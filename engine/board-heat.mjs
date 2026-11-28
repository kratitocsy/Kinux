// A board's steady temperature field, solved by CalculiX.
//
// What goes in, and where each number comes from:
//   geometry      the board outline, its thickness and copper layer count, and
//                 every footprint's pads: read from the .kicad_pcb (the design)
//   power         each part's dissipation, measured by ngspice under one check
//                 block's conditions (engine/part-power.mjs); energy balance
//                 against the block's sources is recorded
//   materials,    laminate and copper conductivity, copper thickness and
//   environment   coverage, ambient temperature and the convection film
//                 coefficients: the caller's heat file, where EVERY value
//                 carries a `source` (a datasheet, a handbook, or the word
//                 "assumed" with why). A value without a source is missing,
//                 and a missing value means no field: NOT_CHECKED,
//                 no_material_data. Never a default.
//
// The model, stated so the viewer can show it verbatim:
//   * the board is a plate of the outline's rectangle, its laminate and copper
//     smeared into one orthotropic material (in-plane: layers in parallel;
//     through the thickness: in series);
//   * each part's power enters as a uniform flux over its pads' bounding box,
//     on the side the part sits on;
//   * heat leaves the two faces by convection to ambient (film coefficients);
//     the edges are insulated; no radiation, no part bodies, no airflow;
//   * steady state, one-way: temperatures do not change the electrical result.
//
// Hex (DC3D8) grids at three or more sizes, each finer than the last; the
// field is drawn only if the hottest point has converged by the same rule as
// every FEA slice (workers/fea/study.mjs). An unconverged field is reported,
// with its numbers, and not drawn.

import { parseSexp, children, child, numAt, atomAt, propertyValue } from '../workers/kicad/sexp.mjs';
import { runCcx } from '../workers/fea/ccx.mjs';
import { convergence } from '../workers/fea/study.mjs';

export const HEAT_MODEL = 'steady conduction in the board (orthotropic laminate+copper plate), convection from both faces, edges insulated; part power from ngspice as a uniform flux over each part\'s pads';

const REQUIRED = {
  ambient_c: v => v > -100 && v < 200,
  h_top_w_m2k: v => v > 0,
  h_bottom_w_m2k: v => v > 0,
  laminate_k_w_mk: v => v > 0,
  copper_k_w_mk: v => v > 0,
  copper_thickness_um: v => v > 0,
  copper_coverage: v => v >= 0 && v <= 1,
};

/** Check the heat file: every required value present, physical, and sourced. */
export function checkHeatInputs(inputs) {
  const missing = [];
  for (const [k, ok] of Object.entries(REQUIRED)) {
    const e = inputs?.[k];
    const v = e?.value;
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v) || typeof e.source !== 'string' || !e.source.trim()) missing.push(k);
  }
  return missing.length ? { ok: false, missing, reason: `heat inputs lack a usable, sourced ${missing.join(', ')}` } : { ok: true };
}

const rotate = (lx, ly, deg) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [lx * c + ly * s, -lx * s + ly * c];
};

