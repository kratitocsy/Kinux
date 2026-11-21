// The thermal section of the design panel.
//
// The fixture below is hand-built and labelled SYNTHETIC on every event: no
// thermal solver produced it. It exists to pin the convention the panel reads
// (layer "thermal", T(part)/P(part) titles, measured/limit/units, the model in
// `reason`) and to exercise the honesty rules. Every event passes the contract
// validator, so the panel is tested against shapes the contract accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryLaunchChromium } from './helpers/browser.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../viewer/reducer.mjs';
import { thermalView, parseThermalTitle, thermalMargin } from '../viewer/thermal.mjs';
import { buildBundle } from '../viewer/export.mjs';
import { validateEvent } from '../contracts/check-run.mjs';
import { serveRun } from '../engine/live.mjs';
import { createRunServer } from '../server/run/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HASH = 'sha256:' + 'b'.repeat(64);
const MODEL = 'lumped steady-state, one-way electrical→thermal coupling';

function fixture(provenance = 'synthetic') {
  let seq = 0;
  const e = (type, data, kind = 'solver') => ({
    v: 1, run_id: 'r-thermal', seq: seq++, ts: new Date(Date.UTC(2026, 10, 21, 3, 0, seq)).toISOString(),
    type, actor: { kind, id: kind === 'solver' ? 'thermal-worker' : 'kinux' },
    design_hash: HASH, provenance, data,
  });
  const q = (id, title) => e('test.queued', { test_id: id, title, layer: 'thermal', solver: 'lumped-thermal' }, 'system');
  const r = (id, subject, verdict, extra = {}) => e('test.result', { test_id: id, subject, verdict, ...extra });

  return [
    e('run.started', { project: 'phase-leg', domain: 'electronics', tool_versions: { 'lumped-thermal': '0' }, source: provenance }, 'system'),
    q('th:1', 'T(RSH) < 125'),
    q('th:2', 'P(RSH) < 2'),
    q('th:3', 'T(RG) < 125'),
    q('th:4', 'T(Q2) < 150'),
    q('th:5', 'board stays cool'),
    r('th:1', 'baseline', 'PASS', { measured: 41.2, limit: 125, units: '°C', reason: MODEL }),
    r('th:2', 'baseline', 'PASS', { measured: 0.8, limit: 2, units: 'W', reason: MODEL }),
    r('th:3', 'baseline', 'PASS', { measured: 25.3, limit: 125, units: '°C', reason: MODEL }),
    // A NOT_CHECKED that nonetheless carries a number: the panel must not show it.
    r('th:4', 'baseline', 'NOT_CHECKED', { measured: 999, units: '°C', reason_code: 'no_material_data', reason: 'no thermal resistance given for Q2' }),
    r('th:5', 'baseline', 'PASS', { measured: 30, limit: 60, units: '°C', reason: MODEL }),
    r('th:1', 'M4', 'FAIL', { measured: 211.0, limit: 125, units: '°C', reason: MODEL }),
    r('th:2', 'M4', 'FAIL', { measured: 8.0, limit: 2, units: 'W', reason: MODEL }),
    r('th:3', 'M4', 'PASS', { measured: 25.3, limit: 125, units: '°C', reason: MODEL }),
    r('th:4', 'M4', 'NOT_CHECKED', { reason_code: 'no_material_data', reason: 'no thermal resistance given for Q2' }),
    e('mutation.result', {
      mutant_id: 'M4', target: 'RSH', description: 'shunt 2 mOhm -> 20 mOhm', layer: 'netlist',
      origin: 'fixed', status: 'killed', killed_by: ['th:1', 'th:2'],
    }, 'villain'),
  ];
}

const stateOf = events => createStore().pushAll(events);

// ---- the fixture is a fair test ---------------------------------------------

test('every fixture event is a valid contract event', () => {
  for (const ev of fixture()) assert.equal(validateEvent(ev).ok, true, `seq ${ev.seq}: ${validateEvent(ev).errors}`);
});

// ---- the pure view -------------------------------------------------------------

