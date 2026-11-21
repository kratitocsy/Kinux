// Panel 3 — instrumentation.
//
// Three things, all drawn by hand with inline SVG (no chart library):
//   * measurements from the solver results that actually arrived,
//   * the mutation table (operator, status, killed_by),
//   * the score with its checkable fraction and Wilson 95% interval.
//
// NOT_CHECKED and ERROR are shown as what they are. They are never drawn as a
// point on a chart, never styled as a pass, and never counted in the score.

import { el, svgEl, panelShell, section, placeholder, fmtPct, fmtNum, shortHash } from '../dom.mjs';
import { badgeFor, measurementSeries, mutationRows } from '../reducer.mjs';

const VERDICT_CLASS = {
  PASS: 'v-pass',
  FAIL: 'v-fail',
  NOT_CHECKED: 'v-notchecked',
  ERROR: 'v-error',
};

const STATUS_LABEL = {
  killed: 'killed',
  survived: 'survived',
  not_checked: 'not checked',
  equivalent: 'equivalent',
  error: 'error',
};

export function renderInstrumentsPanel(state, ctx = {}) {
  const selection = ctx.selection instanceof Set ? ctx.selection : new Set();
  const badge = badgeFor(state, 'instruments');
  const { root, body } = panelShell({
    index: 3,
    title: 'Instrumentation',
    subtitle: 'Measurements, mutants and the score. Charts are drawn from event data only.',
    badge,
    panel: 'instruments',
  });

  body.appendChild(instMeasurements(state, selection, ctx));
  body.appendChild(instWaveforms(state, ctx));
  body.appendChild(instMutationTable(state, selection, ctx));
  body.appendChild(instScore(state, badge));

  return root;
}

// --- measurements ----------------------------------------------------------

function instMeasurements(state, selection, ctx) {
  const series = measurementSeries(state);
  const wrap = el('div', { class: 'charts', 'data-testid': 'measurement-charts' });
  if (series.length === 0) {
    wrap.appendChild(el('p', { class: 'muted', text: 'No tests have been queued in this run.' }));
  }
  for (const s of series) {
    wrap.appendChild(instStrip(s, selection, ctx));
  }
  return section('Measurements per check', [
    el('p', { class: 'muted', text: 'One strip per check. Each marker is one test.result measurement, placed on the measured axis. Results with no number (NOT_CHECKED, ERROR) are listed beside the strip, never plotted.' }),
    wrap,
  ]);
}