/** Outline rectangle, thickness, copper layers and pad boxes from a .kicad_pcb. */
export function boardThermalGeometry(pcbText) {
  const root = parseSexp(pcbText)[0] ?? [];
  const edges = [];
  for (const tag of ['gr_line', 'gr_rect', 'gr_arc', 'gr_circle', 'gr_poly', 'gr_curve']) {
    for (const g of children(root, tag)) if (atomAt(child(g, 'layer'), 1) === 'Edge.Cuts') edges.push({ tag, g });
  }
  let rect = null;
  if (edges.length === 1 && edges[0].tag === 'gr_rect') {
    const s = child(edges[0].g, 'start'), e = child(edges[0].g, 'end');
    rect = { minX: Math.min(numAt(s, 1), numAt(e, 1)), minY: Math.min(numAt(s, 2), numAt(e, 2)), maxX: Math.max(numAt(s, 1), numAt(e, 1)), maxY: Math.max(numAt(s, 2), numAt(e, 2)) };
  } else if (edges.length === 4 && edges.every(x => x.tag === 'gr_line')) {
    const pts = edges.flatMap(({ g }) => ['start', 'end'].map(k => [numAt(child(g, k), 1), numAt(child(g, k), 2)]));
    const axis = edges.every(({ g }) => numAt(child(g, 'start'), 1) === numAt(child(g, 'end'), 1) || numAt(child(g, 'start'), 2) === numAt(child(g, 'end'), 2));
    const xs = [...new Set(pts.map(p => p[0]))], ys = [...new Set(pts.map(p => p[1]))];
    if (axis && xs.length === 2 && ys.length === 2) rect = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  const general = child(root, 'general');
  const thickness = general ? numAt(child(general, 'thickness'), 1) : NaN;
  const layers = child(root, 'layers');
  const copperLayers = layers ? layers.slice(1).filter(l => Array.isArray(l) && /\.Cu$/.test(String(l[1])) && /^(signal|power|mixed|jumper)$/.test(String(l[2]))).length : 0;
  const footprints = {};
  for (const f of children(root, 'footprint')) {
    const at = child(f, 'at');
    let ref = propertyValue(f, 'Reference');
    if (!ref) for (const t of children(f, 'fp_text')) if (atomAt(t, 1) === 'reference') ref = atomAt(t, 2);
    if (!ref || !at) continue;
    const fx = numAt(at, 1), fy = numAt(at, 2), frot = numAt(at, 3, 0);
    let box = null;
    for (const p of children(f, 'pad')) {
      const pat = child(p, 'at'), size = child(p, 'size');
      if (!pat || !size) continue;
      const [dx, dy] = rotate(numAt(pat, 1), numAt(pat, 2), frot);
      const cx = fx + dx, cy = fy + dy;
      const a = (numAt(pat, 3, frot) * Math.PI) / 180;
      const w = numAt(size, 1), h = numAt(size, 2);
      const hw = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
      const hh = (Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))) / 2;
      const b = [cx - hw, cy - hh, cx + hw, cy + hh];
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
    }
    if (box) footprints[ref] = { box, side: atomAt(child(f, 'layer'), 1) === 'B.Cu' ? 'bottom' : 'top' };
  }
  return { rect, thickness, copperLayers, footprints, outlineSegments: edges.length };
}

/** In-plane (parallel) and through-thickness (series) conductivity of the smeared plate, W/(m K). */
export function effectiveConductivity({ thickness_mm, copperLayers, inputs }) {
  const tcu = (inputs.copper_thickness_um.value / 1000) * copperLayers * inputs.copper_coverage.value;
  const tlam = thickness_mm - tcu;
  const kcu = inputs.copper_k_w_mk.value, klam = inputs.laminate_k_w_mk.value;
  return { in_plane: (tcu * kcu + tlam * klam) / thickness_mm, through: thickness_mm / (tcu / kcu + tlam / klam), copper_mm: tcu };
}

const f = x => Number(x).toExponential(10);
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** The CalculiX deck for one grid size. Coordinates are board-relative mm; power in mW (consistent with mW/(mm K)). */
export function heatDeck({ W, H, t, size, k, inputs, loads }) {
  const nx = Math.max(2, Math.ceil(W / size)), ny = Math.max(2, Math.ceil(H / size));
  const dx = W / nx, dy = H / ny;
  const nid = (i, j, l) => 1 + i + j * (nx + 1) + l * (nx + 1) * (ny + 1);
  const lines = ['*HEADING', 'Kinux board heat: steady conduction, convection from both faces', '*NODE'];
  for (let l = 0; l < 2; l++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) lines.push(`${nid(i, j, l)}, ${f(i * dx)}, ${f(j * dy)}, ${f(l * t)}`);
  lines.push('*ELEMENT, TYPE=DC3D8, ELSET=EALL');
  const eid = (i, j) => 1 + i + j * nx;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    lines.push(`${eid(i, j)}, ${nid(i, j, 0)}, ${nid(i + 1, j, 0)}, ${nid(i + 1, j + 1, 0)}, ${nid(i, j + 1, 0)}, ${nid(i, j, 1)}, ${nid(i + 1, j, 1)}, ${nid(i + 1, j + 1, 1)}, ${nid(i, j + 1, 1)}`);
  }
  lines.push('*NSET, NSET=NALL, GENERATE', `1, ${nid(nx, ny, 1)}, 1`);
  lines.push('*MATERIAL, NAME=BOARD', '*CONDUCTIVITY, TYPE=ORTHO', `${f(k.in_plane)}, ${f(k.in_plane)}, ${f(k.through)}`, '*SOLID SECTION, ELSET=EALL, MATERIAL=BOARD');
  lines.push('*INITIAL CONDITIONS, TYPE=TEMPERATURE', `NALL, ${f(inputs.ambient_c.value)}`);
  lines.push('*STEP', '*HEAT TRANSFER, STEADY STATE, SOLVER=SPOOLES');
  // Faces of a DC3D8 with nodes 1-4 at z=0 and 5-8 at z=t: S1/F1 bottom, S2/F2 top.
  const flux = [];
  let applied = 0;
  for (const ld of loads) {
    const [x0, y0, x1, y1] = ld.box;
    const area = (x1 - x0) * (y1 - y0);
    if (!(area > 0) || !(ld.mw > 0)) continue;
    const face = ld.side === 'bottom' ? 'S1' : 'S2';
    for (let j = Math.max(0, Math.floor(y0 / dy)); j < Math.min(ny, Math.ceil(y1 / dy)); j++) {
      for (let i = Math.max(0, Math.floor(x0 / dx)); i < Math.min(nx, Math.ceil(x1 / dx)); i++) {
        const a = overlap(x0, x1, i * dx, (i + 1) * dx) * overlap(y0, y1, j * dy, (j + 1) * dy);
        if (a <= 0) continue;
        const q = (ld.mw * a) / area / (dx * dy); // mW/mm² on this element's face
        flux.push(`${eid(i, j)}, ${face}, ${f(q)}`);
        applied += q * dx * dy;
      }
    }
  }
  if (flux.length) lines.push('*DFLUX', ...flux);
  const hTop = inputs.h_top_w_m2k.value * 1e-3, hBot = inputs.h_bottom_w_m2k.value * 1e-3; // W/(m² K) -> mW/(mm² K)
  lines.push('*FILM');
  for (let e = 1; e <= nx * ny; e++) lines.push(`${e}, F1, ${f(inputs.ambient_c.value)}, ${f(hBot)}`, `${e}, F2, ${f(inputs.ambient_c.value)}, ${f(hTop)}`);
  lines.push('*NODE PRINT, NSET=NALL', 'NT', '*END STEP');
  return { deck: `${lines.join('\n')}\n`, nx, ny, dx, dy, nid, applied_mw: applied };
}

