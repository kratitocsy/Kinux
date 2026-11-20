// Durable job queue for Kinux checks.
//
// Storage: node:sqlite (built into Node 22) in WAL mode. No npm dependency.
//
// Guarantees (see README.md for the full list):
//   - A job is leased to at most one worker at a time. Leases are fenced with an
//     epoch, so a worker whose lease expired can no longer complete or fail it.
//   - A lease that stops being renewed expires and the job becomes leasable again.
//   - Only infrastructure failures are retried. A legitimate FAIL verdict is a
//     completion, not a failure, and is never retried.
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const STATE = Object.freeze({
  QUEUED: 'queued',
  LEASED: 'leased',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** Failure kinds. Only `infra` is ever retried. */
export const FAILURE = Object.freeze({
  INFRA: 'infra',        // timeout, process/container died, host went away
  PERMANENT: 'permanent', // bad job definition, unsupported tool, etc.
});

/** An infrastructure failure: the check never got a chance to produce a verdict. */
export class InfraError extends Error {
  constructor(message, code = 'infra_failure') {
    super(message);
    this.name = 'InfraError';
    this.kind = FAILURE.INFRA;
    this.code = code;
  }
}

/** A permanent failure: re-running would fail the same way. Never retried. */
export class PermanentError extends Error {
  constructor(message, code = 'permanent_failure') {
    super(message);
    this.name = 'PermanentError';
    this.kind = FAILURE.PERMANENT;
    this.code = code;
  }
}

export function classifyFailure(err) {
  if (!err) return FAILURE.PERMANENT;
  if (err.kind === FAILURE.INFRA || err.kind === FAILURE.PERMANENT) return err.kind;
  if (err.infra === true) return FAILURE.INFRA;
  const code = err.code || '';
  if (code === 'ETIMEDOUT' || code === 'timeout' || code === 'process_died' ||
      code === 'ECONNRESET' || code === 'EPIPE' || code === 'lease_expired') {
    return FAILURE.INFRA;
  }
  return FAILURE.PERMANENT;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  cache_key         TEXT,
  kind              TEXT NOT NULL DEFAULT 'check',
  payload           TEXT NOT NULL,
  state             TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  timeout_ms        INTEGER NOT NULL DEFAULT 60000,
  priority          INTEGER NOT NULL DEFAULT 0,
  lease_owner       TEXT,
  lease_epoch       INTEGER NOT NULL DEFAULT 0,
  lease_expires_at  INTEGER,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  result            TEXT,
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  available_at      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_pickable ON jobs (state, available_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS jobs_lease ON jobs (state, lease_expires_at);
CREATE TABLE IF NOT EXISTS job_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,
  at         INTEGER NOT NULL,
  what       TEXT NOT NULL,
  detail     TEXT
);
`;

const toJob = row => row && ({
  id: row.id,
  cacheKey: row.cache_key,
  kind: row.kind,
  payload: JSON.parse(row.payload),
  state: row.state,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  timeoutMs: row.timeout_ms,
  priority: row.priority,
  leaseOwner: row.lease_owner,
  leaseEpoch: row.lease_epoch,
  leaseExpiresAt: row.lease_expires_at,
  cancelRequested: row.cancel_requested === 1,
  result: row.result == null ? null : JSON.parse(row.result),
  error: row.error == null ? null : JSON.parse(row.error),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  availableAt: row.available_at,
});

export class JobQueue {
  /**
   * @param {string} path  SQLite file path, or ':memory:' for a throwaway queue.
   * @param {{now?: () => number, busyTimeoutMs?: number}} [opts]
   */
  constructor(path = ':memory:', opts = {}) {
    this.path = path;
    this.now = opts.now || (() => Date.now());
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`PRAGMA busy_timeout = ${Number(opts.busyTimeoutMs ?? 5000)};`);
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  #log(jobId, what, detail) {
    this.db.prepare('INSERT INTO job_events (job_id, at, what, detail) VALUES (?, ?, ?, ?)')
      .run(jobId, this.now(), what, detail == null ? null : JSON.stringify(detail));
  }

  /** Run fn inside BEGIN IMMEDIATE so concurrent processes serialise on the write lock. */
  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  }

  /**
   * enqueue({ id?, cacheKey?, kind?, payload, maxAttempts?, timeoutMs?, priority?, availableAt? })
   * Enqueuing an id that already exists is a no-op (idempotent submit); the existing job is returned.
   */
  enqueue(job) {
    const now = this.now();
    const id = job.id || randomUUID();
    const row = {
      id,
      cache_key: job.cacheKey ?? null,
      kind: job.kind ?? 'check',
      payload: JSON.stringify(job.payload ?? {}),
      state: STATE.QUEUED,
      max_attempts: Number(job.maxAttempts ?? 3),
      timeout_ms: Number(job.timeoutMs ?? 60000),
      priority: Number(job.priority ?? 0),
      created_at: now,
      updated_at: now,
      available_at: Number(job.availableAt ?? 0),
    };
    return this.#tx(() => {
      const existing = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (existing) return toJob(existing);
      this.db.prepare(`INSERT INTO jobs
        (id, cache_key, kind, payload, state, attempts, max_attempts, timeout_ms, priority,
         created_at, updated_at, available_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
        .run(row.id, row.cache_key, row.kind, row.payload, row.state, row.max_attempts,
             row.timeout_ms, row.priority, row.created_at, row.updated_at, row.available_at);
      this.#log(id, 'enqueued');
      return toJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
    });
  }

  /**
   * Reclaim leases that stopped being renewed. An expired lease is an infrastructure
   * failure: it burns an attempt, and the job goes back to `queued` unless it is out
   * of attempts, in which case it fails with code `lease_expired`.
   * Called automatically by lease(); exposed for sweepers and tests.
   */
  reclaimExpired() {
    const now = this.now();
    return this.#tx(() => {
      const rows = this.db.prepare(
        `SELECT * FROM jobs WHERE state = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
      ).all(STATE.LEASED, now);
      let n = 0;
      for (const row of rows) {
        n++;
        if (row.cancel_requested === 1) {
          this.db.prepare(`UPDATE jobs SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ? WHERE id = ?`).run(STATE.CANCELLED, now, row.id);
          this.#log(row.id, 'cancelled', { after: 'lease_expired' });
        } else if (row.attempts >= row.max_attempts) {
          this.db.prepare(`UPDATE jobs SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
            error = ?, updated_at = ? WHERE id = ?`)
            .run(STATE.FAILED,
                 JSON.stringify({ kind: FAILURE.INFRA, code: 'lease_expired', message: 'lease expired and attempts exhausted', attempts: row.attempts }),
                 now, row.id);
          this.#log(row.id, 'failed', { code: 'lease_expired' });
        } else {
          this.db.prepare(`UPDATE jobs SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ? WHERE id = ?`).run(STATE.QUEUED, now, row.id);
          this.#log(row.id, 'lease_expired', { attempts: row.attempts });
        }
      }
      return n;
    });
  }

  /**
   * Take one job. Returns a lease handle or null.
   * The handle carries `epoch`, a fencing token: heartbeat/complete/fail from a
   * stale owner are rejected.
   */
  lease(workerId, ttlMs = 30000) {
    this.reclaimExpired();
    const now = this.now();
    return this.#tx(() => {
      const row = this.db.prepare(
        `SELECT * FROM jobs
          WHERE state = ? AND cancel_requested = 0 AND available_at <= ?
          ORDER BY priority DESC, created_at ASC, id ASC
          LIMIT 1`
      ).get(STATE.QUEUED, now);
      if (!row) return null;
      const epoch = row.lease_epoch + 1;
      const expires = now + Number(ttlMs);
      this.db.prepare(`UPDATE jobs SET state = ?, lease_owner = ?, lease_epoch = ?,
          lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND state = ? AND lease_epoch = ?`)
        .run(STATE.LEASED, workerId, epoch, expires, now, row.id, STATE.QUEUED, row.lease_epoch);
      const after = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id);
      if (after.lease_epoch !== epoch || after.lease_owner !== workerId) return null;
      this.#log(row.id, 'leased', { workerId, epoch, ttlMs });
      const job = toJob(after);
      return {
        jobId: job.id, owner: workerId, epoch, ttlMs: Number(ttlMs),
        expiresAt: expires, attempt: job.attempts, job,
      };
    });
  }

  #owns(row, opts) {
    if (!row || row.state !== STATE.LEASED) return false;
    if (opts && opts.owner != null && row.lease_owner !== opts.owner) return false;
    if (opts && opts.epoch != null && row.lease_epoch !== Number(opts.epoch)) return false;
    return true;
  }

  /**
   * Renew a lease. Returns { ok, cancelRequested, expiresAt, reason }.
   * `ok:false` means the lease is gone (expired, reclaimed, or taken by someone else)
   * and the worker must stop: continuing would risk a second concurrent execution.
   */
  heartbeat(jobId, opts = {}) {
    const now = this.now();
    return this.#tx(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!row) return { ok: false, reason: 'unknown_job', cancelRequested: false };
      if (!this.#owns(row, opts)) {
        return { ok: false, reason: 'lease_lost', cancelRequested: row.cancel_requested === 1 };
      }
      if (row.lease_expires_at != null && row.lease_expires_at <= now) {
        return { ok: false, reason: 'lease_expired', cancelRequested: row.cancel_requested === 1 };
      }
      if (row.cancel_requested === 1) {
        return { ok: true, cancelRequested: true, expiresAt: row.lease_expires_at };
      }
      const ttl = Number(opts.ttlMs ?? (row.lease_expires_at - row.updated_at) ?? 30000);
      const expires = now + (Number.isFinite(ttl) && ttl > 0 ? ttl : 30000);
      this.db.prepare('UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ?')
        .run(expires, now, jobId);
      return { ok: true, cancelRequested: false, expiresAt: expires };
    });
  }

  /**
   * Finish a job. A check that legitimately returned FAIL is a completion, not a
   * failure: pass it here and it is never retried.
   */
  complete(jobId, result, opts = {}) {
    const now = this.now();
    return this.#tx(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!row) return { ok: false, reason: 'unknown_job' };
      if (!this.#owns(row, opts)) return { ok: false, reason: 'lease_lost' };
      this.db.prepare(`UPDATE jobs SET state = ?, result = ?, error = NULL,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(STATE.SUCCEEDED, JSON.stringify(result ?? null), now, jobId);
      this.#log(jobId, 'completed', { verdict: result && result.verdict });
      return { ok: true, state: STATE.SUCCEEDED };
    });
  }

  /**
   * Record a failure. Infrastructure failures go back on the queue while attempts
   * remain; everything else is terminal.
   * @returns {{ok:boolean, retried?:boolean, state?:string, reason?:string}}
   */
  fail(jobId, err, opts = {}) {
    const now = this.now();
    const kind = classifyFailure(err);
    const payload = {
      kind,
      code: (err && err.code) || (kind === FAILURE.INFRA ? 'infra_failure' : 'permanent_failure'),
      message: (err && err.message) || String(err),
    };
    return this.#tx(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!row) return { ok: false, reason: 'unknown_job' };
      if (!this.#owns(row, opts)) return { ok: false, reason: 'lease_lost' };
      if (row.cancel_requested === 1) {
        this.db.prepare(`UPDATE jobs SET state = ?, error = ?, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
          .run(STATE.CANCELLED, JSON.stringify(payload), now, jobId);
        this.#log(jobId, 'cancelled', payload);
        return { ok: true, retried: false, state: STATE.CANCELLED };
      }
      const retry = kind === FAILURE.INFRA && row.attempts < row.max_attempts;
      if (retry) {
        this.db.prepare(`UPDATE jobs SET state = ?, error = ?, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = ?, available_at = ? WHERE id = ?`)
          .run(STATE.QUEUED, JSON.stringify(payload), now, now, jobId);
        this.#log(jobId, 'retry', { ...payload, attempts: row.attempts });
        return { ok: true, retried: true, state: STATE.QUEUED, attempts: row.attempts };
      }
      this.db.prepare(`UPDATE jobs SET state = ?, error = ?, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(STATE.FAILED, JSON.stringify(payload), now, jobId);
      this.#log(jobId, 'failed', payload);
      return { ok: true, retried: false, state: STATE.FAILED, attempts: row.attempts };
    });
  }

  /**
   * Ask for a job to stop. A queued job is cancelled at once. A leased job gets a
   * cancel flag that its worker sees on the next heartbeat; the job is no longer
   * leasable either way.
   */
  cancel(jobId, reason = 'cancelled by request') {
    const now = this.now();
    return this.#tx(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      if (!row) return { ok: false, reason: 'unknown_job' };
      if (row.state === STATE.SUCCEEDED || row.state === STATE.FAILED) {
        return { ok: false, reason: 'already_finished', state: row.state };
      }
      if (row.state === STATE.LEASED) {
        this.db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(now, jobId);
        this.#log(jobId, 'cancel_requested', { reason });
        return { ok: true, state: STATE.LEASED, pending: true };
      }
      this.db.prepare(`UPDATE jobs SET state = ?, cancel_requested = 1, lease_owner = NULL,
          lease_expires_at = NULL, error = ?, updated_at = ? WHERE id = ?`)
        .run(STATE.CANCELLED, JSON.stringify({ kind: 'cancelled', code: 'cancelled', message: reason }), now, jobId);
      this.#log(jobId, 'cancelled', { reason });
      return { ok: true, state: STATE.CANCELLED, pending: false };
    });
  }

  get(jobId) { return toJob(this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)); }
  list(state) {
    const rows = state
      ? this.db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at').all(state)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at').all();
    return rows.map(toJob);
  }
  history(jobId) {
    return this.db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY seq').all(jobId)
      .map(r => ({ seq: r.seq, at: r.at, what: r.what, detail: r.detail ? JSON.parse(r.detail) : null }));
  }
  counts() {
    const out = {};
    for (const r of this.db.prepare('SELECT state, COUNT(*) n FROM jobs GROUP BY state').all()) out[r.state] = r.n;
    return out;
  }
}

