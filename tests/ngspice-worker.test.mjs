// Tests for the ngspice worker. These call the REAL ngspice binary -- nothing
// here is mocked. If ngspice is not installed the suite fails loudly rather
// than skipping, because a silently skipped safety test is worse than none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitize, describeViolations } from '../workers/ngspice/sanitize.mjs';
import { runNetlist, ngspiceVersion, parseMeasurements, parsePrintTables } from '../workers/ngspice/run.mjs';
import { evaluateCheck, toTestResultEvent } from '../workers/ngspice/verdict.mjs';
import { validateEvent } from '../contracts/check-run.mjs';

const DESIGN_HASH = 'sha256:' + 'a'.repeat(64);
const envelope = { run_id: 'test-run', seq: 0, design_hash: DESIGN_HASH };

// R = 1k, C = 1u  ->  tau = 1 ms. Step at t=0, measured at tau, 3tau, 5tau.
const RC_NETLIST = `RC low-pass step response
V1 in 0 PWL(0 0 1n 1)
R1 in out 1k
C1 out 0 1u
.tran 1u 6m
.control
run
meas tran v_tau FIND v(out) AT=1m
meas tran v_3tau FIND v(out) AT=3m
meas tran v_5tau FIND v(out) AT=5m
print v(out)
.endc
.end
`;

const UNDEFINED_MODEL_NETLIST = `undefined model
V1 in 0 DC 1
R1 in b 1k
Q1 c b 0 NO_SUCH_MODEL_XYZ
.tran 1u 1m
.control
run
meas tran v_c FIND v(c) AT=0.5m
.endc
.end
`;

test('ngspice is really installed and reports its version for the receipt', async () => {
  const v = await ngspiceVersion({ force: true });
  assert.equal(v.available, true, 'ngspice binary must be runnable');
  assert.match(v.id ?? '', /^ngspice-\d/, `parsed version id: ${v.id}`);
  assert.match(v.banner, /ngspice/i);
});

test('RC step response matches 1-exp(-t/RC) at tau, 3tau and 5tau', async () => {
  const run = await runNetlist(RC_NETLIST);
  assert.equal(run.ok, true, run.reason ?? '');
  assert.deepEqual(run.tool_versions.ngspice?.startsWith('ngspice-'), true);

  // Stated tolerance: 1e-4 V absolute. ngspice's own trapezoidal integration
  // error on this circuit at 1 us steps is ~1e-6 V, so this is ~100x headroom
  // and still tight enough that a wrong RC would be caught.
  const TOL = 1e-4;
  const tau = 1e-3;
  const points = [
    ['v_tau', 1 * tau],
    ['v_3tau', 3 * tau],
    ['v_5tau', 5 * tau],
  ];
  for (const [name, t] of points) {
    const analytic = 1 - Math.exp(-t / tau);
    const m = run.measurements[name];
    assert.ok(m, `measurement ${name} must be parsed; got ${JSON.stringify(Object.keys(run.measurements))}`);
    assert.ok(Math.abs(m.value - analytic) < TOL,
      `${name}: ngspice ${m.value} vs analytic ${analytic} (|diff| ${Math.abs(m.value - analytic)} >= ${TOL})`);
  }

  // `print` output is parsed into plain float arrays.
  assert.equal(run.tables.length, 1);
  const table = run.tables[0];
  assert.deepEqual(table.columns, ['time', 'v(out)']);
  assert.ok(table.rows > 1000, `expected a dense transient table, got ${table.rows} rows`);
  assert.ok(table.data['v(out)'].every(x => typeof x === 'number' && Number.isFinite(x)));
  // The printed waveform agrees with the analytic curve too.
  const times = table.data.time;
  const vout = table.data['v(out)'];
  let worst = 0;
  for (let i = 0; i < times.length; i++) {
    worst = Math.max(worst, Math.abs(vout[i] - (1 - Math.exp(-times[i] / tau))));
  }
  assert.ok(worst < 1e-3, `worst-case waveform error ${worst}`);
});

test('the same netlist run 5 times gives an identical hash', async () => {
  const hashes = [];
  for (let i = 0; i < 5; i++) {
    const run = await runNetlist(RC_NETLIST);
    assert.equal(run.ok, true, run.reason ?? '');
    hashes.push(`${run.result_hash} ${run.output_hash}`);
  }
  assert.equal(new Set(hashes).size, 1, `5 runs produced ${new Set(hashes).size} distinct hashes: ${[...new Set(hashes)].join(' | ')}`);
  assert.match(hashes[0], /^sha256:[0-9a-f]{64} sha256:[0-9a-f]{64}$/);
});

