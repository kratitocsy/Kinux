// Mesh-convergence studies and contract verdicts.
//
// THE CONVERGENCE RULE (non-negotiable, see README.md):
//   * at least MIN_LEVELS (3) meshes, each finer than the last;
//   * the quantity of interest changes by no more than `convTol` (relative)
//     between the two finest meshes, AND that last change is no larger than
//     the change before it (the sequence is settling, not wandering) unless
//     it is already below convTol/10;
//   * otherwise the verdict is NOT_CHECKED / mesh_not_converged -- never PASS,
//     and never FAIL either: an unconverged number says nothing about the design.
// The value reported is the one from the finest mesh.

import { validateEvent } from '../../contracts/check-run.mjs';
import { verdictForReason } from '../reason-codes.mjs';

export const MIN_LEVELS = 3;

// The verdict for each reason code is decided once, in workers/reason-codes.mjs (K19).
export { NOT_CHECKED_CODES, ERROR_CODES } from '../reason-codes.mjs';

export function notRun(test_id, subject, reason_code, reason) {
  const verdict = verdictForReason(reason_code, 'ERROR');
  return { test_id, subject, verdict, reason_code, reason: String(reason ?? '').slice(0, 2000) };
}

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), Number.MIN_VALUE);

/**
 * Decide convergence of a sequence of values from successively finer meshes.
 * @param {number[]} values  coarsest first
 */
export function convergence(values, convTol, convAbs = 0) {
  const n = values.length;
  if (n < MIN_LEVELS) {
    return { converged: false, why: `only ${n} mesh level(s); at least ${MIN_LEVELS} are needed to show convergence` };
  }
  if (!values.every(Number.isFinite)) return { converged: false, why: 'a level produced a non-finite value' };
  const last = rel(values[n - 1], values[n - 2]);
  const prev = rel(values[n - 2], values[n - 3]);
  // For a quantity whose exact value is ~0 (a deviation), a relative change
  // is meaningless; an absolute change below convAbs counts as settled.
  const lastAbs = Math.abs(values[n - 1] - values[n - 2]);
  if (convAbs > 0 && lastAbs <= convAbs) return { converged: true, last_change_abs: lastAbs, why: `changed ${lastAbs.toPrecision(3)} (absolute) between the two finest meshes (<= ${convAbs})` };
  if (last > convTol) return { converged: false, last_change: last, prev_change: prev, why: `changed ${(last * 100).toPrecision(3)}% between the two finest meshes (> ${(convTol * 100).toPrecision(3)}%)` };
  if (last > prev && last > convTol / 10) return { converged: false, last_change: last, prev_change: prev, why: `change grew from ${(prev * 100).toPrecision(3)}% to ${(last * 100).toPrecision(3)}%: not settling` };
  return { converged: true, last_change: last, prev_change: prev, why: `changed ${(last * 100).toPrecision(3)}% between the two finest meshes (<= ${(convTol * 100).toPrecision(3)}%)` };
}

/**
 * Turn a study into contract test.result data for one quantity.
 * @param {object} study    returned by a slice: { ok, reason_code?, reason?, levels:[{size,nodes,elements,values:{...}}] }
 * @param {object} q        { test_id, subject?, key, units, convTol, reference?, relTol?, max?, min?, label }
 * @returns {{ result: object, details: object }}
 */
export function judge(study, q) {
  const subject = q.subject ?? 'baseline';
  const sizes = (study.levels ?? []).map(l => l.size);
  const details = { quantity: q.key, units: q.units, mesh_sizes: sizes, levels: study.levels ?? [], analytic: q.reference ?? null, analytic_formula: q.formula ?? null };
  if (!study.ok) return { result: notRun(q.test_id, subject, study.reason_code, study.reason), details };
  const values = study.levels.map(l => l.values[q.key]);
  const conv = convergence(values, q.convTol, q.convAbs ?? 0);
  Object.assign(details, { values, convergence: conv, conv_tol: q.convTol });
  const sizeText = `mesh sizes ${sizes.join(' / ')} (${study.levels.map(l => l.elements).join(' / ')} elements)`;
  if (!conv.converged) {
    return { result: notRun(q.test_id, subject, 'mesh_not_converged', `${q.label}: not converged: ${conv.why}; values ${values.map(v => v.toPrecision(6)).join(', ')} ${q.units}; ${sizeText}`), details };
  }
  const measured = values[values.length - 1];
  details.converged_value = measured;
  let pass, limit;
  if (q.reference !== undefined) {
    const err = rel(measured, q.reference);
    details.rel_error = err;
    limit = `${q.reference.toPrecision(6)} +/- ${(q.relTol * 100).toPrecision(3)}%`;
    pass = err <= q.relTol;
  } else if (q.max !== undefined || q.min !== undefined) {
    limit = `${q.min ?? '-inf'} .. ${q.max ?? '+inf'}`;
    pass = (q.min === undefined || measured >= q.min) && (q.max === undefined || measured <= q.max);
  } else {
    return { result: notRun(q.test_id, subject, 'out_of_scope', `${q.label}: no limit defined`), details };
  }
  const errText = details.rel_error !== undefined ? `; analytic ${q.reference.toPrecision(6)} (${q.formula}), error ${(details.rel_error * 100).toPrecision(3)}%` : '';
  return {
    result: {
      test_id: q.test_id, subject, verdict: pass ? 'PASS' : 'FAIL', measured, limit, units: q.units,
      reason: `${q.label}: CalculiX ${measured.toPrecision(6)} ${q.units} on the finest mesh${errText}; ${conv.why}; ${sizeText}`,
    },
    details,
  };
}

/** Wrap a result in a contract test.result event; throws if the contract rejects it. */
export function toTestResultEvent(result, envelope) {
  const event = {
    v: 1,
    run_id: envelope.run_id,
    seq: envelope.seq,
    ts: envelope.ts ?? new Date().toISOString(),
    type: 'test.result',
    actor: envelope.actor ?? { kind: 'solver', id: 'fea-worker' },
    design_hash: envelope.design_hash,
    // `real`: produced by this worker from a real CalculiX/Gmsh attempt. A
    // NOT_CHECKED result carries no measured number at all.
    provenance: envelope.provenance ?? 'real',
    data: result,
  };
  const { ok, errors } = validateEvent(event);
  if (!ok) throw new Error(`fea worker produced an invalid test.result: ${errors.join('; ')}`);
  return event;
}
