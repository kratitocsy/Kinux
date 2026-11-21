// Append-only event log and content-addressed artifact store for one Kinux run.
//
// Layout under `root`:
//   runs/<run_id>/events.jsonl   one canonical JSON event per line, seq order
//   artifacts/<hex>              artifact bytes, named by their sha256
//
// Guarantees
//   - The server assigns `seq`. It starts at 0 and has no gaps: it is the index of
//     the line in events.jsonl, so the file itself is the authority.
//   - The log is append-only. Nothing is ever rewritten or truncated.
//   - A concurrent reader never sees a torn line. Each append is a single
//     `write(2)` to a file opened O_APPEND, and a reader drops any trailing
//     fragment that is not terminated by a newline. Readers therefore see a
//     prefix of the log, never half an event.
//   - Artifacts are written to a temp file and renamed into place, so a reader
//     either sees the whole artifact or no file at all.
import { createHash } from 'node:crypto';
import {
  openSync, writeSync, closeSync, readFileSync, existsSync, mkdirSync,
  readdirSync, renameSync, unlinkSync, statSync, fsyncSync,
} from 'node:fs';
import { join } from 'node:path';

export const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const sha256 = buf => 'sha256:' + createHash('sha256').update(buf).digest('hex');

/** Deterministic JSON: object keys sorted, no incidental whitespace. */
export function canonicalJSON(value) {
  const enc = v => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return '[' + v.map(enc).join(',') + ']';
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) throw new TypeError('cannot canonicalise non-finite number');
      return JSON.stringify(v);
    }
    if (t === 'string' || t === 'boolean') return JSON.stringify(v);
    if (t === 'undefined' || t === 'function') return 'null';
    if (t === 'bigint') return JSON.stringify(v.toString());
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + enc(v[k])).join(',') + '}';
  };
  return enc(value);
}

/** A run id has to be safe as one path segment: no traversal, no separators. */
export function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || runId === '.' || runId === '..') {
    throw new RunStoreError(`invalid run id: ${JSON.stringify(runId)}`, 'bad_run_id');
  }
  return runId;
}

export class RunStoreError extends Error {
  constructor(message, code = 'run_store_error') {
    super(message);
    this.name = 'RunStoreError';
    this.code = code;
  }
}

/** One persisted event: its seq, its type, the exact stored line, and the parsed object. */
class Record {
  constructor(line) {
    this.line = line;                 // without the trailing newline
    this.event = JSON.parse(line);
    this.seq = this.event.seq;
    this.type = this.event.type;
  }
}

export class RunStore {
  #root;
  #runsDir;
  #artifactsDir;
  #fds = new Map();   // run_id -> open append fd
  #counts = new Map(); // run_id -> next seq

