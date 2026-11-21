// Wrapper around the installed `kicad-cli`.
//
// What this module is for: to let the PCB worker use exactly the capabilities
// the installed KiCad actually has, and to say NOT_CHECKED - loudly, with a
// reason - for everything it does not have. It never reports a rule check it
// did not run.
//
// MEASURED first on kicad-cli 7.0.11 (the table below). The development
// container now has 10.0.8, which has `pcb drc`, `sch erc` and `pcb export glb`;
// on 8.0+ runDrc/runErc run the real checks (runRuleCheck). On 7.x:
//   top-level commands : fp, pcb, sch, sym, version
//   pcb export formats : drill, dxf, gerber, gerbers, pdf, pos, step, svg
//   sch export formats : dxf, hpgl, netlist, pdf, ps, python-bom, svg
//   there is NO `pcb drc` and NO `sch erc`; both arrived in KiCad 8.0.
//   there is NO `pcb export glb`; that arrived in KiCad 8.0 too.
// It runs headless with no DISPLAY, but HOME must point at a writable
// directory or KiCad complains while setting up its config.
//
// Every child process is started with execFile and an argument ARRAY. No shell
// string is ever built, so a file name cannot turn into a command.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export const DEFAULT_BIN = 'kicad-cli';

/** Minimum KiCad major version each capability needs. */
export const CAPABILITY_REQUIREMENTS = {
  drc: { since: '8.0', how: 'kicad-cli pcb drc' },
  erc: { since: '8.0', how: 'kicad-cli sch erc' },
  glb: { since: '8.0', how: 'kicad-cli pcb export glb' },
};

/** pcb export formats, by the first major version that has them. */
const PCB_EXPORT_FORMATS = {
  7: ['drill', 'dxf', 'gerber', 'gerbers', 'pdf', 'pos', 'step', 'svg'],
  8: ['drill', 'dxf', 'gerber', 'gerbers', 'glb', 'pdf', 'pos', 'step', 'svg', 'vrml'],
};
const SCH_EXPORT_FORMATS = {
  7: ['dxf', 'hpgl', 'netlist', 'pdf', 'ps', 'python-bom', 'svg'],
  8: ['dxf', 'hpgl', 'netlist', 'pdf', 'ps', 'python-bom', 'svg', 'bom'],
};

function pickByMajor(table, major) {
  const majors = Object.keys(table).map(Number).sort((a, b) => a - b);
  let chosen = majors[0];
  for (const m of majors) if (major >= m) chosen = m;
  return table[chosen];
}

/** Where KiCad installs the global library tables it copies on first GUI start. */
export const LIBRARY_TABLE_TEMPLATES = '/usr/share/kicad/template';

/**
 * Headless kicad-cli never creates its global library tables (Copperhead's CI
 * notes this, and we measured it: with an empty HOME, DRC on a real board gave
 * 29 "The current configuration does not include the footprint library ..."
 * warnings). Those are about this machine, not the design, and they would fail
 * every real board's baseline. So a fresh HOME gets KiCad's own template tables.
 * Copies are never overwritten. Returns which tables are present.
 */
export function seedLibraryTables(home, major, templates = LIBRARY_TABLE_TEMPLATES) {
  const out = { fp: false, sym: false, source: templates };
  if (!home || !(major >= 8)) return out;
  const dir = join(home, '.config', 'kicad', `${major}.0`);
  mkdirSync(dir, { recursive: true });
  for (const [key, name] of [['fp', 'fp-lib-table'], ['sym', 'sym-lib-table']]) {
    const dest = join(dir, name);
    if (!existsSync(dest) && existsSync(join(templates, name))) copyFileSync(join(templates, name), dest);
    out[key] = existsSync(dest);
  }
  return out;
}

/** A writable HOME, so KiCad can write its config while headless. */
function kicadEnv(home) {
  const h = home ?? mkdtempSync(join(tmpdir(), 'kicad-home-'));
  return { env: { ...process.env, HOME: h, DISPLAY: '' }, home: h };
}

/**
 * Ask the installed binary for its version.
 * Never throws: a missing binary comes back as {available:false}.
 * @returns {Promise<{available:boolean, bin:string, version:string|null, major:number|null, minor:number|null, error?:string}>}
 */
export async function detectKicadCli({ bin = DEFAULT_BIN, home } = {}) {
  const { env } = kicadEnv(home);
  try {
    const { stdout } = await execFileAsync(bin, ['version'], { env, timeout: 30_000 });
    const version = stdout.trim().split(/\s+/)[0] ?? '';
    const m = /^(\d+)\.(\d+)/.exec(version);
    return {
      available: true,
      bin,
      version,
      major: m ? Number(m[1]) : null,
      minor: m ? Number(m[2]) : null,
    };
  } catch (err) {
    return { available: false, bin, version: null, major: null, minor: null, error: String(err.message ?? err) };
  }
}

