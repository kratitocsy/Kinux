# Attaching Kinux to Claude Code

Kinux runs as two MCP servers that you add to your own coding agent. You type in your agent as
usual; Kinux runs the solvers, decides every verdict, and gives you a local page where you can
watch it.

| Server | Role | What your agent can do with it |
|---|---|---|
| `kinux` | Builder | run the design's checks against injected faults (`kinux_start_run`, `kinux_wait_for_run`), read the score and the surviving faults (`kinux_get_findings`), open the viewer (`kinux_open_viewer`), render the board (`kinux_render`) |
| `kinux-review` | Reviewer | review the design by proposals that Kinux's verifiers accept or reject (`kinux_review_bundle`, `kinux_read_document`, `kinux_propose`, `kinux_get_review`) |

The role is fixed when the server starts, never by a tool argument. Neither server can edit a
file, take a verdict or skip the baseline.

## Requirements

Node 22.13 or later and ngspice. For KiCad designs, `kicad-cli` 8 or later (10 is tested). Optional:
KiCad's 3D models (`kicad-packages3d`) for part bodies in the 3D view, Blender and `python3-numpy`
for renders. Check with `npm run doctor`.

## Add the servers

From the project that holds your design (paths are examples):

```bash
claude mcp add kinux -- node /path/to/Kinux/mcp/server.mjs --design hardware/board.kicad_sch --checks checks.md --sidecar kinux.sidecar.json --model-dir models --ngspice-compat psa --jobs 4 --cache .kinux/cache.sqlite --runs-dir .kinux/runs
```

```bash
claude mcp add kinux-review -- node /path/to/Kinux/mcp/server.mjs --role reviewer --design hardware/board.kicad_sch --sidecar kinux.sidecar.json --model-dir models --ngspice-compat psa --doc docs/SPEC.md --doc docs/BOM.md
```

- `--checks` is your check suite in Kinux's closed grammar (see `engine/fixtures/checks-thorough.md`).
- `--sidecar` supplies what KiCad does not export: sources, and which SPICE model file stands for
  which part (schema at the top of `engine/kicad-adapter.mjs`). A part without a model is reported
  NOT_CHECKED, never passed.
- `--ngspice-compat psa` is needed for vendor PSpice models such as TI's (STATUS K28).
- `--doc` (reviewer) names each document a reviewer may quote: the spec, the BOM, datasheets.

## The review subagents

Copy the four domain reviewers into your project, so your agent can run them in parallel:

```bash
mkdir -p .claude/agents && cp /path/to/Kinux/mcp/agents/kinux-review-*.md .claude/agents/
```

They can only use the `kinux-review` tools: no file reading, no shell, no web. Then ask your agent,
for example: "Run the four kinux-review subagents in parallel, then show me kinux_get_review."

## What you see

`kinux_open_viewer` returns a URL on 127.0.0.1. The page shows the run's log, its score, the KiCad
schematic, PCB and 3D board with every part coloured by what the run found (click a part to select
it everywhere), and the original design's waveforms. Nothing is uploaded; the page reads the run's
own files, behind a random token in the URL.

`kinux_render` writes a Blender image of the board, tinted the same way, with a JSON file beside
it that names the run it came from. It is a picture for a report, not a verdict.

## Rules your agent is told

A FAIL is information to report, not an obstacle to route around. NOT_CHECKED and ERROR are never
a pass. A score always travels with its checkable fraction, mutant count and interval. Every
number comes from a solver. This is a pre-check linter, not a certification.
