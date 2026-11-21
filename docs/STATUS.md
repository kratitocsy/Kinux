# Status: what exists today

**As of 2026-11-21**, branch `claude/confident-bardeen-wseypk`, at commit `aa72655`.

This page is for people who want to work alongside the project. It says what has been built, what each piece really does, what has been measured, and what is missing. It records what was run, not what was intended. For where the project is going, read [ROADMAP.md](ROADMAP.md). For how to set up and contribute, read [../CONTRIBUTING.md](../CONTRIBUTING.md). The original plan is [PLAN.md](PLAN.md). What we learned from reading neighbouring projects is in [LEARNINGS.md](LEARNINGS.md).

If this page and the code disagree, the code is right: please fix this page.

## 1. The short version

- **The core loop works, end to end, on a hand-written SPICE circuit.** A netlist and a set of checks go in. The engine runs the checks on the original design (the *baseline*), generates faults (*mutants*), runs the checks on each one with real ngspice, decides which faults the checks caught, and produces a score with a confidence interval and an event stream. A browser viewer shows it, live, while it runs. A full run of 54 mutants takes about 3 seconds.
- **The scorer works, on small circuits.** A weak check suite scores clearly lower than a thorough one on the same design, and the confidence intervals do not overlap (section 4). That shows the score discriminates. It does **not** show that the score predicts design risk, or that engineers review faster with it: both are untested, and the thorough suite's 60.4% against 54 generated faults suggests a score can reflect the check author's blind spots.
- **It has not been run on a real KiCad project.** The link from a KiCad project to a SPICE netlist is not built. The only designs so far are two small circuits written by hand. This is the biggest gap between where we are and the project's first gate.
- **Other physics exists as separate workers.** A lumped thermal model is wired into the engine. A MuJoCo motion worker and a CalculiX finite-element worker are each built and checked against hand calculations, but they stand alone: nothing mutation-tests them yet, and the viewer does not display their results.
- **Not built at all:** the MCP server, the editor extension, the relay, 3D views, the part and interface model, Villain agents, learning, hosting.
- **Tests:** 325 tests in 17 test files. 324 pass, 0 fail, 1 skipped (the IPv6 test, because the development container has no IPv6). These counts hold in the development container. On a machine missing a solver, most of the affected suites fail rather than skip (K21).

## 2. How the pieces fit

```
design.cir ──────┐
checks.md ───────┼──► engine/ ──► workers/ngspice ──► ngspice (real binary)
thermal-model.json   │   baseline first, then mutants
                     ├──► workers/thermal  (power from ngspice currents → temperature)
                     │
                     ├──► events.jsonl  ── checked against contracts/ ──┐
                     └──► report.md / report.json                       │
                                                                        ▼
                                   server/run  (SSE, resume, replay)  ──► viewer/ (browser)

Standalone, not yet called by the engine:
  workers/pcb     KiCad board parser, trace-current check, ERC/DRC report parser
  workers/kicad   KiCad schematic reader (components, source spans)
  workers/motion  MuJoCo recorded trajectories and checks
  workers/fea     CalculiX + Gmsh: stress, conduction, thermal stress, modal
  server/queue    durable job queue, cache, receipt builder (the queue IS used by the engine; receipts are not)
```

Everything speaks the formats in `contracts/`. An event has `run_id`, `seq`, `design_hash`, `provenance` (`real`, `recorded` or `synthetic`), and a typed `data` payload. The viewer, the run server and the engine all validate against the same schemas.

## 3. Try it

You need Node 22 and ngspice. Setup details are in [CONTRIBUTING.md](../CONTRIBUTING.md).

```bash
npm ci
npm test                                   # needs every solver installed; see K21 for what a missing one does
```

Run a mutation test and watch it live:

```bash
node engine/cli.mjs verify examples/phase-leg-support/phase-leg-support.cir \
  --checks examples/phase-leg-support/checks-thorough.md \
  --out /tmp/kinux-run --serve 7777
```

It prints a **WATCH IT** link before the solver starts. Open it and the three panels fill in as the run goes. The server keeps running afterwards so you can replay the run. Press Ctrl-C to stop. The link is only reachable on the machine running it.

Compare a weak suite against a thorough one:

```bash
for s in weak thorough; do
  node engine/cli.mjs verify examples/phase-leg-support/phase-leg-support.cir \
    --checks examples/phase-leg-support/checks-$s.md --out /tmp/kinux-$s --threshold 0
done
```

## 4. What has been measured

Every number here was produced by running the code. The command to reproduce is next to it.

### The central claim: weak checks score lower than thorough ones

| Design | Suite | Mutants killed | Score | 95% interval |
|---|---|---|---|---|
| `engine/fixtures/divider-rc.cir` (33 mutants) | weak | 4 of 33 | **12.1%** | 4.8% to 27.3% |
| same | thorough | 24 of 33 | **72.7%** | 55.8% to 84.9% |
| `examples/phase-leg-support` (6 hand-picked faults) | weak | 1 of 6 | 17% | not computed |
| same | thorough | 6 of 6 | 100% | not computed |

