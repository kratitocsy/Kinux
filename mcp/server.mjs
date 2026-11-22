#!/usr/bin/env node
// Kinux MCP server, Builder role, v0 (ROADMAP R14).
//
//   node mcp/server.mjs --design <x.cir|x.kicad_sch> --checks <checks.md>
//                       [--sidecar <json>] [--model-dir <dir>] [--thermal-model <json>]
//                       [--intent <json>] [--ngspice-compat psa] [--jobs <n>] [--cache <file>]
//                       [--runs-dir <dir>] [--call-log <file.jsonl>]
//   node mcp/server.mjs --role reviewer --design <...> [--sidecar ...] --doc <SPEC.md> [--doc ...]
//                       [--review-log <file.jsonl>]
//   node mcp/server.mjs --role villain --design <...> --checks <checks.md> [--sidecar ...]
//                       [--villain-log <file.jsonl>] [--budget <n>]
//
// ROLE comes from the launch, never from a tool argument. The Builder role
// (default) starts runs and reads findings. The Reviewer role reviews the
// design by PROPOSALS (engine/review.mjs): citations, facts, measurements,
// findings and questions, each accepted or rejected at once by a deterministic
// verifier. A reviewer cannot start runs; a builder cannot propose.
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
// The Villain role (engine/villain.mjs) proposes faults in a closed grammar;
// Kinux applies each one, runs every check and measures the harm with ngspice.
// A villain cannot start runs, propose review items or supply any result.

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
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

export const REVIEW_CONTRACT = [
  'You review a hardware design by PROPOSALS, never by prose. Every proposal is accepted or rejected at once by a deterministic verifier.',
  'Quote documents exactly; a number you cannot cite or have ngspice measure does not survive. Check the datasheet or spec, not your memory.',
  'A statement that something is absent needs the complete member list of the net, not a glance.',
  'A finding must name verified premises: at least one citation (what is required) and at least one fact or measurement (what the design does).',
  'Prefer a few fully grounded findings to many weak ones. When only a person, a measurement or a missing document can settle something, propose a question.',
  'Measurements run on the simulated circuit, which holds the modelled parts only; parts left unmodelled cannot be measured.',
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
  { name: 'kinux_open_viewer', description: 'A local URL (127.0.0.1) where the person can watch and read a run: the log, the score, the KiCad schematic, PCB and 3D board with every part coloured by the run, and the waveforms. Give the URL to the person.', inputSchema: OPTIONAL_RUN },
  { name: 'kinux_render', description: 'Render a finished run\'s 3D board with Blender, each part tinted by what the run found, for a report or a slide. Returns the image URL and a sidecar tracing it to the run. Needs Blender; takes seconds to a minute.', inputSchema: OPTIONAL_RUN },
];

const STR = { type: 'string', maxLength: 2000 };
export const REVIEW_TOOLS = [
  { name: 'kinux_review_bundle', description: 'The closed review bundle: every part, every net with its full member list, the documents you may cite, the automatic sweep, and the bundle hash. Everything you reason over is here.', inputSchema: NO_ARGS },
  { name: 'kinux_read_document', description: 'Read lines of a bundle document, numbered, so you can quote it exactly.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 200 }, from: { type: 'number', minimum: 1, maximum: 100000 }, to: { type: 'number', minimum: 1, maximum: 100000 } }, additionalProperties: false } },
  { name: 'kinux_propose', description: [
    'Submit ONE proposal; a deterministic verifier accepts or rejects it immediately, with the reason. Kinds:',
    'citation {doc, quote}: a verbatim quote (at least 12 characters) from a bundle document.',
    "fact {claim:'part_value', ref, value} | {claim:'connected', net, pins:['R4.1']} | {claim:'net_members', net, pins:[ALL members]}.",
    "measurement {probe:'V(NET)' or 'I(PART)', analysis:'op' or 'tran <step> <stop> [uic]', sources:{NET: volts}, at?}: ngspice measures it; you never supply a value.",
    'finding {title, severity: blocking|major|minor|info, premises:[ids], statement?}: accepted only if every premise is verified, with at least one citation and at least one fact or measurement.',
    'question {text}: something only a person, a measurement or a missing document can settle.',
    'Always set domain to your review domain.'].join(' '),
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['citation', 'fact', 'measurement', 'finding', 'question'] },
      domain: { type: 'string', maxLength: 40 },
      doc: { type: 'string', maxLength: 200 }, quote: STR,
      claim: { type: 'string', enum: ['part_value', 'connected', 'net_members'] }, ref: { type: 'string', maxLength: 40 }, value: { type: 'string', maxLength: 80 },
      net: { type: 'string', maxLength: 80 }, pins: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 200 },
      probe: { type: 'string', maxLength: 80 }, analysis: { type: 'string', maxLength: 80 }, sources: { type: 'object', maxProperties: 12 }, at: { type: 'string', maxLength: 20 },
      title: { type: 'string', maxLength: 200 }, severity: { type: 'string', enum: ['blocking', 'major', 'minor', 'info'] },
      premises: { type: 'array', items: { type: 'string', maxLength: 10 }, maxItems: 30 }, statement: STR, text: STR,
    } } },
  { name: 'kinux_get_review', description: 'The review so far: counts, and the report rendered only from what the verifiers accepted.', inputSchema: NO_ARGS },
];

