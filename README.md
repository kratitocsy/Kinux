# Kinux

**A workspace IDE for physical AI and hardware.**

A workspace where AI agents and engineers design hardware and machines together, and independent physics solvers check the results. The IDE is the long-term form. We start with a viewer and an extension that runs inside editors people already use, and only consider a standalone IDE once real users need one.

> **Status: planning. There is no code in this repository yet.** Everything below describes what we intend to build and the order we intend to build it in. Nothing here has been proven.

The full plan is in [docs/PLAN.md](docs/PLAN.md): architecture, physics checks, the Villain loop, graph learning, the panels, the staged build, the proof test and its gates, and the risks.

## The problem

AI models can now draft schematics, board layouts, enclosures and firmware from short prompts. Models are statistical, though: they can't measure a real board, and they can't show that a design is safe. Published benchmarks still show frequent mistakes in AI-made circuits and layouts. As generating hardware gets cheaper, checking it becomes the bottleneck.

## The idea

- **Agents propose, solvers decide.** A Builder agent (Claude, Codex, Cursor or any other model) changes the design. Deterministic tools such as ngspice, `kicad-cli`, MuJoCo and later OpenFOAM, OpenEMS and structural FEA give the verdicts: pass, fail, or **not checked**. A model never judges pass or fail.
- **Villain agents break things on purpose.** Realistic faults are injected into the design (a removed bypass capacitor, a swapped pin, a heavier load, a weaker motor), and we check whether the tests notice. Faults the tests miss show where the checks are blind. The share caught is a trust score for the design and its tests.
- **The hypothesis:** engineers who review the surviving faults instead of the whole design review faster. This is untested, and testing it with real hardware engineers is the first milestone.
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
| 0 | Shared event and artifact formats, a sample 48V BLDC motor-driver project, one honestly labelled recorded run | not started |
| 1 | Static viewer with all panels, fed by the recorded run | not started |
| 2 | Run server, job queue, real ngspice and `kicad-cli` workers, first mutation runner | not started |
| 3 | Relay, MCP server, VS Code-family extension, tests against Claude Code, Codex and Cursor | not started |
| 4 | 3D board and enclosure, heat overlay, MuJoCo playback, select and highlight | not started |
| later | Fluid, electromagnetic and structural analysis, hand edits, AI-generated faults, 3D-printer export, a multi-model IDE | not started |

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