function instStrip(s, selection, ctx) {
  const W = 420, H = 64, L = 56, R = 16, T = 22, B = 18;
  const values = s.points.map(p => p.measured);
  if (typeof s.test.results.baseline?.limit === 'number') values.push(s.test.results.baseline.limit);
  let min = values.length ? Math.min(...values) : 0;
  let max = values.length ? Math.max(...values) : 1;
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.12;
  min -= pad; max += pad;
  const x = v => L + ((v - min) / (max - min)) * (W - L - R);

  const svg = svgEl('svg', {
    class: 'strip', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
    role: 'img', 'data-testid': 'measurement-strip', 'data-test-id': s.test.test_id,
    'aria-label': `${s.test.test_id} ${s.test.title ?? ''}`,
  });
  svg.appendChild(svgEl('text', { x: 4, y: 12, class: 'strip-title', text: `${s.test.test_id} · ${s.test.title ?? ''}` }));
  svg.appendChild(svgEl('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'axis' }));
  svg.appendChild(svgEl('text', { x: L, y: H - 5, class: 'tick', text: fmtNum(min, 2) }));
  svg.appendChild(svgEl('text', { x: W - R, y: H - 5, class: 'tick', 'text-anchor': 'end', text: `${fmtNum(max, 2)}${s.units ? ' ' + s.units : ''}` }));

  for (const p of s.points) {
    const cx = x(p.measured);
    const isBaseline = p.subject === 'baseline';
    const hit = selection.has(p.subject) || selection.has(p.test_id);
    const g = svgEl('g', {
      class: `pt ${VERDICT_CLASS[p.verdict]}${isBaseline ? ' pt-baseline' : ''}${hit ? ' selected' : ''}`,
      'data-subject': p.subject, 'data-verdict': p.verdict, 'data-testid': 'measurement-point',
      'data-selected': hit ? 'true' : 'false',
    });
    g.appendChild(svgEl('title', { text: `${p.subject}: ${p.measured}${p.units ? ' ' + p.units : ''} → ${p.verdict}` }));
    if (isBaseline) {
      g.appendChild(svgEl('path', { d: `M ${cx} ${H - B - 20} L ${cx} ${H - B}`, class: 'pt-stem' }));
      g.appendChild(svgEl('rect', { x: cx - 4, y: H - B - 24, width: 8, height: 8, class: 'pt-mark' }));
    } else {
      g.appendChild(svgEl('circle', { cx, cy: H - B - 10, r: 4, class: 'pt-mark' }));
    }
    svg.appendChild(g);
  }

  const gaps = el('div', { class: 'gaps' }, s.gaps.map(r => el('span', {
    class: `gap ${VERDICT_CLASS[r.verdict]}`,
    'data-subject': r.subject,
    'data-verdict': r.verdict,
    'data-testid': 'measurement-gap',
    text: `${r.subject}: ${r.verdict}${r.reason_code ? ` (${r.reason_code})` : ''}`,
    title: r.reason ?? '',
  })));

  return el('div', {
    class: `strip-wrap${selection.has(s.test.test_id) ? ' selected' : ''}`,
    'data-test': s.test.test_id,
    'data-selected': selection.has(s.test.test_id) ? 'true' : 'false',
    'data-testid': 'strip-wrap',
    onclick: () => ctx.onSelect && ctx.onSelect(s.test.test_id),
  }, [svg, s.test.stale ? el('div', { class: 'stale-flag', text: 'STALE — predates the current design hash' }) : null, gaps]);
}

// --- waveforms -------------------------------------------------------------

function instWaveforms(state, ctx) {
  const waves = state.artifacts.filter(a => a.kind === 'waveform');
  const samples = ctx.waveforms || {};
  const items = [];
  if (waves.length === 0) {
    items.push(el('p', { class: 'muted', text: 'This run emitted no waveform artifact.' }));
  }
  for (const a of waves) {
    const data = samples[a.artifact_id];
    items.push(el('div', { class: 'wave', 'data-artifact': a.artifact_id, 'data-testid': 'waveform' }, [
      el('div', { class: 'wave-head' }, [
        el('code', { text: a.artifact_id }),
        el('span', { class: 'muted', text: ` ${a.uri} · ${a.bytes} B · ${shortHash(a.sha256)}` }),
        el('span', { class: `prov prov-${a.provenance} prov-compact` }, [el('span', { class: 'prov-label', text: a.provenance.toUpperCase() })]),
      ]),
      data && data.length
        ? instTrace(data)
        : el('div', {
            class: 'wave-missing', 'data-testid': 'waveform-missing',
            text: 'Payload not loaded. The viewer has the artifact hash and size from the event, but not its samples, so no trace is drawn.',
          }),
    ]));
  }
  return section('Waveforms', items);
}

function instTrace(data) {
  const W = 420, H = 110, L = 36, R = 8, T = 8, B = 16;
  let min = Infinity, max = -Infinity;
  for (const v of data) { if (v < min) min = v; if (v > max) max = v; }
  if (min === max) { min -= 1; max += 1; }
  const x = i => L + (i / Math.max(1, data.length - 1)) * (W - L - R);
  const y = v => T + (1 - (v - min) / (max - min)) * (H - T - B);
  let d = '';
  for (let i = 0; i < data.length; i++) d += `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(data[i]).toFixed(2)} `;
  return svgEl('svg', { class: 'trace', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, 'data-testid': 'waveform-trace' }, [
    svgEl('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'axis' }),
    svgEl('line', { x1: L, y1: T, x2: L, y2: H - B, class: 'axis' }),
    svgEl('text', { x: 2, y: T + 8, class: 'tick', text: fmtNum(max, 2) }),
    svgEl('text', { x: 2, y: H - B, class: 'tick', text: fmtNum(min, 2) }),
    svgEl('path', { d: d.trim(), class: 'trace-line' }),
  ]);
}

// --- mutation table --------------------------------------------------------

function instMutationTable(state, selection, ctx) {
  const rows = mutationRows(state);
  const table = el('table', { class: 'mut-table', 'data-testid': 'mutation-table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Mutant' }),
      el('th', { text: 'Operator' }),
      el('th', { text: 'Target' }),
      el('th', { text: 'Origin' }),
      el('th', { text: 'Status' }),
      el('th', { text: 'Killed by' }),
    ])),
  ]);
  const tbody = el('tbody');
  if (rows.length === 0) {
    tbody.appendChild(el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'No mutation results in this run.' })));
  }
  for (const m of rows) {
    const hit = selection.has(m.mutant_id) || selection.has(m.target);
    const tr = el('tr', {
      class: `mut mut-${m.status}${hit ? ' selected' : ''}`,
      'data-mutant': m.mutant_id,
      'data-status': m.status,
      'data-selected': hit ? 'true' : 'false',
      'data-testid': 'mutation-row',
      tabindex: '0',
      onclick: () => ctx.onSelect && ctx.onSelect(m.mutant_id),
    }, [
      el('td', {}, el('code', { text: m.mutant_id })),
      el('td', { text: m.description }),
      el('td', {}, el('code', { text: m.target })),
      el('td', { text: m.origin }),
      el('td', {}, el('span', { class: `status status-${m.status}`, 'data-testid': 'mutation-status', text: STATUS_LABEL[m.status] })),
      el('td', {}, m.killed_by.length
        ? m.killed_by.map(t => el('code', { class: 'killer', 'data-killer': t, text: t }))
        : el('span', { class: 'muted', text: '—' })),
    ]);
    tbody.appendChild(tr);

    // Per-mutant check rows: these are the "checks" that cross-panel selection
    // highlights. Each is one test.result event.
    if (hit) {
      for (const c of m.checks) {
        tbody.appendChild(el('tr', {
          class: `check-row selected ${VERDICT_CLASS[c.verdict]}`,
          'data-check': `${c.test_id}|${c.subject}`,
          'data-verdict': c.verdict,
          'data-selected': 'true',
          'data-testid': 'check-row',
        }, [
          el('td', { text: '' }),
          el('td', { colspan: 5 }, [
            el('code', { text: c.test_id }),
            ` ${state.tests[c.test_id]?.title ?? ''} → `,
            el('span', { class: `verdict ${VERDICT_CLASS[c.verdict]}`, 'data-verdict': c.verdict, text: c.verdict }),
            c.measured !== null ? ` ${fmtNum(c.measured)}${c.units ? ' ' + c.units : ''}` : '',
            c.reason_code ? ` (${c.reason_code}${c.reason ? ': ' + c.reason : ''})` : '',
          ]),
        ]));
      }
    }
  }
  table.appendChild(tbody);

  return section('Mutation table', [
    table,
    el('p', { class: 'muted', text: 'Click a row to select a mutant: its target in the design panel, its checks and its log lines all highlight. A mutant counts as killed only if the baseline passed the check and the mutant failed it.' }),
  ]);
}