test('titles parse into quantity, part and bounds; anything else is refused', () => {
  assert.deepEqual(parseThermalTitle('T(RSH) < 125'), { quantity: 'T', component: 'RSH', op: '<', lo: null, hi: 125 });
  assert.deepEqual(parseThermalTitle('P(Q2) > 0.1'), { quantity: 'P', component: 'Q2', op: '>', lo: 0.1, hi: null });
  assert.deepEqual(parseThermalTitle('T(U1) between 20 and 85'), { quantity: 'T', component: 'U1', op: 'between', lo: 20, hi: 85 });
  for (const bad of ['V(out) < 3', 'board stays cool', 'T(RSH)', 'T(RSH) between 20', '', null]) {
    assert.equal(parseThermalTitle(bad), null, `${bad} is not a thermal title`);
  }
});

test('margin is headroom in the check\'s own units', () => {
  assert.equal(thermalMargin(parseThermalTitle('T(R) < 125'), 41.2), 125 - 41.2);
  assert.equal(thermalMargin(parseThermalTitle('T(R) > 10'), 41.2), 41.2 - 10);
  assert.equal(thermalMargin(parseThermalTitle('T(R) between 20 and 85'), 30), 10);
  assert.ok(thermalMargin(parseThermalTitle('T(R) < 125'), 211) < 0, 'over the limit is negative headroom');
  assert.equal(thermalMargin(parseThermalTitle('T(R) < 125'), null), null);
});

test('a run with no thermal checks has no thermal view, so the placeholder stays', () => {
  const noThermal = fixture().filter(e => !(e.type === 'test.queued' || e.type === 'test.result'));
  assert.equal(thermalView(stateOf(noThermal)), null);
});

test('results group by part, temperature first, with the model carried', () => {
  const v = thermalView(stateOf(fixture()));
  assert.deepEqual(v.components.map(c => c.component), ['RSH', 'RG', 'Q2']);
  const rsh = v.components[0];
  assert.deepEqual(rsh.rows.map(r => r.quantity), ['T', 'P']);
  assert.equal(rsh.rows[0].baseline.measured, 41.2);
  assert.equal(rsh.rows[0].baseline.margin, 125 - 41.2);
  assert.deepEqual(v.models, [MODEL]);
  assert.equal(v.unstatedModel, 0);
  assert.equal(v.provenance, 'synthetic');
});

test('a NOT_CHECKED result never shows a number, even one it was sent', () => {
  const q2 = thermalView(stateOf(fixture())).components.find(c => c.component === 'Q2');
  const b = q2.rows[0].baseline;
  assert.equal(b.verdict, 'NOT_CHECKED');
  assert.equal(b.measured, null, 'the 999 in the event must not reach the screen');
  assert.equal(b.margin, null);
  assert.equal(b.reason_code, 'no_material_data');
});

test('a check whose title names no part is listed, not dropped', () => {
  const v = thermalView(stateOf(fixture()));
  assert.equal(v.unparsed.length, 1);
  assert.equal(v.unparsed[0].title, 'board stays cool');
});

test('selecting a mutant adds its values and the change from baseline', () => {
  const v = thermalView(stateOf(fixture()), new Set(['M4', 'RSH']));
  assert.equal(v.selectedMutant, 'M4');
  const [t, p] = v.components[0].rows;
  assert.equal(t.selected.verdict, 'FAIL');
  assert.equal(t.selected.measured, 211.0);
  assert.ok(Math.abs(t.delta - (211.0 - 41.2)) < 1e-9);
  assert.equal(p.selected.measured, 8.0);
});

test('one synthetic thermal result in a real run makes the whole section synthetic', () => {
  const events = fixture('real');
  events[7] = { ...events[7], provenance: 'synthetic' }; // the P(RSH) baseline
  assert.equal(thermalView(stateOf(events)).provenance, 'synthetic');
});

test('a PASS or FAIL that does not state its model is counted, not hidden', () => {
  const events = fixture().map(e => (e.type === 'test.result' && e.data.test_id === 'th:3' && e.data.subject === 'baseline')
    ? { ...e, data: { ...e.data, reason: undefined } } : e);
  for (const e of events) if (e.data && e.data.reason === undefined) delete e.data.reason;
  assert.equal(thermalView(stateOf(events)).unstatedModel, 1);
});

