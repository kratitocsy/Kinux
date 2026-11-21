// The demo design, run for real.
//
// Everything here goes through the real /usr/bin/ngspice via
// workers/ngspice/{assertions,run}.mjs. Nothing is stubbed and no expected
// number is hard-coded as a measurement: the values below are the design's
// stated behaviour, and the test fails if ngspice disagrees.
//
// What these tests establish:
//   1. the baseline circuit simulates and PASSES every check in BOTH suites
//      (contract rule 2: a check that fails on the baseline can never kill);
//   2. every check is expressed in Kinux's Simulation-block grammar, never as
//      raw ngspice;
//   3. the thorough suite catches every injected fault;
//   4. at least one fault SURVIVES the weak suite while the thorough suite
//      catches it -- the demonstration itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  loadNetlist,
  loadSuite,
  runSuite,
  killVerdict,
  NETLIST_PATH,
  SUITE_PATHS,
} from '../examples/phase-leg-support/suites.mjs';
import { MUTANTS, applyMutant } from '../examples/phase-leg-support/mutants.mjs';
import { toTestResultEvent } from '../workers/ngspice/verdict.mjs';
import { validateEvent } from '../contracts/check-run.mjs';

const DESIGN_HASH = 'sha256:' + 'c'.repeat(64);
const envelope = { run_id: 'examples-run', seq: 0, design_hash: DESIGN_HASH };

/** Run both suites on the baseline once; every test below reuses it. */
const netlist = await loadNetlist();
const suites = {
  thorough: await loadSuite('thorough'),
  weak: await loadSuite('weak'),
};
const baseline = {
  thorough: await runSuite(netlist, suites.thorough, { subject: 'baseline' }),
  weak: await runSuite(netlist, suites.weak, { subject: 'baseline' }),
};

const show = results =>
  results
    .map(r => `${r.verdict} ${r.assertion ?? r.test_id}` + (r.measured !== undefined ? ` (measured ${r.measured}, limit ${r.limit})` : ` (${r.reason_code}: ${r.reason})`))
    .join('\n');

/* -------------------------------------------------------------------------- */
/* 1. The baseline passes both suites, for real                               */
/* -------------------------------------------------------------------------- */

test('baseline: the thorough suite has four analyses and 15 assertions', () => {
  assert.equal(suites.thorough.length, 4);
  assert.deepEqual(
    suites.thorough.map(b => b.analysis.kind),
    ['op', 'tran', 'tran', 'ac'],
  );
  assert.equal(
    suites.thorough.reduce((n, b) => n + b.assertions.length, 0),
    15,
  );
});

test('baseline: the weak suite is one operating point and three assertions', () => {
  assert.equal(suites.weak.length, 1);
  assert.equal(suites.weak[0].analysis.kind, 'op');
  assert.equal(suites.weak[0].assertions.length, 3);
});

for (const name of ['thorough', 'weak']) {
  test(`baseline PASSES every check in the ${name} suite`, () => {
    const results = baseline[name];
    assert.ok(results.length > 0, 'suite produced no results');
    const notPass = results.filter(r => r.verdict !== 'PASS');
    assert.deepEqual(notPass, [], `baseline must pass every ${name} check:\n${show(results)}`);
    // Unique test ids, or the kill rule cannot match baseline to mutant.
    assert.equal(new Set(results.map(r => r.test_id)).size, results.length);
  });
}

test('baseline: every result is a shape the contract accepts', () => {
  for (const results of Object.values(baseline)) {
    for (const r of results) {
      const v = validateEvent(toTestResultEvent(r, envelope));
      assert.equal(v.ok, true, `${r.test_id}: ${v.errors.join('; ')}`);
    }
  }
});

