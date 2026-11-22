# Contributing to Kinux

Thanks for helping. Kinux checks hardware designs by breaking them on purpose and seeing whether the checks notice. It is early, and the most useful thing you can do is pick something real off the list and finish it.

Read these first, in this order:

1. [docs/STATUS.md](docs/STATUS.md): what exists today, what has been measured, and the known issues (K1, K2, ...).
2. [docs/ROADMAP.md](docs/ROADMAP.md): what to build next, with a "done when" for each item (R1, R2, ...).
3. [docs/PLAN.md](docs/PLAN.md): the reasoning behind it all. Long. Skim the sections you need.

## 1. Setup

Tested on Ubuntu 24.04 with Node 22.23. Nothing has been run on macOS or Windows (see K22).

| Tool | Tested version | Needed for |
|---|---|---|
| Node | 22.13 or later (`node:sqlite` needs it) | everything |
| ngspice | 42 | the engine, the ngspice, thermal and demo suites |
| `kicad-cli` (from KiCad) | 7.0.11 | the PCB worker tests |
| CalculiX `ccx` | 2.21 | the FEA tests |
| Gmsh | 4.12.1 | the FEA tests |
| Python 3 and MuJoCo | 3.13 and 4.0.1 | the motion tests |
| Playwright and Chromium | 1.63 | the browser tests (optional) |
| Blender (with `python3-numpy`) | 4.0.2 | `node engine/render.mjs` board renders (optional) |
| KiCad 3D models (`kicad-packages3d`) | 10.0.8 | part bodies in the 3D board view (optional, ~3.3 GB) |

On Ubuntu:

```bash
sudo apt-get install -y ngspice calculix-ccx gmsh
sudo apt-get install -y --no-install-recommends kicad     # large; only the PCB tests need it
python3 -m venv .venv && .venv/bin/pip install -r workers/motion/requirements.txt
npm ci
npm install --no-save playwright && npx playwright install chromium   # optional; --no-save leaves package.json alone
```

Check what your machine can do, then run the tests:

```bash
npm run doctor      # which tools you have, which are hidden from the workers, which suites will run
npm test            # runs every suite whose tools are present, and says which it skipped and why
npm run test:all    # runs every suite regardless; a missing tool fails. CI uses this
```

**If you are missing a tool, `npm test` skips the suites that need it**, by name and with the reason, and runs the rest. The skip is per suite, so a suite's pure unit tests are skipped with it. The motion and browser tests also skip on their own. Running `node --test` directly does not skip, and fails where a tool is missing (K21). When you add a test file, list it in `SUITES` in `scripts/tools.mjs`; a test checks that every suite is listed.

**If your tools are not in `/usr/bin` or `/bin`**, the workers will not find them, because they launch tools with a fixed `PATH` (K22). Point them at the tool with an absolute path:

```bash
export KINUX_NGSPICE_BIN=/opt/homebrew/bin/ngspice
export KINUX_CCX_BIN=/path/to/ccx
export KINUX_GMSH_BIN=/path/to/gmsh
export KINUX_PYTHON=/path/to/python-with-mujoco
```

`kicad-cli` has no override and is found through your normal `PATH`. `npm run doctor` shows a tool installed where the workers will not look as HIDDEN, and prints the variable to set.

## 2. What is where

| Folder | What it is |
|---|---|
| `contracts/` | The shared formats: event, manifest and receipt schemas, and `check-run.mjs`. **Frozen at version 1.** |
| `engine/` | The mutation engine and the `kinux verify` command. |
| `workers/ngspice/` | Runs ngspice safely. The sanitizer and the assertion grammar. |
| `workers/thermal/`, `workers/motion/`, `workers/fea/` | Thermal, MuJoCo and CalculiX workers. |
| `workers/pcb/`, `workers/kicad/` | KiCad board and schematic reading, ERC/DRC report parsing. |
| `server/run/` | The run server: event log, live streaming, replay, tokens. |
| `server/queue/` | The job queue, cache and receipt builder. |
| `viewer/` | The browser UI. Plain HTML, CSS and ES modules. No framework, no build step. |
| `examples/` | A demo circuit with two check suites. |
| `tests/` | One file per component. `tests/helpers/` holds shared test code and is not run on its own. |
| `spikes/`, `docs/` | The environment probe, the plan, status and roadmap. |

`mcp/` holds the MCP server (v0, Builder role). The folders `extension/` and `relay/` are empty placeholders for work that has not started.

## 3. The rules every change follows

These are what make Kinux trustworthy. Most were learned the hard way (STATUS section 7). A change that breaks one will not be merged, however useful it is.

