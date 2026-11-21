// The thermal check grammar, and the worker that turns it into verdicts.
//
// A closed, reviewable language in the same spirit as (and borrowing the
// number parser of) workers/ngspice/assertions.mjs:
//
//   measurables   T(<refdes>)   temperature of the part's single thermal node, degC
//                 P(<refdes>)   power dissipated in the part, W
//   point         optional `at <time>` on T(): first-order transient from a
//                 cold start (power step at t = 0, part at ambient)
//   comparators   between <a> and <b>   < <x>   > <x>
//                 `< rated` uses the part's own sourced limit from the thermal
//                 model (t_max_c for T, p_max_w for P)
//   fields        assert: <assertion>
//                 analysis: op          (optional; the only electrical analysis
//                                        power is taken from today)
//                 scope: parts A, B     (optional, informational)
//
// Example:
//
//   ## Thermal
//
//   analysis: op
//   assert: P(RSH) < rated
//   assert: T(RSH) < 125
//   assert: T(RSH) at 5 < 75
//
// Where the numbers come from:
//
//   P  = I²R. I is the current ngspice MEASURED through the resistor in a DC
//        operating point of the very netlist under test (baseline or mutant);
//        R is that resistor's value in the same netlist. Only resistors have a
//        power here: anything else is NOT_CHECKED / out_of_scope.
//   T  = Ta + P·Rθ                      (steady state)
//   T  = Ta + P·Rθ·(1 − e^(−t/τ))       (at <t>), τ = Rθ·Cθ
//
// One-way chain: the temperature never feeds back into R.
//
// Rules, as for the electrical worker:
//
//  1. HONESTY. Anything that could not really be evaluated -- an unparseable
//     line, a part with no thermal data, a value without a source, a current
//     ngspice could not measure -- is NOT_CHECKED or ERROR with a reason_code.
//     Never PASS, never FAIL. Missing thermal data is `no_material_data`.
//  2. NO ESCAPE HATCH. There is no raw solver syntax: a line starting with `.`
//     is refused, refdeses must match a narrow allowlist, and the only thing
//     that ever reaches ngspice is an electrical assertion this module builds
//     itself from an allowlisted refdes (`I(<refdes>) between ...`), which then
//     goes through the ngspice worker's own compiler and sanitizer.

import { parseSpiceNumber, verifySimulation } from '../ngspice/assertions.mjs';
import {
  MODEL_STEADY, MODEL_TRANSIENT, LIMITATION, THERMAL_TOOL_ID,
  componentThermal, powerI2R, steadyTemperature, transientTemperature, timeConstant,
} from './model.mjs';

export const THERMAL_LAYER = 'thermal';
export const THERMAL_SOLVER = 'lumped-thermal';

/** A refusal that names its line and a machine code, like SimulationParseError. */
export class ThermalParseError extends Error {
  constructor(line, message, code = 'invalid_syntax') {
    super(`line ${line}: ${message}`);
    this.name = 'ThermalParseError';
    this.line = line;
    this.code = code;
    // A refused assertion was not evaluated: NOT_CHECKED, never dropped. Same
    // reason_code the electrical worker uses for check text it cannot accept.
    this.reason_code = 'netlist_unsupported';
  }
}

