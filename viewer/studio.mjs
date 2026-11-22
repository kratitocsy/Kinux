// The studio: the Kinux viewer as one screen, laid out after the "Kinux MCP
// Viewer" design (header with replay controls, agent terminal, 3D
// multi-physics viewport, instrumentation panel).
//
//   header  the run, its phase, and replay: step through the run one injected
//           fault at a time, or auto-run it
//   left    the terminal: what the attached agent asked (Kinux Builder), each
//           fault the Fault Inspector injected, and what the Solver measured
//   centre  the board: 3D (with the CalculiX temperature field), PCB or
//           schematic; colour by temperature or by faults caught and missed
//   right   instruments: one trace per check (its value under every fault,
//           with its limits), telemetry numbers, the temperature per part
//
// Rule kept from the rest of the viewer: every word and number comes from a
// run event or a run file (events.jsonl, heat-field.json, waves/*.json,
// activity.json). Modes with no solver behind them (stress, current density,
// the kinematic rig) are shown as not connected, never drawn.

import { el, svgEl } from './dom.mjs';
import { partStatus, view2d } from './panels/board.mjs';
import { describeActivity } from './panels/log.mjs';
import { heatArtifact, fieldRange, fieldCanvas, hottestParts, fieldNotes, thermalRamp } from './heatfield.mjs';
import { studioStage, stageActions } from './studio3d.mjs';

const files = new Map();
const ui = {
  view: null, viewChosen: false, mode: null, modeChosen: false, step: null, playing: false, timer: null,
  feedScroll: null, activity: [], activityPolling: false, copied: false,
};

function fetchFile(url, as = 'json') {
  if (!files.has(url)) {
    const p = fetch(url, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return as === 'json' ? r.json() : r.text(); });
    files.set(url, { p, value: undefined, error: null });
    p.then(v => { files.get(url).value = v; }, e => { files.get(url).error = e; });
  }
  return files.get(url);
}
/** A file's value if loaded; otherwise start loading and re-render when it arrives. */
function loaded(url, ctx, as) {
  if (!url) return undefined;
  const f = fetchFile(url, as);
  if (f.value === undefined && !f.error) f.p.then(() => ctx.rerender?.(), () => ctx.rerender?.());
  return f.value;
}

