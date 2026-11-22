// The studio layout: one screen that reads like a design studio.
//
//   left    the testing terminal: what the agent asked, each fault the Villain
//           injected, and what the solver said back, as a conversation
//   centre  the design itself: 2D schematic, PCB, or the 3D board with its
//           solved temperature field and callouts
//   right   instruments: telemetry numbers and graphs
//
// Same rule as the rest of the viewer: every sentence and every number is
// derived from a run event or a run file (events.jsonl, heat-field.json,
// waves/*.json, activity.json). Where a run lacks something, the studio says
// so instead of drawing it.

import { el, svgEl } from './dom.mjs';
import { partStatus, view2d } from './panels/board.mjs';
import { describeActivity } from './panels/log.mjs';
import { heatArtifact, fieldRange, fieldCanvas, colourBar, hottestParts, fieldNotes } from './heatfield.mjs';
import { studioStage } from './studio3d.mjs';

const files = new Map();
const ui = { tab: null, tabChosen: false, mode: null, modeChosen: false, filter: 'all', feedScroll: null, activity: [], activityPolling: false };

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
const boardName = p => String(p ?? '').split('/').pop().replace(/\.kicad_sch$|\.cir$/i, '') || 'design';

// --- left: the terminal ------------------------------------------------------

/** What the solver said about one injected fault, from that mutant's own results. */
export function solverReply(state, m) {
  const results = state.testOrder.map(tid => state.tests[tid]).filter(t => t.test_id !== 'design' && t.results[m.mutant_id]);
  if (m.status === 'killed') {
    const t = state.tests[m.killed_by[0]];
    const r = t?.results[m.mutant_id];
    const meas = r && r.measured !== null ? ` measured ${r.measured}${r.units ? ` ${r.units}` : ''}${r.limit ? `, limit ${r.limit}` : ''}` : '';
    return { tone: 'ok', head: 'CAUGHT', text: `${t?.title ?? m.killed_by[0]} failed:${meas}${m.killed_by.length > 1 ? ` (+${m.killed_by.length - 1} more check${m.killed_by.length > 2 ? 's' : ''})` : ''}` };
  }
  if (m.status === 'survived') {
    return { tone: 'bad', head: 'NOT CAUGHT', text: `all ${results.length} checks still pass with this fault in the circuit` };
  }
  if (m.status === 'equivalent') return { tone: 'dim', head: 'EQUIVALENT', text: 'the solver cannot tell this fault from the original design' };
  const why = results.map(t => t.results[m.mutant_id]).find(r => r.reason_code);
  return { tone: 'warn', head: m.status === 'error' ? 'ERROR' : 'NOT CHECKED', text: why ? `${why.reason_code}: ${String(why.reason ?? '').split('\n')[0].slice(0, 140)}` : 'no usable result' };
}

