// Run an MJCF model through MuJoCo (Python) and record its trajectory.
//
// MuJoCo is Python-only, so the simulation lives in sim.py next to this file.
// This module is the only way Kinux reaches it:
//  * the interpreter is KINUX_PYTHON if that is set (no silent fallback, the
//    caller asked for that one), otherwise <repo>/.venv/bin/python;
//  * it is started with execFile() and an ARGUMENT ARRAY, never a shell
//    string; `-I` isolates it from PYTHON* variables, user site-packages and
//    the current directory;
//  * the request goes in on stdin as JSON and the reply comes back on stdout
//    as JSON; the environment is minimal; a timeout SIGKILLs the child;
//  * the model's directory is its jail: sim.py refuses any include or asset
//    path that leaves it (see sim.py preflight()).
//
// The trajectory is stored as an artifact named by its sha256, the way the
// run store does it (server/run/store.mjs: artifacts/<hex>). Its bytes are
// canonical JSON, so the same run gives the same hash.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const SIM_SCRIPT = join(HERE, 'sim.py');
export const DEFAULT_TIMEOUT_MS = 60_000;

export const sha256 = buf => 'sha256:' + createHash('sha256').update(buf).digest('hex');

/** Deterministic JSON: sorted keys, no whitespace. Same as server/run/store.mjs. */
export function canonicalJSON(value) {
  const enc = v => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return '[' + v.map(enc).join(',') + ']';
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) throw new TypeError('cannot canonicalise non-finite number');
      return JSON.stringify(v);
    }
    if (t === 'string' || t === 'boolean') return JSON.stringify(v);
    if (t === 'undefined' || t === 'function') return 'null';
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + enc(v[k])).join(',') + '}';
  };
  return enc(value);
}

/** The interpreter to use. An explicit opts.python wins, then KINUX_PYTHON, then the repo venv. */
export function pythonPath(opts = {}) {
  if (opts.python) return opts.python;
  if (process.env.KINUX_PYTHON) return process.env.KINUX_PYTHON;
  return join(REPO_ROOT, '.venv', 'bin', 'python');
}

/** Run sim.py once with a JSON request. Never throws; failures come back as { ok:false, code }. */
export function callSim(request, opts = {}) {
  const python = pythonPath(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise(resolvePromise => {
    let child;
    const started = Date.now();
    const done = r => resolvePromise({ ...r, python, duration_ms: Date.now() - started });
    if (!existsSync(python)) {
      done({ ok: false, code: 'tool_missing', message: `python interpreter not found at ${python}` });
      return;
    }
    const scratch = opts.cwd ?? tmpdir();
    try {
      child = execFile(python, ['-I', SIM_SCRIPT], {
        cwd: scratch,
        shell: false,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        env: { PATH: '/usr/bin:/bin', HOME: scratch, LC_ALL: 'C', TZ: 'UTC', OMP_NUM_THREADS: '1', MUJOCO_GL: 'disable' },
      }, (err, stdout, stderr) => {
        if (err && (err.killed || err.signal === 'SIGKILL') ) {
          done({ ok: false, code: 'timeout', message: `MuJoCo run killed after ${timeoutMs} ms`, stderr: String(stderr).slice(-4000) });
          return;
        }
        if (err && err.code === 'ENOENT') {
          done({ ok: false, code: 'tool_missing', message: `cannot start ${python}: ${err.message}` });
          return;
        }
        let reply;
        try { reply = JSON.parse(stdout); } catch {
          const tail = String(stderr).slice(-4000);
          // An interpreter that cannot even run the script (wrong version, broken
          // venv) counts as a missing tool, not a design problem.
          done({ ok: false, code: err ? 'tool_missing' : 'tool_error', message: `sim.py gave no JSON reply (exit ${err?.code ?? 0}): ${tail}`, stderr: tail });
          return;
        }
        done(reply);
      });
    } catch (e) {
      done({ ok: false, code: 'tool_missing', message: `cannot start ${python}: ${e.message}` });
      return;
    }
    child.stdin.on('error', () => {}); // child may exit before reading
    child.stdin.end(JSON.stringify(request));
  });
}

const probes = new Map();
/** Can this interpreter import mujoco? Cached per interpreter path. */
export async function probeMotion(opts = {}) {
  const python = pythonPath(opts);
  if (!opts.force && probes.has(python)) return probes.get(python);
  const r = await callSim({ op: 'probe' }, { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 });
  const probe = r.ok
    ? { available: true, python, mujoco_version: r.mujoco_version, python_version: r.python_version, id: `mujoco-${r.mujoco_version}` }
    : { available: false, python, reason_code: 'tool_missing', reason: r.message ?? r.code };
  probes.set(python, probe);
  return probe;
}

/** sim.py failure code -> contract reason_code. */
export const SIM_CODE_TO_REASON = Object.freeze({
  tool_missing: 'tool_missing',
  timeout: 'timeout',
  diverged: 'sim_nonconverge',
  model_refused: 'out_of_scope',
  model_compile: 'out_of_scope',
  bad_request: 'out_of_scope',
  too_long: 'out_of_scope',
  tool_error: 'tool_error',
});

/**
 * Record one run. Returns
 *   { ok:true, trajectory, bytes, sha256, tool_versions }  or
 *   { ok:false, reason_code, reason, sim_code }
 * @param {string} modelPath path to the MJCF file; its directory is the jail
 * @param {object} spec { duration, record_hz, timestep?, integrator?, gravity?, qpos0?, qvel0?, controls? }
 */
export async function recordTrajectory(modelPath, spec, opts = {}) {
  const probe = await probeMotion(opts);
  if (!probe.available) {
    return { ok: false, reason_code: 'tool_missing', reason: probe.reason, sim_code: 'tool_missing' };
  }
  const scratch = await mkdtemp(join(tmpdir(), 'kinux-motion-'));
  try {
    const r = await callSim({ op: 'run', model: resolve(modelPath), ...spec }, { ...opts, cwd: scratch });
    if (!r.ok) {
      return { ok: false, reason_code: SIM_CODE_TO_REASON[r.code] ?? 'tool_error', reason: r.message, sim_code: r.code };
    }
    const bytes = canonicalJSON(r.trajectory);
    return {
      ok: true,
      trajectory: r.trajectory,
      bytes,
      sha256: sha256(bytes),
      model_sha256: sha256(canonicalJSON(r.trajectory.model_files)),
      tool_versions: { mujoco: probe.id, python: `python-${probe.python_version}` },
      duration_ms: r.duration_ms,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Store bytes under <runDir>/artifacts/<hex>, written to a temp file and renamed
 * so a reader sees all of it or nothing. Returns the contract fields.
 */
export async function storeArtifact(runDir, bytes) {
  const hash = sha256(bytes);
  const hex = hash.slice('sha256:'.length);
  const dir = join(runDir, 'artifacts');
  await mkdir(dir, { recursive: true });
  const final = join(dir, hex);
  if (!existsSync(final)) {
    const tmp = join(dir, `.${hex}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, final);
  }
  return { uri: `artifacts/${hex}`, sha256: hash, bytes: Buffer.byteLength(bytes) };
}
