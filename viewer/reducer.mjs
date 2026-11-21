// Kinux viewer — append-only event reducer.
//
// Pure: no DOM, no I/O, no imports. Events in, view state out.
//
// One interface, two sources:
//   * a JSONL file  -> parseJSONL(text) -> replay(events)
//   * an SSE stream -> readSSE(body)    -> store.push(event) per event
// Both go through the same reduce(), so a replay of a file and a live feed of
// the same events produce an identical state object.
//
// Nothing here invents data. Every field is derived from events, and every
// panel carries the provenance of the events that fed it.

export const PROVENANCE_RANK = { synthetic: 0, recorded: 1, real: 2 };
export const PROVENANCE_ORDER = ['synthetic', 'recorded', 'real'];

/** The weaker of two provenance labels. Unknown (null) loses to everything. */
export function weakerProvenance(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return PROVENANCE_RANK[a] <= PROVENANCE_RANK[b] ? a : b;
}

/** Wilson score interval for k of n, z=1.96. Mirrors contracts/check-run.mjs. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [null, null];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * Score as defined in contracts/README.md rule 6 and 7.
 * NOT_CHECKED, ERROR and equivalent mutants are reported separately and are
 * never in the numerator or the denominator.
 */
export function computeScore(statuses) {
  const count = s => statuses.filter(x => x === s).length;
  const killed = count('killed');
  const survived = count('survived');
  const total = statuses.length;
  const checkable = killed + survived;
  const [lo, hi] = wilson(killed, checkable);
  return {
    killed,
    survived,
    not_checked: count('not_checked'),
    equivalent: count('equivalent'),
    errors: count('error'),
    total,
    checkable_fraction: total === 0 ? 0 : checkable / total,
    score: checkable === 0 ? null : killed / checkable,
    ci_low: lo,
    ci_high: hi,
  };
}

/** Which panels an event feeds. Every event is in the log. */
export function panelsFor(event) {
  const out = ['log'];
  switch (event.type) {
    case 'run.started':
    case 'fault.propose':
    case 'fault.toggle':
    case 'param.set':
      out.push('design');
      break;
    case 'select':
    case 'highlight':
    case 'result.stale':
      out.push('design', 'instruments');
      break;
    case 'test.artifact':
      out.push(
        ['schematic_svg', 'pcb_svg', 'mesh_glb', 'thermal_field', 'stress_field', 'mj_trajectory'].includes(event.data.kind)
          ? 'design'
          : 'instruments'
      );
      break;
    case 'test.queued':
    case 'test.progress':
    case 'test.result':
    case 'mutation.result':
    case 'run.score':
      out.push('instruments');
      break;
    case 'run.finished':
      out.push('design', 'instruments');
      break;
    default:
      break;
  }
  return out;
}

const emptyProv = () => ({ real: 0, recorded: 0, synthetic: 0 });

export function initialState() {
  return {
    run: {
      run_id: null,
      project: null,
      domain: null,
      source: null,
      design_artifact_ref: null,
      tool_versions: {},
      design_hash: null,
      started_ts: null,
      finished: null, // { status, summary, ts }
    },
    seq: -1,            // last seq applied
    gaps: [],           // seq numbers that arrived out of order or skipped
    eventCount: 0,
    log: [],            // ordered, append-only
    tests: {},          // test_id -> test record
    testOrder: [],
    mutants: {},        // mutant_id -> mutant record
    mutantOrder: [],
    artifacts: [],
    score: null,        // the run.score event payload, as emitted
    derivedScore: null, // recomputed from mutation.result events
    stale: [],          // test ids marked stale
    highlights: [],
    faults: {},         // fault_id -> { fault_id, target, change, rationale, on }
    params: {},         // param -> value
    provenance: {
      overall: null,
      counts: emptyProv(),
      panels: {
        log: { level: null, counts: emptyProv() },
        design: { level: null, counts: emptyProv() },
        instruments: { level: null, counts: emptyProv() },
      },
    },
    problems: [],       // contract violations the viewer noticed while reducing
  };
}