const fmtW = w => (Math.abs(w) >= 1 ? `${w.toFixed(2)} W` : `${(w * 1000).toFixed(1)} mW`);
const pct = x => `${(x * 100).toFixed(1)}%`;
const fileName = p => String(p ?? '').split('/').pop() || 'design';
const ico = (d, size = 18) => svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  [].concat(d).map(x => svgEl('path', { d: x })));
const LOGO = () => svgEl('svg', { width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none', stroke: '#38BDF8', 'stroke-width': 1.8, 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
  [svgEl('path', { d: 'M12 2 21 7v10l-9 5-9-5V7z' }), svgEl('path', { d: 'M12 22V12M21 7l-9 5-9-5' })]);

// --- replay ------------------------------------------------------------------

/** How many faults are shown: all of them unless the person is stepping. */
const shownCount = state => {
  const n = (state.mutantOrder ?? []).length;
  return ui.step === null ? n : Math.min(ui.step, n);
};

function stopPlay() { if (ui.timer) clearInterval(ui.timer); ui.timer = null; ui.playing = false; }

function play(state, ctx) {
  const n = (state.mutantOrder ?? []).length;
  if (ui.step === null || ui.step >= n) ui.step = 0;
  ui.playing = true;
  ui.timer = setInterval(() => {
    if (ui.step >= n) { stopPlay(); ctx.rerender?.(); return; }
    ui.step += 1;
    ui.feedScroll = Infinity;
    ctx.rerender?.();
  }, 900);
}

/** The run's phase, as the header chip says it. */
export function phaseOf(state, shown) {
  const n = (state.mutantOrder ?? []).length;
  if (!state.run.run_id) return ['Awaiting run', 'idle'];
  if (shown > 0 && (ui.step !== null)) {
    const m = state.mutants[state.mutantOrder[shown - 1]];
    if (m.status === 'survived') return ['Fault missed', 'bad'];
    if (m.status === 'killed') return ['Fault caught', 'good'];
    return ['Not checked', 'warn'];
  }
  if (ui.step === 0) return ['Baseline', 'run'];
  if (!state.run.finished) return [n ? 'Injecting faults' : 'Simulating', 'run'];
  const s = state.score;
  if (s?.cap?.bites) return [`Score ${pct(s.score)} · capped ${(s.cap.applied_at * 100).toFixed(0)}%`, 'warn'];
  return [s ? `Score ${pct(s.score)}` : 'Finished', 'good'];
}

function header(state, ctx, shown) {
  const n = (state.mutantOrder ?? []).length;
  const [phase, tone] = phaseOf(state, shown);
  const btn = (label, attrs, kids) => el('button', { type: 'button', class: 'kv-btn', 'aria-label': label, ...attrs }, kids);
  return el('header', { class: 'kv-head' }, [
    el('div', { class: 'kv-head-l' }, [
      LOGO(),
      el('div', { class: 'kv-title' }, [
        el('div', { class: 'kv-title-main', text: 'Kinux Multi-Physics Viewer' }),
        el('div', { class: 'kv-title-sub', text: `MCP app · ${fileName(state.run.project).replace(/\.kicad_sch$/, '')} · ${state.run.run_id ?? ''}`, title: state.run.project ?? '' }),
      ]),
      el('span', { class: `kv-phase tone-${tone}`, 'data-testid': 'studio-phase', text: phase }),
    ]),
    el('div', { class: 'kv-head-r' }, [
      el('span', { class: 'kv-steplabel', 'data-testid': 'studio-step', text: n ? `Fault ${shown} / ${n}` : 'No faults' }),
      btn('Previous fault', { disabled: shown <= 0 || !n, 'data-testid': 'studio-prev', onclick: () => { stopPlay(); ui.step = Math.max(0, shown - 1); ctx.rerender?.(); } },
        [ico('M15 6l-6 6 6 6', 16)]),
      btn('Next fault', { disabled: shown >= n, 'data-testid': 'studio-next', onclick: () => { stopPlay(); ui.step = Math.min(n, shown + 1); ui.feedScroll = Infinity; ctx.rerender?.(); } },
        ['Step', ico('M9 6l6 6-6 6', 16)]),
      el('button', { type: 'button', class: 'kv-btn kv-btn-primary', disabled: !n, 'data-testid': 'studio-play',
        onclick: () => { if (ui.playing) stopPlay(); else play(state, ctx); ctx.rerender?.(); } }, [ui.playing ? 'Pause' : ui.step !== null && ui.step >= n ? 'Replay' : 'Auto-run']),
      btn('Reset', { 'data-testid': 'studio-reset', onclick: () => { stopPlay(); ui.step = 0; ui.feedScroll = 0; ctx.rerender?.(); } }, ['Reset']),
      btn('Show the whole run', { 'data-testid': 'studio-all', disabled: ui.step === null, onclick: () => { stopPlay(); ui.step = null; ctx.rerender?.(); } }, ['Whole run']),
      btn('All events', { 'data-testid': 'layout-classic', onclick: () => { stopPlay(); ctx.setLayout?.('classic'); } }, ['All events']),
    ]),
  ]);
}

// --- left: the terminal --------------------------------------------------------

/** What the Solver said about one injected fault, from that mutant's own results. */
export function solverReply(state, m) {
  const results = state.testOrder.map(tid => state.tests[tid]).filter(t => t.test_id !== 'design' && t.results[m.mutant_id]);
  if (m.status === 'killed') {
    const t = state.tests[m.killed_by[0]];
    const r = t?.results[m.mutant_id];
    const meas = r && r.measured !== null ? ` measured ${r.measured}${r.units ? ` ${r.units}` : ''}${r.limit ? `, limit ${r.limit}` : ''}` : '';
    return { tag: 'CAUGHT', tone: 'good', text: `${t?.title ?? m.killed_by[0]} failed:${meas}${m.killed_by.length > 1 ? ` (+${m.killed_by.length - 1} more)` : ''}` };
  }
  if (m.status === 'survived') return { tag: 'MISSED', tone: 'bad', text: `all ${results.length} checks still pass with this fault in the circuit` };
  if (m.status === 'equivalent') return { tag: 'EQUIVALENT', tone: 'idle', text: 'the solver cannot tell this fault from the original design' };
  const why = results.map(t => t.results[m.mutant_id]).find(r => r.reason_code);
  return { tag: m.status === 'error' ? 'ERROR' : 'NOT CHECKED', tone: 'warn', text: why ? `${why.reason_code}: ${String(why.reason ?? '').split('\n')[0].slice(0, 140)}` : 'no usable result' };
}

const WHO = {
  kinux: ['K', 'Kinux'], builder: ['KB', 'Kinux Builder'], reviewer: ['RV', 'Reviewer'],
  inspector: ['FI', 'Fault Inspector'], solver: ['S', 'Solver'], villain: ['VL', 'Villain agent'],
};

function line(who, text, { tag = null, tone = null, ref = null, sub = null, ctx = null, selected = false } = {}) {
  const [ini, name] = WHO[who];
  return el('div', { class: `kv-line kv-${who}${selected ? ' selected' : ''}`, 'data-testid': 'terminal-msg', 'data-who': who, 'data-ref': ref ?? '',
    onclick: ref && ctx ? () => ctx.onSelect?.(ref) : null }, [
    el('div', { class: 'kv-badge', text: ini }),
    el('div', { class: 'kv-line-body' }, [
      el('div', { class: 'kv-name' }, [name, sub ? el('span', { class: 'kv-sub', text: ` ${sub}` }) : null]),
      el('div', { class: 'kv-text' }, [tag ? el('span', { class: `kv-tag tone-${tone}`, text: tag }) : null, tag ? ' ' : null, text]),
    ]),
  ]);
}

function terminal(state, ctx, field, shown) {
  const sel = ctx.selection ?? new Set();
  const items = [];
  const checks = state.testOrder.filter(t => t !== 'design').length;
  items.push(line('kinux', `Run started on ${fileName(state.run.project)}: ${checks} checks, ${(state.mutantOrder ?? []).length} faults to inject.`, { sub: state.run.run_id }));
  for (const a of ui.activity) {
    const d = describeActivity(a);
    if (d.villain && !a.isError) {
      items.push(line('villain', d.action, { tag: 'INJECT', tone: 'inject', sub: 'via MCP' }));
      items.push(line('solver', d.decision, { tag: d.status === 'killed' ? 'CAUGHT' : d.status === 'survived' ? 'MISSED' : 'NOT CHECKED', tone: d.status === 'killed' ? 'good' : d.status === 'survived' ? 'bad' : 'warn' }));
      continue;
    }
    items.push(line(a.role === 'reviewer' ? 'reviewer' : a.role === 'villain' ? 'villain' : 'builder', `${d.action}${d.decision ? ` → ${d.decision}` : ''}`, { tag: d.ok ? null : 'REFUSED', tone: 'bad', sub: 'via MCP' }));
  }
  if (field) {
    items.push(line('solver', field.drawn
      ? `ngspice + CalculiX: board heat solved, hottest ${field.peak_c.toFixed(1)} °C at ${field.inputs.ambient_c.value} °C ambient, ${fmtW(field.total_w)} dissipated (converged over ${field.study.levels.length} grids).`
      : `Board heat not drawn: ${field.reason}`, { tag: field.drawn ? 'THERMAL' : 'NOT CHECKED', tone: field.drawn ? 'run' : 'warn' }));
  }
  const order = (state.mutantOrder ?? []).slice(0, shown);
  for (const id of order) {
    const m = state.mutants[id];
    const on = sel.has(m.target) || sel.has(m.mutant_id);
    const reply = solverReply(state, m);
    items.push(line('inspector', m.description, { tag: 'INJECT', tone: 'inject', ref: m.target, ctx, selected: on }));
    items.push(line('solver', reply.text, { tag: reply.tag, tone: reply.tone, ref: m.target, ctx, selected: on, sub: state.run.tool_versions?.ngspice }));
  }
  const s = state.score;
  if (s && shown >= (state.mutantOrder ?? []).length) {
    items.push(line('kinux', `${s.killed} of ${s.killed + s.survived} checkable faults caught (${pct(s.score)}); ${s.survived} missed, ${s.not_checked + s.errors} not checked.${s.cap?.bites ? ` Capped at ${(s.cap.applied_at * 100).toFixed(0)}%: ${s.cap.reason.split(': ').slice(1).join(': ') || s.cap.reason}` : ''}`,
      { tag: 'SCORE', tone: s.cap?.bites ? 'warn' : 'good' }));
  }
  if (ui.playing && shown < (state.mutantOrder ?? []).length) items.push(el('div', { class: 'kv-typing', text: 'Fault Inspector is injecting the next fault…' }));
  const log = el('div', { class: 'kv-log', 'data-testid': 'terminal-list' }, items);
  requestAnimationFrame(() => { log.scrollTop = ui.feedScroll === Infinity ? log.scrollHeight : ui.feedScroll ?? 0; });
  log.addEventListener('scroll', () => { ui.feedScroll = log.scrollTop; });
  const cmd = `@kinux verify ${fileName(state.run.project)} and show me what the faults missed`;
  return el('section', { class: 'kv-card kv-left', 'aria-label': 'Agent terminal' }, [
    el('div', { class: 'kv-card-head' }, [
      el('div', { class: 'kv-h', text: '1. Multi-agent chat & testing terminal' }),
      el('div', { class: 'kv-pills' }, [el('span', { class: 'kv-pill kv-pill-kb', text: 'Kinux Builder' }), el('span', { class: 'kv-pill kv-pill-fi', text: 'Fault Inspector' })]),
    ]),
    log,
    el('div', { class: 'kv-cmd' }, [
      el('label', { for: 'kv-cmd', text: 'COMMAND · paste into Claude Code with Kinux attached' }),
      el('div', { class: 'kv-cmd-row' }, [
        el('input', { id: 'kv-cmd', type: 'text', value: cmd, readonly: true, 'data-testid': 'studio-command' }),
        el('button', { type: 'button', class: 'kv-btn kv-btn-primary', 'aria-label': 'Copy command', title: 'Copy to the clipboard',
          onclick: ev => { navigator.clipboard?.writeText(ev.currentTarget.parentNode.querySelector('input').value).then(() => { ui.copied = true; ctx.rerender?.(); setTimeout(() => { ui.copied = false; ctx.rerender?.(); }, 1500); }, () => {}); } },
        [ui.copied ? 'Copied' : ico('M5 12h14M13 6l6 6-6 6', 16)]),
      ]),
    ]),
  ]);
}

// --- centre: the viewport ----------------------------------------------------------

function viewport(state, ctx, views, parts, field, shown) {
  const viewsAvail = [views.board3d && ['board3d', '3D'], views.pcb && ['pcb', 'PCB'], views.schematic && ['schematic', 'Schematic'], ['data', 'Data']].filter(Boolean);
  if (!ui.viewChosen || !viewsAvail.some(([k]) => k === ui.view)) ui.view = viewsAvail[0]?.[0] ?? null;
  const range = field?.drawn ? fieldRange(field) : null;
  if (!ui.modeChosen || !range) ui.mode = range ? 'heat' : 'faults';
  const sel = ctx.selection ?? new Set();

  // Fault colours from the faults shown so far: a replay colours parts as it goes.
  const status = new Map();
  const RANK = { survived: 0, error: 1, not_checked: 2, killed: 3, equivalent: 4 };
  for (const id of (state.mutantOrder ?? []).slice(0, shown)) {
    const m = state.mutants[id];
    const cur = status.get(m.target);
    if (!cur || RANK[m.status] < RANK[cur]) status.set(m.target, m.status);
  }
  const current = ui.step !== null && shown > 0 ? state.mutants[state.mutantOrder[shown - 1]] : null;

  let callouts = [];
  if (current) {
    const r = solverReply(state, current);
    callouts.push({ ref: current.target, tone: r.tone === 'good' ? 'good' : r.tone === 'bad' ? 'bad' : 'warm', text: `${current.target}: ${r.tag.toLowerCase()} · ${current.description.split(' (')[0].replace(/^\S+\s/, '')}` });
  }
  if (ui.mode === 'heat' && range) {
    for (const p of hottestParts(field, current ? 3 : 4)) {
      if (callouts.some(c => c.ref === p.ref)) continue;
      callouts.push({ ref: p.ref, tone: p.peak_c >= range.max - 0.25 * (range.max - range.min) ? 'hot' : 'warm', text: `${p.ref} ${p.peak_c.toFixed(1)} °C · ${fmtW(p.watts)}` });
    }
  } else if (!current) {
    const missed = new Map();
    for (const id of (state.mutantOrder ?? []).slice(0, shown)) { const m = state.mutants[id]; if (m.status === 'survived') missed.set(m.target, (missed.get(m.target) ?? 0) + 1); }
    callouts = [...missed].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ref, n]) => ({ ref, tone: 'bad', text: `${ref}: ${n} fault${n > 1 ? 's' : ''} missed` }));
  }

  let stage;
  if (ui.view === 'data') stage = dataView(state, ctx, field, shown);
  else if (!parts) stage = el('p', { class: 'kv-muted kv-pad', text: views.parts ? 'Loading the design views…' : 'This run has no design views: run it on a KiCad design to see the board.' });
  else if (ui.view === 'board3d') {
    stage = studioStage({ glbUrl: ctx.artifactUrl(views.board3d), parts, field, range, mode: ui.mode, status, callouts, selection: current ? new Set([current.target, ...sel]) : sel, onSelect: ctx.onSelect });
  } else if (ui.view === 'pcb') {
    let underlay = null;
    if (ui.mode === 'heat' && range && parts.pcb_outline) {
      if (!ui.pcbHeat) ui.pcbHeat = fieldCanvas(field, 'top', range).toDataURL();
      const { width: w, height: h } = field.board_mm;
      underlay = { href: ui.pcbHeat, x: field.board_mm.origin[0] - parts.pcb_outline.minX, y: field.board_mm.origin[1] - parts.pcb_outline.minY, w, h };
    }
    stage = el('div', { class: 'st2d' }, [view2d('pcb', ctx.artifactUrl(views.pcb), parts.pcb, partStatus(state), sel, ctx, 'PCB', null, underlay)]);
  } else stage = el('div', { class: 'st2d' }, [view2d('schematic', ctx.artifactUrl(views.schematic), parts.schematic, partStatus(state), sel, ctx, 'Schematic')]);

  const tool = (label, d, fn, attrs = {}) => el('button', { type: 'button', class: 'kv-btn kv-icon', 'aria-label': label, title: label, disabled: ui.view !== 'board3d', onclick: () => { stageActions()?.[fn.name]?.(...(fn.args ?? [])); ctx.rerender?.(); }, ...attrs }, [ico(d)]);
  const toolbar = el('div', { class: 'kv-tools' }, [
    tool('Orbit', ['M3 12a9 4 0 0 0 18 0a9 4 0 0 0-18 0', 'M12 3a4 9 0 0 1 0 18'], { name: 'orbit' }, { 'data-testid': 'tool-orbit' }),
    tool('Pan', 'M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3', { name: 'pan' }, { 'data-testid': 'tool-pan' }),
    tool('Zoom in', ['M21 21l-5-5M11 8v6M8 11h6', 'M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0'], { name: 'zoom', args: [0.8] }, { 'data-testid': 'tool-zoom-in' }),
    tool('Zoom out', ['M21 21l-5-5M8 11h6', 'M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0'], { name: 'zoom', args: [1.25] }, { 'data-testid': 'tool-zoom-out' }),
    tool('Wireframe', ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 9h18M3 15h18M9 3v18M15 3v18'], { name: 'wireframe' }, { 'data-testid': 'tool-wireframe' }),
    tool('Reset view', ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5'], { name: 'reset' }, { 'data-testid': 'studio-reset-view' }),
  ]);
  const modeTab = (k, label, enabled, why) => el('button', { type: 'button', class: `kv-mode${ui.mode === k ? ' active' : ''}`, disabled: !enabled, title: enabled ? label : why,
    'data-testid': `studio-mode-${k}`, onclick: () => { ui.mode = k; ui.modeChosen = true; ctx.rerender?.(); } }, [label]);
  const modes = el('div', { class: 'kv-modes' }, [
    modeTab('heat', 'Thermal', Boolean(range), field ? `No field: ${field.reason}` : 'Run with --heat to solve the board temperature'),
    modeTab('faults', 'Faults', true),
    modeTab('stress', 'Stress', false, 'No structural solve is connected to this run'),
    modeTab('current', 'Current density', false, 'No current-density solve is connected to this run'),
  ]);
  const viewSwitch = el('div', { class: 'kv-views' }, viewsAvail.map(([k, label]) => el('button', { type: 'button', class: `kv-mode${ui.view === k ? ' active' : ''}`, 'data-testid': `studio-tab-${k}`,
    onclick: () => { ui.view = k; ui.viewChosen = true; ctx.rerender?.(); } }, [label])));

  const legend = ui.mode === 'heat' && range
    ? el('div', { class: 'kv-scale', 'data-testid': 'hf-colour-bar' }, [
      el('div', { class: 'kv-scale-ticks' }, [range.max, (range.max + range.min) / 2, range.min].map(v => el('span', { text: `${v.toFixed(1)}°C` }))),
      el('div', { class: 'kv-scale-ramp', style: `background:linear-gradient(${[1, 0.75, 0.5, 0.25, 0].map(f => `rgb(${thermalRamp(f).join(',')})`).join(',')})` }),
    ])
    : el('div', { class: 'kv-fault-legend' }, [['#F87171', 'fault missed'], ['#34D399', 'all faults caught'], ['#94A3B8', 'not checked']].map(([c, t]) => el('span', {}, [el('i', { style: `background:${c}` }), t])));
  const solvers = [state.run.tool_versions?.ngspice, field?.solver?.calculix].filter(Boolean).join(' + ') || 'solvers';
  return el('section', { class: 'kv-card kv-centre', 'aria-label': '3D multi-physics viewport' }, [
    el('div', { class: 'kv-vp-head' }, [toolbar, el('div', { class: 'kv-h', text: '2. 3D multi-physics studio' })]),
    el('div', { class: 'kv-vp-sub' }, [modes, viewSwitch]),
    el('div', { class: 'kv-stage' }, ui.view === 'data' ? [stage] : [stage, el('div', { class: 'kv-stage-legend' }, [legend]),
      el('div', { class: 'kv-stage-foot', text: `${solvers} · fault ${shown} / ${(state.mutantOrder ?? []).length}` })]),
    field ? fieldNotes(field) : null,
  ]);
}

// --- right: instruments ------------------------------------------------------------

/** Ticks for an axis: five round-ish values from hi to lo. */
function ticks(lo, hi) {
  return [0, 0.25, 0.5, 0.75, 1].map(f => hi - f * (hi - lo));
}
const SI = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9, t: 1e12 };
/** "2m" -> 0.002, "1.5meg" -> 1.5e6, "3e-3" -> 0.003 (the SPICE suffixes a limit is written in). */
export const siValue = text => {
  const m = /^(-?\d*\.?\d+(?:e[-+]?\d+)?)(meg|[fpnumkgt])?$/i.exec(text);
  return m ? Number(m[1]) * (m[2] ? SI[m[2].toLowerCase()] : 1) : NaN;
};