// --- score -----------------------------------------------------------------

function instScore(state, badge) {
  const s = state.score;
  const d = state.derivedScore;
  const shown = s ?? d;
  if (!shown) {
    return section('Score', placeholder('No score yet', ['No mutation results and no run.score event have arrived.']));
  }
  const checkable = shown.killed + shown.survived;
  const disagreements = [];
  if (s && d) {
    for (const k of ['killed', 'survived', 'not_checked', 'equivalent', 'errors', 'total']) {
      if (s[k] !== d[k]) disagreements.push(`${k}: event says ${s[k]}, recomputed ${d[k]}`);
    }
    if (s.score !== null && d.score !== null && Math.abs(s.score - d.score) > 1e-9) {
      disagreements.push(`score: event says ${s.score}, recomputed ${d.score}`);
    }
  }

  const card = el('div', { class: 'score-card', 'data-testid': 'score-card' }, [
    el('div', { class: 'score-main' }, [
      el('div', { class: 'score-value', 'data-testid': 'score-value', text: shown.score === null ? 'null' : fmtPct(shown.score) }),
      el('div', { class: 'score-frac', 'data-testid': 'score-fraction', text: `${shown.killed} killed / ${checkable} checkable` }),
    ]),
    el('div', { class: 'score-side' }, [
      el('div', { 'data-testid': 'checkable-fraction', text: `Checkable fraction ${fmtPct(shown.checkable_fraction)} (${checkable} of ${shown.total} mutants)` }),
      el('div', { 'data-testid': 'wilson-ci', text: shown.ci_low === null ? 'Wilson 95% CI: n/a' : `Wilson 95% CI ${fmtPct(shown.ci_low)} – ${fmtPct(shown.ci_high)}` }),
    ]),
  ]);

  const excluded = el('ul', { class: 'excluded', 'data-testid': 'excluded-counts' }, [
    el('li', { 'data-excluded': 'not_checked', text: `not checked: ${shown.not_checked} — never counted as a pass or a kill` }),
    el('li', { 'data-excluded': 'equivalent', text: `equivalent: ${shown.equivalent} — excluded from the score` }),
    el('li', { 'data-excluded': 'errors', text: `errors: ${shown.errors} — excluded from the score` }),
  ]);

  return section('Score', [
    card,
    instCiBar(shown),
    excluded,
    el('p', { class: 'disclaimer', 'data-testid': 'disclaimer', text: 'Pre-check linter, not a certification. The score measures how many injected faults the checks caught — nothing more.' }),
    badge.level !== 'real'
      ? el('p', { class: 'prov-notice prov-notice-' + (badge.level ?? 'unknown'), 'data-testid': 'score-prov-warning', text: `This score is computed from ${badge.level ?? 'unknown'} events. It says nothing about any physical design.` })
      : null,
    disagreements.length
      ? el('div', { class: 'problems', 'data-testid': 'score-mismatch' }, [
          el('h4', { text: 'The run.score event disagrees with the mutation results' }),
          el('ul', {}, disagreements.map(x => el('li', { text: x }))),
        ])
      : null,
  ]);
}

