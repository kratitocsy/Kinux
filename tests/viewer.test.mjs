// Tests for the Kinux viewer: the reducer, the provenance badges, the score
// display, cross-panel selection and the static export.
//
// Browser assertions run in real Chromium through Playwright. The viewer is
// served over a throwaway static server from the repo root so that the module
// graph loads exactly as it does in development.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

import { checkRun, computeScore, wilson } from '../contracts/check-run.mjs';
import {
  parseJSONL, replay, createStore, reduce, initialState,
  sourceFromJSONL, sourceFromSSE, loadInto, badgeFor, weakerProvenance,
  expandSelection, measurementSeries, mutationRows,
} from '../viewer/reducer.mjs';
import { exportRunHTML, buildBundle } from '../viewer/export.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURE = join(ROOT, 'contracts/fixtures/valid-run.events.jsonl');
const FIXTURE_TEXT = readFileSync(FIXTURE, 'utf8');
const EVENTS = parseJSONL(FIXTURE_TEXT);

const clone = e => JSON.parse(JSON.stringify(e));
const withProvenance = (events, fn) => events.map((e, i) => { const c = clone(e); c.provenance = fn(c, i); return c; });

const ALL_REAL = withProvenance(EVENTS, () => 'real');
// Mixed: real everywhere except one event feeding the design panel and one
// feeding the instruments panel. Every panel must therefore show SYNTHETIC.
const MIXED = withProvenance(EVENTS, e =>
  e.type === 'run.started' || (e.type === 'test.result' && e.data.subject === 'M1') ? 'synthetic' : 'real');
const MIXED_RECORDED = withProvenance(EVENTS, e =>
  e.type === 'run.started' || e.type === 'mutation.result' ? 'recorded' : 'real');

const toJSONL = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';

// --- a tiny static server, plus virtual fixtures under /__fixtures/ --------

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.png': 'image/png' };

function startStatic(virtual = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (virtual[path] !== undefined) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(virtual[path]);
      return;
    }
    if (path === '/__sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const e of EVENTS) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
      res.write('event: done\ndata: [DONE]\n\n');
      res.end();
      return;
    }
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

let srv, port, browser;
const VIRTUAL = {
  '/__fixtures/real.jsonl': toJSONL(ALL_REAL),
  '/__fixtures/mixed.jsonl': toJSONL(MIXED),
  '/__fixtures/mixed-recorded.jsonl': toJSONL(MIXED_RECORDED),
};

before(async () => {
  ({ server: srv, port } = await startStatic(VIRTUAL));
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  srv?.close();
});

async function openViewer(query) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/viewer/index.html${query ? '?' + query : ''}`);
  await page.waitForSelector('[data-testid="provenance-instruments"]');
  return page;
}

// ===========================================================================
// 1. The fixture itself, through the contract validators
// ===========================================================================

test('the fixture is a consistent run by the contract rules', () => {
  assert.deepEqual(checkRun(EVENTS), []);
  assert.equal(EVENTS.length, 29);
  assert.ok(EVENTS.every(e => e.provenance === 'synthetic'));
});

// ===========================================================================
// 2. Reducer
// ===========================================================================

test('replaying the fixture gives the expected state', () => {
  const s = replay(EVENTS);
  assert.equal(s.run.run_id, 'demo-divider-001');
  assert.equal(s.run.project, 'voltage-divider-demo');
  assert.equal(s.run.domain, 'electronics');
  assert.equal(s.run.source, 'synthetic');
  assert.equal(s.run.finished.status, 'completed');
  assert.equal(s.eventCount, 29);
  assert.equal(s.log.length, 29);
  assert.deepEqual(s.gaps, []);
  assert.deepEqual(s.problems, []);
  assert.deepEqual(s.testOrder, ['T1', 'T2', 'T3']);
  assert.deepEqual(s.mutantOrder, ['M1', 'M2', 'M3', 'M4', 'M5']);
  assert.equal(s.mutants.M2.status, 'survived');
  assert.deepEqual(s.mutants.M1.killed_by, ['T1']);
  assert.equal(s.artifacts.length, 1);
  assert.equal(s.artifacts[0].kind, 'waveform');
  assert.equal(s.provenance.overall, 'synthetic');

  // The score the viewer derives must equal the contract's own computation,
  // and the run.score event must agree with both.
  const want = computeScore(['killed', 'survived', 'killed', 'not_checked', 'equivalent']);
  assert.deepEqual(s.derivedScore, want);
  for (const k of Object.keys(want)) assert.equal(s.score[k], want[k]);
  assert.equal(s.derivedScore.score, 2 / 3);
  assert.equal(s.derivedScore.checkable_fraction, 0.6);
  assert.deepEqual([s.derivedScore.ci_low, s.derivedScore.ci_high], wilson(2, 3));
});

test('feeding the same events one at a time gives an identical state', async () => {
  const bulk = replay(EVENTS);

  const store = createStore();
  for (const e of EVENTS) store.push(e);
  assert.deepEqual(JSON.parse(JSON.stringify(store.state)), JSON.parse(JSON.stringify(bulk)));

  // and through the JSONL source interface
  const s2 = createStore();
  await loadInto(s2, sourceFromJSONL(FIXTURE_TEXT));
  assert.deepEqual(JSON.parse(JSON.stringify(s2.state)), JSON.parse(JSON.stringify(bulk)));
});

test('an SSE stream produces exactly the state a file replay does', async () => {
  const store = createStore();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  await loadInto(store, sourceFromSSE(`http://127.0.0.1:${port}/__sse`));
  assert.equal(notifications, EVENTS.length);
  assert.deepEqual(
    JSON.parse(JSON.stringify(store.state)),
    JSON.parse(JSON.stringify(replay(EVENTS))),
  );
});

