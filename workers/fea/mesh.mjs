// Mesh with Gmsh and parse its Abaqus/CalculiX .inp export.
//
// The raw Gmsh export is NEVER handed to CalculiX. It contains line and
// surface elements (T3D3, CPS6, ...) that CalculiX would treat as real
// structural elements, plus whatever else Gmsh chose to write. We parse it,
// keep only the volume elements, and keep the boundary faces as node sets and
// face lists; the solver deck is written fresh by deck.mjs.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GMSH_BIN, runBinary, makeWorkDir, cleanup } from './exec.mjs';
import { sanitizeGeo, describeGeoViolations } from './geo.mjs';

export const VOLUME_TYPES = { C3D4: 4, C3D10: 10 };
const SURFACE_TYPES = { CPS3: 3, CPS6: 6, S3: 3, S6: 6 };

/** Parse a Gmsh .inp export. Throws on anything it does not understand. */
export function parseGmshInp(text) {
  const nodes = new Map();          // id -> [x, y, z]
  const elements = [];              // { id, type, nodes, elset }
  const elsets = new Map();         // name -> [element ids]
  const nsets = new Map();          // name -> [node ids]
  let mode = null, cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('**')) continue;
    if (line.startsWith('*')) {
      const head = line.toUpperCase().replace(/\s+/g, '');
      const param = k => { const m = line.match(new RegExp(`${k}\\s*=\\s*([^,\\s]+)`, 'i')); return m ? m[1] : null; };
      if (head.startsWith('*NODE') && !head.startsWith('*NODEPRINT') && !head.startsWith('*NODEFILE')) { mode = 'node'; }
      else if (head.startsWith('*ELEMENT')) { mode = 'elem'; cur = { type: param('type').toUpperCase(), elset: param('ELSET') }; }
      else if (head.startsWith('*ELSET')) { mode = 'elset'; cur = param('ELSET'); elsets.set(cur, elsets.get(cur) ?? []); }
      else if (head.startsWith('*NSET')) { mode = 'nset'; cur = param('NSET'); nsets.set(cur, nsets.get(cur) ?? []); }
      else mode = null;
      continue;
    }
    const parts = line.split(',').map(s => s.trim()).filter(s => s !== '');
    if (mode === 'node') {
      const [id, x, y, z] = parts.map(Number);
      if (![id, x, y, z].every(Number.isFinite)) throw new Error(`bad node line: ${line}`);
      nodes.set(id, [x, y, z]);
    } else if (mode === 'elem') {
      const ids = parts.map(Number);
      elements.push({ id: ids[0], type: cur.type, nodes: ids.slice(1), elset: cur.elset });
    } else if (mode === 'elset') {
      elsets.get(cur).push(...parts.map(Number));
    } else if (mode === 'nset') {
      nsets.get(cur).push(...parts.map(Number));
    }
  }
  return { nodes, elements, elsets, nsets };
}

/**
 * Keep the volume elements; turn each named physical surface into a node set
 * and a list of surface triangles (for consistent face loads).
 */
export function extractModel(parsed) {
  const volumes = parsed.elements.filter(e => VOLUME_TYPES[e.type]);
  const byId = new Map(parsed.elements.map(e => [e.id, e]));
  const types = [...new Set(volumes.map(e => e.type))];
  for (const e of volumes) {
    if (e.nodes.length !== VOLUME_TYPES[e.type]) throw new Error(`element ${e.id} has ${e.nodes.length} nodes, expected ${VOLUME_TYPES[e.type]}`);
    for (const n of e.nodes) if (!parsed.nodes.has(n)) throw new Error(`element ${e.id} uses missing node ${n}`);
  }
  const faces = {};
  for (const [name, ids] of parsed.elsets) {
    const tris = ids.map(id => byId.get(id)).filter(e => e && SURFACE_TYPES[e.type]);
    if (!tris.length) continue;
    faces[name.toLowerCase()] = {
      triangles: tris.map(e => e.nodes),
      nodes: [...new Set(tris.flatMap(e => e.nodes))].sort((a, b) => a - b),
    };
  }
  // Only nodes used by volume elements go to the solver.
  const used = new Set(volumes.flatMap(e => e.nodes));
  const nodes = new Map([...parsed.nodes].filter(([id]) => used.has(id)).sort((a, b) => a[0] - b[0]));
  return { nodes, elements: volumes.map(({ id, type, nodes }) => ({ id, type, nodes })), elementTypes: types, faces };
}

