// What tools this machine has, and which test suites can therefore run.
//
// Shared by `npm run doctor` and `npm test`. The point is to stop a missing
// solver looking like a broken project: without ngspice, most of our suites used
// to fail with errors that said nothing useful. Now a suite that needs a missing
// tool is skipped, by name, with the reason, and `--all` still runs everything
// so CI cannot skip quietly.
//
// The workers launch their tools with PATH set to /usr/bin:/bin, so a tool that
// is installed elsewhere (Homebrew on macOS) is invisible to them unless a
// KINUX_*_BIN override names it. This module probes the way the workers do, so
// it can tell "not installed" from "installed where the workers will not look".

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export const WORKER_PATH = '/usr/bin:/bin';

/** Which tools each test suite needs. Every suite in tests/ must be listed, even with none. */
export const SUITES = {
  'contracts': [],
  'kicad-sexp': [],
  'queue': [],
  'run-server': [],
  'viewer': [],            // its browser tests skip themselves when Playwright is missing
  'viewer-thermal': [],
  'motion': [],            // skips itself when MuJoCo is missing
  'tools': [],
  'ngspice-worker': ['ngspice'],
  'ngspice-assertions': ['ngspice'],
  'engine': ['ngspice'],
  'engine-receipt': ['ngspice'],
  'coverage': ['ngspice'],
  'spice-number': ['ngspice'],
  'reason-codes': [],
  'examples': ['ngspice'],
  'thermal': ['ngspice'],
  'live': ['ngspice'],
  'pcb-worker': ['kicad-cli'],
  'pcb-erc-drc': ['kicad-cli'],
  'kicad-adapter': ['ngspice', 'kicad-cli'],
  'fea': ['ccx', 'gmsh'],
};

/**
 * @typedef {object} ToolDef
 * @property {string} id
 * @property {string} bin           default executable name
 * @property {string} [env]         env var that overrides it with an absolute path
 * @property {string[]} args        arguments that print the version
 * @property {boolean} workerPath   true when workers launch it with PATH=/usr/bin:/bin
 * @property {(text: string) => string|undefined} version
 */

/** @type {ToolDef[]} */
export const TOOLS = [
  { id: 'ngspice', bin: 'ngspice', env: 'KINUX_NGSPICE_BIN', args: ['--version'], workerPath: true,
    version: t => /ngspice[- ]*(\d+(?:\.\d+)*)/i.exec(t)?.[1] },
  { id: 'ccx', bin: 'ccx', env: 'KINUX_CCX_BIN', args: ['-v'], workerPath: true,
    version: t => /version\s+(\d+(?:\.\d+)*)/i.exec(t)?.[1] },
  { id: 'gmsh', bin: 'gmsh', env: 'KINUX_GMSH_BIN', args: ['--version'], workerPath: true,
    version: t => /(\d+\.\d+(?:\.\d+)*)/.exec(t)?.[1] },
  { id: 'kicad-cli', bin: 'kicad-cli', args: ['version'], workerPath: false,
    version: t => /(\d+\.\d+(?:\.\d+)*)/.exec(t)?.[1] },
];

/** Find an executable by name on a PATH string, or check an absolute path. */
export function which(bin, searchPath = process.env.PATH ?? '') {
  const ok = p => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
  if (bin.includes('/')) return ok(bin) ? bin : null;
  for (const dir of searchPath.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    if (ok(p)) return p;
  }
  return null;
}

function run(file, args, env) {
  return new Promise(resolve => {
    execFile(file, args, { env, timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ran: !err || typeof err.code === 'number', text: `${stdout ?? ''}\n${stderr ?? ''}` });
    });
  });
}

/**
 * Probe one tool the way the workers will launch it.
 * state: 'ok' | 'invisible' (installed, but not where the workers look) | 'missing'.
 */
export async function probeTool(tool, env = process.env) {
  const bin = (tool.env && env[tool.env]) || tool.bin;
  const workerEnv = { ...env, PATH: tool.workerPath ? WORKER_PATH : (env.PATH ?? '') };
  const resolved = which(bin, workerEnv.PATH);
  if (resolved) {
    const r = await run(resolved, tool.args, workerEnv);
    const version = tool.version(r.text);
    if (r.ran && version) return { id: tool.id, state: 'ok', path: resolved, version };
    return { id: tool.id, state: 'missing', reason: `${resolved} did not report a version` };
  }
  if (tool.workerPath) {
    const elsewhere = which(bin, env.PATH ?? '');
    if (elsewhere) {
      return {
        id: tool.id, state: 'invisible', path: elsewhere,
        reason: `found at ${elsewhere}, but workers only search ${WORKER_PATH}; set ${tool.env}=${elsewhere}`,
      };
    }
  }
  return { id: tool.id, state: 'missing', reason: `${bin} not found` };
}

export async function probeAll(env = process.env, tools = TOOLS) {
  const out = {};
  for (const t of tools) out[t.id] = await probeTool(t, env);
  return out;
}

/** A suite's name from its file name: ngspice-worker.test.mjs -> ngspice-worker. */
export const suiteName = file => file.replace(/^.*\//, '').replace(/\.test\.mjs$/, '');

/**
 * Decide which suites run. A suite missing from SUITES is a mistake and is
 * reported as such rather than guessed at. With runAll, nothing is skipped.
 *
 * @returns {{file: string, name: string, run: boolean, reason?: string, unlisted?: boolean}[]}
 */
export function planSuites(files, status, { runAll = false, suites = SUITES } = {}) {
  return files.map(file => {
    const name = suiteName(file);
    if (!(name in suites)) return { file, name, run: true, unlisted: true };
    if (runAll) return { file, name, run: true };
    const blockers = suites[name]
      .map(id => status[id])
      .filter(s => !s || s.state !== 'ok');
    if (blockers.length === 0) return { file, name, run: true };
    const reason = blockers.map(b => `${b?.id ?? 'a tool'}: ${b?.reason ?? 'not probed'}`).join('; ');
    return { file, name, run: false, reason };
  });
}
