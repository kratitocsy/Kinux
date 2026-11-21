// A closed assertion language for motion checks over a recorded trajectory.
//
//   assertion   := measurable comparator
//   measurable  := peak_torque(<joint>)                       N*m  max |joint-side actuator torque| over every step
//                | angle(<joint>)                             rad  every recorded sample of the hinge angle
//                | settling_time(<joint>, <target>, <band>)   s    target and band in rad
//   comparator  := < <number> [unit]
//                | > <number> [unit]
//                | between <number> [unit] and <number> [unit]
//   units       := N*m | Nm (torque); rad | deg (angle); s | ms (time)
//   <joint>     := [A-Za-z_][A-Za-z0-9_.-]{0,63}
//
// settling_time takes `<` only. angle `<` bounds the maximum, `>` the minimum,
// `between` both. Comparisons are strict for < and >, inclusive for between.
// Only hinge joints are supported. There is no escape hatch: anything else is
// refused at parse time and becomes NOT_CHECKED with a reason, never PASS.
//
// Honesty rule (contracts/README.md rule 1): an assertion that could not be
// evaluated -- unparseable, unknown joint, unactuated joint, a record too short
// to show settling -- is NOT_CHECKED with a reason_code. Never PASS, never FAIL.

import * as ANALYSIS from './analysis.mjs';

const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
const JOINT = '[A-Za-z_][A-Za-z0-9_.-]{0,63}';
const UNIT = '(?:N\\*m|Nm|rad|deg|ms|s)';

export const MEASURABLES = Object.freeze({
  peak_torque: { units: 'N*m', allowed: ['N*m', 'Nm'], comparators: ['<', '>', 'between'] },
  angle: { units: 'rad', allowed: ['rad', 'deg'], comparators: ['<', '>', 'between'] },
  settling_time: { units: 's', allowed: ['s', 'ms'], comparators: ['<'] },
});

const TO_SI = { 'N*m': 1, Nm: 1, rad: 1, deg: Math.PI / 180, s: 1, ms: 1e-3 };

export class MotionAssertionError extends Error {
  constructor(message, code = 'invalid_assertion') { super(message); this.code = code; }
}

function number(raw, unit, kind) {
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new MotionAssertionError(`not a finite number: ${raw}`, 'invalid_number');
  if (unit === undefined) return v;
  if (!MEASURABLES[kind].allowed.includes(unit)) {
    throw new MotionAssertionError(`unit ${unit} does not fit ${kind} (use ${MEASURABLES[kind].allowed.join(' or ')})`, 'invalid_unit');
  }
  return v * TO_SI[unit];
}

const MEAS_RE = new RegExp(
  `^(peak_torque|angle)\\(\\s*(${JOINT})\\s*\\)` +
  `|^(settling_time)\\(\\s*(${JOINT})\\s*,\\s*(${NUM})\\s*(?:rad)?\\s*,\\s*(${NUM})\\s*(?:rad)?\\s*\\)`,
);
const CMP_RE = new RegExp(
  `^(?:(<|>)\\s*(${NUM})\\s*(${UNIT})?|between\\s+(${NUM})\\s*(${UNIT})?\\s+and\\s+(${NUM})\\s*(${UNIT})?)$`,
);

/** Parse one assertion line. Throws MotionAssertionError. */
export function parseMotionAssertion(raw, line = 1) {
  const text = String(raw).trim();
  if (text.length > 256) throw new MotionAssertionError(`line ${line}: assertion longer than 256 characters`);
  const m = text.match(MEAS_RE);
  if (!m) throw new MotionAssertionError(`line ${line}: unknown measurable in "${text}" (expected peak_torque(j), angle(j) or settling_time(j, target, band))`, 'unknown_measurable');
  const kind = m[1] ?? m[3];
  const joint = m[2] ?? m[4];
  const measurable = { kind, joint };
  if (kind === 'settling_time') {
    measurable.target = Number(m[5]);
    measurable.band = Number(m[6]);
    if (!Number.isFinite(measurable.target) || !(measurable.band > 0)) throw new MotionAssertionError(`line ${line}: settling target must be finite and band positive`, 'invalid_number');
  }
  const rest = text.slice(m[0].length).trim();
  const c = rest.match(CMP_RE);
  if (!c) throw new MotionAssertionError(`line ${line}: unknown comparator "${rest}" (expected < x, > x, or between a and b)`, 'unknown_comparator');
  let comparator;
  if (c[1]) comparator = { kind: c[1] === '<' ? 'less-than' : 'greater-than', bound: number(c[2], c[3], kind) };
  else {
    comparator = { kind: 'between', lower: number(c[4], c[5], kind), upper: number(c[6], c[7], kind) };
    if (!(comparator.lower <= comparator.upper)) throw new MotionAssertionError(`line ${line}: between needs lower <= upper`, 'invalid_number');
  }
  const sym = comparator.kind === 'less-than' ? '<' : comparator.kind === 'greater-than' ? '>' : 'between';
  if (!MEASURABLES[kind].comparators.includes(sym)) throw new MotionAssertionError(`line ${line}: ${kind} only supports ${MEASURABLES[kind].comparators.join(', ')}`, 'unknown_comparator');
  return { raw: text, line, measurable, comparator, units: MEASURABLES[kind].units };
}

