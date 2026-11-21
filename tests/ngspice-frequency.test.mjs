// f(net): a frequency measurable for the closed assertion grammar.
//
//   f(<net>) crossing <volts> [after <seconds>] (between <a> and <b> | < <x> | > <x>)
//
// Needs a tran analysis. Kinux measures the time for 3 full periods between
// rising crossings of the threshold, starting at `after` (default: half the
// tran window, to skip start-up), and reports 3 / that time in hertz.
//
// The case that matters most: a dead oscillator. If the signal never crosses
// the threshold in the window, its frequency there is 0 Hz, a real
// measurement that can FAIL a check, so stopping an oscillator can be a kill.
// If the net does not exist, or it crosses but too few times to time 3
// periods, the assertion is NOT_CHECKED, never a pass and never a fail.
//
// Expected values are exact by construction: a PULSE source with period P has
// frequency 1/P. All runs use the real ngspice binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSpiceAssertion, verifySimulation } from '../workers/ngspice/assertions.mjs';

const pulse = period => `* pulse ${period}
V1 n 0 PULSE(0 5 0 1n 1n ${period / 2} ${period})
R1 n 0 1k
.end
`;
const dc = `* dc
V1 n 0 DC 1
R1 n 0 1k
.end
`;

async function one(netlist, assertion, analysis = 'tran 10n 1m') {
  const r = await verifySimulation(netlist, { analysis, assertions: [assertion] });
  assert.equal(r.results.length, 1);
  return r.results[0];
}

test('parses: crossing is required, after is optional, units are hertz', () => {
  const a = parseSpiceAssertion('f(OUT) crossing 2.5 between 99k and 101k');
  assert.equal(a.measurable.kind, 'frequency');
  assert.equal(a.crossing.value, 2.5);
  assert.equal(a.after, null);
  const b = parseSpiceAssertion('f(OUT) crossing 2.5V after 2m between 99kHz and 101kHz');
  assert.equal(b.after.value, 2e-3);
  for (const bad of ['f(OUT) between 99k and 101k', 'f(OUT) crossing 2.5 between 99kV and 101kV',
    'f(OUT) crossing 2.5A < 5k', 'f(OUT) crossing 2.5 at 1m < 5k', 'f(OUT) crossing 2.5 after 1mV < 5k']) {
    assert.throws(() => parseSpiceAssertion(bad), undefined, bad);
  }
});

test('a 100 kHz pulse measures 100 kHz (exact by construction)', async () => {
  const r = await one(pulse(10e-6), 'f(n) crossing 2.5 between 99.9k and 100.1k');
  assert.equal(r.verdict, 'PASS', JSON.stringify(r));
  assert.ok(Math.abs(r.measured - 1e5) / 1e5 < 1e-4, `measured ${r.measured}`);
});

test('the same pulse fails a bound it does not meet, so the check can fail', async () => {
  const r = await one(pulse(10e-6), 'f(n) crossing 2.5 > 1Meg');
  assert.equal(r.verdict, 'FAIL');
  assert.ok(Math.abs(r.measured - 1e5) / 1e5 < 1e-4);
});

test('a 7 kHz pulse measures 7 kHz: the number is not a constant', async () => {
  const r = await one(pulse(1 / 7000), 'f(n) crossing 2.5 between 6.99k and 7.01k', 'tran 100n 5m');
  assert.equal(r.verdict, 'PASS', JSON.stringify(r));
});

test('a signal that never crosses the threshold is 0 Hz, and FAILS a frequency band (a dead oscillator is a kill)', async () => {
  const r = await one(dc, 'f(n) crossing 2.5 between 99k and 101k');
  assert.equal(r.verdict, 'FAIL', JSON.stringify(r));
  assert.equal(r.measured, 0);
});

test('a missing net is NOT_CHECKED, not 0 Hz', async () => {
  const r = await one(pulse(10e-6), 'f(nosuchnet) crossing 2.5 between 99k and 101k');
  assert.equal(r.verdict, 'NOT_CHECKED', JSON.stringify(r));
  assert.match(r.reason, /could not resolve "nosuchnet"/);
});

test('too few periods in the window to time three is NOT_CHECKED, not a guess', async () => {
  // 1 kHz in a 4 ms window starting at 2 ms: only 2 rising edges after `after`.
  const r = await one(pulse(1e-3), 'f(n) crossing 2.5 between 0.9k and 1.1k', 'tran 1u 4m');
  assert.equal(r.verdict, 'NOT_CHECKED', JSON.stringify(r));
  assert.match(r.reason, /fewer than 3 full periods/);
});

test('f() needs a tran analysis', async () => {
  const r = await one(pulse(10e-6), 'f(n) crossing 2.5 < 1Meg', 'op');
  assert.equal(r.verdict, 'NOT_CHECKED');
  assert.match(r.reason, /requires a tran analysis/);
});

test('after must fall inside the tran window', async () => {
  const r = await one(pulse(10e-6), 'f(n) crossing 2.5 after 2m < 1Meg', 'tran 10n 1m');
  assert.equal(r.verdict, 'NOT_CHECKED');
  assert.match(r.reason, /not inside the tran window/);
});

test('in the mutation engine, a fault that stops the signal is a kill, and one that leaves it running survives', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'kinux-freq-'));
  try {
    // A 100 kHz clock through a 1k/1k divider: OUT swings 0 to 2.5 V, so it crosses 1.25 V.
    writeFileSync(join(dir, 'clk.cir'), '* clock divider\nV1 clk 0 PULSE(0 5 0 1n 1n 5u 10u)\nR1 clk out 1k\nR2 out 0 1k\n.end\n');
    writeFileSync(join(dir, 'checks.md'), '# f only\n\n## Simulation\n\nscope: nets [out]\nanalysis: tran 10n 1m\nassert: f(out) crossing 1.25 between 99.9k and 100.1k\n');
    execFileSync(process.execPath, [join(root, 'engine/cli.mjs'), 'verify', join(dir, 'clk.cir'), '--checks', join(dir, 'checks.md'),
      '--out', join(dir, 'out'), '--threshold', '0'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
    assert.equal(report.baseline.ok ?? true, true);
    const byId = Object.fromEntries(report.mutants.map(m => [m.mutant_id, m.status]));
    // Opening R1 disconnects the clock: OUT sits at 0 V, never crosses 1.25 V, 0 Hz -> killed.
    assert.equal(byId['M-open_connection-R1.0'], 'killed', JSON.stringify(byId));
    // Opening R2 only doubles the swing (0 to 5 V): still 100 kHz, so no frequency check can see it.
    assert.equal(byId['M-open_connection-R2.0'], 'survived', JSON.stringify(byId));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