The intervals on the first pair do not overlap. Reproduce with `node engine/cli.mjs verify engine/fixtures/divider-rc.cir --checks engine/fixtures/checks-weak.md` (and `checks-thorough.md`).

**What this shows, and what it does not.** It shows the scorer separates a weak suite from a thorough one on one circuit with 33 mutants. That is a sanity check of the scorer. It does not show that a high score means a safe design, or that reviewing survivors saves engineers time. The demo's own thorough suite scored 60.4% against 54 generated faults, so a score can reflect what the check's author happened to think of.

The weak suites are written to be weak honestly: the three nets anyone would name, with bounds that look reasonable, and no transient or AC checks. They are plausible, not sabotaged.

### The thorough suite is not as thorough as it looked

The demo's thorough suite caught all 6 of the faults the author picked by hand. Against the 54 faults the engine generates from its own operators, it scores **60.4%** (32 killed of 53 checkable, interval 46.9% to 72.4%).

Every mutant of `RGS`, the 10 kΩ gate pulldown, survives. That resistor exists to hold the switch off when the driver is not driving it, and no check tests that situation. The author of the checks did not think of it. The engine found it. This is the product doing its job.

One mutant, an open connection at the shunt resistor `RSH`, makes ngspice fail to converge. It is reported `NOT_CHECKED` and left out of the score, so the checkable fraction is 98.1%.

### Thermal checks add nothing on this circuit

Thermal checks catch fault M4 (shunt 2 mΩ to 20 mΩ: 8 W against a 2 W rating, 440 °C against 125 °C). But over every mutant the engine generates, **they kill nothing the electrical suites do not already kill.** The weak suite kills 17 of 54 mutants with and without the thermal checks.

The reason is specific to this circuit: every power fault also moves a voltage that some electrical check watches. The thorough suite's `V(sh) < 50m` is a power limit in disguise. This does not mean thermal checks are useless. It means this circuit is the wrong place to demonstrate them. Thermal checks should earn their keep on faults that raise temperature without moving a measured voltage.

### The solvers match hand calculations

| Solver | Check | Result |
|---|---|---|
| ngspice | RC step response against `1 - exp(-t/RC)` | within 1.8e-6 relative at 1τ, 7e-7 at 3τ |
| ngspice | five identical runs | one SHA-256, byte-identical output |
| ngspice | speed | about 6 ms per small run |
| IPC-2221 trace current | five hand-worked ampacity values | agree to under 1e-6 relative |
| MuJoCo | physical pendulum period against `2π√(I/(m·g·d))` | 6.1e-6 relative; halving the timestep cuts the change by 4.0 each time, which is second-order convergence |
| MuJoCo | torque-driven joint, `α = τ/I` | exact to 1.4e-14 |
| lumped thermal | `P = I²R`, `ΔT = P·Rθ`, transient at one time constant | match hand calculations, shown in test comments |
| CalculiX | cantilever tip deflection `FL³/3EI` | 1.52068 mm against 1.52381 mm: 0.205% |
| CalculiX | cantilever bending stress at mid-span, `Mc/I` | 60.0000 MPa against 60.000 MPa |
| CalculiX | cantilever first natural frequency | 209.020 Hz against 208.879 Hz: 0.067% |
| CalculiX | bar held at both ends and heated, `−EαΔT` | −252.000 MPa against −252 MPa |
| CalculiX | heat flow along a rod, `kAΔT/L` | 5000.00 mW, exact |

All four finite-element checks run at three mesh sizes and must settle. The deflection, stress and frequency figures were also recomputed independently from the formulas. Two of the four (conduction and thermal stress) are easy cases: a linear temperature and a uniform stress are exact at any mesh size, so they check units, boundary conditions and output parsing rather than mesh error.

### Scoring designs written in Copperhead's `fang`

A spike (`spikes/fang/`, reproducible in about 40 seconds) took the SPICE decks `fang` builds for two of its examples and gave them to our engine, with each example's own requirement written as a Kinux check.

| Example | fang says | Kinux mutation score | 95% interval |
|---|---|---|---|
| `rc_filter`, corner between 1.5 and 1.7 kHz | PASS | 62.5% (5 of 8 checkable; 13 mutants) | 30.6% to 86.3% |
| `buck_regulator`, 3V3 rail within 3% | PASS | 27.4% (17 of 62) | 17.9% to 39.6% |

Both pass in `fang` and both reveal blind spots. The RC filter's band absorbs a 5% drift in either part. The buck converter's bench uses a fixed-duty model with no control loop, so no fault in the feedback network can be seen. Four caveats matter: the checks are weaker than fang's full questions (no ripple measure); 22 of the 62 buck mutants are inside the inlined behavioural model, so the design's own parts score 9 of 40; the deck capture wraps an internal method and may break; and only 2 of 12 `fang` examples produce an ngspice deck at all. The `servo_drive` example has no simulation question. Details are in `spikes/fang/README.md`.

### Speed

A full mutation run of 54 mutants takes about 3.3 seconds on the development container. The project's first gate allows 10 minutes per board, so electrical mutation testing is cheap. Finite-element runs will not be: 50 mutants at three minutes each is about 2.5 hours. That is where parallel compute becomes worth paying for.

