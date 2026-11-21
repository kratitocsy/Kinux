// The lumped thermal model: data, validation and the closed-form physics.
//
// What this file is, and is not:
//
//   * ONE thermal node per component, connected to ambient by a thermal
//     resistance Rθ (K/W) -- either a single body-to-ambient figure, or a
//     series chain such as Rθjc + Rθcs + Rθsa, which for a single node is just
//     their sum.
//   * Steady state:   ΔT = P · Rθ,           T = Ta + ΔT
//   * Transient:      T(t) = Ta + P · Rθ · (1 − e^(−t/τ)),   τ = Rθ · Cθ
//     i.e. a step of constant power P applied at t = 0 to a part sitting at
//     ambient. One pole, nothing else.
//   * ONE-WAY coupling, electrical -> thermal. P comes from the electrical
//     simulation; the temperature computed here does NOT feed back into any
//     resistance. A part that gets hot does not change value in this model.
//
// No conduction between parts, no copper spreading, no airflow, no
// temperature-dependent resistance, no coupling back to the electrical side.
// workers/thermal/README.md says the same thing at more length.
//
// HONESTY RULE. Every number used here carries a source: a datasheet figure, a
// stated design rule, or an explicit "assumed". A value without a source is not
// used -- it is treated as missing, and missing thermal data produces
// NOT_CHECKED with reason_code `no_material_data`. Never a default, never a
// guess, never a pass.

/** The two model names a result can carry. The viewer shows them verbatim. */
export const MODEL_STEADY = 'lumped steady-state, one-way electrical→thermal coupling';
export const MODEL_TRANSIENT = 'lumped first-order transient, one-way electrical→thermal coupling';

/** Stated on every result, so the number never travels without its limits. */
export const LIMITATION =
  'one-way electrical -> thermal chain: temperature does not feed back into resistance; ' +
  'no conduction between parts, no copper spreading, no airflow';

export const THERMAL_TOOL_ID = 'kinux-thermal-lumped-1';

/** A source must say which kind it is, then say something. */
const SOURCE_RE = /^(datasheet|design_rule|assumed)\s*:\s*\S/;
export const SOURCE_KINDS = ['datasheet', 'design_rule', 'assumed'];

/**
 * A sourced value: `{ value: <finite number>, source: "<kind>: <text>" }`.
 * Returns `{ ok: true, value, source, kind }` or `{ ok: false, why }`.
 */
export function readSourced(field, name, { positive = false } = {}) {
  if (field === undefined || field === null) return { ok: false, why: `${name} is not given` };
  if (typeof field !== 'object' || Array.isArray(field)) {
    return { ok: false, why: `${name} must be { value, source }, got ${JSON.stringify(field)}` };
  }
  const { value, source } = field;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, why: `${name} has no finite numeric value` };
  }
  if (positive && !(value > 0)) return { ok: false, why: `${name} must be > 0, got ${value}` };
  if (typeof source !== 'string' || !SOURCE_RE.test(source.trim())) {
    return {
      ok: false,
      why: `${name} = ${value} has no source; a value must say "datasheet: ...", "design_rule: ..." or "assumed: ..." to be used`,
    };
  }
  const kind = /^(\w+)/.exec(source.trim())[1];
  return { ok: true, value, source: source.trim(), kind };
}

/**
 * Look up everything the model knows about one component. Never throws; every
 * gap is reported as text so it can become a `no_material_data` reason.
 *
 * Accepted fields per component (all optional, all sourced):
 *   rth_c_per_w        single body-to-ambient thermal resistance, K/W
 *   rth_chain          [{ name, value, source }, ...], summed in series, K/W
 *   cth_j_per_k        thermal capacitance, J/K
 *   t_max_c            maximum allowed temperature, degC (the `rated` T bound)
 *   p_max_w            power rating, W (the `rated` P bound)
 *   ambient_c          overrides the model-level ambient_c
 *
 * @param {object|null|undefined} model
 * @param {string} refdes
 */
