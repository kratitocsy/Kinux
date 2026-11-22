// Panel 2 — the design / physics view.
//
// Honesty rules for this panel, in force until the solvers land:
//   * There is no 3D viewer, no thermal field and no FEA in this build.
//     Those are Phase D-E. We do not draw them, not even as decoration.
//   * What we DO have is the design identity carried by the events, the
//     artifact inventory (with hashes), and the list of design elements the
//     run actually touched. Those are rendered.
//   * Per-component temperatures, when a run carries thermal checks (layer
//     "thermal"): one number per part, as the lumped model computes it, with
//     the model named beside it. Still no FIELD: nothing between parts is drawn.
//   * Everything else is a labelled placeholder that says what is missing.

import { el, panelShell, section, kv, placeholder, shortHash } from '../dom.mjs';
import { renderBoardViews } from './board.mjs';
import { badgeFor } from '../reducer.mjs';
import { thermalView } from '../thermal.mjs';

const THERMAL_VERDICT_CLASS = { PASS: 'ok', FAIL: 'bad', NOT_CHECKED: 'unknown', ERROR: 'unknown' };
const THERMAL_VERDICT_TEXT = { PASS: 'PASS', FAIL: 'FAIL', NOT_CHECKED: 'NOT CHECKED', ERROR: 'ERROR' };

function thermalFmt(x, units) {
  if (x === null || x === undefined) return '—';
  const digits = units === 'W' ? 2 : 1;
  return `${x.toFixed(digits)} ${units ?? ''}`.trim();
}

function thermalLimitText(row, units) {
  const u = units ?? '';
  if (row.op === 'between') return `between ${row.lo} and ${row.hi} ${u}`.trim();
  return `${row.op} ${row.hi ?? row.lo} ${u}`.trim();
}

/** One line of a thermal card: baseline, and the selected mutant if any. */
function thermalRow(row) {
  const b = row.baseline;
  const units = b?.units ?? row.selected?.units ?? (row.quantity === 'T' ? '°C' : 'W');
  const label = row.quantity === 'T' ? 'Temperature' : 'Power';

  const verdictChip = r => el('span', {
    class: `chip chip-${THERMAL_VERDICT_CLASS[r.verdict] ?? 'unknown'}`,
    'data-verdict': r.verdict,
    text: THERMAL_VERDICT_TEXT[r.verdict] ?? r.verdict,
  });

  const value = r => (r.measured === null
    // No number for a check that did not run: say why instead.
    ? el('span', { class: 'thermal-unchecked', text: `not checked — ${r.reason ?? r.reason_code ?? 'no reason given'}` })
    : el('span', { class: 'thermal-value', text: thermalFmt(r.measured, units) }));

  const parts = [
    el('div', { class: 'thermal-q', text: label }),
    el('div', { class: 'thermal-line', 'data-testid': 'thermal-baseline' }, b ? [
      el('span', { class: 'thermal-who', text: 'baseline' }),
      value(b),
      verdictChip(b),
    ] : [el('span', { class: 'muted', text: 'no baseline result' })]),
    el('div', { class: 'thermal-meta', text:
      `limit ${thermalLimitText(row, units)}` + (b && b.margin !== null ? ` · margin ${thermalFmt(b.margin, units)}` : '') }),
  ];

  if (row.selected) {
    const s = row.selected;
    parts.push(el('div', { class: 'thermal-line thermal-mutant', 'data-testid': 'thermal-selected' }, [
      el('span', { class: 'thermal-who', text: 'selected mutant' }),
      value(s),
      verdictChip(s),
      row.delta !== null
        ? el('span', { class: 'thermal-delta', text: `${row.delta >= 0 ? '+' : '−'}${thermalFmt(Math.abs(row.delta), units)}` })
        : null,
    ]));
  }
  return el('div', { class: 'thermal-row', 'data-test': row.test_id, 'data-quantity': row.quantity }, parts);
}

