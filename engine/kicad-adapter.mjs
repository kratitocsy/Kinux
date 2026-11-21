// KiCad schematic -> SPICE deck for `kinux verify` (ROADMAP R3).
//
//   const { netlist, manifest } = await buildDesign({ schematic, sidecar, modelDir });
//
// WHAT IT DOES
//   1. Runs the real `kicad-cli sch export netlist` twice, into a scratch
//      directory: `--format spice` (KiCad's own SPICE netlist) and
//      `--format kicadsexpr` (every part, every pin, every net).
//   2. Classifies EVERY part as `modelled` or `not_checked`, and says why.
//      KiCad's SPICE export is mostly a stub: R, C and L come out with values
//      and nets, while every IC, diode, FET, connector, switch and test point is
//      a one-pin placeholder (`U1 __U1`). Those are NOT passed through.
//      A part is `modelled` only if it is an R/C/L with a value we could read,
//      or the sidecar maps it to a model file we accepted. Otherwise it is
//      `not_checked` with reason_code `no_model`, `blackbox` or
//      `netlist_unsupported`, or (test points, mounting holes, connectors, DNP,
//      parts KiCad itself excludes from simulation) `out_of_scope`.
//      An unmodelled part is left OUT of the deck. It never counts as checked.
//   3. Normalises: ground nets -> 0, DNP parts removed and listed, extra value
//      tokens (`3.3nF C0G`) dropped and recorded, and the SI-prefix boundary.
//
//      SI PREFIXES. Real ngspice reads `1M` as 1 milli and `1meg` as 1 mega, but
//      in KiCad and in people's heads `1M` is a megaohm (Copperhead's issue
//      #483 was this class of bug). This module reads values the KiCad way and
//      EMITS PLAIN EXPONENT NUMBERS (`1e6`), never a suffix, so ngspice cannot
//      read it a second way. KiCad rule: `M` is mega, `m` is milli, `meg` is
//      mega, `k`/`K` kilo, `u`/`U`/`µ` micro; `4k7` and `4R7` are 4.7k and 4.7.
//
// THE SIDECAR (JSON, supplied by the person running the check; `kicad-cli` does
// not export a source, so without one there is no stimulus). Unknown keys are
// rejected. Version 1:
//
//   {
//     "version": 1,
//     "sources": [
//       { "ref": "V1", "kind": "vdc",   "plus": "+5V", "minus": "GND", "volts": 5 },
//       { "ref": "V2", "kind": "vpulse","plus": "IN",  "minus": "GND",
//         "v1": 0, "v2": 5, "delay": 0, "rise": 1e-6, "fall": 1e-6, "width": 1e-3, "period": 2e-3 },
//       { "ref": "I1", "kind": "idc",   "plus": "A",   "minus": "GND", "amps": 0.001 }
//     ],
//     "models": [
//       { "ref": "U1", "file": "tlc555.lib", "subckt": "TLC555",
//         "ports": ["1","2","3","4","5","6","7","8"] },        // KiCad pin number per subckt port, in order
//       { "ref": "D1", "file": "diodes.lib", "model": "D1N4148",
//         "ports": ["2","1"] }                                 // .model device: SPICE node order (D: anode, cathode)
//     ],
//     "blackbox": [ { "ref": "U2", "reason": "behaviour not modelled; its pins left open" } ],
//     "aliases": [ { "name": "P5V", "net": "+5V" } ]
//   }
//
//   * `aliases` exist because the check grammar refuses a `source:` port whose
//     name does not start with a letter or underscore (`+5V`). An alias adds a
//     second, legal node name joined to the real net by a 1 milliohm resistor
//     `Ralias_<name>`, so `source: P5V=0` drives the +5V net. The real net keeps
//     its name. Alias parts are listed in the manifest. The mutation engine sees
//     `Ralias_*` as an ordinary resistor.
//
//   * `plus`/`minus` are KiCad net names (a leading `/` is optional).
//   * A `ports` entry of null is a pin tied to a private floating node.
//   * Model files are resolved ONLY inside the allowlisted model directory
//     (`modelDir`, default: the sidecar's own directory), as plain relative
//     paths with no `..`, no absolute path and no symlink leaving it. They are
//     then run through workers/ngspice/sanitize.mjs and INLINED into the deck.
//     The deck never contains `.include` or `.lib`, which the sanitizer denies.
//     Inside a model file only `.subckt .ends .model .param .func .global` are
//     accepted; analysis commands and `.control` are rejected.
//   * KiCad `Sim.*` properties are recorded in the manifest but NEVER acted on:
//     a `Sim.Library` path is not read, whatever it points at.
//
// Every child process uses execFile with an argument array. The design is
// treated as hostile: kicad-cli reads it and writes only into our scratch
// directory, and the deck is built from parsed tokens, never copied line by
// line from KiCad's output.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

import { parseSexp, children, child, atomAt, propertyValue } from '../workers/kicad/sexp.mjs';
import { loadSchematicProject } from '../workers/kicad/schematic.mjs';
import { sanitize, describeViolations } from '../workers/ngspice/sanitize.mjs';
import { isGround } from './netlist.mjs';

export const KICAD_CLI = process.env.KINUX_KICAD_CLI_BIN || 'kicad-cli';
export const EXPORT_TIMEOUT_MS = 60_000;
const MAX_EXPORT_BYTES = 20_000_000;
const MAX_MODEL_BYTES = 1_000_000;
const MODEL_EXTENSIONS = new Set(['.cir', '.lib', '.sub', '.mod', '.sp', '.spi', '.ckt', '.inc', '.txt']);
const MODEL_DIRECTIVES = new Set(['.subckt', '.ends', '.model', '.param', '.func', '.global']);

export class AdapterError extends Error {
  constructor(message, code = 'adapter_error') { super(message); this.name = 'AdapterError'; this.code = code; }
}

const sha256 = t => createHash('sha256').update(t).digest('hex');

// ------------------------------------------------------------ running kicad-cli

