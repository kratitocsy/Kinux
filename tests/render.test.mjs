// Blender renders of a run's 3D board (engine/render.mjs). Optional tool:
// npm test skips this suite with a reason when Blender is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderRun, tintsFromReport, STATUS_RGB } from '../engine/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('each part is tinted by its worst mutant; equivalent mutants colour nothing', () => {
  const { tints, legend } = tintsFromReport({ mutants: [
    { target: 'R1', status: 'killed' }, { target: 'R1', status: 'survived' },
    { target: 'C1', status: 'killed' }, { target: 'C2', status: 'equivalent' },
  ] });
  assert.deepEqual(legend, { R1: 'survived', C1: 'killed' });
  assert.deepEqual(tints.R1, STATUS_RGB.survived);
  assert.equal(tints.C2, undefined);
});

test('a real Blender render of a real KiCad board, with a sidecar that traces it to the run', async () => {
  const run = mkdtempSync(join(tmpdir(), 'kinux-render-run-'));
  mkdirSync(join(run, 'views'));
  execFileSync('kicad-cli', ['pcb', 'export', 'glb', '--output', join(run, 'views', 'board.glb'),
    join(ROOT, 'workers', 'pcb', 'fixtures', 'two-trace.kicad_pcb')], { stdio: 'ignore', env: { ...process.env, HOME: run } });
  writeFileSync(join(run, 'report.json'), JSON.stringify({ run_id: 'r-render', design_hash: 'sha256:x', score_text: 'n/a', mutants: [] }));
  const s = await renderRun(run, { samples: 2, width: 160, height: 100 });
  const png = readFileSync(s.image);
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 160, 'width as asked');
  assert.equal(png.readUInt32BE(20), 100, 'height as asked');
  const side = JSON.parse(readFileSync(s.image.replace(/\.png$/, '.json'), 'utf8'));
  assert.equal(side.run_id, 'r-render');
  assert.match(side.geometry, /kicad-cli/);
  assert.match(side.renderer, /Blender/);
});

test('a run without a 3D board is refused with a reason, and nothing is drawn in its place', async () => {
  const run = mkdtempSync(join(tmpdir(), 'kinux-render-empty-'));
  await assert.rejects(renderRun(run), /no 3D board/);
});
