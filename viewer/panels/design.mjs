// Panel 2 — the design / physics view.
//
// Honesty rules for this panel, in force until the solvers land:
//   * There is no 3D viewer, no thermal field and no FEA in this build.
//     Those are Phase D-E. We do not draw them, not even as decoration.
//   * What we DO have is the design identity carried by the events, the
//     artifact inventory (with hashes), and the list of design elements the
//     run actually touched. Those are rendered.
//   * Everything else is a labelled placeholder that says what is missing.

import { el, panelShell, section, kv, placeholder, shortHash } from '../dom.mjs';
import { badgeFor } from '../reducer.mjs';

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

  body.appendChild(section('Not wired yet', [
    placeholder('3D board / assembly view', [
      'No 3D solver is connected. There is no mesh, no geometry and no camera in this build.',
      'The concept render shows a 3D multi-physics studio; this viewer deliberately shows nothing in its place rather than a drawing that would be mistaken for one.',
    ], { phase: 'Phase D — Three.js scene, GLB from STEP, picking by design-graph id (STEPS S4.1).' }),
    placeholder('Thermal field', [
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
