// The Villain: faults proposed in a closed grammar, judged by the real check
// suite, with harm measured by ngspice. Every number here is worked out by hand
// for the demo board (engine/fixtures/divider-rc.cir: 5 V, R1 = R2 = 10k, R3
// 1k to `out`, RL 100k), so a harm figure is checked, not trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSuite } from '../engine/cli.mjs';
import { createVillain, replayVillain, harmOf, HARMFUL } from '../engine/villain.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = join(ROOT, 'engine', 'fixtures', 'divider-rc.cir');
const WEAK = join(ROOT, 'engine', 'fixtures', 'checks-weak.md');
const THOROUGH = join(ROOT, 'engine', 'fixtures', 'checks-thorough.md');
const netlist = readFileSync(DESIGN, 'utf8');
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/** V(out) of the demo board, by hand: R2 parallel with (R3 + RL), then the R3/RL divider. */
function vout({ r1 = 10e3, r2 = 10e3, r3 = 1e3, rl = 100e3, shunt = Infinity } = {}) {
  const rlEff = 1 / (1 / rl + 1 / shunt);
  const bottom = 1 / (1 / r2 + 1 / (r3 + rlEff));
  const mid = 5 * bottom / (r1 + bottom);
  return { mid, out: mid * rlEff / (r3 + rlEff) };
}

test('a short the weak suite cannot see survives, with the harm ngspice measures matching the hand answer', async () => {
  const v = createVillain({ netlist, suite: loadSuite(WEAK) });
  const r = await v.inject({ kind: 'short', a: 'out', b: '0', ohms: 1000 });
  assert.equal(r.status, 'survived', r.why);
  const base = vout(), hit = vout({ shunt: 1000 });
  const want = Math.abs(hit.out - base.out) / base.out;
  assert.ok(rel(r.harm, want) < 1e-5, `harm ${r.harm}, by hand ${want}`);
  assert.equal(r.evidence[0].vector, 'v(out)');
  assert.equal(r.harmful, true);
  const rep = v.report();
  assert.deepEqual(rep.missed_harmful.map(x => x.id), [r.id]);
});

test('the same fault is caught by the thorough suite, by the check that measures it', async () => {
  const v = createVillain({ netlist, suite: loadSuite(THOROUGH) });
  const r = await v.inject({ kind: 'value', ref: 'R2', factor: 0.5 });
  assert.equal(r.status, 'killed', r.why);
  assert.ok(r.killed_by.some(id => /:11:/.test(id)), `V(mid) (line 11) catches it: ${r.killed_by}`);
  const base = vout(), hit = vout({ r2: 5e3 });
  assert.ok(rel(r.harm, Math.abs(hit.mid - base.mid) / base.mid) < 1e-3, `harm ${r.harm}`);
});

test('harm is only measured under the suite\'s own analyses: a capacitor change is harmless at DC, and said so', async () => {
  const v = createVillain({ netlist, suite: loadSuite(WEAK) });
  const r = await v.inject({ kind: 'value', ref: 'C2', factor: 10 });
  assert.equal(r.status, 'survived');
  assert.ok(r.harm < 1e-6, `DC cannot see C2: ${r.harm}`);
  assert.equal(r.harmful, false);
  assert.deepEqual(v.report().missed_low_harm.map(x => x.id), [r.id]);
  // Under the thorough suite's transient, the same fault does change behaviour.
  const t = createVillain({ netlist, suite: loadSuite(THOROUGH) });
  const rt = await t.inject({ kind: 'value', ref: 'C2', factor: 10 });
  assert.ok(rt.harm > HARMFUL, `the transient sees C2 ×10: ${rt.harm}`);
});

test('the grammar refuses what it cannot apply, and nothing is tried twice', async () => {
  const v = createVillain({ netlist, suite: loadSuite(WEAK) });
  const refused = [
    [{ kind: 'melt', ref: 'R1' }, /unknown fault kind/],
    [{ kind: 'value', ref: 'R9', factor: 2 }, /no part "R9"/],
    [{ kind: 'value', ref: 'R1', factor: 1 }, /factor/],
    [{ kind: 'value', ref: 'R1', factor: 1e6 }, /factor/],
    [{ kind: 'open', ref: 'R1', pin: 3 }, /pins 1\.\.2/],
    [{ kind: 'short', a: 'mid', b: 'mid' }, /two different nets/],
    [{ kind: 'short', a: 'nowhere', b: '0' }, /no net "nowhere"/],
    [{ kind: 'operator', operator: 'value_drift_5', target: 'Z1' }, /no target/],
  ];
  for (const [f, why] of refused) await assert.rejects(v.inject(f), why, JSON.stringify(f));
  assert.equal(v.log.length, 0, 'a refusal is not a tried fault');
  await v.inject({ kind: 'operator', operator: 'value_drift_10', target: 'R1' });
  await assert.rejects(v.inject({ kind: 'value', ref: 'R1', factor: 1.1 }), /same faulted circuit as V1/);
});