function runKicad(args, { cwd, home, timeoutMs, bin }) {
  return new Promise((res, rej) => {
    // A minimal environment: nothing from the caller's shell leaks into KiCad.
    const env = { PATH: '/usr/bin:/bin:/usr/local/bin', HOME: home, LANG: 'C.UTF-8', DISPLAY: '' };
    execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: MAX_EXPORT_BYTES, windowsHide: true, shell: false }, (err, stdout, stderr) => {
      if (err) rej(new AdapterError(`kicad-cli ${args.slice(0, 3).join(' ')} failed: ${String(stderr || err.message).trim().split('\n').slice(0, 4).join(' | ')}`, err.killed ? 'kicad_timeout' : 'kicad_failed'));
      else res({ stdout, stderr });
    });
  });
}

/**
 * Export a schematic with the real kicad-cli. The input must be a regular
 * `.kicad_sch` file; outputs go to a fresh scratch directory that is removed
 * afterwards, and each output is checked to be inside it.
 */
export async function exportWithKicadCli(schematic, { bin = KICAD_CLI, timeoutMs = EXPORT_TIMEOUT_MS } = {}) {
  const input = resolve(schematic);
  if (extname(input).toLowerCase() !== '.kicad_sch') throw new AdapterError(`${schematic} is not a .kicad_sch file`, 'bad_input');
  let st;
  try { st = statSync(input); } catch { throw new AdapterError(`cannot read ${schematic}`, 'bad_input'); }
  if (!st.isFile()) throw new AdapterError(`${schematic} is not a regular file`, 'bad_input');

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kinux-kicad-')));
  try {
    const out = {};
    for (const [format, name] of [['spice', 'out.cir'], ['kicadsexpr', 'out.net']]) {
      const target = join(scratch, name);
      await runKicad(['sch', 'export', 'netlist', '--format', format, '--output', target, input], { cwd: scratch, home: scratch, timeoutMs, bin });
      // Containment: the file we read is the one we named, inside the scratch dir.
      const real = existsSync(target) ? realpathSync(target) : null;
      if (!real || !real.startsWith(scratch + sep)) throw new AdapterError(`kicad-cli wrote no ${format} netlist`, 'kicad_failed');
      if (statSync(real).size > MAX_EXPORT_BYTES) throw new AdapterError(`the ${format} netlist is larger than ${MAX_EXPORT_BYTES} bytes`, 'too_large');
      out[format] = readFileSync(real, 'utf8');
    }
    const v = await runKicad(['version'], { cwd: scratch, home: scratch, timeoutMs: 30_000, bin }).catch(() => ({ stdout: '' }));
    return { spice: out.spice, sexpr: out.kicadsexpr, kicadVersion: v.stdout.trim().split(/\s+/)[0] || null };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ reading the exports

/** Parse KiCad's `kicadsexpr` netlist into parts and nets. */
export function parseKicadNetlist(text) {
  const root = parseSexp(text)[0];
  if (!Array.isArray(root) || root[0] !== 'export') throw new AdapterError('the kicadsexpr export is not an (export ...) document', 'bad_export');
  const comps = [];
  for (const c of children(child(root, 'components') ?? [], 'comp')) {
    const lib = child(c, 'libsource');
    comps.push({
      ref: atomAt(child(c, 'ref'), 1) ?? '?',
      value: atomAt(child(c, 'value'), 1) ?? '',
      lib: atomAt(child(lib ?? [], 'lib'), 1) ?? '',
      part: atomAt(child(lib ?? [], 'part'), 1) ?? '',
      footprint: atomAt(child(c, 'footprint'), 1) ?? '',
    });
  }
  const nets = [];
  for (const n of children(child(root, 'nets') ?? [], 'net')) {
    nets.push({
      name: atomAt(child(n, 'name'), 1) ?? '',
      nodes: children(n, 'node').map(nd => ({
        ref: atomAt(child(nd, 'ref'), 1) ?? '?',
        pin: atomAt(child(nd, 'pin'), 1) ?? '?',
        pinfunction: atomAt(child(nd, 'pinfunction'), 1) ?? null,
      })),
    });
  }
  return { comps, nets };
}

/**
 * Parse KiCad's SPICE export. Only two-terminal R/C/L lines are kept; each
 * keeps its tokens, never its raw text. Everything else (the `U1 __U1` stubs)
 * is counted and ignored.
 */
export function parseKicadSpice(text) {
  const passives = new Map();
  const duplicated = new Set();
  const ignored = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n').slice(1)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('*') || line.startsWith('.')) continue;
    const t = line.split(/\s+/);
    if (/^[RCL][A-Za-z0-9_]*$/.test(t[0]) && t.length >= 4) {
      if (passives.has(t[0])) { duplicated.add(t[0]); ignored.push(`${t[0]} (duplicate line)`); continue; }
      passives.set(t[0], { n1: t[1], n2: t[2], valueTokens: t.slice(3) });
    } else {
      ignored.push(t[0]);
    }
  }
  return { passives, ignored, duplicated };
}

// ------------------------------------------------------------ values

const EXP = { meg: 6, t: 12, g: 9, k: 3, m: -3, u: -6, 'µ': -6, 'μ': -6, n: -9, p: -12, f: -15 };
const UNIT_FOR = { R: /^(ohms?|Ω|R)$/i, C: /^F$/i, L: /^H$/i };
const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;

/**
 * Read a KiCad component value the KiCad way and return plain exponent text.
 * `1M` -> "1e6" (a megaohm), `1m` -> "1e-3", `4k7` -> "4.7e3", `3.3nF` -> "3.3e-9".
 * Returns { ok:true, text, number } or { ok:false, why }.
 */
export function parseKicadValue(token, kind) {
  const t = String(token).trim();
  const unitRe = UNIT_FOR[kind];
  if (!unitRe) return { ok: false, why: `no value rules for ${kind}` };
  let mant, rest;
  const infix = /^(\d+)([RrKkMmGgTtUuµμNnPpFf])(\d+)$/.exec(t);        // 4k7, 4R7, 2u2
  if (infix) {
    mant = `${infix[1]}.${infix[3]}`;
    const c = infix[2];
    rest = (c === 'R' || c === 'r') ? '' : c;
  } else {
    const m = new RegExp(`^(${NUM})\\s*(.*)$`).exec(t);
    if (!m) return { ok: false, why: `"${t}" does not start with a number` };
    mant = m[1];
    rest = m[2];
  }
  let exp = 0;
  if (rest !== '' && !unitRe.test(rest)) {
    const m = /^(meg|mil|[TtGgKkMmUuµμNnPpFf])\s*(ohms?|Ω|Hz|[FHRVAS])?$/i.exec(rest);
    if (!m) return { ok: false, why: `"${rest}" is not an SI prefix and unit` };
    const p = m[1];
    if (p.toLowerCase() === 'mil') return { ok: false, why: '"mil" is not supported' };
    exp = p.toLowerCase() === 'meg' ? EXP.meg : p === 'M' ? 6 : EXP[p.toLowerCase()];
    if (m[2] !== undefined && !unitRe.test(m[2])) return { ok: false, why: `unit "${m[2]}" does not fit a ${kind}` };
  }
  const text = exp === 0 ? mant : `${mant}e${exp}`;
  const number = Number(text);
  if (!Number.isFinite(number)) return { ok: false, why: `"${t}" is not finite` };
  return { ok: true, text, number };
}

// ------------------------------------------------------------ the sidecar

const SOURCE_FIELDS = {
  vdc: ['volts'], idc: ['amps'],
  vpulse: ['v1', 'v2', 'delay', 'rise', 'fall', 'width', 'period'],
};
const REF_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function exactKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new AdapterError(`sidecar ${where}: unknown key "${k}"`, 'bad_sidecar');
}