/** Kill a process group (detached child + anything it spawned). Never throws. */
export function killTree(child, signal = 'SIGKILL') {
  if (!child || child.pid == null) return;
  try { process.kill(-child.pid, signal); return; } catch { /* no group, fall through */ }
  try { child.kill(signal); } catch { /* already gone */ }
}

/**
 * Run a child process with a hard timeout and an abort signal.
 * The child is spawned detached so the whole process group can be killed: no
 * orphan grandchildren survive a timeout or a cancel.
 *
 * Resolves with { code, signal, stdout, stderr, timedOut, aborted, durationMs }.
 * Never rejects for a non-zero exit; the caller decides what that means.
 */
export function runChild(command, args = [], opts = {}) {
  const { timeoutMs = 60000, graceMs = 250, cwd, env, signal, onSpawn, maxBuffer = 8 * 1024 * 1024 } = opts;
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '', stderr = '', timedOut = false, aborted = false, settled = false;
    let timer = null, graceTimer = null;

    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onSpawn) { try { onSpawn(child); } catch { /* caller's problem */ } }

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const stop = () => {
      killTree(child, 'SIGTERM');
      graceTimer = setTimeout(() => killTree(child, 'SIGKILL'), graceMs);
      if (graceTimer.unref) graceTimer.unref();
    };
    function onAbort() { aborted = true; stop(); }

    if (signal) {
      if (signal.aborted) { aborted = true; stop(); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    child.stdout.on('data', d => { if (stdout.length < maxBuffer) stdout += d; });
    child.stderr.on('data', d => { if (stderr.length < maxBuffer) stderr += d; });

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      killTree(child, 'SIGKILL'); // sweep any grandchildren left in the group
      resolve({ pid: child.pid, code, signal: sig, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    };
    child.on('error', err => { if (settled) return; settled = true; cleanup(); resolve({ pid: child.pid, code: null, signal: null, stdout, stderr: stderr + String(err && err.message), timedOut, aborted, spawnError: String(err && err.message), durationMs: Date.now() - started }); });
    child.on('close', finish);
  });
}

