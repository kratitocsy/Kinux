// Live bridge: the engine's EventStream into the run server's Ingest, so a
// verification run can be watched while it happens instead of only after.
//
// The join is narrow on purpose. `runVerification` already takes an `onEvent`
// hook and `finishRun` emits through the same stream, so run.score and
// run.finished arrive here too; `Ingest.submit` already accepts a caller's seq
// when it matches the one it was going to assign. A run streamed into a freshly
// opened run id therefore lines up event for event, and a divergence is an
// error rather than a silently renumbered log.
//
// POLICY, and the reason this file exists rather than a one-line callback:
// the run is the authority and the stream is a view of it. A viewer that
// disconnects, a full disk, or a store that throws must never abort a
// verification that is producing real verdicts — the engine still writes its
// own events.jsonl, and that file remains the record. So every submit is
// caught here.
//
// But a swallowed error would be worse than a crash. A `seq_not_yours` means
// the engine and the server disagree about what the log is, which is a defect
// and not a transport hiccup. So failures are counted, kept, and surfaced: the
// CLI prints them and `ok` is false, in the same spirit as NOT_CHECKED never
// being allowed to read as a pass.

import { randomBytes } from 'node:crypto';

/**
 * @typedef {object} LiveBridge
 * @property {(event: object) => void} sink     pass to runVerification's onEvent
 * @property {string} runId
 * @property {number} delivered                 events the server accepted
 * @property {Array<{seq:number,type:string,code:string,message:string}>} errors
 * @property {boolean} ok                       true when nothing was dropped
 * @property {() => string} summary             one line for a human
 */

/**
 * Open a run on the server and return a sink that forwards the engine's events
 * to it as they are emitted.
 *
 * @param {object} args
 * @param {{open:Function, submit:Function}} args.ingest
 * @param {string} args.runId
 * @param {(err: object) => void} [args.onError] called once per failed submit
 * @returns {LiveBridge}
 */
export function createLiveBridge({ ingest, runId, onError } = {}) {
  if (!ingest || typeof ingest.submit !== 'function') {
    throw new TypeError('createLiveBridge needs an Ingest with a submit method');
  }
  if (typeof runId !== 'string' || !runId) {
    throw new TypeError('createLiveBridge needs a run id');
  }

  // Opening here, not on first event, so a bad run id or an unwritable store
  // fails before the solver has burned any time.
  ingest.open(runId);

  const errors = [];
  let delivered = 0;

  const sink = event => {
    try {
      ingest.submit(runId, event);
      delivered += 1;
    } catch (e) {
      const record = {
        seq: event?.seq ?? -1,
        type: event?.type ?? 'unknown',
        code: e?.code ?? 'submit_failed',
        message: e?.message ?? String(e),
      };
      errors.push(record);
      if (onError) {
        try { onError(record); } catch { /* a broken reporter must not stop the run */ }
      }
    }
  };

  return {
    sink,
    runId,
    get delivered() { return delivered; },
    errors,
    get ok() { return errors.length === 0; },
    summary() {
      if (errors.length === 0) return `streamed ${delivered} events to run ${runId}`;
      const first = errors[0];
      return `streamed ${delivered} events to run ${runId}, ${errors.length} NOT delivered ` +
        `(first: seq ${first.seq} ${first.type} -- ${first.code}: ${first.message})`;
    },
  };
}

/**
 * Everything the CLI needs to serve one run: a server, a bridge into it, and
 * the URLs to watch it. The caller owns the server and must close it.
 *
 * @param {object} args
 * @param {Function} args.createRunServer  from server/run/server.mjs
 * @param {Function} [args.validate]       validateEvent from contracts
 * @param {string} args.runId
 * @param {string} [args.root]             storage root; omit for a temp dir
 * @param {number} [args.port]             0 picks a free one
 */
export async function serveRun({ createRunServer, validate, runId, root, port = 0, viewToken, viewerRoot } = {}) {
  // READ-ONLY OVER HTTP, BY CONSTRUCTION. With no tokens configured the run
  // server would accept a POST from any local process, which would let anything
  // on the machine append events to a run labelled `real` -- forging the one
  // field this project exists to keep honest. So a run served from the CLI gets
  // a single random VIEW token scoped to this run, and no drive token is issued
  // at all: there is no credential that can write over HTTP. The engine does not
  // need one, because the bridge submits in-process through server.ingest and
  // never touches HTTP.
  const token = viewToken ?? randomBytes(18).toString('base64url');
  const server = createRunServer({
    root,
    validate,
    tokens: [{ token, scope: 'view', run_id: runId }],
    viewerRoot,
  });
  const { port: boundPort, addresses } = await server.listen({ port });
  const bridge = createLiveBridge({ ingest: server.ingest, runId });
  const base = `http://127.0.0.1:${boundPort}`;
  const q = `?token=${encodeURIComponent(token)}`;
  // Same origin as the stream, so the viewer follows it with a RELATIVE url and
  // the browser needs no CORS header at all.
  const relEvents = `/runs/${encodeURIComponent(runId)}/events${q}`;
  const viewerUrl = viewerRoot ? `${base}/viewer/index.html?sse=${encodeURIComponent(relEvents)}` : null;
  return {
    viewerUrl,
    server,
    bridge,
    port: boundPort,
    addresses,
    base,
    token,
    eventsUrl: `${base}/runs/${encodeURIComponent(runId)}/events${q}`,
    jsonlUrl: `${base}/runs/${encodeURIComponent(runId)}/events.jsonl${q}`,
    close: () => server.close(),
  };
}
