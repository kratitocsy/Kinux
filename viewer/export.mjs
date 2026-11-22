// Static export (STEPS S1.4): write a finished run to ONE self-contained HTML
// file that opens from file:// with the network blocked.
//
// There is no build step in this project, so this is the whole bundler: the
// viewer's ES modules are concatenated in dependency order, their internal
// import lines removed and their `export ` keywords stripped, and the result
// is inlined as one classic script together with the CSS and the events.
// Nothing is fetched at runtime — no CDN, no font, no image, no XHR.
//
// Usage: node viewer/export.mjs <run.events.jsonl> <out.html>

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Dependency order. Every module here must be free of external imports. */
export const BUNDLE_MODULES = [
  'dom.mjs',
  'reducer.mjs',
  'thermal.mjs',
  'panels/log.mjs',
  'panels/board.mjs',
  'panels/design.mjs',
  'panels/instruments.mjs',
  'app.mjs',
];

const IMPORT_LINE = /^import[^;]*;[ \t]*$/gm;
const EXPORT_KEYWORD = /^export\s+(?=(?:const|let|var|function|async|class))/gm;

export function flattenModule(source, name) {
  const imports = source.match(IMPORT_LINE) || [];
  for (const line of imports) {
    if (!/from\s+['"]\.{1,2}\//.test(line)) {
      throw new Error(`${name}: external import cannot be inlined — ${line.trim()}`);
    }
  }
  return source.replace(IMPORT_LINE, '').replace(EXPORT_KEYWORD, '');
}

export function buildBundle(readModule = name => readFileSync(join(HERE, name), 'utf8')) {
  return BUNDLE_MODULES
    .map(name => `/* ---- ${name} ---- */\n${flattenModule(readModule(name), name)}`)
    .join('\n');
}

const safeJSON = value => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(new RegExp('\\u2028', 'g'), '\\u2028')
  .replace(new RegExp('\\u2029', 'g'), '\\u2029');

function weakest(events) {
  const rank = { synthetic: 0, recorded: 1, real: 2 };
  let out = null;
  for (const e of events) {
    if (!(e.provenance in rank)) continue;
    if (out === null || rank[e.provenance] < rank[out]) out = e.provenance;
  }
  return out;
}

/**
 * Build the self-contained HTML for a run.
 * @param {object[]} events  the run's events, in order
 * @param {object}   opts    { waveforms, css, bundle, generatedAt }
 */
export function exportRunHTML(events, opts = {}) {
  const css = opts.css ?? readFileSync(join(HERE, 'style.css'), 'utf8');
  const bundle = opts.bundle ?? buildBundle();
  const waveforms = opts.waveforms ?? {};
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const runId = events[0]?.run_id ?? 'unknown-run';
  const prov = weakest(events) ?? 'unknown';
  const payload = { events, waveforms, exportedAt: generatedAt, provenance: prov };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>Kinux run ${escapeHTML(runId)} (${escapeHTML(prov)})</title>
<style>
${css}
.export-note {
  margin: 0; padding: 6px 14px;
  background: #0e121a; border-bottom: 1px solid var(--line);
  font-family: var(--mono); font-size: 10.5px; color: var(--fg-faint);
}
</style>
</head>
<body>
<p class="export-note" data-testid="export-note">Static export of run ${escapeHTML(runId)} — ${events.length} events, provenance ${escapeHTML(prov)}. Exported ${escapeHTML(generatedAt)}. Self-contained: this file loads nothing from the network.</p>
<div id="app"></div>
<script type="application/json" id="kinux-run-events">${safeJSON(events).replace(/<\/script/gi, '<\\/script')}</script>
<script>
${bundle}
;(function () {
  globalThis.__KINUX_RUN__ = ${safeJSON(payload)};
  bootstrap(document.getElementById('app'));
})();
</script>
</body>
</html>
`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function exportRunFile(eventsPath, outPath, opts = {}) {
  const text = readFileSync(eventsPath, 'utf8');
  const events = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
  const html = exportRunHTML(events, opts);
  writeFileSync(outPath, html);
  return { outPath, bytes: Buffer.byteLength(html), events: events.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error('usage: node viewer/export.mjs <run.events.jsonl> <out.html>');
    process.exit(2);
  }
  const r = exportRunFile(input, output);
  console.log(`wrote ${r.outPath} — ${r.events} events, ${r.bytes} bytes, no network references`);
}