function noteProvenance(state, event) {
  const p = event.provenance;
  if (!PROVENANCE_ORDER.includes(p)) {
    state.problems.push(`seq ${event.seq}: provenance ${JSON.stringify(p)} is not one of real, recorded, synthetic`);
    return;
  }
  state.provenance.counts[p] += 1;
  state.provenance.overall = weakerProvenance(state.provenance.overall, p);
  for (const name of panelsFor(event)) {
    const panel = state.provenance.panels[name];
    panel.counts[p] += 1;
    panel.level = weakerProvenance(panel.level, p);
  }
}

function logEntry(event) {
  const { type, data } = event;
  let text = type;
  let severity = 'info';
  const refs = [];
  switch (type) {
    case 'run.started':
      text = `run started — ${data.project} (${data.domain}), source: ${data.source}`;
      break;
    case 'test.queued':
      text = `queued ${data.test_id}: ${data.title} [${data.layer} / ${data.solver}]`;
      refs.push(data.test_id);
      break;
    case 'test.progress':
      text = `${data.test_id} ${data.pct}%${data.message ? ` — ${data.message}` : ''}`;
      refs.push(data.test_id);
      break;
    case 'test.artifact':
      text = `artifact ${data.artifact_id} (${data.kind}, ${data.bytes} B) for ${data.test_id}`;
      refs.push(data.test_id, data.artifact_id);
      break;
    case 'test.result': {
      // Only a check that ran has a reading. A NOT_CHECKED or ERROR that happens to
      // carry `measured` must not print it: beside the verdict it reads as a
      // measurement, which is exactly the misreading this project exists to prevent.
      const ran = data.verdict === 'PASS' || data.verdict === 'FAIL';
      const m = ran && data.measured !== undefined ? ` ${data.measured}${data.units ? ' ' + data.units : ''}` : '';
      const why = data.reason_code ? ` (${data.reason_code}${data.reason ? ': ' + data.reason : ''})` : '';
      text = `${data.verdict} — ${data.test_id} on ${data.subject}${m}${why}`;
      severity = data.verdict === 'FAIL' ? 'failure' : data.verdict === 'PASS' ? 'pass' : 'warning';
      refs.push(data.test_id, data.subject);
      break;
    }
    case 'mutation.result':
      text = `${data.mutant_id} ${data.status} — ${data.description} (${data.target})` +
        (data.killed_by.length ? ` killed by ${data.killed_by.join(', ')}` : '');
      severity = data.status === 'killed' ? 'pass' : data.status === 'survived' ? 'failure' : 'warning';
      refs.push(data.mutant_id, data.target, ...data.killed_by);
      break;
    case 'run.score':
      text = data.score === null
        ? `score: null (nothing checkable) — ${data.total} mutants`
        : `score ${(data.score * 100).toFixed(1)}% = ${data.killed} / ${data.killed + data.survived} checkable of ${data.total}`;
      break;
    case 'run.finished':
      text = `run ${data.status}${data.summary ? ` — ${data.summary}` : ''}`;
      severity = data.status === 'completed' ? 'pass' : 'failure';
      break;
    case 'agent.action':
      text = `${data.action}: ${data.summary}`;
      if (data.target) refs.push(data.target);
      break;
    case 'result.stale':
      text = `stale: ${data.test_ids.join(', ')} predate design ${data.current_design_hash.slice(7, 19)}`;
      severity = 'warning';
      refs.push(...data.test_ids);
      break;
    case 'select':
      text = `selected ${data.ids.join(', ')}${data.tab ? ` in ${data.tab}` : ''}`;
      refs.push(...data.ids);
      break;
    case 'highlight':
      text = `highlight (${data.severity}) ${data.ids.join(', ')}${data.note ? ` — ${data.note}` : ''}`;
      severity = data.severity;
      refs.push(...data.ids);
      break;
    case 'fault.propose':
      text = `proposed fault ${data.fault_id} on ${data.target}: ${data.change} — ${data.rationale}`;
      refs.push(data.fault_id, data.target);
      break;
    case 'fault.toggle':
      text = `fault ${data.fault_id} ${data.on ? 'on' : 'off'}`;
      refs.push(data.fault_id);
      break;
    case 'param.set':
      text = `${data.param} = ${data.value}`;
      refs.push(data.param);
      break;
    default:
      text = `${type} ${JSON.stringify(data)}`;
  }
  return {
    seq: event.seq,
    ts: event.ts,
    type,
    actor: event.actor.kind,
    actorId: event.actor.id,
    provenance: event.provenance,
    design_hash: event.design_hash,
    severity,
    text,
    refs: [...new Set(refs.filter(Boolean))],
  };
}