/**
 * Lease one job and run it. Keeps the lease alive, watches the cancel flag, enforces
 * the per-job timeout, and records the outcome with the right retry semantics.
 *
 * `handler(job, ctx)` gets `ctx.signal` (aborts on timeout or cancel) and
 * `ctx.runChild(cmd, args, opts)` which inherits that signal and the job timeout.
 * Returning a value completes the job (a FAIL verdict included). Throwing an
 * InfraError retries; throwing anything else is terminal.
 *
 * @returns {Promise<null|{jobId, outcome: 'completed'|'failed'|'retried'|'cancelled'|'lease_lost', result?, error?}>}
 */
export async function runOne(queue, workerId, handler, opts = {}) {
  const ttlMs = Number(opts.ttlMs ?? 5000);
  const lease = queue.lease(workerId, ttlMs);
  if (!lease) return null;
  const job = lease.job;
  const fence = { owner: lease.owner, epoch: lease.epoch };
  const timeoutMs = Number(opts.timeoutMs ?? job.timeoutMs ?? 60000);
  const ac = new AbortController();

  let reason = null;
  const beatEvery = Math.max(10, Math.floor(ttlMs / 3));
  const beat = setInterval(() => {
    const hb = queue.heartbeat(job.id, { ...fence, ttlMs });
    if (!hb.ok) { reason = reason || hb.reason || 'lease_lost'; ac.abort(); }
    else if (hb.cancelRequested) { reason = reason || 'cancelled'; ac.abort(); }
  }, beatEvery);

  // Deliberately NOT unref'd. These two timers are the only things that can
  // abort a handler that is waiting, so unref'ing them lets Node drain the
  // event loop while the job's promise is still pending. Both are cleared in
  // the finally block below, so they cannot keep the process alive either.
  const hardTimer = setTimeout(() => { reason = reason || 'timeout'; ac.abort(); }, timeoutMs);

  const ctx = {
    signal: ac.signal,
    lease,
    heartbeat: () => queue.heartbeat(job.id, { ...fence, ttlMs }),
    runChild: (cmd, args, o = {}) => runChild(cmd, args, { timeoutMs, ...o, signal: ac.signal }),
  };

  try {
    const result = await handler(job, ctx);
    if (reason === 'cancelled') {
      queue.fail(job.id, new InfraError('cancelled while running', 'cancelled'), fence);
      return { jobId: job.id, outcome: 'cancelled' };
    }
    if (reason === 'timeout') {
      const r = queue.fail(job.id, new InfraError(`job exceeded its ${timeoutMs}ms timeout`, 'timeout'), fence);
      return { jobId: job.id, outcome: r.retried ? 'retried' : 'failed', error: { code: 'timeout' } };
    }
    if (reason) return { jobId: job.id, outcome: 'lease_lost', error: { code: reason } };
    const done = queue.complete(job.id, result, fence);
    if (!done.ok) return { jobId: job.id, outcome: 'lease_lost', error: { code: done.reason } };
    return { jobId: job.id, outcome: 'completed', result };
  } catch (err) {
    if (reason === 'cancelled') {
      queue.fail(job.id, new InfraError('cancelled while running', 'cancelled'), fence);
      return { jobId: job.id, outcome: 'cancelled' };
    }
    const e = reason === 'timeout'
      ? new InfraError(`job exceeded its ${timeoutMs}ms timeout`, 'timeout')
      : err;
    const r = queue.fail(job.id, e, fence);
    if (!r.ok) return { jobId: job.id, outcome: 'lease_lost', error: { code: r.reason } };
    return { jobId: job.id, outcome: r.retried ? 'retried' : 'failed', error: { code: e.code, message: e.message } };
  } finally {
    clearInterval(beat);
    clearTimeout(hardTimer);
  }
}

export default JobQueue;
