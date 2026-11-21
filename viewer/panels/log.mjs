// Panel 1 — the run log, rendered as a conversation between the actors that
// produced the run: builder, villain, solver, human, system.
//
// Every line is one event from the ordered stream. Nothing is summarised away
// and nothing is invented: the text of each line is derived in reducer.mjs
// from that event's own fields, and each line carries its own provenance.

import { el, panelShell, provenanceBadge, timeOf } from '../dom.mjs';
import { badgeFor } from '../reducer.mjs';

const ACTOR_LABEL = {
  builder: 'Builder',
  villain: 'Villain',
  solver: 'Solver',
  human: 'Human',
  system: 'System',
};

export function renderLogPanel(state, ctx = {}) {
  const selection = ctx.selection instanceof Set ? ctx.selection : new Set();
  const badge = badgeFor(state, 'log');
  const { root, body } = panelShell({
    index: 1,
    title: 'Run log — multi-agent terminal',
    subtitle: `${state.log.length} events, in order. Each line is one event; the chip is its actor.`,
    badge,
    panel: 'log',
  });

  const filterBar = el('div', { class: 'log-filter' });
  const counts = {};
  for (const e of state.log) counts[e.actor] = (counts[e.actor] || 0) + 1;
  for (const kind of ['builder', 'villain', 'solver', 'human', 'system']) {
    filterBar.appendChild(el('span', { class: `chip chip-${kind}`, 'data-actor-count': kind }, [
      el('span', { class: 'chip-name', text: ACTOR_LABEL[kind] }),
      el('span', { class: 'chip-count', text: String(counts[kind] || 0) }),
    ]));
  }
  body.appendChild(filterBar);

  const list = el('ol', { class: 'log-list', 'data-testid': 'log-list' });
  for (const entry of state.log) {
    const hit = entry.refs.some(r => selection.has(r));
    const item = el('li', {
      class: `log-item sev-${entry.severity}${hit ? ' selected' : ''}`,
      'data-seq': String(entry.seq),
      'data-actor': entry.actor,
      'data-type': entry.type,
      'data-refs': entry.refs.join(' '),
      'data-selected': hit ? 'true' : 'false',
      'data-testid': 'log-item',
      onclick: () => {
        if (ctx.onSelect) ctx.onSelect(entry.refs[0] ?? null);
      },
    }, [
      el('div', { class: 'log-meta' }, [
        el('span', { class: 'log-seq', text: `#${entry.seq}` }),
        el('span', { class: 'log-time', text: timeOf(entry.ts) }),
        el('span', { class: `chip chip-${entry.actor}`, text: ACTOR_LABEL[entry.actor] || entry.actor }),
        el('span', { class: 'log-actor-id', text: entry.actorId }),
        provenanceBadge({ level: entry.provenance, mixed: false, counts: {}, label: entry.provenance.toUpperCase() }, { compact: true }),
      ]),
      el('div', { class: 'log-text', text: entry.text }),
    ]);
    list.appendChild(item);
  }
  body.appendChild(list);

  if (state.problems.length) {
    body.appendChild(el('div', { class: 'problems', 'data-testid': 'log-problems' }, [
      el('h4', { text: `${state.problems.length} contract problem(s) seen while reducing` }),
      el('ul', {}, state.problems.map(p => el('li', { text: p }))),
    ]));
  }

  return root;
}