export function componentThermal(model, refdes) {
  const out = { refdes, known: false, rth: null, cth: null, tMax: null, pMax: null, ambient: null, problems: [] };
  if (!model || typeof model !== 'object') {
    out.problems.push('no thermal model was supplied for this design');
    return out;
  }
  const comps = model.components && typeof model.components === 'object' ? model.components : {};
  const key = Object.keys(comps).find(k => k.toLowerCase() === String(refdes).toLowerCase());
  if (!key) {
    out.problems.push(`the thermal model has no entry for ${refdes}`);
    return out;
  }
  out.known = true;
  const c = comps[key] ?? {};

  // Rθ: exactly one of the two forms.
  if (c.rth_c_per_w !== undefined && c.rth_chain !== undefined) {
    out.problems.push(`${refdes} gives both rth_c_per_w and rth_chain; which one is meant is ambiguous`);
  } else if (c.rth_chain !== undefined) {
    if (!Array.isArray(c.rth_chain) || c.rth_chain.length === 0) {
      out.problems.push(`${refdes}.rth_chain must be a non-empty list`);
    } else {
      const parts = c.rth_chain.map((p, i) => ({ name: p?.name ?? `rth${i + 1}`, r: readSourced(p, `${refdes}.rth_chain[${i}]`, { positive: true }) }));
      const bad = parts.filter(p => !p.r.ok);
      if (bad.length) out.problems.push(...bad.map(p => p.r.why));
      else {
        out.rth = {
          value: parts.reduce((s, p) => s + p.r.value, 0),
          chain: parts.map(p => ({ name: String(p.name), value: p.r.value, source: p.r.source })),
          source: parts.map(p => `${p.name}: ${p.r.source}`).join('; '),
        };
      }
    }
  } else {
    const r = readSourced(c.rth_c_per_w, `${refdes}.rth_c_per_w`, { positive: true });
    if (r.ok) out.rth = { value: r.value, chain: null, source: r.source };
    else out.problems.push(r.why);
  }

  const cth = readSourced(c.cth_j_per_k, `${refdes}.cth_j_per_k`, { positive: true });
  if (cth.ok) out.cth = { value: cth.value, source: cth.source };
  else if (c.cth_j_per_k !== undefined) out.problems.push(cth.why);

  const tMax = readSourced(c.t_max_c, `${refdes}.t_max_c`);
  if (tMax.ok) out.tMax = { value: tMax.value, source: tMax.source };
  else if (c.t_max_c !== undefined) out.problems.push(tMax.why);

  const pMax = readSourced(c.p_max_w, `${refdes}.p_max_w`, { positive: true });
  if (pMax.ok) out.pMax = { value: pMax.value, source: pMax.source };
  else if (c.p_max_w !== undefined) out.problems.push(pMax.why);

  const amb = readSourced(c.ambient_c ?? model.ambient_c, c.ambient_c !== undefined ? `${refdes}.ambient_c` : 'ambient_c');
  if (amb.ok) out.ambient = { value: amb.value, source: amb.source };
  else out.problems.push(amb.why);

  return out;
}

/* -------------------------------------------------------------------------- */
/* The physics. Pure functions; the tests check them against hand working.    */
/* -------------------------------------------------------------------------- */

/** Resistor dissipation from a measured current: P = I²R. Sign of I is irrelevant. */
export const powerI2R = (current, resistance) => current * current * resistance;

/** Steady-state rise: ΔT = P · Rθ. */
export const steadyRise = (power, rth) => power * rth;

/** Steady-state temperature: T = Ta + P · Rθ. */
export const steadyTemperature = (ambient, power, rth) => ambient + power * rth;

/** Time constant of the single node: τ = Rθ · Cθ. */
export const timeConstant = (rth, cth) => rth * cth;

/** First-order step response from ambient: T(t) = Ta + P·Rθ·(1 − e^(−t/τ)). */
export function transientTemperature(ambient, power, rth, cth, t) {
  if (t <= 0) return ambient;
  const tau = timeConstant(rth, cth);
  return ambient + power * rth * (1 - Math.exp(-t / tau));
}