// Who speaks in the terminal. The Fault Inspector is Kinux's mutation engine
// (it injects each fault); the Kinux Builder Bot runs the solvers and reports
// what they computed; the Builder and Reviewer agents are whatever coding agent
// is attached over MCP.
const AVATAR = {
  builder: ['builder', 'Builder agent'], villain: ['inspector', 'Fault Inspector'], solver: ['bot', 'Kinux Builder Bot'],
  kinux: ['kinux', 'Kinux'], reviewer: ['reviewer', 'Reviewer agent'],
};
const ICONS = {
  builder: 'M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  inspector: 'M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.7 4.8-1.4 1.4-4.8-4.7A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM9.5 7h2v4h-2zm0 5h2v2h-2z',
  bot: 'M11 2h2v3h4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h4zM8.5 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM8 15h8v1.5H8zM1 10h2v5H1zm20 0h2v5h-2z',
  kinux: 'M12 2l9 5v10l-9 5-9-5V7zm0 2.3L5 8.2v7.6l7 3.9 7-3.9V8.2zM9 8h2v3.2L14 8h2.6l-3.4 3.6L17 16h-2.6l-2.7-3.1-.7.7V16H9z',
  reviewer: 'M4 4h16v12H8l-4 4zm4 4v2h8V8zm0 4v2h5v-2z',
};
const icon = (kind, cls = 'tm-icon') => svgEl('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, [svgEl('path', { d: ICONS[kind], fill: 'currentColor' })]);

function bubble(who, title, body, extra = {}) {
  const [glyph, name] = AVATAR[who];
  return el('li', { class: `tm-msg tm-${who}${extra.tone ? ` tone-${extra.tone}` : ''}${extra.selected ? ' selected' : ''}`, 'data-testid': 'terminal-msg', 'data-who': who,
    'data-ref': extra.ref ?? '', onclick: extra.ref ? () => extra.onSelect?.(extra.ref) : null }, [
    el('span', { class: 'tm-avatar' }, [icon(glyph)]),
    el('div', { class: 'tm-body' }, [
      el('div', { class: 'tm-who' }, [el('strong', { text: title ?? name }), extra.sub ? el('span', { class: 'tm-sub', text: extra.sub }) : null]),
      ...[].concat(body),
    ]),
  ]);
}

function terminal(state, ctx, field) {
  const msgs = [];
  const sel = ctx.selection ?? new Set();
  const tests = state.testOrder.filter(t => t !== 'design').length;
  msgs.push(bubble('kinux', null, el('div', { text: `Run started on ${boardName(state.run.project)}. ${tests} checks from the suite; ${Object.keys(state.mutants).length || 'no'} faults to inject.` }), { sub: state.run.run_id }));
  for (const a of ui.activity) {
    const d = describeActivity(a);
    msgs.push(bubble(a.role === 'reviewer' ? 'reviewer' : 'builder', d.agent, [el('div', { text: d.action }), d.decision ? el('div', { class: 'tm-reply', text: `Kinux: ${d.decision}` }) : null], { tone: d.ok ? null : 'bad', sub: 'via MCP' }));
  }
  if (field) {
    msgs.push(bubble('solver', null, field.drawn
      ? el('div', { text: `Board heat solved: hottest point ${field.peak_c.toFixed(1)} °C at ${field.inputs.ambient_c.value} °C ambient, ${fmtW(field.total_w)} dissipated. Converged over ${field.study.levels.length} grids.` })
      : el('div', { text: `Board heat not drawn: ${field.reason}` }), { tone: field.drawn ? 'ok' : 'warn', sub: 'ngspice + CalculiX' }));
  }
  const order = state.mutantOrder ?? [];
  const counts = { all: order.length, survived: 0, killed: 0, other: 0 };
  for (const id of order) { const s = state.mutants[id].status; counts[s === 'survived' || s === 'killed' ? s : 'other'] += 1; }
  for (const id of order) {
    const m = state.mutants[id];
    const cls = m.status === 'survived' || m.status === 'killed' ? m.status : 'other';
    if (ui.filter !== 'all' && ui.filter !== cls) continue;
    const reply = solverReply(state, m);
    const on = sel.has(m.target) || sel.has(m.mutant_id);
    msgs.push(bubble('villain', null, el('div', { text: `Injecting fault: ${m.description}` }), { ref: m.target, onSelect: ctx.onSelect, selected: on, sub: m.target }));
    msgs.push(bubble('solver', null, [el('span', { class: `tm-verdict tone-${reply.tone}`, text: reply.head }), el('span', { text: ` ${reply.text}` })],
      { tone: reply.tone, ref: m.target, onSelect: ctx.onSelect, selected: on, sub: state.run.tool_versions?.ngspice ?? 'ngspice' }));
  }
  const score = state.score;
  if (score) {
    msgs.push(bubble('kinux', null, [
      el('div', { class: 'tm-score', text: `Score ${score.score === null ? '—' : `${(score.score * 100).toFixed(1)}%`}: ${score.killed} of ${score.killed + score.survived} checkable faults caught; ${score.survived} not caught, ${score.not_checked + score.errors} could not be checked.` }),
      score.cap?.bites ? el('div', { class: 'tm-reply', text: `Capped at ${(score.cap.applied_at * 100).toFixed(0)}%: ${score.cap.reason.split(': ').slice(1).join(': ') || score.cap.reason}` }) : null,
    ], { sub: 'result' }));
  }
  const list = el('ol', { class: 'tm-list', 'data-testid': 'terminal-list' }, msgs);
  const filters = el('div', { class: 'tm-filters' }, [['all', 'All'], ['survived', 'Not caught'], ['killed', 'Caught'], ['other', 'Not checked']].map(([k, label]) =>
    el('button', { type: 'button', class: `st-chip${ui.filter === k ? ' active' : ''}`, 'data-testid': `terminal-filter-${k}`, onclick: () => { ui.filter = k; ctx.rerender?.(); } }, [`${label} ${counts[k]}`])));
  if (ui.feedScroll !== null) requestAnimationFrame(() => { list.scrollTop = ui.feedScroll; });
  list.addEventListener('scroll', () => { ui.feedScroll = list.scrollTop; });
  const lastAsk = [...ui.activity].reverse().find(a => a.tool);
  const agentOn = ui.activity.length > 0;
  const roster = el('div', { class: 'st-roster', 'data-testid': 'studio-roster' }, [
    ['builder', 'Builder agent', agentOn ? 'attached over MCP' : 'not attached in this run', agentOn],
    ['inspector', 'Fault Inspector', `${counts.all} faults injected`, counts.all > 0],
    ['bot', 'Kinux Builder Bot', [state.run.tool_versions?.ngspice, field?.solver?.calculix].filter(Boolean).join(' · ') || 'solvers', true],
  ].map(([k, name, note, on]) => el('div', { class: `st-agent st-agent-${k}` }, [icon(k, 'st-agent-icon'),
    el('div', {}, [el('strong', { text: name }), el('span', { text: note })]), el('i', { class: `st-led${on ? ' on' : ''}` })])));
  return el('section', { class: 'st-col st-left' }, [
    el('header', { class: 'st-col-head' }, [el('h2', { text: '1. Multi-agent chat & testing terminal' })]),
    el('div', { class: 'st-prompt' }, [el('span', { class: 'st-prompt-at', text: '@kinux' }), el('span', { text: lastAsk ? ` → ${lastAsk.tool.replace(/^kinux_/, '').replace(/_/g, ' ')}` : ' → ask from Claude Code: "verify this board"' })]),
    roster,
    filters,
    list,
  ]);
}

// --- centre: the design --------------------------------------------------------

function centre(state, ctx, views, parts, field) {
  const tabs = [
    views.schematic && ['schematic', '2D Schematics'],
    views.pcb && ['pcb', 'PCB Layout'],
    views.board3d && ['board3d', 'Multi-Physics Studio'],
  ].filter(Boolean);
  // Until the person picks, show the richest view the run has: 3D, with the heat field if one was solved.
  if (!ui.tabChosen || !tabs.some(([k]) => k === ui.tab)) ui.tab = tabs.at(-1)?.[0] ?? null;
  const range = field?.drawn ? fieldRange(field) : null;
  if (!ui.modeChosen || !range) ui.mode = range ? 'heat' : 'faults';
  const status = partStatus(state);
  const sel = ctx.selection ?? new Set();

  // Callouts: the hottest parts (from the field) or the parts with faults nobody caught.
  let callouts = [];
  if (ui.mode === 'heat' && range) {
    callouts = hottestParts(field, 4).map(p => ({ ref: p.ref, tone: p.peak_c >= range.max - 0.25 * (range.max - range.min) ? 'hot' : 'warm', text: `${p.ref} ${p.peak_c.toFixed(1)} °C · ${fmtW(p.watts)}` }));
  } else {
    const missed = new Map();
    for (const id of state.mutantOrder ?? []) { const m = state.mutants[id]; if (m.status === 'survived') missed.set(m.target, (missed.get(m.target) ?? 0) + 1); }
    callouts = [...missed].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ref, n]) => ({ ref, tone: 'bad', text: `${ref}: ${n} fault${n > 1 ? 's' : ''} not caught` }));
  }

  let stage;
  if (!parts) stage = el('p', { class: 'st-loading', text: 'Loading the design views…' });
  else if (ui.tab === 'board3d') {
    stage = studioStage({ glbUrl: ctx.artifactUrl(views.board3d), parts, field, range, mode: ui.mode, status, callouts, selection: sel, onSelect: ctx.onSelect });
  } else if (ui.tab === 'pcb') {
    let underlay = null;
    if (ui.mode === 'heat' && range && parts.pcb_outline) {
      if (!ui.pcbHeat) ui.pcbHeat = fieldCanvas(field, 'top', range).toDataURL();
      const { width: w, height: h } = field.board_mm;
      underlay = { href: ui.pcbHeat, x: field.board_mm.origin[0] - parts.pcb_outline.minX, y: field.board_mm.origin[1] - parts.pcb_outline.minY, w, h };
    }
    stage = el('div', { class: 'st2d' }, [view2d('pcb', ctx.artifactUrl(views.pcb), parts.pcb, status, sel, ctx, 'PCB', null, underlay)]);
  } else if (ui.tab === 'schematic') {
    stage = el('div', { class: 'st2d' }, [view2d('schematic', ctx.artifactUrl(views.schematic), parts.schematic, status, sel, ctx, 'Schematic')]);
  } else stage = el('p', { class: 'st-loading', text: 'This run has no design views (run it on a KiCad design to see the board).' });

  const modeBar = el('div', { class: 'st-modes' }, [
    range ? el('button', { type: 'button', class: `st-chip${ui.mode === 'heat' ? ' active' : ''}`, 'data-testid': 'studio-mode-heat', onclick: () => { ui.mode = 'heat'; ui.modeChosen = true; ctx.rerender?.(); } }, ['Heat field']) : null,
    el('button', { type: 'button', class: `st-chip${ui.mode === 'faults' ? ' active' : ''}`, 'data-testid': 'studio-mode-faults', onclick: () => { ui.mode = 'faults'; ui.modeChosen = true; ctx.rerender?.(); } }, ['Faults caught / missed']),
  ]);
  const legend = ui.mode === 'heat' && range ? colourBar(range)
    : el('div', { class: 'st-fault-legend' }, [['#f43f5e', 'fault not caught'], ['#2fd27a', 'all faults caught'], ['#8a8f98', 'not checked']]
      .map(([c, t]) => el('span', {}, [el('i', { style: `background:${c}` }), t])));
  return el('section', { class: 'st-col st-centre' }, [
    el('div', { class: 'st-tabs', role: 'tablist' }, [...tabs.map(([k, label]) => el('button', { type: 'button', role: 'tab', class: `st-tab${k === ui.tab ? ' active' : ''}`, 'data-testid': `studio-tab-${k}`,
      onclick: () => { ui.tab = k; ui.tabChosen = true; ctx.rerender?.(); } }, [label])),
      el('button', { type: 'button', role: 'tab', class: 'st-tab', disabled: true, title: 'Mechanics and motion (MuJoCo) are not connected to the studio yet' }, ['Robotics Sandbox'])]),
    el('header', { class: 'st-col-head st-col-head-centre' }, [el('h2', { text: ui.tab === 'board3d' ? '2. The 3D multi-physics studio' : ui.tab === 'pcb' ? '2. PCB' : '2. Schematic' })]),
    el('div', { class: 'st-stage-wrap' }, [stage, el('div', { class: 'st-stage-tools' }, [modeBar]), el('div', { class: 'st-stage-legend' }, [legend])]),
    field ? fieldNotes(field) : el('p', { class: 'st-foot', text: 'No temperature field in this run (run with --heat to solve one).' }),
  ]);
}