export const VILLAIN_CONTRACT = [
  'You are the Villain: you try to break this design\'s check suite. Propose faults; Kinux applies each one, runs every check with ngspice, and measures how much the circuit\'s behaviour changed (harm).',
  'Your prize is a fault every check still passes but that changes behaviour (survived, harmful). A caught fault shows the checks work; that is also worth knowing.',
  'Read kinux_villain_brief first: parts, nets, checks and what they measure, the analyses, the grammar, and the fixed catalog. Aim where no check looks.',
  'To attack the whole design, split it: kinux_villain_plan lists every element; give each one to an element agent, which reads kinux_villain_brief with its ref and works through that element\'s fault modes. Tag every fault with agent.',
  'Harm is measured only under the analyses and sources the suite already has. A fault that matters only in a condition no block simulates shows no harm; say so rather than claim it.',
  'You never supply a result. NOT_CHECKED and ERROR are never a catch and never a miss. Finish with kinux_villain_report and tell the person which checks are missing, citing the evidence.',
].join('\n');

const FAULT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', enum: ['value', 'open', 'short', 'operator'] },
  ref: { type: 'string', maxLength: 40 }, pin: { type: 'number', minimum: 1, maximum: 64 },
  factor: { type: 'number', minimum: 0.001, maximum: 1000 },
  a: { type: 'string', maxLength: 80 }, b: { type: 'string', maxLength: 80 }, ohms: { type: 'number', minimum: 0.001, maximum: 1e9 },
  operator: { type: 'string', maxLength: 40 }, target: { type: 'string', maxLength: 80 },
  agent: { type: 'string', maxLength: 40, description: 'who is injecting: your element (e.g. "R4") or "lead"; recorded with the fault' },
} };

export const VILLAIN_TOOLS = [
  { name: 'kinux_villain_plan', description: 'How to split the attack: one entry per element with its nets, how many fault modes Kinux knows for it, how many checks observe it, and how many faults were already tried on it. A lead agent dispatches one element agent per entry.', inputSchema: NO_ARGS },
  { name: 'kinux_villain_brief', description: 'Without arguments: every part, net and check, the analyses, the grammar, the catalog and the faults tried so far. With ref: ONE element in depth: its pins and what else is on each net, the checks that observe it, every fault mode Kinux knows for it (in the grammar, ready to inject), and what was already tried on it.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', maxLength: 40 } }, additionalProperties: false } },
  { name: 'kinux_inject_fault', description: [
    'Inject ONE fault; Kinux runs every check on it and measures harm. Kinds:',
    'value {ref, factor 0.001..1000}: multiply a part\'s value.',
    'open {ref, pin}: disconnect one pin (1-based).',
    'short {a, b, ohms?}: connect two nets (b "0" = ground) through ohms (default 0.001).',
    'operator {operator, target}: a fault from the fixed catalog.',
    'Returns status (killed / survived / not_checked / error), which checks caught it, harm (largest relative change of a net voltage or source current) and the evidence.'].join(' '),
    inputSchema: FAULT_SCHEMA },
  { name: 'kinux_villain_report', description: 'The faults tried so far: counts, and the missed faults ranked by harm, each with the net and numbers that show it.', inputSchema: NO_ARGS },
];

