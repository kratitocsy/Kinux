# Run server

Watch a verification run as it happens, and replay a finished one identically.
Step **S2.2** in [`docs/STEPS.md`](../../docs/STEPS.md). Node 22, plain ESM, no npm
dependencies: `node:http` and the standard library only.

Events are the protocol. Every event is one line of a run's append-only
`events.jsonl` and carries the frozen envelope from
[`contracts/event.schema.json`](../../contracts/event.schema.json). The server
assigns `seq`: it starts at 0, has no gaps, and **is** the SSE event id, so a
client that drops its connection can resume exactly where it stopped.

| File | What it is |
|---|---|
| `store.mjs` | the append-only log and the content-addressed artifact store |
| `ingest.mjs` | the one way events enter a run, plus the fan-out to live clients |
| `server.mjs` | the HTTP server, the token model, and the single SSE stream handler |
| `replay.mjs` | replay a finished run through that same handler |

```js
import { createRunServer, TokenSet } from './server/run/server.mjs';
import { validateEvent } from './contracts/check-run.mjs';   // optional

const server = createRunServer({
  root: '/var/lib/kinux',
  validate: validateEvent,
  tokens: new TokenSet([
    { token: 'v…', scope: 'view',  run_id: 'demo-divider-001' },
    { token: 'd…', scope: 'drive' },
  ]),
});
const { port, addresses } = await server.listen({ port: 0 });
// … later
await server.close();
```

## Endpoints

| Method and path | What it does |
|---|---|
| `GET /` | **200 with a real body.** The landing page. Needs no token |
| `GET /healthz` | liveness. Needs no token |
| `GET /runs` | every run with a short summary |
| `GET /runs/:id` | one run's summary: event count, next seq, status, provenance |
| `GET /runs/:id/events` | **SSE.** Honours `Last-Event-ID`; see *Resume* below |
| `GET /runs/:id/events.jsonl` | the whole log, `application/x-ndjson`, byte for byte as stored |
| `GET /artifacts/:hash` | artifact bytes by `sha256:<64 hex>`. Immutable, so cacheable forever |
| `POST /runs` | `{"run_id": "…"}` creates an empty log. **Drive token** |
| `POST /runs/:id/events` | ingest one event, a JSON array of them, or JSONL. **Drive token** |
| `POST /artifacts` | store a body under its own hash. **Drive token** |

`GET /runs/:id/events` takes two query parameters for the awkward cases:
`?heartbeat_ms=N` overrides the heartbeat interval (`0` disables it) and
`?follow=1` keeps the stream open past `run.finished` instead of closing it.
A token may also travel as `?token=`, `X-Kinux-Token:` or the `kinux_token`
cookie, not only as `Authorization: Bearer`.

### Two rules that are not cosmetic

[`docs/PLAN.md` §8](../../docs/PLAN.md) records user reports of panes hanging on
redirects and on IPv6-only binds, so:

- **`GET /` answers 200 with a body. It never redirects.** Not to `/index.html`,
  not to a trailing slash, not to a run.
- **The server binds IPv4 and IPv6 loopback on the same port**, as two listeners.
  IPv4 is bound first and picks the port; the IPv6 listener is `ipv6Only`, so the
  two never collide and there is no reliance on v4-mapped addresses. `listen()`
  returns `{ port, addresses }` and `addresses` says which families actually came
  up: a host with no IPv6 stack yields `['127.0.0.1']` rather than a failure.

## The token model

Two kinds of token, as in [`docs/PLAN.md` §6](../../docs/PLAN.md): view tokens are
read-only, scoped to a run and expiring; drive tokens start and feed runs and are
held by an agent or the CLI, never by a browser.

```js
new TokenSet([
  { token: 'v…', scope: 'view',  run_id: 'demo-divider-001', expires_at: Date.now() + 3600e3 },
  { token: 'd…', scope: 'drive' },                   // run_id defaults to '*'
]);
```

| | `view` | `drive` |
|---|---|---|
| `GET`, `HEAD`, `OPTIONS` | yes | yes |
| anything else (`POST`, `PUT`, `PATCH`, `DELETE`, …) | **403 `view_token_cannot_write`** | yes |

The write rule is enforced on the **method**, before any route runs, so a view
token cannot write through a path nobody thought about. The run scope is checked
the same way: a token with `run_id: 'x'` asking about run `y` gets
`403 token_not_scoped_to_run`. A missing, unknown or expired token is `401` with
`no_token`, `unknown_token` or `token_expired`.

`/` and `/healthz` are public so a preview pane can load the page before anyone has
handed it a token. Set `requireToken: false` for a local server with no tokens at
all.

## Resume semantics

`seq` is the SSE event id. **`Last-Event-ID` is the seq the client already has, so
the stream resumes at `seq + 1`** — the browser `EventSource` contract, and what
`resumeFrom()` implements. An absent, empty or unparseable header means "from the
start".