## 5. What each component is

Status words: **working** means it runs and is tested against real tools. **partial** means it works but has a stated gap. **standalone** means it works but nothing else calls it yet.

| Component | Path | What it does | Tests | Status |
|---|---|---|---|---|
| Contracts | `contracts/` | JSON Schemas for events, manifests and receipts (version 1, frozen), plus `check-run.mjs` with validators, the score arithmetic and the consistency rules. | 15 | working |
| ngspice worker | `workers/ngspice/` | Runs ngspice safely and turns measurements into verdicts. `sanitize.mjs` is a default-deny allowlist for `.control` blocks. `assertions.mjs` is a closed assertion grammar (`V(out) between 2.3 and 2.4`) compiled to ngspice. | 13 + 23 | working |
| PCB worker | `workers/pcb/` | Parses `.kicad_pcb` boards. IPC-2221 trace-current check. A `kicad-cli` wrapper that refuses to pretend ERC, DRC or GLB export ran when the installed version cannot. An ERC/DRC report parser. | 17 + 20 | partial: ERC and DRC cannot run on KiCad 7 |
| KiCad schematic reader | `workers/kicad/` | Reads `.kicad_sch` into components, labels, wires and sheets, with a source span (file, line, byte range) on everything. Derives connectivity for single flat sheets and refuses otherwise. | 32 | partial: no hierarchy |
| Mutation engine | `engine/` | `netlist.mjs` parses SPICE. `operators.mjs` has 12 mutation operators. `runner.mjs` runs baseline first, then mutants. `equivalence.mjs`, `report.mjs` (score, interval, cap) and `cli.mjs` (`kinux verify`). | 38 | working on `.cir` files only |
| Live bridge | `engine/live.mjs` | Streams the engine's events into the run server while it runs. | 16 | working |
| Job queue | `server/queue/` | Durable queue on SQLite with fenced leases and heartbeats. Retries only infrastructure failures, never a genuine FAIL. Content-addressed cache. Receipt builder. | 16 | working; receipts not yet called by the engine |
| Run server | `server/run/` | Append-only `events.jsonl`, SSE with `Last-Event-ID` resume, byte-identical replay, view and drive tokens, and it can serve the viewer from the same origin. | 27 | working; IPv6 untested |
| Viewer | `viewer/` | Browser UI: run log, design view, instrumentation, with a provenance badge on every panel. Per-component thermal cards. Static export that opens offline. | 18 + 13 | partial: see section 6 |
| Thermal worker | `workers/thermal/` | Lumped thermal model: power from ngspice currents, `T = Ta + P·Rθ`, optional transient. Closed `## Thermal` check grammar. | 16 | working, one-way coupling only |
| Motion worker | `workers/motion/` | Runs MuJoCo models, records trajectories at a fixed rate, checks them in a closed grammar, exports joint torque as a load. | 12 | standalone |
| FEA worker | `workers/fea/` | Four CalculiX slices on Gmsh meshes: cantilever stress, heat conduction, thermal stress, modal. Mandatory mesh-convergence rule. Sanitizers for CalculiX `.inp` and Gmsh `.geo` input. | 18 | standalone |
| Demo design | `examples/phase-leg-support/` | A 48 V phase-leg support slice: gate drive, shunt current sense, DC-link feedback. Two check suites, a thermal model, six hand-picked faults. Not a full motor driver (its README lists what it leaves out). | 18 | working |
| Doctor and test runner | `scripts/` | `npm run doctor` reports which tools this machine has, which are hidden from the workers, and which suites will run. `npm test` skips suites whose solver is missing and says why. | 13 | working |
| Environment spike | `spikes/env/`, `docs/SPIKE-ENV.md` | A re-runnable probe of what the toolchain can do here, and the findings. | n/a | done |

### Test counts by suite

`contracts` 15 · `ngspice-worker` 13 · `ngspice-assertions` 23 · `pcb-worker` 17 · `pcb-erc-drc` 20 · `kicad-sexp` 32 · `queue` 16 · `engine` 38 · `live` 16 · `examples` 18 · `run-server` 27 (26 pass, 1 skipped) · `viewer` 18 · `viewer-thermal` 13 · `thermal` 16 · `motion` 12 · `fea` 18 · `tools` 13. **Total 325.**

Tests call the real binaries (ngspice, `kicad-cli`, MuJoCo, CalculiX, Gmsh), not mocks. The motion tests skip with a printed reason when MuJoCo is missing rather than passing. The FEA and thermal tests need their tools installed.

## 6. What is real, synthetic, or a placeholder

Every event carries a provenance label and the viewer always shows it. These are the same distinctions, for people:

**Real** (a solver produced the number): the ngspice verdicts, the mutation scores on the two circuits, the MuJoCo trajectories, and the thermal numbers as computations. One caution on thermal: the arithmetic is real, but the thermal resistances and power ratings are stated design rules or assumptions, not datasheet figures, because the demo circuit names no part numbers. They are not measurements of a real part.

