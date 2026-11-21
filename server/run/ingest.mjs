// Ingest: the one way events enter a run, and the fan-out to live SSE clients.
//
// The mutation engine is being built separately, so this interface is deliberately
// narrow and knows nothing about engines, solvers or mutants. It takes event
// objects, persists them through the store (which assigns `seq`), and hands the
// persisted line to every subscriber. Nothing here imports from `engine/`.
//
//   const ingest = new Ingest({ store });
//   ingest.open('run-1');
//   const off = ingest.subscribe('run-1', record => { ... });
//   ingest.submit('run-1', { type: 'run.started', actor: {...}, ... });
//   off();
//
// Subscribers are called synchronously, in subscription order, after the event is
// durable. A subscriber that throws is detached rather than allowed to break the
// append path.
import { assertRunId } from './store.mjs';

export const EVENT_TYPES = Object.freeze([
  'run.started', 'test.queued', 'test.progress', 'test.artifact', 'test.result',
  'mutation.result', 'run.score', 'run.finished', 'agent.action', 'result.stale',
  'select', 'highlight', 'fault.propose', 'fault.toggle', 'param.set',
]);
const ACTOR_KINDS = Object.freeze(['human', 'builder', 'villain', 'solver', 'system']);
const PROVENANCE = Object.freeze(['real', 'recorded', 'synthetic']);
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export class IngestError extends Error {
  constructor(message, code = 'bad_event', problems = []) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
    this.problems = problems;
  }
}

/**
 * A dependency-free check of the frozen envelope. It is not the JSON Schema: the
 * full schema lives in contracts/ and needs Ajv, so it is injected as `validate`
 * when the caller wants it. This covers the fields the server itself relies on.
 */
export function checkEnvelope(event) {
  const problems = [];
  const p = (c, m) => { if (!c) problems.push(m); };
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, errors: ['event must be an object'] };
  p(event.v === 1, 'v must be 1');
  p(typeof event.run_id === 'string' && event.run_id.length > 0, 'run_id must be a non-empty string');
  p(Number.isInteger(event.seq) && event.seq >= 0, 'seq must be a non-negative integer');
  p(typeof event.ts === 'string' && !Number.isNaN(Date.parse(event.ts)), 'ts must be an ISO date-time');
  p(EVENT_TYPES.includes(event.type), `type must be one of ${EVENT_TYPES.join(', ')}`);
  p(event.actor && typeof event.actor === 'object' && ACTOR_KINDS.includes(event.actor.kind) &&
    typeof event.actor.id === 'string' && event.actor.id.length > 0, 'actor must be {kind, id}');
  p(typeof event.design_hash === 'string' && HASH_RE.test(event.design_hash), 'design_hash must be sha256:<64 hex>');
  p(PROVENANCE.includes(event.provenance), `provenance must be one of ${PROVENANCE.join(', ')}`);
  p(event.data && typeof event.data === 'object' && !Array.isArray(event.data), 'data must be an object');
  return { ok: problems.length === 0, errors: problems };
}

export class Ingest {
  #store;
  #validate;
  #subs = new Map(); // run_id -> Set<listener>

  /**
   * @param {object} opts
   * @param {import('./store.mjs').RunStore} opts.store
   * @param {(event:object)=>{ok:boolean,errors:string[]}} [opts.validate]
   *        Optional full validator, normally `validateEvent` from
   *        contracts/check-run.mjs. Injected so this module needs no npm package.
   */
  constructor({ store, validate } = {}) {
    if (!store) throw new TypeError('Ingest needs a store');
    this.#store = store;
    this.#validate = validate ?? null;
  }

  get store() { return this.#store; }

  /** Start a run's log so clients can subscribe before the first event. */
  open(runId) { return this.#store.createRun(runId); }

  /**
   * Append one event and fan it out. `seq` is assigned here and never by the
   * caller; `v`, `run_id` and `ts` are filled in when missing.
   * @returns {{seq:number,type:string,line:string,event:object}}
   */
  submit(runId, event) {
    assertRunId(runId);
    if (!event || typeof event !== 'object') throw new IngestError('event must be an object');
    if (event.seq !== undefined && event.seq !== this.#store.nextSeq(runId)) {
      throw new IngestError(
        `seq is assigned by the server: expected ${this.#store.nextSeq(runId)}, got ${event.seq}`,
        'seq_not_yours',
      );
    }
    const candidate = {
      v: 1,
      ...event,
      run_id: runId,
      seq: this.#store.nextSeq(runId),
      ts: event.ts ?? new Date().toISOString(),
    };
    const checks = [checkEnvelope(candidate)];
    if (this.#validate) checks.push(this.#validate(candidate));
    const errors = checks.flatMap(c => c.errors ?? []);
    if (errors.length) throw new IngestError(`event rejected: ${errors.join('; ')}`, 'bad_event', errors);

    const record = this.#store.append(runId, candidate);
    for (const fn of [...(this.#subs.get(runId) ?? [])]) {
      try {
        fn(record);
      } catch {
        this.#subs.get(runId)?.delete(fn); // a broken client must not break the log
      }
    }
    return record;
  }

  /** Append several events in order. Returns their records. */
  submitMany(runId, events) {
    return events.map(e => this.submit(runId, e));
  }

  /** Listen for events appended after this call. Returns an unsubscribe function. */
  subscribe(runId, listener) {
    assertRunId(runId);
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    let set = this.#subs.get(runId);
    if (!set) { set = new Set(); this.#subs.set(runId, set); }
    set.add(listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set.delete(listener);
      if (set.size === 0) this.#subs.delete(runId);
    };
  }

  subscriberCount(runId) { return this.#subs.get(runId)?.size ?? 0; }

  /** True once the run's log holds a run.finished event. */
  isFinished(runId) {
    return this.#store.hasRun(runId) && this.#store.readAll(runId).some(r => r.type === 'run.finished');
  }

  /** Drop every subscriber. The store is the caller's to close. */
  close() { this.#subs.clear(); }
}
