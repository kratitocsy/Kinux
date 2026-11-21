// Run the CalculiX and Gmsh binaries safely and reproducibly.
//
//  * execFile with an ARGUMENT ARRAY and shell:false -- never a shell string;
//  * the child gets its own process group and the whole group is SIGKILLed on
//    timeout (ccx can fork helper threads; gmsh can spawn SystemCall children);
//  * a minimal environment: PATH limited to /usr/bin:/bin, HOME and TMPDIR set
//    to the disposable work directory, single-threaded solvers so results are
//    byte-reproducible.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CCX_BIN = process.env.KINUX_CCX_BIN || 'ccx';
export const GMSH_BIN = process.env.KINUX_GMSH_BIN || 'gmsh';

export function minimalEnv(cwd) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: cwd,
    TMPDIR: cwd,
    LC_ALL: 'C',
    TZ: 'UTC',
    // Determinism: one thread everywhere. Parallel assembly and solvers can
    // change the summation order and with it the last printed digit.
    OMP_NUM_THREADS: '1',
    CCX_NPROC_EQUATION_SOLVER: '1',
    CCX_NPROC_STIFFNESS: '1',
    CCX_NPROC_RESULTS: '1',
    NUMBER_OF_CPUS: '1',
  };
}

/**
 * Run `bin args...` in `cwd`. Never throws; returns a structured result.
 * @returns {Promise<{stdout:string, stderr:string, code:number|null, signal:string|null, timedOut:boolean, spawnError:string|null, durationMs:number}>}
 */
export function runBinary(bin, args, { cwd, timeoutMs = 60_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let timedOut = false;
    let child;
    let timer;
    const finish = (err, stdout, stderr) => {
      clearTimeout(timer);
      const out = String(stdout ?? '');
      const errText = String(stderr ?? '');
      let spawnError = null;
      let code = 0;
      let signal = null;
      if (err) {
        if (err.code === 'ENOENT' || err.code === 'EACCES') spawnError = `${bin}: ${err.code}`;
        code = typeof err.code === 'number' ? err.code : null;
        signal = err.signal ?? null;
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') spawnError = `${bin}: output exceeded ${maxBuffer} bytes`;
      }
      resolve({ stdout: out, stderr: errText, code, signal, timedOut, spawnError, durationMs: Date.now() - started });
    };
    try {
      child = execFile(bin, args, {
        cwd,
        shell: false,
        detached: true,
        env: minimalEnv(cwd),
        maxBuffer,
        windowsHide: true,
      }, finish);
    } catch (err) {
      finish(err, '', '');
      return;
    }
    child.stdin?.end();
    timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutMs);
  });
}

/** Make a fresh, empty work directory; the caller removes it with cleanup(). */
export async function makeWorkDir(prefix) {
  return mkdtemp(join(tmpdir(), `kinux-${prefix}-`));
}
export async function cleanup(dir) {
  if (dir) await rm(dir, { recursive: true, force: true });
}

const cache = new Map();
/** Tool versions for the receipt, parsed from the binaries' own output. */
export async function toolVersions({ force = false } = {}) {
  if (cache.has('v') && !force) return cache.get('v');
  const dir = await makeWorkDir('feaver');
  try {
    const [c, g] = await Promise.all([
      runBinary(CCX_BIN, ['-v'], { cwd: dir, timeoutMs: 10_000 }),
      runBinary(GMSH_BIN, ['--version'], { cwd: dir, timeoutMs: 10_000 }),
    ]);
    const cm = `${c.stdout}\n${c.stderr}`.match(/Version\s+(\d+[\w.]*)/i);
    const gm = `${g.stdout}\n${g.stderr}`.match(/(\d+\.\d+\.\d+)/);
    const v = {
      ccx: { available: !c.spawnError && Boolean(cm), version: cm ? cm[1] : null, error: c.spawnError },
      gmsh: { available: !g.spawnError && Boolean(gm), version: gm ? gm[1] : null, error: g.spawnError },
    };
    v.ids = {};
    if (v.ccx.version) v.ids.calculix = `ccx-${v.ccx.version}`;
    if (v.gmsh.version) v.ids.gmsh = `gmsh-${v.gmsh.version}`;
    cache.set('v', v);
    return v;
  } finally {
    await cleanup(dir);
  }
}
