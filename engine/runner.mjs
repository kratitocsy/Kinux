// The mutation runner: baseline first, then every mutant, through the real
// ngspice worker, emitting the contract event stream as it goes.
//
// Three structural guarantees, each enforced by a type rather than by care:
//
//  1. BASELINE GATING (contract rule 2). A mutant is killed only by a check the
//     baseline PASSED. This is not a convention here: the only way to ask
//     whether a check killed a mutant is `BaselineGate.killedBy()`, and a gate
//     is constructed from baseline results. A check the baseline did not pass is
//     not in the gate's `killable` set, so no code path can count it as a kill.
//     Until the baseline has run there is no gate, and so no mutant can be
//     classified at all.
//
//  2. `killed_by` NON-EMPTY EXACTLY WHEN KILLED (rule 3) and A SURVIVOR HAS NO
//     FAILING CHECK (rule 4). `classifyMutant()` derives the status FROM the
//     gated failures: non-empty failures means `killed` and nothing else can,
//     empty failures means the status cannot be `killed`. The two fields cannot
//     disagree because they are computed from one list.
//
//  3. NOT_CHECKED AND ERROR NEVER KILL (rule 1/2). Only the verdict FAIL enters
//     the failure list. A gated check that came back NOT_CHECKED or ERROR is
//     recorded, reported and allowed to change the mutant's status to
//     `not_checked` / `error` -- never to `killed`.
//
// Equivalent mutants are detected BEFORE anything is simulated and are never
// run, so they cannot acquire a verdict at all (rule 6).

import { createHash } from 'node:crypto';
import { verifySimulation } from '../workers/ngspice/assertions.mjs';
import { verifyThermal } from '../workers/thermal/assertions.mjs';
import { THERMAL_TOOL_ID } from '../workers/thermal/model.mjs';
import { ngspiceVersion } from '../workers/ngspice/run.mjs';
import { validateEvent } from '../contracts/check-run.mjs';
import { parseNetlist } from './netlist.mjs';
import { generateMutants, OPERATORS, PatchError } from './operators.mjs';
import { classifyEquivalence, findDuplicates } from './equivalence.mjs';

export const sha256 = text => 'sha256:' + createHash('sha256').update(String(text)).digest('hex');

/** Verdicts that mean "this check did not decide anything". They never kill. */
export const INCONCLUSIVE = new Set(['NOT_CHECKED', 'ERROR']);

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The baseline's verdicts, and the only authority on which checks may kill.
 *
 * A check is `killable` only when the baseline PASSED it. That set is built
 * once, in the constructor, from baseline results; nothing can add to it later.
 */
export class BaselineGate {
  /** @param {Array<{test_id: string, verdict: string, reason_code?: string, reason?: string}>} results */
  constructor(results) {
    /** @type {Map<string, object>} */
    this.results = new Map((results ?? []).map(r => [r.test_id, r]));
    this.killable = new Set((results ?? []).filter(r => r.verdict === 'PASS').map(r => r.test_id));
  }

  get size() { return this.results.size; }
  /** Checks the baseline passed; the only ones that can ever kill a mutant. */
  get killableIds() { return [...this.killable]; }
  /** Checks the baseline did NOT pass. Each one is dead weight, and a gating defect. */
  get blocked() {
    return [...this.results.values()].filter(r => r.verdict !== 'PASS');
  }
  canKill(testId) { return this.killable.has(testId); }
  baselineVerdict(testId) { return this.results.get(testId)?.verdict ?? null; }

  /** Only the results of checks that may kill. */
  gated(results) { return (results ?? []).filter(r => this.canKill(r.test_id)); }