export const TEAM_CONTRACT = [
  'Kinux has split this design into regions that meet at interface nets (the supply rails, ground, busy nets), the way a finite-element solver splits a model into elements.',
  'A lead claims each region (kinux_team_claim) and gives its lease to exactly ONE region agent. Only that agent can add checks there, and only checks that measure its own region. Interfaces belong to the lead.',
  'Every proposed check goes through one queue: it must parse, belong to the proposer\'s region, PASS on the design as drawn, catch at least one of the region\'s surviving faults, and leave the whole suite passing with the global score not lower. Only then is it committed.',
  'A check the design fails is not added: report it to the person as a possible design problem, with the measured value Kinux returned. Never loosen a limit just to get a check in.',
  'The lead alone adds stimulus blocks (a real operating condition the existing blocks do not cover) and may retract a committed check that is unrealistic. A block is a claim about how the board is used: state the condition, and never invent one just to make a fault visible.',
].join('\n');

export const TEAM_TOOLS = [
  { name: 'kinux_team_partition', description: 'The decomposition: every region with its parts, the nets it owns, its faults and current score, who holds its lease; the interface nets; the global score.', inputSchema: NO_ARGS },
  { name: 'kinux_team_claim', description: 'Claim a region and get its lease. One lease per region: give it to the one agent working there.',
    inputSchema: { type: 'object', properties: { region: { type: 'string', maxLength: 20 }, agent: { type: 'string', maxLength: 40 } }, additionalProperties: false } },
  { name: 'kinux_region_brief', description: 'One region in depth: its parts and values, what you may measure (V of its nets, I of its parts), the blocks you can add a check to (analysis and sources), the design\'s baseline measurements, the checks already in the region, and its surviving faults: your target.',
    inputSchema: { type: 'object', properties: { region: { type: 'string', maxLength: 20 } }, additionalProperties: false } },
  { name: 'kinux_propose_check', description: 'Propose ONE check line (the suite grammar, e.g. "V(NET) between 2.3 and 2.45" or "I(R4) between 2.7m and 3.3m") into one block, with your region and lease. Kinux judges it at once in the shared queue: committed (with the faults it now catches and the new scores) or rejected with the reason.',
    inputSchema: { type: 'object', properties: { region: { type: 'string', maxLength: 20 }, lease: { type: 'string', maxLength: 40 }, block: { type: 'string', maxLength: 10 },
      check: { type: 'string', maxLength: 200 }, agent: { type: 'string', maxLength: 40 } }, additionalProperties: false } },
  { name: 'kinux_propose_block', description: 'LEAD ONLY (the "interfaces" lease). Add a simulation block: an analysis (op, or "tran <step> <stop> [uic]") and the stimulus that puts the circuit in a REAL operating condition, e.g. the MCU sinking the LED cathodes, a USB-C source on CC, a load step. Say which condition in why. Kinux solves the design under it and returns every net\'s value, so specialists can centre their limits; it refuses a net already driven by the design, ground, or a block that does not solve. A block with no checks yet is not run.',
    inputSchema: { type: 'object', properties: { lease: { type: 'string', maxLength: 40 }, analysis: { type: 'string', maxLength: 80 },
      sources: { type: 'object', maxProperties: 12 }, why: { type: 'string', maxLength: 300 }, agent: { type: 'string', maxLength: 40 } }, additionalProperties: false } },
  { name: 'kinux_retract_check', description: 'LEAD ONLY. Take back a committed check you judge unrealistic (for example a window tighter than a real board holds). The faults only it caught survive again; the score falls honestly. Give the reason.',
    inputSchema: { type: 'object', properties: { lease: { type: 'string', maxLength: 40 }, commit: { type: 'string', maxLength: 10 }, reason: { type: 'string', maxLength: 300 }, agent: { type: 'string', maxLength: 40 } }, additionalProperties: false } },
  { name: 'kinux_team_status', description: 'Every region\'s score, the global score, the suite\'s hash, and every commit (who, where, what it catches).', inputSchema: NO_ARGS },
];