/**
 * What the installed kicad-cli can do.
 * @returns {Promise<object>}
 */
export async function capabilities(opts = {}) {
  const v = await detectKicadCli(opts);
  if (!v.available) {
    return { ...v, pcb_export: [], sch_export: [], drc: false, erc: false, glb: false };
  }
  const major = v.major ?? 0;
  const pcb_export = pickByMajor(PCB_EXPORT_FORMATS, major);
  const sch_export = pickByMajor(SCH_EXPORT_FORMATS, major);
  return {
    ...v,
    pcb_export,
    sch_export,
    drc: major >= 8,
    erc: major >= 8,
    glb: pcb_export.includes('glb'),
  };
}

// Reason codes: contracts/event.schema.json freezes the v1 `reason_code` enum
// and has no "tool too old" entry, so results carry the nearest legal value
// (`tool_missing`) plus the exact `detail_code` this task asks for. See
// workers/pcb/README.md.
function notChecked({ check, detail_code, reason, found, required }) {
  return {
    check,
    verdict: 'NOT_CHECKED',
    reason_code: 'tool_missing',
    detail_code,
    reason,
    tool: 'kicad-cli',
    version_found: found,
    version_required: required,
  };
}

/**
 * A capability the installed kicad-cli does not have.
 * Returns a NOT_CHECKED result; it never runs anything and never returns PASS.
 */
export async function unavailable(capability, opts = {}) {
  const req = CAPABILITY_REQUIREMENTS[capability];
  const v = await detectKicadCli(opts);
  const found = v.available ? v.version : null;
  const required = req ? req.since : 'unknown';
  if (!v.available) {
    return notChecked({
      check: capability,
      detail_code: 'kicad_cli_missing',
      reason: `kicad-cli was not found (${v.error}), so ${capability.toUpperCase()} did not run`,
      found: null,
      required,
    });
  }
  return notChecked({
    check: capability,
    detail_code: 'kicad_cli_too_old',
    reason: `${capability.toUpperCase()} needs ${req ? req.how : capability}, which arrived in KiCad ${required}; `
      + `the installed kicad-cli is ${found}, so the check did not run. This is not a pass.`,
    found,
    required,
  });
}

/**
 * Run a design-rule check. On KiCad 7 there is no `pcb drc`, so this returns
 * NOT_CHECKED. On 8.0 or newer it runs the real check and returns the path of
 * its JSON report; erc-drc-report.mjs turns that report into a verdict.
 */
export async function runDrc({ input, ...opts } = {}) {
  const caps = await capabilities(opts);
  if (!caps.drc) return { ...(await unavailable('drc', opts)), input };
  return runRuleCheck('drc', input, caps, opts);
}

/** Electrical rule check on a schematic. Same story: KiCad 8.0 or newer only. */
export async function runErc({ input, ...opts } = {}) {
  const caps = await capabilities(opts);
  if (!caps.erc) return { ...(await unavailable('erc', opts)), input };
  return runRuleCheck('erc', input, caps, opts);
}

/**
 * Run `kicad-cli pcb drc` or `kicad-cli sch erc` and write a JSON report into a
 * fresh scratch directory. Errors and warnings are requested explicitly, so the
 * report does not depend on KiCad's default severity set. This is a run, not a
 * verdict: it returns {ok, report} or an ERROR, and never PASS.
 * MEASURED with kicad-cli 10.0.8: both commands exist, take --format json and
 * --output, and exit 0 when they find violations (no --exit-code-violations).
 */
