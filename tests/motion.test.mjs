// Tests for the MuJoCo motion worker (workers/motion/). These call the REAL
// MuJoCo through the Python interpreter the worker resolves (KINUX_PYTHON, else
// .venv/bin/python). Nothing is mocked. If no interpreter can import mujoco,
// every test that needs it is SKIPPED with the reason printed by node --test --
// it does not pass. The tool_missing tests run either way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvent, checkRun } from '../contracts/check-run.mjs';
import { probeMotion, recordTrajectory, storeArtifact, sha256 } from '../workers/motion/run.mjs';
import { measurePeriod } from '../workers/motion/analysis.mjs';
import { parseMotionAssertion, parseMotionAssertions } from '../workers/motion/assertions.mjs';
import { exportJointLoad, checkJointLoad } from '../workers/motion/load-export.mjs';
import { verifyMotion, toTestResultEvent, toArtifactEvent, storeJointLoad } from '../workers/motion/verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'workers', 'motion', 'fixtures');
const PENDULUM = join(FIX, 'physical-pendulum.xml');
const TORQUE = join(FIX, 'torque-joint.xml');
const ACTUATOR = join(FIX, 'joint-actuator.xml');

const PROBE = await probeMotion();
const SKIP = PROBE.available ? false : `MuJoCo not importable with ${PROBE.python}: ${PROBE.reason}`;

const DESIGN_HASH = 'sha256:' + 'b'.repeat(64);
let seq = 0;
const env = () => ({ run_id: 'motion-test', seq: seq++, design_hash: DESIGN_HASH, ts: '2026-11-21T00:00:00.000Z' });

const SERVO_SPEC = { duration: 1.5, record_hz: 200, controls: [{ actuator: 'servo', value: 1.0, t_on: 0.1 }] };

// ---------------------------------------------------------------- hand checks

// Physical pendulum (fixture comments give the numbers): m = 1 kg, d = 0.5 m,
// I_cm = 1/12 kg m^2, I_pivot = I_cm + m d^2 = 1/3 kg m^2, g = 9.81.
// Small-angle T0 = 2 pi sqrt(I_pivot / (m g d)). Released from 0.01 rad, the
// finite-amplitude period is T0 (1 + theta0^2/16 + ...), 6.25e-6 longer.
const T0 = 2 * Math.PI * Math.sqrt((1 / 3) / (1 * 9.81 * 0.5));
const T_AMP = T0 * (1 + 0.01 ** 2 / 16 + 11 * 0.01 ** 4 / 3072);
const PENDULUM_DTS = [0.008, 0.004, 0.002, 0.001, 0.0005];
const periods = new Map();
async function pendulumPeriod(dt) {
  if (!periods.has(dt)) {
    // record_hz 125 divides every dt above, so all runs sample the same instants.
    const r = await recordTrajectory(PENDULUM, { duration: 16, record_hz: 125, timestep: dt, qpos0: { pivot: 0.01 } });
    assert.equal(r.ok, true, r.reason);
    periods.set(dt, measurePeriod(r.trajectory, 'pivot'));
  }
  return periods.get(dt);
}

test('physical pendulum: small-angle period matches 2*pi*sqrt(I/(m*g*d))', { skip: SKIP }, async () => {
  const p = await pendulumPeriod(0.0005);
  assert.equal(p.cycles, 9, 'nine full periods are averaged');
  const relSmall = (p.period - T0) / T0;
  const relAmp = (p.period - T_AMP) / T_AMP;
  console.log(`pendulum dt=0.0005 s (Euler): MuJoCo T=${p.period} s, analytic T0=${T0} s (rel err ${relSmall.toExponential(3)}), amplitude-corrected ${T_AMP} s (rel err ${relAmp.toExponential(3)})`);
  // Tolerance: 2e-5 relative to the small-angle formula. Budget: finite
  // amplitude +6.25e-6, integrator (semi-implicit Euler, rel -(w h)^2/24)
  // -2.5e-7 at this step, Hermite crossing interpolation < 1e-9.
  assert.ok(Math.abs(relSmall) < 2e-5, `rel error vs T0 ${relSmall}`);
  // Against the amplitude-corrected period, only the integrator error is left.
  assert.ok(Math.abs(relAmp) < 1e-6, `rel error vs amplitude-corrected T ${relAmp}`);
});

