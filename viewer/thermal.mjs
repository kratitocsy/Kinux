// The thermal view: per-component temperatures from thermal checks, as a pure
// function of reducer state. No DOM, and deliberately no imports: the static
// export concatenates viewer modules into one scope, so this file must stand
// alone and its top-level names must not collide with any other module's.
//
// What this view is, and is not:
//   * It shows ONE number per component per check: what the thermal worker
//     computed, against the check's limit. That is what a lumped model gives.
//   * It is not a field. A lumped model has no spatial temperature, so this
//     view never draws a heat map and never interpolates between parts. The
//     design panel keeps its "thermal field" placeholder for exactly that.
//
// Convention it reads (agreed with the thermal worker, all within fields the
// frozen contract already declares):
//   test.queued   layer "thermal"; title is the assertion text, T(<part>) ... or P(<part>) ...
//   test.result   measured / limit numeric, units "°C" or "W", reason names the model

/** T(RSH) < 125 · P(RSH) < 2 · T(Q2) between 20 and 125 */
const THERMAL_TITLE_RE = /^\s*([TP])\(\s*([^()\s]+)\s*\)\s*(<=|>=|<|>|between)\s*(-?[0-9.]+(?:e-?\d+)?)\s*(?:and\s*(-?[0-9.]+(?:e-?\d+)?))?/i;

const THERMAL_PROVENANCE_RANK = { synthetic: 0, recorded: 1, real: 2 };

/** Parse a thermal check title. Returns null when it does not follow the convention. */
export function parseThermalTitle(title) {
  const m = THERMAL_TITLE_RE.exec(String(title ?? ''));
  if (!m) return null;
  const quantity = m[1].toUpperCase();
  const op = m[3].toLowerCase();
  const a = Number(m[4]);
  const b = m[5] !== undefined ? Number(m[5]) : null;
  if (op === 'between' && b === null) return null;
  return {
    quantity,                         // 'T' or 'P'
    component: m[2],
    op,                               // '<', '<=', '>', '>=', 'between'
    lo: op === 'between' ? Math.min(a, b) : (op === '>' || op === '>=' ? a : null),
    hi: op === 'between' ? Math.max(a, b) : (op === '<' || op === '<=' ? a : null),
  };
}

/**
 * Headroom left before the check would fail, in the check's own units. Positive
 * means inside the limit. Null when there is no number to measure from.
 */
export function thermalMargin(parsed, measured) {
  if (!parsed || typeof measured !== 'number' || !Number.isFinite(measured)) return null;
  if (parsed.op === 'between') return Math.min(measured - parsed.lo, parsed.hi - measured);
  if (parsed.hi !== null) return parsed.hi - measured;
  if (parsed.lo !== null) return measured - parsed.lo;
  return null;
}

function thermalResultView(parsed, r) {
  if (!r) return null;
  const numeric = typeof r.measured === 'number' && Number.isFinite(r.measured);
  // A NOT_CHECKED or ERROR result carries no number we may show, even if one
  // was sent: the check did not run, so any figure would read as a reading.
  const checked = r.verdict === 'PASS' || r.verdict === 'FAIL';
  return {
    verdict: r.verdict,
    measured: checked && numeric ? r.measured : null,
    units: r.units ?? null,
    margin: checked && numeric ? thermalMargin(parsed, r.measured) : null,
    reason_code: r.reason_code ?? null,
    reason: r.reason ?? null,
    provenance: r.provenance ?? null,
  };
}

/**
 * Build the thermal view, or return null when the run has no thermal checks
 * (the panel then keeps its "not wired" placeholder, which is the truth).
 *
 * @param {object} state      reducer state
 * @param {Set<string>} [selection]
 */
export function thermalView(state, selection = new Set()) {
  const tests = (state.testOrder ?? []).map(id => state.tests[id]).filter(t => t && t.layer === 'thermal');
  if (tests.length === 0) return null;

  const selectedMutant = (state.mutantOrder ?? []).find(id => selection.has(id)) ?? null;
  const byComponent = new Map();
  const unparsed = [];
  const models = new Set();
  let unstatedModel = 0;
  let weakest = null;

  for (const t of tests) {
    for (const subject of t.subjectOrder ?? []) {
      const r = t.results[subject];
      if (!r) continue;
      if (r.provenance && (weakest === null || THERMAL_PROVENANCE_RANK[r.provenance] < THERMAL_PROVENANCE_RANK[weakest])) {
        weakest = r.provenance;
      }
      if (r.verdict === 'PASS' || r.verdict === 'FAIL') {
        if (r.reason) models.add(r.reason); else unstatedModel += 1;
      }
    }

    const parsed = parseThermalTitle(t.title);
    if (!parsed) {
      // Never dropped: a check the view cannot attribute to a part is still a
      // check, and hiding it would understate what ran.
      unparsed.push({ test_id: t.test_id, title: t.title, baseline: thermalResultView(null, t.results.baseline) });
      continue;
    }

    const row = {
      test_id: t.test_id,
      title: t.title,
      quantity: parsed.quantity,
      op: parsed.op,
      lo: parsed.lo,
      hi: parsed.hi,
      baseline: thermalResultView(parsed, t.results.baseline),
      selected: selectedMutant ? thermalResultView(parsed, t.results[selectedMutant]) : null,
    };
    if (row.baseline && row.selected && row.baseline.measured !== null && row.selected.measured !== null) {
      row.delta = row.selected.measured - row.baseline.measured;
    } else {
      row.delta = null;
    }

    if (!byComponent.has(parsed.component)) byComponent.set(parsed.component, { component: parsed.component, rows: [] });
    byComponent.get(parsed.component).rows.push(row);
  }

  // Temperature rows first within a component; components in first-seen order.
  const components = [...byComponent.values()];
  for (const c of components) c.rows.sort((a, b) => (a.quantity === 'T' ? 0 : 1) - (b.quantity === 'T' ? 0 : 1));

  return {
    components,
    unparsed,
    models: [...models],
    unstatedModel,
    provenance: weakest,
    selectedMutant,
    checks: tests.length,
  };
}
