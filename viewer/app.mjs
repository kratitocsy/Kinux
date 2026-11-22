// Kinux viewer shell: three panels, one event stream, a provenance badge on
// every panel and on the window title bar.
//
// No framework. Importing this module has no side effects; call bootstrap().

import { el, clear, provenanceBadge, provenanceNotice, shortHash, fmtPct } from './dom.mjs';
import { createStore, parseJSONL, sourceFromJSONL, sourceFromSSE, badgeFor, expandSelection, loadInto } from './reducer.mjs';
import { renderLogPanel } from './panels/log.mjs';
import { renderDesignPanel } from './panels/design.mjs';
import { renderInstrumentsPanel } from './panels/instruments.mjs';
import { renderStudio } from './studio.mjs';

export function createViewer(root, { waveforms = {}, onSelect, artifactUrl = null, activityUrl = null, layout = 'classic' } = {}) {
  let state = null;
  // 'studio' (one screen: terminal, design, instruments) needs the run's files; 'classic' is every event in full.
  let mode = layout === 'studio' && artifactUrl ? 'studio' : 'classic';
  let selectedId = null;

  const shell = el('div', { class: 'shell' });
  const titlebar = el('header', { class: 'titlebar' });
  const panels = el('main', { class: 'panels' });
  const statusbar = el('footer', { class: 'statusbar' });
  shell.append(titlebar, panels, statusbar);
  clear(root).appendChild(shell);

  function select(id) {
    selectedId = selectedId === id ? null : id;
    if (onSelect) onSelect(selectedId);
    render();
  }

  function render() {
    if (!state) return;
    const selection = expandSelection(state, selectedId);
    const ctx = { selection, selectedId, onSelect: select, waveforms, artifactUrl, activityUrl, rerender: () => render(), setLayout: k => { mode = k; render(); } };

    clear(titlebar);
    shell.classList.toggle('is-studio', mode === 'studio');
    const overall = badgeFor(state, 'overall');
    titlebar.append(...[
      el('div', { class: 'brand' }, [
        mode === 'studio' ? el('span', { class: 'brand-logo', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l9 5v10l-9 5-9-5V7zm0 2.3L5 8.2v7.6l7 3.9 7-3.9V8.2zM9 8h2v3.2L14 8h2.6l-3.4 3.6L17 16h-2.6l-2.7-3.1-.7.7V16H9z"/></svg>' }) : null,
        el('span', { class: 'brand-mark', text: 'Kinux' }),
        el('span', { class: 'brand-sub', text: mode === 'studio' ? 'Studio' : 'run viewer' }),
      ]),
      el('div', { class: 'run-id' }, [
        el('strong', { text: mode === 'studio' ? String(state.run.project ?? state.run.run_id ?? 'no run').split('/').pop() : state.run.project ?? state.run.run_id ?? 'no run' }),
        el('span', { class: 'muted', text: ` ${state.run.run_id ?? ''} · design ${shortHash(state.run.design_hash)} · ${state.eventCount} events` }),
      ]),
      artifactUrl ? el('div', { class: 'layout-switch', role: 'group' }, [['studio', 'Studio'], ['classic', 'All events']].map(([k, label]) =>
        el('button', { type: 'button', class: `layout-btn${mode === k ? ' active' : ''}`, 'data-testid': `layout-${k}`, onclick: () => { mode = k; render(); } }, [label]))) : null,
      el('div', { class: 'titlebar-prov' }, [
        el('span', { class: 'prov-caption', text: 'This run is' }),
        provenanceBadge(overall, { panel: 'overall' }),
      ]),
    ].filter(Boolean));
    const topNotice = provenanceNotice(overall);
    if (topNotice) {
      topNotice.dataset.testid = 'prov-notice-global';
      titlebar.appendChild(topNotice);
    }

    clear(panels);
    panels.className = mode === 'studio' ? 'panels-studio' : 'panels';
    if (mode === 'studio') panels.append(renderStudio(state, ctx));
    else panels.append(
      renderLogPanel(state, ctx),
      renderDesignPanel(state, ctx),
      renderInstrumentsPanel(state, ctx),
    );

    clear(statusbar);
    const f = state.run.finished;
    const score = state.score ?? state.derivedScore;
    statusbar.append(
      el('span', { class: 'status-dot ' + (f ? `st-${f.status}` : 'st-running') }),
      el('span', { class: 'status-text', 'data-testid': 'status-text', text: f ? `run ${f.status} — ${f.summary ?? ''}` : 'run in progress' }),
      el('span', { class: 'status-right', 'data-testid': 'status-score', text: score
        ? `score ${score.score === null ? 'null' : fmtPct(score.score)} · checkable ${fmtPct(score.checkable_fraction)} · ${score.total} mutants`
        : 'no score' }),
      el('span', { class: 'status-sel', 'data-testid': 'status-selection', text: selectedId ? `selected: ${selectedId}` : 'nothing selected' }),
    );
  }

  return {
    get state() { return state; },
    get selectedId() { return selectedId; },
    setState(next) { state = next; render(); },
    select,
    render,
  };
}

/** Mount a viewer over a finished array of events. Used by the static export. */
export function mountEvents(root, events, opts = {}) {
  const store = createStore();
  store.pushAll(events);
  const viewer = createViewer(root, opts);
  viewer.setState(store.state);
  return viewer;
}

/** Mount a viewer that follows a store as events arrive. */
export function mountStore(root, store, opts = {}) {
  const viewer = createViewer(root, opts);
  viewer.setState(store.state);
  store.subscribe(s => viewer.setState(s));
  return viewer;
}

/**
 * Page entry point.
 *   ?run=<url to events.jsonl>   replay a file (default: the contract fixture)
 *   ?sse=<url>                   follow a live stream
 * An exported, self-contained page sets globalThis.__KINUX_RUN__ instead and
 * never touches the network.
 */
export async function bootstrap(root = document.getElementById('app')) {
  const embedded = globalThis.__KINUX_RUN__;
  if (embedded && Array.isArray(embedded.events)) {
    return mountEvents(root, embedded.events, { waveforms: embedded.waveforms || {} });
  }
  const params = new URLSearchParams(globalThis.location?.search || '');
  const sse = params.get('sse');
  const runParam = params.get('run');
  const store = createStore();
  // Where the run's artifacts come from: by content hash from the live server
  // (with the same read-only token as the stream), or beside a replayed file.
  let artifactUrl = null;
  if (sse) {
    const token = new URL(sse, globalThis.location.href).searchParams.get('token');
    artifactUrl = a => `/artifacts/${String(a.sha256).replace(/^sha256:/, '')}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  } else if (runParam) {
    const base = new URL(runParam, globalThis.location.href);
    artifactUrl = a => new URL(a.uri, base).href;
  }
  // Served by an MCP server (mcp/viewer-server.mjs): its agent activity sits beside the runs.
  const activityUrl = runParam ? new URL('../activity.json', globalThis.location.href).href : null;
  const viewer = mountStore(root, store, { artifactUrl, activityUrl, layout: params.get('layout') ?? 'classic' });
  try {
    if (sse) {
      await loadInto(store, sourceFromSSE(sse));
    } else {
      const url = runParam || '../contracts/fixtures/valid-run.events.jsonl';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const events = parseJSONL(await res.text());
      await loadInto(store, sourceFromJSONL(events.map(e => JSON.stringify(e)).join('\n')));
    }
  } catch (err) {
    root.prepend(el('div', { class: 'load-error', 'data-testid': 'load-error', text: `Could not load the run: ${err.message}` }));
  }
  viewer.render();
  return viewer;
}