test('physical pendulum: period converges at second order as the timestep halves', { skip: SKIP }, async () => {
  const T = [];
  for (const dt of PENDULUM_DTS) T.push((await pendulumPeriod(dt)).period);
  const diffs = T.slice(1).map((x, i) => Math.abs(x - T[i]));
  const ratios = diffs.slice(1).map((d, i) => diffs[i] / d);
  PENDULUM_DTS.forEach((dt, i) => console.log(`pendulum dt=${dt}: T=${T[i]} s, rel err vs amplitude-corrected ${((T[i] - T_AMP) / T_AMP).toExponential(3)}`));
  console.log(`successive |dT|: ${diffs.map(d => d.toExponential(3)).join(', ')}; ratios ${ratios.map(r => r.toFixed(3)).join(', ')}`);
  for (let i = 1; i < diffs.length; i++) assert.ok(diffs[i] < diffs[i - 1], 'differences shrink monotonically');
  // Semi-implicit Euler on a harmonic oscillator: period error ~ h^2, so each
  // halving should cut the change by ~4.
  for (const r of ratios) assert.ok(r > 3.5 && r < 4.5, `convergence ratio ${r} is not ~4 (second order)`);
  assert.ok(diffs[diffs.length - 1] < 1e-6, 'the last halving moves the period by under 1 us');
  // Richardson extrapolation of the last two steps lands on the analytic value.
  const rich = T[T.length - 1] + (T[T.length - 1] - T[T.length - 2]) / 3;
  console.log(`Richardson-extrapolated T=${rich} s, rel err vs amplitude-corrected ${((rich - T_AMP) / T_AMP).toExponential(3)}`);
  assert.ok(Math.abs(rich - T_AMP) / T_AMP < 1e-8);
});

test('torque-driven joint: alpha = tau / I, and the angle converges at first order', { skip: SKIP }, async () => {
  // Fixture: I = I_cm + m d^2 = 0.01 + 2 * 0.2^2 = 0.09 kg m^2; gear 5, ctrl 0.9
  // -> tau = 4.5 N m -> alpha = 50 rad/s^2. Gravity off.
  const I = 0.01 + 2 * 0.2 ** 2, tau = 5 * 0.9, alpha = tau / I, Tend = 1.0;
  const errs = [];
  for (const dt of [0.004, 0.002, 0.001]) {
    const r = await recordTrajectory(TORQUE, { duration: Tend, record_hz: 250, timestep: dt, controls: [{ actuator: 'drive', value: 0.9 }] });
    assert.equal(r.ok, true, r.reason);
    const tr = r.trajectory, n = tr.t.length - 1;
    const aMeas = (tr.qvel[n][0] - tr.qvel[0][0]) / (tr.t[n] - tr.t[0]);
    const tauMeas = tr.qfrc_actuator[n][0];
    const theta = tr.qpos[n][0], thetaExact = 0.5 * alpha * Tend ** 2;
    errs.push(theta - thetaExact);
    console.log(`torque joint dt=${dt}: alpha MuJoCo=${aMeas} analytic=${alpha} (rel ${((aMeas - alpha) / alpha).toExponential(3)}); tau=${tauMeas}; theta(1s)=${theta} vs 0.5*alpha*t^2=${thetaExact} (err ${(theta - thetaExact).toExponential(3)})`);
    // The velocity update is exact for constant acceleration: only rounding is left.
    assert.ok(Math.abs(aMeas - alpha) / alpha < 1e-12, `alpha ${aMeas}`);
    assert.ok(Math.abs(tauMeas - tau) < 1e-12, `joint torque ${tauMeas}`);
    // Semi-implicit Euler gives theta_N = alpha h^2 N(N+1)/2: an error of exactly alpha*h*T/2.
    assert.ok(Math.abs((theta - thetaExact) - alpha * dt * Tend / 2) < 1e-9, 'angle error is the known Euler term');
  }
  assert.ok(Math.abs(errs[0] / errs[1] - 2) < 1e-6 && Math.abs(errs[1] / errs[2] - 2) < 1e-6, 'first-order convergence of the angle');
});

// ---------------------------------------------------------------- reproducibility

test('a recorded run is byte-reproducible: same request, same artifact bytes and hash', { skip: SKIP }, async () => {
  const a = await recordTrajectory(ACTUATOR, SERVO_SPEC);
  const b = await recordTrajectory(ACTUATOR, SERVO_SPEC);
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.bytes, b.bytes, 'canonical JSON bytes identical');
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, sha256(a.bytes));
  assert.ok(!/duration_ms|wall|date/i.test(Object.keys(a.trajectory).join(' ')), 'no wall-clock fields in the artifact');
  console.log(`reproducible trajectory ${a.sha256} (${a.bytes.length} bytes)`);
});