export const DESIGNER_CONTRACT = [
  'You change the DESIGN so it meets its checks. The checks are fixed in this role: you cannot read, add, loosen or remove one.',
  'Every edit happens in a copy of the KiCad project. Kinux keeps it only if it reaches the simulated circuit, adds no ERC violation, breaks no check that passed, and makes at least one failing check pass; otherwise the copy is put back.',
  'State the requirement each edit serves (why). Prefer standard values (E24 for resistors, E12 for capacitors) and real parts. A person reviews the diff and applies it; say what you changed and why, with the numbers Kinux measured.',
].join('\n');

export const DESIGNER_TOOLS = [
  { name: 'kinux_design_brief', description: 'The design and its checks as they stand in your copy: every check with its verdict and measured value (failing ones listed), every part with its value and how it is simulated, the simulated circuit, the model files you may switch a part to, ERC, and your edits so far.', inputSchema: NO_ARGS },
  { name: 'kinux_propose_edit', description: [
    'Propose ONE design edit; Kinux rebuilds and re-runs everything and keeps it or puts it back, saying why. Kinds:',
    'value {ref, value, why}: set a part\'s Value (KiCad notation: 4k7, 2.2u, 100n).',
    'model {ref, file, subckt|model, ports?, why}: simulate the part with another model from the model directory.',
    'Returns kept (with the checks it fixed and every measured value that moved) or rejected (regression, fixes_nothing, erc, no_effect, refused).'].join(' '),
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['value', 'model'] }, ref: { type: 'string', maxLength: 40 }, value: { type: 'string', maxLength: 40 },
      file: { type: 'string', maxLength: 80 }, subckt: { type: 'string', maxLength: 80 }, model: { type: 'string', maxLength: 80 },
      ports: { type: 'array', items: { type: 'string', maxLength: 8 }, maxItems: 16 }, why: { type: 'string', maxLength: 300 } } } },
  { name: 'kinux_design_wait', description: `Wait up to ${WAIT_CAP_SECONDS} seconds for a pending brief or edit (by the id a call returned with status "pending"), then return its result, or "pending" again. A real design can take minutes to rebuild and re-check; never errors on timeout, call it again.`,
    inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 20 } }, additionalProperties: false } },
  { name: 'kinux_design_diff', description: 'What the session changed: a diff of the schematic and sidecar against the originals, every kept edit with its reason and the checks it fixed, and where the edited copy is. The person applies it; Kinux never writes the originals.', inputSchema: NO_ARGS },
];

class ToolError extends Error {
  constructor(type, message, extra = {}) { super(message); this.type = type; this.extra = extra; }
}