/** A number with an SI prefix, as engineers read it: 0.0033 -> 3.3m, 4700 -> 4.7k. */
export const tickText = (v, digits = 2) => {
  const a = Math.abs(v);
  if (a === 0 || !Number.isFinite(v)) return '0';
  const P = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']];
  const [f, p] = P.find(([x]) => a >= x * 0.9995) ?? P.at(-1);
  return `${Number((v / f).toPrecision(digits))}${p}`;
};

/**
 * One check as a trace: x is the fault number (0 = the original design), y the
 * value the solver measured for that check under that fault. Its limits are
 * the dashed lines. Points with no number (NOT_CHECKED, ERROR) leave a gap.
 */
export function checkTrace(state, testId, shown) {
  const t = state.tests[testId];
  const subjects = ['baseline', ...(state.mutantOrder ?? []).slice(0, shown)];
  const pts = subjects.map((s, i) => ({ i, r: t.results[s] })).map(({ i, r }) => ({ i, v: typeof r?.measured === 'number' ? r.measured : null, verdict: r?.verdict ?? null }));
  const nums = pts.filter(p => p.v !== null).map(p => p.v);
  // Limits as the check states them: "2m .. 5m", "< 100m", "> -40m".
  const lim = String(t.results.baseline?.limit ?? '');
  const lims = [...lim.matchAll(/-?\d*\.?\d+(?:e[-+]?\d+)?(?:meg|[fpnumkgt])?/gi)].map(m => siValue(m[0])).filter(Number.isFinite);
  return { t, pts, nums, lims };
}

