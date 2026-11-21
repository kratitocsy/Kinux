// Tests for server/run: the append-only store, the SSE run server, resume,
// replay and the token model.
//
// Every test starts a real server on an ephemeral port and makes real HTTP
// requests. Every test has an explicit timeout and every server and socket is
// closed in `after`, so the run cannot hang.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, appendFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunStore, canonicalJSON, sha256 } from '../server/run/store.mjs';
import { Ingest, checkEnvelope, IngestError } from '../server/run/ingest.mjs';
import {
  createRunServer, TokenSet, probeTcp, frameEvent, framePreamble, resumeFrom,
} from '../server/run/server.mjs';
import { replayBytes, loadJsonl, BufferSink } from '../server/run/replay.mjs';
import { validateEvent } from '../contracts/check-run.mjs';

const FIXTURE = fileURLToPath(new URL('../contracts/fixtures/valid-run.events.jsonl', import.meta.url));
const FIXTURE_EVENTS = readFileSync(FIXTURE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const FIXTURE_RUN = FIXTURE_EVENTS[0].run_id;
const VIEW = 'view-token-aaa';
const DRIVE = 'drive-token-bbb';

let dir;
const started = [];
before(async () => { dir = await mkdtemp(join(tmpdir(), 'kinux-run-')); });
after(async () => {
  for (const s of started) { try { await s.server.close(); } catch {} }
  if (dir) await rm(dir, { recursive: true, force: true });
});

let n = 0;
/** A fresh server with its own storage root, bound to both loopback families. */
async function startServer(opts = {}) {
  const root = join(dir, `srv-${++n}`);
  const server = createRunServer({
    root,
    validate: validateEvent,
    tokens: new TokenSet([
      { token: VIEW, scope: 'view' },
      { token: DRIVE, scope: 'drive' },
    ]),
    ...opts,
  });
  const { port, addresses } = await server.listen({ port: 0 });
  const handle = { server, port, addresses, base: `http://127.0.0.1:${port}` };
  started.push(handle);
  return handle;
}

// ---- tiny HTTP helpers -----------------------------------------------------

function request(url, { method = 'GET', headers = {}, body = null, token = VIEW } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      method,
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      family: u.hostname.includes(':') ? 6 : 4,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(10000, () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const getJson = async (url, opts) => {
  const r = await request(url, opts);
  return { ...r, json: JSON.parse(r.body.toString('utf8')) };
};

/** Parse an SSE body into frames. Comment-only frames are kept, flagged. */
function parseSse(text) {
  return text.split('\n\n').filter(b => b !== '').map(block => {
    const out = { comment: null, id: null, event: null, data: null, raw: block };
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) out.comment = line.slice(1).trim();
      else if (line.startsWith('id: ')) out.id = line.slice(4);
      else if (line.startsWith('event: ')) out.event = line.slice(7);
      else if (line.startsWith('data: ')) out.data = line.slice(6);
      else if (line.startsWith('retry: ')) out.retry = Number(line.slice(7));
    }
    return out;
  });
}

/**
 * Open an SSE stream. Returns the live buffer, a promise that resolves when the
 * server ends it, a `waitForId(seq)` promise and an `abort()`.
 */
function openSse(base, path, { token = VIEW, lastEventId = null } = {}) {
  const u = new URL(base + path);
  const chunks = [];
  const waiters = [];
  let settle;
  const done = new Promise(r => { settle = r; });
  const headers = { authorization: `Bearer ${token}` };
  if (lastEventId !== null) headers['last-event-id'] = String(lastEventId);

  const handle = {
    get buffer() { return Buffer.concat(chunks); },
    get text() { return Buffer.concat(chunks).toString('utf8'); },
    get frames() { return parseSse(this.text); },
    get ids() { return this.frames.filter(f => f.id !== null).map(f => Number(f.id)); },
    done,
    status: null,
    abort() { if (handle.req) handle.req.destroy(); settle('aborted'); },
    /** Resolves once a frame with this id has arrived. */
    waitForId(seq) {
      return new Promise((resolve, reject) => {
        const check = () => handle.ids.includes(seq);
        if (check()) return resolve();
        const t = setTimeout(() => reject(new Error(`timed out waiting for id ${seq}`)), 8000);
        waiters.push(() => { if (check()) { clearTimeout(t); resolve(); return true; } return false; });
      });
    },
  };

  handle.req = http.request({
    method: 'GET',
    host: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    family: u.hostname.includes(':') ? 6 : 4,
    headers,
  }, res => {
    handle.status = res.statusCode;
    res.on('data', c => {
      chunks.push(c);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i]()) waiters.splice(i, 1);
    });
    res.on('end', () => settle('ended'));
    res.on('close', () => settle('closed'));
    res.on('error', () => settle('error'));
  });
  handle.req.on('error', () => settle('error'));
  handle.req.end();
  return handle;
}