/** Parse a block of lines (or an array). Blank lines and `#` comments are skipped. Never throws. */
export function parseMotionAssertions(input) {
  const lines = Array.isArray(input) ? input : String(input).split('\n');
  const assertions = [], errors = [];
  lines.forEach((raw, i) => {
    const text = String(raw).trim();
    if (!text || text.startsWith('#')) return;
    try { assertions.push(parseMotionAssertion(text, i + 1)); }
    catch (e) { errors.push({ line: i + 1, raw: text, code: e.code ?? 'invalid_assertion', message: e.message }); }
  });
  return { assertions, errors };
}

export function describeComparator(c) {
  if (c.kind === 'less-than') return `< ${c.bound}`;
  if (c.kind === 'greater-than') return `> ${c.bound}`;
  return `${c.lower} .. ${c.upper}`;
}

/**
 * Measure one assertion on a trajectory. Returns
 *   { ok:true, measured:number, pass:boolean }  or  { ok:false, reason_code, reason }.
 * `measured` is the value the verdict rests on (for angle: the extreme nearest
 * to, or furthest past, the bound that decides it).
 */
export function measureAssertion(traj, a) {
  const { findJoint, angleRange, settlingTime, peakJointTorque, jointIsActuated } = ANALYSIS;
  const j = findJoint(traj, a.measurable.joint);
  if (!j) return { ok: false, reason_code: 'out_of_scope', reason: `no joint named ${a.measurable.joint} in the model` };
  if (j.type !== 'hinge') return { ok: false, reason_code: 'out_of_scope', reason: `joint ${j.name} is ${j.type}; motion checks support hinge joints only` };
  const c = a.comparator;
  switch (a.measurable.kind) {
    case 'peak_torque': {
      if (!jointIsActuated(traj, j)) return { ok: false, reason_code: 'out_of_scope', reason: `no actuator drives joint ${j.name}, so it has no actuator torque to check` };
      const measured = peakJointTorque(traj, j).abs;
      return { ok: true, measured, pass: compare(measured, c) };
    }
    case 'angle': {
      const { min, max } = angleRange(traj, j);
      if (c.kind === 'less-than') return { ok: true, measured: max, pass: max < c.bound };
      if (c.kind === 'greater-than') return { ok: true, measured: min, pass: min > c.bound };
      const pass = min >= c.lower && max <= c.upper;
      const measured = (c.lower - min) > (max - c.upper) ? min : max; // the worse margin
      return { ok: true, measured, pass };
    }
    case 'settling_time': {
      const s = settlingTime(traj, j, a.measurable.target, a.measurable.band);
      if (!s.settled) return { ok: true, measured: `not settled by t=${s.t_end} s`, pass: false, unsettled: true };
      if (s.at_end) return { ok: false, reason_code: 'out_of_scope', reason: `joint ${j.name} enters the band only at the last sample; record longer to show it stays there` };
      return { ok: true, measured: s.t, pass: s.t < c.bound };
    }
    default:
      return { ok: false, reason_code: 'out_of_scope', reason: `unknown measurable ${a.measurable.kind}` };
  }
}

function compare(x, c) {
  if (c.kind === 'less-than') return x < c.bound;
  if (c.kind === 'greater-than') return x > c.bound;
  return x >= c.lower && x <= c.upper;
}

