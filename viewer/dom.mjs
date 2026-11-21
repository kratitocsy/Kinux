// Small hand-written DOM helpers. No framework, no dependencies.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * THE provenance badge. Every panel gets one; it is never optional and never
 * hidden. A synthetic or mixed panel is marked loudly, because the project's
 * credibility rests on nobody mistaking a synthetic number for a measurement.
 */
export function provenanceBadge(badge, { panel, compact = false } = {}) {
  const level = badge.level ?? 'unknown';
  const node = el('span', {
    class: `prov prov-${level}${badge.mixed ? ' prov-mixed' : ''}${compact ? ' prov-compact' : ''}`,
    'data-provenance': level,
    'data-panel': panel || '',
    'data-mixed': badge.mixed ? 'true' : 'false',
    'data-testid': panel ? `provenance-${panel}` : 'provenance',
    title: provenanceTitle(badge),
  }, [
    el('span', { class: 'prov-dot' }),
    el('span', { class: 'prov-label', text: badge.label }),
  ]);
  return node;
}

export function provenanceTitle(badge) {
  const parts = [];
  if (badge.level === null) parts.push('No events have fed this panel yet.');
  if (badge.level === 'synthetic') parts.push('SYNTHETIC: no solver produced these numbers. They are made up to exercise the format.');
  if (badge.level === 'recorded') parts.push('RECORDED: replayed from an earlier real run, not measured now.');
  if (badge.level === 'real') parts.push('REAL: produced by a solver in this run.');
  if (badge.mixed) {
    parts.push(`Mixed sources — the weakest is shown. real ${badge.counts.real}, recorded ${badge.counts.recorded}, synthetic ${badge.counts.synthetic}.`);
  }
  return parts.join(' ');
}

/** A banner spelling out, in words, that a panel's data is not measured. */
export function provenanceNotice(badge) {
  if (badge.level === 'real' && !badge.mixed) return null;
  let text;
  if (badge.level === null) text = 'No data has reached this panel.';
  else if (badge.level === 'synthetic') text = 'Synthetic data — no solver ran. Nothing on this panel is a measurement.';
  else if (badge.level === 'recorded') text = 'Recorded data — replayed from an earlier run, not measured now.';
  else text = 'Mixed sources on this panel — the weakest label applies.';
  if (badge.mixed && badge.level !== null) {
    text += ` (real ${badge.counts.real}, recorded ${badge.counts.recorded}, synthetic ${badge.counts.synthetic})`;
  }
  return el('div', { class: `prov-notice prov-notice-${badge.level ?? 'unknown'}`, 'data-testid': 'prov-notice', text });
}

export function panelShell({ index, title, subtitle, badge, panel }) {
  const body = el('div', { class: 'panel-body' });
  const head = el('header', { class: 'panel-head' }, [
    el('div', { class: 'panel-title' }, [
      el('span', { class: 'panel-index', text: String(index) }),
      el('h2', { text: title }),
    ]),
    provenanceBadge(badge, { panel }),
  ]);
  const root = el('section', { class: 'panel', 'data-panel': panel }, [head]);
  if (subtitle) root.appendChild(el('p', { class: 'panel-sub', text: subtitle }));
  const notice = provenanceNotice(badge);
  if (notice) root.appendChild(notice);
  root.appendChild(body);
  return { root, body };
}

export function section(title, children, attrs = {}) {
  return el('div', Object.assign({ class: 'sec' }, attrs), [
    el('h3', { class: 'sec-title', text: title }),
    ...[].concat(children).filter(Boolean),
  ]);
}

export function kv(pairs) {
  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: v === null || v === undefined || v === '' ? '—' : String(v) }));
  }
  return dl;
}

/** A plainly-worded placeholder for something that is not built yet. */
export function placeholder(title, lines, { phase } = {}) {
  return el('div', { class: 'placeholder', 'data-testid': 'placeholder' }, [
    el('div', { class: 'placeholder-mark', text: 'NOT WIRED' }),
    el('h4', { text: title }),
    ...[].concat(lines).map(t => el('p', { text: t })),
    phase ? el('p', { class: 'placeholder-phase', text: phase }) : null,
  ]);
}

export function fmtPct(x, digits = 1) {
  return x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`;
}

export function fmtNum(x, digits = 3) {
  if (x === null || x === undefined) return '—';
  if (typeof x !== 'number') return String(x);
  return Number.isInteger(x) ? String(x) : x.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

export function shortHash(h) {
  return typeof h === 'string' && h.startsWith('sha256:') ? h.slice(7, 19) : (h ?? '—');
}

export function timeOf(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(11, 19);
}
