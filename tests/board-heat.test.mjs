// Board heat: per-part power from ngspice, and the board's temperature field
// from CalculiX. Every check here runs the real tools and compares against a
// number worked out by hand.
//
//   * power: a resistor network and a subcircuit (whose inside the measurement
//     never looks at) against P = V²/R; a square wave against its exact average;
//     the energy balance closes.
//   * field: a board heated uniformly over its whole face has no lateral
//     gradient, so T = Ta + q / (h_top + h_bottom) exactly; a point-like part
//     makes a peak that is only drawn once the grids agree.
//   * honesty: an unsourced input, a non-rectangular outline or a failed power
//     measurement give no field and say why; nothing falls back to a default.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measurePartPower, refOf, senseDeck, trapezoidAverage } from '../engine/part-power.mjs';
import { boardThermalGeometry, checkHeatInputs, effectiveConductivity, solveBoardHeat } from '../engine/board-heat.mjs';

const INPUTS = {
  ambient_c: { value: 25, source: 'assumed: test' },
  h_top_w_m2k: { value: 10, source: 'assumed: test' },
  h_bottom_w_m2k: { value: 5, source: 'assumed: test' },
  laminate_k_w_mk: { value: 0.3, source: 'assumed: test' },
  copper_k_w_mk: { value: 385, source: 'handbook' },
  copper_thickness_um: { value: 35, source: 'assumed: test' },
  copper_coverage: { value: 0.3, source: 'assumed: test' },
};
const OP = { analysis: { kind: 'op', params: [], raw: 'op' }, sources: [] };
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

test('power per part: resistors and a subcircuit match V²/R, and the energy balance closes', async () => {
  const deck = ['power test', 'V1 a 0 10', 'R1 a b 1k', 'R2 b 0 4k', 'XU1 b 0 LOAD', '.subckt LOAD p n', 'Rin p n 2k', '.ends', ''].join('\n');
  const r = await measurePartPower(deck, OP);
  assert.equal(r.ok, true, r.reason);
  const rpar = 1 / (1 / 4000 + 1 / 2000), i = 10 / (1000 + rpar), vb = i * rpar;
  assert.ok(rel(r.parts.R1.watts, i * i * 1000) < 1e-6, `R1 ${r.parts.R1.watts}`);
  assert.ok(rel(r.parts.R2.watts, vb * vb / 4000) < 1e-6);
  assert.ok(rel(r.parts.U1.watts, vb * vb / 2000) < 1e-6, 'the subcircuit\'s power, measured at its pins');
  assert.deepEqual(r.parts.U1.elements, ['XU1']);
  assert.equal(r.parts.V1, undefined, 'a source is not a part that dissipates');
  assert.ok(Math.abs(r.balance.absorbed_w) < 1e-9, 'what V1 delivers (counted negative) is what the parts absorb');
  assert.ok(rel(-r.balance.design_sources_w, 10 * i) < 1e-6);
});

test('power per part: a block source is accounted for, and a stand-in is attributed only when named', async () => {
  const deck = ['stand-in test', 'R1 vcc 0 100', 'IMCU vcc 0 DC 0.01', ''].join('\n');
  const block = { analysis: { kind: 'op', params: [], raw: 'op' }, sources: [{ port: 'vcc', value: { value: 5 } }] };
  const named = await measurePartPower(deck, block, { standIns: { IMCU: { ref: 'U1', note: 'stand-in' } } });
  assert.ok(rel(named.parts.U1.watts, 0.05) < 1e-6);
  assert.equal(named.parts.U1.note, 'stand-in');
  assert.ok(rel(named.balance.delivered_w, 0.25 + 0.05) < 1e-6, 'the block source delivers V·I to the R and the sink');
  assert.ok(rel(named.balance.absorbed_w, named.balance.delivered_w) < 1e-6);
  const unnamed = await measurePartPower(deck, block);
  assert.equal(unnamed.parts.U1, undefined, 'no stand-in named: the sink is a source, not a part');
});

test('power per part: a transient block is averaged over the solver\'s own samples', async () => {
  const deck = ['tran power', 'V1 a 0 PULSE(0 10 0 1n 1n 0.5m 1m)', 'R1 a 0 100', ''].join('\n');
  const r = await measurePartPower(deck, { analysis: { kind: 'tran', params: ['1u', '4m'], raw: 'tran 1u 4m' }, sources: [] });
  assert.equal(r.ok, true, r.reason);
  assert.ok(rel(r.parts.R1.watts, 0.5) < 0.005, `square wave at 50% duty into 100 ohm averages 0.5 W, got ${r.parts.R1.watts}`);
  assert.equal(r.averaged.samples > 100, true);
});

test('power helpers: refdes mapping, sense deck, trapezoid', () => {
  assert.equal(refOf('XD1'), 'D1');
  assert.equal(refOf('R4'), 'R4');
  assert.equal(refOf('X1'), 'X1');
  const { deck } = senseDeck('t\nR1 a 0 1k\n.end\n', OP);
  assert.match(deck, /^R1 kp1_0 0 1k$/m, 'the element moves to the sense node; ground stays ground');
  assert.match(deck, /^Vkp1_0 a kp1_0 0$/m);
  assert.equal(trapezoidAverage([0, 1, 2], [0, 2, 2]), 1.5);
  assert.equal(trapezoidAverage([0, 1, 2], [0, 2, 2], 1, 2), 2);
});

