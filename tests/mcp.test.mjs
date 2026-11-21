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
import { mkdtempSync, readFileSync } from 'node:fs';
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

test('initialises, states the verdict contract, and lists exactly seven Builder tools with no escape hatch', async () => {
  const s = startServer();
  try {
    const init = await initialised(s);
    assert.equal(init.result.serverInfo.name, 'kinux');
    assert.match(init.result.instructions, /A FAIL is information to report/);
    assert.match(init.result.instructions, /NOT_CHECKED and ERROR are never a pass/);
    const { result } = await s.rpc('tools/list', {});
    assert.deepEqual(result.tools.map(t => t.name).sort(), ['kinux_cancel_run', 'kinux_doctor', 'kinux_get_findings',
      'kinux_get_status', 'kinux_open_viewer', 'kinux_start_run', 'kinux_wait_for_run']);
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

test('the MCP server itself loads only Node built-ins and our own code: no model SDK, no MCP SDK', () => {
  const g = walkImports([SERVER], ROOT);
  const external = [...g.external.keys()].filter(s => !s.startsWith('node:') && !builtinModules.includes(s));
  assert.deepEqual(external, []);
  assert.deepEqual(g.findings, []);
});