test('the reducer notices gaps and foreign run ids instead of hiding them', () => {
  const s = initialState();
  reduce(s, EVENTS[0]);
  reduce(s, EVENTS[5]);
  assert.deepEqual(s.gaps, [{ expected: 1, got: 5 }]);
  const foreign = clone(EVENTS[1]);
  foreign.run_id = 'other';
  foreign.seq = 6;
  reduce(s, foreign);
  assert.ok(s.problems.some(p => p.includes('differs from')));
});

test('weakerProvenance never returns the stronger label', () => {
  assert.equal(weakerProvenance('real', 'synthetic'), 'synthetic');
  assert.equal(weakerProvenance('synthetic', 'real'), 'synthetic');
  assert.equal(weakerProvenance('real', 'recorded'), 'recorded');
  assert.equal(weakerProvenance('recorded', 'synthetic'), 'synthetic');
  assert.equal(weakerProvenance(null, 'real'), 'real');
  assert.equal(weakerProvenance('real', 'real'), 'real');
});

test('badges: every panel of a synthetic run is synthetic, a real run is real', () => {
  const syn = replay(EVENTS);
  for (const panel of ['log', 'design', 'instruments', 'overall']) {
    const b = badgeFor(syn, panel);
    assert.equal(b.level, 'synthetic', panel);
    assert.equal(b.synthetic, true, panel);
    assert.equal(b.label, 'SYNTHETIC', panel);
  }
  const real = replay(ALL_REAL);
  for (const panel of ['log', 'design', 'instruments', 'overall']) {
    const b = badgeFor(real, panel);
    assert.equal(b.level, 'real', panel);
    assert.equal(b.synthetic, false, panel);
    assert.equal(b.mixed, false, panel);
  }
});

test('a mixed run reports the weaker label on every panel it touches', () => {
  const s = replay(MIXED);
  for (const panel of ['log', 'design', 'instruments', 'overall']) {
    const b = badgeFor(s, panel);
    assert.equal(b.level, 'synthetic', `${panel} must fall back to the weakest label`);
    assert.equal(b.mixed, true, panel);
    assert.ok(b.counts.real > 0, `${panel} really is mixed`);
    assert.equal(b.label, 'SYNTHETIC (MIXED)');
  }
  const rec = replay(MIXED_RECORDED);
  for (const panel of ['log', 'design', 'instruments', 'overall']) {
    assert.equal(badgeFor(rec, panel).level, 'recorded', panel);
  }
});

