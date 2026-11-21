// Run a netlist through the real ngspice binary, safely and reproducibly.
//
// Safety rules enforced here:
//  * the netlist is sanitized first (see sanitize.mjs) unless the caller
//    explicitly passes an already-sanitized result;
//  * the child is started with spawn() and an ARGUMENT ARRAY -- never
//    exec()/a shell string, so nothing in the netlist path can be interpreted;
//  * the child gets its own process group and is SIGKILLed on timeout;
//  * it runs in a fresh temp directory with a minimal environment, so a write
//    it does manage to do lands somewhere disposable.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitize, describeViolations } from './sanitize.mjs';

export const NGSPICE_BIN = process.env.KINUX_NGSPICE_BIN || 'ngspice';
export const DEFAULT_TIMEOUT_MS = 20_000;

const sha256 = s => 'sha256:' + createHash('sha256').update(s).digest('hex');

/** Spawn a binary with an argument array. Never a shell. */
function spawnCollect(bin, args, { cwd, timeoutMs }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        detached: true,            // own process group, so we can kill descendants
        shell: false,              // explicit: no shell, ever
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: cwd, LC_ALL: 'C', TZ: 'UTC', SPICE_NO_DATASEG_CHECK: '1' },
      });
    } catch (err) {
      resolve({ spawnError: String(err && err.message || err), stdout: '', stderr: '', code: null, signal: null, timedOut: false });
      return;
    }
    let out = '', err = '', timedOut = false, settled = false;
    const cap = 32 * 1024 * 1024;
    child.stdout.on('data', d => { if (out.length < cap) out += d; });
    child.stderr.on('data', d => { if (err.length < cap) err += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutMs);
    const done = (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: out, stderr: err, code, signal, timedOut, spawnError });
    };
    child.on('error', e => done(null, null, String(e && e.message || e)));
    child.on('close', (code, signal) => done(code, signal));
  });
}

let cachedVersion = null;
/** Tool version, parsed from ngspice's own banner, for the receipt. */
export async function ngspiceVersion({ force = false } = {}) {
  if (cachedVersion && !force) return cachedVersion;
  const dir = await mkdtemp(join(tmpdir(), 'kinux-ngver-'));
  try {
    const r = await spawnCollect(NGSPICE_BIN, ['--version'], { cwd: dir, timeoutMs: 10_000 });
    const banner = `${r.stdout}\n${r.stderr}`;
    const m = banner.match(/ngspice[- ]?(\d+[\w.]*)\s*:/i) || banner.match(/ngspice[- ]?(\d+[\w.]*)/i);
    cachedVersion = {
      available: !r.spawnError,
      tool: 'ngspice',
      version: m ? m[1] : null,
      id: m ? `ngspice-${m[1]}` : null,
      banner: banner.trim(),
      error: r.spawnError ?? null,
    };
    return cachedVersion;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `name  =  1.23e-4 at= 5e-3` -> { value, at }. ngspice prints one per line. */
export function parseMeasurements(stdout) {
  const measurements = {};
  const failed = [];
  const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const re = new RegExp(`^\\s*([A-Za-z_][\\w.$#:\\[\\]]*)\\s*=\\s*(${NUM})\\s*(?:at\\s*=\\s*(${NUM}))?\\s*$`);
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r/g, '');
    if (/failed!\s*$/i.test(line)) {
      const m = line.match(/meas\w*\s+\w+\s+(\w+)/i);
      failed.push({ name: m ? m[1] : line.trim(), line: line.trim() });
      continue;
    }
    const m = line.match(re);
    if (!m) continue;
    const name = m[1].toLowerCase();
    // Skip the node-voltage table ngspice prints for .op; those use the same
    // shape but are indented inside a "Node / Voltage" block.
    measurements[name] = { value: Number(m[2]), at: m[3] === undefined ? null : Number(m[3]) };
  }
  return { measurements, failed };
}

/**
 * Parse `print` tables into plain float arrays.
 * ngspice repeats the "Index time v(out)" header every ~50 rows; a repeated
 * header with the same columns continues the same table.
 */
export function parsePrintTables(stdout) {
  const tables = [];
  const lines = stdout.split('\n');
  let current = null;
  for (const raw of lines) {
    const line = raw.replace(/\r/g, '').replace(/\t/g, ' ');
    if (/^\s*Index\s+\S/.test(line)) {
      const cols = line.trim().split(/\s{1,}/).slice(1).map(c => c.toLowerCase());
      if (current && current.columns.join('|') === cols.join('|')) continue; // page break
      current = { columns: cols, data: Object.fromEntries(cols.map(c => [c, []])), rows: 0 };
      tables.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\s*-{5,}\s*$/.test(line) || line.trim() === '') continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length !== current.columns.length + 1) { continue; }
    if (!/^\d+$/.test(parts[0])) { continue; }
    const vals = parts.slice(1).map(Number);
    if (vals.some(n => !Number.isFinite(n))) continue;
    current.columns.forEach((c, i) => current.data[c].push(vals[i]));
    current.rows++;
  }
  return tables;
}