function ensureTest(state, test_id) {
  if (!state.tests[test_id]) {
    state.tests[test_id] = {
      test_id,
      title: null,
      layer: null,
      solver: null,
      requirement_ids: [],
      queued: false,
      pct: null,
      message: null,
      stale: false,
      results: {},     // subject -> result record
      subjectOrder: [],
      artifacts: [],
    };
    state.testOrder.push(test_id);
  }
  return state.tests[test_id];
}

/**
 * Apply one event. Mutates and returns `state` (append-only: events are never
 * removed or reordered). Callers that want immutability clone first.
 */
export function reduce(state, event) {
  if (!event || typeof event !== 'object') {
    state.problems.push('non-object event ignored');
    return state;
  }
  if (typeof event.seq !== 'number') {
    state.problems.push('event without a numeric seq ignored');
    return state;
  }
  if (event.seq !== state.seq + 1) {
    state.gaps.push({ expected: state.seq + 1, got: event.seq });
  }
  state.seq = Math.max(state.seq, event.seq);
  state.eventCount += 1;
  noteProvenance(state, event);
  state.log.push(logEntry(event));

  if (state.run.run_id == null) state.run.run_id = event.run_id;
  else if (state.run.run_id !== event.run_id) {
    state.problems.push(`seq ${event.seq}: run_id ${event.run_id} differs from ${state.run.run_id}`);
  }
  state.run.design_hash = event.design_hash;

  const d = event.data || {};
  switch (event.type) {
    case 'run.started':
      state.run.project = d.project;
      state.run.domain = d.domain;
      state.run.source = d.source;
      state.run.design_artifact_ref = d.design_artifact_ref ?? null;
      state.run.tool_versions = { ...(d.tool_versions || {}) };
      state.run.started_ts = event.ts;
      break;
    case 'test.queued': {
      const t = ensureTest(state, d.test_id);
      t.title = d.title;
      t.layer = d.layer;
      t.solver = d.solver;
      t.requirement_ids = [...(d.requirement_ids || [])];
      t.queued = true;
      break;
    }
    case 'test.progress': {
      const t = ensureTest(state, d.test_id);
      t.pct = d.pct;
      t.message = d.message ?? null;
      break;
    }
    case 'test.artifact': {
      const t = ensureTest(state, d.test_id);
      const art = {
        artifact_id: d.artifact_id,
        test_id: d.test_id,
        kind: d.kind,
        uri: d.uri,
        sha256: d.sha256,
        bytes: d.bytes,
        mime: d.mime,
        provenance: event.provenance,
        seq: event.seq,
      };
      t.artifacts.push(art);
      state.artifacts.push(art);
      break;
    }
    case 'test.result': {
      const t = ensureTest(state, d.test_id);
      if (!t.queued) state.problems.push(`seq ${event.seq}: result for ${d.test_id}, which was never queued`);
      if (!t.results[d.subject]) t.subjectOrder.push(d.subject);
      t.results[d.subject] = {
        test_id: d.test_id,
        subject: d.subject,
        verdict: d.verdict,
        measured: d.measured ?? null,
        limit: d.limit ?? null,
        units: d.units ?? null,
        reason_code: d.reason_code ?? null,
        reason: d.reason ?? null,
        provenance: event.provenance,
        seq: event.seq,
        design_hash: event.design_hash,
      };
      break;
    }
    case 'mutation.result': {
      if (state.mutants[d.mutant_id]) state.problems.push(`seq ${event.seq}: duplicate mutant ${d.mutant_id}`);
      else state.mutantOrder.push(d.mutant_id);
      state.mutants[d.mutant_id] = {
        mutant_id: d.mutant_id,
        target: d.target,
        description: d.description,
        layer: d.layer,
        origin: d.origin,
        status: d.status,
        killed_by: [...(d.killed_by || [])],
        provenance: event.provenance,
        seq: event.seq,
      };
      state.derivedScore = computeScore(state.mutantOrder.map(id => state.mutants[id].status));
      break;
    }
    case 'run.score':
      state.score = { ...d, provenance: event.provenance, seq: event.seq };
      break;
    case 'run.finished':
      state.run.finished = { status: d.status, summary: d.summary ?? null, ts: event.ts };
      break;
    case 'result.stale':
      for (const id of d.test_ids) {
        ensureTest(state, id).stale = true;
        if (!state.stale.includes(id)) state.stale.push(id);
      }
      break;
    case 'highlight':
      state.highlights.push({ ids: [...d.ids], severity: d.severity, note: d.note ?? null, seq: event.seq });
      break;
    case 'fault.propose':
      state.faults[d.fault_id] = {
        fault_id: d.fault_id,
        target: d.target,
        change: d.change,
        rationale: d.rationale,
        params: d.params ?? null,
        on: state.faults[d.fault_id]?.on ?? false,
        provenance: event.provenance,
      };
      break;
    case 'fault.toggle':
      if (!state.faults[d.fault_id]) {
        state.faults[d.fault_id] = { fault_id: d.fault_id, target: null, change: null, rationale: null, params: null, on: d.on, provenance: event.provenance };
      } else {
        state.faults[d.fault_id].on = d.on;
      }
      break;
    case 'param.set':
      state.params[d.param] = d.value;
      break;
    default:
      break;
  }
  return state;
}

