// Tests for the ported assertion language (workers/ngspice/assertions.mjs).
// These call the REAL ngspice binary -- nothing here is mocked. If ngspice is
// missing the suite fails loudly rather than skipping, for the same reason the
// worker suite does: a silently skipped safety test is worse than none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SimulationParseError,
  compileSimulationDeck,
  compileSpiceAssertion,
  describeComparator,
  evaluateAssertion,
  parseAnalysis,
  parseAssertions,
  parseSimulationBlocks,
  parseSpiceAssertion,
  parseSpiceNumber,
  satisfies,
  verifySimulation,
} from '../workers/ngspice/assertions.mjs';
import { sanitize } from '../workers/ngspice/sanitize.mjs';
import { toTestResultEvent } from '../workers/ngspice/verdict.mjs';
import { validateEvent } from '../contracts/check-run.mjs';

const DESIGN_HASH = 'sha256:' + 'b'.repeat(64);
const envelope = { run_id: 'assertion-run', seq: 0, design_hash: DESIGN_HASH };

// R = 1k, C = 1u -> tau = 1 ms. Stated step response: 0.6321194 at 1 ms,
// 0.9502136 at 3 ms, 0.9932623 at 5 ms.
const RC_NETLIST = `RC low-pass step response
V1 in 0 PWL(0 0 1n 1)
R1 in out 1k
C1 out 0 1u
.end
`;

const DIVIDER_NETLIST = `resistive divider
V1 in 0 DC 5
R1 in out 1k
R2 out 0 1k
.end
`;

const AC_NETLIST = `RC low-pass ac
V1 in 0 AC 1
R1 in out 1k
C1 out 0 1u
.end
`;