test('harm features: a transient shifted in time is not harmed; a changed level is', () => {
  const t = Array.from({ length: 401 }, (_, i) => i * 1e-5);
  const sq = shift => t.map(x => (Math.floor((x + shift) / 1e-3) % 2 ? 5 : 0));
  const vec = y => ({ min: Math.min(...y), max: Math.max(...y), mean: y.reduce((a, b) => a + b) / y.length, y, t });
  const base = [{ prefix: 'b0', ok: true, vectors: { 'v(x)': vec(sq(0)) } }];
  assert.ok(harmOf(base, [{ prefix: 'b0', ok: true, vectors: { 'v(x)': vec(sq(2e-4)) } }]).harm < 0.1, 'a phase shift is not harm');
  const halved = vec(sq(0).map(y => y / 2));
  assert.ok(harmOf(base, [{ prefix: 'b0', ok: true, vectors: { 'v(x)': halved } }]).harm >= 0.5);
  const failed = harmOf(base, [{ prefix: 'b0', ok: false, reason_code: 'sim_nonconverge' }]);
  assert.equal(failed.harm, null, 'a fault the solver could not run has no harm figure');
  assert.deepEqual(failed.unmeasured, ['b0: sim_nonconverge']);
});

test('element modes cover every way one part can fail, and parallel agents never run the same fault twice', async () => {
  const { elementModes, observers } = await import('../engine/villain.mjs');
  const { parseNetlist } = await import('../engine/netlist.mjs');
  const { normaliseSuite } = await import('../engine/runner.mjs');
  const nl = parseNetlist(netlist);
  const modes = elementModes(nl, 'R3');
  assert.deepEqual(modes.filter(m => m.kind === 'value').map(m => m.factor), [0.1, 0.5, 0.9, 1.1, 2, 10]);
  assert.deepEqual(modes.filter(m => m.kind === 'open').map(m => m.pin), [1, 2]);
  const shorts = modes.filter(m => m.kind === 'short').map(m => `${m.a}-${m.b}`);
  for (const s of ['mid-out', 'mid-0', 'out-0', 'mid-vcc']) assert.ok(shorts.includes(s), `${s} in ${shorts}`);
  assert.deepEqual(observers(nl, normaliseSuite(loadSuite(THOROUGH)), 'R3').map(o => o.how).sort(), ['on its net mid', 'on its net out', 'on its net out', 'on its net out']);
  const v = createVillain({ netlist, suite: loadSuite(WEAK) });
  const out = await Promise.allSettled([1, 2, 3].map(() => v.inject({ kind: 'value', ref: 'R3', factor: 10 }, { agent: 'R3' })));
  assert.equal(out.filter(o => o.status === 'fulfilled').length, 1, 'three agents, one fault: solved once');
  assert.ok(out.filter(o => o.status === 'rejected').every(o => /same faulted circuit/.test(o.reason.message)));
  // The same bridge proposed by two agents, either way round, is one circuit (the live team ran one short 4 times before this).
  await v.inject({ kind: 'short', a: 'mid', b: 'out', ohms: 10 }, { agent: 'R3' });
  await assert.rejects(v.inject({ kind: 'short', a: 'out', b: 'mid', ohms: 10 }, { agent: 'RL' }), /same faulted circuit/);
  await v.inject({ kind: 'open', ref: 'C2', pin: 1 }, { agent: 'C2' });
  await assert.rejects(v.inject({ kind: 'operator', operator: 'open_connection', target: 'C2.0' }, { agent: 'lead' }), /same faulted circuit/);
  const rep = v.report();
  assert.equal(rep.per_element.R3.tried, 2);
  assert.ok(rep.untouched.includes('C1'), rep.untouched.join(','));
});

