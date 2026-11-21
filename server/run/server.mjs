// The Kinux run server: watch a verification run as it happens, or replay a
// finished one identically.
//
// Endpoints (see README.md):
//   GET  /                        200 with a real body. Never a redirect.
//   GET  /healthz                 liveness
//   GET  /runs                    run index
//   GET  /runs/:id                run summary
//   GET  /runs/:id/events         SSE, honours Last-Event-ID
//   GET  /runs/:id/events.jsonl   the whole append-only log
//   GET  /artifacts/:hash         artifact bytes by content hash
//   POST /runs                    create a run          (drive token)
//   POST /runs/:id/events         ingest events         (drive token)
//   POST /artifacts               store an artifact     (drive token)
//
// Two rules from PLAN.md section 8 are load-bearing for the Claude Code preview
// pane and are enforced here: `/` answers 200 with a body rather than redirecting,
// and the server binds IPv4 and IPv6 loopback on the same port.
//
// No npm dependencies: node:http and the standard library only.
import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { RunStore, HASH_RE, assertRunId } from './store.mjs';
import { Ingest, IngestError } from './ingest.mjs';
import { readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath, extname, sep as pathSep } from 'node:path';

/** Content types for the viewer's static files. ES modules must be served as
 *  JavaScript or the browser refuses to execute them. */
const VIEWER_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
});

export const SSE_RETRY_MS = 3000;
export const DEFAULT_HEARTBEAT_MS = 15000;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_PATHS = new Set(['/', '/healthz', '/favicon.ico']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Tokens: a view token reads, a drive token reads and writes.
// ---------------------------------------------------------------------------

export class TokenSet {
  #byToken = new Map();

  constructor(entries = []) { for (const e of entries) this.add(e); }

  /** @param {{token:string, scope:'view'|'drive', run_id?:string, expires_at?:number}} entry */
  add(entry) {
    const { token, scope } = entry ?? {};
    if (typeof token !== 'string' || token.length === 0) throw new TypeError('token must be a non-empty string');
    if (scope !== 'view' && scope !== 'drive') throw new TypeError(`scope must be view or drive, got ${scope}`);
    this.#byToken.set(token, {
      token,
      scope,
      run_id: entry.run_id ?? '*',
      expires_at: entry.expires_at ?? null,
    });
    return this;
  }

  get size() { return this.#byToken.size; }

  /** @returns {{ok:true, grant:object}|{ok:false, status:number, reason:string}} */
  verify(token, { method = 'GET', runId = null, now = Date.now() } = {}) {
    if (!token) return { ok: false, status: 401, reason: 'no_token' };
    const grant = this.#byToken.get(token);
    if (!grant) return { ok: false, status: 401, reason: 'unknown_token' };
    if (grant.expires_at !== null && grant.expires_at <= now) return { ok: false, status: 401, reason: 'token_expired' };
    // A view token can read and must not be able to write. Anything that is not a
    // read method needs a drive token, whatever the path.
    if (!READ_METHODS.has(method) && grant.scope !== 'drive') {
      return { ok: false, status: 403, reason: 'view_token_cannot_write' };
    }
    if (grant.run_id !== '*' && runId !== null && grant.run_id !== runId) {
      return { ok: false, status: 403, reason: 'token_not_scoped_to_run' };
    }
    return { ok: true, grant };
  }
}

/** Authorization: Bearer, X-Kinux-Token, ?token=, or the kinux_token cookie. */
export function tokenFromRequest(req, url) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const header = req.headers['x-kinux-token'];
  if (typeof header === 'string' && header) return header;
  const q = url?.searchParams?.get('token');
  if (q) return q;
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === 'kinux_token' && rest.length) return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// SSE framing. One function, used by the live route and by replay.mjs, so that a
// replay is byte-identical to the live stream.
// ---------------------------------------------------------------------------

/** The bytes of one event: `id:` so a client can resume, `event:`, `data:`, blank line. */
export function frameEvent(record) {
  return `id: ${record.seq}\nevent: ${record.type}\ndata: ${record.line}\n\n`;
}