/** Every result must be a shape the contract accepts, always. */
function assertContractShape(results) {
  for (const r of results) {
    const ev = toTestResultEvent(r, envelope);
    const v = validateEvent(ev);
    assert.equal(v.ok, true, `${r.test_id}: ${v.errors.join('; ')}`);
    if (r.verdict === 'NOT_CHECKED' || r.verdict === 'ERROR') {
      assert.ok(r.reason_code, `${r.test_id}: ${r.verdict} without a reason_code`);
      assert.ok(r.reason && r.reason.length > 0, `${r.test_id}: ${r.verdict} without a reason`);
    } else {
      assert.equal(r.reason_code, undefined, `${r.test_id}: a real ${r.verdict} carries no reason_code`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

test('parseSpiceNumber reads SI multipliers and keeps the unit', () => {
  const cases = [
    ['3.3', 3.3, ''],
    ['25uA', 25e-6, 'A'],
    ['10k', 10_000, ''],
    ['2MEGOhm', 2e6, 'Ohm'],
    ['-4.7mV', -4.7e-3, 'V'],
    ['1e-9A', 1e-9, 'A'],
  ];
  for (const [raw, value, unit] of cases) {
    const n = parseSpiceNumber(raw);
    assert.equal(n.raw, raw);
    assert.equal(n.unit, unit);
    assert.ok(Math.abs(n.value - value) < Math.abs(value) * 1e-12 + 1e-18, `${raw}: ${n.value}`);
  }
});

test('malformed numbers are refused with a line and a structured code', () => {
  const cases = [
    ['NaN', 'invalid_number'],
    ['', 'invalid_number'],
    ['1e999V', 'number_out_of_range'],
    ['3,3', 'invalid_number'],
  ];
  for (const [raw, code] of cases) {
    assert.throws(
      () => parseSpiceNumber(raw, 14),
      err => {
        assert.ok(err instanceof SimulationParseError, `${raw}: ${err}`);
        assert.equal(err.line, 14);
        assert.equal(err.code, code, `${raw}: got ${err.code}`);
        assert.equal(err.reason_code, 'netlist_unsupported');
        return true;
      },
    );
  }
});

test('every measurable x comparator form in the grammar parses', () => {
  const expected = [
    ['V(VREF) between 3.25 and 3.35', 'voltage', 'VREF', 'between', null],
    ['I(R5) < 25uA', 'current', 'R5', 'less-than', null],
    ['corner(OUT) > 1kHz', 'corner', 'OUT', 'greater-than', null],
    ['v(out) at 1m between 0.6 and 0.7', 'voltage', 'out', 'between', 1e-3],
    ['I(V1) at 2.5m < 1mA', 'current', 'V1', 'less-than', 2.5e-3],
    ['V(/Power/VREF) > 3V', 'voltage', '/Power/VREF', 'greater-than', null],
  ];
  for (const [raw, kind, target, cmp, at] of expected) {
    const a = parseSpiceAssertion(raw, 7);
    assert.equal(a.raw, raw);
    assert.equal(a.line, 7);
    assert.equal(a.measurable.kind, kind, raw);
    assert.equal(a.measurable.target, target, raw);
    assert.equal(a.comparator.kind, cmp, raw);
    assert.equal(a.at === null ? null : a.at.value, at, raw);
    assert.equal(typeof describeComparator(a.comparator), 'string');
  }
});

test('malformed assertions are refused with a structured reason, never ignored', () => {
  const cases = [
    ['max(V(OUT)) < 5', 'invalid_assertion'],
    ['V(OUT)', 'invalid_assertion'],
    ['W(OUT) < 5', 'invalid_assertion'],
    ["V(OUT') < 5V", 'invalid_target'],
    ['V(OUT) <= 5V', 'invalid_comparator'],
    ['V(OUT) is small', 'invalid_comparator'],
    ['V(OUT) between 5 and 3', 'bounds_not_ordered'],
    ['V(OUT) between 3 and 3', 'bounds_not_ordered'],
    ['V(OUT) between 3.25 and 3.35V', 'unit_mismatch'],
    ['V(OUT) < 25uA', 'unit_not_for_measurable'],
    ['I(R5) < 3.3V', 'unit_not_for_measurable'],
    ['V(OUT) at nope > 1', 'invalid_number'],
    ['V(OUT) < 1..2', 'invalid_number'],
  ];
  for (const [raw, code] of cases) {
    assert.throws(
      () => parseSpiceAssertion(raw, 42),
      err => {
        assert.ok(err instanceof SimulationParseError, `${raw}: ${err}`);
        assert.equal(err.code, code, `${raw}: got code ${err.code} (${err.message})`);
        assert.equal(err.line, 42);
        assert.match(err.message, /^line 42: /);
        return true;
      },
      `"${raw}" must be refused`,
    );
  }
});

test('parseAssertions keeps the good ones and reports the bad ones', () => {
  const { assertions, errors } = parseAssertions(['V(a) > 1', 'nonsense', 'I(V1) < 1mA']);
  assert.equal(assertions.length, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(
    errors.map(e => [e.raw, e.code, e.line]),
    [['nonsense', 'invalid_assertion', 2]],
  );
});

test('analysis carries its sweep parameters, and only safe tokens', () => {
  assert.deepEqual(parseAnalysis('tran 1u 6m'), { kind: 'tran', params: ['1u', '6m'], raw: 'tran 1u 6m' });
  assert.deepEqual(parseAnalysis('op'), { kind: 'op', params: [], raw: 'op' });
  assert.equal(parseAnalysis('AC dec 100 1 1meg').kind, 'ac');
  const bad = [
    ['noise', 'unsupported_analysis'],
    ['op 1u 6m', 'invalid_analysis_params'],
    ['ac 1 2 3 4', 'invalid_analysis_params'],
    ['tran 1u 6m .endc', 'invalid_analysis_params'],
    ['tran 1u "6m"', 'invalid_analysis_params'],
    ['tran 1 2 3 4 5 6 7 8 9', 'invalid_analysis_params'],
  ];
  for (const [raw, code] of bad) {
    assert.throws(
      () => parseAnalysis(raw, 3),
      err => (assert.equal(err.code, code, `${raw}: ${err.code}`), true),
      raw,
    );
  }
});

test('a Simulation block in Markdown parses, with scope, sources and lines', () => {
  const markdown = `# Power subsystem

\`\`\`markdown
## Simulation
scope: nets EXAMPLE, GND
analysis: op
assert: V(EXAMPLE) > 1V
\`\`\`

## Simulation
scope: sheet /Power/Reference
analysis: op
source: VIN=3.3V
sources: ENABLE=1
assert: V(VREF) between 3.25 and 3.35
assert: I(V1) < 25uA

## Notes
Keep the reference close to the ADC.
`;
  const blocks = parseSimulationBlocks(markdown);
  assert.equal(blocks.length, 1, 'the fenced example must not be live input');
  const [b] = blocks;
  assert.equal(b.line, 10);
  assert.deepEqual(b.scope, { kind: 'sheet', sheet: '/Power/Reference' });
  assert.equal(b.analysis.kind, 'op');
  assert.deepEqual(b.sources.map(s => [s.port, s.value.value, s.line]), [
    ['VIN', 3.3, 13],
    ['ENABLE', 1, 14],
  ]);
  assert.deepEqual(b.assertions.map(a => a.line), [15, 16]);

  const nets = parseSimulationBlocks('## Simulation\nscope: nets [VIN, VOUT, GND, VOUT]\nanalysis: tran 1u 1m\nassert: V(VOUT) > 1.2V\n');
  assert.deepEqual(nets[0].scope, { kind: 'nets', nets: ['VIN', 'VOUT', 'GND'] });
  assert.deepEqual(parseSimulationBlocks('# nothing here\n'), []);
});

test('a raw ngspice statement in a Simulation block is a parse error, not input', () => {
  const markdown = `## Simulation
scope: sheet /Power
analysis: op
.control
assert: V(VREF) > 3V
`;
  assert.throws(
    () => parseSimulationBlocks(markdown),
    err => {
      assert.equal(err.code, 'raw_statement_not_allowed');
      assert.equal(err.line, 4);
      assert.match(err.message, /\.control/);
      return true;
    },
  );
  for (const [markdown, code, line] of [
    ['## Simulation\nscope: nets OUT, GND\nanalysis: dc V1 0 5 1\n', 'no_assertions', 1],
    ['## Simulation\nanalysis: op\nassert: V(OUT) > 1V\n', 'missing_scope', 1],
    ['## Simulation\nscope: nets OUT, GND\nassert: V(OUT) > 1V\n', 'missing_analysis', 1],
    ['## Simulation\nscope: board /Power\nanalysis: op\nassert: V(O) > 1V\n', 'invalid_scope', 2],
    ['## Simulation\nscope: sheet\nanalysis: op\nassert: V(O) > 1V\n', 'empty_sheet_scope', 2],
    ['## Simulation\nscope: nets OUT, BAD NET\nanalysis: op\nassert: V(O) > 1V\n', 'invalid_net_list', 2],
    ['## Simulation\nscope: nets OUT\nmode: op\nanalysis: op\nassert: V(O) > 1V\n', 'unknown_field', 3],
    ['## Simulation\nscope: nets OUT\nanalysis: op\nsource: VIN 3.3V\nassert: V(O) > 1V\n', 'invalid_source', 4],
    ['## Simulation\nscope: nets OUT\nanalysis: op\nsource:\nassert: V(O) > 1V\n', 'malformed_field', 4],
    ['## Simulation\nscope: nets OUT\nanalysis: op\nanalysis: dc V1 0 1 1\nassert: V(O) > 1V\n', 'duplicate_field', 4],
  ]) {
    assert.throws(
      () => parseSimulationBlocks(markdown),
      err => {
        assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
        assert.equal(err.line, line, err.message);
        return true;
      },
      code,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Compiling                                                                  */
/* -------------------------------------------------------------------------- */

test('compileSpiceAssertion emits one value measure and an inclusive/strict check', () => {
  const between = compileSpiceAssertion(parseSpiceAssertion('V(VREF) between 3.25 and 3.35', 12), 'op', 'vref');
  assert.deepEqual(between.lines, ['let vref = v(VREF)', 'print vref']);
  assert.deepEqual(between.check, { measure: 'vref', min: 3.25, max: 3.35 });

  const tran = compileSpiceAssertion(parseSpiceAssertion('V(out) at 1m < 0.7', 3), parseAnalysis('tran 1u 6m'), 'k1');
  assert.deepEqual(tran.lines, ['meas tran k1 FIND v(out) AT=1.000000000000e-3']);
  assert.deepEqual(tran.check, { measure: 'k1', max: 0.7 });

  // Current through a non-source device needs @refdes[i] and a save line;
  // i(...) only resolves for V/E/H sources in ngspice.
  const cur = compileSpiceAssertion(parseSpiceAssertion('I(R5) at 1m < 25uA', 4), parseAnalysis('tran 1u 6m'), 'k2');
  assert.deepEqual(cur.saves, ['@r5[i]']);
  assert.match(cur.lines[0], /FIND @r5\[i\]/);
  assert.equal(compileSpiceAssertion(parseSpiceAssertion('I(V1) at 1m < 25uA'), parseAnalysis('tran 1u 6m'), 'k3').expression, 'i(V1)');

  // corner() is AC-only, and an op analysis has no point to measure at.
  assert.throws(
    () => compileSpiceAssertion(parseSpiceAssertion('corner(OUT) < 10kHz'), parseAnalysis('tran 1u 1m'), 'k'),
    err => (assert.equal(err.code, 'corner_requires_ac'), true),
  );
  assert.throws(
    () => compileSpiceAssertion(parseSpiceAssertion('V(out) at 1m > 1'), 'op', 'k'),
    err => (assert.equal(err.code, 'at_not_supported'), true),
  );
  assert.throws(
    () => compileSpiceAssertion(parseSpiceAssertion('V(out) > 1V', 27), 'op', 'bad-name'),
    err => (assert.equal(err.code, 'invalid_measure_name'), true),
  );
});

test('strictness is preserved: between is inclusive, < and > are not', () => {
  const between = parseSpiceAssertion('V(a) between 1 and 2').comparator;
  assert.equal(satisfies(1, between), true);
  assert.equal(satisfies(2, between), true);
  assert.equal(satisfies(2.0001, between), false);
  const lt = parseSpiceAssertion('V(a) < 2').comparator;
  assert.equal(satisfies(1.999, lt), true);
  assert.equal(satisfies(2, lt), false, 'a strict bound must not pass at the bound');
  const gt = parseSpiceAssertion('V(a) > 2').comparator;
  assert.equal(satisfies(2, gt), false, 'a strict bound must not pass at the bound');
  assert.equal(satisfies(2.001, gt), true);
});

test('the compiled deck is a complete, sanitizer-clean netlist', () => {
  const c = compileSimulationDeck(RC_NETLIST, {
    analysis: 'tran 1u 6m',
    assertions: ['V(out) at 1m between 0.6 and 0.7'],
    sources: [{ port: 'bias', value: parseSpiceNumber('3.3V'), line: 1 }],
  });
  assert.equal(c.ok, true);
  assert.deepEqual(c.errors, []);
  assert.match(c.deck, /^RC low-pass step response\n/);
  assert.equal((c.deck.match(/^\.end$/gm) || []).length, 1, 'exactly one .end');
  assert.match(c.deck, /Vksrc1 bias 0 DC 3\.300000000000e\+0/);
  assert.match(c.deck, /\.control\n(?:.*\n)*?\.endc/);
  assert.equal(sanitize(c.deck).ok, true, 'our own output must pass the allowlist');
});

test('a swept analysis without parameters is refused, not guessed', async () => {
  // Upstream never captured sweep parameters, so its `analysis: tran` could not
  // produce a runnable deck. Refusing is honest; inventing a sweep is not.
  const out = await verifySimulation(RC_NETLIST, {
    analysis: 'tran',
    assertions: ['V(out) at 1m > 0.5'],
  });
  assert.equal(out.run, null, 'ngspice must not be started');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].verdict, 'NOT_CHECKED');
  assert.equal(out.results[0].reason_code, 'netlist_unsupported');
  assert.match(out.results[0].reason, /sweep parameters/);
  assertContractShape(out.results);
});

/* -------------------------------------------------------------------------- */
/* End to end against the real binary                                         */
/* -------------------------------------------------------------------------- */

test('end to end on a real RC circuit: a true assertion PASSes, a false one FAILs', async () => {
  const out = await verifySimulation(RC_NETLIST, {
    analysis: 'tran 1u 6m',
    assertions: [
      'V(out) at 1m between 0.6321 and 0.6322', // 0.6321194
      'V(out) at 3m > 0.95',                    // 0.9502136
      'V(out) at 5m < 0.9933',                  // 0.9932623
      'V(out) at 1m > 0.9',                     // false: it is 0.632
      'V(out) at 5m between 0.1 and 0.2',       // false: it is 0.993
      'V(out) at 3m < 0.9',                     // false: it is 0.950
    ],
  });
  assert.equal(out.run.ok, true, out.run.reason ?? '');
  assert.equal(out.results.length, 6);
  assert.deepEqual(
    out.results.map(r => r.verdict),
    ['PASS', 'PASS', 'PASS', 'FAIL', 'FAIL', 'FAIL'],
    JSON.stringify(out.results, null, 1),
  );
  // The measured values are the stated step response.
  const stated = [0.6321194, 0.9502136, 0.9932623];
  stated.forEach((want, i) => {
    assert.ok(
      Math.abs(out.results[i].measured - want) < 1e-4,
      `${out.results[i].test_id}: measured ${out.results[i].measured}, stated ${want}`,
    );
  });
  // A FAIL reports the value it measured and the bound it was judged against.
  assert.ok(Math.abs(out.results[3].measured - 0.6321194) < 1e-4);
  assert.equal(out.results[3].limit, '> 0.9');
  assert.equal(out.results[3].assertion, 'V(out) at 1m > 0.9');
  assertContractShape(out.results);

  // Strictness end to end: re-assert against the exact value ngspice measured.
  // `< v` and `> v` must both FAIL at the bound; `between v and v+d` passes.
  const v3 = out.results[1].measured;
  const atBound = await verifySimulation(RC_NETLIST, {
    analysis: 'tran 1u 6m',
    assertions: [
      `V(out) at 3m < ${v3}`,
      `V(out) at 3m > ${v3}`,
      `V(out) at 3m between ${v3} and ${v3 + 1e-6}`,
    ],
  });
  assert.deepEqual(
    atBound.results.map(r => r.verdict),
    ['FAIL', 'FAIL', 'PASS'],
    JSON.stringify(atBound.results, null, 1),
  );
  assertContractShape(atBound.results);
});

test('end to end: op, ac corner and device current against the real binary', async () => {
  const op = await verifySimulation(DIVIDER_NETLIST, {
    analysis: 'op',
    assertions: ['V(out) between 2.49 and 2.51', 'I(R1) < 3mA', 'V(out) > 4'],
  });
  assert.deepEqual(op.results.map(r => r.verdict), ['PASS', 'PASS', 'FAIL'], JSON.stringify(op.results));
  assert.ok(Math.abs(op.results[0].measured - 2.5) < 1e-9, `${op.results[0].measured}`);
  assert.ok(Math.abs(op.results[1].measured - 2.5e-3) < 1e-9, `${op.results[1].measured}`);
  assertContractShape(op.results);

  // -3 dB corner of a 1k/1u low-pass is 1/(2*pi*1e-3) = 159.15 Hz.
  const ac = await verifySimulation(AC_NETLIST, {
    analysis: 'ac dec 100 1 1meg',
    assertions: ['corner(out) between 150Hz and 170Hz', 'corner(out) > 1kHz'],
  });
  assert.deepEqual(ac.results.map(r => r.verdict), ['PASS', 'FAIL'], JSON.stringify(ac.results));
  assert.ok(Math.abs(ac.results[0].measured - 159.15) < 2, `corner ${ac.results[0].measured}`);
  assertContractShape(ac.results);
});

test('an assertion on a net that does not exist is NOT_CHECKED, never PASS or FAIL', async () => {
  const out = await verifySimulation(RC_NETLIST, {
    analysis: 'tran 1u 6m',
    assertions: ['V(NO_SUCH_NET_XYZ) at 1m between 0 and 5', 'V(out) at 1m > 0.5'],
  });
  const missing = out.results[0];
  assert.notEqual(missing.verdict, 'PASS');
  assert.notEqual(missing.verdict, 'FAIL');
  assert.equal(missing.verdict, 'NOT_CHECKED', JSON.stringify(missing));
  assert.equal(missing.reason_code, 'netlist_unsupported');
  assert.match(missing.reason, /NO_SUCH_NET_XYZ/i);
  assert.equal(missing.measured, undefined, 'nothing was measured, so nothing is reported');
  // The rest of the block is still evaluated.
  assert.equal(out.results[1].verdict, 'PASS', JSON.stringify(out.results[1]));
  assertContractShape(out.results);

  // Same rule when the device, not the net, is missing.
  const dev = await verifySimulation(RC_NETLIST, {
    analysis: 'tran 1u 6m',
    assertions: ['I(R_NOT_HERE) at 1m < 1mA'],
  });
  assert.ok(['NOT_CHECKED', 'ERROR'].includes(dev.results[0].verdict), JSON.stringify(dev.results[0]));
  assert.ok(dev.results[0].reason_code, 'a non-evaluated assertion needs a reason_code');
  assertContractShape(dev.results);
});

test('an unknown model is NOT_CHECKED with no_model, never a pass', async () => {
  const out = await verifySimulation(
    `undefined model
V1 in 0 DC 1
R1 in b 1k
Q1 c b 0 NO_SUCH_MODEL_XYZ
.end
`,
    { analysis: 'tran 1u 1m', assertions: ['V(c) at 0.5m between 0 and 5'] },
  );
  assert.equal(out.run.ok, false, 'ngspice must refuse a circuit with an unknown model');
  assert.equal(out.results[0].verdict, 'NOT_CHECKED', JSON.stringify(out.results[0]));
  assert.equal(out.results[0].reason_code, 'no_model');
  assertContractShape(out.results);
});

test('a timeout is ERROR/timeout, never a pass', async () => {
  const out = await verifySimulation(RC_NETLIST, {
    analysis: 'tran 1n 20',
    assertions: ['V(out) at 1m > 0.5'],
  }, { timeoutMs: 1500 });
  const r = out.results[0];
  assert.equal(out.run.timed_out, true, `exit ${out.run.exit_code} signal ${out.run.signal}`);
  assert.equal(r.verdict, 'ERROR', JSON.stringify(r));
  assert.equal(r.reason_code, 'timeout');
  assertContractShape(out.results);
});

test('every assertion in a block gets exactly one result, whatever happened', async () => {
  const assertions = [
    'V(out) at 1m > 0.5',           // PASS
    'V(out) at 1m > 0.9',           // FAIL
    'V(NOPE) at 1m > 0',            // NOT_CHECKED (missing net)
    'this is not an assertion',     // NOT_CHECKED (parse)
    'corner(out) > 1kHz',           // NOT_CHECKED (corner needs ac)
  ];
  const out = await verifySimulation(RC_NETLIST, { analysis: 'tran 1u 6m', assertions });
  assert.equal(out.results.length, assertions.length);
  assert.equal(new Set(out.results.map(r => r.test_id)).size, assertions.length, 'test ids must be unique');
  const byVerdict = out.results.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {});
  assert.deepEqual(byVerdict, { PASS: 1, FAIL: 1, NOT_CHECKED: 3 }, JSON.stringify(out.results, null, 1));
  assertContractShape(out.results);
});

/* -------------------------------------------------------------------------- */
/* Injection                                                                  */
/* -------------------------------------------------------------------------- */

const PWNED = 'pwned_assertions.txt';

// Assertions are attacker-controlled text that ends up inside a .control block,
// and .control executes shell commands even under `ngspice -b`. None of these
// may reach the binary.
const HOSTILE_ASSERTIONS = [
  `V(out) > 1\n.endc\nshell touch ${PWNED}\n.control\n`,
  `V(out) > 1 ; shell touch ${PWNED}`,
  `V(out) > 1\nshell touch ${PWNED}`,
  `V(out\n.endc\nshell touch ${PWNED}\n.control\nv(out) > 1`,
  `V(out) > \`touch ${PWNED}\``,
  `V(out) > $(touch ${PWNED})`,
  `V(out) > 1 > ${PWNED}`,
  `V(out) at 1m > 1 | shell touch ${PWNED}`,
  `V(out; shell touch ${PWNED}) > 1`,
  `V(out) > 1\n+ shell touch ${PWNED}`,
  `shell touch ${PWNED}`,
  `source /etc/passwd`,
  `V(out) between 0 and 1\nwrite /tmp/${PWNED} v(out)`,
];

test(`a hostile assertion cannot smuggle a .control command (${HOSTILE_ASSERTIONS.length} cases)`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-assert-inject-'));
  const cwdBefore = new Set(readdirSync(process.cwd()));
  try {
    for (const hostile of HOSTILE_ASSERTIONS) {
      // 1. The parser refuses it outright: the grammar is closed.
      assert.throws(
        () => parseSpiceAssertion(hostile),
        err => {
          assert.ok(err instanceof SimulationParseError, `${JSON.stringify(hostile)}: ${err}`);
          assert.equal(typeof err.code, 'string');
          return true;
        },
        `parser ACCEPTED a hostile assertion: ${JSON.stringify(hostile)}`,
      );

      // 2. The compiler produces no deck for it, so there is nothing to run.
      const c = compileSimulationDeck(RC_NETLIST, {
        analysis: 'tran 1u 6m',
        assertions: [hostile],
      });
      assert.equal(c.ok, false, `compiler ACCEPTED: ${JSON.stringify(hostile)}`);
      assert.equal(c.errors.length, 1);
      assert.ok(c.errors[0].code, 'a refusal must carry a structured code');
      assert.equal(
        (c.deck ?? '').includes('shell'),
        false,
        `the payload reached the deck: ${JSON.stringify(hostile)}`,
      );

      // 3. The whole path refuses it, with a reason, and never runs ngspice.
      const out = await verifySimulation(RC_NETLIST, {
        analysis: 'tran 1u 6m',
        assertions: [hostile],
      });
      assert.equal(out.run, null, `ngspice was STARTED for: ${JSON.stringify(hostile)}`);
      assert.equal(out.results.length, 1);
      assert.equal(out.results[0].verdict, 'NOT_CHECKED');
      assert.ok(out.results[0].reason_code);
      assertContractShape(out.results);
    }

    // Nothing anywhere was written.
    for (const where of [dir, tmpdir(), process.cwd()]) {
      assert.equal(existsSync(join(where, PWNED)), false, `${PWNED} appeared in ${where}`);
    }
    const created = readdirSync(process.cwd()).filter(f => !cwdBefore.has(f));
    assert.deepEqual(created, [], `files appeared in the working directory: ${created.join(', ')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the payload is live on this machine, so the test above proves something', async () => {
  // Positive control, matching the worker suite: the same text that a hostile
  // assertion tries to reach really does execute when ngspice sees it.
  const dir = await mkdtemp(join(tmpdir(), 'kinux-assert-control-'));
  try {
    await writeFile(
      join(dir, 'evil.cir'),
      `evil\nV1 in 0 DC 1\nR1 in 0 1k\n.op\n.control\nshell touch ${PWNED}\nrun\n.endc\n.end\n`,
      'utf8',
    );
    const { spawn } = await import('node:child_process');
    await new Promise(resolve => {
      const c = spawn('ngspice', ['-b', 'evil.cir'], { cwd: dir, shell: false, stdio: 'ignore' });
      c.on('close', resolve);
      c.on('error', resolve);
    });
    const after = await readdir(dir);
    assert.ok(
      after.includes(PWNED),
      `positive control failed: ngspice did not execute the payload, so the injection test proves nothing (${after.join(', ')})`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hand-built assertion object cannot bypass the target allowlist', () => {
  // Nothing in the module trusts that an assertion came from the parser.
  const forged = {
    raw: 'forged',
    line: 1,
    at: null,
    measurable: { kind: 'voltage', target: `out)\n.endc\nshell touch ${PWNED}\n.control\nv(out` },
    comparator: { kind: 'greater-than', bound: { raw: '1', value: 1, unit: '' } },
  };
  assert.throws(
    () => compileSpiceAssertion(forged, parseAnalysis('tran 1u 6m'), 'k1'),
    err => (assert.equal(err.code, 'invalid_target'), true),
  );
  const c = compileSimulationDeck(RC_NETLIST, { analysis: 'tran 1u 6m', assertions: [forged] });
  assert.equal(c.ok, false);
  assert.equal(c.errors[0].code, 'invalid_target');
  assert.equal((c.deck ?? '').includes('shell'), false);
});

test('a hostile netlist is still blocked when assertions are compiled onto it', async () => {
  const hostile = `evil
V1 in 0 PWL(0 0 1n 1)
R1 in out 1k
C1 out 0 1u
.control
shell touch ${PWNED}
.endc
.end
`;
  const c = compileSimulationDeck(hostile, {
    analysis: 'tran 1u 6m',
    assertions: ['V(out) at 1m > 0.5'],
  });
  assert.equal(c.ok, false, 'the sanitizer must reject the assembled deck');
  assert.ok(c.violations.some(v => v.code === 'denied_command'), JSON.stringify(c.violations));
  assert.equal(c.reason_code, 'netlist_unsupported');

  const out = await verifySimulation(hostile, {
    analysis: 'tran 1u 6m',
    assertions: ['V(out) at 1m > 0.5'],
  });
  assert.equal(out.run, null, 'ngspice must not be started on a rejected deck');
  assert.equal(out.results[0].verdict, 'NOT_CHECKED');
  assert.equal(out.results[0].reason_code, 'netlist_unsupported');
  assert.match(out.results[0].reason, /sanitizer/);
  assertContractShape(out.results);
  assert.equal(existsSync(join(process.cwd(), PWNED)), false);
});

test('evaluateAssertion refuses to decide without a run', () => {
  const assertion = parseSpiceAssertion('V(out) > 1');
  const r = evaluateAssertion(null, { measure: 'k1', min: 1, assertion, name: 'k1' }, { test_id: 't' });
  assert.equal(r.verdict, 'ERROR');
  assert.equal(r.reason_code, 'tool_error');
  assertContractShape([r]);
});