Gap-free and duplicate-free comes from one gate. The handler subscribes to the
live fan-out and reads the backlog in the same synchronous block, so no event can
slip between them, and every record — backlog or live — passes the same test:
send it only if its seq is exactly the one we still owe the client. A client that
reconnects therefore gets the events it missed, in order, once each, whether they
were appended while it was away or arrive after it is back.

Framing is the SSE wire format and nothing more:

```
retry: 3000\n\n                     ← once, before any event
id: 7\nevent: test.result\ndata: {"v":1,…}\n\n
: heartbeat\n\n                     ← a comment: no id, no event, ignored by clients
```

The `data:` payload is the exact line from `events.jsonl`, so what a client parses
is what is stored. The heartbeat is a comment line on its own timer, reset by every
event, so proxies do not kill an idle stream. The server ends the stream after
`run.finished` unless `?follow=1`.

## Replay is byte-identical to the live stream

That is the step's "done when". It holds because there is only one stream
implementation — `streamRun()` in `server.mjs`. A live client and a replay differ
only in where events come from: the live client gets them from the ingest fan-out
as they are appended, a replay reads them from the log. Both go through the same
gate and the same `frameEvent()`, and the bytes on the wire are the bytes of
`events.jsonl`, so nothing can drift. The viewer can treat a recorded run and a
live one as the same thing.

```js
import { replayBytes, loadJsonl } from './server/run/replay.mjs';

loadJsonl({ ingest: server.ingest, path: 'contracts/fixtures/valid-run.events.jsonl' });
const bytes = replayBytes({ ingest: server.ingest, runId: 'demo-divider-001' });
```

`loadJsonl` feeds a recorded log back through `ingest`, so `seq` is re-assigned
from 0 exactly as for a live run; pass `provenance: 'recorded'` to relabel a replay
of real data, because the UI must show where data came from.

Heartbeats are the one thing a long idle live stream has that a fast replay does
not. They are comment lines carrying no run data, which is why they do not break
the guarantee: `replayBytes` defaults to `heartbeatMs: 0`, and the test compares a
live stream run with heartbeats off against it.

## Storage

```
<root>/runs/<run_id>/events.jsonl    one canonical JSON event per line, in seq order
<root>/artifacts/<hex>               artifact bytes, named by their own sha256
```

- `seq` is the index of the line in the file, so the file is the authority and no
  separate counter can disagree with it.
- The log is append-only. Nothing is rewritten or truncated.
- **A concurrent reader never sees a torn line.** Each append is a single
  `write(2)` of one whole line to a descriptor opened `O_APPEND`, and a reader
  drops any trailing fragment not terminated by a newline. A reader sees a prefix
  of the log, never half an event.
- Lines are canonical JSON (keys sorted, no incidental whitespace), so a stored
  line — and therefore an SSE frame — is stable.
- Artifacts are written to a temp file and renamed into place: a reader sees the
  whole artifact or no file.
- A run id must be one safe path segment, `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. A
  hash must match `sha256:[0-9a-f]{64}`. Neither can escape its directory.

## Ingest

`ingest.mjs` is what the mutation engine will write to. It is deliberately narrow
and imports nothing from `engine/`: it takes event objects, fills `v`, `run_id` and
`ts` when missing, assigns `seq`, checks the envelope, persists, and hands the
persisted record to every subscriber.

```js
const ingest = new Ingest({ store, validate });   // validate is optional
ingest.open(runId);
const off = ingest.subscribe(runId, record => { /* record.seq, .type, .line, .event */ });
ingest.submit(runId, { type: 'test.result', actor: { kind: 'solver', id: 'ngspice' }, … });
```

`seq` belongs to the server: submitting an event that already carries a different
one is an error (`seq_not_yours`), so nobody can forge an ordering. `checkEnvelope`
is a dependency-free check of the frozen envelope and always runs; the full JSON
Schema needs Ajv, so it is **injected** as `validate` — normally `validateEvent`
from `contracts/check-run.mjs` — and this folder stays free of npm packages. A
subscriber that throws is detached rather than allowed to break the append path.

## Tests

```
node --test tests/run-server.test.mjs
```

Every test starts a real server on an ephemeral port and makes real HTTP requests:
`GET /` is 200 and not a redirect; both loopback families answer on one port; SSE
arrives in `seq` order with correct framing; a client disconnects mid-stream,
reconnects with `Last-Event-ID` and the two legs join into `0…N-1` with no gap and
no duplicate; a replay is byte-identical to the live stream; a view token cannot
POST and a drive token can; every event served from the fixture run passes
`validateEvent`; and `close()` leaves no stream, socket or listener behind. Every
test has an explicit timeout and everything is closed in `after`, so the run
cannot hang.

The IPv6 test is **skipped** on a host with no IPv6 stack, where binding `::1`
fails with `EAFNOSUPPORT`. It is skipped rather than quietly passed, so it is
visible that the bind was not exercised.
