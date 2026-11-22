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

let activityNode = null;

/** One line of activity, as text: the agent's action, then Kinux's decision. */
export function describeActivity(a) {
  const r = a.result ?? {};
  const args = a.arguments ?? {};
  if (a.tool === 'kinux_propose') {
    const what = args.kind === 'citation' ? `cites ${args.doc}: "${String(args.quote ?? '').slice(0, 80)}"`
      : args.kind === 'fact' ? `fact ${args.claim} ${args.ref ?? args.net ?? ''}`
      : args.kind === 'measurement' ? `asks ngspice for ${args.probe}${args.sources ? ` with ${Object.entries(args.sources).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}`
      : args.kind === 'finding' ? `finding [${args.severity}] ${args.title}`
      : `question: ${String(args.text ?? '').slice(0, 100)}`;
    const verdict = r.status === 'verified'
      ? `verified${r.measured !== undefined ? `: ngspice measured ${r.measured}` : r.cited_line ? ` at ${r.cited_line}` : ''}`
      : r.status === 'open' ? 'recorded as an open question for a person' : `rejected: ${r.reason ?? r.message ?? ''}`;
    return { agent: `Reviewer${args.domain ? ` (${args.domain})` : ''}`, action: `${r.id ?? ''} ${what}`.trim(), decision: verdict, ok: r.status !== 'rejected' };
  }
  const name = a.tool.replace(/^kinux_/, '').replace(/_/g, ' ');
  if (a.isError) return { agent: 'Builder', action: name, decision: `refused: ${r.message ?? r.error ?? ''}`, ok: false };
  const decision = r.score_text ? `score ${r.score_text}${r.survivors !== undefined ? `; ${r.survivors} faults survived` : ''}`
    : r.run_id ? `run ${r.run_id} ${r.state ?? ''}`.trim() : r.proposals !== undefined ? `${r.proposals} proposals: ${r.verified} verified, ${r.rejected} rejected, ${r.open} open` : '';
  return { agent: a.role === 'reviewer' ? 'Reviewer' : 'Builder', action: name, decision, ok: true };
}

function agentActivity(url) {
  if (activityNode) return activityNode;
  const list = el('ol', { class: 'activity-list', 'data-testid': 'activity-list' });
  activityNode = el('div', { class: 'sec activity', 'data-testid': 'agent-activity', hidden: true }, [
    el('h3', { class: 'sec-title', text: 'Agent activity (MCP)' }),
    el('p', { class: 'muted', text: 'What the attached coding agent asked for, and what Kinux decided. Recorded by the Kinux server, not by the agent.' }),
    list,
  ]);
  let seen = -1;
  const poll = () => fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(items => {
    if (!Array.isArray(items) || items.length === seen) return;
    seen = items.length;
    activityNode.hidden = items.length === 0;
    list.replaceChildren(...items.slice(-200).map(a => {
      const d = describeActivity(a);
      return el('li', { class: `activity-item${d.ok ? '' : ' activity-no'}`, 'data-testid': 'activity-item', 'data-tool': a.tool }, [
        el('div', { class: 'log-meta' }, [el('span', { class: 'log-time', text: timeOf(a.ts) }), el('span', { class: 'chip chip-builder', text: d.agent })]),
        el('div', { class: 'log-text', text: d.action }),
        d.decision ? el('div', { class: 'activity-decision' }, [el('span', { class: 'chip chip-solver', text: 'Kinux' }), ` ${d.decision}`]) : null,
      ]);
    }));
  }).catch(() => {});
  poll();
  setInterval(poll, 3000);
  return activityNode;
}

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

  // What the attached coding agent did over MCP, and what Kinux decided about
  // it (mcp/server.mjs keeps this record itself). Only when served by an MCP server.
  if (ctx.activityUrl) body.appendChild(agentActivity(ctx.activityUrl));

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