/** Replay a whole array of events into a fresh state. */
export function replay(events) {
  const state = initialState();
  for (const ev of events) reduce(state, ev);
  return state;
}

/** Parse a JSONL run file. Blank lines are skipped; a bad line is reported. */
export function parseJSONL(text) {
  const events = [];
  const errors = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      events.push(JSON.parse(trimmed));
    } catch (err) {
      errors.push(`line ${i + 1}: ${err.message}`);
    }
  });
  if (errors.length) {
    const e = new Error(`malformed JSONL: ${errors.join('; ')}`);
    e.events = events;
    throw e;
  }
  return events;
}

/**
 * The one interface both sources go through. A store holds the state and
 * accepts events one at a time, whatever their origin.
 */
export function createStore(onChange) {
  const state = initialState();
  const listeners = new Set();
  if (onChange) listeners.add(onChange);
  const notify = ev => { for (const l of listeners) l(state, ev); };
  return {
    get state() { return state; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    push(event) { reduce(state, event); notify(event); return state; },
    pushAll(events) { for (const ev of events) reduce(state, ev); notify(null); return state; },
    /** Last seq applied, for SSE resume via Last-Event-ID. */
    lastEventId() { return state.seq < 0 ? null : String(state.seq); },
  };
}

/** Source 1: a JSONL file (or any text blob of it). */
export function sourceFromJSONL(text) {
  const events = parseJSONL(text);
  return {
    kind: 'jsonl',
    async run(store) { for (const ev of events) store.push(ev); return store.state; },
  };
}

/**
 * Parse an SSE byte stream into events. Works in Node (response.body) and in
 * the browser (fetch body) — both are async-iterable or have getReader().
 * Yields { id, event, data } frames.
 */
export async function* readSSEFrames(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  const iterate = async function* () {
    if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) yield chunk;
      return;
    }
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  };
  for await (const chunk of iterate()) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const frame = { id: null, event: 'message', data: '' };
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') frame.id = value;
        else if (field === 'event') frame.event = value;
        else if (field === 'data') dataLines.push(value);
      }
      frame.data = dataLines.join('\n');
      if (frame.data) yield frame;
    }
  }
}

/**
 * Source 2: an SSE stream. Same interface, same reduce path, so the resulting
 * state is identical to replaying the same events from a file.
 */
