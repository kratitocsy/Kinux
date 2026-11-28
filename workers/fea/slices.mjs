// The four validated FEA slices. Each one meshes a small box with Gmsh at
// several sizes, solves each mesh with CalculiX, extracts the quantity of
// interest from job.dat, and hands the sequence to study.mjs, which applies
// the convergence rule and compares with the closed-form answer.
//
// Units: mm, N, MPa, tonne/mm^3, s, K, mW (see materials.mjs).

import { boxGeo } from './geo.mjs';
import { meshGeometry } from './mesh.mjs';
import { runCcx, block } from './ccx.mjs';
import { meshCards, materialCards, faceTractionLoads, cloadCards, nearestNode, f } from './deck.mjs';
import { checkMaterial } from './materials.mjs';
import { judge } from './study.mjs';
import { toolVersions } from './exec.mjs';

/** Geometry input: a parametric box, or design .geo text (sanitized) with the same face names. */
function geometryOf(spec) {
  if (spec.geoText !== undefined) return { geoText: spec.geoText, trusted: false };
  return { geoText: boxGeo(spec), trusted: true };
}

/**
 * Run one study: for each mesh size, mesh -> deck -> ccx -> values.
 * buildDeck(model) returns { deck, ctx }; extract(run, model, ctx) returns { values }.
 */
async function runLevels({ geometry, meshSizes, order, material, needs, buildDeck, extract, timeoutMs }) {
  const mat = checkMaterial(material, needs);
  if (!mat.ok) return { ok: false, reason_code: 'no_material_data', reason: mat.reason, levels: [] };
  const levels = [];
  const hashes = [];
  for (const size of meshSizes) {
    const m = await meshGeometry(geometryOf(geometry), { size, order, timeoutMs });
    if (!m.ok) return { ok: false, reason_code: m.reason_code, reason: `mesh size ${size}: ${m.reason}`, levels };
    let built;
    try { built = buildDeck(m.model); } catch (e) { return { ok: false, reason_code: 'mesh_failed', reason: `mesh size ${size}: ${e.message}`, levels }; }
    const run = await runCcx(built.deck, { generated: true, timeoutMs });
    if (!run.ok) return { ok: false, reason_code: run.reason_code, reason: `mesh size ${size}: ${run.reason}`, levels };
    let values;
    try { values = extract(run, m.model, built.ctx); } catch (e) { return { ok: false, reason_code: 'tool_error', reason: `mesh size ${size}: could not read results: ${e.message}`, levels }; }
    levels.push({ size, nodes: m.stats.nodes, elements: m.stats.elements, element_type: m.model.elementTypes[0], values, dat_sha256: run.dat_sha256, deck_sha256: run.deck_sha256, ccx_ms: run.duration_ms });
    hashes.push(run.dat_sha256);
  }
  return { ok: true, levels, tool_versions: (await toolVersions()).ids };
}

const sum = a => a.reduce((s, x) => s + x, 0);
const mean = a => sum(a) / a.length;

/** Least squares for small dense systems (normal equations, Gaussian elimination). */
function lstsq(rows, rhs) {
  const n = rows[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  rows.forEach((r, k) => { for (let i = 0; i < n; i++) { b[i] += r[i] * rhs[k]; for (let j = 0; j < n; j++) A[i][j] += r[i] * r[j]; } });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-300) throw new Error('singular least-squares fit');
    for (let r = c + 1; r < n; r++) { const k = A[r][c] / A[c][c]; for (let j = c; j < n; j++) A[r][j] -= k * A[c][j]; b[r] -= k * b[c]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j]; x[i] = s / A[i][i]; }
  return x;
}

/** Integration-point records {elem, ip, x, y, z, s:[sxx..syz]} from *EL PRINT S,COORD. */
function integrationPoints(run, set) {
  const s = block(run, 'stresses', set), c = block(run, 'global coordinates', set);
  if (!s || !c || !s.rows.length || s.rows.length !== c.rows.length) throw new Error('stress or coordinate output missing');
  return s.rows.map((r, i) => {
    const q = c.rows[i];
    if (q[0] !== r[0] || q[1] !== r[1]) throw new Error('stress and coordinate rows do not line up');
    return { elem: r[0], ip: r[1], x: q[2], y: q[3], z: q[4], s: r.slice(2, 8) };
  });
}

