// K31: a transient average is a measurement, not a missing one.
//
// ngspice prints `name = value from= t1 to= t2` for AVG/RMS/MIN/MAX and
// `name = value targ= .. trig= ..` for TRIG/TARG. The parser accepted only a
// trailing `at=`, so every average over a tran, ac or dc sweep came back
// "not present", i.e. NOT_CHECKED: never a false pass, but those checks never
// counted (measured on the 555 board: 6 of its 9 checks). Real ngspice runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMeasurements } from '../workers/ngspice/run.mjs';
import { verifySimulation } from '../workers/ngspice/assertions.mjs';

test('the parser reads values with from/to, targ/trig and at trailers, and nothing else changes', () => {
  const { measurements } = parseMeasurements([
    'k2                  =  2.500500e+00 from=  0.000000e+00 to=  1.000000e-03',
    'k3                  =  3.000000e-05 targ=  5.300005e-04 trig=  5.000005e-04',
    'k4                  =  5.000000e+00 at=  5.000000e-04',
    'k5 = 7.000000e+00',
  ].join('\n'));
  assert.equal(measurements.k2.value, 2.5005);
  assert.equal(measurements.k3.value, 3e-5);
  assert.deepEqual(measurements.k4, { value: 5, at: 5e-4 });
  assert.equal(measurements.k5.value, 7);
});

test('an average over a transient is measured and judged (real ngspice): a 50% duty 5 V pulse averages 2.5 V', async () => {
  const netlist = '* avg\nV1 n 0 PULSE(0 5 0 1n 1n 5u 10u)\nR1 n 0 1k\n.end\n';
  const r = await verifySimulation(netlist, { analysis: 'tran 10n 1m', assertions: ['V(n) between 2.45 and 2.55', 'V(n) < 1'] });
  assert.equal(r.results[0].verdict, 'PASS', JSON.stringify(r.results[0]));
  assert.ok(Math.abs(r.results[0].measured - 2.5) < 0.01, `measured ${r.results[0].measured}`);
  assert.equal(r.results[1].verdict, 'FAIL', 'and the same average can fail a bound it does not meet');
});