**Synthetic** (made by hand, labelled as such): the sample run in `contracts/fixtures/` (no solver produced it), the thermal panel's test fixture, and five of the eight ERC/DRC report fixtures. Those five are written from the shapes KiCad's reports are believed to have, and have never been checked against a real KiCad 8 run. Tests that pass against them prove the parser is consistent with our belief, not with KiCad.

**Placeholders in the viewer** (shown as "NOT WIRED", deliberately not drawn):

- 3D board and assembly view
- thermal *field*: the per-part thermal numbers are real, but there is no spatial temperature, because a lumped model has none to show
- structural stress
- schematic and PCB layers
- MuJoCo playback: the worker exists but the viewer does not render trajectories
- waveforms: the panel has the artifact reference but does not load the samples

The concept images in the README and plan are renders of the end goal. None of their numbers come from runs.

## 7. Findings worth knowing

Things we learned by running the tools. Several change how the project has to be built.

1. **A SPICE netlist can run shell commands.** ngspice executes `shell` inside a `.control` block even in batch mode. We proved it by creating a file. Netlists come from untrusted projects, so this is a remote-code-execution path. The sanitizer in `workers/ngspice/sanitize.mjs` is mandatory, and with no container available it is currently the only barrier.
2. **Every solver's input format is executable or reads files.** This turned out to be a pattern, not a one-off, and each one was verified by running the real tool:
   - **Gmsh:** a `.geo` file's `SystemCall` runs arbitrary commands. Raw gmsh created a file from `SystemCall "echo OWNED > pwned.txt";`. The same format can also read and write files and set solver executables.
   - **CalculiX:** `*INCLUDE` follows paths outside its directory in any spelling, because ccx strips blanks and ignores case. Other keywords read or write files, and `*RESTART` makes ccx call `system()` with the job name.
   - **MuJoCo:** `<include file=...>` loads `../secret.xml`, and supplying an assets dictionary does not stop it falling back to disk.

   Each worker default-denies its input and contains file access to the design's own directory, with tests. Treat any new solver's input format as hostile until shown otherwise.
3. **KiCad 7 cannot run ERC or DRC.** Ubuntu's `kicad-cli` is 7.0.11, which has only `export` commands. ERC, DRC and GLB export arrived in KiCad 8. Those checks return `NOT_CHECKED` here, naming the version gap.
4. **KiCad reports unrouted connections as errors.** DRC `unconnected_items` carry `"severity": "error"` but are just ratsnest, not defects. Treating them as failures would fail every real board's baseline, and then no mutant could be scored. Findings confined to a single footprint get similar treatment, with exceptions that matter (shorts, duplicated references, unverified footprints still fail).
5. **Hand-picked faults overstate quality.** The demo's thorough suite looked complete against six faults chosen by its author and scored 60.4% against the engine's 54. The gap is the product's reason to exist.
6. **Copperhead's SPICE module could never have worked.** We borrowed its assertion grammar (see section 10). It emitted `.meas op ...`, which ngspice rejects; `i(R5)` for resistors, which ngspice cannot resolve; and a margin expression that cannot reference another measurement. We kept the grammar and rewrote the compiler. Reading code was not enough; only running the real binary exposed it.
7. **KiCad labels connect by name, not only by touch.** Copperhead's net model fragmented nets for that reason. Ours merges by name after the geometric pass.
8. **Exported SVGs carry a wall-clock timestamp**, so the same board hashes differently each run. This does not affect the input-keyed cache but defeats storing artifacts by content hash until the timestamp is normalised.
9. **Thermal checks added nothing on the demo circuit** (section 4).
10. **A timestep-convergence gate can be fooled** if both timesteps are equally wrong. The motion worker's README gives the example: explicit Euler at 100 ms pins peak torque at the force limit at both steps, so it reads as converged while the true peak is about 62 N·m.
11. **Every optional flag on a tool is a possible way around a rule.** The design of the future MCP server (see ROADMAP) should expose no tool that can produce a score without running the baseline.
12. **The mesh-convergence rule catches a real wrong answer.** Linear tetrahedra at 20, 15 and 10 mm give cantilever deflections of 0.40, 0.56 and 0.69 mm against a true 1.52 mm. They lock in bending and keep changing about 25% per step, so the result is `NOT_CHECKED` instead of a wrong PASS. Without the rule this would have been a believable wrong number.
13. **CalculiX's `.frd` result file carries a timestamp**, so only `job.dat` is byte-reproducible. The worker reads results from `job.dat` only.
14. **The KiCad version is a hard wall, not a missing feature.** KiCad 7 refuses files from KiCad 8 or later outright (K4). Our own reader still parses them, so we can read modern boards but cannot simulate them. Copperhead requires KiCad 8 or later, so every board it generates is out of reach here too.

## 8. Known issues and limits

Numbered so they can be referred to. Items marked **gap** block a roadmap goal.