/** Validate a parsed sidecar. Closed schema: anything unknown is an error. */
export function validateSidecar(sc) {
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) throw new AdapterError('sidecar must be a JSON object', 'bad_sidecar');
  exactKeys(sc, ['version', 'sources', 'models', 'blackbox', 'aliases'], 'top level');
  if (sc.version !== 1) throw new AdapterError('sidecar "version" must be 1', 'bad_sidecar');
  const out = { sources: [], models: [], blackbox: [], aliases: [] };
  const seen = new Set();
  const refOf = (e, where) => {
    if (typeof e.ref !== 'string' || !REF_RE.test(e.ref)) throw new AdapterError(`sidecar ${where}: "ref" must match ${REF_RE}`, 'bad_sidecar');
    return e.ref;
  };
  for (const [i, s] of (sc.sources ?? []).entries()) {
    const where = `sources[${i}]`;
    if (!SOURCE_FIELDS[s?.kind]) throw new AdapterError(`sidecar ${where}: "kind" must be one of ${Object.keys(SOURCE_FIELDS).join(', ')}`, 'bad_sidecar');
    exactKeys(s, ['ref', 'kind', 'plus', 'minus', ...SOURCE_FIELDS[s.kind]], where);
    const ref = refOf(s, where);
    if (!new RegExp(`^${s.kind === 'idc' ? 'I' : 'V'}`, 'i').test(ref)) throw new AdapterError(`sidecar ${where}: a ${s.kind} source ref must start with ${s.kind === 'idc' ? 'I' : 'V'}`, 'bad_sidecar');
    for (const k of ['plus', 'minus']) if (typeof s[k] !== 'string' || s[k] === '') throw new AdapterError(`sidecar ${where}: "${k}" must be a net name`, 'bad_sidecar');
    for (const k of SOURCE_FIELDS[s.kind]) if (typeof s[k] !== 'number' || !Number.isFinite(s[k])) throw new AdapterError(`sidecar ${where}: "${k}" must be a number`, 'bad_sidecar');
    if (seen.has(ref.toLowerCase())) throw new AdapterError(`sidecar: ref ${ref} appears twice`, 'bad_sidecar');
    seen.add(ref.toLowerCase());
    out.sources.push({ ...s });
  }
  for (const [i, m] of (sc.models ?? []).entries()) {
    const where = `models[${i}]`;
    exactKeys(m ?? {}, ['ref', 'file', 'subckt', 'model', 'ports'], where);
    refOf(m, where);
    if (typeof m.file !== 'string' || m.file === '') throw new AdapterError(`sidecar ${where}: "file" must be a relative path`, 'bad_sidecar');
    if ((m.subckt === undefined) === (m.model === undefined)) throw new AdapterError(`sidecar ${where}: give exactly one of "subckt" or "model"`, 'bad_sidecar');
    const name = m.subckt ?? m.model;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.$-]{1,64}$/.test(name)) throw new AdapterError(`sidecar ${where}: the model name is not a plain identifier`, 'bad_sidecar');
    if (!Array.isArray(m.ports) || m.ports.length === 0 || m.ports.some(p => p !== null && typeof p !== 'string')) throw new AdapterError(`sidecar ${where}: "ports" must be a non-empty list of pin numbers (or null)`, 'bad_sidecar');
    if (seen.has(m.ref.toLowerCase())) throw new AdapterError(`sidecar: ref ${m.ref} appears twice`, 'bad_sidecar');
    seen.add(m.ref.toLowerCase());
    out.models.push({ ...m });
  }
  for (const [i, b] of (sc.blackbox ?? []).entries()) {
    exactKeys(b ?? {}, ['ref', 'reason'], `blackbox[${i}]`);
    refOf(b, `blackbox[${i}]`);
    if (typeof b.reason !== 'string' || b.reason.trim() === '') throw new AdapterError(`sidecar blackbox[${i}]: a reason is required`, 'bad_sidecar');
    if (seen.has(b.ref.toLowerCase())) throw new AdapterError(`sidecar: ref ${b.ref} appears twice`, 'bad_sidecar');
    seen.add(b.ref.toLowerCase());
    out.blackbox.push({ ...b });
  }
  for (const [i, a] of (sc.aliases ?? []).entries()) {
    exactKeys(a ?? {}, ['name', 'net'], `aliases[${i}]`);
    if (typeof a.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(a.name)) throw new AdapterError(`sidecar aliases[${i}]: "name" must start with a letter or underscore and use only letters, digits and _`, 'bad_sidecar');
    if (typeof a.net !== 'string' || a.net === '') throw new AdapterError(`sidecar aliases[${i}]: "net" must be a net name`, 'bad_sidecar');
    out.aliases.push({ ...a });
  }
  return out;
}

