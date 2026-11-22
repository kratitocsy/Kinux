// Temperature colouring on the board views (viewer/panels/board.mjs), from a
// real run: the phase-leg example's thermal checks through the real engine,
// ngspice currents into the lumped thermal worker. One number per part.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore, parseJSONL } from '../viewer/reducer.mjs';
import { partTemperatures, heatColour } from '../viewer/panels/board.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EX = join(ROOT, 'examples', 'phase-leg-support');

test('temperatures come from the run\'s thermal checks, the baseline\'s or a selected mutant\'s, never anything else', () => {
  const out = mkdtempSync(join(tmpdir(), 'kinux-heat-'));
  execFileSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', join(EX, 'phase-leg-support.cir'), '--checks', join(EX, 'checks-thermal.md'),
    '--thermal-model', join(EX, 'thermal-model.json'), '--out', out, '--threshold', '0', '--quiet', '--limit', '12'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const store = createStore();
  store.pushAll(parseJSONL(readFileSync(join(out, 'events.jsonl'), 'utf8')));
  const t = partTemperatures(store.state);
  assert.ok(t && t.temps.size >= 1, 'the run has per-part temperatures');
  assert.equal(t.subject, 'baseline');
  for (const v of t.temps.values()) assert.ok(Number.isFinite(v) && v > -50 && v < 1000, `a plausible temperature: ${v}`);
  // The numbers are the thermal checks' own measurements, nothing derived.
  const measured = new Set();
  for (const id of store.state.testOrder) { const r = store.state.tests[id].results?.baseline; if (store.state.tests[id].layer === 'thermal' && r?.measured !== undefined) measured.add(r.measured); }
  for (const v of t.temps.values()) assert.ok(measured.has(v), `${v} is a baseline thermal measurement`);
  assert.equal(partTemperatures(createStore().state), null, 'a run with no thermal checks offers no temperature colouring');
});

test('the colour scale runs blue at the coolest part to red at the hottest', () => {
  assert.deepEqual(heatColour(10, 10, 90).css, 'rgb(60,110,230)');
  assert.deepEqual(heatColour(90, 10, 90).css, 'rgb(255,50,40)');
});