test('NOT_CHECKED and ERROR never count toward the score', () => {
  const s = replay(EVENTS);
  assert.equal(s.derivedScore.not_checked, 1);
  assert.equal(s.derivedScore.killed + s.derivedScore.survived, 3);
  assert.equal(s.derivedScore.total, 5);
  // a NOT_CHECKED measurement is never a plottable point
  const series = measurementSeries(s);
  const t1 = series.find(x => x.test.test_id === 'T1');
  assert.ok(t1.points.every(p => p.verdict === 'PASS' || p.verdict === 'FAIL'));
  assert.ok(t1.gaps.some(g => g.subject === 'M4' && g.verdict === 'NOT_CHECKED'));
  // and a not_checked mutant is never reported as killed
  const m4 = mutationRows(s).find(m => m.mutant_id === 'M4');
  assert.equal(m4.status, 'not_checked');
  assert.deepEqual(m4.killed_by, []);
});

test('selecting a mutant expands to its target, and its checks are reachable', () => {
  const s = replay(EVENTS);
  const sel = expandSelection(s, 'M2');
  assert.ok(sel.has('M2'));
  assert.ok(sel.has('C1'), 'the design element it targets');
  // test ids are deliberately NOT pulled in: every mutant's log lines mention
  // them, so the highlight would stop meaning anything.
  assert.equal(sel.has('T1'), false);
  // the checks on the selected subject are reachable by subject id
  const m2 = mutationRows(s).find(m => m.mutant_id === 'M2');
  assert.deepEqual(m2.checks.map(c => c.test_id), ['T1', 'T2', 'T3']);
  assert.ok(m2.checks.every(c => c.subject === 'M2'));
  // and selecting a check lights up the mutants it killed
  assert.deepEqual([...expandSelection(s, 'T1')].sort(), ['M1', 'M3', 'T1']);
});

// ===========================================================================
// 3. Browser: the provenance badge on every panel
// ===========================================================================

test('browser: a synthetic run shows a visible synthetic badge on every panel', async () => {
  const page = await openViewer();
  for (const panel of ['log', 'design', 'instruments']) {
    const badge = page.locator(`[data-testid="provenance-${panel}"]`);
    await badge.waitFor({ state: 'visible' });
    assert.equal(await badge.getAttribute('data-provenance'), 'synthetic', panel);
    assert.equal((await badge.innerText()).trim(), 'SYNTHETIC', panel);
    const box = await badge.boundingBox();
    assert.ok(box && box.width > 40 && box.height > 10, `${panel} badge must actually occupy the screen`);
  }
  // the whole-run badge and a plain-words notice
  assert.equal(await page.locator('[data-testid="provenance-overall"]').getAttribute('data-provenance'), 'synthetic');
  const notice = await page.locator('[data-testid="prov-notice-global"]').innerText();
  assert.match(notice, /Synthetic data/i);
  assert.match(notice, /Nothing on this panel is a measurement/i);
  // every panel also carries the spelled-out notice
  assert.equal(await page.locator('.panel [data-testid="prov-notice"]').count(), 3);
  await page.close();
});

test('browser: a real run shows no synthetic badge anywhere', async () => {
  const page = await openViewer('run=/__fixtures/real.jsonl');
  for (const panel of ['log', 'design', 'instruments', 'overall']) {
    const badge = page.locator(`[data-testid="provenance-${panel}"]`);
    assert.equal(await badge.getAttribute('data-provenance'), 'real', panel);
    assert.equal((await badge.innerText()).trim(), 'REAL', panel);
  }
  assert.equal(await page.locator('[data-provenance="synthetic"]').count(), 0);
  assert.equal(await page.locator('[data-testid="prov-notice"]').count(), 0);
  assert.equal(await page.locator('[data-testid="prov-notice-global"]').count(), 0);
  await page.close();
});

