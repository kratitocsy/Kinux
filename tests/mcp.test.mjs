// The MCP server (R14), driven the way an agent drives it: a child process,
// newline-delimited JSON-RPC on stdio, and real ngspice runs underneath.
//
// What must hold:
//  * exactly seven Builder tools, none of which takes a path, a flag, a
//    verdict or a score; kinux_start_run takes nothing at all;
//  * an unknown argument is refused and starts nothing;
//  * a full loop returns the same score the CLI computes for the same inputs;
//  * survivor details are withheld until the round closes;
//  * a second start while one is running is a typed busy error; cancel works;
//  * stdout carries JSON-RPC only;
//  * the server itself loads no model SDK.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

import { walkImports } from './helpers/import-graph.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'mcp', 'server.mjs');
const DESIGN = join(ROOT, 'engine', 'fixtures', 'divider-rc.cir');
const WEAK = join(ROOT, 'engine', 'fixtures', 'checks-weak.md');

function startServer(extra = []) {
  const runs = mkdtempSync(join(tmpdir(), 'kinux-mcp-test-'));
  const child = spawn(process.execPath, [SERVER, '--design', DESIGN, '--checks', WEAK, '--runs-dir', runs, ...extra],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiters = new Map();
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      lines.push(line);
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
    }
  });
  let next = 1;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = next++;
    const t = setTimeout(() => rej(new Error(`no reply to ${method}`)), 90_000);
    waiters.set(id, m => { clearTimeout(t); res(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => {
    const m = await rpc('tools/call', { name, arguments: args });
    if (m.error) throw new Error(m.error.message);
    return m.result;
  };
  const stop = () => { child.stdin.end(); child.kill(); };
  return { child, rpc, call, lines, stop, runs };
}

async function initialised(s) {
  const init = await s.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  s.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return init;
}

test('initialises, states the verdict contract, and lists exactly eight Builder tools with no escape hatch', async () => {
  const s = startServer();
  try {
    const init = await initialised(s);
    assert.equal(init.result.serverInfo.name, 'kinux');
    assert.match(init.result.instructions, /A FAIL is information to report/);
    assert.match(init.result.instructions, /NOT_CHECKED and ERROR are never a pass/);
    const { result } = await s.rpc('tools/list', {});
    assert.deepEqual(result.tools.map(t => t.name).sort(), ['kinux_cancel_run', 'kinux_doctor', 'kinux_get_findings',
      'kinux_get_status', 'kinux_open_viewer', 'kinux_render', 'kinux_start_run', 'kinux_wait_for_run']);
    for (const t of result.tools) {
      assert.equal(t.inputSchema.additionalProperties, false, t.name);
      const props = Object.keys(t.inputSchema.properties ?? {});
      for (const p of props) assert.ok(['run_id', 'seconds'].includes(p), `${t.name} takes "${p}"`);
    }
    assert.deepEqual(result.tools.find(t => t.name === 'kinux_start_run').inputSchema.properties, {});
  } finally { s.stop(); }
});

test('an argument a tool does not take is refused, and starts nothing', async () => {
  const s = startServer();
  try {
    await initialised(s);
    for (const args of [{ skip_baseline: true }, { force: true }, { design: '/etc/passwd' }]) {
      const r = await s.call('kinux_start_run', args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.equal(r.structuredContent.error, 'invalid_arguments');
    }
    const st = await s.call('kinux_get_status', {});
    assert.equal(st.structuredContent.error, 'no_run', 'nothing was started');
    const bad = await s.call('kinux_get_findings', { run_id: '../../etc' });
    assert.equal(bad.structuredContent.error, 'invalid_arguments');
  } finally { s.stop(); }
});

test('a full loop over MCP gives the same score as the CLI, and survivors only after the round closes', async () => {
  const s = startServer();
  try {
    await initialised(s);
    const started = (await s.call('kinux_start_run', {})).structuredContent;
    assert.match(started.run_id, /^r[0-9a-f]{8}$/);
    const early = (await s.call('kinux_get_findings', {})).structuredContent;
    if (early.state === 'running') assert.equal(early.survivors, undefined, 'no survivor details while running');
    let st;
    do { st = (await s.call('kinux_wait_for_run', { seconds: 55 })).structuredContent; } while (st.state === 'running');
    assert.equal(st.state, 'done', JSON.stringify(st));
    const f = (await s.call('kinux_get_findings', {})).structuredContent;

    const cliOut = mkdtempSync(join(tmpdir(), 'kinux-mcp-cli-'));
    execFileSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', DESIGN, '--checks', WEAK, '--out', cliOut, '--threshold', '0', '--quiet'],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    const cli = JSON.parse(readFileSync(join(cliOut, 'report.json'), 'utf8'));
    for (const k of ['killed', 'survived', 'not_checked', 'total', 'score', 'ci_low', 'ci_high', 'checkable_fraction']) {
      assert.equal(f.score[k], cli.score[k], k);
    }
    assert.equal(f.survivors.length, cli.score.survived);
    assert.equal(f.killed, cli.score.killed);
    assert.ok(f.not_checked.some(m => m.mutant_id === 'M-open_connection-C1.0'), 'the K26 NOT_CHECKED mutant is reported, not hidden');
    assert.match(f.disclaimer, /not a certification/i);
    assert.equal(f.baseline.passed, f.baseline.checks);
  } finally { s.stop(); }
});

test('a second start while a run is going is a typed busy error, and cancel stops the run', async () => {
  const s = startServer();
  try {
    await initialised(s);
    const a = (await s.call('kinux_start_run', {})).structuredContent;
    const b = await s.call('kinux_start_run', {});
    assert.equal(b.isError, true);
    assert.equal(b.structuredContent.error, 'busy');
    assert.equal(b.structuredContent.run_id, a.run_id);
    const c = (await s.call('kinux_cancel_run', { run_id: a.run_id })).structuredContent;
    assert.equal(c.state, 'cancelled');
    const f = (await s.call('kinux_get_findings', { run_id: a.run_id })).structuredContent;
    assert.equal(f.score, undefined, 'a cancelled run has no score');
    const again = (await s.call('kinux_start_run', {})).structuredContent;
    assert.match(again.run_id, /^r/);
    await s.call('kinux_cancel_run', {});
  } finally { s.stop(); }
});

test('stdout carries JSON-RPC and nothing else', async () => {
  const s = startServer();
  try {
    await initialised(s);
    await s.call('kinux_doctor', {});
    await s.rpc('tools/list', {});
    assert.ok(s.lines.length >= 3);
    for (const l of s.lines) assert.equal(JSON.parse(l).jsonrpc, '2.0', l);
  } finally { s.stop(); }
});

test('the server refuses to launch without a real design, and refuses unknown launch flags', () => {
  for (const args of [['--checks', WEAK], ['--design', '/nonexistent.cir', '--checks', WEAK], ['--design', DESIGN, '--checks', WEAK, '--force', '1']]) {
    let code = 0;
    try { execFileSync(process.execPath, [SERVER, ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 }); } catch (e) { code = e.status; }
    assert.equal(code, 2, args.join(' '));
  }
});

test('the MCP server itself loads only Node built-ins, the schema validator and our own code: no model SDK, no MCP SDK', () => {
  const g = walkImports([SERVER], ROOT);
  // Ajv is the project's one sanctioned dependency (CONTRIBUTING rule 6); the reviewer role reaches it
  // through the contract validator. Anything else, a model SDK or an MCP SDK above all, fails here.
  const ALLOWED = new Set(['ajv/dist/2020.js', 'ajv-formats']);
  const external = [...g.external.keys()].filter(s => !s.startsWith('node:') && !builtinModules.includes(s) && !ALLOWED.has(s));
  assert.deepEqual(external, []);
  assert.deepEqual(g.findings, []);
});

test('the server writes its own call log, one line per tool call, and pins the checks each run used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-mcp-log-'));
  const log = join(dir, 'calls.jsonl');
  const s = startServer(['--call-log', log, '--jobs', '2']);
  try {
    await initialised(s);
    const started = (await s.call('kinux_start_run', {})).structuredContent;
    assert.match(started.checks_hash, /^[0-9a-f]{64}$/);
    await s.call('kinux_start_run', { force: true });
    await s.call('kinux_cancel_run', {});
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => [l.tool, l.isError]), [['kinux_start_run', false], ['kinux_start_run', true], ['kinux_cancel_run', false]]);
    assert.deepEqual(lines[1].arguments, { force: true }, 'what the agent asked for is recorded, refused or not');
  } finally { s.stop(); }
});

