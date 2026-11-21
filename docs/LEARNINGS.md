# Learnings from reading neighbouring projects

**2026-11-21.** Six read-only research agents each read the cloned projects (Copperhead, `fang`, atopile, tscircuit, openbench, the KiCad and ngspice MCP servers, and Copperhead's research and board repositories) from one angle. A seventh read our own plan, status and roadmap against the evidence and tried to find what is wrong with them.

**How far to trust this page.** I verified two claims myself and marked them ✔. Everything else is an agent's reading of code, with paths given so you can check it. Nothing from these projects was run except `fang` (see `spikes/fang/`). Licence rule throughout: copy code only from MIT or Apache-2.0 sources, with attribution. From GPL-3.0 (spicebridge), no-licence (`spice_agent`, `copperhead-research`) and CERN-OHL-S (the board repositories) sources, take ideas only.

For the decisions that follow from this, see [ROADMAP.md](ROADMAP.md). For what exists today, see [STATUS.md](STATUS.md).

## The answer in a paragraph

The image is reachable in an honest form, with different effort than I had assumed. **The board half of the 3D view is small**, once we have KiCad 8 or later. **The motor, housing and gears are not**, because nobody has solved mapping a solver's part id to a CAD part id. **No project anywhere overlays temperature or stress on a 3D model**, so that part is new for everyone. For the plan, the deepest gap is not a missing solver. It is that a PASS tells you nothing about **what the model left out**. Our `NOT_CHECKED` says when a check did not run. It does not say what a passing check never modelled.

## 1. 3D and visual panels

- ✔ **KiCad's GLB export names each scene node by reference designator.** In the 555 board's model there are 54 nodes, 20 of them named `SW1`, `D3`, `J3`, `C5`, and so on, each with an anonymous child mesh; materials are anonymous (`mat_0`...). Per-part colour is therefore: find the node by name, recolour its child meshes. **Only 20 of the board's 30 reference designators have a node.** `R1`, `R4` and `U1` (the 555 timer itself) have none, and neither do the test points or mounting holes. A part with no node must show grey and "NOT WIRED", not a colour.
- **GLB export needs KiCad 8 or later** (R8). Before that, only STEP exists, and a STEP-to-GLB converter would be needed. For the motor, housing and gears the 3D comes from CAD anyway, so a converter that keeps part names in node names is needed regardless.
- **atopile's GLB export is real and wired** (`src/faebryk/exporters/pcb/kicad/artifacts.py:95`, MIT). Its viewer uses Google's `<model-viewer>` and only changes soldermask opacity: no part picking, no per-part colour. Copy the `kicad-cli` flags, not the viewer. Three.js with `GLTFLoader` is the right renderer for custom colouring.
- **Waveforms:** openbench draws them in plain SVG with no chart library (`apps/web/components/sim/WaveformViewer.tsx`, `lib/sim/scale.ts`, `cursors.ts`, Apache-2.0). Small, dependency-free, easy to label by provenance. It will struggle past about 50,000 points.
- **Stale views:** Copperhead refuses to emit a view that no longer matches its source. Apply the same to 3D: stamp every GLB with the hash of the file it came from, and show STALE on a mismatch.
- **Nothing overlays temperature or stress on a 3D model in any of these repositories.** Colour per part and label it per part. A continuous field needs CalculiX on its own mesh.
- **Evidence from the hosted product (a screenshot, not code): a browser 3D board view with per-part inspection is shipped.** Copperhead's workspace shows tabs for 3D, PCB and Schematic; Top, Bottom, Angled and Photo views; an Inspector listing parts (37), nets (15), copper layers, tracks (98), vias (178) and size, which fills in when a part or track is clicked, with a find command; and a tool palette (select, lasso, pen, note, measure). KiCad runs server-side in the workspace container. It is a proprietary viewer, so it is not usable as code, but it shows the interaction we planned (R35) is achievable in a browser. It shows no temperature or stress.
- **A status bar that always shows what is undecided.** The same screenshot's footer reads "1393414 results stale · no profile · 1 blocking open · 94 without a verdict": stale results, open blockers (their obligations ledger) and items with no verdict, always visible. That is our honest roll-up as a persistent part of the interface (R36). The first number looks like a bug or a different kind of counter, and is unexplained. **Correction, from a second screenshot:** "without a verdict" there counts *findings awaiting a human's judgement* in their review queue, not checks that did not run. It is related to our `NOT_CHECKED` idea but is not the same thing.
- **Dead or aspirational:** Copperhead's circuit-json export is on an unmerged branch, schematic-only, with no PCB and no viewer by its own non-goals. atopile's `visualizer/web` looks like a 3D tool but only draws an abstract dependency graph.

## 2. The agent loop, the MCP surface and the Villain

- **Our plan lists 14 MCP tools** ✔ (`docs/PLAN.md:190`), while our own roadmap says "about five". Copperhead ships five and `fang` ten, almost all read-only. The 14 mix three jobs.
- **Gate by absence.** A tool the model should not use is not listed at all (`copperhead/src/agent/registry.ts:48-52`). A call to a withheld tool gets a typed reply saying why, because the Copperhead authors found silence made models fabricate results or conclude the engine was missing.
- **Handles, not one-shot calls.** `fang`'s MCP `propose` returns a handle and `commit` refuses an unaccepted one (`fang/mcp.py:749-815`). A test greps the source to assert no propose-and-commit-in-one call exists (`tests/test_mcp.py:297-300`). A weak test, but cheap.
- **Outcome statuses plus a skill that teaches the host agent** that a rollback "is not an error and not your failure to handle", and that violations are information, not something to route around (`integrations/claude-code/copperhead/SKILL.md`).
- **Honest progress.** A monotonic event counter, not a percentage with an invented denominator. JSON-RPC alone on stdout. A typed `busy` rather than a hidden queue. **Copperhead has no cancel and no way to wait for a run.** We need both.
- **An obligations ledger** (`src/agent/ledger.ts`): a run cannot be declared finished while a check is open, and an edit re-opens cleared checks. This is almost exactly our R17.
- **Not enforced anywhere we looked: hiding survivors from the Builder.** Both roles would share one MCP server, so the server must know the role. The role must come from **how the server is launched**, never from a tool argument the model can set.
- **Fabricated-result handling** (cutting everything from a model-written `[result of ...]` line) only protects a direct-model loop. With an MCP host such as Claude Code we never parse model text, so the equivalent is: the Villain's output is data, never a verdict. The input schema has no verdict field.

**A proposed MCP v0 for Kinux** (per-tool `schemaVersion`, a `0.x` protocol, stdout JSON-RPC only):

| Tool | Purpose |
|---|---|
| `kinux_doctor` | Read-only environment probe (ngspice, KiCad, versions). Works when things are missing. |
| `kinux_start_run` | Start baseline then mutation run for the current design hash. Returns a run id or a typed `busy`. Takes no flags. |
| `kinux_get_status` | State, an event counter, the design hash, stale marks. |
| `kinux_wait_for_run` | Block up to about 55 seconds, then return status. Never errors on timeout. |
| `kinux_get_findings` | Verdicts with receipts. `NOT_CHECKED` is its own status. Builder-safe: counts, and survivor descriptions only after the round closes. |
| `kinux_cancel_run` | New. Copperhead has none. |
| `kinux_open_viewer` | Returns the URL. |
| *Villain-mode server only:* `kinux_propose_fault`, `kinux_run_faults`, `kinux_get_survivors` | Structured, anchored, handle-based (below). |

**A proposed fault** is structured fields only, with no free-text netlist. Its target must resolve to a registry entry. Its bound must be at or past the registry limit in the failing direction, so a trivially mild fault cannot inflate the catch rate. It is de-duplicated by a canonical hash. No verdict field exists. Unanchored faults are stored but excluded from the denominator and listed separately, with a cap on faults per round.

**Deliberately absent:** any file-edit or raw solver tool; `skip_baseline`, `force` or any safety-disabling flag; propose-and-run in one call; any tool that takes a verdict or score; `rerun_test` (it could leak a hidden fault's outcome to the Builder); `toggle_fault` and `set_param` (these belong on the viewer, for humans); `highlight`, `get_selection`, `get_changes` for v0.

## 3. Physics depth

- ✔ **Coverage gaps and model confidence are computed from the model, not typed by a person** (`fang/fang/verification.py`). A model's confidence comes from its provenance on a fixed scale (asserted 1.0, inferred 0.8, unverified 0.5). A run's confidence is the **minimum** over the models it rests on, and nothing raises it. Coverage gaps list every abstracted part, everything a model declares it leaves out (`not_modelled`), and the limit of the analysis itself ("an operating point says nothing about dynamic behaviour"). **This is the gap in our plan.** Each Kinux worker should declare what it does not model and carry a confidence ceiling, so a PASS always ships with its gaps and the viewer shows them.
- **"Route each question to the cheapest level" is simple and worth copying** (`verification.py:1361`). If every parameter already has a value and every constraint is decided, nothing runs. A question nothing covers is unroutable, never answered at another level. For us, a closed-form screen (the steady-state rise ΔT = P·Rθ) could decide a thermal check without running a solver, and would say so honestly. That resolves the redundancy we found in R19.
- **Convergence as a confidence input.** The research repo computes a grid convergence index with Richardson extrapolation over three meshes, falls back to a bound if they do not converge monotonically, and checks reciprocity and passivity before trusting a number. Ideas only (no licence). Our CalculiX worker returns a bare number today.
- **Firmware-in-the-loop is real only as open-loop replay.** openbench reads GPIO from QEMU and `fang` runs firmware in Renode, observing events through probes and refusing to claim absence after a timeout. Neither couples back to an analog plant. For the joint actuator it is feasible if scoped to "the firmware drives PWM into the SPICE half-bridge and we record what happens". **Closed-loop controller tuning is not shown by anyone, and I judge it aspirational.**
- **Worst-case tolerance corners** (spicebridge, GPL-3.0, ideas only): run every ± corner and report which gives the min and max of each metric. It needs a cap, since corners grow as 2^n. It fits as a soft mutation operator (R29).
- **Electro-thermal coupling is handled nowhere.** Our one-way chain is not behind anyone. A two-way fixed-point loop with a convergence flag is possible.
- **Our "research-grade" calls were mostly right.** A continuous 3D heat field, gear contact stress and firmware-driven tuning have no precedent in these repositories. We were too pessimistic about one thing: waveforms, ringing and the kinematic rig are plain recorded-data views, realistic once R20 lands.

## 4. The part, interface and requirements model (R22)

**`fang`'s specification covers the electrical half only.** All 21 of its interface types are electrical, atopile's mechanical module is an 8-line stub, and `fang`'s impact tracking follows a single hop, not a transitive walk (`fang/diff.py:155-174`). The mechanical and thermal interfaces a joint actuator needs, and staleness up the levels, are original work for us. I had said the design was "mostly thought through once already". That was overstated, and the roadmap now says so.

What is worth taking, from `fang` (Apache-2.0):

- **A value with a status**: explicit, inferred, assumed or unknown, with conflicting candidates preserved (`fang/values.py`). An unknown carries no quantity; an inferred value needs a source and confidence; an assumed one needs a rationale. This maps onto `NOT_CHECKED` with codes such as `value_unknown`, `value_assumed`, `value_conflicting`.
- **Three-valued constraints with interval semantics**: true if it holds across the whole interval, false if it fails across all of it, undecided if partial. "Not applicable" is separate from pass (`fang/constraints.py`). Honest, but it makes `NOT_CHECKED` common unless parts carry tight ranges.
- **A requirement state table** (`fang/entities.py:35-74`): nothing enters MISSING; VERIFIED needs evidence; WAIVED needs a recorded waiver. A WAIVED requirement must never read as a pass in the UI.
- **Compatibility as a pure function** per interface kind: source facts and sink facts in, `PASS`, `FAIL` or `NOT_CHECKED` out, naming the missing input and citing evidence. Same type never implies compatible.
- **One registry, with files as projections of it.** Our R15 (a flat registry in the Copperhead style) and R22 (typed, in the `fang` style) risk becoming two stores. Make it one.

**Interface kinds the joint actuator needs**, designed by us: **power** (voltage, current capability and demand, ripple); **mechanical** (continuous and peak torque, maximum speed, inertia, backlash, mounting pattern, load limits, and a separate load-path interface where `kinux.joint_load/1` plugs in); **signal** (encoder, PWM and CAN fields, which come straight from `fang`); **thermal** (heat out, interface temperature limit, thermal resistance, ambient range). Example rules: motor peak torque at least the load's maximum; gearbox rated input speed at least the motor's maximum; the sum of heat out at most the housing's dissipation capacity. These need a worked example from a real motor datasheet before anything is frozen.

**Staleness** needs a dependency graph (part value, constraint, budget, requirement, verification result) walked transitively on a design-hash change, emitting one existing `result.stale` event per dependent result. The event does not need to change. The walk is new.

**A schema sketch** that sits beside our frozen v1 contracts without touching any required field: `part` (id, kind, interfaces, budgets, provenance), `value` (status, quantity, source, confidence, rationale, candidates), `requirement`, `constraint`, `link`. Unknown fields are preserved, and a major-version change is rejected rather than downgraded.

**Do not copy:** the Python language and sandboxed elaboration; pin lowering (board-level only); the commit gate and transaction machinery (we have an event log); the Renode and Touchstone parts. **Traps:** `fang`'s commit gate lets an undecided result pass if a verification question measures into it, which weakens our hard rule, so do not import it unexamined. Magnitudes in `fang` are decimal strings, good for hashing and awkward for solvers. Copperhead's registry is numeric-only, with no units and no three values.

## 5. Check authoring and datasheet provenance

- **Do not count on designs arriving with checks.** `fang`'s `servo_drive` declares 46 checks and no simulation question. atopile's `assert`s are solved symbolically as constraints on parameter intervals, not simulated. Neither maps onto our `## Simulation` blocks. Plan for checks authored by us or by an agent against our grammar. That is the main path, and it is what R16 is for.
- **A design for check discovery, about a week.** One file beside the project, `kinux.checks.md`, holding `## Simulation` and `## Thermal` blocks exactly as now, plus a `binds:` line per block (a sheet, or a set of nets). Enforce `scope:`. A block naming a net that does not exist in the netlist is refused with `unknown_net`. `kinux verify <project>` finds the file. A project with no checks reports "0 checks found" loudly, never a score. No `fang` or atopile ingestion; the spike stays an adapter.
- **A real hole in our thermal worker.** Its `datasheet:` source is a bare string that nothing checks, so an invented thermal resistance would pass. Copperhead's intake system closes this (`intake/core/knowledge/validators/pipeline.ts:151`, branch `feat/intake-extraction-core`, Apache-2.0): **a value is admitted only if its verbatim snippet occurs in the digitised document text.** The model that extracts values is untrusted by construction, and the check is pure string and decimal code.
- **A design for verifiable datasheet values, about a week.** Replace the bare string with `{value, unit, qualifier, conditions, source: {doc_sha256, page, snippet}}`. A deterministic verifier, with no network and no model, reads a text extraction we produce and hash ourselves and checks that the snippet occurs and contains the value and unit as whole tokens. A value that fails, or lacks the record, is held, and any check using it is `NOT_CHECKED` with `unverified_source`. `design_rule:` and `assumed:` stay visibly separate classes that never show as datasheet-sourced. Two details worth taking from Copperhead: a maximum-limit check needs a MAX-qualified fact, not a typical one; and a datasheet thermal resistance is only valid for its stated test board and copper area, so it needs a "conditions covered" test.
- **Receipts** should carry the document sha256, page, snippet and rule version, so a verdict can be re-derived without trusting a model (Copperhead's reproducible manifest, `intake/core/manifest.ts`).
- **SPICE models for ICs: nobody here has an honest answer.** openbench's "validated registry" is about six hand-written parts. spicebridge's model wizard silently fills omitted parameters with defaults, which is a hallucination channel. Two real options: vendor model files with a provenance tuple (URL, sha256, licence, date) per file, which needs a vendored-library allowlist because our sanitizer refuses `.include`; or a behavioural model whose every parameter is sourced. Record a reference and let the user fetch the file, because manufacturer model terms often restrict redistribution. That is general knowledge, not checked here. Report model coverage as a first-class number.
- **Evidence from the hosted product: verification is a triage queue.** A screenshot of Copperhead's Verification panel on the OpenEVSE 6-layer board shows "735 findings · 204 blocking · 127 major", grouped into 55 clusters "to judge" (for example "Net conflict 81", "Pad net differs 193", "Missing footprint 14"), with tabs for Findings, Coverage (26) and Decisions, queue states (to judge, new, judged), a profile line reading "manufacturer capability not examined", and separate buttons for "Run verification" and "Run model review". Two lessons. A real imported board produces hundreds of findings, many probably artifacts of the import (missing footprints, schematic and board out of step), so **volume is not insight, and everything depends on grouping and judging**: our R5 and R6 problem, one level up. And the judging workflow with a recorded decision is what R6 needs: survivors grouped, each labelled real gap, equivalent or noise, with the label and reason kept (R37). The findings shown are structural (netlist and footprint mismatches), not behavioural. We have not seen the findings themselves.
- **Baseline noise for ngspice.** The baseline decides the class. A warning present in the baseline and in a mutant is noise. A warning that appears only in a mutant is a killing signal and is reported, never suppressed. A recovered convergence aid is noise. No convergence, a singular matrix, a missing `.subckt`, or a measure ngspice declined to take is never noise.

## 6. The red-team of our plan

The reviewer's single biggest risk, in its own words: Gate A cannot be passed because no real board can run, and even once boards run, the central hypothesis is untested, and **the score may turn out to measure the author's check suite rather than design risk.**

**Corrections already applied to our docs** (all agreed):

- "The central claim has been measured" was overstated. What was measured is that the scorer separates a weak suite from a thorough one, on one circuit with 33 mutants. That is a sanity check of the scorer. It does not show that the score predicts anything about reviewers, and our own thorough suite scoring 60.4% against 54 generated faults points the other way.
- The "311 of 312 passing" count is only valid in the development container (K21).
- The survey said "none of the six does mutation testing". It should say none was *found*.
- K10 and K19 (the two number parsers disagreeing, inconsistent reason codes) sit on the verdict path and belong before Gate A.
- Gate A's dates are unconfirmed placeholders, and its 10-minute limit is trivially met (3 seconds). The binding constraints are real boards and the equivalent-fault fraction.

**Changes proposed, with the evidence:**

- **Gate B's measure is circular.** A mutation score measures the quality of the checks. Gate B counts seeded bugs "flagged". The real hypothesis is the link between them, so define "flagged" as the seeded bug's location matching a surviving mutant. Add a baseline in which a reviewer reads a random sample of the same size, so Gate C can tell the survivor ranking from "any short list".
- **Hand-label at least 30 survivors** on real designs as real gap, equivalent or noise. Without that the under-30% target cannot be assessed.
- **Make R28 (code-defined designs) the primary route to Gate A**, since it needs no KiCad. Caveat: only 2 of 12 `fang` examples simulate, and `fang` is Copperhead's own tool, so this is not "three real boards". Be honest that Gate A would then be "code-defined boards".
- **Decide the KiCad blocker first** (R8). Copperhead's CI installs KiCad 10 and fails with a named error if the version drifts.
- **The reviewer recommends pausing surface work** (the MCP server, the Villain, physics in the viewer) until Gate A has real numbers, citing Copperhead's own roadmap: "Nothing else on this roadmap matters until this phase is done" ✔. **This is undecided** (D7 in the roadmap). The founder has asked for the MCP server.
- **Narrow the positioning** to "scores any design that emits SPICE or a netlist", and watch the closest threat: Copperhead adding a mutation score to its own `check`. Consider offering the engine to them as a plugin rather than competing.
- **Practices worth copying** (Apache-2.0): CI that gates a release on the same job (`copperhead/.github/workflows/ci.yml`); a `doctor` preflight that names missing tools without running a model, which would fix K21 and K22; release hygiene from `fang` (one version source, a tag that must match it, Keep a Changelog); a pull-request template with an invariant checklist; a golden corpus of pinned boards with pinned expected scores.
- **Resolve the licence question** (K18) and any contributor agreement before an outside contributor arrives. CERN-OHL-S boards are fine as test inputs but must not be copied into our repository.

## 7. How Copperhead's review verifies, and how Kinux should use subagents

**How their review works** (`copperhead/src/review/run.ts` and `prompts.ts`, Apache-2.0, read from code on `main` of 2026-11-07):

1. **A deterministic sweep runs first**, with no model. This is where findings such as "Label dangling" and "Rail without testpoint" come from.
2. **A closed bundle**: the design and its source documents, every input recorded by hash.
3. **One model pass per domain**, run in parallel up to a limit, each with a turn cap and a time cap. There are eight domains: power; MCU; storage, sensors and I/O; firmware against hardware; physical; routing and stackup; fabrication and assembly outputs; BOM ratings and traceability. A pass is read-only. It cannot run anything and calls read-only tools over the bundle.
4. **The model produces proposals, not prose.** Six kinds: a *fact* (checked against the netlist), a *citation* (a verbatim quote, checked against the source), a *measurement* (geometry computed deterministically), a *calculation* (each input names the verified proposal it came from), a *finding* (it must name its premises, which must have survived verification, and carry a severity), and a *question* for whatever only a person, a measurement or a missing document can settle.
5. **Deterministic verifiers decide every proposal, and anything they cannot ground is discarded.** The outcome comes back immediately, so the model can repair a rejected proposal.
6. **The report is rendered from what the verifiers decided, never from the model's words**, and a stored run can be replayed with no model and must reproduce the report byte for byte.

Rules written into the model's instructions that are worth keeping: a statement of absence needs evidence over the whole design (the complete member list of a net), not a glance; do not repeat a sweep finding without adding evidence, because a sweep finding can itself be wrong; prefer a few fully grounded findings to many weak ones; and "check the datasheet, not your memory: a number you cannot cite or calculate does not survive."

The group names in the console ("Will it work", "Can it be built and tested") were **not found in the open-source code**, so they are probably the hosted console's own grouping. We do not know how it clusters findings.

**How Kinux should use subagents in the product.** The principle is the same as theirs and as ours: *agents propose, deterministic verifiers decide.*

- **Villain passes, one per domain** (electrical, thermal, mechanical, firmware and control). Each proposes faults as structured proposals. A verifier checks that the target exists in the design, that the bound is anchored to a registry limit, and that the fault is not a duplicate. The verdict comes back immediately so the agent can repair it. This is R16.
- **Check-writing agents.** They propose assertions in our closed grammar, with a datasheet citation (a verbatim quote, verified as in R33), a closed-form calculation, or a measurement from one of our workers. Our engine then scores them. **The score of AI-written checks is the product**, and Gate B depends on AI-written tests.
- **Survivor-labelling agents.** They propose a label for each survivor (real gap, equivalent, noise) with evidence. **A label must never leave "proposed" until a person confirms it or a solver demonstrates it.** Otherwise a model could raise the score simply by calling survivors equivalent. This is the incentive trap in the design.
- **Independence.** Builder, Villain and scorer are separate roles in separate sessions, with the role set by how the server is launched, and with hidden fault sets (section 2).
- **Closed, hashed, replayable.** Read-only tools over a hashed bundle. Every run records its proposals and the verifiers' decisions, and a replay re-verifies them with no model and must reproduce the report. That is also what makes a receipt (R7) trustworthy.
- **Caps.** Turns, minutes, faults per round, and the share of unanchored proposals.
- **Never:** a model judging pass or fail; a model verifying another model's claim; the Builder scoring itself.

**How we should use subagents to build Kinux**, from what happened in this project:

- **Research agents:** read-only, one angle each, required to cite paths and lines, with a cap on tool calls. I verify the headline claims before anything enters the docs. Reliability varied: the agent that read `fang`'s specification corrected something I had overstated, while the red-team agent did not read the specification at all. So put the deep read on one agent and have the others cite it, and cross-check where two disagree.
- **Building agents:** one folder each, contracts frozen during the work, raw test output required, and the tests rerun by me. Usage limits stopped agents twice, so keep tasks small and resumable.
- **Third-party code is not run without approval.** One install was blocked, and we waited for your approval rather than work around it.

## 8. What is not verified

- Only the GLB node names and `fang`'s confidence and coverage mechanism were checked by me. The rest rests on the agents' reading of code.
- The Copperhead and `fang` clones are single-commit snapshots, so none of this tells us how long their work took.
- The check-authoring agent did not read Copperhead's DRC code in this pass; its ngspice noise-class suggestion rests on our own roadmap text.
- `fang`'s `rf.py`, openbench's `gpio-pwl.ts` and the 555 board's ngspice study were read only in part.
- The red-team agent spent most of its budget on our docs and Copperhead's CI and release files, and did not read `fang`'s specification itself. Where it disagrees with the specification reader on `fang`'s coverage (it suggested reusing `fang`'s entity model wholesale), the specification reader is the better-informed source.
