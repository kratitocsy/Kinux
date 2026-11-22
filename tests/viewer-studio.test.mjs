// The studio layout, end to end with the real tools: our divider schematic
// with a small board written beside it, `kinux verify --heat` (ngspice for
// power, CalculiX for the field, kicad-cli for the views), served the way an
// MCP client opens it, in a real Chromium. Checks that the terminal speaks one
// line per fault and one per verdict, that the 3D stage carries the solved
// field and callouts whose numbers are the field's, and that switching to
// faults shows the parts whose faults survived.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLaunchChromium } from './helpers/browser.mjs';
import { startViewerServer } from '../mcp/viewer-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'engine', 'fixtures');
let browser = null, skipReason = null, srv = null, dir = null, out = null;

const fp = (ref, x, y, rot = 0) => `  (footprint "R_0805" (layer "F.Cu") (at ${x} ${y} ${rot})
    (property "Reference" "${ref}" (at 0 -1.6 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0 ${rot}) (size 1 1.3) (layers "F.Cu" "F.Mask"))
    (pad "2" smd rect (at 1 0 ${rot}) (size 1 1.3) (layers "F.Cu" "F.Mask")))`;
const PCB = `(kicad_pcb (version 20240108) (generator "kinux-test")
  (general (thickness 1.6))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (36 "B.SilkS" user) (37 "F.SilkS" user) (38 "B.Mask" user) (39 "F.Mask" user) (44 "Edge.Cuts" user))
  (gr_rect (start 100 100) (end 140 130) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts"))
${fp('R1', 108, 108)}
${fp('R2', 120, 108, 90)}
${fp('R3', 132, 108)}
${fp('R4', 108, 122)}
${fp('R5', 120, 122)}
${fp('C1', 132, 122)}
)
`;
const src = s => ({ value: s, source: 'assumed: test value' });
const HEAT = { block: 1, ambient_c: src(25), h_top_w_m2k: src(10), h_bottom_w_m2k: src(5), laminate_k_w_mk: src(0.3),
  copper_k_w_mk: { value: 385, source: 'handbook: copper' }, copper_thickness_um: src(35), copper_coverage: src(0.3) };