function centroidsInBand(model, axis, lo, hi) {
  const ids = [];
  for (const e of model.elements) {
    const pts = e.nodes.slice(0, 4).map(n => model.nodes.get(n));
    const c = mean(pts.map(p => p[axis]));
    if (c >= lo && c <= hi) ids.push(e.id);
  }
  return ids;
}

const second = { 1: 'linear', 2: 'quadratic' };

// ---------------------------------------------------------------- 1. static
/**
 * Cantilever: clamped at x=0, uniform shear traction totalling F (-z) on x=L.
 * Quantities: tip deflection (mean -u_z over the x=L face nodes) and the
 * bending stress at mid-span x=L/2 (outer fibre), read from a bilinear
 * least-squares fit sxx = a + b x + c z + d x z of the integration-point
 * stresses in the band 0.3L..0.7L -- far from the clamped root (Saint-Venant)
 * and the loaded tip.
 */
export async function cantileverStatic({ L = 200, W = 10, H = 10, F = 100, material, meshSizes = [5, 3.5, 2.5], order = 2, geoText, timeoutMs } = {}) {
  const geometry = geoText !== undefined ? { geoText } : { L, W, H };
  const I = W * H ** 3 / 12;
  const study = await runLevels({
    geometry, meshSizes, order, material, needs: ['E', 'nu'], timeoutMs,
    buildDeck: model => {
      const { loads, area } = faceTractionLoads(model, 'xmax', [0, 0, -F / (W * H)]);
      const band = centroidsInBand(model, 0, 0.3 * L, 0.7 * L);
      const deck = [
        '*HEADING', `Kinux FEA slice: cantilever static, ${second[order]} tets`,
        ...meshCards(model, { extraElsets: { BAND: band } }),
        ...materialCards(material, ['E']),
        '*BOUNDARY', 'XMIN, 1, 3',
        '*STEP', '*STATIC, SOLVER=SPOOLES',
        ...cloadCards(loads),
        '*NODE PRINT, NSET=XMAX', 'U',
        '*NODE PRINT, NSET=XMIN, TOTALS=ONLY', 'RF',
        '*EL PRINT, ELSET=BAND', 'S, COORD',
        '*END STEP',
      ].join('\n') + '\n';
      return { deck, ctx: { area } };
    },
    extract: (run, model, ctx) => {
      const u = block(run, 'displacements', 'XMAX');
      if (!u || !u.rows.length) throw new Error('no tip displacements');
      const tip = -mean(u.rows.map(r => r[3]));
      const rf = block(run, 'total force', 'XMIN');
      const reaction = rf ? rf.rows[0][2] : NaN;
      const ips = integrationPoints(run, 'BAND');
      const coef = lstsq(ips.map(p => [1, p.x, p.z, p.x * p.z]), ips.map(p => p.s[0]));
      const at = (x, z) => coef[0] + coef[1] * x + coef[2] * z + coef[3] * x * z;
      const top = at(L / 2, H), bottom = at(L / 2, 0);
      return { tip_deflection: tip, sigma_midspan: Math.max(Math.abs(top), Math.abs(bottom)), sigma_top: top, sigma_bottom: bottom, root_reaction_z: reaction, load_area: ctx.area };
    },
  });
  const E = material?.E;
  return {
    slice: 'cantilever_static', study,
    analytic: { tip_deflection: F * L ** 3 / (3 * E * I), sigma_midspan: F * (L / 2) * (H / 2) / I, I },
  };
}

// --------------------------------------------------------------- 2. thermal
/**
 * Conduction along a box rod: T = T0 on x=0, T = T1 on x=L, other faces
 * insulated. Quantities: heat flow through x=0 (sum of RFL reactions) and
 * the largest nodal deviation from the linear profile.
 */
