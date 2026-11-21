// The lumped thermal worker, run for real.
//
// Every electrical number here (the current through a resistor) is measured by
// the real ngspice binary through workers/ngspice/. The thermal numbers are then
// checked against hand calculations written out in the comments. Nothing is
// stubbed.
//
// Model under test: lumped steady-state (and first-order transient), ONE-WAY
// electrical -> thermal coupling. Temperature does not feed back into R.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseThermalAssertion, parseThermalBlocks, verifyThermal, ThermalParseError, resistorValue,
} from '../workers/thermal/assertions.mjs';
import {
  powerI2R, steadyRise, steadyTemperature, transientTemperature, timeConstant, componentThermal,
  MODEL_STEADY, MODEL_TRANSIENT,
} from '../workers/thermal/model.mjs';
import { parseSimulationBlocks } from '../workers/ngspice/assertions.mjs';
import { runVerification } from '../engine/runner.mjs';
import { buildReport, finishRun } from '../engine/report.mjs';
import { main } from '../engine/cli.mjs';
import { validateEvent, checkRun } from '../contracts/check-run.mjs';
import { MUTANTS, applyMutant } from '../examples/phase-leg-support/mutants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = join(HERE, '..', 'examples', 'phase-leg-support');
const NETLIST = await readFile(join(EX, 'phase-leg-support.cir'), 'utf8');
const MODEL = JSON.parse(await readFile(join(EX, 'thermal-model.json'), 'utf8'));
const THERMAL_MD = await readFile(join(EX, 'checks-thermal.md'), 'utf8');
const THERMAL_BLOCKS = parseThermalBlocks(THERMAL_MD);
const M4 = MUTANTS.find(m => m.id === 'M4-shunt-10x');
const M4_TEXT = applyMutant(NETLIST, M4);