before(async () => {
  ({ browser, skipReason } = await tryLaunchChromium());
  if (!browser) return;
  dir = mkdtempSync(join(tmpdir(), 'kinux-studio-'));
  copyFileSync(join(FIX, 'divider.kicad_sch'), join(dir, 'divider.kicad_sch'));
  writeFileSync(join(dir, 'divider.kicad_pcb'), PCB);
  writeFileSync(join(dir, 'heat.json'), JSON.stringify(HEAT));
  out = join(dir, 'out');
  const r = spawnSync(process.execPath, [join(ROOT, 'engine/cli.mjs'), 'verify', join(dir, 'divider.kicad_sch'),
    '--sidecar', join(FIX, 'divider.sidecar.json'), '--checks', join(FIX, 'divider.checks.md'),
    '--heat', join(dir, 'heat.json'), '--out', out, '--threshold', '0', '--no-queue', '--quiet'], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(r.status, 0, r.stderr);
  mkdirSync(join(dir, 'runs'));
  cpSync(out, join(dir, 'runs', 'r0123abcd'), { recursive: true });
  srv = await startViewerServer({ runsDir: join(dir, 'runs'), viewerRoot: join(ROOT, 'viewer'), activity: () => [] });
});

after(async () => {
  if (browser) await browser.close();
  if (srv) await srv.close();
});

test('browser: the studio shows the conversation, the solved field with its callouts, and the faults', async t => {
  if (!browser) { t.skip(skipReason); return; }
  const field = JSON.parse(readFileSync(join(out, 'heat', 'heat-field.json'), 'utf8'));
  const events = readFileSync(join(out, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const mutants = events.filter(e => e.type === 'mutation.result');
  assert.equal(field.drawn, true, field.reason);

  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = srv.viewerUrl('r0123abcd');
  assert.match(url, /layout=studio/, 'the MCP link opens the studio');
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('[data-testid=studio-3d]')?.dataset.field === 'drawn', null, { timeout: 60_000 });

  // Terminal: run start, heat, a fault line and a verdict line per mutant, the score.
  const who = await page.$$eval('[data-testid=terminal-msg]', m => m.map(x => x.dataset.who));
  assert.equal(who.filter(w => w === 'inspector').length, mutants.length);
  assert.equal(who.filter(w => w === 'solver').length, mutants.length + 1, 'one verdict per fault, plus the heat solve');
  const names = await page.$$eval('[data-testid=terminal-msg] .kv-name', s => [...new Set(s.map(x => x.firstChild.textContent))]);
  assert.ok(names.includes('Fault Inspector') && names.includes('Solver'), names.join(', '));
  const survived = mutants.filter(e => e.data.status === 'survived').length;
  const tags = await page.$$eval('.kv-tag', t => t.map(x => x.textContent));
  assert.equal(tags.filter(x => x === 'MISSED').length, survived, 'every MISSED is a survivor in the events');
  assert.equal(tags.filter(x => x === 'CAUGHT').length, mutants.filter(e => e.data.status === 'killed').length);
  assert.ok(await page.locator('[data-testid=studio-trace]').count() > 0, 'checks are drawn as traces');

  // Stage: callouts name the hottest parts with the field's own numbers.
  const callouts = await page.$$eval('[data-testid=studio-callout]', c => c.map(x => ({ ref: x.dataset.ref, text: x.textContent })));
  const hottest = Object.entries(field.parts).sort((a, b) => b[1].peak_c - a[1].peak_c)[0];
  assert.equal(callouts[0].ref, hottest[0]);
  assert.ok(callouts[0].text.includes(hottest[1].peak_c.toFixed(1)), callouts[0].text);
  assert.ok((await page.textContent('[data-testid=studio-telemetry]')).includes(`${field.peak_c.toFixed(1)}°C`));

  // Faults mode: callouts are the parts with surviving faults, and no field is shown.
  await page.click('[data-testid=studio-mode-faults]');
  const missed = new Set(mutants.filter(e => e.data.status === 'survived').map(e => e.data.target));
  const faultRefs = await page.$$eval('[data-testid=studio-callout]', c => c.map(x => x.dataset.ref));
  assert.ok(faultRefs.length > 0 && faultRefs.every(r => missed.has(r)), faultRefs.join(','));
  assert.equal(await page.locator('[data-testid=hf-colour-bar]').count(), 0);

  // Replay: reset shows no faults; one step shows the first fault and its verdict, and its part is called out.
  await page.click('[data-testid=studio-reset]');
  assert.equal((await page.textContent('[data-testid=studio-step]')).trim(), `Fault 0 / ${mutants.length}`);
  assert.equal(await page.locator('[data-who=inspector]').count(), 0);
  await page.click('[data-testid=studio-next]');
  assert.equal(await page.locator('[data-who=inspector]').count(), 1);
  const first = mutants[0].data;
  assert.equal(await page.getAttribute('[data-who=inspector]', 'data-ref'), first.target);
  await page.waitForFunction(r => [...document.querySelectorAll('[data-testid=studio-callout]')].some(c => c.dataset.ref === r), first.target);
  assert.equal((await page.textContent('[data-testid=studio-phase]')).trim(), first.status === 'killed' ? 'Fault caught' : first.status === 'survived' ? 'Fault missed' : 'Not checked');
  await page.click('[data-testid=studio-all]');

  // PCB tab: the field lies under KiCad's drawing.
  await page.click('[data-testid=studio-mode-heat]');
  await page.click('[data-testid=studio-tab-pcb]');
  await page.waitForSelector('[data-testid=bv-heat-underlay]');
  assert.deepEqual(errors, []);
  await page.close();
});
