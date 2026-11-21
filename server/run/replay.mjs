// Replay a finished run through the same handler that serves live events.
//
// The step's "done when" is that a replay is byte-identical to the live stream.
// That holds because there is only one stream implementation: `streamRun` in
// server.mjs. A live client and a replay differ only in where the events come
// from -- the live client gets them from the ingest fan-out as they are appended,
// a replay gets them from the log -- and both are handed to the same `send` gate
// and the same `frameEvent`. The bytes a client sees are the bytes of
// events.jsonl, so nothing can drift.
//
// That is also why heartbeats are SSE comment lines on their own timer: they
// carry no run data, a client ignores them, and they are the only bytes a long
// idle live stream has that a fast replay does not.
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { RunStore } from './store.mjs';
import { Ingest } from './ingest.mjs';
import { streamRun, DEFAULT_HEARTBEAT_MS } from './server.mjs';

/** Collects everything written to it, so a stream can be compared byte for byte. */
export class BufferSink {
  constructor() { this.chunks = []; this.ended = false; }
  write(chunk) { this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')); return true; }
  end(chunk) { if (chunk !== undefined) this.write(chunk); this.ended = true; return this; }
  get buffer() { return Buffer.concat(this.chunks); }
  get text() { return this.buffer.toString('utf8'); }
}

/**
 * Replay a run into a sink and return the exact bytes.
 *
 * @param {object} opts
 * @param {Ingest} opts.ingest
 * @param {string} opts.runId
 * @param {string|number|null} [opts.lastEventId] resume point, same meaning as the header
 * @param {number} [opts.heartbeatMs] 0 (the default here) keeps a replay free of
 *        heartbeat comments, which is what makes the comparison exact.
 * @returns {Buffer}
 */
export function replayBytes({ ingest, runId, lastEventId = null, heartbeatMs = 0 }) {
  const sink = new BufferSink();
  const stream = streamRun({ ingest, runId, out: sink, lastEventId, heartbeatMs, closeOnFinish: true });
  stream.stop(true);
  return sink.buffer;
}

/**
 * Replay a run into any Writable (a socket, a file, a test sink) through the live
 * handler. Resolves once the stream has ended.
 */
export function replayTo(writable, { ingest, runId, lastEventId = null, heartbeatMs = 0 } = {}) {
  const out = {
    write: chunk => writable.write(chunk),
    end: () => { if (writable instanceof Writable || typeof writable.end === 'function') writable.end(); },
  };
  const stream = streamRun({ ingest, runId, out, lastEventId, heartbeatMs, closeOnFinish: true });
  stream.stop(true);
  return stream;
}

/**
 * Load a recorded `events.jsonl` into a store as a run, so the ordinary live
 * endpoints serve it. Each line goes through ingest, so the server re-assigns
 * `seq` from 0 with no gaps exactly as it does for a live run.
 *
 * @param {object} opts
 * @param {Ingest} opts.ingest
 * @param {string} opts.path
 * @param {string} [opts.runId]       defaults to the run_id in the file
 * @param {'real'|'recorded'|'synthetic'} [opts.provenance] rewrite provenance (the
 *        UI must show where data came from; a replay of real data is `recorded`)
 * @returns {{runId:string, events:number}}
 */
export function loadJsonl({ ingest, path, runId = null, provenance = null }) {
  const lines = readFileSync(path, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  const events = lines.map(l => JSON.parse(l));
  if (events.length === 0) throw new Error(`no events in ${path}`);
  const id = runId ?? events[0].run_id;
  ingest.open(id);
  for (const ev of events) {
    const { seq: _seq, ...rest } = ev;
    ingest.submit(id, { ...rest, run_id: id, ...(provenance ? { provenance } : {}) });
  }
  return { runId: id, events: events.length };
}

/** A store + ingest holding one recorded run, ready to serve. */
export function recordedRun({ root, path, runId = null, provenance = null, validate = null }) {
  const store = new RunStore(root);
  const ingest = new Ingest({ store, validate });
  const loaded = loadJsonl({ ingest, path, runId, provenance });
  return { store, ingest, ...loaded };
}

export { DEFAULT_HEARTBEAT_MS };