test('browser: a mixed run shows the weaker label, never the stronger', async () => {
  const page = await openViewer('run=/__fixtures/mixed.jsonl');
  for (const panel of ['log', 'design', 'instruments', 'overall']) {
    const badge = page.locator(`[data-testid="provenance-${panel}"]`);
    assert.equal(await badge.getAttribute('data-provenance'), 'synthetic', panel);
    assert.equal(await badge.getAttribute('data-mixed'), 'true', panel);
    const text = (await badge.innerText()).trim();
    assert.equal(text, 'SYNTHETIC (MIXED)', panel);
    assert.notEqual(text, 'REAL');
  }
  // no panel badge claims the run is real
  const labels = await page.locator('.panel-head .prov').evaluateAll(ns => ns.map(n => n.dataset.provenance));
  assert.deepEqual(labels, ['synthetic', 'synthetic', 'synthetic']);
  await page.close();

  const page2 = await openViewer('run=/__fixtures/mixed-recorded.jsonl');
  for (const panel of ['log', 'design', 'instruments']) {
    const badge = page2.locator(`[data-testid="provenance-${panel}"]`);
    assert.equal(await badge.getAttribute('data-provenance'), 'recorded', panel);
    assert.match((await badge.innerText()).trim(), /^RECORDED/);
  }
  await page2.close();
});

// ===========================================================================
// 4. Browser: NOT_CHECKED is never a pass and never counted
// ===========================================================================

test('browser: NOT_CHECKED is never rendered as a pass or counted in the score', async () => {
  const page = await openViewer();

  assert.equal((await page.locator('[data-testid="score-fraction"]').innerText()).trim(), '2 killed / 3 checkable');
  assert.match(await page.locator('[data-testid="checkable-fraction"]').innerText(), /60\.0% \(3 of 5 mutants\)/);
  assert.match(await page.locator('[data-testid="score-value"]').innerText(), /66\.7%/);
  assert.match(await page.locator('[data-testid="wilson-ci"]').innerText(), /20\.8% – 93\.9%/);
  assert.match(await page.locator('[data-testid="excluded-counts"]').innerText(), /not checked: 1 — never counted/);

  // the not_checked mutant is labelled as such and is not styled as a kill
  const m4 = page.locator('[data-testid="mutation-row"][data-mutant="M4"]');
  assert.equal(await m4.getAttribute('data-status'), 'not_checked');
  assert.equal((await m4.locator('[data-testid="mutation-status"]').innerText()).trim(), 'not checked');
  assert.equal(await m4.locator('.status-killed, .v-pass').count(), 0);

  // no NOT_CHECKED result is drawn as a measurement point
  assert.equal(await page.locator('[data-testid="measurement-point"][data-verdict="NOT_CHECKED"]').count(), 0);
  const gap = page.locator('[data-testid="measurement-gap"][data-subject="M4"]');
  assert.equal(await gap.getAttribute('data-verdict'), 'NOT_CHECKED');
  assert.match(await gap.innerText(), /NOT_CHECKED \(no_model\)/);

  // nothing anywhere styles a NOT_CHECKED verdict as a pass
  const bad = await page.locator('[data-verdict="NOT_CHECKED"]').evaluateAll(ns =>
    ns.filter(n => n.className.baseVal !== undefined ? false : /v-pass|status-killed/.test(n.className)).length);
  assert.equal(bad, 0);

  // the score strip at the bottom repeats the honest denominator
  assert.match(await page.locator('[data-testid="status-score"]').innerText(), /checkable 60\.0% · 5 mutants/);
  await page.close();
});

// ===========================================================================
// 5. Browser: cross-panel selection (S1.3)
// ===========================================================================

