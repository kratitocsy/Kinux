// The engine streaming into the run server while a verification runs.
//
// The integration tests use the real ngspice binary and the real run server.
// The one that matters most proves the stream is LIVE: a client that receives
// every event only after the run has finished would pass a naive "events
// arrive" test, so instead we record how far the engine had got at the moment
// the client saw its first event, and require that it was still mid-run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveBridge, serveRun } from '../engine/live.mjs';
import { main, parseArgs } from '../engine/cli.mjs';
import { createRunServer } from '../server/run/server.mjs';
import { Ingest } from '../server/run/ingest.mjs';
import { RunStore } from '../server/run/store.mjs';
import { checkRun, validateEvent } from '../contracts/check-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = join(ROOT, 'engine/fixtures/divider-rc.cir');
const CHECKS = join(ROOT, 'engine/fixtures/checks-thorough.md');
const HASH = 'sha256:' + 'a'.repeat(64);

function ev(seq, type = 'test.queued', data = { test_id: `t${seq}`, title: 'x', layer: 'netlist', solver: 'ngspice' }) {
  return {
    v: 1, run_id: 'r1', seq, ts: new Date(0).toISOString(), type,
    actor: { kind: 'system', id: 'test' }, design_hash: HASH, provenance: 'real', data,
  };
}

// ---- a minimal SSE client --------------------------------------------------

/** Read an SSE stream to its end, calling onEvent for every data frame. */
function readSSE(url, onEvent) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get(url, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`SSE returned ${res.statusCode}`));
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', chunk => {
        buf += chunk;
        let cut;
        while ((cut = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (!data) continue; // a heartbeat or retry line
          const e = JSON.parse(data);
          events.push(e);
          onEvent?.(e);
        }
      });
      res.on('end', () => resolve(events));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function request(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- the bridge on its own -------------------------------------------------

test('the bridge forwards every event and counts it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ingest = new Ingest({ store: new RunStore(dir), validate: validateEvent });
  const bridge = createLiveBridge({ ingest, runId: 'r1' });

  for (let i = 0; i < 4; i++) bridge.sink(ev(i));

  assert.equal(bridge.delivered, 4);
  assert.equal(bridge.ok, true);
  assert.deepEqual(bridge.errors, []);
  assert.match(bridge.summary(), /streamed 4 events/);
});

test('a failing submit never throws out of the sink, so it cannot abort a run', () => {
  const ingest = {
    open() {},
    submit() { const e = new Error('disk full'); e.code = 'store_failed'; throw e; },
  };
  const bridge = createLiveBridge({ ingest, runId: 'r1' });

  assert.doesNotThrow(() => bridge.sink(ev(0)));
  assert.doesNotThrow(() => bridge.sink(ev(1)));
  assert.equal(bridge.delivered, 0);
});

test('but a failure is never swallowed: it is kept, counted and named', () => {
  const ingest = {
    open() {},
    submit() { const e = new Error('disk full'); e.code = 'store_failed'; throw e; },
  };
  const bridge = createLiveBridge({ ingest, runId: 'r1' });
  bridge.sink(ev(0));
  bridge.sink(ev(1, 'test.queued'));

  assert.equal(bridge.ok, false);
  assert.equal(bridge.errors.length, 2);
  assert.deepEqual(bridge.errors[0], { seq: 0, type: 'test.queued', code: 'store_failed', message: 'disk full' });
  assert.match(bridge.summary(), /2 NOT delivered/);
  assert.match(bridge.summary(), /store_failed: disk full/);
});

test('a seq divergence between engine and server is recorded as seq_not_yours, not renumbered', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ingest = new Ingest({ store: new RunStore(dir), validate: validateEvent });
  const bridge = createLiveBridge({ ingest, runId: 'r1' });

  bridge.sink(ev(0));
  bridge.sink(ev(5)); // the engine skipped ahead; the server expects 1

  assert.equal(bridge.delivered, 1);
  assert.equal(bridge.errors.length, 1);
  assert.equal(bridge.errors[0].code, 'seq_not_yours');
  assert.equal(bridge.errors[0].seq, 5);
});

