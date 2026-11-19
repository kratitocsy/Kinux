# Step lists

The detailed steps behind the stages in [PLAN.md](PLAN.md), condensed from the first planning pass. They were written for a viewer-first order, and the plan's phases A to K reorder them (see section 9 of the plan). Hours are planning estimates for an AI agent doing the work, not measurements, and total about 290.

Legend: **F** = founder, **A** = agent, **R** = reviewer agent. "Needs" lists dependencies.

## Stage 0: contracts and the sample project

| Step | What | Who | Hours | Done when |
|---|---|---|---|---|
| S0.1 | Event schemas, domain-agnostic, envelope frozen | A, R | 4 | **Done** (`contracts/`, 15 tests) |
| S0.2 | Artifact manifest | A | 2 | **Done** |
| S0.3 | Pick and licence-check a sample 48V BLDC board. Needs KiCad source, a permissive or usable licence, a 3D model or a way to make one, no non-commercial terms. Keep two fallback boards. Output `examples/bldc48/LICENSE-AUDIT.md` | F decides, A researches | 3 | Founder signs off the licence |
| S0.4 | Sample project and an honestly labelled recorded run. Real: `kicad-cli` SVG exports, rule-check output, STEP to GLB, any ngspice run actually done. Synthetic and labelled: heat field, MuJoCo trajectory, mutation set, Villain actions, timeline | A, R | 12 | At least 15 tests and 30 mutants including survivors and NOT_CHECKED; score arithmetic consistent; every synthetic item labelled |

## Stage 1: static viewer

| Step | What | Who | Hours | Done when |
|---|---|---|---|---|
| S1.1 | Viewer scaffold: an append-only event reducer, with a JSONL source and an SSE source behind one interface | A | 6 | Replay gives the same state as a live feed from a fake server |
| S1.2 | Six panels in parallel: schematic and PCB, waveforms (uPlot), mutation and Villain table, 3D (Three.js), MuJoCo playback (recorded frames, no WASM yet), timeline. Plus an overview tab and a provenance badge on every tab | A (6 agents) | ~30 | A browser test per panel checks the badge and a key element count |
| S1.3 | Cross-panel selection: clicking a surviving fault highlights the net, the test and the timeline entry | A | 4 | Browser test asserts all three highlight |
| S1.4 | Static HTML export of a finished run, no network | A | 5 | Opens from `file://` with the network blocked |
| S1.5 | Reviewer pass: every number traces to an event, labels are honest, NOT_CHECKED never counted as a kill | R | 4 | A deliberately broken event is caught |

## Stage 2: run server, queue, real workers

| Step | What | Who | Hours | Done when |
|---|---|---|---|---|
| S2.0 | Environment spike in a clean container: does `kicad-cli` run headless, is ngspice output reproducible across runs, does Docker with no network and a read-only root still run both tools, cold versus warm times, does the `.control` sanitizer block shell commands, do KiCad netlist quirks still simulate | F or A | 3 | A table of timings and pinned image digests |
| S2.1 | Contract freeze: a design hash in every event, an ERROR verdict, job and receipt schemas | A, R | 3 | The Stage 1 viewer plays the same recording unchanged |
| S2.2 | Run server: append-only `events.jsonl`, SSE with `Last-Event-ID` resume, replay through the same handler, artifacts by hash, view and drive tokens | A | 8 | A replay is byte-identical to the live stream |
| S2.3 | Job queue: SQLite WAL, leases with heartbeat, retries only for infrastructure failures, cancel flag, per-job timeout that kills the container | A | 6 | No orphan containers, no double execution |
| S2.4 | Debounce 500 to 800 ms, cancel older runs, stale-marking by design hash | A | 4 | Five rapid edits start one run; a late result after a hash change is marked stale |
| S2.5 | Container runner and cache keyed on image digest, inputs and args | A | 5 | A second identical run returns from cache in under 100 ms |
| S2.6 | `kicad-cli` worker: ERC and DRC reports parsed, SVG export stored by hash | A | 6 | A broken fixture yields exactly the expected violations |
| S2.7 | ngspice worker: allowlist sanitizer, transient run, raw output to float arrays, verdicts from measure checks, unknown models return NOT_CHECKED | A | 8 | An RC circuit matches the analytic answer; identical hash over 5 runs; the injection corpus is blocked |
| S2.8 | Mutation runner v1: netlist operators, each mutant as a queue job, classification, score with checkable fraction and confidence interval | A, R | 8 | A deliberately blind test scores lower than a good one |
| S2.9 | End-to-end and hardening: scripted edit loop against real tools, token scoping, resume during a real run | R | 5 | All green, with a one-page measurements note |

## Stage 3: surfaces

**Probe these unknowns first** (about 6 agent-hours, and some need the founder at a screen): the preview pane with a hosted URL versus localhost; docking a webview beside Claude Code, Codex and Cursor; SSE through the preview pane and a cloud proxy; WASM and blob workers under the webview security rules; MCP Apps in each client; publishing to both the VS Code Marketplace and Open VSX; a fallback if Codex has no usable panel. All of this is unverified.

