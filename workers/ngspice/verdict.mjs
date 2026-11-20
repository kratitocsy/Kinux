// Turn ngspice measurements into contract verdicts.
//
// The honesty rule, which is not negotiable: a check that did not actually run
// must never look like it passed, and must never look like it failed either.
// If the model is missing, the run did not converge, the sanitizer rejected the
// netlist, or the parse produced nothing, the verdict is NOT_CHECKED or ERROR
// with a reason_code -- never PASS, never FAIL.
//
// The shape of every result is validated against contracts/event.schema.json
// through contracts/check-run.mjs. The rules live there, not here.

import { validateEvent } from '../../contracts/check-run.mjs';

export const VERDICTS = { PASS: 'PASS', FAIL: 'FAIL', NOT_CHECKED: 'NOT_CHECKED', ERROR: 'ERROR' };

/** Reason codes that mean "we could not check", not "the design is wrong". */
export const NOT_CHECKED_CODES = new Set([
  'no_model', 'blackbox', 'netlist_unsupported', 'sim_nonconverge',
  'out_of_scope', 'no_material_data',
]);
export const ERROR_CODES = new Set(['tool_missing', 'timeout', 'tool_error', 'mesh_failed', 'mesh_not_converged', 'unsupported_contact']);

function notRun(test_id, subject, reason_code, reason) {
  const verdict = NOT_CHECKED_CODES.has(reason_code) ? VERDICTS.NOT_CHECKED : VERDICTS.ERROR;
  return { test_id, subject, verdict, reason_code, reason: String(reason ?? '').slice(0, 2000) };
}

/**
 * Evaluate one check against a run result.
 *
 * @param {object} run       the object returned by run.mjs runNetlist()
 * @param {object} check     { test_id, measure, subject?, min?, max?, equals?, tolerance?, units? }
 * @returns {{test_id:string, subject:string, verdict:string, measured?:number,
 *            limit?:string|number, units?:string, reason_code?:string, reason?:string}}
 */
export function evaluateCheck(run, check) {
  const test_id = check.test_id;
  const subject = check.subject ?? 'baseline';

  if (!run || typeof run !== 'object') {
    return notRun(test_id, subject, 'tool_error', 'no run result');
  }
  // 1. The netlist never reached the simulator.
  if (run.blocked) {
    return notRun(test_id, subject, run.reason_code || 'netlist_unsupported', run.reason);
  }
  // 2. The simulator failed.
  if (!run.ok) {
    return notRun(test_id, subject, run.reason_code || 'tool_error', run.reason);
  }

  const name = String(check.measure ?? '').toLowerCase();
  const failedHere = (run.failed_measurements ?? []).some(f => String(f.name).toLowerCase() === name);
  if (failedHere) {
    // ngspice ran, but this particular measurement could not be taken.
    return notRun(test_id, subject, 'netlist_unsupported', `ngspice reported '${name}' failed`);
  }
  const entry = (run.measurements ?? {})[name];
  if (!entry || !Number.isFinite(entry.value)) {
    // 3. Parse produced nothing for this measurement.
    return notRun(test_id, subject, 'netlist_unsupported', `measurement '${name}' is not present in the ngspice output`);
  }

  const measured = entry.value;
  const { min, max, equals, tolerance = 0, units } = check;
  let pass;
  let limit;
  if (equals !== undefined) {
    limit = `${equals} +/- ${tolerance}`;
    pass = Math.abs(measured - equals) <= tolerance;
  } else if (min !== undefined || max !== undefined) {
    limit = `${min ?? '-inf'} .. ${max ?? '+inf'}`;
    pass = (min === undefined || measured >= min) && (max === undefined || measured <= max);
  } else {
    // A check with no limit cannot be decided; saying PASS here would be a lie.
    return notRun(test_id, subject, 'out_of_scope', `check ${test_id} defines no limit`);
  }

  const out = { test_id, subject, verdict: pass ? VERDICTS.PASS : VERDICTS.FAIL, measured, limit };
  if (units) out.units = units;
  return out;
}

/** Evaluate a list of checks against one run. */
export function evaluateChecks(run, checks) {
  return checks.map(c => evaluateCheck(run, c));
}

/**
 * Wrap a verdict in a contract `test.result` event and validate it with
 * contracts/check-run.mjs. Throws if the worker ever produced a shape the
 * contract rejects (for example NOT_CHECKED without a reason_code).
 */
export function toTestResultEvent(result, envelope) {
  const event = {
    v: 1,
    run_id: envelope.run_id,
    seq: envelope.seq,
    ts: envelope.ts ?? new Date().toISOString(),
    type: 'test.result',
    actor: envelope.actor ?? { kind: 'solver', id: 'ngspice-worker' },
    design_hash: envelope.design_hash,
    provenance: envelope.provenance ?? 'real',
    data: result,
  };
  const { ok, errors } = validateEvent(event);
  if (!ok) throw new Error(`ngspice worker produced an invalid test.result: ${errors.join('; ')}`);
  return event;
}