/** The per-component thermal section. Never a map, never interpolated. */
function renderThermalSection(view, ctx, selection) {
  const kids = [];

  kids.push(el('p', { class: 'thermal-model', 'data-testid': 'thermal-model' }, [
    el('strong', { text: 'Model: ' }),
    view.models.length ? view.models.join('; ') : 'not stated by the solver',
    '. One number per part from a lumped model — there is no spatial temperature field, no conduction between parts, and nothing is interpolated.',
  ]));
  if (view.unstatedModel > 0) {
    kids.push(el('p', { class: 'thermal-warn', text: `${view.unstatedModel} thermal result(s) did not state their model.` }));
  }
  if (view.provenance && view.provenance !== 'real') {
    kids.push(el('p', { class: 'prov-notice', 'data-testid': 'thermal-prov-notice',
      text: `These temperatures are ${view.provenance}, not computed from a solver run.` }));
  }
  if (view.selectedMutant) {
    kids.push(el('p', { class: 'muted', text: `Showing baseline and mutant ${view.selectedMutant}.` }));
  }

  const grid = el('div', { class: 'thermal-grid', 'data-testid': 'thermal-grid' });
  for (const c of view.components) {
    const worst = c.rows.some(r => r.baseline?.verdict === 'FAIL' || r.selected?.verdict === 'FAIL') ? 'bad'
      : c.rows.some(r => r.baseline?.verdict === 'PASS') ? 'ok' : 'unknown';
    const hit = selection.has(c.component);
    grid.appendChild(el('div', {
      class: `thermal-card thermal-${worst}${hit ? ' selected' : ''}`,
      'data-testid': 'thermal-card',
      'data-component': c.component,
      'data-selected': hit ? 'true' : 'false',
      role: 'button',
      tabindex: '0',
      onclick: () => ctx.onSelect && ctx.onSelect(c.component),
    }, [
      el('div', { class: 'thermal-name', text: c.component }),
      ...c.rows.map(thermalRow),
    ]));
  }
  kids.push(grid);

  if (view.unparsed.length) {
    kids.push(el('div', { class: 'thermal-unparsed', 'data-testid': 'thermal-unparsed' }, [
      el('p', { class: 'muted', text: 'Thermal checks whose title does not name a part — listed, not dropped:' }),
      el('ul', {}, view.unparsed.map(u => el('li', {}, [
        el('code', { text: u.title ?? u.test_id }),
        u.baseline ? ` — ${THERMAL_VERDICT_TEXT[u.baseline.verdict] ?? u.baseline.verdict}` : '',
      ]))),
    ]));
  }

  const badge = view.provenance
    ? el('span', { class: `prov prov-${view.provenance} prov-compact`, 'data-testid': 'thermal-provenance', 'data-provenance': view.provenance },
      [el('span', { class: 'prov-label', text: view.provenance.toUpperCase() })])
    : null;
  return section(`Thermal — per component (${view.checks} check${view.checks === 1 ? '' : 's'})`,
    [badge, ...kids], { 'data-testid': 'thermal-section' });
}

const DESIGN_ARTIFACT_KINDS = ['schematic_svg', 'pcb_svg', 'mesh_glb', 'thermal_field', 'stress_field', 'mj_trajectory'];

const STATUS_CLASS = {
  killed: 'ok',
  survived: 'bad',
  not_checked: 'unknown',
  equivalent: 'neutral',
  error: 'unknown',
};

