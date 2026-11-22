// The team: decomposition into disjoint regions, leases, the five gates every
// proposed check passes through, and the integration rule: the score the team
// builds one commit at a time equals the score of a fresh, from-scratch
// mutation run on the suite it wrote. Real ngspice throughout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSimulationBlocks } from '../workers/ngspice/assertions.mjs';
import { createTeam, decompose } from '../engine/team.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Two independent dividers on one rail: two natural regions meeting at vcc.
const NET = ['two channels', 'V1 vcc 0 5', 'R1 vcc a 1k', 'R2 a 0 1k', 'R3 vcc b 2k', 'R4 b 0 1k', ''].join('\n');
const WEAK = { id: 'checks', blocks: parseSimulationBlocks('## Simulation\n\nscope: nets [vcc]\nanalysis: op\nassert: V(vcc) between 4 and 6\n') };

test('decomposition: every part in exactly one region; rails are interfaces, owned by no region', () => {
  const d = decompose(NET, { k: 6 });
  const all = d.regions.flatMap(r => r.parts).sort();
  assert.deepEqual(all, ['R1', 'R2', 'R3', 'R4', 'V1'], 'complete and disjoint');
  const of = ref => d.regions.find(r => r.parts.includes(ref)).id;
  assert.equal(of('R1'), of('R2'));
  assert.equal(of('R3'), of('R4'));
  assert.notEqual(of('R1'), of('R3'), 'channels joined only through the rail stay apart');
  assert.deepEqual(d.interfaces, ['vcc']);
  assert.equal(d.netOwner.get('a'), of('R1'));
  const merged = decompose(NET, { k: 2 });
  assert.equal(merged.regions.length, 2);
  assert.deepEqual(merged.regions.flatMap(r => r.parts).sort(), all, 'merging keeps every part, once');
});

test('leases: one agent per region, and a check needs the lease of the region that owns what it measures', async () => {
  const t = createTeam({ netlist: NET, suite: WEAK });
  const d = t.decomposition;
  const A = d.regionOf.get('R1'), B = d.regionOf.get('R3');
  const { lease: la } = await t.claim(A, 'alpha');
  await assert.rejects(t.claim(A, 'beta'), /already leased to alpha/);
  const { lease: lb } = await t.claim(B, 'beta');
  const cross = await t.propose({ region: A, lease: la, block: 'b0', check: 'V(b) between 1.6 and 1.7' });
  assert.equal(cross.code, 'not_yours', 'alpha cannot add a check in beta\'s region');
  const stolen = await t.propose({ region: B, lease: la, block: 'b0', check: 'V(b) between 1.6 and 1.7' });
  assert.equal(stolen.code, 'no_lease', 'nor with its own lease under beta\'s name');
  const rail = await t.propose({ region: A, lease: la, block: 'b0', check: 'V(vcc) between 4.9 and 5.1' });
  assert.equal(rail.code, 'not_yours', 'the rail is an interface: the lead\'s');
  const ok = await t.propose({ region: B, lease: lb, block: 'b0', check: 'V(b) between 1.6 and 1.7' });
  assert.equal(ok.status, 'committed', ok.reason);
});

test('the gates: grammar, design must pass, must catch a survivor, no duplicates', async () => {
  const t = createTeam({ netlist: NET, suite: WEAK });
  const A = t.decomposition.regionOf.get('R1');
  const { lease } = await t.claim(A);
  const p = check => t.propose({ region: A, lease, block: 'b0', check });
  assert.equal((await p('V(a) roughly 2.5')).code, 'grammar');
  const fails = await p('V(a) between 3 and 4');
  assert.equal(fails.code, 'fails_design');
  assert.equal(fails.measured, 2.5, 'and says what the design measures');
  assert.equal((await p('V(a) between -100 and 100')).code, 'catches_nothing');
  assert.equal((await t.propose({ region: A, lease, block: 'b9', check: 'V(a) between 2 and 3' })).code, 'no_block');
  const c = await p('V(a) between 2.45 and 2.55');
  assert.equal(c.status, 'committed');
  assert.ok(c.kills.length > 0 && c.global_after > c.global_before);
  assert.equal((await p('V(a) between 2.45 and 2.55')).code, 'duplicate');
});

