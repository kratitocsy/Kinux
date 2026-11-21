// The views of a KiCad design a person looks at: schematic, PCB, 3D board,
// and where every part sits in each of them.
//
// Everything here is produced by KiCad itself (kicad-cli 8 or later) or read
// from the design files; nothing is drawn by us. The files are normalised so
// the same design always gives the same bytes (CONTRIBUTING rule 9): KiCad
// stamps the export time into each SVG's <title> and into the GLB's
// `generated_at`; those are replaced, and nothing else is touched. Measured on
// kicad-cli 10.0.8: two exports a few seconds apart differ in exactly those
// places.
//
// The parts file maps every reference to its position in each view, so a
// viewer can highlight a part everywhere at once:
//   schematic: page millimetres, the SVG's own viewBox units
//   pcb:       page millimetres, the PCB SVG's viewBox units
//   board3d:   metres in the GLB frame (x = pcb x / 1000, z = pcb y / 1000,
//              y up from the bottom of the board)
//
// Hostile input: kicad-cli runs with execFile and an argument array, a fresh
// HOME seeded with KiCad's template library tables (workers/pcb), a timeout,
// and output written only inside the given directory.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseSexp, children, child, numAt, propertyValue, atomAt } from '../workers/kicad/sexp.mjs';
import { capabilities, seedLibraryTables } from '../workers/pcb/kicad-cli.mjs';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;
export const PCB_LAYERS = ['F.Cu', 'B.Cu', 'F.Silkscreen', 'B.Silkscreen', 'Edge.Cuts'];

const sha256 = buf => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

/** Replace KiCad's export timestamp in an SVG's <title>. */
export function normaliseSvg(text) {
  return text.replace(/(<title>SVG Image created as [^<]*? date )\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/, '$10000-00-00T00:00:00');
}

/** Replace `generated_at` in a GLB's JSON chunk with zeros of the same length, so no offset moves. */
export function normaliseGlb(buf) {
  const out = Buffer.from(buf);
  if (out.length < 20 || out.toString('latin1', 0, 4) !== 'glTF') return out;
  const jsonLen = out.readUInt32LE(12);
  const json = out.toString('latin1', 20, 20 + jsonLen);
  const m = /"generated_at":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)"/.exec(json);
  if (m) out.write('0000-00-00T00:00:00', 20 + m.index + '"generated_at":"'.length, 'latin1');
  return out;
}

/** Symbol positions in a schematic (page mm). Library definitions are skipped. */
export function schematicParts(text) {
  const root = parseSexp(text)[0] ?? [];
  const out = [];
  for (const s of children(root, 'symbol')) {
    if (!child(s, 'lib_id')) continue;
    const ref = propertyValue(s, 'Reference');
    const at = child(s, 'at');
    if (!ref || !at || ref.startsWith('#')) continue;
    out.push({ ref, x: numAt(at, 1), y: numAt(at, 2), rot: numAt(at, 3, 0) });
  }
  return out;
}

/** Footprint positions on a board (page mm), and the board outline's extent. */
export function boardParts(text) {
  const root = parseSexp(text)[0] ?? [];
  const parts = [];
  for (const f of children(root, 'footprint')) {
    const at = child(f, 'at');
    let ref = propertyValue(f, 'Reference');
    if (!ref) for (const t of children(f, 'fp_text')) if (atomAt(t, 1) === 'reference') ref = atomAt(t, 2);
    if (!ref || !at) continue;
    parts.push({ ref, x: numAt(at, 1), y: numAt(at, 2), rot: numAt(at, 3, 0), side: atomAt(child(f, 'layer'), 1) === 'B.Cu' ? 'bottom' : 'top' });
  }
  return parts;
}

async function kicad(args, { bin, home }) {
  const env = { ...process.env, HOME: home, DISPLAY: '' };
  return execFileAsync(bin, args, { env, timeout: TIMEOUT_MS, maxBuffer: 16 << 20 });
}