const close = (a, b, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
const one = async (assertion, { netlist = NETLIST, model = MODEL, subject = 'baseline' } = {}) =>
  (await verifyThermal(netlist, { assertions: [assertion] }, model, { subject })).results[0];

/* -------------------------------------------------------------------------- */
/* 1. Hand calculations                                                       */
/* -------------------------------------------------------------------------- */

test('hand: P = I²R, ΔT = P·Rθ, series chain, and T(τ) = 63.2 % of the final rise', () => {
  // P = I²R: 20 A through 2 mΩ -> 400 × 0.002 = 0.8 W. Sign of I is irrelevant.
  assert.ok(close(powerI2R(20, 0.002), 0.8));
  assert.ok(close(powerI2R(-20, 0.002), 0.8));
  // ΔT = P·Rθ: 0.8 W × 50 K/W = 40 K; T = 40 °C + 40 K = 80 °C.
  assert.ok(close(steadyRise(0.8, 50), 40));
  assert.ok(close(steadyTemperature(40, 0.8, 50), 80));
  // Series chain Rθjc + Rθcs + Rθsa = 1.2 + 0.5 + 3.3 = 5.0 K/W; 10 W -> 50 K.
  const th = componentThermal({
    ambient_c: { value: 25, source: 'assumed: lab bench' },
    components: { Q2: { rth_chain: [
      { name: 'jc', value: 1.2, source: 'datasheet: illustrative' },
      { name: 'cs', value: 0.5, source: 'datasheet: illustrative pad' },
      { name: 'sa', value: 3.3, source: 'design_rule: heatsink sized for 3.3 K/W' },
    ] } },
  }, 'Q2');
  assert.ok(close(th.rth.value, 5.0));
  assert.ok(close(steadyTemperature(th.ambient.value, 10, th.rth.value), 75)); // 25 + 10 × 5
  // Transient: τ = Rθ·Cθ = 50 K/W × 0.1 J/K = 5 s. At t = τ the rise is
  // P·Rθ·(1 − e⁻¹) = 40 K × 0.63212 = 25.285 K, i.e. 63.2 % of the final 40 K.
  const tau = timeConstant(50, 0.1);
  assert.ok(close(tau, 5));
  const rise = transientTemperature(40, 0.8, 50, 0.1, tau) - 40;
  assert.ok(close(rise / 40, 1 - Math.exp(-1)));
  assert.equal(Number((rise / 40).toFixed(3)), 0.632);
  // Limits: t ≤ 0 is ambient; t = 10 τ is within 0.005 % of steady state.
  assert.equal(transientTemperature(40, 0.8, 50, 0.1, 0), 40);
  assert.ok(Math.abs(transientTemperature(40, 0.8, 50, 0.1, 50) - 80) < 0.005);
});

test('real ngspice: shunt P = (20 A)² × 2 mΩ = 0.8 W and T = 40 + 0.8 × 50 = 80 °C', async () => {
  const p = await one('P(RSH) < rated');
  assert.equal(p.verdict, 'PASS', p.reason);
  // ngspice measured the current; ISRC is an ideal 20 A source, so |I| = 20 A.
  assert.ok(close(Math.abs(p.working.current_a), 20, 1e-6), `I = ${p.working.current_a}`);
  assert.ok(close(p.measured, 0.8, 1e-6), `P = ${p.measured}`);
  assert.equal(p.limit, 2);
  assert.equal(p.units, 'W');

  const t = await one('T(RSH) < 125');
  assert.equal(t.verdict, 'PASS');
  assert.ok(close(t.measured, 80, 1e-6), `T = ${t.measured}`);
  assert.equal(t.units, '°C');
  assert.equal(t.limit, 125);
  assert.ok(t.reason.startsWith(MODEL_STEADY), 'the model is named in reason on a PASS');
  assert.match(t.reason, /does not feed back into resistance/);
});

test('real ngspice: divider top leg, a current nobody typed in', async () => {
  // I(RFB1) = 48 V / (100 kΩ + 4.99 kΩ) = 457.19 µA.
  // P = I²R = (457.19e-6)² × 100e3 = 2.0902e-7 × 1e5 = 20.902 mW.
  // T = 40 + 0.020902 × 680 = 54.213 °C.
  const p = await one('P(RFB1) < 125m');
  const iHand = 48 / 104.99e3;
  assert.ok(close(Math.abs(p.working.current_a), iHand, 1e-4), `I = ${p.working.current_a}, hand ${iHand}`);
  assert.ok(close(p.measured, iHand * iHand * 100e3, 1e-4));
  assert.ok(close(p.measured, 0.020902, 1e-4));
  const t = await one('T(RFB1) < rated');
  assert.ok(close(t.measured, 40 + 0.020902 * 680, 1e-4), `T = ${t.measured}`);
  assert.equal(t.verdict, 'PASS');
});

test('real ngspice: transient at t = τ is 63.2 % of the rise, through the grammar', async () => {
  // RSH: τ = 50 × 0.1 = 5 s. T(5 s) = 40 + 40 × (1 − e⁻¹) = 40 + 25.285 = 65.285 °C.
  const r = await one('T(RSH) at 5 < 75');
  assert.equal(r.verdict, 'PASS');
  assert.ok(close(r.measured, 40 + 40 * (1 - Math.exp(-1)), 1e-6), `T(τ) = ${r.measured}`);
  assert.ok(close((r.measured - 40) / (80 - 40), 0.63212, 1e-4));
  assert.ok(r.reason.startsWith(MODEL_TRANSIENT));
  assert.ok(close(r.working.tau_s, 5));
});

test('real ngspice: a series Rθ chain is summed (RG: 300 + 380 = 680 K/W)', async () => {
  // I(RG) = 12 V / (10 Ω + 10 kΩ) = 1.1988 mA; P = I² × 10 = 14.37 µW;
  // T = 40 + 14.37e-6 × 680 = 40.00977 °C.
  const r = await one('T(RG) < rated');
  assert.equal(r.verdict, 'PASS');
  assert.ok(close(r.working.rth_c_per_w, 680));
  const i = 12 / 10010;
  assert.ok(close(r.measured, 40 + i * i * 10 * 680, 1e-5), `T = ${r.measured}`);
});

test('the netlist value is read from the netlist under test, so a mutant is seen', () => {
  assert.equal(resistorValue(NETLIST, 'RSH').value, 0.002);
  assert.equal(resistorValue(M4_TEXT, 'RSH').value, 0.02);
  assert.equal(resistorValue(NETLIST, 'RNOPE').ok, false);
});

/* -------------------------------------------------------------------------- */
/* 2. Missing thermal data: NOT_CHECKED / no_material_data, never a guess     */
/* -------------------------------------------------------------------------- */

test('missing thermal data is NOT_CHECKED with no_material_data, never a pass', async () => {
  // RF has no entry in the model at all.
  const rf = await one('T(RF) < 125');
  assert.equal(rf.verdict, 'NOT_CHECKED');
  assert.equal(rf.reason_code, 'no_material_data');
  assert.equal(rf.measured, undefined, 'no number is invented');
  assert.match(rf.reason, /no entry for RF/);

  // No model supplied for the design.
  const none = await one('T(RSH) < 125', { model: null });
  assert.equal(none.reason_code, 'no_material_data');
  // `< rated` for P needs a sourced power rating.
  assert.equal((await one('P(RSH) < rated', { model: null })).reason_code, 'no_material_data');

  // A transient needs Cθ; RFB1 has none.
  const tr = await one('T(RFB1) at 1 < 125');
  assert.equal(tr.reason_code, 'no_material_data');
  assert.match(tr.reason, /thermal capacitance/);

  // A value without a source is not used.
  const unsourced = { ambient_c: { value: 40, source: 'assumed: x' }, components: { RSH: { rth_c_per_w: { value: 50 } } } };
  const u = await one('T(RSH) < 125', { model: unsourced });
  assert.equal(u.verdict, 'NOT_CHECKED');
  assert.equal(u.reason_code, 'no_material_data');
  assert.match(u.reason, /has no source/);

  // A source with an unknown kind is not a source.
  const vague = { ambient_c: { value: 40, source: 'trust me: 40' }, components: { RSH: { rth_c_per_w: { value: 50, source: 'assumed: y' } } } };
  assert.equal((await one('T(RSH) < 125', { model: vague })).reason_code, 'no_material_data');

  // A non-resistor has no I²R here: out of scope, not a guess.
  const e = await one('T(EAMP) < 125');
  assert.equal(e.verdict, 'NOT_CHECKED');
  assert.equal(e.reason_code, 'out_of_scope');
});

test('a resistor that does not exist is NOT_CHECKED, not a FAIL', async () => {
  const model = { ...MODEL, components: { ...MODEL.components, RGHOST: MODEL.components.RSH } };
  const r = await one('T(RGHOST) < 125', { model });
  assert.equal(r.verdict, 'NOT_CHECKED');
  assert.equal(r.reason_code, 'netlist_unsupported');
});

/* -------------------------------------------------------------------------- */
/* 3. Hostile and malformed assertions are refused with a structured reason   */
/* -------------------------------------------------------------------------- */

test('hostile or malformed thermal assertions are refused with a structured code', async () => {
  const cases = [
    ['T(RSH;shell rm -rf /) < 125', 'invalid_assertion'],
    ['T(RSH)) < 125', 'invalid_assertion'],
    ['T(../etc) < 125', 'invalid_target'],
    ['T(RSH[i]) < 125', 'invalid_target'],
    ['T(RSH) < 125 ; .shell ls', 'invalid_comparator'],
    ['T(RSH) < 1e999', 'number_out_of_range'],
    ['T(RSH) < 125W', 'unit_not_for_measurable'],
    ['P(RSH) < 2C', 'unit_not_for_measurable'],
    ['T(RSH) at 5min < 75', 'unit_not_for_measurable'],
    ['T(RSH) at -1 < 75', 'invalid_time'],
    ['P(RSH) at 5 < 2', 'at_not_supported'],
    ['T(RSH) > rated', 'invalid_comparator'],
    ['T(RSH) between 130 and 120', 'bounds_not_ordered'],
    ['V(sh) < 50m', 'invalid_assertion'],
    ['T(RSH) < `cat /etc/passwd`', 'invalid_comparator'],
    ['T(RSH) < $(id)', 'invalid_number'],
  ];
  for (const [raw, code] of cases) {
    assert.throws(() => parseThermalAssertion(raw, 7), err => err instanceof ThermalParseError && err.code === code && err.line === 7,
      `${raw} should be refused as ${code}`);
  }
  // Through the worker: a NOT_CHECKED result with a reason_code, not a dropped line.
  const { results } = await verifyThermal(NETLIST, { assertions: cases.map(c => c[0]) }, MODEL);
  assert.equal(results.length, cases.length);
  for (const [i, r] of results.entries()) {
    assert.equal(r.verdict, 'NOT_CHECKED');
    assert.equal(r.reason_code, 'netlist_unsupported');
    assert.equal(r.refusal_code, cases[i][1]);
  }
});

test('a Thermal block refuses raw solver lines, unknown fields and non-op analyses', () => {
  const bad = [
    ['## Thermal\n\n.control\nassert: T(RSH) < 125\n', 'raw_statement_not_allowed'],
    ['## Thermal\n\n.shell rm -rf /\n', 'raw_statement_not_allowed'],
    ['## Thermal\n\nexec: rm -rf /\nassert: T(RSH) < 125\n', 'unknown_field'],
    ['## Thermal\n\nanalysis: tran 1u 1m\nassert: T(RSH) < 125\n', 'unsupported_analysis'],
    ['## Thermal\n\nanalysis: op\n', 'no_assertions'],
    ['## Thermal\n\nscope: parts R;S\nassert: T(RSH) < 125\n', 'invalid_scope'],
  ];
  for (const [md, code] of bad) {
    assert.throws(() => parseThermalBlocks(md), err => err instanceof ThermalParseError && err.code === code, code);
  }
  // Fenced code and comments are not live input.
  assert.equal(parseThermalBlocks('```\n## Thermal\nassert: T(X) < 1\n```\n<!--\n## Thermal\n-->\n').length, 0);
  // Simulation blocks are ignored by the thermal parser and vice versa.
  assert.equal(parseSimulationBlocks(THERMAL_MD).length, 0);
});

/* -------------------------------------------------------------------------- */
/* 4. Baseline, contract shape                                                */
/* -------------------------------------------------------------------------- */

test('baseline: every check in checks-thermal.md PASSES on the real design', async () => {
  assert.equal(THERMAL_BLOCKS.length, 1);
  const { results } = await verifyThermal(NETLIST, THERMAL_BLOCKS[0], MODEL);
  assert.equal(results.length, 7);
  for (const r of results) {
    assert.equal(r.verdict, 'PASS', `${r.assertion}: ${r.reason}`);
    assert.equal(r.layer, 'thermal');
    assert.equal(typeof r.measured, 'number');
    assert.equal(typeof r.limit, 'number');
    assert.ok(['°C', 'W'].includes(r.units));
    assert.ok(r.reason.startsWith('lumped '), 'the model is named on every result');
  }
});

test('thermal results validate as contract test.result events', async () => {
  const { results } = await verifyThermal(NETLIST, { assertions: [...THERMAL_BLOCKS[0].assertions.map(a => a.raw), 'T(RF) < 125', 'T(RSH;x) < 1'] }, MODEL);
  for (const [seq, r] of results.entries()) {
    const ev = {
      v: 1, run_id: 'thermal-test', seq, ts: new Date().toISOString(), type: 'test.result',
      actor: { kind: 'solver', id: 'thermal-worker' }, design_hash: 'sha256:' + 'd'.repeat(64), provenance: 'real',
      data: { test_id: r.test_id, subject: r.subject, verdict: r.verdict,
        ...Object.fromEntries(['measured', 'limit', 'units', 'reason_code', 'reason'].filter(k => r[k] !== undefined).map(k => [k, r[k]])) },
    };
    const { ok, errors } = validateEvent(ev);
    assert.ok(ok, `${r.assertion}: ${errors.join('; ')}`);
  }
  assert.ok(results.some(r => r.verdict === 'NOT_CHECKED' && r.reason_code === 'no_material_data'));
});

/* -------------------------------------------------------------------------- */
/* 5. Engine: M4 is killed by a thermal check, with baseline gating           */
/* -------------------------------------------------------------------------- */

const handMutants = ids => MUTANTS.filter(m => ids.includes(m.id)).map(m => ({
  mutant_id: m.id, description: m.label, target: m.find.split(/\s+/)[0], text: applyMutant(NETLIST, m),
}));

test('engine: M4 (shunt 2 mΩ -> 20 mΩ) is KILLED by thermal checks alone', async () => {
  // Hand: P = (20 A)² × 20 mΩ = 8 W > 2 W rating; T = 40 + 8 × 50 = 440 °C > 125 °C;
  // T(5 s) = 40 + 400 × 0.632 = 292.8 °C > 75 °C.
  const outcome = await runVerification({
    netlist: NETLIST, suite: { id: 'thermal', blocks: THERMAL_BLOCKS, thermalModel: MODEL },
    operators: [], extraMutants: handMutants(['M4-shunt-10x', 'M6-sense-gain']), useQueue: false, runId: 'thermal-m4',
  });
  assert.equal(outcome.baseline.blocked.length, 0, 'the thermal suite passes on the baseline');
  const m4 = outcome.mutants.find(m => m.mutant_id === 'M4-shunt-10x');
  assert.equal(m4.status, 'killed', m4.why);
  const byAssertion = Object.fromEntries(m4.results.map(r => [r.assertion, r]));
  assert.ok(close(byAssertion['P(RSH) < rated'].measured, 8, 1e-6));
  assert.ok(close(byAssertion['T(RSH) < rated'].measured, 440, 1e-6));
  assert.ok(close(byAssertion['T(RSH) at 5 < 75'].measured, 40 + 400 * (1 - Math.exp(-1)), 1e-6));
  assert.equal(m4.killed_by.length, 3);
  // A gain change dissipates nothing new: thermal honestly does not see it.
  assert.equal(outcome.mutants.find(m => m.mutant_id === 'M6-sense-gain').status, 'survived');
  assert.equal(outcome.tool_versions.thermal, 'kinux-thermal-lumped-1');

  const report = buildReport(outcome, { threshold: 0.5 });
  const events = finishRun(outcome, report);
  assert.deepEqual(checkRun(events), []);
  const queued = events.filter(e => e.type === 'test.queued');
  for (const q of queued) {
    assert.equal(q.data.layer, 'thermal');
    assert.match(q.data.title, /^[TP]\([A-Za-z0-9_]+\) /, 'title is the assertion text');
  }
  for (const r of events.filter(e => e.type === 'test.result')) {
    assert.equal(r.actor.id, 'thermal-worker');
    assert.match(r.data.reason, /^lumped .*one-way electrical→thermal coupling/);
    assert.ok(['°C', 'W'].includes(r.data.units));
  }
});

test('engine: a thermal check the baseline did not PASS can never kill', async () => {
  const blocks = parseThermalBlocks('## Thermal\n\nassert: T(RF) < 125\nassert: P(RSH) < 0.5\n');
  const outcome = await runVerification({
    netlist: NETLIST, suite: { id: 'thermal', blocks, thermalModel: MODEL },
    operators: [], extraMutants: handMutants(['M4-shunt-10x']), useQueue: false, runId: 'thermal-gate',
  });
  // Baseline: T(RF) NOT_CHECKED (no data); P(RSH) = 0.8 W FAILs `< 0.5`.
  assert.deepEqual(outcome.baseline.results.map(r => r.verdict), ['NOT_CHECKED', 'FAIL']);
  const m4 = outcome.mutants[0];
  assert.equal(m4.results[1].verdict, 'FAIL', 'M4 fails it too (8 W) ...');
  assert.notEqual(m4.status, 'killed', '... but that is not a kill');
  assert.deepEqual(m4.killed_by, []);
  const report = buildReport(outcome, { threshold: 0.5 });
  assert.ok(report.cap.gates.some(g => g.code === 'baseline_check_not_passing'));
  assert.deepEqual(checkRun(finishRun(outcome, report)), []);
});

test('measured: on this design thermal checks kill nothing the electrical suites miss', async () => {
  // All 12 engine operators (54 generated mutants) plus the six hand mutants.
  const extra = handMutants(MUTANTS.map(m => m.id));
  const el = name => parseSimulationBlocks(readFileSync(join(EX, `checks-${name}.md`), 'utf8'));
  const run = async (id, blocks) => {
    const o = await runVerification({ netlist: NETLIST, suite: { id: 'checks', blocks, thermalModel: MODEL }, extraMutants: extra, useQueue: false, runId: `thermal-cmp-${id}` });
    assert.deepEqual(checkRun(finishRun(o, buildReport(o, { threshold: 0.7 }))), []);
    return o;
  };
  const weak = await run('weak', el('weak'));
  const thermal = await run('thermal', THERMAL_BLOCKS);
  const both = await run('weak-thermal', [...el('weak'), ...THERMAL_BLOCKS]);
  const killed = o => new Set(o.mutants.filter(m => m.status === 'killed').map(m => m.mutant_id));
  const kw = killed(weak), kt = killed(thermal), kb = killed(both);
  assert.equal(weak.mutants.length, 60);
  // Thermal alone kills exactly two: M4 (shunt at 8 W) and a gate short, which
  // puts 12 V across RG: P = (12 / 10.001)² × 10 = 14.4 W against 0.125 W.
  assert.deepEqual([...kt].sort(), ['M-output_short-gate', 'M4-shunt-10x']);
  // Both are already killed by the WEAK electrical suite, so adding thermal
  // changes no kill. Thermal adds nothing over electrical here; it says it.
  for (const id of kt) assert.ok(kw.has(id), `${id} is already killed electrically`);
  assert.deepEqual([...kb].sort(), [...kw].sort());
  const gate = thermal.mutants.find(m => m.mutant_id === 'M-output_short-gate');
  const pRG = gate.results.find(r => r.assertion === 'P(RG) < rated');
  assert.ok(close(pRG.measured, (12 / 10.001) ** 2 * 10, 1e-3), `P(RG) = ${pRG.measured}`);
});

/* -------------------------------------------------------------------------- */
/* 6. CLI                                                                     */
/* -------------------------------------------------------------------------- */

test('cli: --thermal-model runs "## Thermal" blocks alongside "## Simulation" ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-thermal-'));
  try {
    const checks = join(dir, 'checks.md');
    await writeFile(checks, (await readFile(join(EX, 'checks-weak.md'), 'utf8')) + '\n' + THERMAL_MD);
    const lines = [];
    const code = await main(['verify', join(EX, 'phase-leg-support.cir'), '--checks', checks, '--thermal-model', join(EX, 'thermal-model.json'),
      '--out', join(dir, 'out'), '--limit', '4', '--no-queue', '--threshold', '0'], { log: s => lines.push(s), error: s => lines.push(s) });
    assert.equal(code, 0, lines.join('\n'));
    const events = (await readFile(join(dir, 'out', 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(checkRun(events), []);
    const layers = new Set(events.filter(e => e.type === 'test.queued').map(e => e.data.layer));
    assert.deepEqual([...layers].sort(), ['netlist', 'thermal']);
    assert.equal(events[0].data.tool_versions.thermal, 'kinux-thermal-lumped-1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

