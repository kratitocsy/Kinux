#!/usr/bin/env node
// Kinux MCP server, Builder role, v0 (ROADMAP R14).
//
//   node mcp/server.mjs --design <x.cir|x.kicad_sch> --checks <checks.md>
//                       [--sidecar <json>] [--model-dir <dir>] [--thermal-model <json>]
//                       [--intent <json>] [--ngspice-compat psa] [--jobs <n>] [--cache <file>]
//                       [--runs-dir <dir>] [--call-log <file.jsonl>]
//
// A coding agent (Claude Code, Codex, Cursor) starts runs and reads findings
// through these seven tools. It never edits files through Kinux and never
// supplies a verdict. Design rules, from ROADMAP R14 and LEARNINGS:
//
//  * The design, the checks and the role are fixed at LAUNCH, never by a tool
//    argument. No tool takes a path, so an agent cannot point Kinux at a file.
//  * kinux_start_run takes no arguments at all: no force, no skip_baseline, no
//    limit. It runs the same `kinux verify` as the CLI, baseline first.
//  * No tool accepts a verdict, a score or solver text.
//  * Survivor details are released only when the round has closed.
//  * One run at a time; a second start is a typed `busy` error, not a queue.
//  * stdout carries JSON-RPC and nothing else; diagnostics go to stderr.
//  * No dependencies: MCP over stdio is newline-delimited JSON-RPC 2.0.
//  * This file is on the agent side. tests/no-model-in-verdict.test.mjs fails
//    if anything on the verdict path imports it.
//
// Not in v0: the Villain role (propose_fault, run_faults, get_survivors), live
// viewer serving, per-tool schema negotiation beyond `schemaVersion`.

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'engine', 'cli.mjs');
const DOCTOR = join(ROOT, 'scripts', 'doctor.mjs');
export const PROTOCOL_VERSION = '2025-06-18';
export const SCHEMA_VERSION = '0.1';
export const WAIT_CAP_SECONDS = 55;

export const VERDICT_CONTRACT = [
  'Kinux scores how well a design\'s checks catch injected faults. A solver decides every verdict; you never do.',
  'A FAIL is information to report to the person, not an obstacle to route around. Do not weaken a check, loosen a bound or edit the design just to turn a FAIL into a PASS.',
  'NOT_CHECKED and ERROR are never a pass and never a kill. Report them with their reason.',
  'A score always travels with its checkable fraction, mutant count and confidence interval. Quote them together.',
  'Survivors are faults no check noticed. Each one should end as a new or tighter check, a solver-proven or person-confirmed equivalent, or a person\'s recorded acceptance.',
  'This is a pre-check linter, not a certification.',
].join('\n');

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const RUN_ID = { type: 'string', pattern: '^r[0-9a-f]{8}$', description: 'a run id from kinux_start_run; default: the latest run' };
const OPTIONAL_RUN = { type: 'object', properties: { run_id: RUN_ID }, additionalProperties: false };

export const TOOLS = [
  { name: 'kinux_doctor', description: 'Read-only probe of this machine: which solvers are installed and which test suites can run.', inputSchema: NO_ARGS },
  { name: 'kinux_start_run', description: 'Start a mutation run on the design and checks this server was launched with: the baseline first, then every generated fault. Takes no arguments. Returns a run id, or a busy error if a run is already going.', inputSchema: NO_ARGS },
  { name: 'kinux_get_status', description: 'State of a run: running, done, failed or cancelled, with the number of events written so far.', inputSchema: OPTIONAL_RUN },
  { name: 'kinux_wait_for_run', description: `Wait up to ${WAIT_CAP_SECONDS} seconds for a run to finish, then return its status. Never errors on timeout; call it again.`,
    inputSchema: { type: 'object', properties: { run_id: RUN_ID, seconds: { type: 'number', minimum: 0, maximum: WAIT_CAP_SECONDS } }, additionalProperties: false } },
  { name: 'kinux_get_findings', description: 'The result of a finished run: baseline, score with its interval and checkable fraction, cap, and the survivors (faults no check caught). While a run is going, only its state is returned.', inputSchema: OPTIONAL_RUN },
  { name: 'kinux_cancel_run', description: 'Stop a running run. A cancelled run has no score.', inputSchema: OPTIONAL_RUN },
  { name: 'kinux_open_viewer', description: 'Where to read a run: the report and event files. A live browser view is not wired in v0.', inputSchema: OPTIONAL_RUN },
];

class ToolError extends Error {
  constructor(type, message, extra = {}) { super(message); this.type = type; this.extra = extra; }
}