| Step | What | Who | Hours | Done when |
|---|---|---|---|---|
| S3.1 | Relay: serves the viewer, proxies API and SSE, exchanges a first-load nonce for a session cookie so no token stays in the URL | A, R | 8 | View tokens can't POST; the URL carries no token after exchange; SSE survives 60 s |
| S3.2 | Preview-pane integration: `open_viewer` returns a URL and the pane shows it | F, A | 4 | Loads in a Claude desktop session |
| S3.3 | MCP server: `start_run`, `get_status`, `wait_for_run` (capped near 55 s), `get_findings`, `open_viewer`, `get_selection`, `get_changes` | A | 10 | Initializes against all three clients |
| S3.4 | VS Code-family extension with webview tabs; fallback is an iframe to the local relay if the security rules block workers | A, R | 14 | Tabs open beside the chat; a status bar item shows run state |
| S3.5 | Selection and change tools: `get_selection` returns the live snapshot; `get_changes(since_seq)` returns actor-tagged commands plus the current lock holder | A | 6 | A human command appears in `get_changes` |
| S3.7 | MCP Apps `ui://`, only where a client renders it | A | 3 | Optional |
| S3.8 | Packaging and publishing to both marketplaces | F, A | 4 | Installs from Open VSX in Cursor |
| S3.9 | Integration tests per client: start a run, wait, read findings, human selects, agent calls `get_selection`. Claude Code and Codex automated; Cursor a manual checklist | A, F | 12 | Assertions on the MCP call log, not the agent's prose |

## Stage 4: 3D, heat, motion, interaction

| Step | What | Who | Hours | Done when |
|---|---|---|---|---|
| S4.1 | Scene contract and Three.js viewer skeleton: orbit, hover, click, picking by design-graph id | F schema, A viewer | 10 | A click on a known pixel selects the right component |
| S4.2 | Board 3D export: `kicad-cli` GLB, post-processed so node names match design ids; synthetic boxes if no 3D models | A | 12 | Every component has a node; GLB under 5 MB |
| S4.3 | STEP to GLB for enclosure and mount (CadQuery and OCP), stable ids | A | 10 | Bounding box and volume match the STEP |
| S4.4 | Heat overlay from the one-way chain: a small grid texture coloured in the browser, per-component temperatures for pass and fail, a strict "synthetic" label for the simple thermal model | A, R | 14 | Changing the limit flips the verdict |
| S4.5 | MuJoCo trajectory playback: cloud records qpos at a fixed rate; the browser does joint math; WASM waits for live physics | A | 14 | Client poses match MuJoCo within a tolerance |
| S4.6 | Event additions: actor on every command, `select`, `highlight`, `fault.toggle`, `param.set`, with lock and undo reserved as stubs | F, R | 6 | Frozen before S4.7 |
| S4.7 | MCP tools and interaction steps 1 to 3: `highlight`, `toggle_fault`, `set_param`, `rerun_test` | A | 14 | Slider move leads to a new heat map and a verdict flip in under 3 s |
| S4.8 | Villain and Builder activity feed with actor chips | A | 8 | A recorded run renders in order of `seq` |
| S4.9 | Demo fixtures and an end-to-end browser scenario | F, R | 8 | Passes headless, with badges on every panel |

Performance budget on an ordinary laptop: 60 fps target and 30 fps floor, 300,000 triangles or fewer, GLB totals 15 MB or less, heat texture 256x256 or smaller, first render under 2 s on a local network, no WASM in the first demo.

Deferred: hand edits (locks, diff view, real undo), live MuJoCo physics, stress fields, mesh compression, server-rendered video, multi-user cursors.

## Mutation engine pieces

| Piece | What | Done when |
|---|---|---|
| 0. Contracts | Schemas and fixtures | **Done** |
| 1. `kicad_ingest/` | A KiCad project becomes a design graph and a SPICE netlist, with a source map back to the file | Five open projects (simple and hierarchical) give a runnable netlist and a correct net graph, checked by hand on two |
| 2. `operators/` | Pure functions that emit a patch, plus a patch applier that re-parses the result. Operators: pin swap, pull-up removed or x10, rail swap, bypass cap removed, value drift (5, 10, 20 percent), diode flip, trace width shrink, output short, open connection, divider ratio off, tolerance corners | Each is tested on a toy RC and a regulator circuit |
| 3. `runner/` | Runs checks, gates on the baseline, caches, maps problems to NOT_CHECKED | A known test kills a known mutant, with a survivor and a no-model case, identical on re-run |
| 4. `scoring/` and `receipts/` | Outcome classification, score and interval, hidden versus public split, equivalence heuristics, receipt hashing, JSON and Markdown reports | The receipt hash changes when any input changes |

Version one mutates the netlist. Editing KiCad files directly is later, except for trace width.

## Weeks 1 to 12: founder and agent

Dates assume week 1 starts Mon 23 Nov, which is not yet confirmed.

| Week | Founder | Agents |
|---|---|---|
| 1 | Decide commitment and the pause plan; draft the pre-registration; shortlist boards | Repo, contracts, CI |
| 2 | Review and freeze contracts; start recruiting engineers | Parser, one operator, ngspice runner |
| 3 | Run Gate A personally (11 Dec) | End-to-end score on 3 boards |
| 4 | Build the bug taxonomy from errata; interview 1 to 2 engineers | Operator library |
| 5 | Sample 30 survivors by hand for equivalence | Equivalence filter, report v1 |
| 6 | Pick the 10 boards; seed bugs blind | Test-authoring flow, GitHub Action |
| 7 | Freeze the seeded bugs; run the tool | Run on 10 boards |
| 8 | Gate B decision in writing (15 Jan) | Bug fixes only |
| 9 | Confirm 8 engineers; pilot a session | Study harness and timing sheets |
| 10 to 11 | Run sessions; Gate C (5 Feb) | MCP server, docs, analysis scripts |
| 12 | Write-up, launch, ask for pilots, decide | Demo assets, README |

The cloud viewer and the editor panel stay out of scope until Gate C passes, if the proof-test plan is followed strictly. The plan's phase order puts panels earlier, so settle which applies before starting.