export function renderDesignPanel(state, ctx = {}) {
  const selection = ctx.selection instanceof Set ? ctx.selection : new Set();
  const badge = badgeFor(state, 'design');
  const { root, body } = panelShell({
    index: 2,
    title: 'Design view',
    subtitle: 'What the run says about the design. No geometry solver is connected in this build.',
    badge,
    panel: 'design',
  });

  body.appendChild(section('Design under test', kv([
    ['Project', state.run.project],
    ['Domain', state.run.domain],
    ['Run id', state.run.run_id],
    ['Source', state.run.source],
    ['Design hash', shortHash(state.run.design_hash)],
    ['Design ref', state.run.design_artifact_ref],
    ['Tools', Object.entries(state.run.tool_versions).map(([k, v]) => `${k} ${v}`).join(', ')],
    ['Status', state.run.finished ? state.run.finished.status : 'in progress'],
  ])));

  // The design itself, as KiCad drew it, when the run carries its views.
  const boardViews = renderBoardViews(state, ctx);
  if (boardViews) body.appendChild(boardViews);
  const has3d = state.artifacts.some(a => a.test_id === 'design' && a.kind === 'mesh_glb');

  // Design elements the run actually touched. These are target strings from
  // mutation.result and fault.propose events — names, not a layout.
  const elements = new Map();
  for (const id of state.mutantOrder) {
    const m = state.mutants[id];
    if (!elements.has(m.target)) elements.set(m.target, []);
    elements.get(m.target).push(m);
  }
  for (const f of Object.values(state.faults)) {
    if (f.target && !elements.has(f.target)) elements.set(f.target, []);
  }

  const grid = el('div', { class: 'element-grid', 'data-testid': 'element-grid' });
  if (elements.size === 0) {
    grid.appendChild(el('p', { class: 'muted', text: 'No design elements have been named by any event in this run.' }));
  }
  for (const [target, mutants] of elements) {
    const hit = selection.has(target) || mutants.some(m => selection.has(m.mutant_id));
    const worst = mutants.find(m => m.status === 'survived') || mutants[0];
    grid.appendChild(el('button', {
      type: 'button',
      class: `element ${worst ? 'el-' + STATUS_CLASS[worst.status] : 'el-neutral'}${hit ? ' selected' : ''}`,
      'data-element': target,
      'data-selected': hit ? 'true' : 'false',
      'data-testid': 'design-element',
      title: mutants.map(m => `${m.mutant_id}: ${m.description} → ${m.status}`).join('\n') || target,
      onclick: () => ctx.onSelect && ctx.onSelect(target),
    }, [
      el('span', { class: 'element-name', text: target }),
      el('span', { class: 'element-sub', text: mutants.length ? mutants.map(m => m.status).join(', ') : 'referenced' }),
    ]));
  }
  body.appendChild(section('Design elements named by this run', [
    el('p', { class: 'muted', text: 'Element names taken from mutation and fault events. This is a list of names, not a layout or a placement — the viewer has no geometry for this design.' }),
    grid,
  ]));

  // Artifacts that a design view would render, if we had the viewers for them.
  const designArtifacts = state.artifacts.filter(a => DESIGN_ARTIFACT_KINDS.includes(a.kind));
  const artList = el('ul', { class: 'artifact-list', 'data-testid': 'design-artifacts' });
  if (designArtifacts.length === 0) {
    artList.appendChild(el('li', { class: 'muted', text: 'This run emitted no schematic, PCB, mesh, thermal, stress or trajectory artifact.' }));
  }
  for (const a of designArtifacts) {
    artList.appendChild(el('li', {}, [
      el('code', { text: a.artifact_id }),
      ` ${a.kind} · ${a.bytes} B · ${shortHash(a.sha256)} · `,
      el('span', { class: `prov prov-${a.provenance} prov-compact` }, [el('span', { class: 'prov-label', text: a.provenance.toUpperCase() })]),
      el('div', { class: 'muted', text: `${a.uri} — payload not loaded; no viewer for ${a.kind} in this build.` }),
    ]));
  }
  body.appendChild(section('Design artifacts in this run', artList));

  const faults = Object.values(state.faults);
  if (faults.length) {
    body.appendChild(section('Proposed faults', el('ul', { class: 'fault-list' }, faults.map(f => el('li', {
      class: selection.has(f.fault_id) || selection.has(f.target) ? 'selected' : '',
      'data-fault': f.fault_id,
    }, [
      el('strong', { text: f.fault_id }),
      ` ${f.on ? 'ON' : 'off'} — ${f.target ?? '?'}: ${f.change ?? '?'}`,
    ])))));
  }

  // Per-component thermal results, when the run has any. A run without thermal
  // checks gets no section at all: the placeholder below then says so.
  const thermal = thermalView(state, selection);
  if (thermal) body.appendChild(renderThermalSection(thermal, ctx, selection));

  body.appendChild(section('Not wired yet', [
    has3d ? null : placeholder('3D board / assembly view', [
      'No 3D solver is connected. There is no mesh, no geometry and no camera in this build.',
      'The concept render shows a 3D multi-physics studio; this viewer deliberately shows nothing in its place rather than a drawing that would be mistaken for one.',
    ], { phase: 'Phase D — Three.js scene, GLB from STEP, picking by design-graph id (STEPS S4.1).' }),
    thermal
      // Per-part numbers exist, but a field still does not: say exactly that.
      ? placeholder('Thermal field (spatial)', [
        'Per-component temperatures are wired above. A spatial field is not: the thermal model is lumped, one number per part, so there is no temperature between parts to draw.',
        'A coloured heat map would still be a fabrication, so none is drawn.',
      ], { phase: 'Phase D-E — conduction through board and housing (workers/fea), then a field.' })
      : placeholder('Thermal field', [
        'No thermal solver is connected. No temperature anywhere in this viewer is measured or simulated.',
        'A coloured heat map would be a fabrication, so none is drawn.',
      ], { phase: 'Phase D-E — per-component temperature for pass/fail.' }),
    placeholder('Structural FEA / stress', [
      'No FEA solver is connected (CalculiX, Gmsh). No stress number exists in this run.',
    ], { phase: 'Phase E — stage 5 and later.' }),
    placeholder('Schematic and PCB layers', [
      'No SVG export pipeline is connected. kicad-cli exports are not produced or loaded by this viewer yet.',
    ], { phase: 'Phase C-D — kicad-cli SVG, KiCanvas later.' }),
    placeholder('Robotics sandbox / kinematic rig', [
      'No MuJoCo trajectory playback. No recorded frames are loaded.',
    ], { phase: 'Phase E — recorded trajectory playback, WASM physics later.' }),
  ]));

  return root;
}