/** The bytes written before any event. Identical live and on replay. */
export function framePreamble() {
  return `retry: ${SSE_RETRY_MS}\n\n`;
}

/** A comment line: keeps proxies from killing an idle stream, ignored by clients. */
export function frameHeartbeat() {
  return ': heartbeat\n\n';
}

/**
 * `Last-Event-ID` carries the seq of the last event the client actually got, so
 * the next event to send is seq + 1. Anything unparseable means "from the start".
 */
export function resumeFrom(lastEventId) {
  if (lastEventId === undefined || lastEventId === null || lastEventId === '') return 0;
  const n = Number(String(lastEventId).trim());
  if (!Number.isInteger(n) || n < 0) return 0;
  return n + 1;
}

/**
 * Stream a run to `out` as SSE. This is the single handler: the HTTP route and
 * replay.mjs both call it, which is what makes a replay byte-identical.
 *
 * @param {object} opts
 * @param {Ingest} opts.ingest
 * @param {string} opts.runId
 * @param {{write:(s:string)=>any, end:()=>any}} opts.out
 * @param {string|number|null} [opts.lastEventId]
 * @param {number} [opts.heartbeatMs]   0 disables heartbeats
 * @param {boolean} [opts.closeOnFinish] end the stream after run.finished (default true)
 * @returns {{stop:(end?:boolean)=>void, get sent():number, get closed():boolean}}
 */