export async function conductionRod({ L = 100, W = 10, H = 10, T0 = 100, T1 = 0, material, meshSizes = [10, 6, 4], order = 2, geoText, timeoutMs } = {}) {
  const geometry = geoText !== undefined ? { geoText } : { L, W, H };
  const study = await runLevels({
    geometry, meshSizes, order, material, needs: ['conductivity'], timeoutMs,
    buildDeck: model => ({
      deck: [
        '*HEADING', 'Kinux FEA slice: steady conduction in a rod',
        ...meshCards(model, { heat: true }),
        ...materialCards(material, ['conductivity']),
        '*BOUNDARY', `XMIN, 11, 11, ${f(T0)}`, `XMAX, 11, 11, ${f(T1)}`,
        '*STEP', '*HEAT TRANSFER, STEADY STATE, SOLVER=SPOOLES',
        '*NODE PRINT, NSET=NALL', 'NT',
        '*NODE PRINT, NSET=XMIN, TOTALS=ONLY', 'RFL',
        '*END STEP',
      ].join('\n') + '\n',
      ctx: {},
    }),
    extract: (run, model) => {
      const t = block(run, 'temperatures', 'NALL');
      if (!t || t.rows.length !== model.nodes.size) throw new Error('temperature output incomplete');
      let maxDev = 0;
      for (const [id, T] of t.rows) {
        const x = model.nodes.get(id)[0];
        const want = T0 + (T1 - T0) * x / L;
        maxDev = Math.max(maxDev, Math.abs(T - want));
      }
      // ccx 2.21 labels the summed RFL reaction "total heat generation".
      const q = block(run, 'total heat generation', 'XMIN');
      if (!q || !q.rows.length) throw new Error('no heat flux reaction');
      return { heat_flow: Math.abs(q.rows[0][0]), max_profile_deviation: maxDev };
    },
  });
  const k = material?.conductivity;
  return {
    slice: 'conduction_rod', study,
    analytic: { heat_flow: k * W * H * Math.abs(T0 - T1) / L, max_profile_deviation: 0 },
  };
}

// --------------------------------------------------------- 3. thermal stress
/**
 * A bar held at both ends (u_x = 0 on x=0 and x=L, free to expand sideways;
 * two corner nodes remove the remaining rigid-body modes) heated uniformly by
 * dT. Quantity: mean axial stress over all integration points, plus its
 * spread (max - min).
 */
export async function thermalStressBar({ L = 100, W = 10, H = 10, Tinit = 20, dT = 100, material, meshSizes = [10, 6, 4], order = 2, geoText, timeoutMs } = {}) {
  const geometry = geoText !== undefined ? { geoText } : { L, W, H };
  const study = await runLevels({
    geometry, meshSizes, order, material, needs: ['E', 'nu', 'expansion'], timeoutMs,
    buildDeck: model => {
      const a = nearestNode(model, [0, 0, 0]), b = nearestNode(model, [0, W, 0]);
      if (a.distance > 1e-6 || b.distance > 1e-6) throw new Error('box corner nodes not found');
      return {
        deck: [
          '*HEADING', 'Kinux FEA slice: thermal stress in a bar held at both ends',
          ...meshCards(model),
          ...materialCards(material, ['E', 'expansion']),
          '*INITIAL CONDITIONS, TYPE=TEMPERATURE', `NALL, ${f(Tinit)}`,
          '*BOUNDARY', 'XMIN, 1, 1', 'XMAX, 1, 1', `${a.id}, 2, 3`, `${b.id}, 3, 3`,
          '*STEP', '*STATIC, SOLVER=SPOOLES',
          '*TEMPERATURE', `NALL, ${f(Tinit + dT)}`,
          '*EL PRINT, ELSET=EALL', 'S, COORD',
          '*END STEP',
        ].join('\n') + '\n',
        ctx: {},
      };
    },
    extract: run => {
      const ips = integrationPoints(run, 'EALL');
      const sxx = ips.map(p => p.s[0]);
      return { sigma_axial: mean(sxx), sigma_spread: Math.max(...sxx) - Math.min(...sxx) };
    },
  });
  return {
    slice: 'thermal_stress_bar', study,
    analytic: { sigma_axial: -(material?.E) * (material?.expansion) * dT },
  };
}

