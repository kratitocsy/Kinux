// Trace-current check (IPC-2221 conductor-sizing curves).
//
// FORMULA
//   I = k * dT^0.44 * A^0.725
// where
//   I  = maximum current, amperes
//   dT = allowed conductor temperature rise above ambient, degrees C
//   A  = conductor cross-section, square mils
//   k  = 0.048 for external (outer-layer) conductors
//        0.024 for internal conductors
// Source: IPC-2221 "Generic Standard on Printed Board Design", section 6.2,
// the standard algebraic fit to its conductor current/temperature-rise charts.
// The 2:1 derating of k for internal layers is the standard's own, and reflects
// the poorer heat path out of a buried conductor.
//
// ASSUMPTIONS (all of them are assumptions, none are measured from the board):
//   * Copper weight is 1 oz/ft^2 unless the caller says otherwise, which is
//     taken as 1.37 mil (34.8 um) of finished copper. Real finished thickness
//     varies with plating; this number is nominal.
//   * Default allowed temperature rise dT = 10 C.
//   * Cross-section = width x thickness. Etch taper, plating on the trace
//     sides and copper roughness are ignored, so the computed ampacity is
//     slightly optimistic for fine traces.
//   * Ambient temperature, nearby copper pours, thermal vias, airflow, the
//     adjacent-trace heating that IPC-2152 models, and any duty cycle are NOT
//     modelled. IPC-2221 is a single isolated conductor in still air.
//   * F.Cu and B.Cu are treated as external; every other *.Cu layer is
//     internal. Non-copper layers are not checked at all.
//   * The check is per segment. A net routed as several segments is as weak as
//     its narrowest segment; this reports each segment separately rather than
//     collapsing them.
//
// HONESTY RULE (non-negotiable): a net whose required current we were not told
// is NOT_CHECKED with a reason code. It is never a PASS. Not knowing the
// requirement is not evidence that the trace is wide enough.

/** IPC-2221 constants. */
export const K_EXTERNAL = 0.048;
export const K_INTERNAL = 0.024;
export const DT_EXPONENT = 0.44;
export const AREA_EXPONENT = 0.725;

/** 1 oz/ft^2 finished copper, nominal, in mils. */
export const OZ_COPPER_MILS = 1.37;
export const DEFAULT_COPPER_OZ = 1;
export const DEFAULT_DELTA_T_C = 10;

export const MM_PER_MIL = 0.0254;
export const mmToMils = mm => mm / MM_PER_MIL;

/** Layers treated as external (outer) copper. */
const EXTERNAL_LAYERS = new Set(['F.Cu', 'B.Cu']);

/**
 * Classify a KiCad layer name.
 * @returns {'external'|'internal'|'non_copper'}
 */
export function layerClass(layer) {
  if (typeof layer !== 'string') return 'non_copper';
  if (EXTERNAL_LAYERS.has(layer)) return 'external';
  if (layer.endsWith('.Cu')) return 'internal';
  return 'non_copper';
}

/**
 * Maximum current for a conductor, per IPC-2221.
 *
 * @param {object} o
 * @param {number} o.width_mm   trace width in millimetres
 * @param {number} [o.deltaT_c] allowed temperature rise, default 10 C
 * @param {boolean} o.external  true for an outer-layer conductor
 * @param {number} [o.copper_oz] copper weight in oz/ft^2, default 1
 * @returns {{ampacity_a:number, area_mil2:number, k:number, thickness_mil:number, deltaT_c:number}}
 */
export function ipc2221Ampacity({ width_mm, deltaT_c = DEFAULT_DELTA_T_C, external, copper_oz = DEFAULT_COPPER_OZ }) {
  if (!(Number.isFinite(width_mm) && width_mm > 0)) throw new RangeError(`width_mm must be a positive number, got ${width_mm}`);
  if (!(Number.isFinite(deltaT_c) && deltaT_c > 0)) throw new RangeError(`deltaT_c must be a positive number, got ${deltaT_c}`);
  if (!(Number.isFinite(copper_oz) && copper_oz > 0)) throw new RangeError(`copper_oz must be a positive number, got ${copper_oz}`);

  const thickness_mil = copper_oz * OZ_COPPER_MILS;
  const area_mil2 = mmToMils(width_mm) * thickness_mil;
  const k = external ? K_EXTERNAL : K_INTERNAL;
  const ampacity_a = k * Math.pow(deltaT_c, DT_EXPONENT) * Math.pow(area_mil2, AREA_EXPONENT);
  return { ampacity_a, area_mil2, k, thickness_mil, deltaT_c };
}