  /**
   * The checks that killed this mutant: FAIL on the mutant AND PASS on the
   * baseline. Nothing else is a kill, and nothing else can reach this list.
   */
  killedBy(results) {
    return (results ?? [])
      .filter(r => r.verdict === 'FAIL' && this.canKill(r.test_id))
      .map(r => r.test_id);
  }
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Decide one mutant's status from its results. Pure: no simulator, no I/O, so
 * the rules can be tested on their own.
 *
 * @param {BaselineGate} gate
 * @param {Array<object>} results the mutant's own check results
 * @param {{equivalence?: {equivalent: boolean, reason: string|null, detail: string|null},
 *          error?: {reason_code: string, reason: string}|null}} [extra]
 * @returns {{status: 'killed'|'survived'|'not_checked'|'equivalent'|'error',
 *            killed_by: string[], why: string, inconclusive: string[]}}
 */
export function classifyMutant(gate, results, extra = {}) {
  if (!(gate instanceof BaselineGate)) {
    throw new TypeError('classifyMutant needs a BaselineGate: without baseline verdicts nothing can be a kill');
  }
  if (extra.equivalence?.equivalent) {
    return {
      status: 'equivalent', killed_by: [], inconclusive: [],
      why: `equivalent (${extra.equivalence.reason}): ${extra.equivalence.detail}`,
    };
  }
  if (extra.error) {
    return {
      status: 'error', killed_by: [], inconclusive: [],
      why: `${extra.error.reason_code}: ${extra.error.reason}`,
    };
  }

  const gated = gate.gated(results);
  const killed_by = gate.killedBy(results);          // FAIL + baseline PASS, nothing else
  const inconclusive = gated.filter(r => INCONCLUSIVE.has(r.verdict)).map(r => r.test_id);

  if (killed_by.length > 0) {
    return {
      status: 'killed', killed_by, inconclusive,
      why: `failed ${killed_by.length} check(s) the baseline passed: ${killed_by.join(', ')}`,
    };
  }
  if (gated.length === 0) {
    const n = (results ?? []).length;
    return {
      status: 'not_checked', killed_by: [], inconclusive: [],
      why: n === 0
        ? 'no check ran against this mutant'
        : `none of the ${n} check(s) that ran had passed on the baseline, so none of them could kill anything`,
    };
  }
  if (inconclusive.length === gated.length) {
    return {
      // Every eligible check came back NOT_CHECKED or ERROR: the mutant was not
      // checked. Calling this "survived" would be the central lie of the tool.
      status: gated.some(r => r.verdict === 'ERROR') ? 'error' : 'not_checked',
      killed_by: [], inconclusive,
      why: `all ${gated.length} eligible check(s) were inconclusive: ${gated.map(r => `${r.test_id}=${r.verdict}(${r.reason_code ?? '-'})`).join(', ')}`,
    };
  }
  const decided = gated.filter(r => !INCONCLUSIVE.has(r.verdict));
  return {
    status: 'survived', killed_by: [], inconclusive,
    why: `${decided.length} eligible check(s) ran and passed on the mutant; none noticed it`
      + (inconclusive.length ? ` (${inconclusive.length} more were inconclusive)` : ''),
  };
}

/* -------------------------------------------------------------------------- */
/* The event stream                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Builds the run's events.jsonl. Owns `seq` (from 0, no gaps), stamps every
 * event with `design_hash` and `provenance`, validates each one against
 * contracts/event.schema.json, and refuses to emit a `test.result` for a test
 * that was never queued (rule 5) by queueing it first.
 */
export class EventStream {
  constructor({ runId, designHash, provenance = 'real', actor = { kind: 'system', id: 'kinux-engine' }, now = () => new Date() } = {}) {
    if (!runId) throw new Error('EventStream needs a run_id');
    if (!/^sha256:[0-9a-f]{64}$/.test(designHash ?? '')) throw new Error(`EventStream needs a sha256 design_hash, got ${designHash}`);
    this.runId = runId;
    this.designHash = designHash;
    this.provenance = provenance;
    this.actor = actor;
    this.nowFn = now;
    this.seq = 0;
    /** @type {object[]} */
    this.events = [];
    this.queued = new Set();
    this.sinks = [];
  }

  onEvent(fn) { this.sinks.push(fn); return this; }

  emit(type, data, actor = this.actor) {
    const event = {
      v: 1,
      run_id: this.runId,
      seq: this.seq++,
      ts: this.nowFn().toISOString(),
      type,
      actor,
      design_hash: this.designHash,
      provenance: this.provenance,
      data,
    };
    const { ok, errors } = validateEvent(event);
    if (!ok) throw new Error(`engine produced an invalid ${type} event: ${errors.join('; ')}`);
    this.events.push(event);
    for (const sink of this.sinks) sink(event);
    return event;
  }