test('integration: two regions working at once build the same score a fresh run of their suite gives', async () => {
  const t = createTeam({ netlist: NET, suite: WEAK });
  const d = t.decomposition;
  const A = d.regionOf.get('R1'), B = d.regionOf.get('R3');
  const [{ lease: la }, { lease: lb }] = await Promise.all([t.claim(A, 'alpha'), t.claim(B, 'beta')]);
  // Both agents propose at the same moment; the queue judges them one after another.
  const out = await Promise.all([
    // A loose check first (catches gross faults, not a 5% drift), then a tight one that has drifts left to catch.
    t.propose({ region: A, lease: la, block: 'b0', check: 'V(a) between 2 and 3', agent: 'alpha' }),
    t.propose({ region: B, lease: lb, block: 'b0', check: 'V(b) between 1.6 and 1.7', agent: 'beta' }),
    t.propose({ region: A, lease: la, block: 'b0', check: 'I(R1) between 2.45m and 2.55m', agent: 'alpha' }),
  ]);
  assert.deepEqual(out.map(o => o.status), ['committed', 'committed', 'committed'], JSON.stringify(out.map(o => o.reason)));
  assert.deepEqual(out.map(o => o.id), ['C1', 'C2', 'C3'], 'committed in the order they arrived');
  for (let i = 1; i < out.length; i++) assert.ok(out[i].global_after >= out[i - 1].global_after, 'the global score never falls');
  const built = (await t.status()).global;

  // Fresh: parse the suite the team wrote, and score it from nothing.
  const fresh = createTeam({ netlist: NET, suite: { id: 'checks', blocks: parseSimulationBlocks(t.render()) } });
  const again = (await fresh.partition()).global;
  assert.deepEqual({ k: again.killed, s: again.survived }, { k: built.killed, s: built.survived }, 'incremental and from-scratch agree');
});

test('MCP: --role team gives the lead and its agents the team tools, and nothing else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-team-'));
  const design = join(dir, 'two.cir'), checks = join(dir, 'checks.md'), out = join(dir, 'team-suite.md');
  writeFileSync(design, NET);
  writeFileSync(checks, '## Simulation\n\nscope: nets [vcc]\nanalysis: op\nassert: V(vcc) between 4 and 6\n');
  const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs'), '--role', 'team', '--design', design, '--checks', checks, '--suite-out', out], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '', next = 1;
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(res => { const id = next++; waiters.set(id, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    const names = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    assert.deepEqual(names, ['kinux_team_partition', 'kinux_team_claim', 'kinux_region_brief', 'kinux_propose_check', 'kinux_propose_block', 'kinux_retract_check', 'kinux_team_status']);
    const part = (await call('kinux_team_partition')).structuredContent;
    const region = part.regions.find(r => r.parts.includes('R1')).region;
    const { lease } = (await call('kinux_team_claim', { region, agent: 'alpha' })).structuredContent;
    const brief = (await call('kinux_region_brief', { region })).structuredContent;
    assert.ok(brief.you_may_measure.includes('V(a)'));
    const r = (await call('kinux_propose_check', { region, lease, block: 'b0', check: 'V(a) between 2.45 and 2.55', agent: 'alpha' })).structuredContent;
    assert.equal(r.status, 'committed');
    const status = (await call('kinux_team_status')).structuredContent;
    assert.equal(status.commits.length, 1);
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync(out, 'utf8'), /assert: V\(a\) between 2\.45 and 2\.55/, 'every commit is written to the suite file');
  } finally { child.kill(); }
});