/** Inverse of the above: the narrowest trace that carries `current_a`. Handy for advice, not a verdict. */
export function ipc2221MinWidthMm({ current_a, deltaT_c = DEFAULT_DELTA_T_C, external, copper_oz = DEFAULT_COPPER_OZ }) {
  const k = external ? K_EXTERNAL : K_INTERNAL;
  const area_mil2 = Math.pow(current_a / (k * Math.pow(deltaT_c, DT_EXPONENT)), 1 / AREA_EXPONENT);
  return area_mil2 / (copper_oz * OZ_COPPER_MILS) * MM_PER_MIL;
}

// Reason codes: contracts/event.schema.json freezes the `reason_code` enum for
// v1 and it has no trace-current entries, so each result carries the nearest
// legal enum value in `reason_code` plus an exact `detail_code` beside it.
// See workers/pcb/README.md.
const NOT_CHECKED = (detail_code, reason, reason_code = 'no_model') => ({
  verdict: 'NOT_CHECKED', reason_code, detail_code, reason,
});

/**
 * Check every copper segment of a parsed board against per-net current requirements.
 *
 * @param {object} board              result of parsePcb()
 * @param {object} o
 * @param {Record<string, number>} [o.net_currents_a] net NAME -> required current in amps
 * @param {Record<number, number>}  [o.net_currents_a_by_number] net NUMBER -> required current in amps
 * @param {number} [o.deltaT_c]      allowed temperature rise, default 10 C
 * @param {number} [o.copper_oz]     copper weight, default 1 oz
 * @returns {{deltaT_c:number, copper_oz:number, thickness_mil:number, segments:Array<object>, summary:object}}
 */
export function checkTraceCurrent(board, {
  net_currents_a = {},
  net_currents_a_by_number = {},
  deltaT_c = DEFAULT_DELTA_T_C,
  copper_oz = DEFAULT_COPPER_OZ,
} = {}) {
  const results = [];

  for (const seg of board.segments ?? []) {
    const cls = layerClass(seg.layer);
    const base = {
      segment_index: seg.index,
      net: seg.net,
      net_name: seg.net_name ?? '',
      layer: seg.layer,
      layer_class: cls,
      width_mm: seg.width_mm,
      length_mm: seg.length_mm,
      units: 'A',
    };

    if (cls === 'non_copper') {
      results.push({ ...base, ...NOT_CHECKED('not_a_copper_layer',
        `segment is on layer ${seg.layer}, which is not copper, so IPC-2221 does not apply`, 'out_of_scope') });
      continue;
    }

    const required = net_currents_a_by_number[seg.net] ?? net_currents_a[seg.net_name ?? ''];
    if (required === undefined || required === null) {
      const who = seg.net_name ? `net "${seg.net_name}"` : `net ${seg.net} (unnamed)`;
      results.push({ ...base, ...NOT_CHECKED('no_current_requirement',
        `no required current was declared for ${who}; without it there is nothing to compare the trace against`) });
      continue;
    }
    if (!(Number.isFinite(required) && required > 0)) {
      results.push({ ...base, ...NOT_CHECKED('bad_current_requirement',
        `the required current declared for net "${seg.net_name}" is ${required}, which is not a positive number`) });
      continue;
    }
    if (!(Number.isFinite(seg.width_mm) && seg.width_mm > 0)) {
      results.push({ ...base, ...NOT_CHECKED('bad_trace_width',
        `segment width is ${seg.width_mm}, which is not a positive number`, 'tool_error') });
      continue;
    }

    const m = ipc2221Ampacity({ width_mm: seg.width_mm, deltaT_c, external: cls === 'external', copper_oz });
    const pass = m.ampacity_a >= required;
    results.push({
      ...base,
      verdict: pass ? 'PASS' : 'FAIL',
      measured: m.ampacity_a,
      limit: required,
      area_mil2: m.area_mil2,
      k: m.k,
      deltaT_c: m.deltaT_c,
      copper_oz,
      thickness_mil: m.thickness_mil,
      min_width_mm: ipc2221MinWidthMm({ current_a: required, deltaT_c, external: cls === 'external', copper_oz }),
      reason: pass
        ? `IPC-2221 ampacity ${m.ampacity_a.toFixed(3)} A at dT=${deltaT_c} C is at or above the required ${required} A`
        : `IPC-2221 ampacity ${m.ampacity_a.toFixed(3)} A at dT=${deltaT_c} C is below the required ${required} A`,
    });
  }

  const count = v => results.filter(r => r.verdict === v).length;
  return {
    check: 'trace_current_ipc2221',
    deltaT_c,
    copper_oz,
    thickness_mil: copper_oz * OZ_COPPER_MILS,
    segments: results,
    summary: {
      total: results.length,
      pass: count('PASS'),
      fail: count('FAIL'),
      not_checked: count('NOT_CHECKED'),
      error: count('ERROR'),
    },
  };
}