// --------------------------------------------------------------------------
// Injection corpus. Every one of these must be REJECTED by the sanitizer.
// --------------------------------------------------------------------------
const PWNED = 'pwned.txt';
const INJECTION_CORPUS = [
  ['shell escape writes a file', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
shell echo OWNED > ${PWNED}
run
.endc
.end
`],
  ['uppercase SHELL (case-insensitivity)', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
RUN
SHELL touch ${PWNED}
.endc
.end
`],
  ['leading whitespace hides the command', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
\t   shell /bin/sh -c "touch ${PWNED}"
.endc
.end
`],
  ['command hidden after a semicolon', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run ; shell touch ${PWNED}
.endc
.end
`],
  ['second .control block carries the payload', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
.endc
.control
system touch ${PWNED}
.endc
.end
`],
  ['line continuation splits the command', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
sh
+ell touch ${PWNED}
.endc
.end
`],
  ['backtick command substitution', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
echo \`touch ${PWNED}\`
.endc
.end
`],
  ['$( ) command substitution', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
echo $(touch ${PWNED})
.endc
.end
`],
  ['source reads another script', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
source /etc/passwd
run
.endc
.end
`],
  ['load reads a binary', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
load /etc/shadow
run
.endc
.end
`],
  ['cd escapes the run directory', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
cd /
run
.endc
.end
`],
  ['rusage leaks host information', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
rusage everything
.endc
.end
`],
  ['exec', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
exec /bin/sh
.endc
.end
`],
  ['write escapes to an absolute path', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
write /tmp/${PWNED} v(in)
.endc
.end
`],
  ['write traverses with ..', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
wrdata ../../${PWNED} v(in)
.endc
.end
`],
  ['.include reads an arbitrary file', `evil
V1 in 0 DC 1
R1 in 0 1k
.include /etc/passwd
.op
.end
`],
  ['output redirection in a control command', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
print v(in) > ${PWNED}
.endc
.end
`],
  ['unrecognised command is denied by default', `evil
V1 in 0 DC 1
R1 in 0 1k
.op
.control
run
totally_unknown_command_xyz
.endc
.end
`],
];

test(`injection corpus: all ${INJECTION_CORPUS.length} hostile netlists are rejected`, () => {
  assert.ok(INJECTION_CORPUS.length >= 10, 'the corpus must hold at least 10 cases');
  for (const [name, netlist] of INJECTION_CORPUS) {
    const r = sanitize(netlist);
    assert.equal(r.ok, false, `sanitizer ACCEPTED a hostile netlist: ${name}`);
    assert.ok(r.violations.length > 0, `${name}: rejection must carry a structured reason`);
    for (const vio of r.violations) {
      assert.equal(typeof vio.code, 'string');
      assert.equal(typeof vio.line, 'number');
      assert.equal(typeof vio.detail, 'string');
    }
    assert.equal(typeof describeViolations(r.violations), 'string');
  }
});

test('the shell-escape netlist creates no file, and the sanitizer is what stops it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-inject-'));
  const cwdBefore = new Set(readdirSync(process.cwd()));
  try {
    const [, hostile] = INJECTION_CORPUS[0];

    // 1. Positive control: run the SAME netlist through ngspice with the
    //    sanitizer bypassed, to prove the payload is live on this machine.
    await writeFile(join(dir, 'evil.cir'), hostile, 'utf8');
    const { spawn } = await import('node:child_process');
    await new Promise(resolve => {
      const c = spawn('ngspice', ['-b', 'evil.cir'], { cwd: dir, shell: false, stdio: 'ignore' });
      c.on('close', resolve);
      c.on('error', resolve);
    });
    const after = await readdir(dir);
    assert.ok(after.includes(PWNED),
      `positive control failed: ngspice did not execute the payload, so this test proves nothing (dir: ${after.join(', ')})`);
    await rm(join(dir, PWNED), { force: true });

    // 2. The real path: runNetlist must block before ngspice is started.
    const run = await runNetlist(hostile);
    assert.equal(run.blocked, true, 'runNetlist must block the hostile netlist');
    assert.equal(run.ok, false);
    assert.equal(run.stage, 'sanitize');
    assert.equal(run.reason_code, 'netlist_unsupported');
    assert.ok(run.violations.some(v => v.code === 'denied_command'));

    // 3. Nothing was written anywhere we can see.
    const afterBlocked = await readdir(dir);
    assert.equal(afterBlocked.includes(PWNED), false, `${PWNED} appeared in ${dir} after a blocked run`);
    assert.equal(existsSync(join(process.cwd(), PWNED)), false, `${PWNED} appeared in the working directory`);
    assert.equal(existsSync(join(tmpdir(), PWNED)), false, `${PWNED} appeared in ${tmpdir()}`);
    const cwdAfter = readdirSync(process.cwd()).filter(f => !cwdBefore.has(f));
    assert.deepEqual(cwdAfter, [], `a blocked run created files in the working directory: ${cwdAfter.join(', ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('benign netlists survive the sanitizer unchanged', () => {
  for (const n of [RC_NETLIST, UNDEFINED_MODEL_NETLIST]) {
    const r = sanitize(n);
    assert.equal(r.ok, true, r.ok ? '' : describeViolations(r.violations));
    assert.equal(r.netlist, n, 'the sanitizer rejects, it never silently rewrites');
  }
});

// --------------------------------------------------------------------------
// Verdicts
// --------------------------------------------------------------------------
test('an undefined model gives NOT_CHECKED with a reason_code, never PASS', async () => {
  const run = await runNetlist(UNDEFINED_MODEL_NETLIST);
  assert.equal(run.ok, false, 'ngspice must refuse a circuit with an unknown model');
  assert.equal(run.reason_code, 'no_model', `classified as ${run.reason_code}: ${run.reason}`);

  const result = evaluateCheck(run, { test_id: 'rc-tau', measure: 'v_c', min: 0, max: 5, units: 'V' });
  assert.notEqual(result.verdict, 'PASS');
  assert.notEqual(result.verdict, 'FAIL');
  assert.ok(['NOT_CHECKED', 'ERROR'].includes(result.verdict), result.verdict);
  assert.equal(result.reason_code, 'no_model');
  assert.ok(result.reason.length > 0);

  // And the contract accepts the shape (NOT_CHECKED requires a reason_code).
  const ev = toTestResultEvent(result, envelope);
  assert.equal(validateEvent(ev).ok, true, validateEvent(ev).errors.join('; '));
});

test('a measurement outside its limits gives FAIL', async () => {
  const run = await runNetlist(RC_NETLIST);
  assert.equal(run.ok, true, run.reason ?? '');
  // v_tau is really 0.632; demand >= 0.9 so the check must fail.
  const result = evaluateCheck(run, { test_id: 'rc-tau-too-high', measure: 'v_tau', min: 0.9, units: 'V' });
  assert.equal(result.verdict, 'FAIL', JSON.stringify(result));
  assert.ok(Math.abs(result.measured - 0.6321206) < 1e-3, `measured ${result.measured}`);
  assert.equal(result.reason_code, undefined, 'a real FAIL carries no reason_code');
  assert.equal(validateEvent(toTestResultEvent(result, envelope)).ok, true);
});

test('a measurement inside its limits gives PASS', async () => {
  const run = await runNetlist(RC_NETLIST);
  const result = evaluateCheck(run, { test_id: 'rc-tau-ok', measure: 'v_tau', equals: 1 - Math.exp(-1), tolerance: 1e-4, units: 'V' });
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(validateEvent(toTestResultEvent(result, envelope)).ok, true);
});

test('a blocked netlist can never produce PASS or FAIL', () => {
  const blocked = {
    blocked: true, ok: false, stage: 'sanitize',
    reason_code: 'netlist_unsupported', reason: 'rejected', violations: [],
    measurements: {}, failed_measurements: [], tables: [],
  };
  const r = evaluateCheck(blocked, { test_id: 'x', measure: 'anything', min: 0 });
  assert.equal(r.verdict, 'NOT_CHECKED');
  assert.equal(r.reason_code, 'netlist_unsupported');
  assert.equal(validateEvent(toTestResultEvent(r, envelope)).ok, true);
});

test('a check with no limit is NOT_CHECKED, not PASS', async () => {
  const run = await runNetlist(RC_NETLIST);
  const r = evaluateCheck(run, { test_id: 'no-limit', measure: 'v_tau' });
  assert.equal(r.verdict, 'NOT_CHECKED');
  assert.equal(r.reason_code, 'out_of_scope');
});

test('a timeout kills the child and gives ERROR/timeout, not PASS', async () => {
  const slow = `slow transient
V1 in 0 PWL(0 0 1n 1)
R1 in out 1k
C1 out 0 1u
.tran 1n 20
.control
run
meas tran v_tau FIND v(out) AT=1m
.endc
.end
`;
  const run = await runNetlist(slow, { timeoutMs: 1500 });
  assert.equal(run.ok, false);
  assert.equal(run.timed_out, true, `exit ${run.exit_code} signal ${run.signal}`);
  assert.equal(run.reason_code, 'timeout');
  const r = evaluateCheck(run, { test_id: 'slow', measure: 'v_tau', min: 0 });
  assert.equal(r.verdict, 'ERROR');
  assert.equal(r.reason_code, 'timeout');
  assert.equal(validateEvent(toTestResultEvent(r, envelope)).ok, true);
});

test('parsers handle ngspice output shapes directly', () => {
  const { measurements, failed } = parseMeasurements([
    'vmax                =  1.000000e+00 at=  4.000000e-08',
    'v_tau               =  6.321204e-01',
    ' meas tran vnope find v(out) at=99 failed!',
  ].join('\n'));
  assert.equal(measurements.vmax.value, 1);
  assert.equal(measurements.vmax.at, 4e-8);
  assert.equal(measurements.v_tau.value, 0.6321204);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, 'vnope');

  // A repeated header (ngspice pages long tables) continues the same table.
  const tables = parsePrintTables([
    'Index   time            v(out)',
    '--------------------------------------------------------------',
    '0\t0.000000e+00\t0.000000e+00',
    '1\t1.000000e-03\t6.321204e-01',
    '',
    'Index   time            v(out)',
    '--------------------------------------------------------------',
    '2\t3.000000e-03\t9.502129e-01',
  ].join('\n'));
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns, ['time', 'v(out)']);
  assert.deepEqual(tables[0].data.time, [0, 1e-3, 3e-3]);
  assert.deepEqual(tables[0].data['v(out)'], [0, 0.6321204, 0.9502129]);
});