test('launch flags for vendor models are checked: only psa, and jobs within 1..64', () => {
  for (const extra of [['--ngspice-compat', 'spice3'], ['--jobs', '0'], ['--jobs', 'x']]) {
    let code = 0;
    try { execFileSync(process.execPath, [SERVER, '--design', DESIGN, '--checks', WEAK, ...extra], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 }); } catch (e) { code = e.status; }
    assert.equal(code, 2, extra.join(' '));
  }
});

function startReviewer(extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-mcp-rev-'));
  const spec = join(dir, 'SPEC.md');
  writeFileSync(spec, '# Spec\n\nThe divider output SHALL sit between 2.4 V and 2.6 V with a 5 V input.\n');
  const FIXD = join(ROOT, 'engine', 'fixtures');
  const child = spawn(process.execPath, [SERVER, '--role', 'reviewer', '--design', join(FIXD, 'divider.kicad_sch'),
    '--sidecar', join(FIXD, 'divider.sidecar.json'), '--doc', spec, '--review-log', join(dir, 'review.jsonl'), ...extra], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '';
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  let next = 1;
  const rpc = (method, params) => new Promise(res => { const id = next++; waiters.set(id, res); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { child, rpc, call, dir, stop: () => { child.stdin.end(); child.kill(); } };
}

test('the reviewer role lists only the review tools; neither role can call the other\'s', async () => {
  const r = startReviewer();
  try {
    const init = await r.rpc('initialize', {});
    assert.match(init.result.instructions, /PROPOSALS, never by prose/);
    const names = (await r.rpc('tools/list', {})).result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['kinux_get_review', 'kinux_propose', 'kinux_read_document', 'kinux_review_bundle']);
    const run = await r.rpc('tools/call', { name: 'kinux_start_run', arguments: {} });
    assert.ok(run.error, 'a reviewer cannot start runs');
  } finally { r.stop(); }
  const b = startServer();
  try {
    await initialised(b);
    const p = await b.rpc('tools/call', { name: 'kinux_propose', arguments: { kind: 'question', text: 'x' } });
    assert.ok(p.error, 'a builder cannot propose');
  } finally { b.stop(); }
});

test('a review over MCP: proposals are verified or rejected at once, the report holds only what survived, the server logs it', async () => {
  const r = startReviewer();
  try {
    await r.rpc('initialize', {});
    const bundle = (await r.call('kinux_review_bundle', {})).structuredContent;
    assert.match(bundle.bundle_hash, /^[0-9a-f]{64}$/);
    const cite = (await r.call('kinux_propose', { kind: 'citation', domain: 'power', doc: 'SPEC.md', quote: 'between 2.4 V and 2.6 V with a 5 V input' })).structuredContent;
    assert.equal(cite.status, 'verified');
    const meas = (await r.call('kinux_propose', { kind: 'measurement', domain: 'power', probe: 'V(OUT)', analysis: 'op' })).structuredContent;
    assert.equal(meas.status, 'verified');
    assert.ok(Math.abs(meas.evidence.measured - 2.48511) < 1e-3);
    const fake = (await r.call('kinux_propose', { kind: 'citation', domain: 'power', doc: 'SPEC.md', quote: 'output SHALL be exactly 3.3 V always' })).structuredContent;
    assert.equal(fake.status, 'rejected');
    const f = (await r.call('kinux_propose', { kind: 'finding', domain: 'power', severity: 'info', title: 'Divider output is inside its band', premises: [cite.id, meas.id] })).structuredContent;
    assert.equal(f.status, 'verified');
    const bad = await r.call('kinux_propose', { kind: 'measurement', probe: 'V(OUT)', sources: { 'OUT; shell': 1 } });
    assert.equal(bad.isError, true, 'a source name outside the grammar is refused before any verifier runs');
    const rev = (await r.call('kinux_get_review', {})).structuredContent;
    assert.equal(rev.verified, 3);
    assert.equal(rev.rejected, 1);
    assert.match(rev.report, /Divider output is inside its band/);
    assert.doesNotMatch(rev.report, /exactly 3\.3 V/);
    const log = readFileSync(join(r.dir, 'review.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(log.map(e => e.status), ['verified', 'verified', 'rejected', 'verified']);
  } finally { r.stop(); }
});


test('open_viewer serves the run to a person on 127.0.0.1, behind a path token, and nothing outside the run', async () => {
  const s = startServer();
  try {
    await initialised(s);
    const { run_id } = (await s.call('kinux_start_run', {})).structuredContent;
    let st;
    do { st = (await s.call('kinux_wait_for_run', { seconds: 55 })).structuredContent; } while (st.state === 'running');
    const v = (await s.call('kinux_open_viewer', {})).structuredContent;
    assert.match(v.viewer_url, /^http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]{20,}\/viewer\/index\.html\?run=/);
    const page = await fetch(v.viewer_url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /importmap/);
    const base = v.viewer_url.split('/viewer/')[0];
    const events = await fetch(`${base}/runs/${run_id}/events.jsonl`);
    assert.equal(events.status, 200);
    assert.ok((await events.text()).includes('"run.started"'));
    const origin = new URL(v.viewer_url).origin;
    for (const bad of [`${origin}/viewer/index.html`, `${origin}/t/wrongtoken/runs/${run_id}/events.jsonl`,
      `${base}/runs/${run_id}/../../../etc/passwd`, `${base}/runs/${run_id}/%2e%2e/%2e%2e/etc/passwd`,
      `${base}/runs/../events.jsonl`, `${base}/runs/rffffffff/events.jsonl`, `${base}/viewer/../../package.json`]) {
      assert.equal((await fetch(bad)).status, 404, bad);
    }
    const act = await (await fetch(`${base}/activity.json`)).json();
    assert.deepEqual(act.slice(0, 2).map(a => [a.role, a.tool]), [['builder', 'kinux_start_run'], ['builder', 'kinux_wait_for_run']]);
    assert.ok(act.some(a => a.tool === 'kinux_open_viewer'), 'the activity record is the server\'s, kept for every call');
    const r = await s.call('kinux_render', {});
    assert.equal(r.isError, true, 'a .cir design has no 3D board to render');
    assert.equal(r.structuredContent.error, 'no_board');
  } finally { s.stop(); }
});
