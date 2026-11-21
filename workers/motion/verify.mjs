// Motion checks end to end: record, refine the timestep, decide, emit events.
//
// verifyMotion() records the model twice, at timestep h and h/2, evaluates
// every assertion on both trajectories, and only gives PASS or FAIL when the
// two agree:
//   * the verdict is the same at h and h/2, and
//   * the measured value changed by no more than max(abs_tol, rel_tol*|value|)
//     (rel_tol defaults to 1%; abs_tol is 1e-6 in SI units, or one record
//     interval for settling_time, whose resolution is the sample spacing).
// Otherwise the assertion is NOT_CHECKED with reason_code sim_nonconverge: an
// answer that still moves when the step shrinks is not an answer. The result
// reported is the one at h/2. A run that diverges (MuJoCo flags bad
// qpos/qvel/qacc, or the state goes non-finite) is NOT_CHECKED sim_nonconverge.
//
// Verdict mapping (contracts/README.md rule 1):
//   no interpreter can import mujoco      -> NOT_CHECKED tool_missing
//   model refused (escapes its directory), model does not compile,
//   bad request, unparseable assertion    -> NOT_CHECKED out_of_scope
//   diverged or not converged in timestep -> NOT_CHECKED sim_nonconverge
//   child killed by the timeout           -> ERROR timeout
//   no JSON from the child                -> ERROR tool_error

import { validateEvent } from '../../contracts/check-run.mjs';
import { recordTrajectory, storeArtifact, canonicalJSON } from './run.mjs';
import { parseMotionAssertions, measureAssertion, describeComparator } from './assertions.mjs';

export const DEFAULT_REL_TOL = 0.01;
const ERROR_CODES = new Set(['timeout', 'tool_error']);

function notRun(test_id, subject, reason_code, reason, assertion) {
  const r = {
    test_id, subject,
    verdict: ERROR_CODES.has(reason_code) ? 'ERROR' : 'NOT_CHECKED',
    reason_code,
    reason: String(reason ?? '').slice(0, 2000),
  };
  if (assertion) r.assertion = assertion;
  return r;
}

function converged(a, m1, m2, traj, relTol) {
  if (m1.pass !== m2.pass) return { ok: false, why: `verdict changes with the timestep (${m1.pass ? 'PASS' : 'FAIL'} at h, ${m2.pass ? 'PASS' : 'FAIL'} at h/2)` };
  if (typeof m1.measured === 'string' || typeof m2.measured === 'string') {
    return m1.unsettled && m2.unsettled ? { ok: true } : { ok: false, why: 'settling differs between h and h/2' };
  }
  const absTol = a.measurable.kind === 'settling_time' ? 1 / traj.record_hz + 1e-12 : 1e-6;
  const diff = Math.abs(m1.measured - m2.measured);
  const tol = Math.max(absTol, relTol * Math.abs(m2.measured));
  return diff <= tol ? { ok: true, diff, tol } : { ok: false, why: `measured ${m1.measured} at h and ${m2.measured} at h/2 differ by ${diff}, more than ${tol}` };
}

/**
 * @param {string} modelPath MJCF file; its directory is the only place it may read
 * @param {string|string[]} assertionText closed-grammar assertions (assertions.mjs)
 * @param {object} spec recordTrajectory spec ({duration, record_hz, timestep?, controls?, ...})
 * @param {{idPrefix?:string, subject?:string, relTol?:number, runDir?:string, python?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{results:object[], trajectory:object|null, coarse:object|null, artifact:object|null, runs:object[]}>}
 */
export async function verifyMotion(modelPath, assertionText, spec, opts = {}) {
  const idPrefix = opts.idPrefix ?? 'motion';
  const subject = opts.subject ?? 'baseline';
  const relTol = opts.relTol ?? DEFAULT_REL_TOL;
  const { assertions, errors } = parseMotionAssertions(assertionText);
  const id = a => `${idPrefix}:${a.line}`;
  const results = errors.map(e => notRun(`${idPrefix}:${e.line}`, subject, 'out_of_scope', e.message, e.raw));
  if (!assertions.length) return { results, trajectory: null, coarse: null, artifact: null, runs: [] };

  const coarse = await recordTrajectory(modelPath, spec, opts);
  if (!coarse.ok) {
    for (const a of assertions) results.push(notRun(id(a), subject, coarse.reason_code, coarse.reason, a.raw));
    return { results, trajectory: null, coarse, artifact: null, runs: [coarse] };
  }
  const h = coarse.trajectory.timestep;
  const fine = await recordTrajectory(modelPath, { ...spec, timestep: h / 2 }, opts);
  if (!fine.ok) {
    for (const a of assertions) results.push(notRun(id(a), subject, fine.reason_code, `at timestep h/2 = ${h / 2}: ${fine.reason}`, a.raw));
    return { results, trajectory: null, coarse, artifact: null, runs: [coarse, fine] };
  }

  for (const a of assertions) {
    const m1 = measureAssertion(coarse.trajectory, a);
    const m2 = measureAssertion(fine.trajectory, a);
    if (!m2.ok) { results.push(notRun(id(a), subject, m2.reason_code, m2.reason, a.raw)); continue; }
    if (!m1.ok) { results.push(notRun(id(a), subject, 'sim_nonconverge', `not measurable at h = ${h}: ${m1.reason}`, a.raw)); continue; }
    const c = converged(a, m1, m2, fine.trajectory, relTol);
    if (!c.ok) {
      results.push(notRun(id(a), subject, 'sim_nonconverge', `not converged in timestep (h = ${h} s vs h/2): ${c.why}`, a.raw));
      continue;
    }
    results.push({
      test_id: id(a), subject,
      verdict: m2.pass ? 'PASS' : 'FAIL',
      measured: m2.measured,
      limit: describeComparator(a.comparator),
      units: a.units,
      assertion: a.raw,
    });
  }

  let artifact = null;
  if (opts.runDir) artifact = await storeArtifact(opts.runDir, fine.bytes);
  return { results, trajectory: fine.trajectory, fine, coarse, artifact, runs: [coarse, fine] };
}

function envelopeOf(type, data, env) {
  const event = {
    v: 1,
    run_id: env.run_id,
    seq: env.seq,
    ts: env.ts ?? new Date().toISOString(),
    type,
    actor: env.actor ?? { kind: 'solver', id: 'motion-worker' },
    design_hash: env.design_hash,
    provenance: env.provenance ?? 'real',
    data,
  };
  const { ok, errors } = validateEvent(event);
  if (!ok) throw new Error(`motion worker produced an invalid ${type}: ${errors.join('; ')}`);
  return event;
}

/** A contract `test.result` event, validated. Throws on a shape the contract rejects. */
export const toTestResultEvent = (result, env) => envelopeOf('test.result', result, env);

/**
 * A contract `test.artifact` event for a stored artifact, validated.
 * @param {{uri:string, sha256:string, bytes:number}} stored from storeArtifact()
 */
export function toArtifactEvent(stored, { test_id, artifact_id, kind = 'mj_trajectory', mime = 'application/json' }, env) {
  return envelopeOf('test.artifact', {
    test_id,
    artifact_id: artifact_id ?? `${kind}-${stored.sha256.slice(7, 19)}`,
    kind, uri: stored.uri, sha256: stored.sha256, bytes: stored.bytes, mime,
  }, env);
}

/** Store a joint load (load-export.mjs) as an artifact; returns the storeArtifact() fields. */
export const storeJointLoad = (runDir, load) => storeArtifact(runDir, canonicalJSON(load));