// --- right: instruments --------------------------------------------------------

function barChart(title, rows, { unit, colour, fmt }) {
  const W = 300, rowH = 16, H = rows.length * rowH + 6;
  const max = Math.max(...rows.map(r => r.value), 1e-12);
  const svg = svgEl('svg', { class: 'st-bars', viewBox: `0 0 ${W} ${H}`, width: '100%', preserveAspectRatio: 'xMinYMin meet' });
  rows.forEach((r, i) => {
    const y = 3 + i * rowH, w = Math.max(1, (r.value / max) * (W - 120));
    svg.append(svgEl('text', { x: 0, y: y + 11, class: 'st-bar-label', text: r.label }),
      svgEl('rect', { x: 44, y: y + 2, width: w, height: rowH - 5, rx: 2, fill: r.colour ?? colour }),
      svgEl('text', { x: 48 + w, y: y + 11, class: 'st-bar-value', text: fmt(r.value) }));
  });
  return el('div', { class: 'st-card', 'data-testid': 'studio-chart' }, [el('h3', { text: title }), svg, unit ? el('p', { class: 'st-card-note', text: unit }) : null]);
}

function waveChart(payload, i) {
  const W = 300, H = 110, P = 4;
  const xs = payload.x.values;
  const colours = ['#38bdf8', '#fb923c', '#7ee787', '#d2a8ff'];
  const all = payload.series.flatMap(s => s.values);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const x0 = xs[0], xspan = xs[xs.length - 1] - x0 || 1;
  const svg = svgEl('svg', { class: 'st-wave', viewBox: `0 0 ${W} ${H}`, width: '100%' });
  for (let g = 1; g < 4; g++) svg.append(svgEl('line', { x1: 0, x2: W, y1: (H * g) / 4, y2: (H * g) / 4, class: 'st-grid' }));
  payload.series.slice(0, 4).forEach((s, k) => {
    const pts = s.values.map((v, j) => `${(((xs[j] - x0) / xspan) * (W - 2 * P) + P).toFixed(1)},${(H - P - ((v - lo) / span) * (H - 2 * P)).toFixed(1)}`).join(' ');
    svg.append(svgEl('polyline', { points: pts, fill: 'none', stroke: colours[k], 'stroke-width': 1.3 }));
  });
  return el('div', { class: 'st-card', 'data-testid': 'studio-wave' }, [
    el('h3', { text: `Waveform ${i + 1} · ${payload.analysis}` }), svg,
    el('p', { class: 'st-card-note' }, payload.series.slice(0, 4).map((s, k) => el('span', { class: 'st-key' }, [el('i', { style: `background:${colours[k]}` }), `${s.name} ${lo.toPrecision(3)}…${hi.toPrecision(3)} ${s.unit}`]))),
  ]);
}