test('browser: clicking a surviving mutant highlights all three panels', async () => {
  const page = await openViewer();
  assert.equal(await page.locator('.selected').count(), 0, 'nothing is selected at rest');

  await page.locator('[data-testid="mutation-row"][data-mutant="M2"]').click();

  // 1. the log entry (or entries) that mention M2
  const logHits = page.locator('.panel[data-panel="log"] [data-testid="log-item"][data-selected="true"]');
  assert.ok(await logHits.count() > 0, 'log entries highlight');
  const mutantLine = page.locator('.panel[data-panel="log"] [data-testid="log-item"][data-selected="true"][data-type="mutation.result"]');
  assert.equal(await mutantLine.count(), 1, 'the mutant\'s own log line highlights');
  assert.match(await mutantLine.innerText(), /M2 survived/);

  // 2. the design element the mutant targets
  const elHits = page.locator('.panel[data-panel="design"] [data-testid="design-element"][data-selected="true"]');
  assert.equal(await elHits.count(), 1);
  assert.match(await elHits.innerText(), /C1/);

  // 3. its checks in the instruments panel
  const row = page.locator('[data-testid="mutation-row"][data-mutant="M2"]');
  assert.equal(await row.getAttribute('data-selected'), 'true');
  const checks = page.locator('[data-testid="check-row"][data-selected="true"]');
  assert.equal(await checks.count(), 3, 'T1, T2 and T3 ran on M2');
  assert.match(await page.locator('[data-testid="status-selection"]').innerText(), /selected: M2/);

  // selection also reaches the measurement strips
  assert.ok(await page.locator('[data-testid="measurement-point"][data-subject="M2"][data-selected="true"]').count() > 0);

  // clicking the same row again clears every highlight
  await page.locator('[data-testid="mutation-row"][data-mutant="M2"]').click();
  assert.equal(await page.locator('[data-selected="true"]').count(), 0);

  // selecting from the design panel works the same way, in reverse
  await page.locator('[data-testid="design-element"][data-element="C1"]').click();
  assert.ok(await page.locator('.panel[data-panel="log"] [data-selected="true"]').count() > 0);
  assert.equal(await page.locator('[data-testid="mutation-row"][data-mutant="M2"]').getAttribute('data-selected'), 'true');
  await page.close();
});

// ===========================================================================
// 6. Browser: the design panel is honest about what it does not have
// ===========================================================================

test('browser: the design panel says plainly that no 3D solver is connected', async () => {
  const page = await openViewer();
  const design = page.locator('.panel[data-panel="design"]');
  const text = await design.innerText();
  assert.match(text, /No 3D solver is connected/i);
  assert.match(text, /No thermal solver is connected/i);
  assert.match(text, /No FEA solver is connected/i);
  assert.ok(await design.locator('[data-testid="placeholder"]').count() >= 5);
  // nothing that could pass for a rendered field
  assert.equal(await design.locator('canvas, img').count(), 0);
  await page.close();
});

// ===========================================================================
// 7. The static export (S1.4)
// ===========================================================================

test('the export bundle contains no module syntax and no network references', () => {
  const bundle = buildBundle();
  assert.equal(/^\s*import\s/m.test(bundle), false, 'no import statements survive');
  assert.equal(/^\s*export\s/m.test(bundle), false, 'no export statements survive');
  const html = exportRunHTML(EVENTS, { generatedAt: '2026-11-21T00:00:00.000Z' });
  // The only absolute URL left is the SVG namespace, which is an identifier
  // and is never fetched.
  const urls = [...html.matchAll(/https?:\/\/[^\s"'()]*/g)].map(m => m[0]);
  assert.deepEqual([...new Set(urls)], ['http://www.w3.org/2000/svg']);
  assert.equal(/<link\b/i.test(html), false, 'no stylesheet links');
  assert.equal(/\bsrc=/i.test(html), false, 'no external script or image sources');
});

test('browser: the static export opens from file:// with the network blocked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinux-export-'));
  const out = join(dir, 'run.html');
  writeFileSync(out, exportRunHTML(EVENTS, { generatedAt: '2026-11-21T00:00:00.000Z' }));

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, offline: true });
  const offOrigin = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('file:')) return route.continue();
    offOrigin.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(out).href);
  await page.waitForSelector('[data-testid="provenance-instruments"]');

  assert.deepEqual(errors, [], 'no page errors offline');
  assert.deepEqual(offOrigin, [], 'the page requested nothing but its own file');

  // the whole viewer is there, with its badges and its score
  for (const panel of ['log', 'design', 'instruments']) {
    assert.equal(await page.locator(`[data-testid="provenance-${panel}"]`).getAttribute('data-provenance'), 'synthetic');
  }
  assert.equal(await page.locator('[data-testid="log-item"]').count(), 29);
  assert.equal(await page.locator('[data-testid="mutation-row"]').count(), 5);
  assert.equal((await page.locator('[data-testid="score-fraction"]').innerText()).trim(), '2 killed / 3 checkable');
  assert.match(await page.locator('[data-testid="export-note"]').innerText(), /provenance synthetic/);

  // and it is still interactive offline
  await page.locator('[data-testid="mutation-row"][data-mutant="M2"]').click();
  assert.ok(await page.locator('.panel[data-panel="design"] [data-selected="true"]').count() > 0);

  await context.close();
});
