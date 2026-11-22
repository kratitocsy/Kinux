// Board views in the viewer, end to end: `kinux verify --serve` on our own
// KiCad fixture (engine/fixtures/divider.kicad_sch, no board file), a real
// Chromium on the served viewer. The schematic is KiCad's own SVG; every
// placed part gets one marker; clicking a marker selects that part; a design
// without a .kicad_pcb offers no PCB or 3D tab rather than an empty one.
// Skips with a reason when Playwright is missing (tests/helpers/browser.mjs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tryLaunchChromium } from './helpers/browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'engine', 'fixtures');
let browser = null, skipReason = null, server = null, url = null, out = null;

before(async () => {
  ({ browser, skipReason } = await tryLaunchChromium());
  if (!browser) return;
  out = mkdtempSync(join(tmpdir(), 'kinux-board-'));
  server = spawn(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', join(FIX, 'divider.kicad_sch'),
    '--sidecar', join(FIX, 'divider.sidecar.json'), '--checks', join(FIX, 'divider.checks.md'),
    '--out', out, '--threshold', '0', '--serve', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no viewer URL:\n${log}`)), 120_000);
    server.stdout.on('data', d => {
      log += d;
      const m = /WATCH IT:\s+(\S+)/.exec(log);
      if (m && /still serving/.test(log)) { clearTimeout(t); res(m[1]); }
    });
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill();
});

test('browser: the schematic is KiCad\'s, every placed part is marked, and a marker selects its part', async t => {
  if (!browser) { t.skip(skipReason); return; }
  const parts = JSON.parse(readFileSync(join(out, 'views', 'parts.json'), 'utf8'));
  assert.ok(parts.schematic.length >= 3);
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('[data-testid=bv-schematic]')?.dataset.ready === 'true', null, { timeout: 60_000 });

  const tabs = await page.$$eval('.bv-tab', b => b.map(x => x.dataset.tab));
  assert.deepEqual(tabs, ['schematic'], 'no board file: no PCB or 3D tab is offered');
  const vb = await page.getAttribute('[data-testid=bv-schematic] .bv-overlay', 'viewBox');
  assert.match(vb, /^0(\.0+)? 0(\.0+)? \d/, 'markers share the drawing\'s own millimetre frame');
  const refs = await page.$$eval('[data-testid=bv-schematic] [data-testid=bv-marker]', m => m.map(x => x.dataset.ref).sort());
  assert.deepEqual(refs, parts.schematic.map(p => p.ref).sort());

  const ref = refs[0];
  await page.locator(`[data-testid=bv-schematic] [data-ref="${ref}"]`).dispatchEvent('click');
  assert.equal((await page.textContent('[data-testid=status-selection]')).trim(), `selected: ${ref}`);
  await page.waitForFunction(r => document.querySelector(`[data-testid=bv-schematic] [data-ref="${r}"]`)?.dataset.selected === 'true', ref);
  assert.deepEqual(errors, []);
  await page.close();
});