| # | Issue | Severity |
|---|---|---|
| K1 | **No container isolation.** There is no Docker daemon in the development container. The ngspice sanitizer is the only barrier against hostile netlists. Do not run third-party designs here. | gap |
| K2 | **No KiCad to netlist link.** The engine consumes a hand-written `.cir`. `kicad-cli sch export netlist --format spice` exists in 7.0.11 (the help lists `spice`), but nothing calls it. It was tried once, on real projects, and **cannot open any of them**: see K4. | gap |
| K3 | **Schematic connectivity is single flat sheet only.** Hierarchical designs return `not_derivable`. Of 19 real schematics tried, 10 derived and 9 were refused. | gap |
| K4 | **KiCad 7 cannot open files saved by KiCad 8 or later, and Ubuntu ships only 7.0.11.** Measured: 18 of Copperhead's 19 schematics (file version 20231120) all failed to load, and its one board (20240108) was refused with "unable to open this file because it was created with a newer version of KiCad". The same command loads our KiCad 7 board (20221018). So every modern board is out of reach until a newer KiCad is available, which blocks K2 and R3 outright, not only ERC, DRC and GLB export (which also need 8 or later). Adding the KiCad PPA was refused by the container's policy. The live ERC/DRC call path is unwired. | gap, blocks K2 |
| K5 | Equivalent-mutant detection accepts only two proofs (identical text, or a change below 1e-6 relative). It deliberately under-detects, which lowers scores. First measurement (ROADMAP R6): 21 of 78 survivors (27%) are solver-identical to the original; labels for the rest are agent proposals awaiting a person, and none come from real boards. | gap |
| K6 | The engine does not produce evidence receipts. `server/queue/receipt.mjs` builds them but nothing calls it. | gap |
| K7 | A CI workflow (`.github/workflows/ci.yml`) is written and parses, but has **never run on GitHub**: it was authored in a container with no access to Actions. It runs `npm run test:all`, so a missing solver fails instead of skipping. Expect to adjust the first run. Two things are unverified: that MuJoCo's pinned wheel exists for the runner's Python, and the IPv6 test on a runner. | gap |
| K8 | `corner()` in the assertion grammar is an absolute −3 dBV crossing, so it only means "filter corner" when passband gain is 0 dB. | bug |
| K9 | `scope:` in a `## Simulation` block is parsed but not enforced. | bug |
| K10 | `3.3F` reads as 3.3 femto in `workers/ngspice/assertions.mjs` (which matches ngspice), but as 3.3 with the unit "F" in `engine/netlist.mjs`. The two number parsers disagree. Both read `M` as milli and `meg` as mega, correctly. These parsers sit on the verdict path, so this should be fixed before Gate A. | bug |
| K11 | One queue test ("timeouts") failed once under full-suite load and passed 15 of 15 times in isolation. It uses a 200 ms process-kill timeout. | flaky |
| K12 | `node:sqlite` needs a recent Node 22 and prints an ExperimentalWarning. `package.json` had said Node 20 would do; that was wrong. | fixed in this change |
| K13 | The IPv6 listener has never run: the container has no IPv6 stack. The test skips visibly. | unverified |
| K14 | The live server serves one run per process, and the viewer has no banner when the server goes away. | limit |
| K15 | The motion worker and the PCB workers are not called by the engine. | gap |
| K16 | Three folders lack READMEs: `server/queue`, `workers/ngspice`, `workers/pcb`. This page is currently their documentation. | docs debt |
| K17 | Packages installed with `apt` in the development container do not persist. A new container needs them again. | setup |
| K18 | The project has no licence yet, and it contains Apache-2.0 code (section 10). | decision |
| K19 | **Inconsistent reason-code mapping.** `workers/ngspice/verdict.mjs` maps `mesh_failed` and `mesh_not_converged` to `ERROR`; the FEA worker maps them to `NOT_CHECKED`, as the plan says. The contract allows both. They should be unified, and before Gate A, because this is the verdict path. | bug |
| K20 | Only one of the physics workers (thermal) is mutation-tested. Motion and FEA have validated checks but no mutants, no engine integration, and no viewer panels. | gap |
| K21 | **Mostly fixed.** `npm test` now skips a suite whose solver is missing, by name and with the reason, and `npm run doctor` says what is missing. Measured by pointing ngspice, CalculiX and Gmsh at nothing: 7 suites skipped and the other 10 passed 182 of 182, where before dozens of tests failed. The skip is per suite, so a suite's pure unit tests are skipped with it. Running `node --test` directly, or `npm run test:all`, still fails where a tool is missing, on purpose (CI uses `test:all`). | fixed, with a limit |
| K22 | **Tools are found at a fixed path.** Workers launch their tool with `PATH` set to `/usr/bin:/bin`, so ngspice, CalculiX or Gmsh installed elsewhere (for example Homebrew on macOS, `/opt/homebrew/bin`) are not found. Override with `KINUX_NGSPICE_BIN`, `KINUX_CCX_BIN`, `KINUX_GMSH_BIN` and `KINUX_PYTHON`, each an absolute path. `kicad-cli` has no override and is found through the normal `PATH`. Nothing has been run on macOS or Windows. `npm run doctor` now reports a tool installed where the workers will not look as HIDDEN, and prints the variable to set. | limit |
| K23 | **Datasheet sources in the thermal model are bare strings that nothing verifies**, so an invented thermal resistance would pass. A model that says `datasheet:` today could be wrong or made up. See R33. | gap |

