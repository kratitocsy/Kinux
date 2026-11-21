# The mutation engine

The engine breaks a design on purpose and measures how much of that the check
suite notices. The number it produces is **a score for the tests, not for the
design**: a low score means the checks are thin, and a survivor is a gap in the
checks, not proof of a defect.

Everything here runs the real ngspice binary through `workers/ngspice/`. No
verdict in a report was invented by this code.

| File | What it does |
|---|---|
| `netlist.mjs` | Parses a SPICE netlist into an editable structure and serialises it back byte for byte |
| `operators.mjs` | The mutation operators. Each returns a **patch**; `applyPatch` re-parses its own output, so a broken patch throws instead of producing an unparseable netlist |
| `equivalence.mjs` | Conservative equivalent-mutant detection |
| `runner.mjs` | Baseline, gate, mutant dispatch, classification, event stream |
| `report.mjs` | The score, the cap, JSON and Markdown |
| `cli.mjs` | `kinux verify` (a `.cir`, or a `.kicad_sch` with `--sidecar`; exit 4 = nothing checkable) |
| `kicad-adapter.mjs` | KiCad schematic to SPICE deck through the real `kicad-cli`: per-part manifest (modelled / not_checked with reason), checkable fraction, value and net normalisation, sidecar sources and models, check-name validation. Schema in its header |
| `fixtures/` | A demo board and two check suites, used by `tests/engine.test.mjs` |

## Operators

All are deterministic: candidates come out in a stable sorted order and each
mutant has a stable `mutant_id` of the form `M-<operator>-<target>`.

| id | What it injects |
|---|---|
| `value_drift_5`, `value_drift_10`, `value_drift_20` | A passive (R/C/L) is that many percent above nominal: tolerance, temperature, the wrong reel |
| `pullup_removed` | A pull-up resistor is gone and the node floats |
| `pullup_x10` | The pull-up is ten times weaker: fine on the bench, not on a leaky node |
| `bypass_cap_removed` | A rail-to-ground decoupling capacitor is gone. A DC-only check cannot see this at all |
| `divider_ratio_off` | The bottom leg of a resistor divider is 25% off |
| `open_connection` | One terminal is left dangling: a cold joint, a missing via, an unrouted net |
| `output_short` | An internal node is shorted to ground through 1 mΩ |
| `diode_flip` | A diode is fitted backwards |
| `rail_swap` | Supply and ground are swapped on one part |
| `pin_swap` | Two pins of a multi-terminal part are swapped |

`generateMutants(netlist, { operators, limit })` returns every mutant the chosen
operators can make, each with its patch, its applied netlist and its text.

## Scoring guarantees

The score is **not computed here**. `contracts/check-run.mjs` owns
`computeScore` and `wilson`, both frozen, and `checkRun` recomputes the score
from the emitted events; a report that disagreed with its own event stream would
be rejected by the contract. The engine's job is to produce honest statuses.

- **Baseline first, always.** Every check runs against the unmutated design
  before any mutant exists. A mutant is killed only if the baseline **PASSED**
  that check and the mutant **FAILED** it (contract rule 2).
- That gating is structural, not a convention. The only way to ask whether a
  check killed a mutant is `BaselineGate.killedBy()`, and a gate is built from
  baseline results; a check the baseline did not pass is not in its `killable`
  set, so no code path can count it. `classifyMutant()` throws without a gate.
- **`NOT_CHECKED` and `ERROR` never kill.** Only `FAIL` enters the kill list. If
  every eligible check on a mutant came back inconclusive, the mutant's status is
  `not_checked` or `error` — never `survived`.
- **`killed_by` is non-empty exactly when the status is `killed`** (rule 3), and
  **a `survived` mutant has no check that failed on it** (rule 4). Both fall out
  of one list, so they cannot disagree.
- **Score = killed / (killed + survived).** `not_checked`, `error` and
  `equivalent` mutants are reported separately and never counted (rule 6). The
  score is `null`, not 0, when nothing was checkable.