  queue({ test_id, title, layer = 'netlist', solver = 'ngspice', requirement_ids }) {
    if (this.queued.has(test_id)) return null;
    this.queued.add(test_id);
    const data = { test_id, title, layer, solver };
    if (requirement_ids) data.requirement_ids = requirement_ids;
    return this.emit('test.queued', data);
  }

  /** Emit a result, queueing its test first if it was never queued (rule 5). */
  result(result, { title, layer = result.layer ?? 'netlist', solver = result.solver ?? 'ngspice' } = {}) {
    if (!this.queued.has(result.test_id)) {
      this.queue({ test_id: result.test_id, title: title ?? result.assertion ?? result.test_id, layer, solver });
    }
    const data = {
      test_id: result.test_id,
      subject: result.subject,
      verdict: result.verdict,
    };
    for (const k of ['measured', 'limit', 'units', 'reason_code', 'reason']) {
      if (result[k] !== undefined) data[k] = result[k];
    }
    // Thermal results come from the thermal worker, not ngspice.
    return this.emit('test.result', data, { kind: 'solver', id: result.layer === 'thermal' ? 'thermal-worker' : 'ngspice-worker' });
  }

  toJSONL() { return this.events.map(e => JSON.stringify(e)).join('\n') + '\n'; }
}

/* -------------------------------------------------------------------------- */
/* Checks                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a check suite into blocks the ngspice assertion worker understands.
 * A suite is `{ id?, title?, blocks: [{ analysis, assertions, sources? }] }`;
 * a bare array of blocks and a single block are both accepted.
 */
export function normaliseSuite(suite) {
  const blocks = Array.isArray(suite) ? suite : suite?.blocks ?? (suite?.assertions ? [suite] : []);
  if (!blocks.length) throw new Error('a check suite needs at least one block with assertions');
  return {
    id: (Array.isArray(suite) ? null : suite?.id) ?? 'checks',
    title: (Array.isArray(suite) ? null : suite?.title) ?? null,
    // Thermal blocks (kind: 'thermal') are judged against this design's lumped
    // thermal model. Absent model => every T() check is NOT_CHECKED/no_material_data.
    thermalModel: (Array.isArray(suite) ? null : suite?.thermalModel) ?? null,
    blocks: blocks.map((b, i) => ({ ...b, index: i, prefix: b.prefix ?? `b${i}` })),
  };
}

/**
 * Run every block of a suite against one netlist. The subject ("baseline" or a
 * mutant id) is carried into every result, and test ids are stable across
 * subjects, which is what lets the gate line a mutant's result up with the
 * baseline's.
 */
export async function runChecks(netlistText, suite, { subject = 'baseline', timeoutMs, compat } = {}) {
  const results = [];
  const runs = [];
  for (const block of suite.blocks) {
    if (block.kind === 'thermal') {
      // One-way electrical -> thermal: the thermal worker measures currents
      // through ngspice on this same netlist, then applies the lumped model.
      const th = await verifyThermal(netlistText, block, suite.thermalModel ?? block.model ?? null,
        { subject, testIdPrefix: `${suite.id}:${block.prefix}`, timeoutMs, compat });
      results.push(...th.results);
      runs.push({ block: block.prefix, kind: 'thermal', deck: null, duration_ms: null, result_hash: null });
      continue;
    }
    const out = await verifySimulation(
      netlistText,
      { analysis: block.analysis, assertions: block.assertions, sources: block.sources },
      { subject, testIdPrefix: `${suite.id}:${block.prefix}`, timeoutMs, compat },
    );
    results.push(...out.results);
    runs.push({ block: block.prefix, deck: out.deck, duration_ms: out.run?.duration_ms ?? null, result_hash: out.run?.result_hash ?? null });
  }
  return { results, runs };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

const titleFor = r => r.assertion ?? r.test_id;

/**
 * Verify a design: baseline, then mutants, scored and streamed.
 *
 * Mutants are dispatched through the real job queue (`server/queue/queue.mjs`)
 * when `useQueue` is true (the default): one job per mutant, leased and run by
 * an in-process worker loop via `runOne`, which gives us the queue's timeout,
 * lease and retry semantics for free. The queue is read-only to this module.
 * Pass `useQueue: false` to run mutants directly in a plain loop; both paths
 * produce identical results, and the direct path is the fallback when no
 * SQLite-backed queue is available.
 *
 * @returns {Promise<object>} the raw run outcome; `report.mjs` turns it into a report.
 */
export async function runVerification(options) {
  const {
    netlist,
    suite: rawSuite,
    operators = OPERATORS,
    limit = Infinity,
    runId = `run-${Date.now()}`,
    project = 'kinux',
    domain = 'electronics',
    provenance = 'real',
    timeoutMs,
    compat = null,
    useQueue = true,
    queuePath = ':memory:',
    onEvent,
    now,
  } = options;

  if (typeof netlist !== 'string' || !netlist.trim()) throw new Error('runVerification needs the design netlist as text');
  const suite = normaliseSuite(rawSuite);
  const designHash = sha256(netlist);
  const parsed = parseNetlist(netlist); // throws NetlistParseError on a bad design

  const stream = new EventStream({ runId, designHash, provenance, now });
  if (onEvent) stream.onEvent(onEvent);

  const version = await ngspiceVersion();
  const tool_versions = version.id ? { ngspice: version.id } : {};
  if (suite.blocks.some(b => b.kind === 'thermal')) tool_versions.thermal = THERMAL_TOOL_ID;
  stream.emit('run.started', {
    project,
    domain,
    tool_versions,
    source: provenance === 'real' ? 'live' : provenance,
    design_artifact_ref: options.designRef ?? undefined,
  });

  // --- 1. Baseline. Always first. Nothing can be classified before it. ------
  const baseline = await runChecks(netlist, suite, { subject: 'baseline', timeoutMs, compat });
  for (const r of baseline.results) {
    stream.queue({ test_id: r.test_id, title: titleFor(r), layer: r.layer, solver: r.solver });
  }
  for (const r of baseline.results) stream.result(r);
  const gate = new BaselineGate(baseline.results);

  // --- 2. Mutants. ---------------------------------------------------------
  const generated = [];
  const generationErrors = [];
  try {
    generated.push(...generateMutants(parsed, { operators, limit }));
  } catch (err) {
    if (!(err instanceof PatchError)) throw err;
    generationErrors.push({ operator: err.patch?.operator ?? null, target: err.patch?.target ?? null, message: err.message });
  }
  // Hand-written mutants (e.g. examples/phase-leg-support/mutants.mjs), judged
  // exactly like generated ones: same gate, same classification.
  for (const m of options.extraMutants ?? []) {
    if (typeof m?.mutant_id !== 'string' || typeof m?.text !== 'string') throw new Error('an extra mutant needs mutant_id and text');
    generated.push({ operator: 'hand', operator_title: 'hand-written', layer: 'netlist', origin: 'fixed', target: m.target ?? m.mutant_id, description: m.description ?? m.mutant_id, ...m });
  }

  const duplicates = findDuplicates(generated);
  const prepared = generated.map(m => ({ mutant: m, equivalence: classifyEquivalence(netlist, m) }));

  const outcomes = [];
  const runnable = prepared.filter(p => !p.equivalence.equivalent);

  // Equivalents are never simulated: they must not be able to acquire a verdict.
  const executed = useQueue
    ? await runThroughQueue(runnable, suite, { timeoutMs, compat, queuePath })
    : await runDirectly(runnable, suite, { timeoutMs, compat });

  const byId = new Map(executed.map(e => [e.mutant_id, e]));

  for (const { mutant, equivalence } of prepared) {
    const exec = byId.get(mutant.mutant_id);
    const results = exec?.results ?? [];
    if (!equivalence.equivalent) for (const r of results) stream.result(r, { title: titleFor(r) });

    const verdict = classifyMutant(gate, results, { equivalence, error: exec?.error ?? null });
    stream.emit('mutation.result', {
      mutant_id: mutant.mutant_id,
      target: mutant.target,
      description: mutant.description,
      layer: mutant.layer,
      origin: mutant.origin,
      status: verdict.status,
      killed_by: verdict.killed_by,
    }, { kind: 'villain', id: 'kinux-villain' });

    outcomes.push({
      mutant_id: mutant.mutant_id,
      operator: mutant.operator,
      operator_title: mutant.operator_title,
      target: mutant.target,
      description: mutant.description,
      layer: mutant.layer,
      origin: mutant.origin,
      status: verdict.status,
      killed_by: verdict.killed_by,
      inconclusive: verdict.inconclusive,
      why: verdict.why,
      equivalence,
      results,
      duration_ms: exec?.duration_ms ?? null,
      dispatch: exec?.dispatch ?? (equivalence.equivalent ? 'skipped' : null),
    });
  }

  return {
    run_id: runId,
    design_hash: designHash,
    design_text: netlist,
    project,
    domain,
    provenance,
    tool_versions,
    suite: { id: suite.id, title: suite.title, blocks: suite.blocks.map(b => ({ prefix: b.prefix, kind: b.kind ?? 'simulation', analysis: b.analysis, assertions: b.assertions })) },
    baseline: { results: baseline.results, runs: baseline.runs, blocked: gate.blocked, killable: gate.killableIds },
    gate,
    mutants: outcomes,
    duplicates,
    generation_errors: generationErrors,
    stream,
    // Finishing the stream (run.score + run.finished) belongs to report.mjs,
    // which owns the score and the cap. See finishRun() there.
  };
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

async function executeOne(mutant, suite, { timeoutMs, compat }) {
  const started = Date.now();
  try {
    const { results } = await runChecks(mutant.text, suite, { subject: mutant.mutant_id, timeoutMs, compat });
    return { mutant_id: mutant.mutant_id, results, error: null, duration_ms: Date.now() - started };
  } catch (err) {
    // The worker itself broke (not a FAIL, not a NOT_CHECKED). That is an
    // ERROR, and an ERROR never kills.
    return {
      mutant_id: mutant.mutant_id,
      results: [],
      error: { reason_code: 'tool_error', reason: String(err?.message ?? err) },
      duration_ms: Date.now() - started,
    };
  }
}

async function runDirectly(prepared, suite, opts) {
  const out = [];
  for (const { mutant } of prepared) {
    out.push({ ...(await executeOne(mutant, suite, opts)), dispatch: 'direct' });
  }
  return out;
}

/**
 * One job per mutant through the durable queue. The queue only carries the
 * mutant id and its netlist text (payload is JSON), so nothing in here depends
 * on the queue's storage; the handler runs the same `executeOne` as the direct
 * path. A job that the queue could not complete becomes an ERROR outcome, never
 * a kill and never a survivor.
 */
async function runThroughQueue(prepared, suite, { timeoutMs, compat, queuePath }) {
  if (!prepared.length) return [];
  let JobQueue, runOne;
  try {
    ({ default: JobQueue, runOne } = await import('../server/queue/queue.mjs'));
  } catch (err) {
    // No node:sqlite, or the queue is unavailable: fall back, loudly.
    const out = await runDirectly(prepared, suite, { timeoutMs, compat });
    return out.map(o => ({ ...o, dispatch: `direct (queue unavailable: ${String(err?.message ?? err)})` }));
  }

  const queue = new JobQueue(queuePath);
  const byId = new Map(prepared.map(({ mutant }) => [mutant.mutant_id, mutant]));
  const jobTimeout = Math.max(60_000, (timeoutMs ?? 20_000) * (suite.blocks.length + 1));
  try {
    for (const { mutant } of prepared) {
      queue.enqueue({
        id: mutant.mutant_id,
        kind: 'mutation',
        payload: { mutant_id: mutant.mutant_id, netlist: mutant.text },
        maxAttempts: 1,            // a mutant run is deterministic; retrying hides nothing
        timeoutMs: jobTimeout,
      });
    }
    const out = [];
    for (;;) {
      const done = await runOne(queue, 'kinux-engine', async job => {
        const mutant = byId.get(job.payload.mutant_id);
        return executeOne(mutant, suite, { timeoutMs, compat });
      }, { ttlMs: Math.max(5_000, jobTimeout), timeoutMs: jobTimeout });
      if (!done) break;                              // queue drained
      if (done.outcome === 'completed') {
        out.push({ ...done.result, dispatch: 'queue' });
      } else {
        const mutantId = done.jobId;
        out.push({
          mutant_id: mutantId,
          results: [],
          error: { reason_code: done.error?.code === 'timeout' ? 'timeout' : 'tool_error', reason: `queue outcome ${done.outcome}: ${done.error?.message ?? done.error?.code ?? 'unknown'}` },
          duration_ms: null,
          dispatch: 'queue',
        });
      }
    }
    return out;
  } finally {
    queue.close();
  }
}
