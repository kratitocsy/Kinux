# Kinux

**A workspace IDE for physical AI and hardware.**

First audience: robotics and physical-AI engineers who design their own actuators, boards and enclosures with coding agents, then small hardware startups.

A workspace where AI agents and engineers design hardware and machines together, and independent physics solvers check the results. The IDE is the long-term form. We start with a viewer and an extension that runs inside editors people already use, and only consider a standalone IDE once real users need one.

> **Status: early, and the core loop runs.** A mutation-testing engine, real ngspice, thermal, motion (MuJoCo) and finite-element (CalculiX) workers, a live run server and a browser viewer all exist, with 312 tests against the real tools. What has **not** happened: it has never run on a real KiCad board, there is no MCP server or editor extension yet, and the idea has not been tested with hardware engineers. Everything beyond the engine below is still intent.

**First measured result**, on one hand-written circuit: a weak check suite scores 12.1% and a thorough one 72.7%, and the 95% intervals do not overlap. That is the central claim, shown once, on a small circuit. It is not yet shown on real hardware.

## Where to look

| If you want | Read |
|---|---|
| What exists today, what was measured, known issues | [docs/STATUS.md](docs/STATUS.md) |
| What to build next, and what is blocked | [docs/ROADMAP.md](docs/ROADMAP.md) |
| How to set up and contribute | [CONTRIBUTING.md](CONTRIBUTING.md) |
| The full plan and the reasoning | [docs/PLAN.md](docs/PLAN.md) |
| What we learned from reading neighbouring projects | [docs/LEARNINGS.md](docs/LEARNINGS.md) |

The plan covers architecture, physics checks, the Villain loop, graph learning, the panels, the staged build, the proof test and its gates, and the risks. It was written before the work started; where it disagrees with STATUS or ROADMAP, those two are right.

## Try it

You need Node 22 and ngspice (setup in [CONTRIBUTING.md](CONTRIBUTING.md)):

```bash
npm ci && npm test
node engine/cli.mjs verify examples/phase-leg-support/phase-leg-support.cir \
  --checks examples/phase-leg-support/checks-thorough.md --serve 7777
```

It prints a link; open it to watch the mutation run fill in the panels live.

## The problem

AI models can now draft schematics, board layouts, enclosures and firmware from short prompts. Models are statistical, though: they can't measure a real board, and they can't show that a design is safe. Published benchmarks still show frequent mistakes in AI-made circuits and layouts. As generating hardware gets cheaper, checking it becomes the bottleneck.

## The idea

- **Agents propose, solvers decide.** A Builder agent (Claude, Codex, Cursor or any other model) changes the design. Deterministic tools such as ngspice, `kicad-cli`, MuJoCo and later OpenFOAM, OpenEMS and structural FEA give the verdicts: pass, fail, or **not checked**. A model never judges pass or fail.
- **Villain agents break things on purpose.** Realistic faults are injected into the design (a removed bypass capacitor, a swapped pin, a heavier load, a weaker motor), and we check whether the tests notice. Faults the tests miss show where the checks are blind. The share caught is a trust score for the design and its tests.
- **The hypothesis:** engineers who review the surviving faults instead of the whole design review faster. This is untested, and testing it with real hardware engineers is the first milestone.
- **Machines, part by part.** Each part (board, motor, gearbox, housing) is verified on its own through its interfaces, then parts are fitted into a subsystem and finally a whole machine. The first whole-machine target is a single joint actuator. A full robot is the long-term goal.
- **Live viewer.** Results stream in as the checks finish, in panels: 2D schematic and PCB, waveforms, mutation table and score, 3D board and enclosure with a heat overlay, motion playback, and a timeline of what each agent did. The viewer is meant to open in a browser and in a panel beside the agent in VS Code-based editors. Agents drive it through MCP tools.
- **Background checks.** Fast checks run on every edit and slow ones on pull requests. Each result is tied to the design version it checked and is marked stale if the design changes.
- **Memory (later).** Each fault and fix is recorded so future runs get relevant warnings. Local to the project by default, with opt-in sharing.

## Principles

- Every panel labels its data as **recorded**, **synthetic** or **real**.
- **Not checked** is never counted as a pass or a catch.
- Evidence reports carry hashes of the inputs and tool versions, so a run can be reproduced.
- This is a pre-check linter. It does not certify a design or replace engineering sign-off, especially for safety-critical, medical or mains-voltage work.

## Plan

| Stage | What | Status |
|---|---|---|
| 0 | Shared event and artifact formats, a sample 48V BLDC motor-driver project, one honestly labelled recorded run | formats and tests done; a demo circuit stands in for the board, which is not yet chosen |
| 1 | Static viewer with all panels, fed by the recorded run | partly done: 3 of 6 panels, live and offline export work |
| 2 | Run server, job queue, real ngspice and `kicad-cli` workers, first mutation runner | mostly done; ERC/DRC cannot run on the KiCad 7 available here |
| 3 | Relay, MCP server, VS Code-family extension, tests against Claude Code, Codex and Cursor | not started |
| 4 | 3D board and enclosure, heat overlay, MuJoCo playback, select and highlight | not started; per-part thermal numbers exist and the MuJoCo and CalculiX workers are built, but not shown in the viewer |
| later | Fluid, electromagnetic and structural analysis, hand edits, AI-generated faults, 3D-printer export, a multi-model IDE | not started |

The next step is the one the first gate needs: running on real KiCad boards. [docs/ROADMAP.md](docs/ROADMAP.md) has the order and what is blocked.

In parallel with these stages, a proof test: about 10 public KiCad boards with blind-seeded bugs, and 6 to 8 hardware engineers reviewing with and without the report. If it doesn't show a clear benefit, we stop or change direction.

## Open questions

- Does the mutation score actually save review time? Unknown until the proof test.
- Can the viewer sit beside the agent in Claude Code, Codex and Cursor? Each needs testing, and support varies by editor.
- Which parts are already covered by existing open-source tools (KiCad MCP servers, SPICE wrappers, CI reviewers) and which are new? A first scan says design-rule checks and SPICE wrappers are commodity, and a verdict-and-evidence layer is not.
- Who would pay, and for what? No data yet.

## Related

- [kratitocsy/Robolix](https://github.com/kratitocsy/Robolix): research on sharing robot data across different kinds of robots. It began in this repository and now lives there.

## License

Not decided yet.
