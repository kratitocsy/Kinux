// Tests for server/queue: durable job queue, content-addressed cache, receipts.
// Fast and deterministic: short TTLs, no sleeps longer than needed, explicit timeouts.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import {
  JobQueue, STATE, FAILURE, InfraError, PermanentError, runOne, runChild,
} from '../server/queue/queue.mjs';
import {
  ResultCache, cacheKey, cacheKeySync, sha256, hashInputs,
} from '../server/queue/cache.mjs';
import { buildReceipt, verifyReceipt, DISCLAIMER } from '../server/queue/receipt.mjs';
import { validateReceipt } from '../contracts/check-run.mjs';

const QUEUE_URL = fileURLToPath(new URL('../server/queue/queue.mjs', import.meta.url));
const H = c => 'sha256:' + String(c).repeat(64).slice(0, 64);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'kinux-queue-')); });
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const newQueue = name => new JobQueue(join(dir, `${name}-${Math.random().toString(36).slice(2)}.db`));

describe('leases', () => {
  test('two worker processes racing for the same job: exactly one wins', { timeout: 20000 }, async () => {
    const dbPath = join(dir, 'race.db');
    const q = new JobQueue(dbPath);
    q.enqueue({ id: 'race-1', payload: { check: 'T1' } });
    q.close();

    // Both racers open the same WAL database and spin until a shared start instant,
    // so the lease really is contended rather than merely sequential.
    const startAt = Date.now() + 400;
    const racer = `
      const { JobQueue } = await import(process.argv[1]);
      const q = new JobQueue(process.argv[2]);
      const startAt = Number(process.argv[3]);
      while (Date.now() < startAt) {}
      const lease = q.lease(process.argv[4], 10000);
      process.stdout.write(JSON.stringify({ worker: process.argv[4], got: lease ? lease.jobId : null, epoch: lease ? lease.epoch : null }));
      q.close();
    `;
    const run = worker => new Promise((resolve, reject) => {
      execFile(process.execPath, ['--input-type=module', '-e', racer, '--', QUEUE_URL, dbPath, String(startAt), worker],
        { timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
    });

    const [a, b] = await Promise.all([run('worker-A'), run('worker-B')]);
    const winners = [a, b].filter(r => r.got === 'race-1');
    assert.equal(winners.length, 1, `exactly one worker may hold the lease, got ${JSON.stringify([a, b])}`);

    const q2 = new JobQueue(dbPath);
    const job = q2.get('race-1');
    assert.equal(job.state, STATE.LEASED);
    assert.equal(job.leaseOwner, winners[0].worker);
    assert.equal(job.attempts, 1, 'the loser must not have burned an attempt');
    q2.close();
  });

  test('a lease whose heartbeat stops is reclaimed after the TTL and can be re-leased', { timeout: 10000 }, async () => {
    const q = newQueue('ttl');
    q.enqueue({ id: 'j1', payload: {} });

    const first = q.lease('worker-A', 60);
    assert.ok(first, 'first lease should succeed');
    assert.equal(q.lease('worker-B', 60), null, 'job is not leasable while held');

    // Heartbeat keeps it held.
    await sleep(40);
    assert.equal(q.heartbeat('j1', { owner: 'worker-A', epoch: first.epoch, ttlMs: 60 }).ok, true);
    assert.equal(q.lease('worker-B', 60), null, 'a renewed lease is still held');

    // Stop beating; after the TTL it comes back.
    await sleep(90);
    const second = q.lease('worker-B', 1000);
    assert.ok(second, 'an unrenewed lease must expire and the job become leasable');
    assert.equal(second.jobId, 'j1');
    assert.equal(second.epoch, first.epoch + 1, 'the fencing epoch must advance');

    // The old owner is fenced out: it can no longer heartbeat or complete.
    assert.equal(q.heartbeat('j1', { owner: 'worker-A', epoch: first.epoch }).ok, false);
    assert.equal(q.complete('j1', { verdict: 'PASS' }, { owner: 'worker-A', epoch: first.epoch }).ok, false,
      'a worker whose lease expired must not be able to complete the job');
    assert.equal(q.complete('j1', { verdict: 'PASS' }, { owner: 'worker-B', epoch: second.epoch }).ok, true);
    q.close();
  });
});

describe('cancel', () => {
  test('a queued job that is cancelled stops being leasable and does not run', { timeout: 10000 }, async () => {
    const q = newQueue('cancel-queued');
    q.enqueue({ id: 'c1', payload: {} });
    assert.equal(q.cancel('c1').state, STATE.CANCELLED);
    assert.equal(q.get('c1').state, STATE.CANCELLED);
    assert.equal(q.lease('worker-A', 1000), null, 'a cancelled job must not be leasable');

    let ran = 0;
    const out = await runOne(q, 'worker-A', async () => { ran++; return { verdict: 'PASS' }; }, { ttlMs: 500 });
    assert.equal(out, null, 'there is nothing to lease');
    assert.equal(ran, 0, 'a cancelled job must not run');
    q.close();
  });

  test('a running job observes the cancel flag and stops', { timeout: 10000 }, async () => {
    const q = newQueue('cancel-running');
    q.enqueue({ id: 'c2', payload: {}, timeoutMs: 5000 });

    let aborted = false;
    const running = runOne(q, 'worker-A', async (job, ctx) => {
      await new Promise(resolve => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      aborted = ctx.signal.aborted;
      return { verdict: 'PASS' };
    }, { ttlMs: 90 });

    await sleep(30);
    assert.equal(q.cancel('c2').pending, true, 'cancelling a leased job sets a flag the worker observes');

    const out = await running;
    assert.equal(out.outcome, 'cancelled');
    assert.equal(aborted, true, 'the running worker must see the cancel');
    assert.equal(q.get('c2').state, STATE.CANCELLED);
    assert.equal(q.lease('worker-B', 1000), null, 'a cancelled job is not re-queued');
    q.close();
  });
});

describe('timeouts', () => {
  test('a job over its timeout is killed, recorded as infrastructure failure, no orphans', { timeout: 20000 }, async () => {
    const q = newQueue('timeout');
    q.enqueue({ id: 't1', payload: {}, timeoutMs: 200, maxAttempts: 1 });

    // The child spawns a grandchild, so this also proves the whole process group dies.
    const childSrc = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(JSON.stringify({ child: process.pid, grandchild: g.pid }) + '\\n');
      setInterval(() => {}, 1000);
    `;
    let seen = null;
    const out = await runOne(q, 'worker-A', async (job, ctx) => {
      const r = await ctx.runChild(process.execPath, ['-e', childSrc]);
      seen = JSON.parse(r.stdout.trim().split('\n')[0]);
      assert.equal(r.timedOut || r.aborted, true, 'the child must have been stopped, not have exited on its own');
      throw new InfraError('child was killed', 'process_died');
    }, { ttlMs: 2000 });

    assert.equal(out.outcome, 'failed', 'maxAttempts is 1, so it does not retry');
    const job = q.get('t1');
    assert.equal(job.state, STATE.FAILED);
    assert.equal(job.error.kind, FAILURE.INFRA);
    assert.equal(job.error.code, 'timeout');

    // Nothing survives. SIGKILL is asynchronous, so allow the kernel a moment.
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && (alive(seen.child) || alive(seen.grandchild)); i++) await sleep(20);
    assert.equal(alive(seen.child), false, `child ${seen.child} survived the timeout`);
    assert.equal(alive(seen.grandchild), false, `grandchild ${seen.grandchild} survived the timeout`);
    q.close();
  });

  test('runChild reports a timeout without rejecting', { timeout: 10000 }, async () => {
    const r = await runChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 150, graceMs: 50 });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.signal, null);
  });
});

describe('retry policy', () => {
  test('an infrastructure failure retries; a FAIL verdict does not', { timeout: 10000 }, async () => {
    const q = newQueue('retry');

    // Infrastructure failure: back on the queue, same job, next attempt.
    q.enqueue({ id: 'infra', payload: {}, maxAttempts: 3 });
    const l1 = q.lease('worker-A', 1000);
    const r1 = q.fail('infra', new InfraError('container died', 'process_died'), { owner: 'worker-A', epoch: l1.epoch });
    assert.equal(r1.retried, true);
    assert.equal(q.get('infra').state, STATE.QUEUED);
    const l2 = q.lease('worker-B', 1000);
    assert.ok(l2, 'a retried job is leasable again');
    assert.equal(l2.attempt, 2);

    // ...but only up to maxAttempts.
    q.fail('infra', new InfraError('died again', 'process_died'), { owner: 'worker-B', epoch: l2.epoch });
    const l3 = q.lease('worker-C', 1000);
    const r3 = q.fail('infra', new InfraError('died a third time', 'process_died'), { owner: 'worker-C', epoch: l3.epoch });
    assert.equal(r3.retried, false, 'retries are bounded by maxAttempts');
    assert.equal(q.get('infra').state, STATE.FAILED);

    // A legitimate FAIL verdict is a completion, never a retry.
    let executions = 0;
    q.enqueue({ id: 'verdict', payload: {}, maxAttempts: 3 });
    const out = await runOne(q, 'worker-A', async () => { executions++; return { verdict: 'FAIL', reason: 'Vout 2.9 V, outside 3.2-3.4 V' }; }, { ttlMs: 1000 });
    assert.equal(out.outcome, 'completed');
    const done = q.get('verdict');
    assert.equal(done.state, STATE.SUCCEEDED);
    assert.equal(done.result.verdict, 'FAIL');
    assert.equal(q.lease('worker-B', 1000), null, 'a design that genuinely fails must not be retried');
    assert.equal(executions, 1);

    // A permanent error is terminal too.
    q.enqueue({ id: 'perm', payload: {}, maxAttempts: 3 });
    const lp = q.lease('worker-A', 1000);
    const rp = q.fail('perm', new PermanentError('no such tool', 'unknown_tool'), { owner: 'worker-A', epoch: lp.epoch });
    assert.equal(rp.retried, false);
    assert.equal(q.get('perm').state, STATE.FAILED);
    q.close();
  });
});

describe('content-addressed cache', () => {
  test('an identical second job hits the cache and does not re-execute', { timeout: 10000 }, async () => {
    const cache = new ResultCache(join(dir, 'cache.db'));
    const file = join(dir, 'divider.net');
    await writeFile(file, 'R1 1k\nR2 2k\n');

    const spec = { tool: 'ngspice', toolVersion: '42', inputs: [file], args: ['--batch'], seeds: { villain: 7 } };
    let executions = 0;
    const work = async () => {
      executions++;
      await sleep(60); // stands in for a real solver run
      return { verdict: 'PASS', vout: 3.3 };
    };

    const t0 = Date.now();
    const first = await cache.run(spec, work);
    const firstMs = Date.now() - t0;

    const t1 = Date.now();
    const second = await cache.run({ ...spec }, work);
    const secondMs = Date.now() - t1;

    assert.equal(executions, 1, 'the second, identical job must not re-execute');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.key, first.key);
    assert.deepEqual(second.result, first.result);
    assert.ok(secondMs < firstMs, `a cache hit must return quickly (${secondMs}ms vs ${firstMs}ms)`);
    cache.close();
  });

  test('every part of the key matters', { timeout: 10000 }, async () => {
    const base = {
      tool: 'ngspice', toolVersion: '42',
      inputs: [{ path: 'a.net', sha256: H('a') }],
      args: ['--batch'], seeds: { villain: 7 },
    };
    const k = s => cacheKeySync(s).key;
    const baseline = k(base);
    const variants = {
      'tool name': { ...base, tool: 'ngspice-ng' },
      'tool version': { ...base, toolVersion: '43' },
      'input hash': { ...base, inputs: [{ path: 'a.net', sha256: H('b') }] },
      'input path': { ...base, inputs: [{ path: 'b.net', sha256: H('a') }] },
      'extra input': { ...base, inputs: [...base.inputs, { path: 'b.net', sha256: H('b') }] },
      arguments: { ...base, args: ['--interactive'] },
      seed: { ...base, seeds: { villain: 8 } },
    };
    const seen = new Set([baseline]);
    for (const [what, v] of Object.entries(variants)) {
      const key = k(v);
      assert.notEqual(key, baseline, `changing the ${what} must change the key`);
      assert.equal(seen.has(key), false, `the ${what} variant collided with another key`);
      seen.add(key);
    }
    // Input order and object key order must not matter.
    assert.equal(
      k({ ...base, inputs: [{ path: 'b.net', sha256: H('b') }, { path: 'a.net', sha256: H('a') }] }),
      k({ ...base, inputs: [{ path: 'a.net', sha256: H('a') }, { path: 'b.net', sha256: H('b') }] }),
      'input order must not change the key');
    assert.equal(k({ seeds: { villain: 7 }, tool: 'ngspice', toolVersion: '42', inputs: base.inputs, args: ['--batch'] }), baseline);
  });

  test('changing one input byte changes the cache key AND the receipt hash', { timeout: 10000 }, async () => {
    const a = join(dir, 'one-byte-a.net');
    const b = join(dir, 'one-byte-b.net');
    await writeFile(a, 'R1 1k\nR2 2k\n');
    await writeFile(b, 'R1 1k\nR2 3k\n'); // one byte differs

    const spec = p => ({ tool: 'ngspice', toolVersion: '42', inputs: [p], args: ['--batch'], seeds: { villain: 7 } });
    const ka = await cacheKey(spec(a));
    const kb = await cacheKey(spec(b));
    assert.notEqual(ka.key, kb.key, 'one byte of input must change the cache key');

    const receiptFor = async (p, key) => buildReceipt({
      engineVersion: '0.0.1',
      inputs: (await hashInputs([p])).map(i => ({ path: 'divider.net', sha256: i.sha256 })),
      toolVersions: { ngspice: '42', kinux: '0.0.1' },
      seeds: { villain: 7 },
      checkSetSha: H('c'), operatorSetSha: H('d'),
      cacheKey: key,
      score: ['killed', 'survived'],
      created: '2026-11-19T10:00:00.000Z',
    });
    const ra = await receiptFor(a, ka.key);
    const rb = await receiptFor(b, kb.key);
    assert.notEqual(ra.receipt_id, rb.receipt_id, 'one byte of input must change the receipt hash');

    // The same inputs, tools and seeds give the same receipt id: it is a content hash.
    assert.equal((await receiptFor(a, ka.key)).receipt_id, ra.receipt_id);
  });
});

describe('receipts', () => {
  const sample = extra => buildReceipt({
    engineVersion: '0.0.1',
    inputs: [{ path: 'examples/divider/divider.kicad_sch', sha256: H('a') }],
    toolVersions: { ngspice: '42', kinux: '0.0.1' },
    seeds: { villain: 7, sampler: 1234 },
    checkSetSha: H('c'), operatorSetSha: H('d'),
    cacheKey: H('e'),
    resultHashes: [H('f')],
    score: ['killed', 'killed', 'survived', 'not_checked'],
    created: '2026-11-19T10:00:00.000Z',
    ...extra,
  });

  test('a built receipt passes validateReceipt with zero errors', { timeout: 10000 }, () => {
    const r = sample();
    const { ok, errors } = validateReceipt(r);
    assert.deepEqual(errors, [], 'receipt must validate against contracts/receipt.schema.json');
    assert.equal(ok, true);
    assert.deepEqual(verifyReceipt(r), { ok: true, errors: [] });
  });

  test('it carries the fixed disclaimer and the cache key', { timeout: 10000 }, () => {
    const r = sample();
    assert.equal(r.disclaimer, DISCLAIMER);
    assert.match(r.disclaimer, /Pre-check linter\. Not a certification/);
    assert.equal(r.result_hashes[0], H('e'), 'the cache key travels in the receipt');
    assert.match(r.receipt_id, /^sha256:[0-9a-f]{64}$/);
    // The score is the contract's score, recomputed from the mutant statuses.
    assert.equal(r.score.killed, 2);
    assert.equal(r.score.survived, 1);
    assert.equal(r.score.not_checked, 1);
    assert.equal(r.score.score, 2 / 3);
    assert.equal(r.score.checkable_fraction, 3 / 4);
  });

  test('the receipt hash changes when a tool version or a seed changes', { timeout: 10000 }, () => {
    const base = sample().receipt_id;
    assert.notEqual(sample({ toolVersions: { ngspice: '43', kinux: '0.0.1' } }).receipt_id, base, 'tool version');
    assert.notEqual(sample({ seeds: { villain: 8, sampler: 1234 } }).receipt_id, base, 'seed');
    assert.notEqual(sample({ engineVersion: '0.0.2' }).receipt_id, base, 'engine version');
    assert.notEqual(sample({ cacheKey: H('9') }).receipt_id, base, 'cache key');
    // A tampered receipt is caught.
    const tampered = sample();
    tampered.score.killed = 3;
    assert.equal(verifyReceipt(tampered).ok, false);
  });

  test('bad receipt material is rejected rather than silently encoded', { timeout: 10000 }, () => {
    assert.throws(() => sample({ seeds: { villain: 7.5 } }), /must be an integer/);
    assert.throws(() => sample({ checkSetSha: 'not-a-hash' }), /sha256/);
    assert.throws(() => buildReceipt({ ...{}, engineVersion: '' }), /engineVersion/);
  });
});

describe('durability', () => {
  test('a queue survives being closed and reopened', { timeout: 10000 }, async () => {
    const path = join(dir, 'durable.db');
    const q1 = new JobQueue(path);
    q1.enqueue({ id: 'd1', payload: { check: 'T1' }, cacheKey: H('a') });
    const l = q1.lease('worker-A', 10000);
    q1.complete('d1', { verdict: 'PASS' }, { owner: 'worker-A', epoch: l.epoch });
    q1.close();

    const q2 = new JobQueue(path);
    const job = q2.get('d1');
    assert.equal(job.state, STATE.SUCCEEDED);
    assert.equal(job.result.verdict, 'PASS');
    assert.equal(job.cacheKey, H('a'));
    assert.ok(q2.history('d1').some(e => e.what === 'completed'));
    q2.close();
  });

  test('enqueuing the same id twice is idempotent', { timeout: 10000 }, () => {
    const q = newQueue('idem');
    q.enqueue({ id: 'same', payload: { n: 1 } });
    q.enqueue({ id: 'same', payload: { n: 2 } });
    assert.equal(q.list().length, 1);
    assert.equal(q.get('same').payload.n, 1);
    q.close();
  });
});