1. **`NOT_CHECKED` and `ERROR` are never a pass and never a kill.** They always carry a `reason_code`. A check that did not run must not look like one that passed. The same goes for tests: if a tool is missing, skip with a printed reason, never pass silently.
2. **Never draw or report what a solver did not produce.** Every event carries a `provenance` (`real`, `recorded`, `synthetic`) and the viewer shows it. Missing views are labelled "not wired", not faked.
3. **Test against the real tool, not a mock.** For a solver, check it against a hand calculation and show the working in a comment, with a stated tolerance. A test should be able to fail: when you can, break the code on purpose and confirm the test notices.
4. **Treat every design file as hostile.** Netlists, CalculiX decks, Gmsh `.geo` files and MuJoCo models all execute commands or read files. Default-deny, contain paths to the design's own directory, and start tools with `execFile` and an argument array, never a shell string. Test with a hostile corpus **and a positive control** that proves the payload really fires on your machine, so the test cannot pass vacuously.
5. **Contracts are frozen.** Do not change a required field in `contracts/`. Optional fields may be added. A change to a required field is a new version and needs an approved pull request.
6. **No new dependencies without discussion.** The standard library comes first (`node:http`, `node:sqlite`). Today the only dependencies are the schema validator (Ajv) and its formats plugin, both development-only.
7. **Checks are written in closed grammars.** No raw solver syntax and no escape hatch.
8. **A score never travels alone.** It carries its checkable fraction, mutant count and confidence interval. A cap is reported by name, never folded silently into the number.
9. **Results must be reproducible.** Do not put timestamps in anything that is hashed. If a tool embeds one (KiCad SVGs, CalculiX `.frd`), read the part that does not.
10. **Stay the verifier.** Kinux does not generate designs. A tool that grades its own work cannot be trusted.
11. **Credit borrowed code.** Copying from another project means checking its licence, keeping the notice in the file header, and adding a row to [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Apache-2.0 requires this, and it also rules out a GPLv2 licence for us.

## 4. Making a change

1. **Say what you are taking.** Open an issue or a draft pull request that names the roadmap item, so two people do not build the same thing.
2. **Keep it small.** One idea per commit. Commit often.
3. **Verify; do not trust.** Run the tests yourself. If an AI tool wrote part of it, rerun its output and read the diff. A claim that something passes is not evidence; the command and its output are.
4. **Write the commit message for someone who was not there.** Say why, give the measured numbers, and be plain about limits. The history is the best guide to the tone we want: look at `git log`.
5. **Update the docs in the same change.** If you finish a roadmap item or find a new problem, update [STATUS.md](docs/STATUS.md) (the component table, test counts, issue list) and [ROADMAP.md](docs/ROADMAP.md).
6. **When you find something wrong, record it.** A limit you discovered and wrote down is worth more than a clean-looking page.

## 5. Adding a worker

A worker takes a design and a check, runs one tool, and returns contract-shaped results. Use `workers/ngspice/` and `workers/thermal/` as models. A checklist:

- Run the tool with `execFile`, an argument array, a timeout that kills the child, a minimal environment and a scratch directory.
- Sanitise or refuse hostile input before the tool sees it, and test that.
- Return `PASS`, `FAIL`, `NOT_CHECKED` or `ERROR`, with a `reason_code` on the last two. Use the reason codes already in `contracts/event.schema.json`.
- Name the model or method on every result, so a reader knows what the number is and is not.
- Check it against a hand calculation, and say in the README what it does **not** validate.
- Skip with a printed reason when the tool is missing.
- Validate every result with `validateEvent` from `contracts/check-run.mjs`.
- Add a README: what is verified, the tolerances, the assumptions, and what it does not model.

## 6. Working in parallel

The plan builds with several people or agents at once. It works because each owns one folder, the contracts are frozen during the work, and nothing merges on someone's word alone: the person merging reruns the tests. If you are working alongside others, stay inside the folder you claimed, and if you need a change in someone else's, ask.

## 7. Tests

- `npm test` runs every suite whose tools are present (section 1), and `npm run test:raw` is plain `node --test tests/*.test.mjs`. One file per component.
- Keep tests fast and deterministic. Give anything that can hang an explicit timeout, and always close servers and child processes.
- A test that drives a browser uses `tests/helpers/browser.mjs`, which skips with a reason when Playwright is missing.
- A screenshot a test takes goes to a temporary directory, never into the repository. Set `KINUX_SCREENSHOT=<path>` to keep one.
- One queue test ("timeouts") has failed once under heavy load (K11). If you see it, rerun before assuming you broke something.

## 8. Security

Several workers pass untrusted files to programs that can run commands, and there is no container isolation yet (K1). Please do not run designs you do not trust on a machine you care about.

If you find a way past a sanitizer, please report it privately to the repository owner rather than in a public issue, and include a reproduction. Fixing it, and adding it to the hostile corpus, is the most valuable contribution there is.

## 9. Licence

The project has no licence yet, and it already contains Apache-2.0 code (see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)). That is a decision for the maintainers (ROADMAP D1). Until it is made, there is no contributor agreement, and you keep the rights to your work.