test('specialists: each region gets the specialist for its kind of element, from the KiCad library when known', async () => {
  const { partKind, specialtyOf } = await import('../engine/team.mjs');
  const { parseNetlist } = await import('../engine/netlist.mjs');
  const nl = parseNetlist(['t', 'R1 a 0 1k', 'C1 a 0 1u', 'XD2 a b SMCW_1206', 'XF1 a b F1_SUB', 'XD1 a b 1N4148W', 'IMCU a 0 DC 0.01', 'XU1 a b c TLC555', ''].join('\n'));
  const kind = (ref, info) => partKind(nl.component(ref), info);
  assert.equal(kind('R1'), 'resistor');
  assert.equal(kind('C1'), 'capacitor');
  assert.equal(kind('XD2', { lib: 'Device', part: 'LED' }), 'led');
  assert.equal(kind('XF1', { lib: 'Device', part: 'Polyfuse' }), 'fuse');
  assert.equal(kind('XD1', { lib: 'Diode', part: '1N4148W' }), 'diode');
  assert.equal(kind('XD1', { lib: 'Device', part: 'D_TVS' }), 'protection_diode');
  assert.equal(kind('IMCU'), 'source');
  assert.equal(kind('XU1', { lib: 'Timer', part: 'TLC555xD' }), 'ic');
  assert.equal(kind('XU1'), 'ic', 'no library entry: the element type decides');
  assert.equal(specialtyOf(['resistor', 'led']), 'emitter');
  assert.equal(specialtyOf(['capacitor', 'diode', 'fuse']), 'protection');
  assert.equal(specialtyOf(['source', 'resistor']), 'active');
  assert.equal(specialtyOf(['capacitor', 'capacitor']), 'storage');
  assert.equal(specialtyOf(['resistor', 'resistor']), 'passive');
  const t = createTeam({ netlist: NET, suite: WEAK, partInfo: { R1: { lib: 'Device', part: 'R' } } });
  const part = await t.partition();
  const a = part.regions.find(r => r.parts.includes('R1'));
  assert.equal(a.specialist, 'kinux-spec-passive');
  assert.equal(part.regions.find(r => r.region === 'interfaces').specialist, 'lead');
  assert.ok(part.specialists.emitter, 'the partition explains every specialty');
});

test('every specialist the partition can name exists as a subagent, on a faster model than the lead', async () => {
  const { SPECIALISTS } = await import('../engine/team.mjs');
  const { readFileSync } = await import('node:fs');
  for (const k of Object.keys(SPECIALISTS)) {
    const md = readFileSync(join(ROOT, 'mcp', 'agents', `kinux-spec-${k}.md`), 'utf8');
    assert.match(md, new RegExp(`^name: kinux-spec-${k}$`, 'm'));
    assert.match(md, /^model: sonnet$/m);
    assert.match(md, /^tools: mcp__kinux-team__kinux_region_brief, mcp__kinux-team__kinux_propose_check$/m, 'a specialist cannot claim regions or spawn agents');
  }
  const lead = readFileSync(join(ROOT, 'mcp', 'commands', 'kinux-team.md'), 'utf8');
  assert.match(lead, /^model: opus$/m, 'the lead runs on the stronger model');
  for (const k of Object.keys(SPECIALISTS)) assert.match(lead, new RegExp(`kinux-spec-${k}`));
});

// An LED whose cathode is an MCU pin: dark unless something sinks it.
const LED = ['led channel', 'V1 vcc 0 5', 'R1 vcc a 680', 'D1 a k LEDM', 'R9 k 0 100meg', '.model LEDM D(IS=1e-20 N=1.8)', ''].join('\n');

