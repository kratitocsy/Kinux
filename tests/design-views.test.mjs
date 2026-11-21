// The views of a KiCad design (engine/design-views.mjs): schematic and PCB
// SVGs and a 3D GLB from the real kicad-cli, normalised to be byte-
// reproducible, and a parts file that places every reference in each view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportDesignViews, normaliseSvg, normaliseGlb, schematicParts, boardParts } from '../engine/design-views.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCH = join(ROOT, 'engine', 'fixtures', 'divider.kicad_sch');

test('the export timestamp is the only thing normalised in an SVG', () => {
  const a = '<svg><title>SVG Image created as x.svg date 2026-11-21T17:47:06 </title><path d="M 2026-11-21"/></svg>';
  const n = normaliseSvg(a);
  assert.equal(n, '<svg><title>SVG Image created as x.svg date 0000-00-00T00:00:00 </title><path d="M 2026-11-21"/></svg>');
});

test('a GLB keeps its length and every byte but the timestamp', () => {
  const json = Buffer.from('{"asset":{"extras":{"generated_at":"2026-11-21T17:47:07"}}}  ', 'latin1');
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + json.length, 8);
  head.writeUInt32LE(json.length, 12); head.write('JSON', 16, 'latin1');
  const glb = Buffer.concat([head, json]);
  const out = normaliseGlb(glb);
  assert.equal(out.length, glb.length);
  assert.match(out.toString('latin1'), /"generated_at":"0000-00-00T00:00:00"/);
  let diff = 0; for (let i = 0; i < glb.length; i++) if (out[i] !== glb[i]) diff++;
  assert.ok(diff > 0 && diff <= 19);
});

test('schematic parts come from placed symbols, never from library definitions', () => {
  const parts = schematicParts(readFileSync(SCH, 'utf8'));
  assert.ok(parts.length >= 3, `found ${parts.map(p => p.ref)}`);
  assert.ok(parts.every(p => /^[A-Z]+\d+$/.test(p.ref)), 'no library definition (R, C, D) or power symbol (#) slipped in');
  assert.ok(parts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test('footprint positions and sides are read from a board, in either reference syntax', () => {
  const pcb = `(kicad_pcb (version 20240108)
 (footprint "R_0603" (layer "F.Cu") (at 145.1 149.9 180) (property "Reference" "R6" (at 0 0 0)))
 (footprint "C_0603" (layer "B.Cu") (at 120 110) (fp_text reference "C2" (at 0 0)))
 (footprint "Hole" (layer "F.Cu")))`;
  assert.deepEqual(boardParts(pcb), [
    { ref: 'R6', x: 145.1, y: 149.9, rot: 180, side: 'top' },
    { ref: 'C2', x: 120, y: 110, rot: 0, side: 'bottom' },
  ]);
});

test('the real kicad-cli exports the schematic, and two exports are byte-identical', async () => {
  const a = await exportDesignViews({ schematic: SCH, outDir: mkdtempSync(join(tmpdir(), 'kinux-dv-')) });
  const b = await exportDesignViews({ schematic: SCH, outDir: mkdtempSync(join(tmpdir(), 'kinux-dv-')) });
  const kinds = a.artifacts.map(x => x.kind);
  assert.ok(kinds.includes('schematic_svg'), JSON.stringify(a.notes));
  assert.ok(kinds.includes('other'), 'the parts file');
  assert.ok(a.notes.some(n => /no \.kicad_pcb/.test(n)), 'a schematic without a board says so; nothing is drawn in its place');
  assert.ok(!kinds.includes('pcb_svg') && !kinds.includes('mesh_glb'));
  for (const x of a.artifacts) {
    assert.match(x.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(x.sha256, b.artifacts.find(y => y.artifact_id === x.artifact_id).sha256, `${x.artifact_id} is reproducible`);
  }
});