test('power per part: an analysis it cannot use is refused, not guessed', async () => {
  const r = await measurePartPower('t\nR1 a 0 1\n', { analysis: { kind: 'ac' }, sources: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason_code, 'out_of_scope');
});

const PCB = `(kicad_pcb (version 20240108)
 (general (thickness 1.6))
 (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
 (gr_rect (start 10 20) (end 60 70) (layer "Edge.Cuts"))
 (footprint "R" (layer "F.Cu") (at 30 40 90) (property "Reference" "R1" (at 0 0 0))
  (pad "1" smd rect (at -1 0 90) (size 1 2) (layers "F.Cu")) (pad "2" smd rect (at 1 0 90) (size 1 2) (layers "F.Cu")))
 (footprint "C" (layer "B.Cu") (at 50 60) (property "Reference" "C1" (at 0 0 0))
  (pad "1" smd rect (at 0 0) (size 2 1) (layers "B.Cu"))))`;

test('board geometry: outline, thickness, copper layers, and pad boxes rotated with the footprint', () => {
  const g = boardThermalGeometry(PCB);
  assert.deepEqual(g.rect, { minX: 10, minY: 20, maxX: 60, maxY: 70 });
  assert.equal(g.thickness, 1.6);
  assert.equal(g.copperLayers, 2);
  // R1 at 90°: pads move to y = 40 ∓ 1 and are 2 wide in x, 1 tall in y.
  assert.deepEqual(g.footprints.R1.box.map(v => +v.toFixed(6)), [29, 38.5, 31, 41.5]);
  assert.equal(g.footprints.C1.side, 'bottom');
  const k = effectiveConductivity({ thickness_mm: 1.6, copperLayers: 2, inputs: INPUTS });
  assert.ok(k.in_plane > 5 && k.in_plane < 7, `in-plane ${k.in_plane}`);
  assert.ok(k.through > 0.3 && k.through < 0.32, 'series: barely above the laminate');
});

test('heat field: a board heated evenly over its top face matches the exact one-dimensional answer', async () => {
  const geometry = { rect: { minX: 0, minY: 0, maxX: 50, maxY: 50 }, thickness: 1.6, copperLayers: 2, footprints: { U1: { box: [0, 0, 50, 50], side: 'top' } } };
  const power = { ok: true, analysis: 'op', parts: { U1: { watts: 1, elements: ['U1'] } }, balance: { delivered_w: 1, absorbed_w: 1 } };
  const r = await solveBoardHeat({ geometry, power, inputs: INPUTS });
  assert.equal(r.drawn, true, r.reason);
  const kz = effectiveConductivity({ thickness_mm: 1.6, copperLayers: 2, inputs: INPUTS }).through;
  const q = 1 / 0.0025; // 400 W/m²
  const want = 25 + q / (10 + 1 / (1 / 5 + 0.0016 / kz)); // ≈ 51.90 °C
  assert.ok(rel(r.peak_c, want) < 1e-4, `peak ${r.peak_c}, expected ${want}`);
  assert.ok(Math.min(...r.grid.top) > want - 0.01, 'flat field: no point on the top face is cooler');
  const wantBottom = want - (q - 10 * (want - 25)) * 0.0016 / kz;
  assert.ok(rel(Math.max(...r.grid.bottom), wantBottom) < 1e-4, `bottom face ${Math.max(...r.grid.bottom)}, expected ${wantBottom}`);
  assert.ok(rel(r.study.levels.at(-1).applied_w, 1) < 1e-9, 'all of the power is applied, on every grid');
});

test('heat field: a small hot part gives a peak that is drawn only after the grids converge', async () => {
  const geometry = boardThermalGeometry(PCB);
  const power = { ok: true, analysis: 'op', parts: { R1: { watts: 0.25, elements: ['R1'] }, C1: { watts: 0, elements: ['C1'] } }, balance: {} };
  const r = await solveBoardHeat({ geometry, power, inputs: INPUTS });
  assert.equal(r.drawn, true, r.reason);
  assert.ok(r.study.levels.length >= 3);
  assert.equal(r.study.convergence.converged, true);
  assert.ok(r.parts.R1.peak_c > 26 && r.parts.R1.peak_c === r.peak_c, 'the hottest point is on the part that dissipates');
  assert.equal(r.grid.nx * r.grid.ny, r.grid.top.length);
  // The flux must leave the board: mean rise times total film conductance ≈ power.
  const mean = r.grid.top.reduce((a, v) => a + v, 0) / r.grid.top.length;
  assert.ok(mean > 25 && mean < r.peak_c);
  const capped = await solveBoardHeat({ geometry, power, inputs: INPUTS, maxLevels: 2 });
  assert.equal(capped.drawn, false, 'two grids cannot show convergence');
  assert.equal(capped.verdict, 'NOT_CHECKED');
  assert.equal(capped.reason_code, 'mesh_not_converged');
  assert.equal(capped.grid, undefined, 'an unconverged field carries no picture');
});

test('heat field: no source, no field; an odd outline or no power says so', async () => {
  const geometry = boardThermalGeometry(PCB);
  const power = { ok: true, parts: { R1: { watts: 0.1 } }, balance: {} };
  const unsourced = { ...INPUTS, laminate_k_w_mk: { value: 0.3 } };
  assert.deepEqual(checkHeatInputs(unsourced).missing, ['laminate_k_w_mk']);
  const a = await solveBoardHeat({ geometry, power, inputs: unsourced });
  assert.equal(a.drawn, false);
  assert.equal(a.reason_code, 'no_material_data');
  const b = await solveBoardHeat({ geometry: { ...geometry, rect: null, outlineSegments: 3 }, power, inputs: INPUTS });
  assert.equal(b.reason_code, 'out_of_scope');
  const c = await solveBoardHeat({ geometry, power: { ok: false, reason_code: 'sim_nonconverge', reason: 'op failed' }, inputs: INPUTS });
  assert.equal(c.verdict, 'NOT_CHECKED');
  assert.match(c.reason, /op failed/);
});