/**
 * Export the views of a KiCad project into `outDir`.
 * @returns {Promise<{artifacts: Array<{artifact_id, kind, file, mime}>, notes: string[]}>}
 */
export async function exportDesignViews({ schematic, outDir, bin = 'kicad-cli' }) {
  const caps = await capabilities({ bin });
  const notes = [];
  if (!caps.available) return { artifacts: [], notes: ['kicad-cli is not installed: no schematic, PCB or 3D view'] };
  mkdirSync(outDir, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), 'kinux-views-home-'));
  seedLibraryTables(home, caps.major);
  const artifacts = [];
  const sch = resolve(schematic);
  const pcb = sch.replace(/\.kicad_sch$/i, '.kicad_pcb');

  // Schematic: kicad-cli writes one SVG per sheet into a directory.
  const schDir = mkdtempSync(join(tmpdir(), 'kinux-sch-svg-'));
  try {
    await kicad(['sch', 'export', 'svg', '--output', schDir, sch], { bin, home });
    const svgs = readdirSync(schDir).filter(f => f.endsWith('.svg')).sort();
    const main = svgs.find(f => f === basename(sch).replace(/\.kicad_sch$/i, '.svg')) ?? svgs[0];
    if (main) {
      writeFileSync(join(outDir, 'schematic.svg'), normaliseSvg(readFileSync(join(schDir, main), 'utf8')));
      artifacts.push({ artifact_id: 'schematic', kind: 'schematic_svg', file: 'schematic.svg', mime: 'image/svg+xml' });
      if (svgs.length > 1) notes.push(`schematic has ${svgs.length} sheets; only the root sheet is shown`);
    }
  } catch (e) { notes.push(`schematic SVG export failed: ${String(e.message).split('\n')[0]}`); }

  let board = null;
  if (existsSync(pcb)) {
    try {
      const out = join(outDir, 'pcb.svg');
      await kicad(['pcb', 'export', 'svg', '--mode-single', '--layers', PCB_LAYERS.join(','), '--output', out, pcb], { bin, home });
      writeFileSync(out, normaliseSvg(readFileSync(out, 'utf8')));
      artifacts.push({ artifact_id: 'pcb', kind: 'pcb_svg', file: 'pcb.svg', mime: 'image/svg+xml' });
    } catch (e) { notes.push(`PCB SVG export failed: ${String(e.message).split('\n')[0]}`); }
    if (caps.glb) {
      try {
        const out = join(outDir, 'board.glb');
        await kicad(['pcb', 'export', 'glb', '--subst-models', '--output', out, pcb], { bin, home });
        writeFileSync(out, normaliseGlb(readFileSync(out)));
        artifacts.push({ artifact_id: 'board3d', kind: 'mesh_glb', file: 'board.glb', mime: 'model/gltf-binary' });
        notes.push('3D view: board, copper and pads from KiCad; part bodies appear only where KiCad finds a 3D model');
      } catch (e) { notes.push(`GLB export failed: ${String(e.message).split('\n')[0]}`); }
    } else notes.push(`kicad-cli ${caps.version} cannot export GLB: no 3D view`);
    board = boardParts(readFileSync(pcb, 'utf8'));
  } else notes.push('no .kicad_pcb beside the schematic: no PCB or 3D view');

  const parts = {
    schematic: schematicParts(readFileSync(sch, 'utf8')),
    pcb: board ?? [],
    board3d: (board ?? []).map(p => ({ ref: p.ref, x: p.x / 1000, z: p.y / 1000, side: p.side })),
    notes,
  };
  writeFileSync(join(outDir, 'parts.json'), `${JSON.stringify(parts, null, 1)}\n`);
  artifacts.push({ artifact_id: 'parts', kind: 'other', file: 'parts.json', mime: 'application/json' });

  for (const a of artifacts) {
    const buf = readFileSync(join(outDir, a.file));
    a.sha256 = sha256(buf);
    a.bytes = buf.length;
  }
  return { artifacts, notes };
}