export function readSidecar(path) {
  let text;
  try { text = readFileSync(resolve(path), 'utf8'); } catch (e) { throw new AdapterError(`cannot read the sidecar: ${e.message}`, 'bad_sidecar'); }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new AdapterError(`the sidecar is not JSON: ${e.message}`, 'bad_sidecar'); }
  return { sidecar: validateSidecar(json), text };
}

// ------------------------------------------------------------ model files

/**
 * Read a model file from inside the allowlisted directory and check it.
 * Returns { ok:true, text, subckts:Map(name->portCount), models:Set } or
 * { ok:false, code, detail }. Never throws on hostile input.
 */
export function loadModelFile(modelDir, file) {
  if (!modelDir) return { ok: false, code: 'netlist_unsupported', detail: 'no model directory is allowlisted (pass --model-dir or keep models beside the sidecar)' };
  if (isAbsolute(file) || /[\0\\]/.test(file) || file.split('/').some(s => s === '..' || s === '') || file.startsWith('~') || file.startsWith('$')) {
    return { ok: false, code: 'netlist_unsupported', detail: `model path "${file}" is not a plain relative path inside the model directory` };
  }
  if (!MODEL_EXTENSIONS.has(extname(file).toLowerCase())) return { ok: false, code: 'netlist_unsupported', detail: `model file extension "${extname(file)}" is not allowed` };
  let root, real;
  try { root = realpathSync(resolve(modelDir)); } catch { return { ok: false, code: 'netlist_unsupported', detail: 'the model directory does not exist' }; }
  try { real = realpathSync(join(root, file)); } catch { return { ok: false, code: 'no_model', detail: `model file "${file}" does not exist in the model directory` }; }
  if (!real.startsWith(root + sep)) return { ok: false, code: 'netlist_unsupported', detail: `model file "${file}" resolves outside the model directory` };
  const st = lstatSync(real);
  if (!st.isFile()) return { ok: false, code: 'netlist_unsupported', detail: `model "${file}" is not a regular file` };
  if (st.size > MAX_MODEL_BYTES) return { ok: false, code: 'netlist_unsupported', detail: `model "${file}" is larger than ${MAX_MODEL_BYTES} bytes` };
  const raw = readFileSync(real, 'utf8');

  // The model goes through the same sanitizer as every netlist (it denies
  // .include, .lib, .control shell ...), after a title line so line 1 is not
  // skipped as one. Then a stricter model-only allowlist on top.
  const s = sanitize(`* model ${basename(file)}\n${raw}`);
  if (!s.ok) return { ok: false, code: 'netlist_unsupported', detail: `model "${file}" was rejected by the sanitizer: ${describeViolations(s.violations).split('\n')[0]}` };
  const subckts = new Map();
  const models = new Set();
  const kept = [];
  const folded = raw.replace(/\r\n?/g, '\n').replace(/\n\s*\+/g, ' ').split('\n');
  let depth = 0;
  for (const line of folded) {
    const t = line.trim();
    if (t.startsWith('.')) {
      const d = t.toLowerCase().split(/[\s(=]/)[0];
      if (d === '.end') continue;
      if (d === '.subckt') depth += 1;
      if (d === '.ends') depth = Math.max(0, depth - 1);
      // `.ic`/`.nodeset` inside a subcircuit set the model's own private nodes
      // (TI's TPS5430 model has three) and are part of its definition. At the
      // top level of a model file they would set the design's nodes: refused.
      if ((d === '.ic' || d === '.nodeset') && depth > 0) { kept.push(line); continue; }
      if (!MODEL_DIRECTIVES.has(d)) return { ok: false, code: 'netlist_unsupported', detail: `model "${file}": directive ${d} is not allowed inside a model file` };
      const toks = t.split(/\s+/);
      if (d === '.subckt') subckts.set(toks[1]?.toLowerCase(), toks.slice(2).filter(x => !x.includes('=') && x.toLowerCase() !== 'params:').length);
      if (d === '.model') models.add(toks[1]?.toLowerCase());
    }
    kept.push(line);
  }
  return { ok: true, text: raw.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim().toLowerCase() !== '.end').join('\n'), subckts, models, sha256: sha256(raw), file };
}

// ------------------------------------------------------------ classification

/** Why this part is out of scope (test point, hole, connector, fiducial), or null. */
export function outOfScopeReason(ref, lib) {
  if (/^TP\d/i.test(ref) || /^TestPoint$/i.test(lib)) return 'test point';
  if (/^(H|MH)\d/i.test(ref) || /^MountingHole$/i.test(lib)) return 'mounting hole';
  if (/^(J|P|CN)\d/i.test(ref) || /^Connector/i.test(lib)) return 'connector';
  if (/^FID\d/i.test(ref) || /^(Fiducial|Mechanical)$/i.test(lib)) return 'fiducial or mechanical item';
  return null;
}

const ZERO_OHM_REPLACEMENT = '1e-3';

/**
 * Net-name normalisation: KiCad name -> SPICE node. Ground nets become 0.
 * Returns { map: Map(kicad -> spice), merged: string[] }.
 */