test('the offline export bundle includes the thermal module', () => {
  const bundle = buildBundle();
  assert.match(bundle, /function thermalView\(/);
  assert.doesNotMatch(bundle, /^import /m);
});

// ---- in a real browser ------------------------------------------------------

test('browser: the thermal section renders per part, selection shows the mutant, the field stays unwired', { timeout: 120_000 }, async t => {
  const { browser, skipReason } = await tryLaunchChromium();
  if (!browser) return t.skip(skipReason);
  t.after(() => browser.close());
  const dir = await mkdtemp(join(tmpdir(), 'kinux-thermal-'));
  const live = await serveRun({
    createRunServer, validate: validateEvent, runId: 'r-thermal', root: dir, viewerRoot: join(ROOT, 'viewer'),
  });
  t.after(async () => { await live.close(); await rm(dir, { recursive: true, force: true }); });
  for (const ev of fixture()) live.bridge.sink(ev);
  assert.equal(live.bridge.ok, true, live.bridge.summary());

  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(live.viewerUrl);

  const cards = page.locator('[data-testid="thermal-card"]');
  await cards.first().waitFor({ timeout: 30_000 });
  assert.deepEqual(await cards.evaluateAll(ns => ns.map(n => n.dataset.component)), ['RSH', 'RG', 'Q2']);

  const rsh = page.locator('[data-testid="thermal-card"][data-component="RSH"]');
  assert.match(await rsh.innerText(), /41\.2 °C/);
  assert.match(await rsh.innerText(), /0\.80 W/);

  // NOT_CHECKED shows its reason and no number.
  const q2 = await page.locator('[data-testid="thermal-card"][data-component="Q2"]').innerText();
  assert.match(q2, /not checked — no thermal resistance given for Q2/);
  assert.doesNotMatch(q2, /999/);

  // The model is named, and the provenance of the numbers is not hidden.
  assert.match(await page.locator('[data-testid="thermal-model"]').innerText(), /lumped steady-state/);
  assert.equal(await page.locator('[data-testid="thermal-provenance"]').getAttribute('data-provenance'), 'synthetic');
  assert.equal(await page.locator('[data-testid="thermal-prov-notice"]').count(), 1);

  // The spatial field is still declared NOT WIRED, under its narrower name.
  const placeholders = await page.locator('[data-testid="placeholder"] h4').allInnerTexts();
  assert.ok(placeholders.includes('Thermal field (spatial)'), placeholders.join(' | '));
  assert.ok(!placeholders.includes('Thermal field'), 'the old "no thermal solver" text is gone once there is thermal data');

  // Selecting the mutant in the instruments panel shows baseline -> mutant here.
  await page.locator('[data-testid="mutation-row"][data-mutant="M4"]').click();
  const sel = page.locator('[data-testid="thermal-card"][data-component="RSH"] [data-testid="thermal-selected"]');
  await sel.first().waitFor({ timeout: 10_000 });
  assert.match(await sel.first().innerText(), /211\.0 °C/);
  assert.equal(await sel.first().locator('[data-verdict]').getAttribute('data-verdict'), 'FAIL');
  assert.equal(await rsh.getAttribute('data-selected'), 'true', 'the mutant\'s target part is highlighted');

  // And clicking a card selects that part across the panels.
  await page.locator('[data-testid="thermal-card"][data-component="RG"]').click();
  assert.equal(await page.locator('[data-testid="thermal-card"][data-component="RG"]').getAttribute('data-selected'), 'true');

  assert.deepEqual(errors, []);
  await page.screenshot({ path: process.env.KINUX_SCREENSHOT ?? join(tmpdir(), `kinux-thermal-${process.pid}.png`), fullPage: false });
});

test('the run log never prints a number beside NOT_CHECKED, even one the event carried', () => {
  const state = stateOf(fixture());
  const lines = (state.log ?? []).map(l => l.text ?? '');
  const notChecked = lines.filter(t => t.startsWith('NOT_CHECKED'));
  assert.ok(notChecked.length >= 1, 'the fixture has NOT_CHECKED results in the log');
  for (const t of notChecked) assert.doesNotMatch(t, /999/, t);
  // A result that ran still shows its reading.
  assert.ok(lines.some(t => /^PASS — th:1 on baseline 41\.2 °C/.test(t)), lines.join('\n'));
});
