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
import { makeReceipt } from './receipt.mjs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSimulationBlocks } from '../workers/ngspice/assertions.mjs';
import { parseThermalBlocks } from '../workers/thermal/assertions.mjs';
import { checkRun } from '../contracts/check-run.mjs';
import { runVerification } from './runner.mjs';
import { buildReport, finishRun, renderMarkdown, scoreLine } from './report.mjs';
import { buildDesign, formatSummary, unknownCheckNets, renderDesignSection } from './kicad-adapter.mjs';

export const USAGE = `kinux verify -- mutation-test a circuit's check suite

  node engine/cli.mjs verify <design.cir> --checks <checks.md|checks.json> [options]
  node engine/cli.mjs verify <design.kicad_sch> --sidecar <json> --checks <checks.md> [options]

  A .kicad_sch is exported with the real kicad-cli and turned into a SPICE deck
  (engine/kicad-adapter.mjs). Parts with no model are NOT simulated and are listed
  with a reason; the checkable fraction is printed and written to design-model.json.
  Exit status 4 means nothing in the design was checkable and no score is claimed.

  --sidecar <json>    sources and model mappings for a KiCad design (schema in the
                      header of engine/kicad-adapter.mjs)
  --model-dir <dir>   the only directory model files may be read from (default:
                      the sidecar's own directory)
  --intent <json>     a schematic.intent.json; connectivity is compared with it and
                      every mismatch is listed
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
  --thermal-model <f> JSON lumped thermal model for "## Thermal" blocks in --checks
                      (see workers/thermal/README.md). Without it, every T()
                      check is NOT_CHECKED (no_material_data).
  --no-queue          run mutants directly instead of through server/queue
  --timeout <ms>      per-simulation timeout (default 20000)
  --serve [port]      stream the run live over SSE while it executes, and keep
                      serving it afterwards so it can be watched or replayed.
                      0 or omitted picks a free port. The run still writes its
                      own events.jsonl: the file is the record, the stream is
                      a view of it, and a viewer that drops never fails a run.
  --json              print the report as JSON on stdout instead of text
  --quiet             print nothing but the exit status
  -h, --help          this text
`;

/** Parse argv into an options object. Pure, so the tests can use it. */
export function parseArgs(argv) {
  const out = { command: null, design: null, checks: null, out: 'kinux-run', threshold: 0.7, limit: Infinity, operators: null, runId: null, project: null, useQueue: true, timeoutMs: undefined, json: false, quiet: false, help: false, serve: false, port: 0, thermalModel: null, sidecar: null, modelDir: null, intent: null };
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
      case '--thermal-model': out.thermalModel = next(); break;
      case '--sidecar': out.sidecar = next(); break;
      case '--model-dir': out.modelDir = next(); break;
      case '--intent': out.intent = next(); break;
      // --serve takes an OPTIONAL port, so only consume the next argv entry
      // when it really is one. "--serve --json" must not eat "--json".
      case '--serve': {
        out.serve = true;
        const peek = argv[i + 1];
        if (peek !== undefined && /^\d+$/.test(peek)) { out.port = Number(argv[++i]); }
        break;
      }
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
  const blocks = [...parseSimulationBlocks(text), ...parseThermalBlocks(text)];
  if (!blocks.length) throw new Error(`${path} contains no "## Simulation" or "## Thermal" block`);
  return { id: 'checks', title: null, blocks };
}