/** Refdeses we accept. Deliberately narrower than the electrical worker's targets. */
const SAFE_REFDES = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export const UNIT_LABEL = Object.freeze({ temperature: '°C', power: 'W' });
const UNITS_FOR = {
  temperature: new Set(['', 'c', 'degc']),
  power: new Set(['', 'w', 'watt', 'watts']),
  time: new Set(['', 's', 'sec']),
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

function number(raw, line, unitKind, what) {
  let n;
  try {
    n = parseSpiceNumber(raw, line);
  } catch (err) {
    throw new ThermalParseError(line, err.message.replace(/^line \d+: /, ''), err.code ?? 'invalid_number');
  }
  if (!UNITS_FOR[unitKind].has(n.unit.toLowerCase())) {
    throw new ThermalParseError(
      line,
      `unit "${n.unit}" does not belong to ${what} (expected one of: ${[...UNITS_FOR[unitKind]].filter(Boolean).join(', ')}, or none)`,
      'unit_not_for_measurable',
    );
  }
  return n;
}

/**
 * Parse one thermal assertion:
 *   `T(ref) [at <t>] (between <a> and <b> | < <x> | > <x> | < rated)`
 *   `P(ref) (between <a> and <b> | < <x> | > <x> | < rated)`
 */
export function parseThermalAssertion(raw, line = 1) {
  const text = String(raw ?? '').trim();
  if (text.length > 200) throw new ThermalParseError(line, 'assertion is longer than 200 characters', 'too_long');
  const m = /^([TP])\(([^()\s]*)\)\s+(.+)$/i.exec(text);
  if (!m) throw new ThermalParseError(line, `invalid thermal assertion "${text}"`, 'invalid_assertion');
  const target = m[2];
  if (!SAFE_REFDES.test(target)) {
    throw new ThermalParseError(line, `invalid component reference "${target}"`, 'invalid_target');
  }
  const kind = m[1].toUpperCase() === 'T' ? 'temperature' : 'power';
  const what = kind === 'temperature' ? 'T()' : 'P()';
  let rest = m[3].trim();

  let at = null;
  const atMatch = /^at\s+(\S+)\s+(.+)$/i.exec(rest);
  if (atMatch) {
    if (kind !== 'temperature') {
      throw new ThermalParseError(line, 'P() is a steady value here; it takes no "at" point', 'at_not_supported');
    }
    at = number(atMatch[1], line, 'time', 'a time point');
    if (!(at.value > 0)) throw new ThermalParseError(line, '"at" time must be > 0 s', 'invalid_time');
    rest = atMatch[2].trim();
  }

  let comparator;
  const between = /^between\s+(\S+)\s+and\s+(\S+)$/i.exec(rest);
  if (between) {
    const lower = number(between[1], line, kind, what);
    const upper = number(between[2], line, kind, what);
    if (lower.value >= upper.value) {
      throw new ThermalParseError(line, 'between lower bound must be less than upper bound', 'bounds_not_ordered');
    }
    comparator = { kind: 'between', lower, upper };
  } else {
    const single = /^([<>])\s*(\S+)$/.exec(rest);
    if (!single) throw new ThermalParseError(line, `invalid comparator "${rest}"`, 'invalid_comparator');
    if (/^rated$/i.test(single[2])) {
      if (single[1] !== '<') {
        throw new ThermalParseError(line, '"rated" is an upper limit; only "< rated" is meaningful', 'invalid_comparator');
      }
      comparator = { kind: 'less-than', bound: null, rated: true };
    } else {
      const bound = number(single[2], line, kind, what);
      comparator = single[1] === '<' ? { kind: 'less-than', bound } : { kind: 'greater-than', bound };
    }
  }
  return { raw: text, line, measurable: { kind, target }, comparator, at };
}

/** Parse a list without throwing: parsed assertions plus one structured refusal per bad line. */
export function parseThermalAssertions(inputs, { startLine = 1 } = {}) {
  const assertions = [];
  const errors = [];
  (inputs ?? []).forEach((input, i) => {
    if (input && typeof input === 'object') {
      // A hand-built object passes the same allowlist the parser applies.
      if (!SAFE_REFDES.test(String(input.measurable?.target ?? ''))) {
        errors.push({ raw: String(input.raw ?? ''), line: input.line ?? startLine + i, code: 'invalid_target', message: `invalid component reference "${input.measurable?.target}"` });
      } else assertions.push(input);
      return;
    }
    try {
      assertions.push(parseThermalAssertion(String(input), startLine + i));
    } catch (err) {
      if (!(err instanceof ThermalParseError)) throw err;
      errors.push({ raw: String(input), line: err.line, code: err.code, message: err.message });
    }
  });
  return { assertions, errors };
}

function markdownFence(line) {
  const m = /^(`{3,}|~{3,})/.exec(line);
  return m ? m[1] : null;
}

/**
 * Parse every `## Thermal` section of a Markdown document. Like
 * parseSimulationBlocks: fenced code and HTML comments are not live input, a
 * raw solver line is refused, an unknown field is refused, and a block must
 * have at least one assertion. Throws ThermalParseError.
 *
 * @returns {Array<{kind: 'thermal', line: number, analysis: {kind: 'op'}, scope: string[]|null, assertions: object[]}>}
 */
export function parseThermalBlocks(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const blocks = [];
  let fence = null;
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const f = markdownFence(t);
    if (fence) { if (f && f[0] === fence[0] && f.length >= fence.length) fence = null; continue; }
    if (comment) { if (t.includes('-->')) comment = false; continue; }
    if (f) { fence = f; continue; }
    if (t.startsWith('<!--')) { if (!t.includes('-->')) comment = true; continue; }
    if (!/^##\s+Thermal\s*$/i.test(t)) continue;

    const headingLine = i + 1;
    const body = [];
    let j = i + 1;
    let bf = null;
    let bc = false;
    for (; j < lines.length; j++) {
      const s = lines[j].trim();
      const g = markdownFence(s);
      if (bf) { if (g && g[0] === bf[0] && g.length >= bf.length) bf = null; continue; }
      if (bc) { if (s.includes('-->')) bc = false; continue; }
      if (g) { bf = g; continue; }
      if (/^#{1,6}\s+/.test(s)) break;
      if (s.startsWith('<!--')) { if (!s.includes('-->')) bc = true; continue; }
      if (s.startsWith('.') || /^[A-Za-z]+\s*:/.test(s)) body.push({ text: s, line: j + 1 });
    }
    blocks.push(parseThermalBlock(body, headingLine));
    i = j - 1;
  }
  return blocks;
}

function parseThermalBlock(body, headingLine) {
  let analysis = null;
  let scope = null;
  const assertions = [];
  for (const e of body) {
    if (e.text.startsWith('.')) {
      throw new ThermalParseError(e.line, `raw solver statement "${e.text.split(/\s/, 1)[0]}" is not allowed`, 'raw_statement_not_allowed');
    }
    const fm = /^([A-Za-z]+)\s*:\s*(.+)$/.exec(e.text);
    if (!fm) throw new ThermalParseError(e.line, `expected "field: value", got "${e.text}"`, 'malformed_field');
    const field = fm[1].toLowerCase();
    const value = fm[2].trim();
    switch (field) {
      case 'analysis':
        if (analysis) throw new ThermalParseError(e.line, 'duplicate analysis', 'duplicate_field');
        if (!/^op$/i.test(value)) {
          throw new ThermalParseError(e.line, `unsupported analysis "${value}": power is taken from a DC operating point ("op") only`, 'unsupported_analysis');
        }
        analysis = { kind: 'op' };
        break;
      case 'scope': {
        if (scope) throw new ThermalParseError(e.line, 'duplicate scope', 'duplicate_field');
        const sm = /^parts\s+(.+)$/i.exec(value);
        const parts = sm ? sm[1].replace(/^\[(.*)\]$/, '$1').split(',').map(s => s.trim()).filter(Boolean) : [];
        if (!parts.length || parts.some(p => !SAFE_REFDES.test(p))) {
          throw new ThermalParseError(e.line, 'scope must be "parts <A>, <B>"', 'invalid_scope');
        }
        scope = [...new Set(parts)];
        break;
      }
      case 'assert':
        assertions.push(parseThermalAssertion(value, e.line));
        break;
      default:
        throw new ThermalParseError(e.line, `unknown Thermal field "${field}"`, 'unknown_field');
    }
  }
  if (!assertions.length) throw new ThermalParseError(headingLine, 'Thermal block needs at least one assertion', 'no_assertions');
  return { kind: 'thermal', line: headingLine, analysis: analysis ?? { kind: 'op' }, scope, assertions };
}

/* -------------------------------------------------------------------------- */
/* The netlist side: R values and measured currents                           */
/* -------------------------------------------------------------------------- */

/**
 * The resistance of one resistor, read from the netlist under test (so a
 * mutated value is seen). Refuses anything it cannot read unambiguously:
 * a parameter expression, a refdes that appears twice, a part inside a
 * subcircuit definition.
 */
export function resistorValue(netlist, refdes) {
  const want = refdes.toLowerCase();
  const hits = [];
  let inSubckt = false;
  const lines = String(netlist ?? '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, i) => {
    if (i === 0) return; // SPICE title line
    const t = raw.trim();
    if (/^\.subckt\b/i.test(t)) inSubckt = true;
    if (/^\.ends\b/i.test(t)) { inSubckt = false; return; }
    if (!t || t.startsWith('*') || t.startsWith('.') || t.startsWith('+')) return;
    const tok = t.split(/\s+/);
    if (tok[0].toLowerCase() === want) hits.push({ tok, inSubckt, line: i + 1, next: lines[i + 1] ?? '' });
  });
  if (hits.length === 0) return { ok: false, reason_code: 'netlist_unsupported', reason: `${refdes} does not exist in this netlist` };
  if (hits.length > 1) return { ok: false, reason_code: 'netlist_unsupported', reason: `${refdes} appears ${hits.length} times; its resistance is ambiguous` };
  const h = hits[0];
  if (h.inSubckt) return { ok: false, reason_code: 'netlist_unsupported', reason: `${refdes} is inside a subcircuit definition; per-instance power is not resolved` };
  if (/^\s*\+/.test(h.next)) return { ok: false, reason_code: 'netlist_unsupported', reason: `${refdes} continues on the next line; not read` };
  let token = h.tok[3];
  if (token && /^r\s*=/i.test(token)) token = token.replace(/^r\s*=\s*/i, '');
  try {
    const n = parseSpiceNumber(token ?? '');
    if (!(n.value > 0)) throw new Error('not positive');
    return { ok: true, value: n.value, text: token, line: h.line };
  } catch {
    return { ok: false, reason_code: 'netlist_unsupported', reason: `${refdes} value "${token ?? ''}" is not a plain number (expressions are not evaluated here)` };
  }
}

/**
 * Measure the DC current through each resistor with the ngspice worker. The
 * probe is an ordinary electrical assertion built here from an allowlisted
 * refdes; the bound is so wide it never matters -- only `measured` is used.
 */
export async function probeCurrents(netlist, refdeses, { subject, timeoutMs } = {}) {
  const out = new Map();
  if (!refdeses.length) return { currents: out, deck: null };
  const assertions = refdeses.map(r => `I(${r}) between -1e12 and 1e12`);
  const res = await verifySimulation(netlist, { analysis: 'op', assertions }, { subject, testIdPrefix: 'thermal-probe', timeoutMs });
  const byText = new Map(res.results.map(r => [r.assertion, r]));
  refdeses.forEach((r, i) => {
    const e = byText.get(assertions[i]);
    if (e && (e.verdict === 'PASS' || e.verdict === 'FAIL') && Number.isFinite(e.measured)) {
      out.set(r, { ok: true, current: e.measured });
    } else {
      out.set(r, {
        ok: false,
        verdict: e?.verdict === 'ERROR' ? 'ERROR' : 'NOT_CHECKED',
        reason_code: e?.reason_code ?? 'tool_error',
        reason: `ngspice could not measure the current through ${r}: ${e?.reason ?? 'no probe result'}`,
      });
    }
  });
  return { currents: out, deck: res.deck };
}

/* -------------------------------------------------------------------------- */
/* Verdicts                                                                   */
/* -------------------------------------------------------------------------- */

const fmt = (x, d = 4) => (Number.isFinite(x) ? Number(x.toPrecision(d)).toString() : String(x));

function base(test_id, subject, assertion, model) {
  return { test_id, subject, assertion, model, layer: THERMAL_LAYER, solver: THERMAL_SOLVER };
}

function inconclusive(test_id, subject, assertion, model, verdict, reason_code, reason) {
  return {
    ...base(test_id, subject, assertion, model),
    verdict,
    reason_code,
    reason: `${model}: ${reason}`.slice(0, 2000),
  };
}

function compare(measured, c, bound) {
  if (c.kind === 'between') return measured >= c.lower.value && measured <= c.upper.value;
  if (c.kind === 'less-than') return measured < bound;
  return measured > bound;
}

/**
 * The whole job for one `## Thermal` block: parse, look up thermal data,
 * measure currents with ngspice, compute P and T, decide. One result per
 * assertion, every one carrying its model.
 *
 * @param {string} netlist the circuit under test (baseline or mutant)
 * @param {{assertions: Array<string|object>}} block
 * @param {object|null} thermalModel the design's thermal model (see README)
 * @param {{subject?: string, testIdPrefix?: string, timeoutMs?: number}} [opts]
 */
export async function verifyThermal(netlist, block, thermalModel, opts = {}) {
  const subject = opts.subject ?? 'baseline';
  const prefix = opts.testIdPrefix ?? 'thermal';
  const results = [];

  const parsed = parseThermalAssertions(block?.assertions ?? []);
  parsed.errors.forEach((e, i) => {
    results.push(inconclusive(`${prefix}:${e.line}:e${i + 1}`, subject, e.raw, MODEL_STEADY, 'NOT_CHECKED', 'netlist_unsupported',
      `assertion refused [${e.code}] ${e.message}; nothing was computed`));
    results[results.length - 1].refusal_code = e.code;
  });

  // Plan each assertion, settle everything decidable without a simulator.
  const plans = parsed.assertions.map((a, i) => {
    const test_id = `${prefix}:${a.line}:t${i + 1}`;
    const model = a.at ? MODEL_TRANSIENT : MODEL_STEADY;
    const ref = a.measurable.target;
    const plan = { a, test_id, model, ref, done: null };
    if (!/^r/i.test(ref)) {
      plan.done = inconclusive(test_id, subject, a.raw, model, 'NOT_CHECKED', 'out_of_scope',
        `${ref} is not a resistor; this worker only derives power as I²R for resistors`);
      return plan;
    }
    const th = componentThermal(thermalModel, ref);
    plan.th = th;
    const missing = [];
    if (a.measurable.kind === 'power') {
      if (a.comparator.rated && !th.pMax) missing.push(`no sourced power rating (p_max_w) for ${ref}`);
    } else {
      if (!th.rth) missing.push(`no sourced thermal resistance for ${ref}`);
      if (!th.ambient) missing.push('no sourced ambient temperature');
      if (a.at && !th.cth) missing.push(`no sourced thermal capacitance (cth_j_per_k) for ${ref}, so no transient`);
      if (a.comparator.rated && !th.tMax) missing.push(`no sourced maximum temperature (t_max_c) for ${ref}`);
    }
    if (missing.length) {
      const extra = th.problems.length ? ` (${[...new Set(th.problems)].join('; ')})` : '';
      plan.done = inconclusive(test_id, subject, a.raw, model, 'NOT_CHECKED', 'no_material_data',
        `${missing.join('; ')}${extra}. No value is guessed`);
      return plan;
    }
    const r = resistorValue(netlist, ref);
    if (!r.ok) {
      plan.done = inconclusive(test_id, subject, a.raw, model, 'NOT_CHECKED', r.reason_code, r.reason);
      return plan;
    }
    plan.r = r;
    return plan;
  });

  const need = [...new Set(plans.filter(p => !p.done).map(p => p.ref))];
  const { currents } = await probeCurrents(netlist, need, { subject, timeoutMs: opts.timeoutMs });

  for (const p of plans) {
    if (p.done) { results.push(p.done); continue; }
    const probe = currents.get(p.ref);
    if (!probe?.ok) {
      results.push(inconclusive(p.test_id, subject, p.a.raw, p.model, probe?.verdict ?? 'ERROR', probe?.reason_code ?? 'tool_error', probe?.reason ?? 'no probe'));
      continue;
    }
    const I = probe.current;
    const R = p.r.value;
    const P = powerI2R(I, R);
    const working = { current_a: I, resistance_ohm: R, power_w: P };
    let measured, bound, units, text;
    const c = p.a.comparator;

    if (p.a.measurable.kind === 'power') {
      measured = P;
      units = UNIT_LABEL.power;
      bound = c.rated ? p.th.pMax.value : c.bound?.value;
      text = `P = I²R = (${fmt(I)} A)² × ${fmt(R)} Ω = ${fmt(P)} W` + (c.rated ? `; rated ${p.th.pMax.value} W (${p.th.pMax.source})` : '');
    } else {
      const Ta = p.th.ambient.value;
      const Rth = p.th.rth.value;
      const rthText = p.th.rth.chain ? `(${p.th.rth.chain.map(x => fmt(x.value)).join(' + ')}) K/W` : `${fmt(Rth)} K/W`;
      units = UNIT_LABEL.temperature;
      working.ambient_c = Ta;
      working.rth_c_per_w = Rth;
      if (p.a.at) {
        const Cth = p.th.cth.value;
        const t = p.a.at.value;
        const tau = timeConstant(Rth, Cth);
        measured = transientTemperature(Ta, P, Rth, Cth, t);
        Object.assign(working, { cth_j_per_k: Cth, tau_s: tau, t_s: t });
        text = `T(${fmt(t)} s) = Ta + I²R·Rθ·(1 − e^(−t/τ)) = ${fmt(Ta)} + ${fmt(P)} W × ${rthText} × (1 − e^(−${fmt(t)}/${fmt(tau)})) = ${fmt(measured)} °C, τ = Rθ·Cθ = ${fmt(tau)} s`;
      } else {
        measured = steadyTemperature(Ta, P, Rth);
        text = `T = Ta + I²R·Rθ = ${fmt(Ta)} °C + (${fmt(I)} A)² × ${fmt(R)} Ω × ${rthText} = ${fmt(Ta)} + ${fmt(P)} W × ${fmt(Rth)} K/W = ${fmt(measured)} °C`;
      }
      bound = c.rated ? p.th.tMax.value : c.bound?.value;
      text += `; Ta: ${p.th.ambient.source}; Rθ: ${p.th.rth.source}` + (c.rated ? `; rated ${p.th.tMax.value} °C (${p.th.tMax.source})` : '');
    }

    const pass = compare(measured, c, bound);
    const limit = c.kind === 'between' ? `${c.lower.value} .. ${c.upper.value}` : bound;
    results.push({
      ...base(p.test_id, subject, p.a.raw, p.model),
      verdict: pass ? 'PASS' : 'FAIL',
      measured,
      limit,
      units,
      reason: `${p.model}: ${text}. Limits: ${LIMITATION}.`.slice(0, 2000),
      working,
    });
  }

  return { results, tool: THERMAL_TOOL_ID };
}