/** Characteristic edge length actually produced: (volume / elements)^(1/3) scaled to a tet edge. */
function meshStats(model) {
  return { nodes: model.nodes.size, elements: model.elements.length };
}

/**
 * Mesh geometry with Gmsh.
 * @param {{geoText:string, trusted?:boolean}} geometry  trusted=true only for text from geo.mjs boxGeo()
 * @param {{size:number, order?:1|2, timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, model, stats, mesh_size} | {ok:false, reason_code, reason}>}
 */
/**
 * Options pinned on every mesh, never taken from user input or Gmsh's defaults
 * (which change between versions). Measured on gmsh 4.12.1 on this project's
 * machine: at 4 threads the same model gave 6 different meshes in 6 runs, and
 * pinning only some of the per-dimension thread counts did not fix it; all
 * three at 1 did. The seed and algorithms are this version's defaults, written
 * down so an upgrade cannot change them silently. docs/DETERMINISM-PLAN.md §4.2.
 */
export const GMSH_PINNED = Object.freeze({
  'General.NumThreads': 1,
  'Mesh.MaxNumThreads1D': 1,
  'Mesh.MaxNumThreads2D': 1,
  'Mesh.MaxNumThreads3D': 1,
  'Mesh.RandomSeed': 1,
  'Mesh.Algorithm': 6,
  'Mesh.Algorithm3D': 1,
});

export async function meshGeometry({ geoText, trusted = false }, { size, order = 2, timeoutMs = 60_000 } = {}) {
  if (!trusted) {
    const s = sanitizeGeo(geoText);
    if (!s.ok) {
      return { ok: false, blocked: true, reason_code: 'mesh_failed', reason: `geometry rejected by the .geo sanitizer (not run):\n${describeGeoViolations(s.violations)}`, violations: s.violations };
    }
  }
  if (!(typeof size === 'number' && size > 0 && Number.isFinite(size))) {
    return { ok: false, reason_code: 'mesh_failed', reason: `mesh size must be a positive number, got ${size}` };
  }
  const dir = await makeWorkDir('gmsh');
  try {
    await writeFile(join(dir, 'model.geo'), geoText, 'utf8');
    const args = ['model.geo', '-3', '-order', String(order), '-clmax', String(size),
      '-format', 'inp', '-o', 'mesh.inp', '-nt', '1', '-setnumber', 'Mesh.SaveGroupsOfNodes', '1',
      ...Object.entries(GMSH_PINNED).flatMap(([k, v]) => ['-setnumber', k, String(v)])];
    const r = await runBinary(GMSH_BIN, args, { cwd: dir, timeoutMs });
    const log = `${r.stdout}\n${r.stderr}`;
    if (r.spawnError) return { ok: false, reason_code: 'tool_missing', reason: r.spawnError };
    if (r.timedOut) return { ok: false, reason_code: 'timeout', reason: `gmsh exceeded ${timeoutMs} ms` };
    const errors = log.split('\n').filter(l => /^Error\s*:/.test(l));
    if (r.code !== 0 || errors.length) {
      return { ok: false, reason_code: 'mesh_failed', reason: (errors.join('\n') || `gmsh exited with ${r.code}`).slice(0, 2000) };
    }
    let text;
    try { text = await readFile(join(dir, 'mesh.inp'), 'utf8'); } catch { return { ok: false, reason_code: 'mesh_failed', reason: 'gmsh wrote no mesh file' }; }
    let model;
    try { model = extractModel(parseGmshInp(text)); } catch (e) { return { ok: false, reason_code: 'mesh_failed', reason: `could not parse gmsh output: ${e.message}` }; }
    if (!model.elements.length) return { ok: false, reason_code: 'mesh_failed', reason: 'gmsh produced no volume elements' };
    if (model.elementTypes.length !== 1) return { ok: false, reason_code: 'mesh_failed', reason: `mixed element types ${model.elementTypes.join(',')}` };
    return { ok: true, model, stats: meshStats(model), mesh_size: size, mesh_sha256: `sha256:${createHash('sha256').update(text).digest('hex')}`, gmsh_options: GMSH_PINNED, gmsh_warnings: log.split('\n').filter(l => /^Warning\s*:/.test(l)) };
  } finally {
    await cleanup(dir);
  }
}