## 9. In flight right now

Nothing. Every worker that was being built has landed and is committed. If you start something, say so in the issue or pull request so others do not duplicate it (see [../CONTRIBUTING.md](../CONTRIBUTING.md)).

## 10. Environment, and borrowed code

### The development container

Where the numbers above came from. Reproduce what you can with `spikes/env/probe.sh`.

| Tool | Version | Source | Notes |
|---|---|---|---|
| Node | 22.23.5 | preinstalled | tested here; needs 22.13 or later for `node:sqlite` |
| ngspice | 42 | `apt` | byte-reproducible |
| KiCad (`kicad-cli`) | 7.0.11 | `apt` | no ERC, DRC or GLB |
| CalculiX `ccx` | 2.21 | `apt` | 20 ms for a one-element solve |
| Gmsh | 4.12.1 | `apt` | meshes headless |
| MuJoCo | 4.0.1 | `.venv` (Python 3.13) | pinned in `workers/motion/requirements.txt` |
| Docker | client only | preinstalled | **no daemon** |

### Code borrowed from Copperhead

[copperheadhq/copperhead](https://github.com/copperheadhq/copperhead) is an Apache-2.0 LLM agent for KiCad design. We read its codebase and took three modules, rewriting each for our needs. Its parts are listed in [../THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) with what changed, and each derived file carries the notice in its header, as Apache-2.0 requires.

- the SPICE assertion grammar → `workers/ngspice/assertions.mjs`
- the schematic reader → `workers/kicad/sexp.mjs`, with spans added
- the ERC/DRC report parser → `workers/pcb/erc-drc-report.mjs`

Taking Apache-2.0 code rules out a GPLv2 licence for Kinux. Our own licence is undecided.

Copperhead builds designs; Kinux checks them. We deliberately did not take its design-generation code. It has no mutation testing, no physics beyond connectivity, no mechanical or motion checks, and no part or machine model.

### Worth reading in Copperhead's other branches

Copperhead's repository has 83 branches. **None is named "research"**: they are `feat/`, `fix/`, `docs/`, `chore/` and `propose/` (written specs). These are the ones relevant to us. I read their READMEs, proposals and commit messages; I did not run any of it, and several are behind `main`, so a diff against `main` is noisy.

| Branch | What it is | Why it matters to us |
|---|---|---|
| `feat/intake-extraction-core` (212 files not on `main`) | **Datasheet intake**: turns a datasheet into typed, source-cited, confidence-scored facts, then gives APPROVE, REFUSE or HOLD with the exact datasheet line and rule line cited. The verdict engine is a pure function: no network, no clock, no model. A value whose quoted text is not found in the datasheet is held, never trusted. | The same principles as ours, applied to a gap we have: our thermal model records `datasheet:` as a bare string. This is how to make that provenance checkable (R15, R19). It is a separate workspace and needs external API keys. |
| `fix/320-fabricated-tool-results` | A model that carries on past its tool calls in the harness's own transcript format, inventing `[result of <tool>]` lines. Everything from that line on is treated as fabricated and discarded, and a `fabricated-results` event is logged. | Agents can invent tool results. When the MCP server and Villain loop exist (R14, R16), verdicts must come only from real solver output. |
| `feat/kicad-ipc-bridge`, `add-kicad-side-panel` | Reads the selection and open documents from a running KiCad through its IPC API (KiCad 9 or later), and a panel inside KiCad. | A different surface for R26, and a parallel to our own `get_selection` tool. Needs KiCad 9+. |
| `add-circuit-json-export`, `circuit-json-corpus-run` | Export to tscircuit's `circuit-json` format, with SVG renders of 10 real designs. | A possible route to a 2D schematic panel. But their exporter works from their own drafting model, and lifting circuit-json from an arbitrary `.kicad_sch` is explicitly out of their scope. |
| `docs/cloud-console` | Their hosted product: a GitHub App, a fresh container per run, no model in the check, tenant isolation enforced in the database, and a rule that design files are never stored. | A worked example for Phase L (registry and badges) and for hosting decisions (D6). |
| `fix/355-erc-exclusions` | ERC exclusions declared as named entries with a reason, instead of KiCad's own markers, which are keyed by position and change every re-draft. Every excluded finding is printed with its reason. | The pattern for R5: a "reported, never a failure" class should name what it excuses and why. |
| `fix/drift-si-mega-vs-milli` | Fixed `1m` and `1M` comparing equal, nine orders of magnitude apart. | We checked: our parsers are right, but the KiCad hand-off needs a test (R3). |
| `remove-synap-memory` | Removed a cross-run memory integration: "in-repo docs and constraints stay the agent's only memory". | Prior art for the plan's phase G memory, where an external memory service was tried and dropped. The reason is in their issue #167, which I did not read. |

### Copperhead's other repositories

The `copperheadhq` organisation has more than the main repository. Read-only clones are in `/home/user/copperheadhq/` and none of it is copied into Kinux. All eight repositories were read, most only at the level of READMEs, example sources and code headers. **`fang` was also run**, once you approved it, in a throwaway virtualenv built from a copy: see section 4 and `spikes/fang/`. Its first install attempt was blocked by the session's permission check, and we waited for approval rather than work around it.

- **`copperhead-research` has no licence file**, and its README says "Private for now". Reading it for ideas is fine; copying its code, data or figures is not. It holds one study, `diffpair-meanders`: whether serpentine length tuning removes skew in a differential pair, answered with **openEMS** (FDTD), mixed-mode S-parameters and a calibrated line model. Everything in it is simulated; nothing was built. Ideas worth taking: its conventions match ours (every quoted number generated by a script from the results, never typed; raw solver output and a provenance record committed beside the scripts); it runs three mesh levels with a Richardson extrapolation and grid convergence index, the same idea as our mesh-convergence rule; and it writes the openEMS model as **XML and runs the binary**, so no Python bindings are needed. That is the shape an openEMS worker in Node would take (Phase E).
- **`copperhead-tps5430-buck-converter` and `copperhead-555-oscillator`** are candidate first real boards. Licences, format and what makes them useful are under R2 in the roadmap. `copperhead-quiet-orbit` (an ATtiny84A with four LEDs) and `copperhead-stm32-data-logger` (an STM32L433 logger) are the same kind of AI-designed, never-built board with the same licence pattern, but dominated by a microcontroller, so less suited to ngspice. `copperhead-site` is an MIT-licensed marketing page and not relevant.
- **`fang` is the most relevant find**: "Hardware as Code", Apache-2.0, version 0.1.0, Python 3.11 or later with no runtime dependencies, 44 test files. A typed design kernel in which a design is Python source. It lowers to a KiCad netlist, simulation decks (ngspice, Xyce), views and CAD, and it can run a board's firmware in Renode. Its README lists a 111-requirement normative specification covering typed interfaces and their compatibility checks, units, explicit unknowns, append-only provenance, three-valued constraint logic, impact propagation and routing each question to the cheapest level that can answer it. Its stance matches ours: "a pass is a finding with the confidence its model provenance supports, never proof of physical correctness", and a plan that cannot be satisfied is refused, never run with a substitute. Its `servo_drive` example is three half-bridges with CAN, an encoder and a shunt per phase, which is close to our target demo. **It has no mutation testing**: we searched the whole repository. We have not read its specification, only the README, example sources and code headers. We ran its examples (section 4).

### Other projects in this space: a survey

Found by searching GitHub, then cloning six and reading them at the level of READMEs, tool lists and keyword searches. Nothing was run, and a GitHub search is not exhaustive. **None of the six was found to do mutation testing**: a keyword search of all six found no real hit (the apparent ones were "mutations" meaning schematic edits, and "injection" meaning dependency injection). That is not proof for the whole world: fault simulation is an established field in chip testing, so our novelty is applying it to board-level design checks with agents, not the idea itself.

| Project | What it is | Licence | What matters to us |
|---|---|---|---|
| `mixelpixx/KiCAD-MCP-Server` (3,465 stars) | MCP server for KiCad. About 35 tools; the only verification-flavoured ones are `drc` and a UI check. Its author's work **grew into a commercial product**, Konnect-EDA (Orchis.ai): 228 tools in 21 on-demand toolsets, including ERC, DRC and "design-review audits", free for individuals and licensed for businesses. | MIT | The nearest commercial competitor in the agent-plus-KiCad space. Its "on-demand toolsets" show what happens when a tool surface sprawls. |
| `shuvamk/openbench` | A browser workbench: schematic editor, ngspice compiled to run in the tab, KiCad import and export, firmware in an emulator, and an MCP server per engine. 525 tests. | Apache-2.0 | Its ngspice MCP tools take a **validated JSON netlist**, never raw SPICE text, and a compiler builds the deck, so a `.control` shell command cannot be smuggled in. Supports our closed-grammar decision. |
| `clanker-lover/spicebridge` | An MCP server for ngspice with 28 tools: templates, Monte Carlo and **worst-case tolerance analysis**, a model wizard that writes SPICE models from datasheet parameters, and spec verification. | **GPL-3.0** | Worst-case analysis covers what single-fault testing cannot (R29). The model wizard addresses the missing-model problem. GPL means we must not copy its code. |
| `atopile/atopile` (4,088 stars) | A language and toolchain for electronics: `.ato` files with equations, "deep validation" and parametric part picking. | MIT | Designs carry their own `assert`s and requirements, so checks can come from the design source (R4). Little simulation: `ngspice` appears in one file. |
| `tscircuit/tscircuit` (3,060 stars) | Electronics in TypeScript and React, with 2D and 3D previews. The repository is a thin umbrella of 46 files; the real code is elsewhere. | MIT | Defined the `circuit-json` format Copperhead exports. Not read in depth. |
| `julian-tischler/spice_agent` | A harness to verify LLM-made circuits through ngspice. 0 stars. | **none** | The nearest in spirit, but tiny. With no licence, all rights are reserved, so nothing may be copied. Not read in depth. |

Three patterns recur: code-first design languages (atopile, tscircuit, fang), MCP servers that let an agent drive EDA or SPICE tools, and browser workbenches. None is positioned as an independent scorer of how good a design's checks are.

## 11. Decisions made, and why

| # | Decision | Why |
|---|---|---|
| D1 | Contracts first, and frozen at version 1. | Four parallel builders could work without collisions because the formats were fixed. Changing a required field is a new version and needs an approved change. |
| D2 | No npm dependencies beyond the schema validator. Standard library only (`node:http`, `node:sqlite`). | Fewer supply-chain surfaces, and nothing to build. |
| D3 | `NOT_CHECKED` and `ERROR` are never a pass and never a kill. | The project's whole claim is honest reporting. A check that did not run must not look like one that passed. |
| D4 | Baseline gating is structural, not a convention. | A check the original design fails can never kill a mutant. The engine makes this impossible to get wrong by construction. |
| D5 | The score carries a cap on `effective_score`, never on `score`. | The contract recomputes `score` from results, so folding a cap into it would make every capped run inconsistent. |
| D6 | Closed check grammars with no raw solver syntax. | An allowlist over arbitrary text is a losing position. A grammar with no escape hatch is not. |
| D7 | The viewer is served from the same origin as its stream, and served runs get a read-only token. | Opening CORS on a localhost server lets any web page the user visits try to read it. Without a read-only token any local process could append events to a run labelled `real`. |
| D8 | Spans and anchored edits, not reserialising files. | Rewriting a KiCad file churns it and changes its hash for irrelevant reasons, defeating the cache and receipts. |
| D9 | Thermal first as a lumped model, before finite elements. | It is closed-form, instant and checkable by hand, and it uses the currents ngspice already measures. |
| D10 | Stay the verifier. We do not generate designs. | A tool that grades its own homework cannot be trusted. Generation is Copperhead's territory. |
| D11 | Hosted infrastructure waits until after the first gate. | The solvers are native programs, designs are private, and the real infrastructure need is isolated containers, not a web host. |

## 12. Progress against the step lists

Rows are the steps in [STEPS.md](STEPS.md). The plan was written viewer-first; the actual order has drifted (the viewer and run server exist, while the first gate's inputs do not), so read this as a map, not a schedule.

| Step | State |
|---|---|
| S0.1 event schemas, S0.2 manifest | done |
| S0.3 choose and licence-check a real 48 V board | **not done; needs the founder** |
| S0.4 sample project and recorded run | partial: a real run of a demo circuit exists, not a real board |
| S1.1 viewer reducer, one interface for file and live | done |
| S1.2 six panels | partial: three panels (log, design, instrumentation); schematic/PCB, 3D, MuJoCo and timeline are placeholders |
| S1.3 cross-panel selection, S1.4 offline export | done |
| S1.5 reviewer pass | partial |
| S2.0 environment spike | done |
| S2.1 contract freeze | partial: events and receipts done, no job schema |
| S2.2 run server | done (IPv6 unverified) |
| S2.3 job queue | done |
| S2.4 debounce, cancel, stale marking | partial: cancel only |
| S2.5 container runner and cache | partial: cache done, no containers |
| S2.6 `kicad-cli` worker | partial: reports parsed, no live ERC/DRC |
| S2.7 ngspice worker | done |
| S2.8 mutation runner v1 | done on netlists |
| S2.9 end-to-end and hardening | partial |
| S3.* relay, preview pane, MCP server, extension, marketplace, client tests | **not started** |
| S4.1 to S4.9 3D, heat, motion in the viewer, interaction | not started; lumped thermal cards (S4.4 in part) are done |

Mutation-engine pieces from STEPS: contracts **done**; `kicad_ingest` **partial** (K2, K3); operators **done** (12); runner **done**; scoring **done**; receipts **not wired** (K6).

## 13. Glossary

- **Baseline**: the original, unmutated design. Run first. A check it fails can kill nothing.
- **Mutant**: the design with one realistic fault injected, such as a removed capacitor or a resistor ten times off.
- **Killed**: the baseline passed a check and the mutant failed it. The checks noticed the fault.
- **Survived**: no check noticed. These are the blind spots, and the useful output.
- **Score**: killed ÷ (killed + survived). `NOT_CHECKED`, `ERROR` and `equivalent` mutants are reported separately and never counted. It always travels with its checkable fraction and a Wilson 95% interval.
- **Cap**: a ceiling on the headline score when a gating condition exists, such as a check the baseline cannot pass. Reported by name, never folded silently into the number.
- **Equivalent mutant**: a change that does not alter behaviour, so no check can catch it.
- **Provenance**: `real`, `recorded` or `synthetic`. Shown on every panel.
- **Villain**: an agent that proposes faults. The Builder designs; the Villain breaks; solvers decide. (The Villain is planned; today the faults come from fixed operators.)
- **Pre-check linter, not a certification**: the fixed disclaimer on every report. This tool does not certify a design.
