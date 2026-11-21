# Roadmap

**Updated 2026-11-21.** Read [STATUS.md](STATUS.md) first: it says what exists today, and its issue numbers (K1, K2, ...) are referred to here. The long-form plan, with the reasoning behind the phases, is [PLAN.md](PLAN.md). The detailed step lists are [STEPS.md](STEPS.md).

This page is the working order of attack. It changes as we learn things, so treat dates as targets and sizes as guesses.

**How to read an item**

- **Size:** **S** is a day or less for one person or agent. **M** is a few days. **L** is a week or more. These are guesses. The plan's own hour estimates are planning figures, not measurements.
- **Human:** the item needs a decision or an action that code cannot make. Those are collected in section 9.
- **Done when:** a check anyone can run. If you cannot tell whether an item is done, the item is badly written. Please fix it.

Items are numbered R1 onward so they can be claimed and referred to.

## 1. Where we are against the plan's phases

[PLAN.md](PLAN.md) section 9 defines phases A to M. The honest picture:

| Phase | What the plan says | State today |
|---|---|---|
| **A** | Deterministic electrical core: formats, environment spike, `kicad-cli` checks, ngspice and trace-current checks, queue, cache, receipts, mutation engine and score, `kinux verify`, **Gate A**, then an MCP server | **Mostly built, gate not passed.** The KiCad-to-SPICE adapter now exists (R3, no IC models yet). Still missing: live ERC/DRC (K4), receipts from the engine (K6), and the MCP server. Gate A needs three real boards and we have none. |
| **B** | Agents and humans together, first slow physics tier | **Partly pulled forward.** Event server with live progress, replay and resume: done. Validated MuJoCo checks and four validated CalculiX slices: done. Debounce and stale marking, MCP tools, command log with actor tags: not done. OpenFOAM and OpenEMS: not started. |
| **C** | 2D panels in coding agents | **Partly pulled forward.** Three viewer panels exist. No schematic or PCB panel, no relay, no extension, no probes. |
| **D** | 3D and interaction | Not started. Per-part thermal cards exist, as a stand-in. |
| **E** | Heavy physics on real assemblies | Not started. |
| **F** | Machines part by part | Not started. No part or interface schema yet. |
| **G** | Learning | Not started. Run logs are training-friendly by design. |
| **H to M** | Hand edits, multi-model, fabrication, IDE, registry, hosting | Not started. |

**The order drifted, deliberately.** The viewer and run server (phases B and C) were built before Gate A's inputs existed, so that there would be a working end-to-end picture early. That was a reasonable choice and it produced the measured result in STATUS section 4. But it means the next work should **return to Gate A**, not keep extending the surfaces.

## 2. The gates

Dates come from [PLAN.md](PLAN.md) section 10 and assume week 1 starts **Monday 23 November**. That date is **not confirmed** (see D5).

| Gate | Date | Pass condition | Where we stand |
|---|---|---|---|
| **A** | Fri 11 Dec | Scoring runs end to end on 3 boards in under 10 minutes each, with under 30% of survivors equivalent | Scoring runs end to end in about 3 seconds, on **two hand-written circuits and no real boards**. The equivalent fraction has never been measured against real survivors. **Not passed.** Blockers: R2, R3, R4, R6. |
| **B** | Fri 15 Jan | At least 60% of seeded bugs flagged on 10 boards, false alarms at most 30%. Under 40%: drop the scoring claim | Not started. Needs the proof-test materials (R27). |
| **C** | Fri 5 Feb | Review time down at least 25% with no loss in bugs found, and at least 5 of 8 engineers would use it | Not started. |
| **Money** | Fri 12 Feb | Two teams agree to a paid pilot or sign a letter of intent, otherwise it stays open source | Not started. |

Three things about the gates, from a review of our docs against the evidence:

- **The dates are placeholders.** They assume a start that was never confirmed (D5), and Gate A's 10-minute limit is already met many times over (about 3 seconds). The binding constraints are real boards and the equivalent-fault fraction, and neither is tied to a date.
- **Gate B's measure is circular as written.** A mutation score measures how good the *checks* are. Gate B counts seeded bugs "flagged". The real hypothesis is the link between the two, so "flagged" needs a definition: the seeded bug's location matches a surviving mutant. It also needs a baseline in which a reviewer reads a random sample of the same size, so Gate C can tell the survivor ranking apart from any short list. See R30.
- **The score may measure the author's checks, not the design's risk.** That is the single biggest risk the review found (section 10).

If Gate B passes and C fails, the plan pivots to audit reports or integration into other tools. If B fails, the plan stops: the benchmark, the open-source engine and a written negative result remain. We should design the work so those outcomes are still worth having.

## 3. Critical path to Gate A

Do these in roughly this order. R1, R10, R11 and R12 are independent and can run in parallel with everything else.

```
R2 choose boards (human) ──┐
                           ├──► R3 KiCad → netlist ──► R4 check authoring ──► R5 baseline noise ──► R6 equivalence ──► R13 Gate A run
R8 KiCad 8+ (human) ───────┘                              │
                                                          └──► R7 receipts
R1 CI · R10 import-graph test · R11 small fixes · R12 docs debt   (any time)
R9 isolation  (before any third-party design runs anywhere that matters)
```

**An order suggested by the deep reads, not yet agreed (D7).** A reviewer who read our docs against the evidence argued that surface work (the MCP server, the Villain, physics in the viewer) should wait until Gate A has real numbers, because the gate needs real boards and a measured equivalent fraction, and nothing on the surface produces either. Its suggested next two weeks: R1 (CI, tests that skip, a `kinux doctor`), R8 (decide the KiCad question), R28 on three code-defined boards, R6 (hand-label 30 survivors), R30 (define Gate B), and the licence decision. This is undecided. The founder has asked for the MCP server, which is cheap and makes the Builder and Villain loop real. The cost of building it first is that it does not move Gate A.

