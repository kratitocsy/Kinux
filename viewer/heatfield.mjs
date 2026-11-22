// The board's temperature field, as CalculiX solved it (engine/board-heat.mjs).
//
// The pixels are the solver's own nodal temperatures, one per grid node of the
// finest converged mesh; the browser's image smoothing interpolates between
// neighbouring nodes, which is what the hex elements do too (trilinear). A
// field that did not converge, or could not be computed, is never drawn: its
// reason is shown instead.

import { el } from './dom.mjs';

/** Blue → cyan → green → yellow → red, the usual thermal ramp. f in 0..1. */
export function thermalRamp(f) {
  const x = Math.min(1, Math.max(0, f));
  const stops = [[0, [30, 60, 200]], [0.25, [0, 170, 230]], [0.5, [40, 200, 90]], [0.75, [250, 210, 30]], [1, [230, 40, 30]]];
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i++;
  const [a, ca] = stops[i], [b, cb] = stops[i + 1];
  const t = (x - a) / (b - a);
  return ca.map((c, k) => Math.round(c + (cb[k] - c) * t));
}

/** The artifact record of the heat field in a run, or null. */
export const heatArtifact = state => (state.artifacts ?? []).find(a => a.test_id === 'design' && a.kind === 'thermal_field') ?? null;

/** Min and max over both faces. */
export function fieldRange(field) {
  let min = Infinity, max = -Infinity;
  for (const v of field.grid.top) { if (v < min) min = v; if (v > max) max = v; }
  for (const v of field.grid.bottom) { if (v < min) min = v; if (v > max) max = v; }
  return { min, max };
}

/** One face as a canvas, one pixel per node, row 0 at the board's smallest y. */
export function fieldCanvas(field, face = 'top', range = fieldRange(field), alpha = 255) {
  const { nx, ny } = field.grid;
  const values = field.grid[face];
  const canvas = document.createElement('canvas');
  canvas.width = nx; canvas.height = ny;
  const g = canvas.getContext('2d');
  const img = g.createImageData(nx, ny);
  const span = range.max - range.min || 1;
  for (let k = 0; k < values.length; k++) {
    const [r, gg, b] = thermalRamp((values[k] - range.min) / span);
    img.data.set([r, gg, b, alpha], k * 4);
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

/** A vertical colour bar with its end temperatures. */
export function colourBar(range) {
  const stops = [0, 0.25, 0.5, 0.75, 1].map(f => `rgb(${thermalRamp(f).join(',')}) ${100 - f * 100}%`).reverse();
  return el('div', { class: 'hf-bar', 'data-testid': 'hf-colour-bar' }, [
    el('span', { class: 'hf-bar-label', text: `${range.max.toFixed(1)} °C` }),
    el('div', { class: 'hf-bar-ramp', style: `background:linear-gradient(to top, ${stops.join(', ')})` }),
    el('span', { class: 'hf-bar-label', text: `${range.min.toFixed(1)} °C` }),
  ]);
}

/** The hottest parts, hottest first, from the solved field. */
export function hottestParts(field, n = 4) {
  return Object.entries(field.parts ?? {}).sort((a, b) => b[1].peak_c - a[1].peak_c).slice(0, n)
    .map(([ref, p]) => ({ ref, peak_c: p.peak_c, watts: p.watts, side: p.side }));
}

/** What the field is and what went into it, every input with its source. */
export function fieldNotes(field) {
  const st = field.study ?? {};
  const levels = st.levels ?? [];
  const inputs = Object.entries(field.inputs ?? {}).filter(([, v]) => v && typeof v === 'object' && 'value' in v);
  const bal = field.power_source?.balance;
  return el('details', { class: 'hf-notes', 'data-testid': 'hf-notes' }, [
    el('summary', { text: field.drawn
      ? `Temperature field: CalculiX ${field.solver?.calculix ?? ''}, converged over ${levels.length} grids (finest ${levels.at(-1)?.elements ?? '?'} elements); power from ngspice. What went in ▸`
      : `No temperature field drawn: ${field.verdict} ${field.reason_code}. ▸` }),
    field.drawn ? null : el('p', { class: 'hf-why', text: field.reason }),
    el('p', { class: 'muted', text: `Model: ${field.model}` }),
    levels.length ? el('p', { class: 'muted', text: `Peak rise per grid (K): ${(st.values ?? []).map(v => v.toFixed(3)).join(' → ')}; ${st.convergence?.why ?? ''}` }) : null,
    bal ? el('p', { class: 'muted', text: `Power (${field.power_source.analysis}, check block ${field.block}): ${(field.total_w ?? 0).toFixed(4)} W placed on the board; the block's sources deliver ${bal.delivered_w.toFixed(4)} W and the parts absorb ${bal.absorbed_w.toFixed(4)} W.` }) : null,
    field.unplaced?.length ? el('p', { class: 'muted', text: `Power with no footprint to put it on: ${field.unplaced.map(u => `${u.ref} ${(u.watts * 1000).toFixed(2)} mW`).join(', ')}` }) : null,
    el('table', { class: 'hf-inputs' }, inputs.map(([k, v]) => el('tr', {}, [
      el('td', { text: k }), el('td', { text: String(v.value) }), el('td', { class: /^assumed/i.test(v.source) ? 'hf-assumed' : '', text: v.source }),
    ]))),
  ]);
}