/** Parse launch arguments. Throws on anything missing or unknown. */
export function parseLaunchArgs(argv) {
  const opts = {};
  const known = new Set(['design', 'checks', 'sidecar', 'model-dir', 'thermal-model', 'runs-dir', 'intent', 'ngspice-compat', 'jobs', 'cache', 'call-log',
    'role', 'doc', 'review-log', 'villain-log', 'budget', 'regions', 'suite-out']);
  const literal = new Set(['ngspice-compat', 'jobs', 'role', 'budget', 'regions']);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--') || !known.has(flag.slice(2)) || argv[i + 1] === undefined) {
      throw new Error(`unknown or incomplete argument "${flag}"`);
    }
    const key = flag.slice(2);
    const value = literal.has(key) ? argv[i + 1] : resolve(argv[i + 1]);
    if (key === 'suite-out' && existsSync(value) && !/\.md$/i.test(value)) throw new Error('--suite-out must be a .md file');
    if (key === 'doc') (opts.doc ??= []).push(value);
    else opts[key] = value;
  }
  opts.role ??= 'builder';
  if (!['builder', 'reviewer', 'villain', 'team', 'designer'].includes(opts.role)) throw new Error('--role is builder, reviewer, villain, team or designer');
  if (opts.role === 'designer' && !/\.kicad_sch$/i.test(opts.design ?? '')) throw new Error('--role designer edits a KiCad design: --design must be a .kicad_sch');
  if (opts.regions !== undefined && !(/^\d+$/.test(opts.regions) && Number(opts.regions) >= 1 && Number(opts.regions) <= 32)) throw new Error('--regions must be a whole number from 1 to 32');
  for (const req of opts.role === 'reviewer' ? ['design'] : ['design', 'checks']) if (!opts[req]) throw new Error(`--${req} is required`);
  if (opts.budget !== undefined && !(/^\d+$/.test(opts.budget) && Number(opts.budget) >= 1 && Number(opts.budget) <= 1000)) throw new Error('--budget must be a whole number from 1 to 1000');
  for (const d of opts.doc ?? []) if (!existsSync(d)) throw new Error(`--doc ${d} does not exist`);
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
  // Agent activity for the viewer: one compact line per tool call, written by
  // the server from what it decided, never by the agent. Capped.
  const activity = [];
  const summarise = (tool, r) => {
    if (!r || typeof r !== 'object') return {};
    const keep = ['run_id', 'state', 'score_text', 'status', 'reason', 'id', 'kind', 'error', 'message', 'verified', 'rejected', 'open', 'proposals',
      'description', 'harm', 'harmful', 'killed_by', 'tried', 'killed', 'survived', 'code', 'region', 'check', 'global_after', 'why'];
    const out = Object.fromEntries(keep.filter(k => r[k] !== undefined).map(k => [k, typeof r[k] === 'string' ? r[k].slice(0, 300) : r[k]]));
    if (r.evidence?.measured !== undefined) out.measured = r.evidence.measured;
    if (r.evidence?.line !== undefined) out.cited_line = `${r.evidence.doc}:${r.evidence.line}`;
    if (Array.isArray(r.survivors)) out.survivors = r.survivors.length;
    return out;
  };
  const callLog = entry => {
    const line = { ts: new Date().toISOString(), role: opts.role ?? 'builder', tool: entry.tool, isError: entry.isError,
      arguments: JSON.parse(JSON.stringify(entry.arguments ?? {}, (k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v))),
      result: summarise(entry.tool, entry.result) };
    activity.push(line);
    if (activity.length > 2000) activity.shift();
    if (opts['call-log']) appendFileSync(opts['call-log'], `${JSON.stringify({ ts: line.ts, ...entry })}\n`);
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

  // The local viewer server starts on first use (kinux_open_viewer, kinux_render).
  let viewerPromise = null;
  const getViewer = () => (viewerPromise ??= import('./viewer-server.mjs')
    .then(m => m.startViewerServer({ runsDir, viewerRoot: join(ROOT, 'viewer'), activity: () => activity })));

  let reviewPromise = null;
  const getReview = () => (reviewPromise ??= (async () => {
    const { buildBundle, createReview } = await import('../engine/review.mjs');
    let design, deck, sweep = null;
    if (/\.kicad_sch$/i.test(opts.design)) {
      const { buildDesign } = await import('../engine/kicad-adapter.mjs');
      const built = await buildDesign({ schematic: opts.design, sidecar: opts.sidecar, modelDir: opts['model-dir'], intent: opts.intent });
      design = { comps: built.comps, nets: built.nets };
      deck = built.netlist;
      sweep = { checkable_fraction: built.manifest.counts.checkable_fraction, not_checked: built.manifest.excluded, connectivity: built.manifest.notes };
    } else {
      const { parseNetlist } = await import('../engine/netlist.mjs');
      deck = readFileSync(opts.design, 'utf8');
      const nl = parseNetlist(deck);
      const nets = new Map();
      for (const c of nl.components) c.nodes.forEach((n, i) => { if (!nets.has(n)) nets.set(n, []); nets.get(n).push({ ref: c.refdes, pin: String(i + 1) }); });
      design = { comps: nl.components.map(c => ({ ref: c.refdes, value: c.tail[0] ?? '' })), nets: [...nets].map(([name, nodes]) => ({ name, nodes })) };
    }
    const bundle = buildBundle({ design, deck, documents: (opts.doc ?? []).map(path => ({ path })), sweep, compat: opts['ngspice-compat'] ?? null });
    return createReview(bundle);
  })());

  const reviewTools = {
    kinux_review_bundle: async () => {
      const { describeBundle } = await import('../engine/review.mjs');
      return describeBundle((await getReview()).bundle);
    },
    kinux_read_document: async (args = {}) => {
      const { readDocument } = await import('../engine/review.mjs');
      const doc = readDocument((await getReview()).bundle, args.name, args.from ?? 1, args.to ?? Infinity);
      if (!doc) throw new ToolError('unknown_document', `no document "${args.name}" in the bundle`);
      return doc;
    },
    kinux_propose: async (args = {}) => {
      const r = await getReview();
      const { domain, ...proposal } = args;
      const entry = await r.propose(proposal, { domain: domain ?? null });
      if (opts['review-log']) appendFileSync(opts['review-log'], `${JSON.stringify(entry)}\n`);
      return { id: entry.id, kind: entry.kind, status: entry.status, ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.evidence ? { evidence: entry.evidence } : {}) };
    },
    kinux_get_review: async () => {
      const { renderReport } = await import('../engine/review.mjs');
      const r = await getReview();
      const count = k => r.log.filter(e => e.status === k).length;
      return { bundle_hash: r.bundle.hash, proposals: r.log.length, verified: count('verified'), rejected: count('rejected'), open: count('open'), report: renderReport(r) };
    },
  };

  let villainPromise = null;
  const getVillain = () => (villainPromise ??= (async () => {
    const { createVillain } = await import('../engine/villain.mjs');
    const { loadSuite } = await import('../engine/cli.mjs');
    let netlist;
    if (/\.kicad_sch$/i.test(opts.design)) {
      const { buildDesign } = await import('../engine/kicad-adapter.mjs');
      netlist = (await buildDesign({ schematic: opts.design, sidecar: opts.sidecar, modelDir: opts['model-dir'], intent: opts.intent })).netlist;
    } else netlist = readFileSync(opts.design, 'utf8');
    const v = createVillain({ netlist, suite: loadSuite(opts.checks), compat: opts['ngspice-compat'] ?? null, budget: Number(opts.budget ?? 200) });
    await v.init();
    return v;
  })());

  const villainTools = {
    kinux_villain_plan: async () => (await getVillain()).plan(),
    kinux_villain_brief: async (args = {}) => {
      const { VillainError } = await import('../engine/villain.mjs');
      try { return await (await getVillain()).brief(args); } catch (e) { if (e instanceof VillainError) throw new ToolError('refused', e.message); throw e; }
    },
    kinux_inject_fault: async (args = {}) => {
      const v = await getVillain();
      const { VillainError } = await import('../engine/villain.mjs');
      let rec;
      const { agent, ...fault } = args;
      try { rec = await v.inject(fault, { agent: agent ?? null }); } catch (e) {
        if (e instanceof VillainError) throw new ToolError('refused', e.message);
        throw e;
      }
      if (opts['villain-log']) appendFileSync(opts['villain-log'], `${JSON.stringify(rec)}\n`);
      const { results, ...brief } = rec;
      return { ...brief, checks_run: results.length };
    },
    kinux_villain_report: async () => (await getVillain()).report(),
  };

  let teamPromise = null;
  const getTeam = () => (teamPromise ??= (async () => {
    const { createTeam } = await import('../engine/team.mjs');
    const { loadSuite } = await import('../engine/cli.mjs');
    let netlist, partInfo = {};
    if (/\.kicad_sch$/i.test(opts.design)) {
      const { buildDesign } = await import('../engine/kicad-adapter.mjs');
      const built = await buildDesign({ schematic: opts.design, sidecar: opts.sidecar, modelDir: opts['model-dir'], intent: opts.intent });
      netlist = built.netlist;
      // The KiCad library entry of every part tells the team what kind of element it is.
      partInfo = Object.fromEntries(built.manifest.parts.map(p => [p.ref, { lib: p.lib, part: p.part }]));
    } else netlist = readFileSync(opts.design, 'utf8');
    const t = createTeam({ netlist, suite: loadSuite(opts.checks), compat: opts['ngspice-compat'] ?? null, k: Number(opts.regions ?? 6), jobs: Number(opts.jobs ?? 4), partInfo });
    await t.partition();
    return t;
  })());
  const teamErr = async fn => {
    const { TeamError } = await import('../engine/team.mjs');
    try { return await fn(); } catch (e) { if (e instanceof TeamError) throw new ToolError('refused', e.message); throw e; }
  };
  const teamTools = {
    kinux_team_partition: async () => (await getTeam()).partition(),
    kinux_team_claim: async (args = {}) => teamErr(async () => (await getTeam()).claim(args.region, args.agent ?? null)),
    kinux_region_brief: async (args = {}) => teamErr(async () => (await getTeam()).brief(args.region)),
    kinux_propose_check: async (args = {}) => {
      const t = await getTeam();
      const r = await t.propose(args);
      if (r.status === 'committed' && opts['suite-out']) writeFileSync(opts['suite-out'], `${t.render()}\n`);
      const { region_after, ...rest } = r;
      return { ...rest, ...(region_after ? { region_score: region_after.score, region_survivors: region_after.survived } : {}) };
    },
    kinux_propose_block: async (args = {}) => {
      const t = await getTeam();
      return t.proposeBlock(args);
    },
    kinux_retract_check: async (args = {}) => {
      const t = await getTeam();
      const r = await t.retract(args);
      if (r.status === 'retracted' && opts['suite-out']) writeFileSync(opts['suite-out'], `${t.render()}\n`);
      return r;
    },
    kinux_team_status: async () => (await getTeam()).status(),
  };

  let designPromise = null;
  const getDesign = () => (designPromise ??= (async () => {
    const { createDesignSession } = await import('../engine/design-session.mjs');
    const { loadSuite } = await import('../engine/cli.mjs');
    return createDesignSession({ schematic: opts.design, sidecar: opts.sidecar, modelDir: opts['model-dir'], intent: opts.intent,
      suite: loadSuite(opts.checks), compat: opts['ngspice-compat'] ?? null });
  })());
  // A real design takes minutes to rebuild and re-check; MCP clients give up on a tool call
  // after about a minute. Long work runs as a job: a call that would outlast the cap returns
  // "pending" with an id, and kinux_design_wait collects it.
  const jobs = new Map();
  let jobN = 0;
  const asJob = async (work, waitMs = (WAIT_CAP_SECONDS - 5) * 1000) => {
    const id = `J${++jobN}`;
    const job = { done: false, value: undefined, error: null };
    job.promise = work().then(v => { job.done = true; job.value = v; }, e => { job.done = true; job.error = e; });
    jobs.set(id, job);
    await Promise.race([job.promise, new Promise(r => setTimeout(r, waitMs))]);
    if (!job.done) return { status: 'pending', id, note: 'Kinux is still rebuilding and re-checking the design. Call kinux_design_wait with this id.' };
    jobs.delete(id);
    if (job.error) throw job.error;
    return job.value;
  };
  const designerTools = {
    kinux_design_brief: () => asJob(async () => (await getDesign()).brief()),
    kinux_propose_edit: (args = {}) => asJob(async () => (await getDesign()).propose(args)),
    kinux_design_wait: async (args = {}) => {
      const job = jobs.get(args.id);
      if (!job) throw new ToolError('unknown_job', `no pending job ${args.id}; it may already have been collected`);
      await Promise.race([job.promise, new Promise(r => setTimeout(r, (WAIT_CAP_SECONDS - 5) * 1000))]);
      if (!job.done) return { status: 'pending', id: args.id, note: 'still working; call kinux_design_wait again' };
      jobs.delete(args.id);
      if (job.error) throw job.error;
      return job.value;
    },
    kinux_design_diff: async () => (await getDesign()).diff(),
  };
  // Start preparing at launch: the first brief should not wait for the whole first build.
  if ((opts.role ?? 'builder') === 'designer') getDesign().then(d => d.brief()).catch(() => {});

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
      // --waveforms: a person may open this run, so record the original design's transients for the viewer.
      const args = [CLI, 'verify', opts.design, '--checks', opts.checks, '--out', out, '--threshold', '0', '--quiet', '--run-id', id, '--waveforms'];
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

    kinux_open_viewer: async args => {
      const run = pick(args);
      const v = await getViewer();
      return { run_id: run.id, state: run.state, viewer_url: v.viewerUrl(run.id), report_md_url: v.fileUrl(run.id, 'report.md'),
        note: run.state === 'running' ? 'The run is still going: reload the page to see more of it.' : 'Local to this machine. The page reads the run\'s own files; nothing is uploaded.' };
    },

    kinux_render: async args => {
      const run = pick(args);
      if (run.state !== 'done') throw new ToolError('not_done', `run ${run.id} is ${run.state}; render a finished run`);
      const { renderRun } = await import('../engine/render.mjs');
      let side;
      try { side = await renderRun(run.out, { out: join(run.out, 'render.png'), samples: 32, width: 1600, height: 1000 }); }
      catch (e) { throw new ToolError(e.code === 3 ? 'blender_missing' : e.code === 2 ? 'no_board' : 'render_failed', e.message); }
      const v = await getViewer();
      return { run_id: run.id, image_url: v.fileUrl(run.id, 'render.png'), sidecar_url: v.fileUrl(run.id, 'render.json'),
        tinted: side.tinted_in_image, legend: side.legend, renderer: side.renderer,
        note: 'Colours are the worst mutant per part from this run; the geometry is KiCad\'s export. A picture, not a verdict.' };
    },
  };

  const role = opts.role ?? 'builder';
  const toolset = { reviewer: REVIEW_TOOLS, villain: VILLAIN_TOOLS, team: TEAM_TOOLS, designer: DESIGNER_TOOLS }[role] ?? TOOLS;
  const impl = { reviewer: reviewTools, villain: villainTools, team: teamTools, designer: designerTools }[role] ?? tools;

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
      if (sch.type === 'string' && ((sch.enum && !sch.enum.includes(v)) || (sch.maxLength && v.length > sch.maxLength))) {
        throw new ToolError('invalid_arguments', `${k} must be ${sch.enum ? `one of ${sch.enum.join(', ')}` : `at most ${sch.maxLength} characters`}`);
      }
      if (sch.type === 'array' && (!Array.isArray(v) || v.length > (sch.maxItems ?? Infinity) || v.some(x => typeof x !== 'string' || x.length > (sch.items?.maxLength ?? Infinity)))) {
        throw new ToolError('invalid_arguments', `${k} must be a list of short strings`);
      }
      if (sch.type === 'object' && (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length > (sch.maxProperties ?? Infinity)
        || Object.entries(v).some(([kk, vv]) => !/^[A-Za-z_/][A-Za-z0-9_./:+-]*$/.test(kk) || typeof vv !== 'number' || !Number.isFinite(vv)))) {
        throw new ToolError('invalid_arguments', `${k} must map net names to numbers`);
      }
    }
    return args;
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'kinux', version: '0.1.0' }, instructions: role === 'reviewer' ? REVIEW_CONTRACT : role === 'villain' ? VILLAIN_CONTRACT : role === 'team' ? TEAM_CONTRACT : role === 'designer' ? DESIGNER_CONTRACT : VERDICT_CONTRACT };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: toolset.map(t => ({ ...t, _meta: { schemaVersion: SCHEMA_VERSION, role: opts.role } })) };
    if (method === 'tools/call') {
      const tool = toolset.find(t => t.name === params?.name);
      if (!tool) throw Object.assign(new Error(`unknown tool ${params?.name}`), { code: -32602 });
      try {
        const args = validateArgs(tool, params.arguments);
        const result = await impl[tool.name](args);
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
    if (viewerPromise) viewerPromise.then(v => v.close()).catch(() => {});
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