test('an onError reporter that itself throws does not break the sink', () => {
  const ingest = { open() {}, submit() { throw new Error('nope'); } };
  const bridge = createLiveBridge({ ingest, runId: 'r1', onError: () => { throw new Error('reporter broke'); } });
  assert.doesNotThrow(() => bridge.sink(ev(0)));
  assert.equal(bridge.errors.length, 1);
});

test('the bridge refuses to start without an ingest or a run id', () => {
  assert.throws(() => createLiveBridge({ runId: 'r1' }), TypeError);
  assert.throws(() => createLiveBridge({ ingest: { open() {}, submit() {} } }), TypeError);
});

// ---- the CLI flag ----------------------------------------------------------

test('--serve takes an optional port and never swallows the next flag', () => {
  assert.equal(parseArgs(['verify', 'd.cir', '--checks', 'c.md']).serve, false);

  const bare = parseArgs(['verify', 'd.cir', '--checks', 'c.md', '--serve']);
  assert.equal(bare.serve, true);
  assert.equal(bare.port, 0);

  const withPort = parseArgs(['verify', 'd.cir', '--checks', 'c.md', '--serve', '7777']);
  assert.equal(withPort.port, 7777);

  const thenFlag = parseArgs(['verify', 'd.cir', '--checks', 'c.md', '--serve', '--json']);
  assert.equal(thenFlag.serve, true);
  assert.equal(thenFlag.json, true, '--serve must not consume --json as its port');
});

// ---- read-only over HTTP ---------------------------------------------------

test('a served run is read-only over HTTP: no credential exists that can write to it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-live-'));
  const live = await serveRun({ createRunServer, validate: validateEvent, runId: 'r1', root: dir });
  t.after(async () => { await live.close(); await rm(dir, { recursive: true, force: true }); });

  live.bridge.sink(ev(0, 'run.started', { project: 'p', domain: 'electronics', source: 'live' }));
  const before = (await request(live.jsonlUrl)).body;

  // The view token it hands out can read ...
  assert.equal((await request(live.jsonlUrl)).status, 200);

  // ... but not write, through any route, even holding that token.
  const forged = JSON.stringify(ev(1, 'run.finished', { status: 'completed', summary: 'forged' }));
  const post = await request(`${live.base}/runs/r1/events?token=${live.token}`, {
    method: 'POST', body: forged, headers: { 'content-type': 'application/json' },
  });
  assert.ok(post.status === 401 || post.status === 403, `a POST with the view token must be refused, got ${post.status}`);

  // And without a token nothing is readable either.
  assert.equal((await request(`${live.base}/runs/r1/events.jsonl`)).status, 401);

  assert.equal((await request(live.jsonlUrl)).body, before, 'the log must be unchanged after the refused write');
});

// ---- the real thing: engine -> server -> SSE client -------------------------

test('an engine run streams LIVE: the client sees events while the engine is still producing them', { timeout: 120_000 }, async t => {
  const out = await mkdtemp(join(tmpdir(), 'kinux-live-run-'));
  t.after(() => rm(out, { recursive: true, force: true }));

  let live = null;
  let client = null;
  let deliveredAtFirstReceipt = null;

  const code = await main(
    ['verify', DESIGN, '--checks', CHECKS, '--out', out, '--serve', '--limit', '10', '--no-queue', '--quiet'],
    {
      holdServer: false,
      onServe: l => {
        live = l;
        // Attach before the run starts, exactly as a person opening the URL would.
        client = readSSE(l.eventsUrl, () => {
          if (deliveredAtFirstReceipt === null) deliveredAtFirstReceipt = l.bridge.delivered;
        });
      },
    },
  );

  assert.ok(live, 'onServe was called');
  const received = await client;
  const totalDelivered = live.bridge.delivered;

  assert.ok(code === 0 || code === 1, `the verification itself ran (exit ${code})`);
  assert.equal(live.bridge.ok, true, live.bridge.summary());
  assert.ok(received.length > 0, 'the client received events');

  // THE LIVENESS PROOF. When the client saw its first event, the engine had
  // delivered only part of the run: the stream was carrying the run as it
  // happened, not replaying it afterwards.
  assert.ok(deliveredAtFirstReceipt !== null);
  assert.ok(
    deliveredAtFirstReceipt < totalDelivered,
    `first event reached the client after ${deliveredAtFirstReceipt} of ${totalDelivered} were delivered -- that is a replay, not a live stream`,
  );

  // Nothing lost, nothing invented: the client got exactly the run.
  assert.equal(received.length, totalDelivered);
  assert.equal(received[0].type, 'run.started');
  assert.equal(received.at(-1).type, 'run.finished');
  received.forEach((e, i) => assert.equal(e.seq, i, `seq ${i} arrived in order with no gap`));
});