### R1. Continuous integration · S
- **Status:** done, apart from a first run on GitHub. `npm test` skips a suite whose solver is missing, by name and with the reason; `npm run doctor` reports what a machine has and flags a tool the workers cannot see; `npm run test:all` runs everything and is what CI uses. The workflow (`.github/workflows/ci.yml`) is written and parses but has **never run on GitHub**, so expect to adjust it. Still to do: a configurable location for `kicad-cli` (K22), and the badge once a run is green.
- **Why:** 312 tests and nothing runs them on a push (K7). And a contributor without every solver installed sees failures instead of an explanation (K21).
- **Do:**
  - Add a shared helper that reports whether a tool is present, like the one browser tests now use (`tests/helpers/browser.mjs`), and make each solver's tests **skip with a printed reason** when it is missing. Today only the motion and browser tests do. The `engine` suite does not run at all without ngspice.
  - Then a GitHub Action that installs ngspice, CalculiX and Gmsh, runs `npm ci` and `npm test`, with a smaller toolset still giving a green run.
  - While there, make the tool locations configurable for every worker, `kicad-cli` included (K22).
- **Done when:** a push shows a green or red check, the README carries the badge, and `npm test` on a machine with only Node reports skips with reasons rather than failures.

### R2. Choose and licence-check three real boards · S · Human
- **Why:** Gate A needs three real boards, and so does everything after it (STEPS S0.3). We have none.
- **Do:** pick one open 48 V BLDC driver board and two fallbacks, as the plan describes. Each needs KiCad source, a permissive or usable licence, no non-commercial terms, and a way to get a 3D model. Write `examples/<board>/LICENSE-AUDIT.md`. An agent can research candidates; a person signs off.
- **Candidates found, not yet vendored or signed off.** Copperhead publishes example boards in its GitHub organisation, each designed by its own agent. Two are well suited:
  - `copperhead-tps5430-buck-converter`: 12 V to 5 V at 3 A, 37 parts.
  - `copperhead-555-oscillator`: 10 kHz to 1 MHz, 30 parts.

  Both have hardware under **CERN-OHL-S-2.0** (strongly reciprocal: a distributed modified version must be released under the same licence) and documents under CC-BY-4.0. Both are **KiCad 10 format** (PCB file version 20260206), so they need R8. Neither has been built, and both say so plainly. Neither ships a SPICE model.

  What makes them useful: the 555 board's README reports an ngspice study, with TI's TLC555 model, finding the top of its range at about 744 kHz against a 1 MHz target, so the original design fails its own spec. That is a ready-made case for baseline gating and the cap. The buck converter names an open question: whether the TPS5430's 4 to 6 A current limit overloads its 5 A catch diode in a sustained output short. That is a fault the engine should be able to find. Whether we may vendor them, and whether our modified copies must then carry CERN-OHL-S, is a licence call for you (D4).
- **Done when:** the founder has approved three boards in writing.

### R3. KiCad project to SPICE netlist · L
- **Why:** the engine only reads a hand-written `.cir` (K2). This is the biggest gap to Gate A, and probably the biggest unknown in the project.
- **Do:**
  - Call `kicad-cli sch export netlist --format spice`. The 7.0.11 help lists `spice` as a format. **It cannot yet be tried on a real project**: KiCad 7 fails to load every KiCad 8 file (K4), so this needs R8 first. It has never successfully exported a real schematic.
  - Prefer `kicad-cli` over our own `workers/kicad` reader for connectivity, since the reader refuses hierarchy (K3). Keep the reader for source spans, so a finding can name the exact lines it came from.
  - Report symbols with no SPICE model as `NOT_CHECKED` with `no_model`, never as a pass.
  - **Test the SI-prefix boundary.** Real ngspice reads `1M` as **1 milliohm** and `1meg` as 1 megaohm (measured: a 1 V source across each draws 1000 A and 1 µA). In KiCad and in people's heads `1M` is a megaohm. If the export does not translate it, the simulated resistor is a billion times too small and every verdict is silently wrong. Our own parsers already follow SPICE; the risk is the hand-off from KiCad. Copperhead shipped exactly this class of bug, where `1m` and `1M` compared equal (their issue #483).
  - Try it on the three boards and on the 19 real schematics in Copperhead's `manual-tests/` (see STATUS section 10).
- **Done when:** `kinux verify` accepts a KiCad project, and the fraction of real designs that yield a runnable netlist is **measured and written down**.
- **Risk to watch:** real boards are full of ICs with no SPICE model. The checkable fraction on a real board could be low. Honest reporting handles that correctly, but it affects how useful the score is, and we should find out early.

### R4. Check authoring: where checks live · M
- **Why:** a mutation score is a property of the check suite, and the plan never said where a design's checks come from. The assertion grammar exists (`## Simulation` blocks); the convention for attaching checks to a KiCad project does not. Gate B's "AI-written tests" have nothing to write into until this exists.
- **Do:** decide the file convention (for example a checks file beside the project), how a block binds to a sheet or set of nets, and how an agent adds one. Enforce `scope:` (K9). Fix `corner()` so it measures against the passband (K8).
- **Do not count on designs arriving with checks.** `fang`'s `servo_drive` declares 46 checks but no simulation question, and atopile's `assert`s are solved symbolically, not simulated, so neither maps onto a `## Simulation` block. The smallest design that works: one `kinux.checks.md` beside the project, holding `## Simulation` and `## Thermal` blocks as now plus a `binds:` line per block (a sheet, or a set of nets). A block naming a net that does not exist is refused as `unknown_net`. A project with no checks file reports "0 checks found" loudly, never a score. Checks authored by us or by an agent against our grammar are the main path. Details in [LEARNINGS.md](LEARNINGS.md).
- **Done when:** `kinux verify <project>` finds its own checks, and a check naming a net that does not exist is refused with a clear reason.