function instCiBar(s) {
  const W = 420, H = 46, L = 8, R = 8, Y = 24;
  const x = p => L + p * (W - L - R);
  const kids = [
    svgEl('line', { x1: L, y1: Y, x2: W - R, y2: Y, class: 'axis' }),
    svgEl('text', { x: L, y: H - 4, class: 'tick', text: '0%' }),
    svgEl('text', { x: W - R, y: H - 4, class: 'tick', 'text-anchor': 'end', text: '100%' }),
  ];
  if (s.ci_low !== null) {
    kids.push(svgEl('rect', { x: x(s.ci_low), y: Y - 8, width: Math.max(1, x(s.ci_high) - x(s.ci_low)), height: 16, class: 'ci-band', 'data-testid': 'ci-band' }));
    kids.push(svgEl('line', { x1: x(s.ci_low), y1: Y - 12, x2: x(s.ci_low), y2: Y + 12, class: 'ci-end' }));
    kids.push(svgEl('line', { x1: x(s.ci_high), y1: Y - 12, x2: x(s.ci_high), y2: Y + 12, class: 'ci-end' }));
  }
  if (s.score !== null) {
    kids.push(svgEl('line', { x1: x(s.score), y1: Y - 14, x2: x(s.score), y2: Y + 14, class: 'ci-point' }));
  }
  kids.push(svgEl('text', { x: 0, y: 12, class: 'strip-title', text: 'Wilson 95% interval on the kill rate' }));
  return svgEl('svg', { class: 'ci', viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, 'data-testid': 'ci-chart' }, kids);
}