/** Parse launch arguments. Throws on anything missing or unknown. */
export function parseLaunchArgs(argv) {
  const opts = {};
  const known = new Set(['design', 'checks', 'sidecar', 'model-dir', 'thermal-model', 'runs-dir', 'intent', 'ngspice-compat', 'jobs', 'cache', 'call-log']);
  const literal = new Set(['ngspice-compat', 'jobs']);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--') || !known.has(flag.slice(2)) || argv[i + 1] === undefined) {
      throw new Error(`unknown or incomplete argument "${flag}"`);
    }
    opts[flag.slice(2)] = literal.has(flag.slice(2)) ? argv[i + 1] : resolve(argv[i + 1]);
  }
  for (const req of ['design', 'checks']) if (!opts[req]) throw new Error(`--${req} is required`);
  if (opts['ngspice-compat'] !== undefined && opts['ngspice-compat'] !== 'psa') throw new Error('--ngspice-compat accepts only psa');
  if (opts.jobs !== undefined && !(/^\d+$/.test(opts.jobs) && Number(opts.jobs) >= 1 && Number(opts.jobs) <= 64)) throw new Error('--jobs must be a whole number from 1 to 64');
  for (const k of ['design', 'checks', 'sidecar', 'model-dir', 'thermal-model', 'intent']) {
    if (opts[k] && !existsSync(opts[k])) throw new Error(`--${k} ${opts[k]} does not exist`);
  }
  if (/\.kicad_sch$/i.test(opts.design) && !opts.sidecar) throw new Error('a .kicad_sch design needs --sidecar');
  return opts;
}