- **The score never appears alone.** Every rendering goes through
  `scoreLine()`, which throws unless the checkable fraction, the mutant count and
  the Wilson 95% interval are all present (rule 7).

### Equivalence

An equivalent mutant is removed from the denominator, so a false positive here
is how a tool flatters itself. `equivalence.mjs` accepts only two proofs:

1. **Textually identical** after normalisation (comments, blank lines,
   indentation, case and line order; values, nodes and refdeses are never
   rewritten).
2. **Below the simulator's resolution** — a value change smaller than 1e-6
   relative, three orders of magnitude under ngspice's default `reltol` of 1e-3.

Everything else counts, including faults a human can see no check could catch. A
removed bypass capacitor that no DC check could notice is a **survivor**: the
suite really did fail to cover it. A rail/ground swap on a symmetric two-terminal
part genuinely is the same circuit, but proving that needs a topology comparison
this module does not do, so it is reported as a survivor. When unsure, not
equivalent — that is the direction that lowers the score.

Mutants identical to *each other* are listed as `duplicates` and are still
scored, because one of the pair is a real uncaught fault.

### The cap

Modelled on Copperhead's `src/kicad/score.ts`, where any error-severity finding
caps the composite below the known-good floor "so a high score can never coexist
with a gating defect", and the cap is reported as a structured object. Kinux
needs it for `docs/PLAN.md` §6: *"its verdict can't be better than its weakest
NOT_CHECKED"*.

```js
report.cap === null                                  // no gating condition
report.cap === { applied_at, reason, bites, gates }   // a gating condition exists
```

- `applied_at` is **0.40**, below the known-good floor of 0.85.
- `effective_score = min(score, applied_at)`. The raw `score` is **never**
  rewritten: it stays exactly what `computeScore` produced, because `checkRun`
  recomputes it. Both numbers are printed, side by side.
- `cap.gates` names every condition. `bites` says whether the ceiling actually
  changed the number (a raw score already below 0.40 still names its gate).

Gating conditions:

| code | Why it gates |
|---|---|
| `baseline_check_not_passing` | The baseline did not PASS a check, so that check sat out the whole run and could kill nothing. The hardware equivalent of a test suite that does not compile |
| `run_error` | The tool broke on a mutant. An ERROR is not evidence either way |
| `mutant_generation_error` | An operator could not produce a mutant |
| `nothing_checkable` | The score is `null`: nothing was killed or survived |

`not_checked` mutants are deliberately **not** gating: they are already visible
in the checkable fraction, which by rule 7 is printed with the score every time.

## The event stream

A run writes an `events.jsonl` that passes `checkRun(events)` with zero
problems: `run.started` first, `run.finished` last, `seq` from 0 with no gaps,
exactly one `run.score` after the last `mutation.result`, every event carrying
`design_hash` (the sha256 of the design text) and `provenance`. `EventStream`
validates each event against `contracts/event.schema.json` as it is emitted and
throws rather than write a malformed line, and it queues a test before any
result for it (rule 5). Equivalent mutants are detected before anything is
simulated and are never run, so they cannot acquire a verdict at all.

## Dispatch

Mutants go through the real job queue (`server/queue/queue.mjs`) by default: one
job per mutant, leased and executed by an in-process worker loop via `runOne`,
which brings the queue's lease fencing and per-job timeout. It composed cleanly —
the payload is just the mutant id and its netlist text — so no part of the engine
depends on the queue's storage. `--no-queue` (or `useQueue: false`) runs the same
executor in a plain loop; `tests/engine.test.mjs` asserts the two paths agree
mutant for mutant. If `node:sqlite` is unavailable the engine falls back to the
direct loop and says so in each mutant's `dispatch` field.

## Running it

`package.json` is frozen, so there is no `npm run verify`. The full invocation:

```sh
node engine/cli.mjs verify engine/fixtures/divider-rc.cir \
  --checks engine/fixtures/checks-thorough.md \
  --out /tmp/kinux-run --threshold 0.7
```