// ------------------------------------------------------------------ 4. modal
/** The cantilever's lowest natural frequency (clamped at x=0). */
export async function cantileverModal({ L = 200, W = 10, H = 10, modes = 4, material, meshSizes = [5, 3.5, 2.5], order = 2, geoText, timeoutMs } = {}) {
  const geometry = geoText !== undefined ? { geoText } : { L, W, H };
  const study = await runLevels({
    geometry, meshSizes, order, material, needs: ['E', 'nu', 'density'], timeoutMs,
    buildDeck: model => ({
      deck: [
        '*HEADING', 'Kinux FEA slice: cantilever modal',
        ...meshCards(model),
        ...materialCards(material, ['E', 'density']),
        '*BOUNDARY', 'XMIN, 1, 3',
        '*STEP', '*FREQUENCY, SOLVER=SPOOLES', String(modes),
        '*END STEP',
      ].join('\n') + '\n',
      ctx: {},
    }),
    extract: run => {
      if (!run.eigen.length) throw new Error('no eigenvalue output');
      const fr = run.eigen.map(e => e.frequency).sort((a, b) => a - b);
      return { f1: fr[0], frequencies: fr };
    },
  });
  const I = Math.min(W * H ** 3, H * W ** 3) / 12, A = W * H;
  const E = material?.E, rho = material?.density;
  return {
    slice: 'cantilever_modal', study,
    analytic: { f1: (1.875104068711961 ** 2 / (2 * Math.PI)) * Math.sqrt(E * I / (rho * A * L ** 4)) },
  };
}

/** Standard checks for each slice: the hand calculation and the tolerances. */
export const SLICE_CHECKS = {
  cantilever_static: [
    { test_id: 'fea.cantilever.deflection', key: 'tip_deflection', units: 'mm', convTol: 0.005, relTol: 0.01, formula: 'F L^3 / (3 E I)', label: 'tip deflection' },
    { test_id: 'fea.cantilever.stress', key: 'sigma_midspan', units: 'MPa', convTol: 0.01, relTol: 0.02, formula: 'M c / I at x = L/2', label: 'mid-span bending stress' },
  ],
  conduction_rod: [
    { test_id: 'fea.conduction.heat_flow', key: 'heat_flow', units: 'mW', convTol: 0.001, relTol: 0.001, formula: 'k A dT / L', label: 'heat flow' },
    // Largest nodal departure from T0 + (T1 - T0) x / L, in kelvin. Its exact
    // value is 0; 1e-3 K is ~200x the 7-digit print precision of job.dat.
    { test_id: 'fea.conduction.profile', key: 'max_profile_deviation', units: 'K', convTol: 0.001, convAbs: 1e-3, max: 1e-3, label: 'deviation from the linear profile' },
  ],
  thermal_stress_bar: [
    { test_id: 'fea.thermal_stress.axial', key: 'sigma_axial', units: 'MPa', convTol: 0.001, relTol: 0.001, formula: '-E alpha dT', label: 'axial thermal stress' },
  ],
  cantilever_modal: [
    { test_id: 'fea.modal.f1', key: 'f1', units: 'Hz', convTol: 0.005, relTol: 0.01, formula: '(1.875^2 / 2 pi) sqrt(E I / (rho A L^4))', label: 'first natural frequency' },
  ],
};

/** Judge a slice's study with its standard checks (overridable). */
export function judgeSlice(sliceResult, { checks, subject } = {}) {
  const list = checks ?? SLICE_CHECKS[sliceResult.slice];
  return list.map(q => judge(sliceResult.study, { ...q, subject, reference: q.max !== undefined || q.min !== undefined ? undefined : sliceResult.analytic[q.key] }));
}