/** The whole command. Returns the exit code; never calls process.exit itself. */
/** Exit codes: 0 pass, 1 below threshold, 2 usage or input error, 3 event contract problem, 4 nothing checkable. */
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

  let netlist, suite, designModel = null, schematicText = null;
  const isKicad = extname(opts.design).toLowerCase() === '.kicad_sch';
  if (isKicad) {
    try {
      const built = await buildDesign({ schematic: resolve(opts.design), sidecar: opts.sidecar ? resolve(opts.sidecar) : undefined, modelDir: opts.modelDir ? resolve(opts.modelDir) : undefined, intent: opts.intent ? resolve(opts.intent) : undefined });
      netlist = built.netlist;
      designModel = built.manifest;
      schematicText = readFileSync(resolve(opts.design), 'utf8');
    } catch (e) {
      err(`could not build a netlist from the KiCad design: ${e.message}`);
      return 2;
    }
    if (!opts.quiet) log(formatSummary(designModel));
    mkdirSync(resolve(opts.out), { recursive: true });
    writeFileSync(join(resolve(opts.out), 'design.cir'), netlist, 'utf8');
    writeFileSync(join(resolve(opts.out), 'design-model.json'), JSON.stringify(designModel, null, 2) + '\n', 'utf8');
    if (designModel.counts.modelled === 0) {
      // Nothing was simulated, so there is nothing to score. Say so and stop:
      // a score here would be a number about an empty circuit.
      err('nothing in this design is checkable: no part has a model, so no mutation score is claimed. See design-model.json for every part and its reason.');
      return 4;
    }
  } else if (opts.sidecar || opts.modelDir || opts.intent) {
    err('--sidecar, --model-dir and --intent only apply to a .kicad_sch design');
    return 2;
  }
  try {
    if (!isKicad) netlist = readFileSync(resolve(opts.design), 'utf8');
    suite = loadSuite(resolve(opts.checks));
    if (opts.thermalModel) suite.thermalModel = JSON.parse(readFileSync(resolve(opts.thermalModel), 'utf8'));
  } catch (e) {
    err(`could not read the inputs: ${e.message}`);
    return 2;
  }
  if (designModel) {
    const bad = unknownCheckNets(suite, designModel, netlist);
    if (bad.length) {
      for (const b of bad) err(`check net "${b.name}" (${b.where}) is not a node of the generated deck: ${b.hint}`);
      err('refusing to run: a check on a name the deck does not have would pass or drive the wrong node. Fix the names in the checks, or add a sidecar alias.');
      return 2;
    }
  }

  let operators;
  if (opts.operators) {
    const { OPERATORS } = await import('./operators.mjs');
    operators = OPERATORS.filter(o => opts.operators.includes(o.id));
    if (!operators.length) { err(`no operator matches ${opts.operators.join(',')}`); return 2; }
  }

  const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;

  // Start serving BEFORE the run, and print the URL first, so a viewer can be
  // attached in time to watch the baseline go by rather than arriving at the end.
  let live = null;
  if (opts.serve) {
    try {
      const { serveRun } = await import('./live.mjs');
      const { createRunServer } = await import('../server/run/server.mjs');
      const { validateEvent } = await import('../contracts/check-run.mjs');
      live = await serveRun({
        createRunServer,
        validate: validateEvent,
        runId,
        root: io.serveRoot ?? join(resolve(opts.out), 'server'),
        port: opts.port,
        viewerRoot: join(dirname(fileURLToPath(import.meta.url)), '..', 'viewer'),
      });
    } catch (e) {
      err(`could not start the run server: ${e.message}`);
      return 2;
    }
    if (!opts.quiet) {
      log(`serving run ${runId} at ${live.base}`);
      log(`  WATCH IT:  ${live.viewerUrl}`);
      log(`  live SSE:  ${live.eventsUrl}`);
      log(`  full log:  ${live.jsonlUrl}`);
    }
    if (io.onServe) io.onServe(live);
  }

  let outcome;
  try {
    outcome = await runVerification({
      onEvent: live ? live.bridge.sink : undefined,
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
    // A listening server is an open handle: left alone it would keep the
    // process alive after a failed run, which looks like a hang.
    if (live) await live.close();
    return 2;
  }

  const report = buildReport(outcome, { threshold: opts.threshold });
  if (designModel) report.design_model = { checkable_fraction: designModel.counts.checkable_fraction, modelled: designModel.counts.modelled, electrical: designModel.counts.electrical, not_checked: designModel.counts.by_reason };
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
  writeFileSync(paths.markdown, (designModel ? renderDesignSection(designModel) + '\n' : '') + renderMarkdown(report), 'utf8');
  writeFileSync(paths.json, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(paths.events, outcome.stream.toJSONL(), 'utf8');
  paths.receipt = join(dir, 'receipt.json');
  const receipt = makeReceipt({ outcome, report, inputs: [{ path: opts.design, text: isKicad ? schematicText : netlist }, ...(isKicad ? [{ path: 'design.cir', text: netlist }] : []), { path: opts.checks, text: readFileSync(opts.checks, 'utf8') }], operators, limit: opts.limit });
  writeFileSync(paths.receipt, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  report.receipt_id = receipt.receipt_id;
  report.written = paths;

  if (!opts.quiet) {
    if (opts.json) {
      log(JSON.stringify(report, null, 2));
    } else {
      if (designModel) log(`score covers the modelled subset only: ${designModel.counts.modelled} of ${designModel.counts.electrical} electrical parts (${(designModel.counts.checkable_fraction * 100).toFixed(1)}%)`);
      log(`mutation score: ${scoreLine(report.score)}`);
      if (report.cap) log(`CAP at ${(report.cap.applied_at * 100).toFixed(1)}%${report.cap.bites ? '' : ' (does not bite)'}: ${report.cap.gates.map(g => g.code).join(', ')}`);
      log(`capped score: ${report.effective_score === null ? 'not checkable' : `${(report.effective_score * 100).toFixed(1)}%`} (threshold ${(opts.threshold * 100).toFixed(1)}%)`);
      log(`events: ${events.length} -> ${paths.events}${problems.length ? ` (${problems.length} contract problem(s)!)` : ' (contract-clean)'}`);
      log(`report: ${paths.markdown}`);
      for (const p of problems) err(`contract problem: ${p}`);
    }
  }

  const code = problems.length ? 3 : (report.passed_threshold ? 0 : 1);

  if (live) {
    // Delivery is reported, never folded into the exit code: the exit code is
    // the verification's verdict, and a viewer that dropped does not change
    // what the solver measured. It is printed on stderr, loudly, because a
    // seq divergence means the engine and the server disagree about the log.
    if (live.bridge.ok) {
      if (!opts.quiet && !opts.json) log(`live: ${live.bridge.summary()}`);
    } else {
      err(`live stream INCOMPLETE: ${live.bridge.summary()}`);
      err(`  the run itself is unaffected; ${join(resolve(opts.out), 'events.jsonl')} is the complete record`);
    }

    // Keep serving so the finished run can still be opened and replayed. main()
    // must not return here, because the caller's process.exit() would tear the
    // server down the instant the run ended. Tests pass holdServer: false.
    if (io.holdServer !== false) {
      if (!opts.quiet && !opts.json) log(`run finished; still serving ${live.base} -- Ctrl-C to stop`);
      await new Promise(done => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
      });
    }
    await live.close();
  }

  return code;
}

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) process.exit(await main(process.argv.slice(2)));