test('floating nets are never evidence: not on the baseline, and not as a raw number under a fault', async () => {
  const { plausibleVoltage } = await import('../engine/villain.mjs');
  assert.equal(plausibleVoltage(netlist, { sources: [] }), 500, 'the 5 V source, times the margin');
  assert.equal(plausibleVoltage(netlist, { sources: [{ port: 'x', value: { value: 12 } }] }), 1200);
  // As on quiet-orbit's CC-only block: the baseline itself floats at -8.7e7 V.
  const base = [{ prefix: 'b3', ok: true, bound: 500, vectors: { 'v(VBUS)': { dc: -86921839.3, floating: true }, 'v(CC1)': { dc: 5 } } }];
  const hit = harmOf(base, [{ prefix: 'b3', ok: true, vectors: { 'v(VBUS)': { dc: 2.4e-18 }, 'v(CC1)': { dc: 5 } } }]);
  assert.equal(hit.harm, 0, 'the floating net is not harm');
  assert.match(hit.unmeasured[0], /float on the baseline/);
  // A fault that leaves a well-defined net floating: changed, recorded as such, at 100% rather than its raw value.
  const ok = [{ prefix: 'b0', ok: true, bound: 500, vectors: { 'v(out)': { dc: 2.4 } } }];
  const fl = harmOf(ok, [{ prefix: 'b0', ok: true, vectors: { 'v(out)': { dc: -3e7 } } }]);
  assert.equal(fl.harm, 1);
  assert.equal(fl.top[0].feature, 'floats under the fault');
  assert.equal(fl.top[0].faulted, null);
});

test('a villain log replays with no model, record for record', async () => {
  const opts = { netlist, suite: loadSuite(THOROUGH) };
  const v = createVillain(opts);
  for (const f of [{ kind: 'value', ref: 'R3', factor: 3 }, { kind: 'open', ref: 'RL', pin: 2 }, { kind: 'short', a: 'mid', b: 'out', ohms: 10 }]) await v.inject(f);
  const again = await replayVillain(opts, JSON.parse(JSON.stringify(v.log)));
  assert.deepEqual(again.map(x => x.same), [true, true, true]);
});

test('MCP: --role villain lists only the villain tools, injects through Kinux, and a refusal is a tool error', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'kinux-villain-')), 'villain.jsonl');
  const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs'), '--role', 'villain', '--design', DESIGN, '--checks', WEAK, '--villain-log', log],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '', next = 1;
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise(res => { const id = next++; waiters.set(id, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.match(init.result.instructions, /You are the Villain/);
    const list = await rpc('tools/list', {});
    assert.deepEqual(list.result.tools.map(t => t.name), ['kinux_villain_plan', 'kinux_villain_brief', 'kinux_inject_fault', 'kinux_villain_report']);
    const plan = (await rpc('tools/call', { name: 'kinux_villain_plan', arguments: {} })).result.structuredContent;
    assert.deepEqual(plan.elements.filter(e => e.unobserved).map(e => e.ref), ['R2', 'R3', 'C2', 'RL'], 'the weak suite looks only at vcc');
    const one = (await rpc('tools/call', { name: 'kinux_villain_brief', arguments: { ref: 'R3' } })).result.structuredContent;
    assert.equal(one.element.ref, 'R3');
    assert.deepEqual(one.observed_by, []);
    assert.ok(one.modes.some(m => m.kind === 'open' && m.pin === 2) && one.modes.some(m => m.kind === 'short' && m.a === 'mid' && m.b === 'out'));
    const brief = (await rpc('tools/call', { name: 'kinux_villain_brief', arguments: {} })).result.structuredContent;
    assert.ok(brief.parts.some(p => p.ref === 'R2') && brief.nets.some(n => n.net === 'out'));
    assert.equal(brief.checks.length, 1);
    const hit = (await rpc('tools/call', { name: 'kinux_inject_fault', arguments: { kind: 'short', a: 'out', b: '0', ohms: 1000, agent: 'RL' } })).result;
    assert.equal(hit.isError, false);
    assert.equal(hit.structuredContent.agent, 'RL', 'the fault is attributed to the agent that injected it');
    assert.equal(hit.structuredContent.status, 'survived');
    const bad = (await rpc('tools/call', { name: 'kinux_inject_fault', arguments: { kind: 'value', ref: 'R9', factor: 2 } })).result;
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error, 'refused');
    const sneaky = (await rpc('tools/call', { name: 'kinux_inject_fault', arguments: { kind: 'value', ref: 'R1', factor: 2, status: 'killed' } })).result;
    assert.equal(sneaky.isError, true, 'no argument can carry a result');
    const start = await rpc('tools/call', { name: 'kinux_start_run', arguments: {} });
    assert.ok(start.error, 'a villain cannot start runs');
    const rep = (await rpc('tools/call', { name: 'kinux_villain_report', arguments: {} })).result.structuredContent;
    assert.equal(rep.tried, 1);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'the server logs every accepted fault');
  } finally { child.kill(); }
});