  constructor(root) {
    this.#root = root;
    this.#runsDir = join(root, 'runs');
    this.#artifactsDir = join(root, 'artifacts');
    mkdirSync(this.#runsDir, { recursive: true });
    mkdirSync(this.#artifactsDir, { recursive: true });
  }

  get root() { return this.#root; }

  runDir(runId) { return join(this.#runsDir, assertRunId(runId)); }
  logPath(runId) { return join(this.runDir(runId), 'events.jsonl'); }

  hasRun(runId) { return existsSync(this.logPath(runId)); }

  listRuns() {
    return readdirSync(this.#runsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(this.#runsDir, d.name, 'events.jsonl')))
      .map(d => d.name)
      .sort();
  }

  /** Create an empty log for a run. Idempotent; never truncates an existing log. */
  createRun(runId) {
    assertRunId(runId);
    mkdirSync(this.runDir(runId), { recursive: true });
    if (!existsSync(this.logPath(runId))) closeSync(openSync(this.logPath(runId), 'a'));
    return runId;
  }

  #fd(runId) {
    let fd = this.#fds.get(runId);
    if (fd === undefined) {
      this.createRun(runId);
      fd = openSync(this.logPath(runId), 'a');
      this.#fds.set(runId, fd);
    }
    return fd;
  }

  /** Next seq for a run: the number of complete lines already in its log. */
  nextSeq(runId) {
    let n = this.#counts.get(runId);
    if (n === undefined) {
      n = this.#completeLines(runId).length;
      this.#counts.set(runId, n);
    }
    return n;
  }

  #completeLines(runId) {
    assertRunId(runId);
    const path = this.logPath(runId);
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
    if (text === '') return [];
    const parts = text.split('\n');
    // The last element is either the empty string after the final newline, or a
    // trailing fragment of an append still in flight. Either way it is not an
    // event, so drop it: a reader sees a prefix of the log, never half a line.
    parts.pop();
    return parts.filter(l => l !== '');
  }

  /**
   * Append an event. The caller supplies everything but `seq`; the store assigns
   * that. Returns the persisted {seq, type, line, event}.
   */
  append(runId, event) {
    assertRunId(runId);
    if (!event || typeof event !== 'object') throw new RunStoreError('event must be an object', 'bad_event');
    if (event.run_id !== undefined && event.run_id !== runId) {
      throw new RunStoreError(`event run_id ${event.run_id} does not match ${runId}`, 'run_id_mismatch');
    }
    const seq = this.nextSeq(runId);
    const full = {
      v: 1,
      ...event,
      run_id: runId,
      seq,
      ts: event.ts ?? new Date().toISOString(),
    };
    const line = canonicalJSON(full);
    if (line.includes('\n')) throw new RunStoreError('canonical event contains a newline', 'bad_event');
    // One write(2) of one whole line to an O_APPEND fd: readers see all of it or none.
    const fd = this.#fd(runId);
    writeSync(fd, line + '\n');
    this.#counts.set(runId, seq + 1);
    return new Record(line);
  }

  /** Every complete event of a run, in seq order. */
  readAll(runId) {
    return this.#completeLines(runId).map(l => new Record(l));
  }

  /** Events with seq >= fromSeq. */
  readFrom(runId, fromSeq = 0) {
    const from = Number.isInteger(fromSeq) && fromSeq > 0 ? fromSeq : 0;
    return this.readAll(runId).slice(from);
  }

  /** The whole log as it is on disk, complete lines only, newline-terminated. */
  readLog(runId) {
    const lines = this.#completeLines(runId);
    return lines.length === 0 ? '' : lines.join('\n') + '\n';
  }

  /** Cheap run summary for the index page and `GET /runs/:id`. */
  summary(runId) {
    const records = this.readAll(runId);
    const last = records[records.length - 1];
    const finished = records.find(r => r.type === 'run.finished');
    return {
      run_id: runId,
      events: records.length,
      next_seq: records.length,
      last_seq: last ? last.seq : null,
      finished: Boolean(finished),
      status: finished ? (finished.event.data?.status ?? 'finished') : (records.length ? 'running' : 'empty'),
      provenance: records.length ? records[0].event.provenance : null,
      started_at: records.length ? records[0].event.ts : null,
      updated_at: last ? last.event.ts : null,
    };
  }

  // ---- artifacts, by content hash -----------------------------------------

  artifactPath(hash) {
    if (!HASH_RE.test(hash)) throw new RunStoreError(`not a sha256 hash: ${hash}`, 'bad_hash');
    return join(this.#artifactsDir, hash.slice('sha256:'.length));
  }

  /** Store bytes under their own hash. Returns {hash, bytes}. Idempotent. */
  putArtifact(buf) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const hash = sha256(data);
    const dest = this.artifactPath(hash);
    if (!existsSync(dest)) {
      const tmp = dest + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
      const fd = openSync(tmp, 'wx');
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try { renameSync(tmp, dest); } catch (err) { try { unlinkSync(tmp); } catch {} throw err; }
    }
    return { hash, bytes: data.length };
  }

  hasArtifact(hash) {
    try { return existsSync(this.artifactPath(hash)); } catch { return false; }
  }

  /** Artifact bytes, or null when the hash is unknown. */
  getArtifact(hash) {
    let path;
    try { path = this.artifactPath(hash); } catch { return null; }
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }

  artifactSize(hash) {
    try { return statSync(this.artifactPath(hash)).size; } catch { return null; }
  }

  /** Close every open append fd. Safe to call twice. */
  close() {
    for (const fd of this.#fds.values()) { try { closeSync(fd); } catch {} }
    this.#fds.clear();
  }
}