test('what streamed live is exactly what the engine wrote to events.jsonl', { timeout: 120_000 }, async t => {
  const out = await mkdtemp(join(tmpdir(), 'kinux-live-run-'));
  t.after(() => rm(out, { recursive: true, force: true }));

  let client = null;
  await main(
    ['verify', DESIGN, '--checks', CHECKS, '--out', out, '--serve', '--limit', '6', '--no-queue', '--quiet'],
    { holdServer: false, onServe: l => { client = readSSE(l.eventsUrl); } },
  );
  const streamed = await client;
  const written = (await readFile(join(out, 'events.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));

  // The file is the record and the stream is a view of it. They must agree.
  assert.equal(streamed.length, written.length);
  assert.deepEqual(streamed, written);

  // And what crossed the wire is a valid, consistent run by the contract.
  for (const e of streamed) assert.equal(validateEvent(e).ok, true, `seq ${e.seq} is a valid event`);
  assert.deepEqual(checkRun(streamed), [], 'the streamed run passes checkRun with zero problems');
  assert.ok(streamed.every(e => e.provenance === 'real'), 'every streamed event is real: ngspice produced it');
});

test('a run that cannot start does not leave a server holding the process open', { timeout: 30_000 }, async t => {
  const out = await mkdtemp(join(tmpdir(), 'kinux-live-run-'));
  t.after(() => rm(out, { recursive: true, force: true }));

  let live = null;
  const errors = [];
  // An empty design makes runVerification throw after the server has started.
  // (A netlist with a title and no elements does NOT: it runs, finds nothing
  // checkable and exits 1, which is the honest outcome, so it cannot reach the
  // path this test is about.)
  const bad = join(out, 'bad.cir');
  await (await import('node:fs/promises')).writeFile(bad, '');

  const code = await main(
    ['verify', bad, '--checks', CHECKS, '--out', out, '--serve', '--quiet'],
    { holdServer: false, onServe: l => { live = l; }, error: s => errors.push(s) },
  );

  assert.equal(code, 2);
  assert.ok(live, 'the server had started before the run failed');
  assert.equal(live.server.listeners.length, 0, 'every listener was closed');
});

// ---- the viewer, served from the same origin as its stream -----------------

const VIEWER_DIR = join(ROOT, 'viewer');

async function servedWithViewer(t, runId = 'r1') {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-live-'));
  const live = await serveRun({ createRunServer, validate: validateEvent, runId, root: dir, viewerRoot: VIEWER_DIR });
  t.after(async () => { await live.close(); await rm(dir, { recursive: true, force: true }); });
  return live;
}

test('the viewer is served same-origin, without a token, as runnable ES modules', async t => {
  const live = await servedWithViewer(t);

  const page = await request(`${live.base}/viewer/index.html`);
  assert.equal(page.status, 200, 'the page itself needs no token: it holds no run data');

  // Browsers refuse to execute a module served with the wrong type, so this is
  // not cosmetic: get it wrong and the page is blank.
  const mod = await new Promise((resolve, reject) => {
    http.get(`${live.base}/viewer/app.mjs`, res => { res.resume(); resolve(res); }).on('error', reject);
  });
  assert.equal(mod.statusCode, 200);
  assert.match(mod.headers['content-type'], /^text\/javascript/);
  assert.equal(mod.headers['x-content-type-options'], 'nosniff');

  assert.ok(live.viewerUrl.startsWith(`${live.base}/viewer/index.html?sse=`));
  assert.ok(decodeURIComponent(live.viewerUrl.split('?sse=')[1]).startsWith('/runs/r1/events?token='),
    'the viewer follows the stream by a relative url, so no CORS is needed');
});

test('no spelling of a path escapes the viewer directory', async t => {
  const live = await servedWithViewer(t);
  const secret = await readFile(join(ROOT, 'package.json'), 'utf8');

  for (const p of [
    '/viewer/../package.json',
    '/viewer/%2e%2e/package.json',
    '/viewer/..%2fpackage.json',
    '/viewer/..%2F..%2Fpackage.json',
    '/viewer/%2e%2e%2fpackage.json',
    '/viewer/panels/../../package.json',
    '/viewer//etc/passwd',
    '/viewer/%00index.html',
  ]) {
    const r = await new Promise((resolve, reject) => {
      const req = http.request(`${live.base}${p}`, { method: 'GET' }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.notEqual(r.status, 200, `${p} must not be served`);
    assert.ok(!r.body.includes('"name": "kinux"') && r.body !== secret, `${p} must not leak package.json`);
  }
});

test('a write to a viewer path is not a viewer request: it meets the token gate', async t => {
  const live = await servedWithViewer(t);
  const r = await request(`${live.base}/viewer/index.html`, { method: 'POST', body: 'x' });
  assert.equal(r.status, 401);
});

test('serving files is opt-in: without viewerRoot the server serves none', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kinux-live-'));
  const live = await serveRun({ createRunServer, validate: validateEvent, runId: 'r1', root: dir });
  t.after(async () => { await live.close(); await rm(dir, { recursive: true, force: true }); });

  assert.equal(live.viewerUrl, null);
  assert.notEqual((await request(`${live.base}/viewer/index.html`)).status, 200);
});

test('in a real browser, the panels fill WHILE the solver is still running', { timeout: 180_000 }, async t => {
  const { createRequire } = await import('node:module');
  const { chromium } = createRequire(import.meta.url)('playwright');
  const { runVerification } = await import('../engine/runner.mjs');
  const { buildReport, finishRun } = await import('../engine/report.mjs');
  const { loadSuite } = await import('../engine/cli.mjs');

  const live = await servedWithViewer(t, 'browser-run');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  // Open the URL the CLI prints, and wait until its stream is actually open,
  // exactly as a person who opened the link before starting a run would be.
  const streamOpened = page.waitForResponse(r => r.url().includes('/runs/browser-run/events'));
  await page.goto(live.viewerUrl);
  await streamOpened;

  // Watch the DOM from outside while the engine runs. The moment the first log
  // line appears, record how much of the run the engine had produced.
  let deliveredWhenBrowserFirstShowed = null;
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      if ((await page.locator('[data-testid="log-item"]').count()) > 0) {
        deliveredWhenBrowserFirstShowed = live.bridge.delivered;
        return;
      }
      await new Promise(r => setTimeout(r, 10));
    }
  })();

  const outcome = await runVerification({
    netlist: await readFile(DESIGN, 'utf8'),
    suite: loadSuite(CHECKS),
    limit: 12,
    runId: 'browser-run',
    useQueue: false,
    onEvent: live.bridge.sink,
  });
  finishRun(outcome, buildReport(outcome, { threshold: 0.7 }));
  watching = false;
  await watcher;

  const total = live.bridge.delivered;
  assert.equal(live.bridge.ok, true, live.bridge.summary());

  // THE PROOF, in the browser this time.
  assert.ok(deliveredWhenBrowserFirstShowed !== null, 'the browser rendered a log line');
  assert.ok(deliveredWhenBrowserFirstShowed < total,
    `the first log line appeared after ${deliveredWhenBrowserFirstShowed} of ${total} events -- the panels filled after the run, not during it`);

  // And at the end the page holds the whole run, labelled as what it is.
  await page.waitForFunction(n => document.querySelectorAll('[data-testid="log-item"]').length === n, total, { timeout: 30_000 });
  assert.equal(await page.locator('[data-testid="provenance-overall"]').getAttribute('data-provenance'), 'real');
  assert.equal(await page.locator('[data-provenance="synthetic"]').count(), 0, 'nothing on the page claims to be synthetic');
  assert.deepEqual(errors, [], 'the page threw no errors');

  // To a temp dir, never into the repo: a test that writes tracked files dirties
  // the working tree on every run. KINUX_SCREENSHOT=<path> keeps a copy.
  await page.screenshot({ path: process.env.KINUX_SCREENSHOT ?? join(tmpdir(), `kinux-live-${process.pid}.png`) });
  t.diagnostic(`browser showed its first line after ${deliveredWhenBrowserFirstShowed} of ${total} events`);
});