/**
 * Solve the field at successively finer grids and judge convergence of the hottest point.
 * @returns {Promise<object>} the heat-field payload (always), with `drawn` true only when converged
 */
export async function solveBoardHeat({ geometry, power, inputs, minLevels = 3, maxLevels = 7, timeoutMs = 300_000, convTol = 0.02 }) {
  const base = { model: HEAT_MODEL, inputs, power_w: Object.fromEntries(Object.entries(power?.parts ?? {}).map(([r, p]) => [r, { watts: p.watts, elements: p.elements, ...(p.note ? { note: p.note } : {}) }])),
    power_source: { solver: 'ngspice', analysis: power?.analysis, averaged: power?.averaged ?? null, balance: power?.balance, tool_versions: power?.tool_versions } };
  const chk = checkHeatInputs(inputs);
  if (!chk.ok) return { ...base, drawn: false, verdict: 'NOT_CHECKED', reason_code: 'no_material_data', reason: chk.reason };
  if (!geometry.rect) {
    return { ...base, drawn: false, verdict: 'NOT_CHECKED', reason_code: 'out_of_scope', reason: `the board outline is ${geometry.outlineSegments} Edge.Cuts shape(s), not one rectangle; only rectangular boards are modelled so far` };
  }
  if (!(geometry.thickness > 0) || !geometry.copperLayers) return { ...base, drawn: false, verdict: 'NOT_CHECKED', reason_code: 'no_material_data', reason: 'the board file gives no thickness or no copper layers' };
  if (!power?.ok) return { ...base, drawn: false, verdict: 'NOT_CHECKED', reason_code: power?.reason_code ?? 'tool_error', reason: `no part power: ${power?.reason ?? 'not measured'}` };

  const { rect } = geometry;
  const W = rect.maxX - rect.minX, H = rect.maxY - rect.minY, t = geometry.thickness;
  const k = effectiveConductivity({ thickness_mm: t, copperLayers: geometry.copperLayers, inputs });
  const loads = [], unplaced = [], absorbing = [];
  for (const [ref, p] of Object.entries(power.parts)) {
    if (p.watts < 0) { absorbing.push(ref); continue; }
    if (p.watts === 0) continue;
    const fp = geometry.footprints[ref];
    if (!fp) { unplaced.push({ ref, watts: p.watts }); continue; }
    const [x0, y0, x1, y1] = fp.box;
    loads.push({ ref, mw: p.watts * 1000, side: fp.side, box: [x0 - rect.minX, y0 - rect.minY, x1 - rect.minX, y1 - rect.minY] });
  }
  const size0 = Math.max(W, H) / 16;
  const study = [];
  let last = null;
  // Refine by 1.6x per level until the peak rise has converged (at least
  // minLevels grids, as for every FEA slice) or maxLevels is reached.
  for (let level = 0; level < maxLevels; level++) {
    if (level >= minLevels && convergence(study.map(s => s.peak_c - inputs.ambient_c.value), convTol, 1e-6).converged) break;
    const size = size0 / 1.6 ** level;
    const d = heatDeck({ W, H, t, size, k, inputs, loads });
    const run = await runCcx(d.deck, { generated: true, timeoutMs });
    if (!run.ok) return { ...base, drawn: false, verdict: run.reason_code === 'timeout' || run.reason_code === 'tool_error' ? 'ERROR' : 'NOT_CHECKED', reason_code: run.reason_code, reason: run.reason };
    const temps = run.blocks.find(b => b.kind.toLowerCase().startsWith('temperatures'));
    const T = new Float64Array(d.nid(d.nx, d.ny, 1) + 1);
    for (const [id, v] of temps?.rows ?? []) T[id] = v;
    const top = [], bottom = [];
    for (let j = 0; j <= d.ny; j++) for (let i = 0; i <= d.nx; i++) { top.push(T[d.nid(i, j, 1)]); bottom.push(T[d.nid(i, j, 0)]); }
    const peak = Math.max(...top, ...bottom);
    const parts = {};
    for (const ld of loads) {
      const field = ld.side === 'bottom' ? bottom : top;
      let pk = -Infinity;
      for (let j = 0; j <= d.ny; j++) for (let i = 0; i <= d.nx; i++) {
        const x = i * d.dx, y = j * d.dy;
        if (x >= ld.box[0] - d.dx / 2 && x <= ld.box[2] + d.dx / 2 && y >= ld.box[1] - d.dy / 2 && y <= ld.box[3] + d.dy / 2) pk = Math.max(pk, field[i + j * (d.nx + 1)]);
      }
      parts[ld.ref] = { peak_c: pk, watts: ld.mw / 1000, side: ld.side };
    }
    study.push({ size, elements: d.nx * d.ny, nodes: 2 * (d.nx + 1) * (d.ny + 1), peak_c: peak, applied_w: d.applied_mw / 1000, deck_sha256: run.deck_sha256, tool_versions: run.tool_versions });
    last = { d, top, bottom, parts, run };
  }
  const rises = study.map(s => s.peak_c - inputs.ambient_c.value);
  const conv = convergence(rises, convTol, 1e-6);
  const totalW = loads.reduce((a, l) => a + l.mw, 0) / 1000;
  const out = {
    ...base, solver: last.run.tool_versions, board_mm: { width: W, height: H, thickness: t, copper_layers: geometry.copperLayers, origin: [rect.minX, rect.minY] },
    conductivity_w_mk: k, total_w: totalW, unplaced, sources_absorbing: absorbing,
    study: { levels: study, quantity: 'peak temperature rise above ambient, K', values: rises, convergence: conv, conv_tol: convTol },
  };
  if (!conv.converged) return { ...out, drawn: false, verdict: 'NOT_CHECKED', reason_code: 'mesh_not_converged', reason: `peak rise not converged: ${conv.why}` };
  const { d } = last;
  return {
    ...out, drawn: true, verdict: 'COMPUTED',
    peak_c: study[study.length - 1].peak_c,
    grid: { nx: d.nx + 1, ny: d.ny + 1, dx: d.dx, dy: d.dy, unit: 'degC', top: last.top.map(v => +v.toFixed(4)), bottom: last.bottom.map(v => +v.toFixed(4)) },
    parts: last.parts,
  };
}