### R5. Per-domain baseline noise · M
- **Why:** KiCad DRC has findings that are reported but must never fail a baseline (unrouted ratsnest, single-footprint findings). Every other solver has its own equivalent: ngspice convergence warnings, mesh failures, contact noise. Without a "reported, never a failure" class for each, real baselines fail and every mutant becomes unscoreable.
- **The baseline decides the class.** A warning that appears in the baseline and in a mutant is noise. A warning that appears only in a mutant is a killing signal and is reported, never suppressed. For ngspice, a recovered convergence aid is noise; no convergence, a singular matrix, a missing `.subckt`, or a measure ngspice declined to take is never noise.
- **Done when:** each wired solver documents its noise class, with a test that the exceptions still fail (as the DRC parser's do).

### R6. Calibrate equivalent-mutant detection · M · Human
- **Why:** Gate A requires under 30% of survivors to be equivalent, and we have never measured it (K5). The current heuristic is deliberately conservative, so it marks almost nothing equivalent, which biases scores low.
- **Do:** a person hand-classifies about 30 survivors across the boards as equivalent or genuine (the plan puts this in week 5). Use the result to tune the heuristics, conservatively: when unsure, do not mark equivalent.
- **Start with a plain file, not a screen.** Label survivors in a `labels.jsonl` (id, label, reason, labeller) and compute the fraction with a script. A judging queue in the viewer, modelled on Copperhead's Verification panel, is R37.
- **First number (partial, 2026-11-21).** `spikes/survivors/profile.mjs` re-runs ngspice on the original and each survivor and measures the largest difference; `fraction.mjs` combines that with labels into `spikes/survivors/labels.jsonl`. Of 78 survivors (divider-rc 9, phase-leg 21, fang rc_filter 3, fang buck 45), **21 (27%, Wilson 95% CI 18-38%) are solver-demonstrated equivalent**, a floor. The other 57 were labelled by three independent blind agents; they agreed unanimously on 56 and the labels are **proposals, status "proposed", not yet confirmed by a person**. Their consensus: 39 benign, 10 real gaps, 6 inside an inlined model, 2 equivalent. Caveats: the 78 come from our own hand-written and fang-generated circuits, not real boards; 45 of them are one design (the buck, whose feedback loop is open in the model, so the R1/R2 survivors are probably one real gap counted eight times); "benign" means requirements still hold, which is not "equivalent" and the Gate A wording ("equivalent") needs defining. **Not done:** a person confirming the labels; real boards (R3, D2).
- **Done when:** the equivalent fraction on real survivors is measured and reported with its sample size.

### R7. Evidence receipts from the engine · S to M
- **Why:** reports are reproducible only if they carry hashes of their inputs (K6). `server/queue/receipt.mjs` already builds receipts that validate against the schema, but the engine never calls it.
- **Done when:** `kinux verify` writes a receipt that passes `validateReceipt`, and a test shows the receipt hash changes when the design, the checks, the operator set, the tool version or the seed changes.
- **Status (2026-11-21): done for design, checks, operators and limit.** `kinux verify` writes `receipt.json` (`engine/receipt.mjs`, tests in `tests/engine-receipt.test.mjs`): it validates, the same inputs give the same id, and changing the design, checks, operator set or limit changes it. Not covered: a change of tool version (only ngspice 42 is available to test) and seeds (the engine has none). The limit is also folded into the operator hash, but a test cannot tell that apart from the result change it causes.

### R8. KiCad 8 or later · S once decided · Human
- **Why:** ERC, DRC and GLB export need it, and **so does opening any modern board at all**. KiCad 7 refuses files saved by KiCad 8 or later: 18 of 19 real schematics and the one board we tried all failed (K4). That makes this the gate on R3, so the decision (D2) should be made first, not last. It also lets us check the five hand-authored report fixtures against real output.
- **Do:** decide how to get it (D2). Then wire `runErc` and `runDrc` to call `--format json --output <path>` and return the path (`workers/pcb/erc-drc-report.mjs` already reads it).
- **A recipe known to work elsewhere, which we have not run.** Copperhead's CI (`.github/workflows/ci.yml` in its repository) installs KiCad 10 on a GitHub Actions Ubuntu runner from `ppa:kicad/kicad-10.0-releases`, and its comments record four traps worth knowing before we repeat it:
  1. On Ubuntu 26.04 images, apt can silently install the distribution's own KiCad 9 instead of the PPA's, unless you pass `-o APT::Architecture-Variants=amd64`.
  2. Install `kicad-footprints` as well, or ERC reports every footprint library as missing and the checks fail on the environment rather than on the design.
  3. `kicad-cli` never creates its global footprint-library table when run headless. Copy `/usr/share/kicad/template/fp-lib-table` into `~/.config/kicad/<version>/` first.
  4. Check the version by name in CI and fail there, instead of as dozens of "Failed to load" test errors when a runner or the PPA drifts.

  Their installer also deals with macOS, where `kicad-cli` lives inside `KiCad.app` and is not on `PATH`: it searches the standard install folders and offers an environment-variable override. We should do both (K22). By their own comment, Ubuntu 26.04 ships KiCad 9, so a newer base image would also work without a PPA.
- **Done when:** ERC and DRC run on a real board, and the five hand-authored fixtures are replaced or confirmed.
- **Progress (2026-11-21):** KiCad 10.0.8 is installed by the environment's setup script (D2 settled for the development container), and ERC and DRC run on real boards. **Still open:** the five hand-authored report fixtures have not yet been compared against real KiCad 10 reports, and ERC/DRC are not yet wired into the engine as checks.

### R9. Isolate the solvers · L · Human
- **Why:** netlists, `.inp` decks, `.geo` files and MuJoCo models can all execute code or read files, and today our sanitizers are the only barrier (K1; STATUS section 7, finding 2). Nothing third-party should run until solvers run in containers with no network, a read-only root and a size and time limit.
- **Do:** decide where untrusted designs run (D3), then build the container runner. Until then, add a clear refusal or warning when a design is not from the repository.
- **Done when:** a hostile design from each solver's test corpus runs inside the container and demonstrably cannot reach the host.

### R10. The "a model never judges" test · S
- **Why:** "agents propose, solvers decide" is the project's central rule, and today it is a sentence. A short test can make it a build failure: walk the import graph from the verdict and scoring code and fail if it ever reaches a model SDK or an agent module. Copperhead does this and it costs about twenty lines.
- **Done when:** the test exists and fails if you add such an import. Extend it when the MCP server lands (R14).
- **Done (2026-11-21).** `tests/no-model-in-verdict.test.mjs` walks the import graph of 17 verdict and scoring entry points (25 files) and allows only Node built-ins, Ajv and our own code; it also rejects `require()`, computed `import()`, anything under `mcp/` or an agents folder, and a model SDK in the motion worker's Python child. Measured: adding `import OpenAI from 'openai'` to `engine/report.mjs` fails it. Extend the entry list when the MCP server lands.

### R11. Small fixes · S each
Good starting points. Each is one issue from STATUS section 8.
- K8: `corner()` measures against the passband (also in R4).
- K10: done (engine parser matches ngspice; see STATUS K10 for the one remaining grammar gap).
- K11: make the queue "timeouts" test insensitive to machine load.
- K19: done for the mesh codes. `tool_missing` is still split (K24), and needs a decision.
- Corner cases found along the way: the convergence gate in the motion worker can be fooled when both timesteps are equally wrong (STATUS finding 10). At minimum, add a third timestep.

### R12. Documentation debt · S each
`server/queue`, `workers/ngspice` and `workers/pcb` have no README (K16). Each should say what the module does, its guarantees, and what it does not guarantee. Read the code headers and tests; they are the source of truth.

### R13. Run Gate A and write it down · S
- **Do:** run the three boards, time each, report the equivalent fraction, and write the outcome, pass or fail, in a new file, `docs/GATE-A.md`.
- **Done when:** the numbers are measured and committed. A failed gate with honest numbers is a good result.

### R28. Score a code-defined design (a possible shortcut around R8) · M
- **Why:** `fang` lets a design be Python source and lowers it to ngspice decks and a KiCad netlist without opening a KiCad board. If that works as its README describes, real designs could reach our engine without KiCad 10 (D2). Its `servo_drive` example is close to our target demo. And a `fang` design declares requirements and benches, which are checks, so Kinux could measure how well they catch faults. `fang` answers the questions its author declared; it has no way to find the ones the author did not think of.
- **Established by a spike** (`spikes/fang/`, about 40 seconds): `fang` installs with no dependencies, runs ngspice, and builds plain SPICE decks that our engine accepts once its `.control` block is dropped and its `.include` inlined. Two fang designs got a mutation score: `rc_filter` 62.5%, `buck_regulator` 27.4% (STATUS section 4). The path exists, with no KiCad involved.
- **Limits found:** there is no supported way to get a deck out of fang (the spike wraps an internal method); only 2 of its 12 examples run a simulation; `servo_drive`, the closest to our demo, declares no question; and Kinux's grammar cannot express fang's ripple measure.
- **Do next:** ask the `fang` authors for a supported way to write a verification deck, or use its public `lower_question`; add a peak-to-peak measure to our grammar; and try mutating the Python source, not only the SPICE text.
- **Done when:** there is a supported way to get a deck from `fang`, and a `fang` design with several real checks has a mutation score.

### R29. Tolerance corners · M
- **Why:** single-fault testing cannot see faults that combine. In the `fang` RC filter, a 5% drift in R1 or C1 alone stays inside the band, but both together put the corner at about 1.44 kHz, outside it (`spikes/fang/`). The plan already lists tolerance corners as an operator, and `spicebridge` ships Monte Carlo and worst-case analysis, so the idea is established.
- **Do:** add an operator that applies the worst-case combination of declared tolerances, and report it separately from single faults so the score stays interpretable.
- **Done when:** on the RC filter, the corner operator is killed by the check while each single 5% drift still survives, matching the hand calculation.

### R30. Define Gate B precisely · S · Human
- **Why:** the gate as written is circular (section 2). A mutation score measures the checks, not the design.
- **Do:** write down what "flagged" means (a seeded bug's location matches a surviving mutant), the seeding protocol, and a random-sample baseline in which a reviewer reads as many items as there are survivors. Get it signed off before any board is seeded.
- **Done when:** a pre-registered definition is committed.

## 4. Closing Phase A: the MCP server and the Villain

### R14. MCP server · L
- **Why:** it is how a coding agent starts runs and plays the Villain. The plan calls it the end of Phase A.
- **Design rules**, taken from what Copperhead learned shipping one:
  - Expose **outcome-level** tools: `start_run`, `get_status`, `wait_for_run` (capped near 55 seconds), `get_findings`, `open_viewer`. No file-edit tool, no raw solver tool.
  - **No partial-loop tool.** There must be no sequence of calls that skips the baseline or produces a score without it. Interactive tools for the viewer (`set_param`, `rerun_test`) are fine, but none may be able to produce a score.
  - **No tool input may turn off a safety rule.** Every optional flag such as `force` or `skip_baseline` is a way around a rail.
  - **Take structured input, never raw solver text.** `openbench`'s ngspice MCP server accepts a validated JSON netlist and builds the deck itself, which closes the shell-command hole by construction.
  - **Keep the tool surface small.** The open KiCad MCP server has about 35 tools, and its commercial successor needed 21 on-demand toolsets to manage 228. Copperhead ships five. We plan about five. Our plan's own list names 14, which contradicts that. The proposed v0 list in [LEARNINGS.md](LEARNINGS.md) has seven tools for the Builder, plus three more on a Villain-mode server only.
  - **The role comes from how the server is launched, never from a tool argument.** The Builder's server does not list the Villain's tools at all, because a model can claim any role in an argument. Hiding survivors from the Builder is enforced nowhere else we looked.
  - **A proposed fault is a structured request with a handle**, anchored to a verified limit in the registry. Unanchored faults are stored but excluded from the score, and no tool input carries a verdict. `rerun_test` is left out of v0 because it could leak a hidden fault's outcome. `toggle_fault` and `set_param` belong on the viewer, for humans.
  - **We need cancel, and a way to wait.** Copperhead has neither.
  - Ship a **verdict-interpretation contract** with it, telling the host agent that a FAIL is information to surface, not something to route around. A helpful coding agent's default reaction to a failing check is to get past it.
  - JSON-RPC alone on stdout; typed "busy" errors rather than an invisible queue; a per-tool schema version; a pinned `0.x` protocol until it settles.
- **Done when:** it initialises against Claude Code and Codex in automated tests and against Cursor by a manual checklist, with assertions on the MCP call log rather than on the agent's prose.
- **v0 built (2026-11-21):** `mcp/server.mjs`, the seven Builder tools from LEARNINGS, no dependencies. `tests/mcp.test.mjs` drives it as a child process over stdio with real ngspice runs: seven tools and no escape hatch, unknown arguments refused, same score as the CLI, survivors withheld until the round closes, typed busy error, cancel, stdout is JSON-RPC only, no model or MCP SDK in its import graph. **Not done:** the done-when above (no real agent client has connected yet), the Villain role (R16), live viewer serving.

### R15. Constraint registry · M
A machine-readable list of limits (a datasheet maximum, an interface limit, a declared budget), each with an `affects` list that drives staleness. It is what lets the Villain's faults be validated without a model judging realism, which the project's own rule forbids.

### R16. AI Villain v0 · L
The host coding agent proposes faults through MCP (`propose_fault`, `run_faults`, `get_survivors`). A proposed fault **counts toward the score only if its target and bound resolve to an entry in the registry** (R15). An agent-invented fault with no anchor is recorded as an unverified claim and excluded from the denominator. Depends on R14 and R15. The pattern to copy from Copperhead's model review (LEARNINGS section 7): agents produce structured proposals, not prose; deterministic verifiers decide every proposal and discard what they cannot ground; the verdict on each proposal comes back immediately so the agent can repair it; and a recorded run can be replayed without a model to reproduce the report.

### R17. Staleness and obligations · M
The contract already has a `result.stale` event and the engine never emits it. When the design changes, every dependent result should be marked stale and shown that way, and a run should not be declarable "done" while a dependent check is unverified. This is what turns "parts verified, system not checked" from a sentence into something enforced.

## 4b. Direction: design and verify, kept apart (D12, 2026-11-21)

The founder's direction: design parts (actuators, electronics, TV-class parts), verify each one blind, then assemble the machine from verified parts. This does not change the order of attack: Gate A (real boards scored) still comes first, because everything after it rests on a measured score. What it adds, in order:

1. **R14 and R16**: the MCP loop, so a designer agent and a separate Villain can run against the verifier. The loop ends when the baseline passes, nothing is stale (R17) and every survivor is killed, proven equivalent or accepted by a person, or when a round, budget or no-progress limit stops it. A stop is reported as a stop, never as a pass.
2. **R22**: the part and interface contract, so each part carries its budgets (power, heat, torque, mass, space) and its interfaces.
3. **R21**: the joint-actuator chain (driver electronics, motor, load), reusing the motion worker's torque export and the thermal worker's one-way coupling.
4. **The integrator**: system checks across parts, and a roll-up that says "parts verified, system not checked" until system tests have run. A machine's verdict is never better than its weakest `NOT_CHECKED`.

Open questions: what the designer is (a separate tool, or Claude Code through MCP) and how it is kept out of the verdict path.

## 5. The physics track

These follow the plan's order: deterministic checks first, then the slow tier. Start after R13 unless you have spare hands.

### R18. Physics mutation operators · L
Only thermal is mutation-tested today (K20). The plan lists Villain faults for each domain: for FEA a heavier load, a thinner wall, a weaker material, a hotter ambient; for motion a load of 1.8 times the rating. Each needs operators, baseline gating, and a noise class (R5).

### R19. Thermal where it matters · M
Thermal checks added nothing on the demo circuit (STATUS section 4). Find or build a design and fault set where temperature rises without moving a measured voltage, use datasheet thermal resistances instead of design rules, and add thermal-specific faults (heatsink removed, ambient raised, duty cycle doubled). Until then the thermal worker is validated but unproven to be useful. **Also, our thermal model's `datasheet:` source is a bare string that nothing checks**, so an invented value would pass. Make datasheet values verifiable first (R33), before adding more thermal operators.

### R20. Physics in the viewer · M
Render what the workers already produce: recorded MuJoCo trajectories (STEPS S4.5), waveform samples (the panel has the reference but does not load them), and FEA results as per-part numbers in the same cards as thermal. Fields and 3D come later. Keep the rule: draw only what a solver produced.

### R21. The joint-actuator chain · L
The plan's first whole-machine demo. Motion gives joint torque, which becomes a load on the housing in FEA, while ngspice and the thermal model give heat. The motion worker already exports `kinux.joint_load/1` for this. Chain one way and mark everything else `NOT_CHECKED`. Depends on R22.

### R22. Part and interface contract · M
**Do this before anyone authors parts.** **Read `fang`'s specification first** (`openspec/specs/fang-kernel/spec.md` in `copperheadhq/fang`, Apache-2.0). It covers typed interfaces and their compatibility checks, units, explicit unknowns, provenance and impact propagation, so the electrical half has been thought through once already. **The mechanical and thermal interfaces the joint actuator needs are not there**: all 21 of its interface types are electrical, so those are original design work, and its impact tracking follows one hop only, so staleness up the levels needs our own transitive walk. A read of the specification, and a proposal for our contract, are in [LEARNINGS.md](LEARNINGS.md). A schema and validator for parts, interfaces (power, mechanical, signal, thermal), budgets and requirements, with rules a schema cannot express: interface compatibility, budget roll-up, staleness propagation upward, version pinning. Add the precedence rule: requirements outrank budgets, budgets outrank constraints, constraints outrank the design, and a requirement violation is flagged for a person, never silently resolved. This is cheap now and expensive to migrate later, for the same reason the event format was frozen first.

### R23. The slow tier at scale · L
Finite-element runs are minutes, not milliseconds. Parallel isolated containers, the existing input-keyed cache, time budgets and stop conditions. Depends on R9. This is where rented compute earns its cost.

### R31. Model limits and a confidence ceiling · S to M
- **Why:** our `NOT_CHECKED` says when a check did not run. A PASS says nothing about what the model *left out*. `fang` computes this from the model: each model declares what it does not model, a model's confidence comes from its provenance on a fixed scale, a run's confidence is the minimum over the models it rests on, and nothing ever raises it (LEARNINGS section 3). Without this, every new solver widens the gap between "pass" and what was modelled.
- **Do:** each worker (ngspice, thermal, motion, FEA) emits a `not_modelled` list and a confidence ceiling. The viewer shows them beside every PASS.
- **Done when:** no PASS reaches the viewer without its stated gaps.

### R32. Decide at the cheapest level that can answer · S
- **Why:** thermal checks added nothing on our demo circuit (R19), and we counted a redundant solver run to learn that. `fang`'s rule is simple: if every parameter already has a value and every constraint is decided, nothing runs, and a question nothing covers is unroutable, never answered at another level.
- **Do:** a closed-form screen (the steady-state rise, power times thermal resistance) that decides a check without running a solver when it can, and escalates when it cannot, saying which it did.
- **Done when:** a thermal check on the demo circuit reports "decided at the equation level" and a hand calculation agrees.

### R33. Verifiable datasheet values · M
- **Why:** K23. Copperhead's intake admits a value only if its verbatim snippet occurs in the document text, and treats the model that extracts values as untrusted.
- **Do:** replace the bare `datasheet:` string with `{value, unit, qualifier, conditions, source: {doc_sha256, page, snippet}}`, and a deterministic verifier with no network and no model. A value that fails is held, and a check that uses it is `NOT_CHECKED` with `unverified_source`. A maximum-limit check needs a MAX-qualified value, not a typical one. Keep `design_rule:` and `assumed:` visibly separate.
- **Done when:** a thermal model with an invented datasheet value is refused, and one with a real, verified value is accepted.

### R34. A confidence band on finite-element results · M
Our CalculiX worker returns a bare number. Run three mesh levels and report a grid convergence index band on peak stress, with sanity checks (energy balance, symmetry) beside it. The research repository does this; it has no licence, so only the textbook formulas are usable.

### R35. A per-part 3D view · M, blocked on R8
- **Do:** load a KiCad GLB in the viewer (Three.js), build a map from reference designator to scene node, and recolour each part from its solver number in bands with a numeric label. A part with no node, or no solver number, shows grey and "NOT WIRED". Stamp the GLB with the hash of the board it came from and show STALE on a mismatch. The motor, housing and gears must come from STEP files, and nothing yet maps a solver part id to a CAD part id.
- **Done when:** the 555 board's model loads with its parts coloured from the thermal worker, and the 10 parts with no node are shown as not wired.

### R36. A status bar that always shows what is undecided · S
- **Why:** Copperhead's workspace footer shows stale results, open blockers and items "without a verdict" at all times (LEARNINGS section 1). Our viewer already knows the `NOT_CHECKED` and `ERROR` counts. Stale marks and open obligations wait on R17.
- **Do:** show "N without a verdict, N stale, N survivors" in the viewer footer on every run, beside the score.
- **Done when:** a run with `NOT_CHECKED` results shows the count in the footer, and a test pins it. Held back with the rest of the viewer work (D7).

### R37. A judging queue for survivors · M
- **Why:** R6, Gate B and Gate C all need a person to judge items and keep the decision. Copperhead's Verification panel is a worked example: findings grouped into clusters "to judge", queue states (to judge, new, judged), a Coverage tab and a Decisions record (LEARNINGS section 5).
- **Do:** group survivors (by operator and target), let a reviewer label each real gap, equivalent or noise with a reason, store the labels as events, and show the running equivalent fraction. It doubles as the harness for the proof test.
- **Done when:** 30 survivors are judged in the viewer and the fraction appears with its sample size. Held back with the viewer work (D7), except that it is on the path to Gate A, so the plain-file version in R6 comes first.

### R38. Check-writing and survivor-labelling agents, as proposals · M
- **Why:** Gate B depends on AI-written checks, and R6 needs survivors labelled. Both are jobs a model can propose and cannot be trusted to decide (LEARNINGS section 7).
- **Do:** a check-writing agent proposes assertions in our grammar, each with a verbatim datasheet citation (R33), a closed-form calculation or a measurement; our engine scores the result. A labelling agent proposes real gap, equivalent or noise with evidence. **A label stays "proposed" until a person confirms it or a solver demonstrates it**, and only confirmed labels count toward the equivalent fraction.
- **Done when:** a labelling agent's proposals on 30 survivors are shown beside a person's labels, with the agreement rate reported, and the score never uses an unconfirmed label.

## 6. Surfaces: the viewer beside the agent

Phase C. Largely unverified; each needs probing on a real editor.

- **R24. Relay.** Serves the viewer, proxies the API, exchanges a first-load nonce for a session cookie so no token stays in the URL. View tokens must not be able to POST. (The run server already does same-origin serving and read-only tokens; this is the rest.)
- **R25. Editor extension.** Webview tabs beside the chat in VS Code and Open VSX forks.
- **R26. Probes.** Whether the preview pane loads a hosted URL versus localhost, docking beside Claude Code, Codex and Cursor, SSE through a proxy, workers under webview rules, publishing to both marketplaces. All are *unverified* in the plan and need a person at a screen.

## 7. The proof test (founder-owned, runs in parallel)

### R27. Proof-test materials · Human
The plan's riskiest assumption is that reviewing surviving faults makes engineers faster. Testing it needs about 10 public boards with blind-seeded bugs, 6 to 8 paid engineers, and a pre-registered hypothesis file committed before any run. Agents can build the study harness, timing sheets and analysis scripts; a person owns recruitment, the bug taxonomy (built independently of the mutation rules), and the pre-registration. Publish the numbers even if bad.

A useful source of realistic buggy boards: designs generated by AI tools such as Copperhead are naturally imperfect, and more representative than hand-seeded faults.

## 8. Later

One line each; see [PLAN.md](PLAN.md) for detail.

- **G. Learning:** lessons for agents, learned priorities, a graph model last.
- **H. Hand edits:** locks, undo, diff view. Needs rollback; Copperhead's git-snapshot handling (including that KiCad 9 writes a nested `.history/` repository that breaks `git add -A`) is worth reading first.
- **I. Multi-model and hidden fault sets:** a builder from one vendor, an attacker from another, rotating hidden faults to resist gaming the score.
- **J. Fabrication:** enclosure fit and print tolerances; printer export only through a local bridge, with a person pressing start.
- **K. A standalone IDE:** only if the extension cannot do the job and real users need one.
- **L. Registry, badges, datasets:** a GitHub Action, report pages and a score badge worded "scored", never "certified". Needs a lawyer for contribution terms.
- **M. Kinux hosting:** only if people ask for it.

## 9. Decisions needed from people

These cannot be settled by writing code. Until they are, the items that depend on them are blocked.

| # | Decision | Blocks |
|---|---|---|
| **D1** | **Kinux's licence.** A permissive licence is suggested. The project already contains Apache-2.0 code, so GPLv2 is ruled out. | everything public; R2's board terms |
| **D2** | **How to get KiCad 8 or later.** Options: the KiCad PPA (reachable from the container, but adding it was refused by the container's policy, so you would allow it or do it on your own machine), a CI runner that installs it (Copperhead's workflow is a worked example, see R8), a newer base image (Ubuntu 26.04 reportedly ships KiCad 9), or a pinned container image (needs Docker). **This is now the first thing to decide**, because without it no modern board can be opened. | R8, **R3**, and K4 |
| **D3** | **Where untrusted designs run.** Docker on your own machine, or a small rented Linux box. | R9, R23 |
| **D4** | **Which three boards.** | R2, R3, R13 |
| **D5** | **Commitment and the start date.** The plan's schedule assumes week 1 is 23 November, which was never confirmed, and asks for a pause plan. | every date on this page |
| **D6** | **When to add hosting.** Recommendation: after Gate A. Supabase fits logins, saved run history and shared runs; Vercel can host static report pages; neither runs solvers. | Phase L onward |
| **D7** | **Whether to pause surface work** (the MCP server, the Villain, physics in the viewer) until Gate A has real numbers. A reviewer recommends pausing. The MCP server is cheap and makes the Builder and Villain loop real, but it does not move Gate A. | the order of everything in section 3 and 4 |

## 10. Top risks

1. **Real boards may be mostly unsimulatable.** Many ICs have no SPICE model, so the checkable fraction on a real board could be small. We report it honestly, but it limits how useful the score is. R3 is where we find out. One data point from the buck converter's bill of materials (read, not tested): 23 of its 24 electrical parts are discrete (10 capacitors, 4 diodes, 5 resistors, a fuse, a ferrite jumper, an inductor, a transistor), and the one IC, the TPS5430, has no model in the repository. Mostly-discrete boards look checkable apart from the controller. Mitigations: behavioural models, a focus on power and analog subcircuits, and reporting model coverage as a first-class number.
2. **Gaming the score.** AI-written tests can aim at known operators. Hidden fault sets (phase I) are the planned answer.
3. **Equivalent mutants** can inflate or deflate the score (R6).
4. **Copperhead walks toward verification.** Its roadmap includes a SPICE gate, and its `fang` toolchain already holds a requirements graph, ngspice and Xyce backends, firmware emulation and an MCP server. It has no mutation testing (we searched the whole repository). Our edge is what does not bolt on in a weekend: mutation testing, validated physics, independence from whatever built the design, and honest `NOT_CHECKED` reporting. A viewer and an MCP server are not an edge. The sharper position is to be the independent scoring layer that works on any source, KiCad or code. The closest commercial neighbour is Konnect-EDA (Orchis.ai), which markets "design-review audits" beside 228 design tools, so someone is already selling review for agent-made boards.
5. **Solver inputs are hostile** (R9). One missed escape in any worker undoes the trust we are building.
6. **The proof test may fail.** The plan accepts that and says stop or pivot before the expensive phases. We should keep the open-source engine, the benchmark and a written negative result worth having either way.
7. **The score may measure the author's checks, not the design's risk.** Our own thorough suite scored 60.4% against faults it was not written for, and thermal checks added nothing. If the score mostly reflects what the check author thought of, it is a poor proxy for design risk. The hand-labelled survivors (R6) and the proof test are what will tell us.
8. **Copperhead adds a mutation score to its own `check`.** That is the closest threat, closer than any commercial product, because it already has the designs, the checks and the users. One response is to offer the engine to them as a plugin instead of competing. Their console now has a Verification section and a "Verify a design" card ("electrical and manufacturing checks plus a model review"). From their open-source `copperhead review` code (main, 2026-11-07), that review is built the way we would build it: a deterministic sweep first, then model passes whose claims are checked by deterministic verifiers, a report rendered from what the verifiers decided and never from the model's prose, and a replay that must reproduce the report byte for byte. A precise search of that code found no mutation testing, fault injection or scoring of the checks. We have not seen the hosted product itself, only a screenshot, so it may differ from the code we read.

## 11. Picking something up

1. Read STATUS sections 1, 5 and 8, then the item here.
2. Read [../CONTRIBUTING.md](../CONTRIBUTING.md) for setup and the rules every change follows.
3. Say you are taking it, in an issue or draft pull request, so two people do not build the same thing.
4. Good first items: R1, R10, R11, R12.
5. When you finish, update STATUS (the component table, test counts, and the issue list) in the same change.

### R39. Ideas from Copperhead's website (copperhead.sh), not yet built
Source: an agent read their posts and the copperbench page (2026-11-21). Their benchmark has a method but no runner and no results, and their verification is KiCad ERC/DRC, which they call "a floor". They have no mutation testing. Worth adopting, cheapest first:
- **S:** report pass^k (all repeats passed) next to the mean, with cost per passing task; an allowlist of known baseline violations ("enumerate and account") so a new type or higher count fails; a credential scan that fails a run; refusals graded on a cited source.
- **S to M:** a comparability stamp (suite, design hash, tool versions) so records that disagree are never averaged; a build that fails if a published number does not regenerate from stored results.
- **M:** a closed assertion vocabulary with offline re-grading from stored evidence; a deterministic failure-category classifier ranked by frequency times cost; "looks green but wrong" tasks (budget tampering, whole-file regeneration, partial rename), which our mutation operators could generate; contamination variants (renamed nets, permuted pins, scaled values); a mesh-refinement or timestep check stored with each solver verdict.
- **Caution:** their claims of drift and respin costs ($5-50k) are unsourced, and their demo covers specification to part selection only.

### R40. tscircuit and KiCad as input adapters · S to L, staged
Source: an agent ran a spike and read package sources and KiCad docs (2026-11-21). **Verified by running it:** the sandbox reaches npm; `@tscircuit/core` 0.0.2445, `circuit-json` 0.0.559 and `circuit-json-to-spice` 0.0.51 install; Bun 1.4.4 turned a 4-part `<board>` into Circuit JSON headless, and the converter emitted a deck. **Read from the converter's source:** it has cases for resistor, capacitor, inductor, diode, LED, BJT, MOSFET and switch, plus voltage and current sources and an op-amp. That corrects this item's earlier text, which said R, C and BJT only (the converter's README says the same, and is stale). **Not verified:** that the source, MOSFET and op-amp output is correct or that ngspice accepts it; the emitted deck had no ground node, so it was not simulation-ready. The `tsci` CLI was not tried.
- **Architecture:** our SPICE-level netlist model (`engine/netlist.mjs`) stays the internal representation, not Circuit JSON (too broad, and 559 releases in about a year). Adapters (`adapters/kicad`, `adapters/tscircuit`) each emit a deck, a sidecar mapping line ids to source references, and a model-coverage report. Mutation operators act only on the deck; survivors map back to a KiCad span or a `.tsx` line. Source files are never mutated.
- **Plan:** (1) spike, S: a tscircuit RC or divider board with a source and ground scored by `kinux verify`; pin versions, and `@tscircuit/core` has about 20 peer dependencies that must be installed explicitly. (2) our own Circuit JSON to SPICE emitter, M, tested against ngspice, done when three code-defined boards give a nonzero checkable fraction. (3) sidecar and source-line mapping, M. (4) KiCad adapter, L, blocked on D2/R8; `kicad-cli sch export netlist` lists a `spice` format, but real parts mostly lack simulation fields (risk 1). (5) cross-check a board in both formats, S. Do K10 and K19 first.
- **Risks:** a `.tsx` file is executable code, so run it in a sandboxed subprocess with no secrets; tscircuit stays a build-time dependency of the adapter only; core's npm metadata showed no licence field (unconfirmed); copy only MIT, Apache or ISC code, with a notice, and prefer our own emitter; report code-defined boards separately in Gate A because they may not resemble real ones.