const postEvent = (base, runId, event, token = DRIVE) =>
  request(`${base}/runs/${runId}/events`, {
    method: 'POST', token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });

/** The fixture with its server-assigned fields stripped, ready to be ingested. */
const asIngestable = (ev, runId = null) => {
  const { seq, ...rest } = ev;
  return runId ? { ...rest, run_id: runId } : rest;
};

/** Does this host have IPv6 at all? Some containers are built without it. */
function hasIpv6() {
  return new Promise(resolve => {
    const s = createNetServer();
    s.once('error', () => resolve(false));
    s.listen({ port: 0, host: '::1', ipv6Only: true }, () => s.close(() => resolve(true)));
  });
}

// ===========================================================================

describe('store: append-only events.jsonl', () => {
  test('the server assigns seq from 0 with no gaps, and ignores a caller-set seq', { timeout: 10000 }, () => {
    const store = new RunStore(join(dir, 'store-seq'));
    store.createRun('r1');
    for (const ev of FIXTURE_EVENTS) store.append('r1', asIngestable(ev, 'r1'));
    const all = store.readAll('r1');
    assert.equal(all.length, FIXTURE_EVENTS.length);
    assert.deepEqual(all.map(r => r.seq), FIXTURE_EVENTS.map((_, i) => i));
    assert.equal(store.nextSeq('r1'), FIXTURE_EVENTS.length);
    // seq is the line index, so the file is the authority
    const lines = store.readLog('r1').trim().split('\n');
    assert.deepEqual(lines.map(l => JSON.parse(l).seq), all.map(r => r.seq));
    store.close();
  });

  test('a concurrent reader never sees a torn line', { timeout: 10000 }, () => {
    const store = new RunStore(join(dir, 'store-torn'));
    store.createRun('r2');
    store.append('r2', asIngestable(FIXTURE_EVENTS[0], 'r2'));
    // Simulate an append caught in flight: a fragment with no terminating newline.
    const fd = openSync(store.logPath('r2'), 'a');
    writeSync(fd, '{"v":1,"run_id":"r2","seq":1,"type":"test.qu');
    closeSync(fd);
    const seen = store.readAll('r2');          // must not throw, must not include the fragment
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'run.started');
    assert.equal(store.readLog('r2').split('\n').filter(Boolean).length, 1);
    store.close();
  });

  test('a run id cannot escape its directory', { timeout: 10000 }, () => {
    const store = new RunStore(join(dir, 'store-escape'));
    for (const bad of ['../evil', 'a/b', '..', '', 'x'.repeat(200)]) {
      assert.throws(() => store.createRun(bad), /invalid run id/);
    }
    store.close();
  });

  test('artifacts are stored by content hash and retrieved by hash', { timeout: 10000 }, () => {
    const store = new RunStore(join(dir, 'store-art'));
    const bytes = Buffer.from('waveform bytes');
    const { hash } = store.putArtifact(bytes);
    assert.equal(hash, sha256(bytes));
    assert.ok(store.hasArtifact(hash));
    assert.deepEqual(store.getArtifact(hash), bytes);
    assert.equal(store.putArtifact(bytes).hash, hash);      // idempotent
    assert.equal(store.getArtifact('sha256:' + '0'.repeat(64)), null);
    assert.equal(store.getArtifact('not-a-hash'), null);
    store.close();
  });

  test('canonical JSON sorts keys, so a stored line is stable', { timeout: 10000 }, () => {
    assert.equal(canonicalJSON({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('ingest', () => {
  test('rejects a bad envelope and a caller-chosen seq', { timeout: 10000 }, () => {
    const store = new RunStore(join(dir, 'ingest-bad'));
    const ingest = new Ingest({ store, validate: validateEvent });
    ingest.open('r');
    assert.throws(() => ingest.submit('r', { type: 'nope', actor: { kind: 'system', id: 'x' }, design_hash: 'sha256:' + 'a'.repeat(64), provenance: 'synthetic', data: {} }), IngestError);
    ingest.submit('r', asIngestable(FIXTURE_EVENTS[0], 'r'));
    assert.throws(() => ingest.submit('r', { ...asIngestable(FIXTURE_EVENTS[1], 'r'), seq: 7 }), /seq is assigned by the server/);
    assert.equal(checkEnvelope(FIXTURE_EVENTS[0]).ok, true);
    assert.equal(checkEnvelope({}).ok, false);
    ingest.close();
    store.close();
  });

  test('fans out to subscribers and stops after unsubscribe', { timeout: 10000 }, () => {
    const store = new RunStore(join(dir, 'ingest-fan'));
    const ingest = new Ingest({ store });
    ingest.open('r');
    const seen = [];
    const off = ingest.subscribe('r', rec => seen.push(rec.seq));
    ingest.submit('r', asIngestable(FIXTURE_EVENTS[0], 'r'));
    ingest.submit('r', asIngestable(FIXTURE_EVENTS[1], 'r'));
    assert.equal(ingest.subscriberCount('r'), 1);
    off();
    ingest.submit('r', asIngestable(FIXTURE_EVENTS[2], 'r'));
    assert.deepEqual(seen, [0, 1]);
    assert.equal(ingest.subscriberCount('r'), 0);
    assert.equal(ingest.isFinished('r'), false);
    ingest.close();
    store.close();
  });
});

describe('GET / and the bind', () => {
  test('GET / is 200 with a real body and is not a redirect', { timeout: 15000 }, async () => {
    const s = await startServer();
    const r = await request(`${s.base}/`, { token: null });   // the landing page needs no token
    assert.equal(r.status, 200);
    assert.ok(r.status < 300 || r.status >= 400, 'must not be a 3xx');
    assert.equal(r.headers.location, undefined, 'must not send a Location header');
    assert.ok(r.body.length > 200, `body was ${r.body.length} bytes`);
    assert.match(r.body.toString('utf8'), /Kinux run server/);
    assert.match(r.headers['content-type'], /text\/html/);
  });

  test('the server is reachable over IPv4 loopback', { timeout: 15000 }, async () => {
    const s = await startServer();
    assert.ok(s.addresses.includes('127.0.0.1'), `bound: ${s.addresses.join(', ')}`);
    assert.equal(await probeTcp('127.0.0.1', s.port), true);
    assert.equal((await request(`http://127.0.0.1:${s.port}/healthz`)).status, 200);
  });

  test('the server is reachable over IPv6 loopback on the same port', { timeout: 15000 }, async t => {
    if (!(await hasIpv6())) {
      // Not a pass: this host has no IPv6 stack at all, so the bind cannot be
      // exercised here. The listener is attempted and EAFNOSUPPORT is tolerated.
      t.skip('this host has no IPv6 (binding ::1 fails with EAFNOSUPPORT)');
      return;
    }
    const s = await startServer();
    assert.deepEqual(s.addresses, ['127.0.0.1', '::1'], 'both families bound on one port');
    assert.equal(await probeTcp('::1', s.port), true);
    assert.equal((await request(`http://[::1]:${s.port}/healthz`)).status, 200);
    assert.equal((await request(`http://127.0.0.1:${s.port}/healthz`)).status, 200);
  });
});

describe('SSE', () => {
  test('delivers events in seq order with correct framing', { timeout: 20000 }, async () => {
    const s = await startServer();
    loadJsonl({ ingest: s.server.ingest, path: FIXTURE });

    const sse = openSse(s.base, `/runs/${FIXTURE_RUN}/events`);
    const why = await sse.done;                       // the server ends it at run.finished
    assert.ok(why === 'ended' || why === 'closed', why);
    assert.equal(sse.status, 200);

    const text = sse.text;
    assert.ok(text.startsWith(framePreamble()), 'starts with the retry preamble');
    assert.ok(text.endsWith('\n\n'), 'every frame is terminated by a blank line');
    assert.ok(!text.includes(': heartbeat'), 'a fast run needs no heartbeat');

    const frames = sse.frames.filter(f => f.id !== null);
    assert.equal(frames.length, FIXTURE_EVENTS.length);
    assert.deepEqual(frames.map(f => Number(f.id)), FIXTURE_EVENTS.map((_, i) => i));
    frames.forEach((f, i) => {
      assert.equal(f.event, FIXTURE_EVENTS[i].type);
      const ev = JSON.parse(f.data);
      assert.equal(ev.seq, i);
      assert.equal(ev.run_id, FIXTURE_RUN);
      assert.match(f.raw, /^id: \d+\nevent: [a-z.]+\ndata: \{.*\}$/s);
    });
  });

  test('a heartbeat keeps an idle stream alive', { timeout: 20000 }, async () => {
    const s = await startServer();
    s.server.ingest.open('idle-run');
    s.server.ingest.submit('idle-run', asIngestable(FIXTURE_EVENTS[0], 'idle-run'));
    const sse = openSse(s.base, '/runs/idle-run/events?heartbeat_ms=60');
    const until = Date.now() + 6000;
    while (!sse.text.includes(': heartbeat') && Date.now() < until) {
      await new Promise(r => setTimeout(r, 25));
    }
    sse.abort();
    assert.match(sse.text, /: heartbeat\n\n/, 'an idle stream gets heartbeat comments');
    // The heartbeat is a comment, so it carries no event and no id.
    const beats = sse.frames.filter(f => f.comment === 'heartbeat');
    assert.ok(beats.length >= 1);
    for (const b of beats) assert.equal(b.id, null);
  });

  test('events.jsonl returns the whole log, byte for byte', { timeout: 15000 }, async () => {
    const s = await startServer();
    loadJsonl({ ingest: s.server.ingest, path: FIXTURE });
    const r = await request(`${s.base}/runs/${FIXTURE_RUN}/events.jsonl`);
    assert.equal(r.status, 200);
    assert.equal(r.body.toString('utf8'), s.server.store.readLog(FIXTURE_RUN));
    const lines = r.body.toString('utf8').trim().split('\n');
    assert.equal(lines.length, FIXTURE_EVENTS.length);
  });
});

describe('resume with Last-Event-ID', () => {
  test('Last-Event-ID means "I have this seq", so the next event is seq + 1', { timeout: 10000 }, () => {
    assert.equal(resumeFrom(null), 0);
    assert.equal(resumeFrom(''), 0);
    assert.equal(resumeFrom('0'), 1);
    assert.equal(resumeFrom('5'), 6);
    assert.equal(resumeFrom('nonsense'), 0);
    assert.equal(resumeFrom('-3'), 0);
  });

  test('disconnect mid-stream, reconnect with Last-Event-ID: no gap and no duplicate', { timeout: 30000 }, async () => {
    const s = await startServer();
    const runId = 'resume-run';
    s.server.ingest.open(runId);

    // A live run: the client is connected before the events exist.
    const first = openSse(s.base, `/runs/${runId}/events`);
    await new Promise(r => setTimeout(r, 50));

    const events = FIXTURE_EVENTS.map(ev => asIngestable(ev, runId));
    const CUT = 9;
    for (const ev of events.slice(0, CUT + 1)) {
      const r = await postEvent(s.base, runId, ev);
      assert.equal(r.status, 202, r.body.toString('utf8'));
    }
    await first.waitForId(CUT);

    // Disconnect mid-run, while there is more to come.
    const firstIds = first.ids;
    first.abort();
    await new Promise(r => setTimeout(r, 50));
    const last = firstIds[firstIds.length - 1];
    assert.deepEqual(firstIds, firstIds.map((_, i) => i), 'the first leg is 0..n with no gaps');

    // More events arrive while nobody is watching.
    for (const ev of events.slice(CUT + 1, CUT + 5)) {
      assert.equal((await postEvent(s.base, runId, ev)).status, 202);
    }

    // Reconnect from exactly where we left off.
    const second = openSse(s.base, `/runs/${runId}/events`, { lastEventId: last });
    await second.waitForId(CUT + 4);
    for (const ev of events.slice(CUT + 5)) {
      assert.equal((await postEvent(s.base, runId, ev)).status, 202);
    }
    await second.done;

    const secondIds = second.ids;
    assert.equal(secondIds[0], last + 1, 'resumes at last + 1: no duplicate of the last event');

    const all = [...firstIds, ...secondIds];
    assert.deepEqual(all, events.map((_, i) => i), 'the two legs join into 0..N-1: no gap, no duplicate');
    assert.equal(new Set(all).size, all.length, 'no duplicate');

    // And the resumed frames are exactly the frames the log holds.
    const stored = s.server.store.readFrom(runId, last + 1);
    assert.equal(
      second.frames.filter(f => f.id !== null).map(f => f.raw + '\n\n').join(''),
      stored.map(frameEvent).join(''),
    );
  });

  test('resuming past the end waits instead of replaying anything', { timeout: 15000 }, async () => {
    const s = await startServer();
    const runId = 'resume-tail';
    loadJsonl({ ingest: s.server.ingest, path: FIXTURE, runId });
    const sse = openSse(s.base, `/runs/${runId}/events`, { lastEventId: 28 });
    await new Promise(r => setTimeout(r, 200));
    sse.abort();
    assert.deepEqual(sse.ids, [], 'nothing left to send');
    assert.equal(sse.text, framePreamble());
  });
});

describe('replay is byte-identical to the live stream', () => {
  test('a live stream and a replay of the same run produce the same bytes', { timeout: 30000 }, async () => {
    const s = await startServer();
    const runId = 'identical-run';
    s.server.ingest.open(runId);

    // Watch it live, from before the first event to the run.finished that closes it.
    const live = openSse(s.base, `/runs/${runId}/events?heartbeat_ms=60000`);
    await new Promise(r => setTimeout(r, 50));
    for (const ev of FIXTURE_EVENTS) {
      const r = await postEvent(s.base, runId, asIngestable(ev, runId));
      assert.equal(r.status, 202, r.body.toString('utf8'));
    }
    await live.done;
    const liveBytes = live.buffer;
    assert.ok(liveBytes.length > 0);
    assert.ok(!live.text.includes(': heartbeat'));

    // Now replay the finished run through the same handler.
    const replayed = replayBytes({ ingest: s.server.ingest, runId });
    assert.equal(replayed.length, liveBytes.length, 'same number of bytes');
    assert.ok(replayed.equals(liveBytes), 'a replay is byte-identical to the live stream');

    // The same holds over HTTP, and for a replay that resumes.
    const overHttp = await request(`${s.base}/runs/${runId}/events`);
    assert.ok(Buffer.from(overHttp.body).equals(liveBytes), 'replay over HTTP matches too');
    const resumedReplay = replayBytes({ ingest: s.server.ingest, runId, lastEventId: 9 });
    const resumedHttp = await request(`${s.base}/runs/${runId}/events`, { headers: { 'last-event-id': '9' } });
    assert.ok(resumedReplay.equals(Buffer.from(resumedHttp.body)), 'a resumed replay matches a resumed live stream');
  });

  test('replayTo-style sinks see the same bytes as replayBytes', { timeout: 15000 }, async () => {
    const s = await startServer();
    loadJsonl({ ingest: s.server.ingest, path: FIXTURE });
    const a = replayBytes({ ingest: s.server.ingest, runId: FIXTURE_RUN });
    const sink = new BufferSink();
    sink.write(a);
    assert.ok(sink.buffer.equals(a));
    assert.equal(sink.text.startsWith('retry: '), true);
  });
});

describe('tokens: a view token reads, a drive token drives', () => {
  test('a view token cannot POST; a drive token can', { timeout: 20000 }, async () => {
    const s = await startServer();
    const runId = 'token-run';
    const ev = asIngestable(FIXTURE_EVENTS[0], runId);

    const refused = await getJson(`${s.base}/runs/${runId}/events`, {
      method: 'POST', token: VIEW,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev),
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, 'view_token_cannot_write');
    assert.equal(s.server.store.hasRun(runId), false, 'nothing was written');

    // Every write path, not just this one.
    for (const [method, path] of [['POST', '/runs'], ['POST', '/artifacts'], ['PUT', `/runs/${runId}/events`], ['DELETE', '/runs']]) {
      const r = await getJson(`${s.base}${path}`, { method, token: VIEW, body: '{}' });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.json.error, 'view_token_cannot_write');
    }

    const accepted = await getJson(`${s.base}/runs/${runId}/events`, {
      method: 'POST', token: DRIVE,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.json.seqs, [0]);

    // A view token still reads.
    const read = await getJson(`${s.base}/runs/${runId}`, { token: VIEW });
    assert.equal(read.status, 200);
    assert.equal(read.json.events, 1);
  });

  test('no token, an unknown token and an expired token are all 401', { timeout: 15000 }, async () => {
    const s = await startServer();
    assert.equal((await getJson(`${s.base}/runs`, { token: null })).json.error, 'no_token');
    assert.equal((await getJson(`${s.base}/runs`, { token: 'nope' })).json.error, 'unknown_token');
    assert.equal((await request(`${s.base}/runs`, { token: null })).status, 401);

    const tokens = new TokenSet([{ token: 'gone', scope: 'view', expires_at: Date.now() - 1 }]);
    assert.equal(tokens.verify('gone').reason, 'token_expired');
    assert.equal(tokens.verify('gone', { method: 'POST' }).reason, 'token_expired');
  });

  test('a run-scoped token cannot read another run', { timeout: 15000 }, async () => {
    const tokens = new TokenSet([
      { token: 'scoped', scope: 'view', run_id: 'mine' },
      { token: DRIVE, scope: 'drive' },
    ]);
    const s = await startServer({ tokens });
    s.server.ingest.open('mine');
    s.server.ingest.open('yours');
    assert.equal((await request(`${s.base}/runs/mine`, { token: 'scoped' })).status, 200);
    const other = await getJson(`${s.base}/runs/yours`, { token: 'scoped' });
    assert.equal(other.status, 403);
    assert.equal(other.json.error, 'token_not_scoped_to_run');
  });

  test('a token can also travel in a query string or a cookie, not only a header', { timeout: 15000 }, async () => {
    const s = await startServer();
    assert.equal((await request(`${s.base}/runs?token=${VIEW}`, { token: null })).status, 200);
    assert.equal((await request(`${s.base}/runs`, { token: null, headers: { cookie: `kinux_token=${VIEW}` } })).status, 200);
    assert.equal((await request(`${s.base}/runs`, { token: null, headers: { 'x-kinux-token': VIEW } })).status, 200);
  });
});

describe('artifacts by hash', () => {
  test('POST /artifacts then GET /artifacts/:hash returns the same bytes', { timeout: 15000 }, async () => {
    const s = await startServer();
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    const put = await getJson(`${s.base}/artifacts`, { method: 'POST', token: DRIVE, body: bytes });
    assert.equal(put.status, 201);
    assert.equal(put.json.hash, sha256(bytes));

    const got = await request(`${s.base}/artifacts/${put.json.hash}`);
    assert.equal(got.status, 200);
    assert.ok(Buffer.from(got.body).equals(bytes));
    assert.equal(got.headers.etag, `"${put.json.hash}"`);

    assert.equal((await request(`${s.base}/artifacts/sha256:${'0'.repeat(64)}`)).status, 404);
    assert.equal((await request(`${s.base}/artifacts/not-a-hash`)).status, 400);
    assert.equal((await request(`${s.base}/artifacts/sha256:${'z'.repeat(64)}`)).status, 400);
    // A traversal attempt never reaches the artifact directory: the hash pattern
    // is the only accepted shape.
    const trav = await request(`${s.base}/artifacts/${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(trav.status, 400);
  });
});

describe('the fixture run', () => {
  test('every event the server serves passes validateEvent', { timeout: 20000 }, async () => {
    const s = await startServer();
    loadJsonl({ ingest: s.server.ingest, path: FIXTURE });

    const log = await request(`${s.base}/runs/${FIXTURE_RUN}/events.jsonl`);
    const fromLog = log.body.toString('utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(fromLog.length, FIXTURE_EVENTS.length);
    for (const ev of fromLog) {
      const { ok, errors } = validateEvent(ev);
      assert.ok(ok, `events.jsonl event ${ev.seq}: ${errors.join('; ')}`);
    }

    const sse = openSse(s.base, `/runs/${FIXTURE_RUN}/events`);
    await sse.done;
    const fromSse = sse.frames.filter(f => f.id !== null).map(f => JSON.parse(f.data));
    assert.equal(fromSse.length, FIXTURE_EVENTS.length);
    for (const ev of fromSse) {
      const { ok, errors } = validateEvent(ev);
      assert.ok(ok, `sse event ${ev.seq}: ${errors.join('; ')}`);
    }
    assert.deepEqual(fromSse, fromLog, 'the stream and the log carry the same events');
  });

  test('a replay is labelled recorded when asked, and still validates', { timeout: 15000 }, async () => {
    const s = await startServer();
    loadJsonl({ ingest: s.server.ingest, path: FIXTURE, runId: 'recorded-run', provenance: 'recorded' });
    const r = await request(`${s.base}/runs/recorded-run/events.jsonl`);
    const events = r.body.toString('utf8').trim().split('\n').map(l => JSON.parse(l));
    for (const ev of events) {
      assert.equal(ev.provenance, 'recorded');
      assert.ok(validateEvent(ev).ok);
    }
  });

  test('unknown runs and paths are 404, not a hang', { timeout: 15000 }, async () => {
    const s = await startServer();
    assert.equal((await request(`${s.base}/runs/nope`)).status, 404);
    assert.equal((await request(`${s.base}/nope`)).status, 404);
    assert.equal((await request(`${s.base}/runs/nope/events.jsonl`)).status, 404);
  });
});

describe('shutdown', () => {
  test('closing leaves no stream, no socket and no listener behind', { timeout: 20000 }, async () => {
    const root = join(dir, 'shutdown');
    const server = createRunServer({ root, validate: validateEvent, requireToken: false });
    const { port, addresses } = await server.listen({ port: 0 });
    const base = `http://127.0.0.1:${port}`;
    server.ingest.open('live');
    server.ingest.submit('live', asIngestable(FIXTURE_EVENTS[0], 'live'));

    const sse = openSse(base, '/runs/live/events', { token: null });
    await sse.waitForId(0);
    assert.equal(server.streamCount, 1);

    await server.close();
    await sse.done;                                   // the server ended the stream itself

    assert.equal(server.streamCount, 0);
    assert.equal(server.openSockets, 0);
    assert.equal(server.listeners.length, 0);
    for (const addr of addresses) assert.equal(await probeTcp(addr, port, 1000), false, `${addr} still listening`);
    await server.close();                             // closing twice is safe
  });
});
