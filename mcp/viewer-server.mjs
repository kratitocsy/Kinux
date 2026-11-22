// A local web server for the MCP server's runs: the viewer, and each run's
// files (events, report, KiCad views, waveforms, renders), so a person who
// attached Kinux to their coding agent can open what the agent ran.
//
// Bound to 127.0.0.1 only. Everything lives under /t/<token>/, a random token
// in the PATH (not a query string), so the viewer's relative links to a run's
// views and waveforms keep it; a request without the token is a 404. Only the
// viewer's own files and files inside a run's folder can be read: run ids are
// checked, paths are resolved and contained, nothing is listed, nothing is
// written.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8',
  '.webp': 'image/webp',
};
const RUN_ID = /^r[0-9a-f]{8}$/;

function inside(root, rel) {
  const target = resolve(root, rel);
  return target === root || target.startsWith(root + sep) ? target : null;
}

export async function startViewerServer({ runsDir, viewerRoot, port = 0 }) {
  const token = randomBytes(18).toString('base64url');
  const runsRoot = resolve(runsDir);
  const viewRoot = resolve(viewerRoot);
  const server = createServer((req, res) => {
    const notFound = () => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return notFound(); }
    if (path.includes('\0')) return notFound();
    const prefix = `/t/${token}/`;
    if (!path.startsWith(prefix)) return notFound();
    const rest = path.slice(prefix.length);
    let file = null;
    if (rest === 'viewer' || rest === 'viewer/') file = join(viewRoot, 'index.html');
    else if (rest.startsWith('viewer/')) file = inside(viewRoot, rest.slice('viewer/'.length));
    else {
      const m = /^runs\/([^/]+)\/(.+)$/.exec(rest);
      if (m && RUN_ID.test(m[1])) { const runRoot = join(runsRoot, m[1]); file = inside(runRoot, m[2]); }
    }
    if (!file || !existsSync(file) || !statSync(file).isFile()) return notFound();
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': body.length,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  const base = `http://127.0.0.1:${server.address().port}/t/${token}`;
  return {
    base,
    viewerUrl: runId => `${base}/viewer/index.html?run=${encodeURIComponent(`../runs/${runId}/events.jsonl`)}`,
    fileUrl: (runId, rel) => `${base}/runs/${runId}/${rel}`,
    close: () => new Promise(ok => server.close(() => ok())),
  };
}
