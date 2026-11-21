// Write CalculiX decks from a parsed mesh and typed inputs. Every number is
// checked to be finite and every set name is generated here, so the deck
// needs no sanitizing; runCcx() is called with generated:true.

const fin = (x, what) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${what} must be a finite number, got ${x}`);
  return x;
};
/** Fixed 13-significant-digit exponent format: deterministic and round-trippable enough. */
export const f = x => fin(x, 'value').toExponential(12);

function idLines(ids, per = 10) {
  const out = [];
  for (let i = 0; i < ids.length; i += per) out.push(ids.slice(i, i + per).join(', ') + ',');
  return out;
}

/** Map a solid element type to its heat-transfer twin. */
const HEAT_TYPE = { C3D4: 'DC3D4', C3D10: 'DC3D10' };

/**
 * Mesh section of a deck: nodes, volume elements (EALL), NALL, and one node
 * set per named face (upper-cased face name, e.g. XMIN).
 */
export function meshCards(model, { heat = false, extraElsets = {} } = {}) {
  const out = ['*NODE'];
  for (const [id, [x, y, z]] of model.nodes) out.push(`${id}, ${f(x)}, ${f(y)}, ${f(z)}`);
  const type = heat ? HEAT_TYPE[model.elementTypes[0]] : model.elementTypes[0];
  out.push(`*ELEMENT, TYPE=${type}, ELSET=EALL`);
  for (const e of model.elements) out.push(`${e.id}, ${e.nodes.join(', ')}`);
  out.push('*NSET, NSET=NALL', ...idLines([...model.nodes.keys()]));
  for (const [name, face] of Object.entries(model.faces)) {
    if (!/^[a-z0-9_]+$/.test(name)) continue;
    const used = face.nodes.filter(n => model.nodes.has(n));
    if (used.length) out.push(`*NSET, NSET=${name.toUpperCase()}`, ...idLines(used));
  }
  for (const [name, ids] of Object.entries(extraElsets)) {
    if (ids.length) out.push(`*ELSET, ELSET=${name}`, ...idLines(ids));
  }
  return out;
}

/** Material block. `m` has already been checked by materials.mjs. */
export function materialCards(m, needs) {
  const out = ['*MATERIAL, NAME=MAT'];
  if (needs.includes('E')) out.push('*ELASTIC', `${f(m.E)}, ${f(m.nu)}`);
  if (needs.includes('density')) out.push('*DENSITY', f(m.density));
  if (needs.includes('expansion')) out.push('*EXPANSION', f(m.expansion));
  if (needs.includes('conductivity')) out.push('*CONDUCTIVITY', f(m.conductivity));
  out.push('*SOLID SECTION, ELSET=EALL, MATERIAL=MAT');
  return out;
}

/**
 * Consistent nodal loads for a uniform traction `t` (force per area, vector)
 * on a face made of CPS3/CPS6 triangles. For a 6-node triangle the corner
 * loads are zero and each mid-side node takes A/3; for a 3-node triangle each
 * corner takes A/3. Returns Map(node -> [fx, fy, fz]).
 */
export function faceTractionLoads(model, faceName, t) {
  const face = model.faces[faceName];
  if (!face) throw new Error(`face ${faceName} not found in mesh`);
  const loads = new Map();
  const add = (n, s) => {
    const v = loads.get(n) ?? [0, 0, 0];
    loads.set(n, [v[0] + s * t[0], v[1] + s * t[1], v[2] + s * t[2]]);
  };
  let area = 0;
  for (const tri of face.triangles) {
    const [a, b, c] = tri.slice(0, 3).map(n => model.nodes.get(n));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const A = Math.hypot(...cr) / 2;
    area += A;
    const carriers = tri.length === 6 ? tri.slice(3, 6) : tri.slice(0, 3);
    for (const n of carriers) add(n, A / 3);
  }
  return { loads, area };
}

export function cloadCards(loads) {
  const out = ['*CLOAD'];
  for (const [n, v] of [...loads].sort((a, b) => a[0] - b[0])) {
    v.forEach((x, i) => { if (x !== 0) out.push(`${n}, ${i + 1}, ${f(x)}`); });
  }
  return out;
}

/** Node nearest to a point (used to pin rigid-body modes at box corners). */
export function nearestNode(model, p) {
  let best = null, bd = Infinity;
  for (const [id, x] of model.nodes) {
    const d = Math.hypot(x[0] - p[0], x[1] - p[1], x[2] - p[2]);
    if (d < bd) { bd = d; best = id; }
  }
  return { id: best, distance: bd };
}