test('blocks: only the lead adds stimulus, with a stated condition; then faults that could not show can be caught', async () => {
  const t = createTeam({ netlist: LED, suite: WEAK });
  const part = await t.partition();
  const g = part.regions.find(r => r.parts.includes('R1')).region;
  const { lease: L } = await t.claim('interfaces', 'lead');
  const { lease: G } = await t.claim(g, 'emitter');
  assert.equal((await t.propose({ region: g, lease: G, block: 'b0', check: 'I(R1) between 4.4m and 5.4m' })).code, 'fails_design', 'dark LED: no current to check');
  assert.equal((await t.proposeBlock({ lease: G, analysis: 'op', sources: { k: 0 }, why: 'x' })).code, 'no_lease', 'a specialist cannot add stimulus');
  assert.equal((await t.proposeBlock({ lease: L, analysis: 'op', sources: { k: 0 } })).code, 'no_reason');
  assert.equal((await t.proposeBlock({ lease: L, analysis: 'op', sources: { vcc: 3 }, why: 'brown-out' })).code, 'bad_source', 'vcc is already driven by V1');
  assert.equal((await t.proposeBlock({ lease: L, analysis: 'op', sources: { nowhere: 0 }, why: 'x' })).code, 'bad_source');
  assert.equal((await t.proposeBlock({ lease: L, analysis: 'ac dec 10 1 1k', sources: { k: 0 }, why: 'x' })).code, 'grammar');
  const b = await t.proposeBlock({ lease: L, analysis: 'op', sources: { k: 0 }, why: 'MCU pin sinks the LED cathode: LED on' });
  assert.equal(b.status, 'committed');
  const iR1 = (5 - b.values['v(a)']) / 680;
  assert.ok(Math.abs(b.values['i(vksrc1)'] - iR1) / iR1 < 1e-4, 'the block reports the solved circuit: the cathode source sinks the R1 current');
  assert.equal((await t.proposeBlock({ lease: L, analysis: 'op', sources: { k: 0 }, why: 'again' })).code, 'duplicate');
  const brief = await t.brief(g);
  assert.ok(brief.blocks.find(x => x.block === b.block).values['v(a)'] > 1, 'specialists see the values on their nets');
  const c = await t.propose({ region: g, lease: G, block: b.block, check: 'I(R1) between 4.3m and 4.9m' });
  assert.equal(c.status, 'committed', c.reason);
  assert.ok(c.kills.length >= 3 && c.global_after > c.global_before);
  // The suite the team wrote still scores the same from scratch, new block and all.
  const fresh = createTeam({ netlist: LED, suite: { id: 'checks', blocks: parseSimulationBlocks(t.render()) } });
  const again = (await fresh.partition()).global;
  const built = (await t.status()).global;
  assert.deepEqual({ k: again.killed, s: again.survived }, { k: built.killed, s: built.survived });
  assert.match(t.render(), /block added by the lead: MCU pin sinks the LED cathode/);
});

test('interfaces: the lead\'s rail checks may catch any region\'s fault; retracting a check gives its faults back', async () => {
  const t = createTeam({ netlist: NET, suite: WEAK });
  await t.partition();
  const { lease: L } = await t.claim('interfaces', 'lead');
  const A = t.decomposition.regionOf.get('R1');
  const { lease: la } = await t.claim(A);
  const tight = await t.propose({ region: A, lease: la, block: 'b0', check: 'V(a) between 2.49 and 2.51' });
  assert.equal(tight.status, 'committed', tight.reason);
  assert.equal((await t.retract({ lease: la, commit: tight.id, reason: 'x' })).code, 'no_lease', 'only the lead retracts');
  assert.equal((await t.retract({ lease: L, commit: tight.id })).code, 'no_reason');
  const r = await t.retract({ lease: L, commit: tight.id, reason: '±0.4% is tighter than two 1% resistors hold' });
  assert.equal(r.status, 'retracted');
  assert.ok(r.global_after < r.global_before && r.survive_again.length > 0, 'the score falls honestly');
  assert.doesNotMatch(t.render(), /between 2\.49 and 2\.51/);
  // The lead holds node a at its nominal level; the rail source then carries R1's current minus R2's,
  // so a check on it (an interface quantity) catches region A's faults.
  const b = await t.proposeBlock({ lease: L, analysis: 'op', sources: { a: 2.5 }, why: 'test fixture holds node a at its nominal level' });
  assert.equal(b.status, 'committed');
  const c = await t.propose({ region: 'interfaces', lease: L, block: b.block, check: 'I(Vksrc1) between -0.1m and 0.1m' });
  assert.equal(c.status, 'committed', c.reason);
  const ofA = new Set(t.decomposition.regions.find(x => x.id === A).parts);
  assert.ok(c.kills.some(id => [...ofA].some(p => id.includes(p))), `an interface check catches region ${A}'s faults: ${c.kills}`);
  const fresh = createTeam({ netlist: NET, suite: { id: 'checks', blocks: parseSimulationBlocks(t.render()) } });
  const again = (await fresh.partition()).global;
  const built = (await t.status()).global;
  assert.deepEqual({ k: again.killed, s: again.survived }, { k: built.killed, s: built.survived }, 'and still equals a fresh run');
});
