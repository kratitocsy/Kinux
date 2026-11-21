#!/usr/bin/env node
// `kinux verify` -- the mutation engine's entry point.
//
//   node engine/cli.mjs verify <design.cir> --checks <checks.md|checks.json> [options]
//
// Runs the baseline, generates mutants, runs each one through the real ngspice
// worker, scores the suite and writes three files into --out:
//
//   report.md      the human report, with the score, its interval and the cap
//   report.json    the same thing as data
//   events.jsonl   the contract event stream (passes contracts/checkRun)
//
// Exits 1 when the capped score is below --threshold, 2 on a usage or input
// error. package.json is frozen, so there is no `npm run verify`; the full
// invocation is in engine/README.md.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { parseSimulationBlocks } from '../workers/ngspice/assertions.mjs';
import { checkRun } from '../contracts/check-run.mjs';
import { runVerification } from './runner.mjs';
import { buildReport, finishRun, renderMarkdown, scoreLine } from './report.mjs';

export const USAGE = `kinux verify -- mutation-test a circuit's check suite

  node engine/cli.mjs verify <design.cir> --checks <checks.md|checks.json> [options]

  --checks <file>     required; a Markdown file with "## Simulation" blocks, or
                      JSON: { "blocks": [ { "analysis": "op",
                                            "assertions": ["V(out) between 2.3 and 2.4"] } ] }
  --out <dir>         where report.md, report.json and events.jsonl are written
                      (default: ./kinux-run)
  --threshold <0..1>  exit non-zero when the capped score is below this (default 0.7)
  --limit <n>         stop after n mutants
  --operators <ids>   comma-separated operator ids (default: all)
  --run-id <id>       run id for the event stream (default: generated)
  --project <name>    project name recorded in the report (default: the design's filename)
  --no-queue          run mutants directly instead of through server/queue
  --timeout <ms>      per-simulation timeout (default 20000)
  --json              print the report as JSON on stdout instead of text
  --quiet             print nothing but the exit status
  -h, --help          this text
`;

/** Parse argv into an options object. Pure, so the tests can use it. */
export function parseArgs(argv) {
  const out = { command: null, design: null, checks: null, out: 'kinux-run', threshold: 0.7, limit: Infinity, operators: null, runId: null, project: null, useQueue: true, timeoutMs: undefined, json: false, quiet: false, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '--checks': out.checks = next(); break;
      case '--out': out.out = next(); break;
      case '--threshold': out.threshold = Number(next()); break;
      case '--limit': out.limit = Number(next()); break;
      case '--operators': out.operators = next().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--run-id': out.runId = next(); break;
      case '--project': out.project = next(); break;
      case '--no-queue': out.useQueue = false; break;
      case '--timeout': out.timeoutMs = Number(next()); break;
      case '--json': out.json = true; break;
      case '--quiet': out.quiet = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        rest.push(a);
    }
  }
  out.command = rest[0] ?? null;
  out.design = rest[1] ?? null;
  if (!Number.isFinite(out.threshold) || out.threshold < 0 || out.threshold > 1) throw new Error('--threshold must be a number between 0 and 1');
  return out;
}

/**
 * Load a check suite from a file. Markdown goes through the worker's own
 * `## Simulation` parser, so the CLI speaks exactly the assertion grammar the
 * worker speaks and nothing else.
 */
export function loadSuite(path) {
  const text = readFileSync(path, 'utf8');
  if (extname(path).toLowerCase() === '.json') {
    const parsed = JSON.parse(text);
    const blocks = Array.isArray(parsed) ? parsed : parsed.blocks;
    if (!Array.isArray(blocks) || !blocks.length) throw new Error(`${path} has no "blocks"`);
    return { id: parsed.id ?? 'checks', title: parsed.title ?? null, blocks };
  }
  const blocks = parseSimulationBlocks(text);
  if (!blocks.length) throw new Error(`${path} contains no "## Simulation" block`);
  return { id: 'checks', title: null, blocks };
}

/** The whole command. Returns the exit code; never calls process.exit itself. */
export async function main(argv, io = {}) {
  const log = io.log ?? (s => process.stdout.write(s + '\n'));
  const err = io.error ?? (s => process.stderr.write(s + '\n'));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err(String(e.message));
    err(USAGE);
    return 2;
  }
  if (opts.help || !opts.command) { log(USAGE); return opts.help ? 0 : 2; }
  if (opts.command !== 'verify') { err(`unknown command "${opts.command}"`); err(USAGE); return 2; }
  if (!opts.design) { err('a design netlist is required'); err(USAGE); return 2; }
  if (!opts.checks) { err('--checks is required'); err(USAGE); return 2; }

  let netlist, suite;
  try {
    netlist = readFileSync(resolve(opts.design), 'utf8');
    suite = loadSuite(resolve(opts.checks));
  } catch (e) {
    err(`could not read the inputs: ${e.message}`);
    return 2;
  }

  let operators;
  if (opts.operators) {
    const { OPERATORS } = await import('./operators.mjs');
    operators = OPERATORS.filter(o => opts.operators.includes(o.id));
    if (!operators.length) { err(`no operator matches ${opts.operators.join(',')}`); return 2; }
  }

  const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  let outcome;
  try {
    outcome = await runVerification({
      netlist,
      suite,
      operators,
      limit: opts.limit,
      runId,
      project: opts.project ?? opts.design,
      designRef: opts.design,
      useQueue: opts.useQueue,
      timeoutMs: opts.timeoutMs,
    });
  } catch (e) {
    err(`the run could not start: ${e.message}`);
    return 2;
  }

  const report = buildReport(outcome, { threshold: opts.threshold });
  const events = finishRun(outcome, report);
  const problems = checkRun(events);
  report.event_stream = { events: events.length, problems };

  const dir = resolve(opts.out);
  mkdirSync(dir, { recursive: true });
  const paths = {
    markdown: join(dir, 'report.md'),
    json: join(dir, 'report.json'),
    events: join(dir, 'events.jsonl'),
  };
  writeFileSync(paths.markdown, renderMarkdown(report), 'utf8');
  writeFileSync(paths.json, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(paths.events, outcome.stream.toJSONL(), 'utf8');
  report.written = paths;

  if (!opts.quiet) {
    if (opts.json) {
      log(JSON.stringify(report, null, 2));
    } else {
      log(`mutation score: ${scoreLine(report.score)}`);
      if (report.cap) log(`CAP at ${(report.cap.applied_at * 100).toFixed(1)}%${report.cap.bites ? '' : ' (does not bite)'}: ${report.cap.gates.map(g => g.code).join(', ')}`);
      log(`capped score: ${report.effective_score === null ? 'not checkable' : `${(report.effective_score * 100).toFixed(1)}%`} (threshold ${(opts.threshold * 100).toFixed(1)}%)`);
      log(`events: ${events.length} -> ${paths.events}${problems.length ? ` (${problems.length} contract problem(s)!)` : ' (contract-clean)'}`);
      log(`report: ${paths.markdown}`);
      for (const p of problems) err(`contract problem: ${p}`);
    }
  }

  if (problems.length) return 3;
  return report.passed_threshold ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) process.exit(await main(process.argv.slice(2)));