/**
 * The whole step for a run: measure power under the heat file's block, solve,
 * write heat/heat-field.json. Returns the artifact record (always, drawn or not).
 */
export async function boardHeatArtifact({ netlist, suite, spec, pcbText, outDir, compat = null, timeoutMs }) {
  const { measurePartPower } = await import('./part-power.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const n = Number(spec.block ?? 1);
  const block = suite.blocks.filter(b => b.kind !== 'thermal')[n - 1];
  const power = block
    ? await measurePartPower(netlist, block, { compat, timeoutMs, standIns: spec.stand_ins ?? {}, averageFrom: spec.average_from_s })
    : { ok: false, reason_code: 'out_of_scope', reason: `the heat file names block ${n}, and the suite has no such simulation block` };
  const payload = await solveBoardHeat({ geometry: boardThermalGeometry(pcbText), power, inputs: spec });
  payload.block = n;
  mkdirSync(outDir, { recursive: true });
  const buf = Buffer.from(`${JSON.stringify(payload)}\n`);
  writeFileSync(join(outDir, 'heat-field.json'), buf);
  return { payload, artifact: { artifact_id: 'heat-field', kind: 'thermal_field', file: 'heat-field.json', mime: 'application/json',
    sha256: `sha256:${createHash('sha256').update(buf).digest('hex')}`, bytes: buf.length } };
}