/** Everything in stdout that changes between two identical runs (timestamps). */
export function normalizeOutput(text) {
  return text
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b.*$/gm, '')
    .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

const ERROR_PATTERNS = [
  [/can't find model|could not find a valid modelname|unknown (?:device )?model|Unable to find definition of model/i, 'no_model'],
  [/unknown subckt|could not find a valid subckt|subcircuit .* not found/i, 'netlist_unsupported'],
  [/Timestep too small|iteration limit reached|convergence (?:problem|failure)|Transient solution failed|doAnalyses: .*(?:TRAN|DC).*failed|no convergence|singular matrix/i, 'sim_nonconverge'],
  [/Error on line|Simulation interrupted due to error|syntax error|unknown parameter|premature EOF/i, 'netlist_unsupported'],
];

/** Classify a failed run into a contract reason_code. */
export function classifyFailure({ stderr = '', stdout = '', timedOut = false, spawnError = null } = {}) {
  if (spawnError) return 'tool_missing';
  if (timedOut) return 'timeout';
  const blob = `${stderr}\n${stdout}`;
  for (const [re, code] of ERROR_PATTERNS) if (re.test(blob)) return code;
  return 'tool_error';
}

/**
 * Sanitize (unless told not to) and run a netlist.
 * @param {string} netlist
 * @param {{timeoutMs?:number, alreadySanitized?:boolean, allowWriteFiles?:string[], keepDir?:boolean}} [opts]
 * @returns {Promise<object>} a structured result; never throws on simulation failure.
 */
export async function runNetlist(netlist, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    alreadySanitized = false,
    allowWriteFiles = [],
    keepDir = false,
  } = opts;

  if (!alreadySanitized) {
    const s = sanitize(netlist, { allowWriteFiles });
    if (!s.ok) {
      return {
        ok: false,
        blocked: true,
        stage: 'sanitize',
        reason_code: 'netlist_unsupported',
        reason: `netlist rejected by the ngspice sanitizer:\n${describeViolations(s.violations)}`,
        violations: s.violations,
        netlist_sha256: sha256(netlist),
        measurements: {}, failed_measurements: [], tables: [],
        tool_versions: {},
      };
    }
  }

  const version = await ngspiceVersion();
  const dir = await mkdtemp(join(tmpdir(), 'kinux-ngspice-'));
  const file = join(dir, 'circuit.cir');
  const started = Date.now();
  try {
    await writeFile(file, netlist, 'utf8');
    // Argument array. No shell. Relative filename, cwd is the temp dir.
    const r = await spawnCollect(NGSPICE_BIN, ['-b', 'circuit.cir'], { cwd: dir, timeoutMs });
    const durationMs = Date.now() - started;
    const { measurements, failed } = parseMeasurements(r.stdout);
    const tables = parsePrintTables(r.stdout);
    const normalized = normalizeOutput(r.stdout);
    const hardFail = Boolean(r.spawnError) || r.timedOut || r.code !== 0;
    // ngspice 42 exits 0 after "Warning: singular matrix" and prints a solution that is wrong for the
    // whole circuit (a 5 V source read back as 0 V, with one capacitor terminal opened). A solve the
    // solver itself flagged is not a measurement, so it is a failed run, never a result (K26).
    const singular = !hardFail && /singular matrix/i.test(`${r.stderr}\n${r.stdout}`);
    const files = keepDir ? await readdir(dir) : undefined;

    const result = {
      ok: !hardFail && !singular,
      blocked: false,
      stage: 'run',
      exit_code: r.code,
      signal: r.signal,
      timed_out: r.timedOut,
      spawn_error: r.spawnError ?? null,
      duration_ms: durationMs,
      stdout: r.stdout,
      stderr: r.stderr,
      measurements,
      failed_measurements: failed,
      tables,
      netlist_sha256: sha256(netlist),
      output_hash: sha256(normalized),
      result_hash: sha256(JSON.stringify({ measurements, tables: tables.map(t => ({ columns: t.columns, data: t.data })) })),
      tool_versions: version.id ? { ngspice: version.id } : {},
      run_dir: keepDir ? dir : null,
      run_dir_files: files,
    };
    if (!result.ok) {
      result.reason_code = classifyFailure(r);
      result.reason = singular
        ? 'ngspice reported a singular matrix, so its solution is not trustworthy and was discarded'
        : (r.stderr.trim() || r.stdout.trim() || 'ngspice failed').split('\n').slice(0, 6).join('\n');
      if (singular) result.singular_matrix = true;
    }
    return result;
  } finally {
    if (!keepDir) await rm(dir, { recursive: true, force: true });
  }
}