Writes `report.md`, `report.json` and `events.jsonl` into `--out`. Options:

| Option | Meaning |
|---|---|
| `--checks <file>` | Required. Markdown with `## Simulation` blocks (the worker's own grammar), or JSON `{ "blocks": [ { "analysis": "op", "assertions": ["V(out) between 2.3 and 2.4"] } ] }` |
| `--out <dir>` | Output directory (default `./kinux-run`) |
| `--threshold <0..1>` | Exit non-zero below this, compared against the **capped** score (default 0.7) |
| `--limit <n>` | Stop after n mutants |
| `--operators <ids>` | Comma-separated operator ids (default: all) |
| `--run-id <id>`, `--project <name>` | Recorded in the stream and the report |
| `--no-queue` | Run mutants directly instead of through the job queue |
| `--timeout <ms>` | Per-simulation timeout (default 20000) |
| `--serve [port]` | Stream the run live and serve the viewer; see below |
| `--json`, `--quiet` | Print the report as JSON / print nothing |

Exit codes: `0` threshold met, `1` below the threshold, `2` usage or input
error, `3` the run produced an event stream the contract rejects.

### Watching a run live

```sh
node engine/cli.mjs verify engine/fixtures/divider-rc.cir \
  --checks engine/fixtures/checks-thorough.md --serve 7777
```

prints, before the solver starts:

```
serving run run-20261121... at http://127.0.0.1:7777
  WATCH IT:  http://127.0.0.1:7777/viewer/index.html?sse=...
  live SSE:  http://127.0.0.1:7777/runs/run-.../events?token=...
  full log:  http://127.0.0.1:7777/runs/run-.../events.jsonl?token=...
```

Open **WATCH IT** and the three panels fill as ngspice runs. `engine/live.mjs`
bridges the engine's `EventStream` into the run server (`server/run/`) through
the `onEvent` hook, and after the run finishes the server keeps serving until
Ctrl-C so the run can still be opened and replayed.

Four properties, each with a test in `tests/live.test.mjs`:

- **It is live, not a replay.** A test records how many events the engine had
  produced at the moment a client — and, separately, a real browser — first
  saw one, and requires the run to have still been in progress. A bridge that
  buffered and flushed at the end fails it with *"that is a replay, not a live
  stream"*; that sabotage was tried, and caught.
- **The stream is a view; the file is the record.** A viewer that disconnects
  never fails a run, so every submit is caught inside the bridge. But nothing
  is swallowed: failures are counted, named and printed on stderr. They do not
  change the exit code, which stays the verification's verdict.
- **Read-only over HTTP.** A served run gets one random view token scoped to it
  and **no drive token exists**. Without that, any local process could POST
  events into a run labelled `real`. The engine needs no token: the bridge
  submits in-process.
- **Same origin, no CORS.** The server serves `viewer/` itself, so the page
  follows its stream by a relative URL. Opening CORS on a localhost server
  instead would let any web page the user visits try to read it.

What it does not do yet: it serves one run per process, and there is no
reconnect banner in the viewer when the server goes away.

A check suite looks like this:

```markdown
## Simulation

scope: nets [vcc, mid, out]
analysis: op
assert: V(vcc) between 4.95 and 5.05
assert: V(mid) between 2.36 and 2.405
assert: I(V1) between -270u and -255u

## Simulation

scope: nets [out]
analysis: tran 10u 2m
assert: V(out) at 500u between 197m and 201m
```

## Tests

```sh
node --test tests/engine.test.mjs
```

They use the real binary; there is no simulator stub. The headline test is *a
deliberately weak check suite scores lower than a thorough one on the same
design*: on `fixtures/divider-rc.cir` the one-check suite scores 12.1%
(4/33 killed, 95% CI 4.8–27.3%) and the six-check suite 72.7% (24/33, 95% CI
55.8–84.9%) — the intervals do not overlap, and the test asserts that.