async function runRuleCheck(kind, input, caps, { bin = DEFAULT_BIN, home, timeout = 120_000 } = {}) {
  const check = kind;
  if (!input || !existsSync(input)) {
    return { check, verdict: 'ERROR', reason_code: 'tool_error', detail_code: 'input_missing',
      reason: `input not found: ${input}`, input, tool: 'kicad-cli', version: caps.version };
  }
  const { env, home: h } = kicadEnv(home);
  const seeded = seedLibraryTables(h, caps.major);
  const dir = mkdtempSync(join(tmpdir(), `kinux-${kind}-`));
  const report = join(dir, `${kind}.json`);
  const args = [kind === 'drc' ? 'pcb' : 'sch', kind, '--format', 'json', '--units', 'mm',
    '--severity-error', '--severity-warning', '--output', report, input];
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { env, timeout });
    if (!existsSync(report) || statSync(report).size === 0) {
      return { check, verdict: 'ERROR', reason_code: 'tool_error', detail_code: 'report_missing',
        reason: `kicad-cli ${kind} wrote no report`, input, tool: 'kicad-cli', version: caps.version,
        argv: [bin, ...args], stdout, stderr };
    }
    return { check, ok: true, report, input, tool: 'kicad-cli', version: caps.version,
      library_tables: seeded, argv: [bin, ...args], ms: Date.now() - started, stdout, stderr };
  } catch (err) {
    return { check, verdict: 'ERROR', reason_code: err.killed ? 'timeout' : 'tool_error',
      detail_code: err.killed ? 'timeout' : 'kicad_cli_failed',
      reason: `kicad-cli ${kind} failed: ${String(err.message ?? err).split('\n')[0]}`,
      input, tool: 'kicad-cli', version: caps.version, argv: [bin, ...args],
      stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * Export a board.
 *
 * @param {object} o
 * @param {string} o.input   path to the .kicad_pcb
 * @param {string} o.format  one of the formats capabilities().pcb_export lists
 * @param {string} o.output  output path
 * @param {string[]} [o.layers] copper/technical layers to draw; svg and dxf on
 *   KiCad 7 REFUSE to run without at least one ("At least one or more layers
 *   must be specified"), so those two default to F.Cu,B.Cu,Edge.Cuts here.
 * @param {string[]} [o.extraArgs] extra kicad-cli arguments, passed through as an array
 * @returns {Promise<object>} an ARTIFACT result (ok/bytes/path) or a NOT_CHECKED/ERROR result.
 *   Note this is an export, not a rule check: a successful export is never a PASS verdict.
 */
export const DEFAULT_SVG_LAYERS = ['F.Cu', 'B.Cu', 'Edge.Cuts'];
const LAYERS_REQUIRED = new Set(['svg', 'dxf']);

export async function exportPcb({ input, format, output, layers, extraArgs = [], bin = DEFAULT_BIN, home, timeout = 120_000 } = {}) {
  const caps = await capabilities({ bin, home });
  if (!caps.available) {
    return { ...(await unavailable('export', { bin, home })), format, input };
  }
  if (!caps.pcb_export.includes(format)) {
    const req = CAPABILITY_REQUIREMENTS[format];
    return {
      check: `pcb_export_${format}`,
      verdict: 'NOT_CHECKED',
      reason_code: 'tool_missing',
      detail_code: req ? 'kicad_cli_too_old' : 'unsupported_export_format',
      reason: `kicad-cli ${caps.version} cannot export ${format}`
        + (req ? `; that needs KiCad ${req.since}` : `; it supports ${caps.pcb_export.join(', ')}`),
      tool: 'kicad-cli',
      version_found: caps.version,
      version_required: req ? req.since : 'unknown',
      format,
      input,
    };
  }
  if (!existsSync(input)) {
    return {
      check: `pcb_export_${format}`, verdict: 'ERROR', reason_code: 'tool_error',
      detail_code: 'input_missing', reason: `input board not found: ${input}`, input, format,
    };
  }

  const { env } = kicadEnv(home);
  const args = ['pcb', 'export', format, '--output', output];
  const layerList = layers ?? (LAYERS_REQUIRED.has(format) ? DEFAULT_SVG_LAYERS : null);
  const callerSetLayers = extraArgs.some(a => a === '--layers' || a === '-l' || String(a).startsWith('--layers='));
  if (layerList && !callerSetLayers) args.push('--layers', layerList.join(','));
  args.push(...extraArgs, input);
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { env, timeout });
    const bytes = existsSync(output) ? statSync(output).size : 0;
    return {
      check: `pcb_export_${format}`,
      ok: bytes > 0,
      artifact: output,
      bytes,
      format,
      input,
      tool: 'kicad-cli',
      version: caps.version,
      argv: [bin, ...args],
      ms: Date.now() - started,
      stdout, stderr,
    };
  } catch (err) {
    return {
      check: `pcb_export_${format}`,
      verdict: 'ERROR',
      reason_code: 'tool_error',
      detail_code: err.killed ? 'timeout' : 'kicad_cli_failed',
      reason: `kicad-cli pcb export ${format} failed: ${String(err.message ?? err).split('\n')[0]}`,
      format, input,
      tool: 'kicad-cli',
      version: caps.version,
      argv: [bin, ...args],
      stdout: err.stdout ?? '', stderr: err.stderr ?? '',
    };
  }
}

/** 3D GLB export. Not in KiCad 7: returns NOT_CHECKED. */
export async function exportGlb({ input, output, ...opts } = {}) {
  const caps = await capabilities(opts);
  if (!caps.glb) return { ...(await unavailable('glb', opts)), input, output, format: 'glb' };
  return exportPcb({ ...opts, input, output, format: 'glb' });
}