export function mapNets(names) {
  const map = new Map();
  const used = new Map();       // lowercase spice name -> kicad name
  const merged = [];
  for (const raw of [...new Set(names)]) {
    const base = raw.startsWith('/') ? raw.slice(1) : raw;
    if (isGround(base) || isGround(raw)) {
      map.set(raw, '0');
      if (!/^gnd$/i.test(base) && base !== '0') merged.push(raw);
      continue;
    }
    const clean = s => (s.replace(/[^A-Za-z0-9_+.-]/g, '_') || '_');
    let name = clean(base);
    if (used.has(name.toLowerCase()) || name === '0') name = clean(raw.replace(/\//g, '_')) + (raw.startsWith('/') ? '' : '');
    let n = 2;
    const stem = name;
    while (used.has(name.toLowerCase()) || name === '0') name = `${stem}_${n++}`;
    used.set(name.toLowerCase(), raw);
    map.set(raw, name);
  }
  return { map, merged };
}

const fmt = n => (Number.isInteger(n) || Math.abs(n) >= 1e-3 ? String(n) : n.toExponential());

function sourceLine(s, node) {
  const [p, m] = [node(s.plus), node(s.minus)];
  if (s.kind === 'vdc') return `${s.ref} ${p} ${m} DC ${fmt(s.volts)}`;
  if (s.kind === 'idc') return `${s.ref} ${p} ${m} DC ${fmt(s.amps)}`;
  return `${s.ref} ${p} ${m} DC ${fmt(s.v1)} PULSE(${fmt(s.v1)} ${fmt(s.v2)} ${fmt(s.delay)} ${fmt(s.rise)} ${fmt(s.fall)} ${fmt(s.width)} ${fmt(s.period)})`;
}

/**
 * Build the deck and the manifest.
 *
 * @param {object} o
 * @param {string} o.schematic     path to a .kicad_sch
 * @param {string} [o.sidecar]     path to the sidecar JSON
 * @param {string} [o.modelDir]    allowlisted model directory (default: the sidecar's directory)
 * @param {{spice:string, sexpr:string, kicadVersion?:string}} [o.exported] already-exported text (tests)
 */
export async function buildDesign({ schematic, sidecar, modelDir, exported, kicadBin, intent } = {}) {
  const exp = exported ?? await exportWithKicadCli(schematic, { bin: kicadBin ?? KICAD_CLI });
  const { comps, nets } = parseKicadNetlist(exp.sexpr);
  const spice = parseKicadSpice(exp.spice);
  let sc = { sources: [], models: [], blackbox: [], aliases: [] };
  let sidecarText = null;
  if (sidecar) { const r = readSidecar(sidecar); sc = r.sidecar; sidecarText = r.text; }
  const allowDir = modelDir ?? (sidecar ? dirname(resolve(sidecar)) : null);

  // Facts only the .kicad_sch has: DNP, exclude-from-simulation, Sim.* fields.
  const schFacts = new Map();
  let hierarchyNote = null;
  if (schematic) {
    try {
      const project = loadSchematicProject(schematic);
      for (const sheet of project.sheets) {
        for (const c of sheet.components) {
          const refs = new Set([c.refdes, ...c.instances.map(i => i.reference).filter(Boolean)]);
          const sim = {};
          for (const k of ['Sim.Device', 'Sim.Type', 'Sim.Library', 'Sim.Name', 'Sim.Params', 'Sim.Pins']) {
            const v = propertyValue(c.node, k);
            if (v !== undefined) sim[k] = v;
          }
          for (const r of refs) schFacts.set(r, { dnp: c.dnp, excludeFromSim: c.excludeFromSim, sim });
        }
      }
      if (project.sheets.length > 1) hierarchyNote = `${project.sheets.length} sheets; DNP and Sim.* facts matched by reference designator`;
    } catch (e) {
      hierarchyNote = `the schematic reader could not read the project (${e.message}); DNP flags and Sim.* properties were not available`;
    }
  }

  // Pin -> net, from kicadsexpr.
  const pinNet = new Map();   // ref -> Map(pin -> kicad net)
  for (const n of nets) for (const nd of n.nodes) {
    if (!pinNet.has(nd.ref)) pinNet.set(nd.ref, new Map());
    pinNet.get(nd.ref).set(nd.pin, n.name);
  }
  const netNames = nets.map(n => n.name);
  const { map: netMap, merged } = mapNets(netNames);
  const nodeOf = name => {
    const key = netMap.has(name) ? name : netMap.has(`/${name}`) ? `/${name}` : null;
    if (key === null) throw new AdapterError(`net "${name}" is not in the design; nets are: ${[...netMap.keys()].slice(0, 12).join(', ')}${netMap.size > 12 ? ', ...' : ''}`, 'bad_sidecar');
    return netMap.get(key);
  };

  const parts = [];
  const normalisations = [];
  const lines = [];            // deck element lines
  const modelBlocks = new Map(); // resolved file -> text
  const modelNames = new Map();  // lowercase subckt/model name -> file
  const bbMap = new Map(sc.blackbox.map(b => [b.ref.toLowerCase(), b]));
  const mdMap = new Map(sc.models.map(m => [m.ref.toLowerCase(), m]));
  const compRefs = new Set(comps.map(c => c.ref.toLowerCase()));
  for (const s of sc.sources) if (compRefs.has(s.ref.toLowerCase())) throw new AdapterError(`sidecar source ${s.ref} has the same reference as a part in the schematic`, 'bad_sidecar');
  for (const x of [...sc.models, ...sc.blackbox]) if (!compRefs.has(x.ref.toLowerCase())) throw new AdapterError(`sidecar names ${x.ref}, which is not a part in the schematic`, 'bad_sidecar');

  const mk = (c, status, reason_code, detail, extra = {}) => ({
    ref: c.ref, lib: c.lib, part: c.part, value_raw: c.value, status, reason_code: reason_code ?? null, detail, ...extra,
  });

  for (const c of comps.filter(c => !c.ref.startsWith('#'))) {
    const facts = schFacts.get(c.ref) ?? { dnp: false, excludeFromSim: false, sim: {} };
    const simNote = Object.keys(facts.sim).length ? { sim_properties: facts.sim } : {};
    const kindMatch = /^([A-Za-z]+)\d+/.exec(c.ref);
    const prefix = kindMatch ? kindMatch[1].toUpperCase() : '';

    if (facts.dnp || /^dnp$/i.test(c.value.trim()) || /^dnp\b/i.test(c.value.trim())) {
      parts.push(mk(c, 'not_checked', 'out_of_scope', 'DNP (do not populate): removed from the deck', { dnp: true, ...simNote }));
      continue;
    }
    if (facts.excludeFromSim) {
      parts.push(mk(c, 'not_checked', 'out_of_scope', 'marked "exclude from simulation" in the schematic', simNote));
      continue;
    }
    const oos = outOfScopeReason(c.ref, c.lib);
    if (oos && !mdMap.has(c.ref.toLowerCase())) {
      parts.push(mk(c, 'not_checked', 'out_of_scope', oos, simNote));
      continue;
    }
    const bb = bbMap.get(c.ref.toLowerCase());
    if (bb) { parts.push(mk(c, 'not_checked', 'blackbox', `declared a black box in the sidecar: ${bb.reason}`, simNote)); continue; }

    const pins = pinNet.get(c.ref) ?? new Map();
    const md = mdMap.get(c.ref.toLowerCase());
    if (md) {
      const m = loadModelFile(allowDir, md.file);
      if (!m.ok) { parts.push(mk(c, 'not_checked', m.code, m.detail, simNote)); continue; }
      const name = (md.subckt ?? md.model).toLowerCase();
      if (md.subckt !== undefined) {
        if (!m.subckts.has(name)) { parts.push(mk(c, 'not_checked', 'no_model', `subckt ${md.subckt} is not defined in ${md.file}`, simNote)); continue; }
        if (m.subckts.get(name) !== md.ports.length) { parts.push(mk(c, 'not_checked', 'netlist_unsupported', `subckt ${md.subckt} has ${m.subckts.get(name)} ports but the sidecar lists ${md.ports.length}`, simNote)); continue; }
      } else {
        if (!m.models.has(name)) { parts.push(mk(c, 'not_checked', 'no_model', `.model ${md.model} is not defined in ${md.file}`, simNote)); continue; }
        if (!/^[DQMJ]/i.test(c.ref)) { parts.push(mk(c, 'not_checked', 'netlist_unsupported', `a .model device needs a ref starting D, Q, M or J, not ${c.ref}`, simNote)); continue; }
      }
      const bad = md.ports.find(p => p !== null && !pins.has(p));
      if (bad !== undefined) { parts.push(mk(c, 'not_checked', 'netlist_unsupported', `${c.ref} has no pin "${bad}" (pins: ${[...pins.keys()].join(', ')})`, simNote)); continue; }
      // A name defined twice by two different files would be ambiguous for ngspice.
      const clash = [...m.subckts.keys(), ...m.models].find(n => modelNames.has(n) && modelNames.get(n) !== m.sha256);
      if (clash) { parts.push(mk(c, 'not_checked', 'netlist_unsupported', `model name ${clash} is already defined by another file`, simNote)); continue; }
      for (const n of [...m.subckts.keys(), ...m.models]) modelNames.set(n, m.sha256);
      if (!modelBlocks.has(m.sha256)) modelBlocks.set(m.sha256, m.text);
      const nodes = md.ports.map((p, i) => (p === null ? `nc_${c.ref}_${i}` : nodeOf(pins.get(p))));
      const inst = md.subckt !== undefined ? `X${c.ref} ${nodes.join(' ')} ${md.subckt}` : `${c.ref} ${nodes.join(' ')} ${md.model}`;
      lines.push(inst);
      parts.push(mk(c, 'modelled', null, `sidecar model ${md.subckt ?? md.model} from ${md.file}`, { model: { file: md.file, name: md.subckt ?? md.model, kind: md.subckt !== undefined ? 'subckt' : 'model', sha256: m.sha256 }, ...simNote }));
      continue;
    }

    // Plain R / C / L.
    if (['R', 'C', 'L'].includes(prefix) && REF_RE.test(c.ref)) {
      if (facts.sim['Sim.Library'] !== undefined || facts.sim['Sim.Name'] !== undefined || (facts.sim['Sim.Device'] ?? prefix) === 'SPICE') {
        parts.push(mk(c, 'not_checked', 'no_model', 'the part carries a Sim.Library / Sim.Name / SPICE model; Kinux never reads a model path from a schematic, map it in the sidecar', simNote));
        continue;
      }
      const sp = spice.passives.get(c.ref);
      if (spice.duplicated.has(c.ref)) { parts.push(mk(c, 'not_checked', 'netlist_unsupported', 'KiCad\'s SPICE export has more than one line for this part', simNote)); continue; }
      const pinList = [...pins.keys()];
      if (!sp) { parts.push(mk(c, 'not_checked', 'netlist_unsupported', 'KiCad\'s SPICE export has no line for this part', simNote)); continue; }
      if (pinList.length === 2) {
        // The two exports spell root-sheet nets differently (`/GND` vs `GND`), so
        // compare the SPICE nodes each one resolves to.
        const a = [...pins.values()].map(n => nodeOf(n)).sort().join('|');
        const b = [sp.n1, sp.n2].map(n => nodeOf(n)).sort().join('|');
        if (a !== b) { parts.push(mk(c, 'not_checked', 'netlist_unsupported', `the two KiCad exports disagree about ${c.ref}'s nets (${a} vs ${b})`, simNote)); continue; }
      } else if (pinList.length !== 0) {
        parts.push(mk(c, 'not_checked', 'no_model', `${c.ref} has ${pinList.length} pins; a plain ${prefix} has 2`, simNote)); continue;
      }
      const [valueTok, ...dropped] = sp.valueTokens;
      const v = parseKicadValue(valueTok, prefix);
      if (!v.ok) { parts.push(mk(c, 'not_checked', 'no_model', `value "${sp.valueTokens.join(' ')}" cannot be read as a ${prefix} value: ${v.why}`, simNote)); continue; }
      let text = v.text;
      const norm = [];
      if (v.number < 0) { parts.push(mk(c, 'not_checked', 'no_model', `negative ${prefix} value ${valueTok}`, simNote)); continue; }
      if (v.number === 0) {
        if (prefix !== 'R') { parts.push(mk(c, 'not_checked', 'no_model', `a zero-valued ${prefix} is not a usable model`, simNote)); continue; }
        text = ZERO_OHM_REPLACEMENT;
        norm.push('0 ohm jumper modelled as 1 milliohm (measured: ngspice 42 silently substitutes 1 milliohm for R=0, so it is made explicit)');
      }
      if (dropped.length) norm.push(`extra value tokens dropped: ${dropped.join(' ')}`);
      if (/[Mm]|^\d+[RrKkUuNnPp]\d+$/.test(valueTok)) norm.push(`SI prefix read the KiCad way: "${valueTok}" -> ${text} (plain number, no suffix)`);
      for (const n of norm) normalisations.push(`${c.ref}: ${n}`);
      lines.push(`${c.ref} ${nodeOf(sp.n1)} ${nodeOf(sp.n2)} ${text}`);
      parts.push(mk(c, 'modelled', null, `${prefix} ${valueTok} -> ${text}`, { value_si: text, dropped_tokens: dropped, ...simNote }));
      continue;
    }

    const why = Object.keys(facts.sim).length ? `no SPICE model mapped (schematic Sim.* properties are recorded, not used)` : 'no SPICE model: map it in the sidecar or leave it unchecked';
    parts.push(mk(c, 'not_checked', 'no_model', why, simNote));
  }

  for (const s of sc.sources) lines.push(sourceLine(s, nodeOf));
  const usedNames = new Set([...netMap.values()].map(v => v.toLowerCase()));
  for (const a of sc.aliases) {
    if (usedNames.has(a.name.toLowerCase())) throw new AdapterError(`alias ${a.name} is already a net name in the design`, 'bad_sidecar');
    usedNames.add(a.name.toLowerCase());
    lines.push(`Ralias_${a.name} ${a.name} ${nodeOf(a.net)} 1e-3`);
  }

  // The deck. Built only from parsed tokens; no line of KiCad's text is copied.
  const title = `.title kinux kicad-adapter ${basename(schematic ?? 'design')}`.replace(/[^\x20-\x7e]/g, '_');
  const deck = [title, ...lines, ...[...modelBlocks.values()].map(t => t.trim()), '.end'].join('\n') + '\n';
  const s = sanitize(deck);
  if (!s.ok) throw new AdapterError(`the generated deck was rejected by the sanitizer (adapter bug or hostile design):\n${describeViolations(s.violations)}`, 'deck_rejected');

  const manifest = summarise({ aliasList: sc.aliases.map(a => ({ name: a.name, net: a.net, element: `Ralias_${a.name}` })), parts, normalisations, merged, netMap, exp, schematic, sidecarText, hierarchyNote, spiceIgnored: spice.ignored.length, deck, modelFiles: [...modelBlocks.keys()] });
  if (intent) manifest.intent_check = compareIntent(nets, comps, typeof intent === 'string' ? JSON.parse(readFileSync(resolve(intent), 'utf8')) : intent);
  return { netlist: deck, manifest, nets, comps };
}

function summarise({ aliasList, parts, normalisations, merged, netMap, exp, schematic, sidecarText, hierarchyNote, spiceIgnored, deck, modelFiles }) {
  const by = {};
  for (const p of parts) if (p.status === 'not_checked') by[p.reason_code] = (by[p.reason_code] ?? 0) + 1;
  const modelled = parts.filter(p => p.status === 'modelled').length;
  const outOfScope = by.out_of_scope ?? 0;
  const electrical = parts.length - outOfScope;
  return {
    schema: 'kinux.kicad-adapter/1',
    source: { file: schematic ? basename(schematic) : null, kicad_cli: exp.kicadVersion ?? null, deck_sha256: sha256(deck), sidecar_sha256: sidecarText ? sha256(sidecarText) : null },
    parts,
    counts: {
      total: parts.length, modelled, not_checked: parts.length - modelled, by_reason: by,
      electrical, checkable_fraction: electrical === 0 ? 0 : modelled / electrical,
    },
    dnp: parts.filter(p => p.dnp).map(p => p.ref),
    excluded: parts.filter(p => p.status === 'not_checked').map(p => ({ ref: p.ref, reason_code: p.reason_code, detail: p.detail })),
    normalisations,
    nets: Object.fromEntries(netMap),
    ground_merged: merged,
    notes: [hierarchyNote, spiceIgnored ? `${spiceIgnored} line(s) of KiCad's SPICE export were stubs or unsupported and were not used` : null,
      'The deck contains only the modelled parts: every not_checked part was left out, so the simulated circuit is the modelled subset, not the whole board.'].filter(Boolean),
    model_files: modelFiles,
    aliases: aliasList,
  };
}

// ------------------------------------------------------------ cross-check with schematic.intent.json

/**
 * Compare connectivity derived from kicad-cli with an independent intent file
 * ({parts:[{ref}], nets:[{name,pins:["R1.1"]}]}). Reports every difference.
 */
export function compareIntent(nets, comps, intent) {
  const strip = n => (n.startsWith('/') ? n.slice(1) : n);
  const derived = new Map();
  for (const n of nets) {
    const pins = new Set(n.nodes.filter(nd => !nd.ref.startsWith('#')).map(nd => `${nd.ref}.${nd.pin}`));
    if (pins.size === 0 || /^unconnected-/.test(n.name)) continue;
    derived.set(strip(n.name), pins);
  }
  const byPins = new Map([...derived].map(([k, v]) => [[...v].sort().join(','), k]));
  const mismatches = [];
  const renamed = [];
  const intentNames = new Set();
  for (const n of intent.nets ?? []) {
    const name = strip(n.name);
    intentNames.add(name);
    const want = new Set(n.pins);
    const got = derived.get(name);
    if (!got) {
      const alt = byPins.get([...want].sort().join(','));
      if (alt) renamed.push({ intent: name, kicad: alt });
      else mismatches.push({ net: name, kind: 'net_missing', detail: `no net with this name or this pin set in the kicad-cli netlist` });
      continue;
    }
    const missing = [...want].filter(p => !got.has(p));
    const extra = [...got].filter(p => !want.has(p));
    if (missing.length || extra.length) mismatches.push({ net: name, kind: 'pins_differ', missing_in_kicad: missing, extra_in_kicad: extra });
  }
  const renamedKicad = new Set(renamed.map(r => r.kicad));
  for (const [name] of derived) if (!intentNames.has(name) && !renamedKicad.has(name)) mismatches.push({ net: name, kind: 'net_not_in_intent', detail: 'present in kicad-cli, absent from the intent file' });
  const refs = new Set(comps.map(c => c.ref));
  const iref = new Set((intent.parts ?? []).map(p => p.ref));
  for (const r of iref) if (!refs.has(r)) mismatches.push({ part: r, kind: 'part_missing_in_kicad' });
  for (const r of refs) if (!r.startsWith('#') && !iref.has(r)) mismatches.push({ part: r, kind: 'part_not_in_intent' });
  return { agrees: mismatches.length === 0, intent_nets: (intent.nets ?? []).length, kicad_nets: derived.size, renamed_only: renamed, mismatches };
}

// ------------------------------------------------------------ reporting

const pct = f => `${(f * 100).toFixed(1)}%`;

/** Plain-text summary: the checkable fraction and every excluded part with its reason. */
export function formatSummary(manifest) {
  const c = manifest.counts;
  const L = [];
  L.push(`design: ${c.total} parts, ${c.modelled} modelled, ${c.not_checked} not checked (${Object.entries(c.by_reason).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
  L.push(`checkable fraction: ${pct(c.checkable_fraction)} (${c.modelled} modelled of ${c.electrical} electrical parts; out-of-scope parts are not counted)`);
  if (c.modelled === 0) L.push('NOTHING IS CHECKABLE: no part of this design has a model. No score is claimed.');
  else L.push('the simulated circuit contains only the modelled parts; every excluded part was left out of the simulation.');
  for (const e of manifest.excluded) L.push(`  excluded ${e.ref}: ${e.reason_code} -- ${e.detail}`);
  for (const n of manifest.normalisations) L.push(`  normalised ${n}`);
  if (manifest.ground_merged.length) L.push(`  nets merged into ground 0: ${manifest.ground_merged.join(', ')}`);
  for (const n of manifest.notes) L.push(`  note: ${n}`);
  if (manifest.intent_check) {
    const i = manifest.intent_check;
    L.push(`connectivity vs intent file: ${i.agrees ? 'agrees' : `${i.mismatches.length} mismatch(es)`} (${i.kicad_nets} kicad nets, ${i.intent_nets} intent nets${i.renamed_only.length ? `, ${i.renamed_only.length} renamed only` : ''})`);
    for (const m of i.mismatches) L.push(`  mismatch: ${JSON.stringify(m)}`);
  }
  return L.join('\n');
}

/** Node names of the deck's own circuit (not the insides of inlined subcircuits). */
export function deckNodes(deck) {
  const nodes = new Set(['0']);
  let depth = 0;
  for (const l of deck.split('\n')) {
    if (/^\.subckt/i.test(l)) { depth++; continue; }
    if (/^\.ends/i.test(l)) { depth--; continue; }
    if (depth !== 0 || !/^[A-Za-z]/.test(l)) continue;
    const t = l.trim().split(/\s+/);
    const first = t[0][0].toUpperCase();
    const n = first === 'X' ? t.length - 2 : first === 'Q' || first === 'J' ? 3 : first === 'M' ? 4 : 2;
    for (const x of t.slice(1, 1 + n)) nodes.add(x.toLowerCase());
  }
  return nodes;
}

/**
 * Every net name a check suite uses (scope nets, `source:` ports, V() targets)
 * must be a node of the deck. One that is not is an ERROR the caller must
 * surface: a `source:` on an unknown name silently drives a brand-new,
 * unconnected node, and a check on it would pass for the wrong reason.
 * @returns {Array<{name:string, where:string, hint:string}>}
 */
export function unknownCheckNets(suite, manifest, deck) {
  const nodes = deckNodes(deck);
  const problems = [];
  const seen = new Set();
  const test = (name, where) => {
    if (!name || nodes.has(name.toLowerCase()) || /^gnd$/i.test(name)) return;
    if (seen.has(`${where}|${name}`)) return;
    seen.add(`${where}|${name}`);
    const stripped = name.startsWith('/') ? name.slice(1) : name;
    let hint = 'no such net in the deck';
    if (nodes.has(stripped.toLowerCase())) hint = `the deck calls this net "${stripped}" (root-sheet local labels lose KiCad's leading "/")`;
    else if (name in manifest.nets || `/${name}` in manifest.nets) hint = 'the net exists in KiCad but no modelled part touches it, so it is not in the deck';
    problems.push({ name, where, hint });
  };
  for (const b of suite.blocks ?? []) {
    for (const n of b.scope?.nets ?? []) test(n, 'scope');
    for (const src of b.sources ?? []) test(src.port, 'source');
    for (const a of b.assertions ?? []) {
      const m = a.measurable;
      if (m?.kind === 'voltage') for (const t of String(m.target).split(',')) test(t.trim(), 'V()');
    }
  }
  return problems;
}

/** A Markdown section for the top of report.md, so the score never travels without it. */
export function renderDesignSection(manifest) {
  const c = manifest.counts;
  const L = ['## Design model (KiCad)', '',
    `Parts: **${c.total}**; modelled **${c.modelled}**; not checked **${c.not_checked}**. Checkable fraction **${pct(c.checkable_fraction)}** (${c.modelled} of ${c.electrical} electrical parts).`, '',
    c.modelled === 0 ? '**Nothing is checkable. No score is claimed.**' : 'The mutation score below is a score for the **modelled subset only**. Excluded parts were not simulated.', ''];
  if (manifest.excluded.length) {
    L.push('| Part | Reason | Detail |', '|---|---|---|');
    for (const e of manifest.excluded) L.push(`| ${e.ref} | ${e.reason_code} | ${String(e.detail).replace(/\|/g, '\\|')} |`);
    L.push('');
  }
  return L.join('\n');
}