test('baseline: the design behaves as the README states', () => {
  const byAssertion = new Map(baseline.thorough.map(r => [r.assertion, r.measured]));
  // Stated design values, from README.md's component table.
  const stated = [
    ['V(gate) > 10.5', 11.988, 1e-2],                          // 12 V across Rg + Rgs
    ['V(fb) between 2.25 and 2.32', 2.2814, 1e-3],             // 48 * 4.99/104.99
    ['I(RFB1) < 600u', 457.19e-6, 1e-7],                       // 48 / 104.99k
    ['V(sh) < 50m', 0.040, 1e-5],                              // 20 A * 2 mOhm
    ['V(adc_i) between 0.78 and 0.82', 0.800, 1e-5],           // 40 mV * 20
    ['I(RSH) between 19 and 21', 20.0, 1e-6],                  // the phase current
    ['corner(adc_i) between 1.2k and 2.0k', 1591.5, 10],       // 1/(2*pi*1k*100n)
  ];
  for (const [assertion, want, tol] of stated) {
    const got = byAssertion.get(assertion);
    assert.ok(got !== undefined, `no result for ${assertion}`);
    assert.ok(
      Math.abs(got - want) <= tol,
      `${assertion}: ngspice measured ${got}, the design states ${want} (+/- ${tol})`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 2. The checks are in the project's grammar, not raw ngspice                */
/* -------------------------------------------------------------------------- */

test('every check is an assertion in the project grammar, never raw ngspice', async () => {
  for (const [name, path] of Object.entries(SUITE_PATHS)) {
    const text = await readFile(path, 'utf8');
    // A Simulation block refuses a raw statement outright, so a dot directive
    // anywhere a block would read it is already impossible; assert the stronger
    // property that the suite documents contain no deck or control syntax.
    for (const line of text.split('\n')) {
      assert.ok(
        !/^\s*[.]/.test(line) && !/^\s*(let|meas|print|tran|save)\b/.test(line),
        `${name}: "${line.trim()}" looks like hand-written ngspice`,
      );
    }
    // And every assertion really did parse into the grammar's own AST.
    for (const block of await loadSuite(name)) {
      for (const a of block.assertions) {
        assert.ok(['voltage', 'current', 'corner'].includes(a.measurable.kind));
        assert.ok(['between', 'less-than', 'greater-than'].includes(a.comparator.kind));
      }
    }
  }
});

test('the netlist uses only built-in primitives: no vendor models, no includes', async () => {
  const text = await readFile(NETLIST_PATH, 'utf8');
  assert.ok(!/^\s*\.(include|inc|lib)\b/im.test(text), 'netlist pulls in an external file');
  assert.ok(!/^\s*\.model\b/im.test(text), 'netlist declares a device model');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('*') || t.startsWith('.')) continue;
    assert.match(t, /^[RCVIE]/, `unexpected device line: ${t}`);
  }
});

/* -------------------------------------------------------------------------- */
/* 3. Mutants: the thorough suite catches every one                           */
/* -------------------------------------------------------------------------- */

/** Measured once, reused by the tests below. */
const measured = [];
for (const m of MUTANTS) {
  const mutated = applyMutant(netlist, m);
  measured.push({
    mutant: m,
    thorough: killVerdict(baseline.thorough, await runSuite(mutated, suites.thorough, { subject: m.id })),
    weak: killVerdict(baseline.weak, await runSuite(mutated, suites.weak, { subject: m.id })),
  });
}

test('each mutant really is a change: applyMutant refuses a no-op', () => {
  for (const m of MUTANTS) {
    assert.notEqual(applyMutant(netlist, m), netlist, `${m.id} changed nothing`);
    assert.throws(
      () => applyMutant(netlist, { ...m, find: 'RX nowhere 0 1k' }),
      /expected exactly one occurrence/,
    );
  }
});

for (const m of MUTANTS) {
  test(`thorough suite catches ${m.id} (${m.label})`, () => {
    const row = measured.find(r => r.mutant.id === m.id);
    assert.equal(
      row.thorough.caught,
      true,
      `${m.id} survived the thorough suite; not-checked: ${JSON.stringify(row.thorough.notChecked)}`,
    );
    assert.ok(row.thorough.killedBy.length > 0);
  });
}

test('NOT_CHECKED is never counted as a catch', () => {
  // M5 and M6 make corner() unmeasurable. Each must still be caught by a real
  // FAIL, and the unmeasurable assertion must not appear among the killers.
  for (const row of measured) {
    for (const nc of row.thorough.notChecked) {
      assert.ok(!row.thorough.killedBy.includes(nc), `${row.mutant.id}: ${nc} counted as a catch`);
    }
  }
  const m5 = measured.find(r => r.mutant.id === 'M5-cf-removed');
  assert.ok(m5.thorough.notChecked.length > 0, 'expected corner() to be unmeasurable for M5');
  assert.ok(m5.thorough.killedBy.length > 0, 'M5 must still be caught by a real FAIL');
});

/* -------------------------------------------------------------------------- */
/* 4. The demonstration: a weak suite scores lower on the same design         */
/* -------------------------------------------------------------------------- */

test('THE DEMONSTRATION: faults survive the weak suite that the thorough suite catches', () => {
  const survivors = measured.filter(r => !r.weak.caught && r.thorough.caught);
  const detail = measured
    .map(r => `  ${r.mutant.id}: thorough=${r.thorough.caught ? 'CAUGHT' : 'SURVIVED'} weak=${r.weak.caught ? 'CAUGHT' : 'SURVIVED'}`)
    .join('\n');

  assert.ok(
    survivors.length >= 1,
    'NO fault survived the weak suite while the thorough suite caught it. ' +
      'The product thesis -- a weak suite scores lower than a thorough one on ' +
      `the same design -- is NOT demonstrated by this design.\n${detail}`,
  );

  // Named explicitly: the gate-resistor fault and the missing decoupling cap
  // are the two the weak suite structurally cannot see, being op-only.
  const survivorIds = survivors.map(r => r.mutant.id);
  assert.ok(survivorIds.includes('M1-rg-10x'), detail);
  assert.ok(survivorIds.includes('M2-cfb-removed'), detail);
});

test('THE DEMONSTRATION: the thorough suite strictly outscores the weak one', () => {
  const t = measured.filter(r => r.thorough.caught).length;
  const w = measured.filter(r => r.weak.caught).length;
  const detail = `thorough ${t}/${measured.length}, weak ${w}/${measured.length}`;
  assert.equal(t, measured.length, `thorough suite missed a fault: ${detail}`);
  assert.ok(
    w < t,
    'THE WEAK SUITE SCORED AS HIGH AS THE THOROUGH ONE. This contradicts the ' +
      `central claim and must be reported, not hidden: ${detail}`,
  );
  // Every fault the weak suite catches must also be caught by the thorough one;
  // otherwise "thorough" is a misnomer.
  for (const row of measured) {
    if (row.weak.caught) assert.ok(row.thorough.caught, `${row.mutant.id}: weak caught it, thorough did not`);
  }
});
