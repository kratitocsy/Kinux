// Design sessions: an agent edits the DESIGN; Kinux keeps an edit only if it
// reaches the simulated circuit, adds no ERC violation, breaks no passing
// check and fixes at least one failing one. Real kicad-cli and ngspice, on our
// own divider schematic (engine/fixtures/divider.kicad_sch: VIN 5 V, R1 10k,
// R2 10k to mid, R3 1M, R4 1k to out). The originals are never written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseSimulationBlocks } from '../workers/ngspice/assertions.mjs';
import { createDesignSession, setSymbolValue, diffText } from '../engine/design-session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = join(ROOT, 'engine', 'fixtures');
const SCH = join(F, 'divider.kicad_sch'), SIDE = join(F, 'divider.sidecar.json');
const suiteOf = md => ({ id: 'checks', blocks: parseSimulationBlocks(md) });
// V(out) is 2.485 V as drawn. This suite asks for 2.49 .. 2.50: the design fails it.
const WANT = suiteOf('## Simulation\n\nscope: nets [mid, out]\nanalysis: op\nassert: V(out) between 2.49 and 2.50\nassert: I(V1) between -260u and -240u\n');

test('anchored value edit: exactly one placed symbol, exactly one Value field; library symbols are never touched', () => {
  const text = readFileSync(SCH, 'utf8');
  const { text: out, from } = setSymbolValue(text, 'R3', '2M');
  assert.equal(from, '1M');
  const d = diffText(text, out, 'x.kicad_sch');
  assert.equal(d.split('\n').filter(l => /^[-+](?![-+])/.test(l)).length, 2, 'one line out, one line in');
  assert.match(d, /^-.*\(property "Value" "1M"/m);
  assert.match(d, /^\+.*\(property "Value" "2M"/m);
  assert.throws(() => setSymbolValue(text, 'R9', '1k'), /exactly one placed symbol R9, found 0/);
  assert.throws(() => setSymbolValue(text, 'R', '1k'), /exactly one placed symbol/, 'the library definition\'s generic "R" is not a placed part');
});

test('an edit that fixes a failing check is kept, with what it fixed; the originals are untouched', async () => {
  const before = { sch: readFileSync(SCH, 'utf8'), side: readFileSync(SIDE, 'utf8') };
  const s = createDesignSession({ schematic: SCH, sidecar: SIDE, suite: WANT });
  const b = await s.brief();
  assert.deepEqual(b.failing, ['V(out) between 2.49 and 2.50']);
  // Notes after the value stay in the field for the BOM (the live 555 run lost "C0G" before this).
  const r = await s.propose({ kind: 'value', ref: 'R3', value: '2M 1%', why: 'output must sit at 2.49 .. 2.50 V' });
  assert.equal(r.status, 'kept', JSON.stringify(r));
  assert.deepEqual(r.fixed.map(f => f.check), ['V(out) between 2.49 and 2.50']);
  assert.ok(r.fixed[0].now > 2.49 && r.fixed[0].was < 2.49);
  const d = s.diff();
  assert.match(d.diff, /^\+.*\(property "Value" "2M 1%"/m);
  assert.deepEqual(d.kept.map(k => k.description), ['R3 value 1M -> 2M 1%']);
  assert.equal(readFileSync(SCH, 'utf8'), before.sch, 'the original schematic is never written');
  assert.equal(readFileSync(SIDE, 'utf8'), before.side);
  assert.match(readFileSync(d.schematic, 'utf8'), /\(property "Value" "2M 1%"/, 'the edit is in the session copy');
});

test('refusals: no reason, a regression, no fix, and a value that is not one; each one leaves the copy as it was', async () => {
  const s = createDesignSession({ schematic: SCH, sidecar: SIDE, suite: suiteOf('## Simulation\n\nscope: nets [mid, out]\nanalysis: op\nassert: V(out) between 2.480 and 2.490\n') });
  await s.brief();
  assert.equal((await s.propose({ kind: 'value', ref: 'R3', value: '2M' })).code, 'no_reason');
  const reg = await s.propose({ kind: 'value', ref: 'R3', value: '2M', why: 'try' });
  assert.equal(reg.code, 'regression');
  assert.ok(reg.regressed[0].now > 2.49, 'and says what it did to the check');
  assert.equal((await s.propose({ kind: 'value', ref: 'R3', value: '1.1M', why: 'try' })).code, 'fixes_nothing');
  assert.equal((await s.propose({ kind: 'value', ref: 'R1', value: 'abc', why: 'x' })).code, 'refused');
  assert.equal((await s.propose({ kind: 'value', ref: 'R9', value: '1k', why: 'x' })).code, 'refused');
  assert.equal((await s.propose({ kind: 'model', ref: 'D1', file: 'x.lib', model: 'D', why: 'x' })).code, 'refused', 'no model directory in this session');
  assert.equal(s.diff().diff, '', 'nothing was kept');
});

test('MCP: --role designer exposes the design tools only, and an agent cannot touch the checks', async () => {
  const checks = join(mkdtempSync(join(tmpdir(), 'kinux-designer-')), 'checks.md');
  writeFileSync(checks, '## Simulation\n\nscope: nets [mid, out]\nanalysis: op\nassert: V(out) between 2.49 and 2.50\nassert: I(V1) between -260u and -240u\n');
  const child = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs'), '--role', 'designer', '--design', SCH, '--sidecar', SIDE, '--checks', checks], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '', next = 1;
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(res => { const id = next++; waiters.set(id, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.match(init.result.instructions, /checks are fixed/i);
    const names = (await rpc('tools/list', {})).result.tools.map(t => t.name);
    assert.deepEqual(names, ['kinux_design_brief', 'kinux_propose_edit', 'kinux_design_wait', 'kinux_design_diff']);
    const brief = (await call('kinux_design_brief')).structuredContent;
    assert.deepEqual(brief.failing, ['V(out) between 2.49 and 2.50']);
    const r = (await call('kinux_propose_edit', { kind: 'value', ref: 'R3', value: '2M', why: 'output level' })).structuredContent;
    assert.equal(r.status, 'kept');
    const sneaky = await call('kinux_propose_edit', { kind: 'value', ref: 'R3', value: '3M', why: 'x', check: 'V(out) > 0' });
    assert.equal(sneaky.isError, true, 'no argument can carry a check');
    const d = (await call('kinux_design_diff')).structuredContent;
    assert.match(d.diff, /"2M"/);
  } finally { child.kill(); }
});