function traceCard(state, testId, shown, total, colour) {
  const { t, pts, nums, lims } = checkTrace(state, testId, shown);
  if (!nums.length) return null;
  let lo = Math.min(...nums, ...lims), hi = Math.max(...nums, ...lims);
  if (hi === lo) { hi += Math.abs(hi) * 0.1 || 1; lo -= Math.abs(lo) * 0.1 || 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const W = 300, H = 78, X = i => (total ? (i / total) * W : 0), Y = v => 2 + ((hi - v) / (hi - lo)) * 74;
  let d = '';
  pts.forEach((p, k) => { if (p.v === null) return; d += `${k && pts[k - 1].v !== null ? 'L' : 'M'}${X(p.i).toFixed(1)},${Y(p.v).toFixed(1)}`; });
  const last = pts.at(-1);
  const tone = last?.verdict === 'PASS' ? 'good' : last?.verdict === 'FAIL' ? 'bad' : 'warn';
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'kv-trace-svg', role: 'img', 'aria-label': `${t.title} trace` }, [
    svgEl('path', { d: 'M50 0V78M100 0V78M150 0V78M200 0V78M250 0V78M0 20H300M0 58H300', stroke: '#1A202B', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    ...lims.map(l => svgEl('path', { d: `M0 ${Y(l).toFixed(1)}H300`, stroke: '#F59E0B', 'stroke-width': 1, 'stroke-dasharray': '4 3', 'vector-effect': 'non-scaling-stroke', opacity: 0.8 })),
    svgEl('path', { d, fill: 'none', stroke: colour, 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }),
    ...pts.filter(p => p.v !== null && p.verdict === 'FAIL').map(p => svgEl('circle', { cx: X(p.i), cy: Y(p.v), r: 2.2, fill: '#34D399', 'vector-effect': 'non-scaling-stroke' })),
  ]);
  return el('div', { class: 'kv-trace', 'data-testid': 'studio-trace', 'data-test': testId }, [
    el('div', { class: 'kv-trace-ticks' }, ticks(lo, hi).map(v => el('span', { text: tickText(v) }))),
    el('div', { class: 'kv-trace-plot' }, [svg, el('div', { class: 'kv-trace-label' }, [
      el('span', { class: 'kv-trace-name', text: t.title ?? testId }),
      el('span', { class: `kv-trace-val tone-${tone}`, text: last?.v !== null && last?.v !== undefined ? `${tickText(last.v, 3)}${t.results.baseline?.units ?? ''}` : (last?.verdict ?? '—') }),
    ])]),
  ]);
}

function waveCard(payload, colourIdx) {
  const xs = payload.x.values, colours = ['#38BDF8', '#FB923C', '#34D399', '#C4B5FD'];
  const all = payload.series.flatMap(s => s.values);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1, x0 = xs[0], xs1 = xs.at(-1) - x0 || 1;
  const svg = svgEl('svg', { viewBox: '0 0 300 78', preserveAspectRatio: 'none', class: 'kv-trace-svg' }, [
    svgEl('path', { d: 'M50 0V78M100 0V78M150 0V78M200 0V78M250 0V78M0 20H300M0 58H300', stroke: '#1A202B', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }),
    ...payload.series.slice(0, 2).map((s, k) => svgEl('polyline', { fill: 'none', stroke: colours[(colourIdx + k) % 4], 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke',
      points: s.values.map((v, j) => `${(((xs[j] - x0) / xs1) * 300).toFixed(1)},${(2 + ((hi - v) / span) * 74).toFixed(1)}`).join(' ') })),
  ]);
  return el('div', { class: 'kv-trace', 'data-testid': 'studio-wave' }, [
    el('div', { class: 'kv-trace-ticks' }, ticks(lo, hi).map(v => el('span', { text: tickText(v) }))),
    el('div', { class: 'kv-trace-plot' }, [svg, el('div', { class: 'kv-trace-label' }, [el('span', { class: 'kv-trace-name', text: payload.series.slice(0, 2).map(s => s.name).join(', ') }),
      el('span', { class: 'kv-trace-val tone-idle', text: `${payload.analysis}` })])]),
  ]);
}

function instruments(state, ctx, field, shown) {
  const total = (state.mutantOrder ?? []).length;
  const traces = [];
  const waves = state.artifacts.filter(a => a.kind === 'waveform' && a.mime === 'application/json');
  waves.forEach((a, i) => { const p = ctx.artifactUrl ? loaded(ctx.artifactUrl(a), ctx) : undefined; if (p?.series?.length) traces.push(waveCard(p, i * 2)); });
  const colours = ['#38BDF8', '#38BDF8', '#FB923C', '#FB923C'];
  for (const tid of state.testOrder.filter(x => x !== 'design')) {
    const c = traceCard(state, tid, shown, total, colours[traces.length % 4]);
    if (c) traces.push(c);
  }
  const s = state.score;
  const caught = (state.mutantOrder ?? []).slice(0, shown).reduce((a, id) => { const st = state.mutants[id].status; a[st] = (a[st] ?? 0) + 1; return a; }, {});
  const tele = [
    ['Score', s && shown >= total ? `${pct(s.score)}${s.cap?.bites ? ` → ${(s.cap.applied_at * 100).toFixed(0)}%` : ''}` : '—', s?.cap?.bites ? 'warn' : 'good'],
    ['Caught', `${caught.killed ?? 0} / ${(caught.killed ?? 0) + (caught.survived ?? 0)}`, (caught.survived ?? 0) ? 'bad' : 'good'],
    ['Hottest', field?.drawn ? `${field.peak_c.toFixed(1)}°C ${hottestParts(field, 1)[0]?.ref ?? ''}` : '—', field?.drawn ? 'good' : 'idle'],
    ['Board power', field?.power_source?.balance ? fmtW(field.total_w) : '—', 'idle'],
  ];
  const bars = field?.drawn ? Object.entries(field.parts).sort((a, b) => b[1].peak_c - a[1].peak_c).slice(0, 6) : [];
  const amb = field?.inputs?.ambient_c?.value;
  const maxRise = bars.length ? bars[0][1].peak_c - amb : 1;
  return el('section', { class: 'kv-card kv-right', 'aria-label': 'Physics instrumentation and controls' }, [
    el('div', { class: 'kv-card-head' }, [el('div', { class: 'kv-h', text: '3. Physics instrumentation & controls panel' })]),
    el('div', { class: 'kv-traces' }, traces.length ? [
      ...traces,
      el('div', { class: 'kv-trace-x' }, [0, 0.25, 0.5, 0.75, 1].map(f => el('span', { text: String(Math.round(f * total)) }))),
      el('div', { class: 'kv-trace-note', text: 'x: fault number (0 = the design as drawn) · dashed: the check\'s limits · green dot: the check caught that fault' }),
    ] : [el('p', { class: 'kv-muted', text: 'No numeric check results yet.' })]),
    el('div', { class: 'kv-section', 'data-testid': 'studio-telemetry' }, [
      el('div', { class: 'kv-section-h', text: 'Telemetry outputs' }),
      el('div', { class: 'kv-tele' }, tele.map(([k, v, tone]) => el('div', {}, [el('span', { class: 'kv-tele-k', text: `${k}: ` }), el('span', { class: `kv-tele-v tone-${tone}`, text: v })]))),
    ]),
    el('div', { class: 'kv-section' }, [
      el('div', { class: 'kv-section-h', text: 'Temperature per part' }),
      bars.length ? el('div', { class: 'kv-bars' }, bars.map(([ref, p]) => el('div', { class: 'kv-bar' }, [
        el('span', { class: 'kv-bar-k', text: ref }),
        el('span', { class: 'kv-bar-track' }, [el('i', { style: `width:${(((p.peak_c - amb) / maxRise) * 100).toFixed(1)}%;background:rgb(${thermalRamp(0.4 + 0.6 * (p.peak_c - amb) / maxRise).join(',')})` })]),
        el('span', { class: 'kv-bar-v', text: `${p.peak_c.toFixed(1)}°C` }),
      ]))) : el('p', { class: 'kv-muted', text: 'No temperature field in this run.' }),
    ]),
    powerSection(field),
    faultsSection(state, shown),
    el('div', { class: 'kv-section' }, [
      el('div', { class: 'kv-rig', title: 'MuJoCo is installed, but this design has no mechanism to simulate' }, ['Kinematic rig: not connected (no mechanism in this design)']),
    ]),
  ]);
}

function barRows(rows, fmt) {
  const max = Math.max(...rows.map(r => r.value), 1e-15);
  return el('div', { class: 'kv-bars' }, rows.map(r => el('div', { class: 'kv-bar' }, [
    el('span', { class: 'kv-bar-k', text: r.label }),
    el('span', { class: 'kv-bar-track' }, [el('i', { style: `width:${((r.value / max) * 100).toFixed(1)}%;background:${r.colour}` })]),
    el('span', { class: 'kv-bar-v', text: fmt(r.value) }),
  ])));
}

function powerSection(field) {
  const rows = Object.entries(field?.power_w ?? {}).filter(([, p]) => p.watts > 0).sort((a, b) => b[1].watts - a[1].watts)
    .map(([ref, p]) => ({ label: ref, value: p.watts, colour: p.note ? '#64748B' : '#38BDF8' }));
  if (!rows.length) return null;
  const bal = field.power_source?.balance;
  return el('div', { class: 'kv-section', 'data-testid': 'studio-power' }, [
    el('div', { class: 'kv-section-h', text: 'Power per part (ngspice)' }),
    barRows(rows, fmtW),
    el('div', { class: 'kv-trace-note', text: `${field.power_source.analysis}${field.power_source.averaged ? `, averaged ${tickText(field.power_source.averaged.from)}s–${tickText(field.power_source.averaged.to)}s` : ''}${bal ? ` · sources deliver ${fmtW(bal.delivered_w)}, parts absorb ${fmtW(bal.absorbed_w)}` : ''}${rows.some(r => r.colour === '#64748B') ? ' · grey: a stand-in model' : ''}` }),
  ]);
}

function faultsSection(state, shown) {
  const per = new Map();
  for (const id of (state.mutantOrder ?? []).slice(0, shown)) {
    const m = state.mutants[id];
    const r = per.get(m.target) ?? { killed: 0, survived: 0, other: 0 };
    r[m.status === 'killed' || m.status === 'survived' ? m.status : 'other'] += 1;
    per.set(m.target, r);
  }
  if (!per.size) return null;
  const rows = [...per].sort((a, b) => b[1].survived - a[1].survived || b[1].killed - a[1].killed);
  return el('div', { class: 'kv-section', 'data-testid': 'studio-faults-per-part' }, [
    el('div', { class: 'kv-section-h', text: 'Faults per part' }),
    el('div', { class: 'kv-bars' }, rows.map(([ref, r]) => {
      const n = r.killed + r.survived + r.other;
      return el('div', { class: 'kv-bar' }, [
        el('span', { class: 'kv-bar-k', text: ref }),
        el('span', { class: 'kv-bar-track kv-stack' }, [['killed', '#34D399'], ['survived', '#F87171'], ['other', '#64748B']].map(([k, c]) => el('i', { style: `width:${((r[k] / n) * 100).toFixed(1)}%;background:${c}` }))),
        el('span', { class: 'kv-bar-v', text: `${r.killed}/${r.killed + r.survived}${r.other ? ` +${r.other}` : ''}` }),
      ]);
    })),
    el('div', { class: 'kv-trace-note', text: 'green caught · red missed · grey not checked; caught/checkable (+ not checked)' }),
  ]);
}

// --- the Data view: every table the run has ---------------------------------------

const table = (head, rows, attrs = {}) => el('table', { class: 'kv-table', ...attrs }, [
  el('thead', {}, [el('tr', {}, head.map(h => el('th', { text: h })))]),
  el('tbody', {}, rows.map(r => el('tr', {}, r.map(c => (c instanceof Node ? el('td', {}, [c]) : el('td', { text: c === null || c === undefined ? '—' : String(c) })))))),
]);
const verdictChip = (v, label = v) => el('span', { class: `kv-tag tone-${v === 'PASS' || v === 'killed' ? 'good' : v === 'FAIL' || v === 'survived' ? 'bad' : 'warn'}`, text: label });

function dataView(state, ctx, field, shown) {
  const design = ctx.artifactUrl ? loaded(ctx.artifactUrl({ uri: 'design-model.json', sha256: '' }), ctx) : undefined;
  const order = (state.mutantOrder ?? []).slice(0, shown);
  const caughtBy = new Map();
  for (const id of order) for (const tid of state.mutants[id].killed_by) caughtBy.set(tid, (caughtBy.get(tid) ?? 0) + 1);
  const s = state.score;
  const secs = [];
  secs.push(el('h3', { text: 'Run' }), table(['', ''], [
    ['Design', state.run.project], ['Run', state.run.run_id], ['Design hash', state.run.design_hash],
    ['Tools', Object.entries(state.run.tool_versions ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')],
    ...(s ? [['Mutants', `${s.total}: ${s.killed} caught, ${s.survived} missed, ${s.not_checked} not checked, ${s.errors} errors, ${s.equivalent} equivalent`],
      ['Score', `${pct(s.score)} (95% CI ${pct(s.ci_low)}–${pct(s.ci_high)}), checkable ${pct(s.checkable_fraction)}`],
      ['Cap', s.cap?.bites ? `${(s.cap.applied_at * 100).toFixed(0)}%: ${s.cap.reason}` : 'none']] : []),
  ], { 'data-testid': 'data-run' }));

  const checks = state.testOrder.filter(t => t !== 'design').map(tid => {
    const t = state.tests[tid], b = t.results.baseline;
    return [tid.split(':').slice(1, 3).join(':'), t.title, b?.measured !== null && b?.measured !== undefined ? `${tickText(b.measured, 4)}${b.units ?? ''}` : '—', b?.limit, b ? verdictChip(b.verdict) : '—', caughtBy.get(tid) ?? 0];
  });
  secs.push(el('h3', { text: `Checks (${checks.length})` }), table(['Block:line', 'Check', 'Design measured', 'Limit', 'Design verdict', 'Faults caught'], checks, { 'data-testid': 'data-checks' }));

  const per = new Map();
  for (const id of order) { const m = state.mutants[id]; const r = per.get(m.target) ?? { k: 0, s: 0, o: 0 }; m.status === 'killed' ? r.k++ : m.status === 'survived' ? r.s++ : r.o++; per.set(m.target, r); }
  const partRows = (design?.parts ?? []).map(p => {
    const pw = field?.power_w?.[p.ref], pk = field?.parts?.[p.ref], f = per.get(p.ref);
    return [p.ref, p.value_raw, p.status === 'modelled' ? 'modelled' : `${p.status}${p.reason_code ? ` (${p.reason_code})` : ''}`, p.detail,
      pw ? fmtW(pw.watts) : '—', pk ? `${pk.peak_c.toFixed(2)}°C` : '—', f ? `${f.k} caught, ${f.s} missed${f.o ? `, ${f.o} n/c` : ''}` : '—'];
  });
  secs.push(el('h3', { text: `Parts (${partRows.length || 'loading…'})` }),
    partRows.length ? table(['Part', 'Value', 'Status', 'How it is simulated', 'Power', 'Peak temp', 'Faults'], partRows, { 'data-testid': 'data-parts' })
      : el('p', { class: 'kv-muted', text: design === undefined ? 'Loading design-model.json…' : 'No design model in this run.' }));

  const faultRows = order.map((id, i) => {
    const m = state.mutants[id];
    return [i + 1, m.target, m.description, verdictChip(m.status, m.status.replace('_', ' ')), m.killed_by.map(t => state.tests[t]?.title ?? t).join('; ')];
  });
  secs.push(el('h3', { text: `Faults injected (${faultRows.length})` }), table(['#', 'Part', 'Fault', 'Result', 'Caught by'], faultRows, { 'data-testid': 'data-faults' }));

  if (field) {
    const st = field.study ?? {};
    secs.push(el('h3', { text: 'Thermal solve' }), table(['', ''], [
      ['Result', field.drawn ? `converged, peak ${field.peak_c.toFixed(3)}°C` : `${field.verdict} ${field.reason_code}: ${field.reason}`],
      ['Model', field.model],
      ['Board', field.board_mm ? `${field.board_mm.width} × ${field.board_mm.height} × ${field.board_mm.thickness} mm, ${field.board_mm.copper_layers} copper layers` : '—'],
      ['Conductivity', field.conductivity_w_mk ? `in-plane ${field.conductivity_w_mk.in_plane.toFixed(3)}, through ${field.conductivity_w_mk.through.toFixed(4)} W/(m K)` : '—'],
      ['Power', field.power_source?.balance ? `${fmtW(field.total_w)} placed; delivered ${fmtW(field.power_source.balance.delivered_w)}, absorbed ${fmtW(field.power_source.balance.absorbed_w)} (${field.power_source.analysis})` : '—'],
    ]), table(['Grid (mm)', 'Elements', 'Peak (°C)', 'Power applied'], (st.levels ?? []).map(l => [l.size.toFixed(3), l.elements, l.peak_c.toFixed(4), fmtW(l.applied_w)])),
    table(['Input', 'Value', 'Source'], Object.entries(field.inputs ?? {}).filter(([, v]) => v && typeof v === 'object' && 'value' in v).map(([k, v]) => [k, v.value, v.source])));
  }
  const waves = state.artifacts.filter(a => a.kind === 'waveform');
  if (waves.length) secs.push(el('h3', { text: 'Waveforms' }), table(['Artifact', 'File', 'Bytes', 'sha256'], waves.map(a => [a.artifact_id, a.uri, a.bytes, String(a.sha256).slice(7, 19)])));
  return el('div', { class: 'kv-data', 'data-testid': 'studio-data' }, secs);
}

/** The studio for a run. */
export function renderStudio(state, ctx) {
  const views = Object.fromEntries((state.artifacts ?? []).filter(a => a.test_id === 'design').map(a => [a.artifact_id, a]));
  const parts = views.parts && ctx.artifactUrl ? loaded(ctx.artifactUrl(views.parts), ctx) : null;
  const ha = heatArtifact(state);
  const field = ha && ctx.artifactUrl ? loaded(ctx.artifactUrl(ha), ctx) : null;
  if (ctx.activityUrl && !ui.activityPolling) {
    ui.activityPolling = true;
    let seen = -1;
    const poll = () => fetch(ctx.activityUrl, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(items => {
      if (Array.isArray(items) && items.length !== seen) { seen = items.length; ui.activity = items.slice(-100); ctx.rerender?.(); }
    }).catch(() => {});
    poll();
    setInterval(poll, 3000);
  }
  const shown = shownCount(state);
  return el('div', { class: 'kv', 'data-testid': 'studio' }, [
    header(state, ctx, shown),
    el('main', { class: 'kv-main' }, [
      terminal(state, ctx, field ?? null, shown),
      viewport(state, ctx, views, parts ?? null, field ?? null, shown),
      instruments(state, ctx, field ?? null, shown),
    ]),
  ]);
}