export function sourceFromSSE(url, { fetchImpl = globalThis.fetch, signal } = {}) {
  return {
    kind: 'sse',
    async run(store) {
      const headers = { Accept: 'text/event-stream' };
      const last = store.lastEventId();
      if (last !== null) headers['Last-Event-ID'] = last;
      const res = await fetchImpl(url, { headers, signal });
      if (!res.ok) throw new Error(`SSE ${url}: HTTP ${res.status}`);
      for await (const frame of readSSEFrames(res.body)) {
        if (frame.event === 'done' || frame.data === '[DONE]') break;
        store.push(JSON.parse(frame.data));
      }
      return store.state;
    },
  };
}

/** Run any source into a store. The single entry point the app uses. */
export async function loadInto(store, source) {
  return source.run(store);
}

// ---------------------------------------------------------------------------
// Derived views the panels ask for. Kept here so the DOM code stays dumb.
// ---------------------------------------------------------------------------

/** The provenance badge for a panel: level, whether the panel is mixed, counts. */
export function badgeFor(state, panel) {
  const p = panel === 'overall'
    ? { level: state.provenance.overall, counts: state.provenance.counts }
    : state.provenance.panels[panel];
  if (!p) return { level: null, mixed: false, counts: emptyProv(), label: 'NO DATA', synthetic: false };
  const present = PROVENANCE_ORDER.filter(k => p.counts[k] > 0);
  const mixed = present.length > 1;
  const level = p.level;
  return {
    level,
    mixed,
    counts: { ...p.counts },
    synthetic: level === 'synthetic',
    label: level === null ? 'NO DATA' : mixed ? `${level.toUpperCase()} (MIXED)` : level.toUpperCase(),
  };
}

/** Verdicts that are not a pass and must never be shown or counted as one. */
export const NON_PASS_VERDICTS = ['FAIL', 'NOT_CHECKED', 'ERROR'];

export function isPass(verdict) {
  return verdict === 'PASS';
}

/**
 * Rows for the mutation table, in arrival order, with the log seq and the
 * checks that are relevant to each mutant (for cross-panel selection).
 */
export function mutationRows(state) {
  return state.mutantOrder.map(id => {
    const m = state.mutants[id];
    const checks = [];
    for (const tid of state.testOrder) {
      const r = state.tests[tid].results[id];
      if (r) checks.push(r);
    }
    return { ...m, checks };
  });
}

/**
 * Measurement series for the waveform/measurement chart: for each test, the
 * numeric measurements per subject that genuinely arrived as test.result.
 * Non-numeric and NOT_CHECKED/ERROR results are returned separately so the
 * chart can show them as gaps rather than as points.
 */
export function measurementSeries(state) {
  return state.testOrder.map(tid => {
    const t = state.tests[tid];
    const points = [];
    const gaps = [];
    for (const subject of t.subjectOrder) {
      const r = t.results[subject];
      if (typeof r.measured === 'number' && (r.verdict === 'PASS' || r.verdict === 'FAIL')) {
        points.push(r);
      } else {
        gaps.push(r);
      }
    }
    return { test: t, points, gaps, units: points[0]?.units ?? null };
  });
}

/** Everything in the run that carries an id a user can select. */
export function selectionTargets(state) {
  const ids = new Set();
  for (const id of state.mutantOrder) {
    ids.add(id);
    ids.add(state.mutants[id].target);
  }
  for (const id of state.testOrder) ids.add(id);
  for (const a of state.artifacts) ids.add(a.artifact_id);
  return [...ids];
}

/**
 * Given a selected id, the ids that should light up in every panel.
 *
 * Deliberately narrow. Selecting a mutant pulls in the design element it
 * targets and any sibling mutant on the same element; it does NOT pull in the
 * test ids, because every other mutant's log lines mention those too and the
 * highlight would stop meaning anything. The checks run on the selected
 * subject are found by subject id instead (see mutationRows and the log
 * entries, whose refs carry the subject).
 */
export function expandSelection(state, id) {
  const out = new Set();
  if (!id) return out;
  out.add(id);
  const m = state.mutants[id];
  if (m) out.add(m.target);
  for (const mid of state.mutantOrder) {
    const other = state.mutants[mid];
    if (other.target === id) out.add(mid);
    // selecting a check lights up the mutants that check killed
    if (other.killed_by.includes(id)) out.add(mid);
  }
  return out;
}