export function createServer(opts, { log = () => {} } = {}) {
  const runsDir = opts['runs-dir'] ?? mkdtempSync(join(tmpdir(), 'kinux-mcp-'));
  mkdirSync(runsDir, { recursive: true });
  const runs = new Map();
  let latest = null;

  const designHash = () => createHash('sha256').update(readFileSync(opts.design)).digest('hex');
  const checksHash = () => createHash('sha256').update(readFileSync(opts.checks)).digest('hex');
  // The call log is the evidence of what the agent did (R14: assert on the
  // call log, not on the agent's prose). One JSON line per tool call, written
  // by the server, never by the agent.
  const callLog = entry => {
    if (!opts['call-log']) return;
    appendFileSync(opts['call-log'], `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  };

  function pick(args = {}) {
    const id = args.run_id ?? latest;
    if (!id) throw new ToolError('no_run', 'no run has been started');
    const run = runs.get(id);
    if (!run) throw new ToolError('unknown_run', `no run ${id}`);
    return run;
  }

  function eventCount(run) {
    const p = join(run.out, 'events.jsonl');
    if (!existsSync(p)) return 0;
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
  }

  function status(run) {
    return { run_id: run.id, state: run.state, design_hash: run.design_hash, events: eventCount(run),
      elapsed_ms: (run.finished ?? Date.now()) - run.started,
      ...(run.state === 'failed' ? { reason: run.reason } : {}) };
  }

  const tools = {
    kinux_doctor: () => new Promise(res => {
      execFile(process.execPath, [DOCTOR], { timeout: 30_000 }, (err, stdout, stderr) => {
        res({ report: String(stdout).trim(), ...(err ? { note: `doctor exited ${err.code}: ${String(stderr).trim().slice(0, 300)}` } : {}) });
      });
    }),

    kinux_start_run: () => {
      const active = [...runs.values()].find(r => r.state === 'running');
      if (active) throw new ToolError('busy', `run ${active.id} is still running; wait for it or cancel it`, { run_id: active.id });
      const id = `r${randomBytes(4).toString('hex')}`;
      const out = join(runsDir, id);
      const args = [CLI, 'verify', opts.design, '--checks', opts.checks, '--out', out, '--threshold', '0', '--quiet', '--run-id', id];
      if (opts.sidecar) args.push('--sidecar', opts.sidecar);
      if (opts['model-dir']) args.push('--model-dir', opts['model-dir']);
      if (opts['thermal-model']) args.push('--thermal-model', opts['thermal-model']);
      if (opts.intent) args.push('--intent', opts.intent);
      if (opts['ngspice-compat']) args.push('--ngspice-compat', opts['ngspice-compat']);
      if (opts.jobs) args.push('--jobs', opts.jobs);
      if (opts.cache) args.push('--cache', opts.cache);
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const run = { id, out, child, state: 'running', started: Date.now(), finished: null, stderr: '', design_hash: designHash(), checks_hash: checksHash() };
      child.stderr.on('data', d => { run.stderr = (run.stderr + d).slice(-4000); });
      child.on('exit', (code, signal) => {
        run.finished = Date.now();
        if (run.state === 'cancelled') return;
        // Exit 0 and 1 both mean the run completed (1 = below threshold; we pass 0).
        if ((code === 0 || code === 1) && existsSync(join(out, 'report.json'))) run.state = 'done';
        else {
          run.state = 'failed';
          run.reason = `kinux verify exited ${code ?? signal}: ${run.stderr.split('\n').filter(l => l && !/ExperimentalWarning|trace-warnings/.test(l)).slice(-4).join(' | ')}`;
        }
        log(`run ${id} ${run.state}`);
      });
      runs.set(id, run);
      latest = id;
      return { run_id: id, state: 'running', design_hash: run.design_hash, checks_hash: run.checks_hash };
    },

    kinux_get_status: args => status(pick(args)),

    kinux_wait_for_run: async (args = {}) => {
      const run = pick(args);
      const limit = Math.min(Number.isFinite(args.seconds) ? args.seconds : WAIT_CAP_SECONDS, WAIT_CAP_SECONDS) * 1000;
      const until = Date.now() + limit;
      while (run.state === 'running' && Date.now() < until) await new Promise(r => setTimeout(r, 200));
      return { ...status(run), waited_ms: Math.max(0, limit - (until - Date.now())) };
    },

    kinux_get_findings: args => {
      const run = pick(args);
      if (run.state !== 'done') {
        return { ...status(run), note: run.state === 'running'
          ? 'The round has not closed. Findings and survivor details are released when it finishes.'
          : 'This run has no findings.' };
      }
      const r = JSON.parse(readFileSync(join(run.out, 'report.json'), 'utf8'));
      const mutants = r.mutants ?? [];
      const brief = m => ({ mutant_id: m.mutant_id, operator: m.operator, target: m.target, description: m.description });
      return {
        run_id: run.id, state: 'done', design_hash: r.design_hash, disclaimer: r.disclaimer,
        baseline: { checks: r.baseline?.checks, passed: r.baseline?.passed, not_passed: r.baseline?.not_passed ?? [] },
        score: r.score, score_text: r.score_text, cap: r.cap ?? null, effective_score: r.effective_score,
        survivors: mutants.filter(m => m.status === 'survived').map(brief),
        not_checked: mutants.filter(m => m.status === 'not_checked' || m.status === 'error')
          .map(m => ({ ...brief(m), status: m.status, why: m.why })),
        killed: mutants.filter(m => m.status === 'killed').length,
        report: join(run.out, 'report.md'),
      };
    },

    kinux_cancel_run: args => {
      const run = pick(args);
      if (run.state !== 'running') return { ...status(run), note: `run is already ${run.state}` };
      run.state = 'cancelled';
      run.child.kill('SIGTERM');
      return status(run);
    },

    kinux_open_viewer: args => {
      const run = pick(args);
      return { run_id: run.id, report_md: join(run.out, 'report.md'), report_json: join(run.out, 'report.json'),
        events: join(run.out, 'events.jsonl'), live_viewer: 'not wired in v0' };
    },
  };

  function validateArgs(tool, args) {
    if (args === undefined || args === null) return {};
    if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError('invalid_arguments', 'arguments must be an object');
    const allowed = tool.inputSchema.properties ?? {};
    for (const [k, v] of Object.entries(args)) {
      if (!(k in allowed)) throw new ToolError('invalid_arguments', `${tool.name} takes no argument "${k}"`);
      const sch = allowed[k];
      if (sch.type === 'string' && (typeof v !== 'string' || (sch.pattern && !new RegExp(sch.pattern).test(v)))) {
        throw new ToolError('invalid_arguments', `${k} is not a valid ${k}`);
      }
      if (sch.type === 'number' && (typeof v !== 'number' || v < sch.minimum || v > sch.maximum)) {
        throw new ToolError('invalid_arguments', `${k} must be a number from ${sch.minimum} to ${sch.maximum}`);
      }
    }
    return args;
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kinux', version: '0.1.0' }, instructions: VERDICT_CONTRACT };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS.map(t => ({ ...t, _meta: { schemaVersion: SCHEMA_VERSION, role: 'builder' } })) };
    if (method === 'tools/call') {
      const tool = TOOLS.find(t => t.name === params?.name);
      if (!tool) throw Object.assign(new Error(`unknown tool ${params?.name}`), { code: -32602 });
      try {
        const args = validateArgs(tool, params.arguments);
        const result = await tools[tool.name](args);
        callLog({ tool: tool.name, arguments: params.arguments ?? {}, isError: false, result });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false };
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        const body = { error: err.type, message: err.message, ...err.extra };
        callLog({ tool: tool.name, arguments: params.arguments ?? {}, isError: true, result: body });
        return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true };
      }
    }
    throw Object.assign(new Error(`method not found: ${method}`), { code: -32601, id });
  }

  function shutdown() {
    for (const r of runs.values()) if (r.state === 'running') { r.state = 'cancelled'; r.child.kill('SIGTERM'); }
  }

  return { handle, shutdown, runs };
}

async function main() {
  let opts;
  try { opts = parseLaunchArgs(process.argv.slice(2)); } catch (err) {
    process.stderr.write(`kinux mcp: ${err.message}\n`);
    process.exit(2);
  }
  const server = createServer(opts, { log: m => process.stderr.write(`kinux mcp: ${m}\n`) });
  const send = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    if (msg.id === undefined) return; // a notification, such as notifications/initialized
    try {
      send({ jsonrpc: '2.0', id: msg.id, result: await server.handle(msg) });
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  });
  rl.on('close', () => { server.shutdown(); process.exit(0); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