// ---------------------------------------------------------------- checks

test('checks on a real joint-actuator trajectory: one passes, one fails, refusals are NOT_CHECKED', { skip: SKIP }, async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'kinux-motion-run-'));
  try {
    const text = [
      'peak_torque(shoulder) < 80 N*m',
      'peak_torque(shoulder) < 50 N*m',
      'angle(shoulder) between -0.1 and 1.2 rad',
      'settling_time(shoulder, 0.98, 0.03) < 0.5 s',
      'angle(elbow) < 1',
      'torque(shoulder) < 3',
      'exec(rm -rf /) < 1',
    ].join('\n');
    const r = await verifyMotion(ACTUATOR, text, SERVO_SPEC, { runDir, idPrefix: 'act' });
    const by = Object.fromEntries(r.results.map(x => [x.assertion, x]));
    for (const x of r.results) console.log(`${x.verdict.padEnd(11)} ${x.assertion}  measured=${x.measured ?? '-'} limit=${x.limit ?? '-'} ${x.reason_code ?? ''}`);
    assert.equal(by['peak_torque(shoulder) < 80 N*m'].verdict, 'PASS');
    assert.equal(by['peak_torque(shoulder) < 50 N*m'].verdict, 'FAIL');
    assert.ok(by['peak_torque(shoulder) < 50 N*m'].measured > 50 && by['peak_torque(shoulder) < 50 N*m'].measured < 80);
    assert.equal(by['angle(shoulder) between -0.1 and 1.2 rad'].verdict, 'PASS');
    assert.equal(by['settling_time(shoulder, 0.98, 0.03) < 0.5 s'].verdict, 'PASS');
    for (const k of ['angle(elbow) < 1', 'torque(shoulder) < 3', 'exec(rm -rf /) < 1']) {
      assert.equal(by[k].verdict, 'NOT_CHECKED', k);
      assert.equal(by[k].reason_code, 'out_of_scope', k);
    }
    // The trajectory artifact is on disk under its own hash.
    const stored = await readFile(join(runDir, r.artifact.uri), 'utf8');
    assert.equal(sha256(stored), r.artifact.sha256);

    // Every event validates, and a whole run built from them is consistent.
    seq = 0;
    const events = [{ v: 1, run_id: 'motion-test', seq: seq++, ts: '2026-11-21T00:00:00.000Z', type: 'run.started', actor: { kind: 'system', id: 'test' }, design_hash: DESIGN_HASH, provenance: 'real', data: { project: 'joint-actuator', domain: 'robotics', tool_versions: r.fine.tool_versions, source: 'live' } }];
    for (const x of r.results) events.push({ ...env(), type: 'test.queued', actor: { kind: 'system', id: 'test' }, provenance: 'real', v: 1, data: { test_id: x.test_id, title: x.assertion, layer: 'motion', solver: 'mujoco' } });
    events.push(toArtifactEvent(r.artifact, { test_id: r.results[0].test_id }, env()));
    for (const x of r.results) events.push(toTestResultEvent(x, env()));
    events.push({ v: 1, run_id: 'motion-test', seq: seq++, ts: '2026-11-21T00:00:01.000Z', type: 'run.finished', actor: { kind: 'system', id: 'test' }, design_hash: DESIGN_HASH, provenance: 'real', data: { status: 'completed' } });
    for (const e of events) assert.equal(validateEvent(e).ok, true, validateEvent(e).errors.join('; '));
    assert.deepEqual(checkRun(events), []);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('a result that changes with the timestep is NOT_CHECKED sim_nonconverge, never PASS', { skip: SKIP }, async () => {
  // Explicit Euler at h = 50 ms is far too coarse for this servo (kp 60, kv 2.5
  // on I = 0.044 kg m^2): the peak torque saturates at h and not at h/2.
  const r = await verifyMotion(ACTUATOR, 'peak_torque(shoulder) < 80 N*m', { ...SERVO_SPEC, timestep: 0.05, record_hz: 20, integrator: 'Euler' });
  assert.equal(r.results[0].verdict, 'NOT_CHECKED');
  assert.equal(r.results[0].reason_code, 'sim_nonconverge');
  assert.match(r.results[0].reason, /not converged in timestep/);
  assert.equal(validateEvent(toTestResultEvent(r.results[0], env())).ok, true);
});

test('a run killed by the timeout is ERROR timeout', { skip: SKIP }, async () => {
  const r = await verifyMotion(TORQUE, 'peak_torque(axle) < 10', { duration: 4000, record_hz: 1, controls: [{ actuator: 'drive', value: 0.1 }] }, { timeoutMs: 400 });
  assert.equal(r.results[0].verdict, 'ERROR');
  assert.equal(r.results[0].reason_code, 'timeout');
  assert.equal(validateEvent(toTestResultEvent(r.results[0], env())).ok, true);
});

test('the assertion grammar is closed', () => {
  assert.deepEqual(parseMotionAssertion('angle(j) between -10 deg and 90 deg').comparator.upper, Math.PI / 2);
  assert.equal(parseMotionAssertion('settling_time(j, 1, 0.01) < 300 ms').comparator.bound, 0.3);
  const { assertions, errors } = parseMotionAssertions([
    '# comment', '', 'peak_torque(j) < 5 Nm',
    'peak_torque(j) < 5 rad', 'settling_time(j, 1, 0.01) > 1', 'angle(j) <= 1', 'angle(j); import os < 1', 'angle(j) < 1 and 2', 'peak_torque(__import__("os")) < 1',
  ]);
  assert.equal(assertions.length, 1);
  assert.equal(errors.length, 6);
});

// ---------------------------------------------------------------- load export

test('joint-actuator load export: torque series and peak in kinux.joint_load/1, checked by hand', { skip: SKIP }, async () => {
  const r = await recordTrajectory(ACTUATOR, SERVO_SPEC);
  assert.equal(r.ok, true, r.reason);
  const load = exportJointLoad(r.trajectory, 'shoulder', { trajectory_sha256: r.sha256, model_sha256: r.model_sha256 });
  assert.deepEqual(checkJointLoad(load), []);
  assert.equal(load.body, 'arm');
  assert.equal(load.parent_body, 'housing');
  assert.equal(load.t.length, load.torque.length);
  const seriesMax = Math.max(...load.torque.map(Math.abs));
  assert.ok(load.peak.abs >= seriesMax, 'step-level peak covers the sampled series');
  // Static hand check: once settled, the servo holds the arm against gravity,
  // so the joint torque is m g d cos(theta) (m = 1 kg, d = 0.2 m).
  const k = load.t.length - 1;
  const theta = r.trajectory.qpos[k][0];
  const hold = 1 * 9.81 * 0.2 * Math.cos(theta);
  console.log(`holding torque at t=${load.t[k]} s: MuJoCo ${load.torque[k]} N m, m*g*d*cos(theta) = ${hold} N m (rel ${((load.torque[k] - hold) / hold).toExponential(3)}); peak ${load.peak.abs} N m at t=${load.peak.t} s`);
  assert.ok(Math.abs(load.torque[k] - hold) / hold < 1e-6);
  // It is stored and announced like any artifact.
  const runDir = await mkdtemp(join(tmpdir(), 'kinux-motion-load-'));
  try {
    const stored = await storeJointLoad(runDir, load);
    const ev = toArtifactEvent(stored, { test_id: 'act:load', kind: 'other', artifact_id: 'joint-load-shoulder' }, env());
    assert.equal(validateEvent(ev).ok, true);
    assert.deepEqual(checkJointLoad(JSON.parse(readFileSync(join(runDir, stored.uri), 'utf8'))), []);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- containment

const SECRET_MJCF = '<mujoco><worldbody><body name="SECRET_BODY"><joint name="s" type="hinge"/><inertial pos="0 0 0" mass="1" diaginertia="1 1 1"/></body></worldbody></mujoco>';
const wrap = inner => `<mujoco><worldbody><body name="b"><joint name="j" type="hinge"/><inertial pos="0 0 -0.1" mass="1" diaginertia="0.01 0.01 0.01"/></body></worldbody>${inner}</mujoco>`;

test('<include> and asset paths cannot leave the model directory', { skip: SKIP }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'kinux-motion-jail-'));
  try {
    const jail = join(base, 'design');
    await mkdir(join(jail, 'parts'), { recursive: true });
    await writeFile(join(base, 'secret.xml'), SECRET_MJCF);       // outside the jail, valid MJCF
    await writeFile(join(jail, 'parts', 'arm.xml'), SECRET_MJCF.replace('SECRET_BODY', 'INSIDE_BODY'));
    symlinkSync(join(base, 'secret.xml'), join(jail, 'link.xml'));
    const cases = {
      'dotdot.xml': ['<mujoco><include file="../secret.xml"/></mujoco>', /'\.\.' segment/],
      'absolute.xml': [`<mujoco><include file="${join(base, 'secret.xml')}"/></mujoco>`, /absolute/],
      'symlink.xml': ['<mujoco><include file="link.xml"/></mujoco>', /resolves outside/],
      'nested.xml': ['<mujoco><include file="parts/evil.xml"/></mujoco>', /'\.\.' segment/],
      'mesh.xml': [wrap('<asset><mesh name="m" file="../secret.stl"/></asset>'), /'\.\.' segment/],
      'meshdir.xml': [wrap('<compiler meshdir="/etc"/><asset><mesh name="m" file="passwd"/></asset>'), /absolute/],
      'texture.xml': [wrap('<asset><texture name="t" type="cube" fileright="../../etc/hostname"/></asset>'), /'\.\.' segment/],
      'entity.xml': ['<!DOCTYPE m [<!ENTITY x SYSTEM "file:///etc/passwd">]><mujoco model="&x;"/>', /DOCTYPE/],
      'plugin.xml': [wrap('<extension><plugin plugin="mujoco.elasticity.cable"/></extension>'), /plugins are not allowed/],
    };
    await writeFile(join(jail, 'parts', 'evil.xml'), '<mujoco><include file="../secret.xml"/></mujoco>');
    for (const [name, [xml]] of Object.entries(cases)) await writeFile(join(jail, name), xml);
    for (const [name, [, why]] of Object.entries(cases)) {
      const r = await recordTrajectory(join(jail, name), { duration: 0.01, record_hz: 100 });
      assert.equal(r.ok, false, `${name} must be refused`);
      assert.equal(r.sim_code, 'model_refused', `${name}: ${r.reason}`);
      assert.match(r.reason, why, name);
      assert.ok(!/SECRET_BODY|root:/.test(r.reason), 'nothing from outside leaks into the reason');
    }
    {
      // And the refusal surfaces as a contract result.
      const v = await verifyMotion(join(jail, 'dotdot.xml'), 'angle(j) < 1', { duration: 0.01, record_hz: 100 });
      assert.equal(v.results[0].verdict, 'NOT_CHECKED');
      assert.equal(v.results[0].reason_code, 'out_of_scope');
      assert.equal(validateEvent(toTestResultEvent(v.results[0], env())).ok, true);
    }
    // Positive control: an include inside the directory loads, and is hashed.
    await writeFile(join(jail, 'ok.xml'), '<mujoco><include file="parts/arm.xml"/></mujoco>');
    const ok = await recordTrajectory(join(jail, 'ok.xml'), { duration: 0.01, record_hz: 100 });
    assert.equal(ok.ok, true, ok.reason);
    assert.deepEqual(ok.trajectory.model_files.map(f => f.path), ['ok.xml', 'parts/arm.xml']);
    assert.equal(ok.trajectory.joints[0].body, 'INSIDE_BODY');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- tool missing (always runs)

test('no interpreter with mujoco: NOT_CHECKED tool_missing, and the event validates', async () => {
  const candidates = ['/no/such/python'];
  if (existsSync('/usr/bin/python3')) {
    const p = await probeMotion({ python: '/usr/bin/python3' });
    if (!p.available) candidates.push('/usr/bin/python3'); // a real python without mujoco
  }
  for (const python of candidates) {
    const probe = await probeMotion({ python, force: true });
    assert.equal(probe.available, false, python);
    const r = await verifyMotion(PENDULUM, 'angle(pivot) < 1', { duration: 0.1, record_hz: 100 }, { python });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].verdict, 'NOT_CHECKED', python);
    assert.equal(r.results[0].reason_code, 'tool_missing', python);
    console.log(`${python}: ${r.results[0].verdict} ${r.results[0].reason_code}: ${r.results[0].reason.split('\n')[0]}`);
    assert.equal(validateEvent(toTestResultEvent(r.results[0], env())).ok, true);
  }
});

test('MuJoCo availability is reported, so a skip is visible rather than silent', () => {
  console.log(`motion worker interpreter ${PROBE.python}: ${PROBE.available ? `mujoco ${PROBE.mujoco_version}, python ${PROBE.python_version}` : `UNAVAILABLE (${PROBE.reason}); MuJoCo tests are SKIPPED`}`);
  assert.equal(typeof PROBE.available, 'boolean');
});