export function streamRun({ ingest, runId, out, lastEventId = null, heartbeatMs = DEFAULT_HEARTBEAT_MS, closeOnFinish = true }) {
  assertRunId(runId);
  const store = ingest.store;
  let next = resumeFrom(lastEventId);
  let sent = 0;
  let closed = false;
  let timer = null;
  let unsubscribe = () => {};

  const stop = (end = true) => {
    if (closed) return;
    closed = true;
    if (timer) { clearInterval(timer); timer = null; }
    unsubscribe();
    if (end) { try { out.end(); } catch {} }
  };

  const write = text => {
    if (closed) return false;
    try { out.write(text); } catch { stop(false); return false; }
    return true;
  };

  const beat = () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (heartbeatMs > 0 && !closed) {
      timer = setInterval(() => { write(frameHeartbeat()); }, heartbeatMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  };

  // Send a record only when it is exactly the one we owe the client. That is what
  // makes a resume gap-free and duplicate-free: the backlog and the live feed go
  // through the same gate.
  const send = record => {
    if (closed || record.seq !== next) return;
    next = record.seq + 1;
    sent += 1;
    if (!write(frameEvent(record))) return;
    beat();
    if (closeOnFinish && record.type === 'run.finished') stop(true);
  };

  write(framePreamble());

  // Subscribe before reading the backlog. Both happen in this one synchronous
  // block, so no event can slip between them.
  unsubscribe = ingest.subscribe(runId, send);
  if (store.hasRun(runId)) for (const record of store.readFrom(runId, next)) send(record);
  beat();

  return {
    stop,
    get sent() { return sent; },
    get closed() { return closed; },
    get nextSeq() { return next; },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
};

const INDEX_HTML = runs => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kinux run server</title>
<style>
  :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  body { margin: 0; padding: 24px 16px; max-width: 70ch; }
  h1 { font-size: 1.2rem; margin: 0 0 4px; }
  p { line-height: 1.5; }
  code { background: rgba(127,127,127,.18); padding: 1px 4px; border-radius: 3px; }
  ul { padding-left: 1.2rem; }
</style></head>
<body>
<h1>Kinux run server</h1>
<p>Live and replayed verification runs. This page is served with a 200 and no
redirect so it loads in a preview pane.</p>
<h2>Runs</h2>
${runs.length ? `<ul>${runs.map(r => `<li><code>${r}</code> &mdash; <a href="/runs/${encodeURIComponent(r)}/events.jsonl">events.jsonl</a></li>`).join('')}</ul>` : '<p>No runs yet.</p>'}
<h2>Endpoints</h2>
<ul>
<li><code>GET /runs/:id/events</code> &mdash; SSE, resumable with <code>Last-Event-ID</code></li>
<li><code>GET /runs/:id/events.jsonl</code> &mdash; the whole append-only log</li>
<li><code>GET /artifacts/:hash</code> &mdash; artifact bytes by sha256</li>
</ul>
</body></html>
`;

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new IngestError('body too large', 'body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a request body as one JSON event, an array of them, or JSONL. */
export function parseEventBody(buf) {
  const text = buf.toString('utf8').trim();
  if (text === '') throw new IngestError('empty body', 'bad_event');
  if (text.startsWith('[')) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new IngestError('expected an array', 'bad_event');
    return arr;
  }
  if (text.startsWith('{') && !text.includes('\n')) return [JSON.parse(text)];
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}

/**
 * Build the run server.
 *
 * @param {object} opts
 * @param {string} [opts.root]       storage directory (required unless a store is given)
 * @param {RunStore} [opts.store]
 * @param {Ingest} [opts.ingest]
 * @param {TokenSet|Array} [opts.tokens]
 * @param {boolean} [opts.requireToken]  default true when any token is configured
 * @param {number} [opts.heartbeatMs]
 */
export function createRunServer(opts = {}) {
  const store = opts.store ?? new RunStore(opts.root);
  const ingest = opts.ingest ?? new Ingest({ store, validate: opts.validate });
  const tokens = opts.tokens instanceof TokenSet ? opts.tokens : new TokenSet(opts.tokens ?? []);
  const requireToken = opts.requireToken ?? tokens.size > 0;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  // Opt-in: a server only serves files when it is told which directory to serve.
  const viewerRoot = opts.viewerRoot ? resolvePath(opts.viewerRoot) : null;

  /** Serve one file from viewerRoot. Never escapes it, never lists it. */
  const serveViewerAsset = (res, method, path) => {
    let rel = path === '/viewer' || path === '/viewer/' ? 'index.html' : path.slice('/viewer/'.length);
    try { rel = decodeURIComponent(rel); } catch { return json(res, 400, { error: 'bad path encoding' }); }
    // Resolve, then require the result to sit strictly inside viewerRoot. This
    // catches "..", encoded "%2e%2e", absolute paths and NUL tricks in one check
    // rather than by enumerating bad spellings.
    const target = resolvePath(viewerRoot, rel);
    if (rel.includes('\0') || (target !== viewerRoot && !target.startsWith(viewerRoot + pathSep))) {
      return json(res, 404, { error: 'not found' });
    }
    let body;
    try {
      if (!statSync(target).isFile()) return json(res, 404, { error: 'not found' });
      body = readFileSync(target);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'content-type': VIEWER_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(method === 'HEAD' ? undefined : body);
  };

  const streams = new Set();
  const listeners = [];   // the http.Server instances, one per address family
  const sockets = new Set();
  let closing = false;

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Which run, if any, this request is about: needed before the token check so a
    // run-scoped token can be enforced.
    const runMatch = /^\/runs\/([^/]+)(\/events(?:\.jsonl)?)?\/?$/.exec(path);
    const runId = runMatch ? safeDecode(runMatch[1]) : null;

    // The viewer's own files are public: they are static code with no run data
    // in them. The data still arrives over the token-gated SSE route, so making
    // the page loadable without a token gives nothing away. GET and HEAD only --
    // a write to a /viewer path is not a viewer request and gets the gate.
    const isViewerAsset = viewerRoot !== null &&
      (method === 'GET' || method === 'HEAD') &&
      (path === '/viewer' || path.startsWith('/viewer/'));

    if (requireToken && !PUBLIC_PATHS.has(path) && !isViewerAsset) {
      const verdict = tokens.verify(tokenFromRequest(req, url), { method, runId });
      if (!verdict.ok) {
        res.setHeader('cache-control', 'no-store');
        if (verdict.status === 401) res.setHeader('www-authenticate', 'Bearer realm="kinux"');
        return json(res, verdict.status, { error: verdict.reason });
      }
      req.grant = verdict.grant;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, { allow: 'GET, HEAD, POST, OPTIONS', 'content-length': 0 });
      return res.end();
    }

    // GET /viewer/* -- the viewer served from the same origin as the stream, so
    // a browser can follow /runs/:id/events without any CORS header. Opening
    // CORS on a localhost server instead would invite any web page the user
    // visits to try reading it.
    if (isViewerAsset) return serveViewerAsset(res, method, path);

    // GET / -- 200 with a body, never a redirect (PLAN.md section 8).
    if (path === '/' && (method === 'GET' || method === 'HEAD')) {
      const body = INDEX_HTML(store.listRuns());
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      return res.end(method === 'HEAD' ? undefined : body);
    }
    if (path === '/healthz') return json(res, 200, { ok: true, runs: store.listRuns().length });
    if (path === '/favicon.ico') { res.writeHead(204, { 'content-length': 0 }); return res.end(); }

    if (path === '/runs' && (method === 'GET' || method === 'HEAD')) {
      return json(res, 200, { runs: store.listRuns().map(r => store.summary(r)) });
    }

    if (path === '/runs' && method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch { return json(res, 400, { error: 'bad_json' }); }
      try {
        ingest.open(body.run_id);
        return json(res, 201, store.summary(body.run_id));
      } catch (err) { return json(res, 400, { error: err.code ?? 'bad_request', message: err.message }); }
    }

    if (runMatch) {
      let valid = true;
      try { assertRunId(runId); } catch { valid = false; }
      if (!valid) return json(res, 400, { error: 'bad_run_id' });
      const tail = runMatch[2] ?? '';

      if (tail === '/events' && method === 'POST') {
        let events;
        try { events = parseEventBody(await readBody(req)); }
        catch (err) { return json(res, 400, { error: err.code ?? 'bad_json', message: err.message }); }
        try {
          ingest.open(runId);
          const records = ingest.submitMany(runId, events);
          return json(res, 202, { accepted: records.length, seqs: records.map(r => r.seq), next_seq: store.nextSeq(runId) });
        } catch (err) {
          return json(res, 422, { error: err.code ?? 'bad_event', message: err.message, problems: err.problems ?? [] });
        }
      }

      if (method !== 'GET' && method !== 'HEAD') return json(res, 405, { error: 'method_not_allowed' });
      if (!store.hasRun(runId)) {
        if (tail !== '/events') return json(res, 404, { error: 'no_such_run', run_id: runId });
      }

      if (tail === '') return json(res, 200, store.summary(runId));

      if (tail === '/events.jsonl') {
        const body = store.readLog(runId);
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        return res.end(method === 'HEAD' ? undefined : body);
      }

      if (tail === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        if (typeof res.socket?.setNoDelay === 'function') res.socket.setNoDelay(true);
        if (res.socket) res.socket.setTimeout(0);

        const lastEventId = req.headers['last-event-id'] ?? url.searchParams.get('last_event_id');
        const stream = streamRun({
          ingest,
          runId,
          out: res,
          lastEventId,
          heartbeatMs: url.searchParams.has('heartbeat_ms') ? Number(url.searchParams.get('heartbeat_ms')) : heartbeatMs,
          closeOnFinish: url.searchParams.get('follow') !== '1',
        });
        streams.add(stream);
        const drop = () => { streams.delete(stream); stream.stop(false); };
        res.on('close', drop);
        res.on('error', drop);
        return undefined;
      }
    }

    const artMatch = /^\/artifacts\/([^/]+)\/?$/.exec(path);
    if (artMatch && (method === 'GET' || method === 'HEAD')) {
      const raw = safeDecode(artMatch[1]);
      const hash = raw.startsWith('sha256:') ? raw : `sha256:${raw}`;
      if (!HASH_RE.test(hash)) return json(res, 400, { error: 'bad_hash' });
      const bytes = store.getArtifact(hash);
      if (!bytes) return json(res, 404, { error: 'no_such_artifact', hash });
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.length,
        etag: `"${hash}"`,
        // Content-addressed: the bytes under a hash can never change.
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return res.end(method === 'HEAD' ? undefined : bytes);
    }

    if (path === '/artifacts' && method === 'POST') {
      let buf;
      try { buf = await readBody(req); }
      catch (err) { return json(res, 413, { error: err.code ?? 'body_too_large' }); }
      const { hash, bytes } = store.putArtifact(buf);
      return json(res, 201, { hash, bytes, url: `/artifacts/${hash}` });
    }

    return json(res, 404, { error: 'not_found', path });
  };

  const onRequest = (req, res) => {
    handler(req, res).catch(err => {
      try { json(res, 500, { error: 'internal', message: String(err?.message ?? err) }); } catch {}
    });
  };

  const track = server => {
    server.on('connection', sock => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server.keepAliveTimeout = 5000;
    server.headersTimeout = 10000;
    server.requestTimeout = 0;      // an SSE stream is a long-lived request
    return server;
  };

  const listenOne = (server, port, host, extra = {}) => new Promise((resolve, reject) => {
    const onError = err => { server.removeListener('listening', onOk); reject(err); };
    const onOk = () => { server.removeListener('error', onError); resolve(server.address()); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen({ port, host, ...extra });
  });

  /**
   * Bind IPv4 and IPv6 loopback on the same port, as two listeners. PLAN.md
   * section 8 records hangs on IPv6-only binds, so IPv4 is bound first and gets
   * to pick the port; the IPv6 listener is ipv6Only so the two never collide.
   * Returns {port, addresses}.
   */
  const listen = async ({ port = 0, host = null, dualStack = true } = {}) => {
    if (host !== null || !dualStack) {
      const s = track(createHttpServer(onRequest));
      const addr = await listenOne(s, port, host ?? '127.0.0.1');
      listeners.push(s);
      return { port: addr.port, addresses: [addr.address] };
    }
    const v4 = track(createHttpServer(onRequest));
    const addresses = [];
    let chosen = port;
    try {
      const addr = await listenOne(v4, port, '127.0.0.1');
      listeners.push(v4);
      chosen = addr.port;
      addresses.push('127.0.0.1');
    } catch (err) {
      if (err.code !== 'EAFNOSUPPORT' && err.code !== 'EADDRNOTAVAIL') throw err;
    }
    const v6 = track(createHttpServer(onRequest));
    try {
      const addr = await listenOne(v6, chosen, '::1', { ipv6Only: true });
      listeners.push(v6);
      chosen = addr.port;
      addresses.push('::1');
    } catch (err) {
      if (err.code !== 'EAFNOSUPPORT' && err.code !== 'EADDRNOTAVAIL' && err.code !== 'EINVAL') throw err;
    }
    if (addresses.length === 0) throw new Error('could not bind IPv4 or IPv6 loopback');
    return { port: chosen, addresses };
  };

  /** Stop every stream, destroy every socket, close every listener. */
  const close = async () => {
    if (closing) return;
    closing = true;
    for (const s of [...streams]) s.stop(true);
    streams.clear();
    ingest.close();
    await Promise.all(listeners.map(s => new Promise(resolve => {
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
      s.close(() => resolve());
    })));
    for (const sock of [...sockets]) { try { sock.destroy(); } catch {} }
    sockets.clear();
    listeners.length = 0;
    store.close();
  };

  return {
    store, ingest, tokens,
    listen, close,
    get listeners() { return [...listeners]; },
    get streamCount() { return streams.size; },
    get openSockets() { return sockets.size; },
    handler: onRequest,
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Probe a TCP port on a host. Used by the tests and by `listen` callers. */
export function probeTcp(host, port, timeoutMs = 2000) {
  return new Promise(resolve => {
    const sock = netConnect({ host, port });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