function instruments(state, ctx, field) {
  const cards = [];
  const s = state.score;
  const tele = [
    ['Mutation score', s ? (s.score === null ? '—' : `${(s.score * 100).toFixed(1)}%`) : 'running', s?.cap?.bites ? `capped at ${(s.cap.applied_at * 100).toFixed(0)}%` : null],
    ['Faults caught', s ? `${s.killed} / ${s.killed + s.survived}` : `${Object.values(state.mutants).filter(m => m.status === 'killed').length}`, null],
    ['Hottest point', field?.drawn ? `${field.peak_c.toFixed(1)} °C` : '—', field?.drawn ? 'CalculiX' : 'no field'],
    ['Board power', field?.power_source?.balance ? fmtW(field.total_w) : '—', field?.power_source?.balance ? 'ngspice' : null],
  ];
  cards.push(el('div', { class: 'st-card st-tele', 'data-testid': 'studio-telemetry' }, [el('h3', { text: 'Telemetry outputs' }),
    el('div', { class: 'st-tele-grid' }, tele.map(([k, v, note]) => el('div', { class: 'st-tele-item' }, [el('span', { class: 'st-tele-k', text: k }), el('strong', { text: v }), note ? el('span', { class: `st-tele-n${/capped/.test(note) ? ' warn' : ''}`, text: note }) : null])))]));

  // Waveforms the run recorded (transient blocks).
  const waves = state.artifacts.filter(a => a.kind === 'waveform' && a.mime === 'application/json');
  waves.slice(0, 3).forEach((a, i) => {
    const p = ctx.artifactUrl ? loaded(ctx.artifactUrl(a), ctx) : undefined;
    if (p?.series?.length) cards.push(waveChart(p, i));
  });
  if (!waves.length) cards.push(el('p', { class: 'st-foot', text: 'No waveforms: this suite has no transient (tran) block, so there is no signal over time to plot.' }));

  if (field?.drawn) {
    const hot = Object.entries(field.parts).sort((a, b) => b[1].peak_c - a[1].peak_c).slice(0, 8);
    cards.push(barChart('Peak temperature per part', hot.map(([ref, p]) => ({ label: ref, value: p.peak_c - field.inputs.ambient_c.value, colour: '#fb923c' })),
      { unit: `rise above ${field.inputs.ambient_c.value} °C ambient, K — CalculiX`, fmt: v => `+${v.toFixed(2)} K` }));
  }
  if (field?.power_w) {
    const pw = Object.entries(field.power_w).filter(([, p]) => p.watts > 0).sort((a, b) => b[1].watts - a[1].watts).slice(0, 8);
    if (pw.length) cards.push(barChart('Power per part', pw.map(([ref, p]) => ({ label: ref, value: p.watts, colour: p.note ? '#8a8f98' : '#38bdf8' })),
      { unit: `ngspice, ${field.power_source.analysis}; grey = a stand-in model`, fmt: fmtW }));
  }
  const perPart = new Map();
  for (const id of state.mutantOrder ?? []) {
    const m = state.mutants[id];
    const r = perPart.get(m.target) ?? { caught: 0, missed: 0 };
    if (m.status === 'killed') r.caught += 1; else if (m.status === 'survived') r.missed += 1;
    perPart.set(m.target, r);
  }
  const worst = [...perPart].filter(([, r]) => r.missed).sort((a, b) => b[1].missed - a[1].missed).slice(0, 8);
  if (worst.length) cards.push(barChart('Faults not caught, per part', worst.map(([ref, r]) => ({ label: ref, value: r.missed, colour: '#f43f5e' })), { unit: 'injected by the Fault Inspector, judged by ngspice', fmt: v => String(v) }));

  return el('section', { class: 'st-col st-right' }, [
    el('header', { class: 'st-col-head' }, [el('h2', { text: '3. Physics instrumentation & telemetry' })]),
    el('div', { class: 'st-cards' }, cards),
  ]);
}

/** The three studio columns for a run. */
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
  return el('main', { class: 'studio', 'data-testid': 'studio' }, [
    terminal(state, ctx, field ?? null),
    centre(state, ctx, views, parts ?? null, field ?? null),
    instruments(state, ctx, field ?? null),
  ]);
}

