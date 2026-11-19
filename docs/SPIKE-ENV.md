# Environment spike (Phase A, step S2.0)

Settles the "Environment status (unverified)" note in [PLAN.md](PLAN.md) section 9.

Measured on 2026-11-19 in the cloud session container: Ubuntu 24.04 (noble), 4 CPUs, 15 GB RAM, 60 GB free disk, Node v22.23.5, Python 3.13.18.

Re-run everything with [`spikes/env/probe.sh`](../spikes/env/probe.sh). It is idempotent and writes only to a temp dir.

## Verdict

**Phase A can proceed in this container for SPICE work. It cannot do KiCad rule checks here.**

| Question from the plan | Answer | Evidence |
|---|---|---|
| Does the Docker daemon run and pull images? | **No.** Client 29.10.0 is installed, but there is no daemon and no `/var/run/docker.sock`. | `docker info` fails to connect |
| Can `apt` find ngspice? | **Yes.** The plan's note was a stale package index, not a missing package. | `ngspice 42+ds-3build1` from `noble/universe` |
| Is ngspice output reproducible across runs? | **Yes, byte-identical.** | 5 runs, one SHA-256 |
| Does ngspice match a known analytic answer? | **Yes, to ~2e-6 relative.** | table below |
| Does the `.control` sanitizer matter? | **Critically. Netlists execute arbitrary shell commands.** | see Security |
| Does `kicad-cli` run headless? | **Yes, with no `DISPLAY`.** | SVG export, 76,919 bytes |
| Can `kicad-cli` do ERC and DRC? | **No. Not at version 7.0.11.** | no `erc`/`drc` subcommands |
| Pinned image digests | **None — there are no containers here.** Pinned apt versions instead. | below |

Pinned versions instead of image digests: `ngspice 42+ds-3build1`, `kicad 7.0.11+dfsg-1build4`, both from `noble/universe`.

## ngspice: usable, fast, reproducible

RC low-pass step response, R = 1 k, C = 1 uF, tau = 1 ms, against `1 - exp(-t/tau)`:

| Point | Analytic | ngspice | Relative error |
|---|---|---|---|
| 1 tau | 0.632120559 | 0.632119400 | 1.8e-6 |
| 3 tau | 0.950212932 | 0.950213600 | 7.0e-7 |
| 5 tau | 0.993262053 | 0.993262300 | 2.5e-7 |

Five consecutive runs produced one SHA-256 over the measured values, so results are safe to cache and to hash into a receipt.

**Timing:** 20 consecutive warm runs of this transient took 0.126 s total, about 6 ms each including process spawn. Cold versus warm is not a meaningful distinction without containers: there is no image to pull. Budget for real boards once a board-sized netlist exists; this figure is a floor, not a forecast.

## Security: netlists are executable code

A netlist is derived from an untrusted user project. `.control` blocks execute shell commands **even in batch mode (`-b`)**. A netlist containing:

```
.control
run
shell echo OWNED > pwned.txt
.endc
```

created the file. This is a remote code execution path straight through the mutation engine, which generates and runs thousands of netlists.

**Consequences, not optional:**

1. The ngspice worker must use an **allowlist** sanitizer and default-deny. Rejecting is correct; silently stripping is not.
2. Block at minimum `shell`, `exec`, `system`, `source`, `load`, `cd`, `rusage`, command substitution and anything hidden after `;`.
3. Never invoke the simulator through a shell string. Use an argument array.
4. Sandboxing was going to be the containers' job. **There are no containers here**, so the sanitizer is currently the only barrier. Treat this container as compromised-if-breached and do not run untrusted third-party boards in it until the solvers are isolated.

## KiCad: exports only

`kicad-cli` 7.0.11 exposes `fp`, `pcb`, `sch`, `sym`, `version`, and under `pcb` and `sch` **only `export`**.

- `pcb export`: drill, dxf, gerber, gerbers, pdf, pos, step, svg
- `sch export`: dxf, hpgl, netlist, pdf, ps, python-bom, svg

**Missing and needed:**

| Need | Where the plan uses it | Arrived in |
|---|---|---|
| `sch erc` / `pcb drc` | Phase A, "`kicad-cli` rule checks" | KiCad 8.0 |
| `pcb export glb` | Stage 4 / S4.2 board 3D | KiCad 8.0 |

Ubuntu noble ships only 7.0.11. The KiCad 9 PPA **is reachable from this container** (`ppa.launchpadcontent.net` and the Launchpad API both answered 200), but adding a third-party apt repository and signing key was refused by this session's sandbox policy. So the upgrade is a permissions decision, not a networking one.

Until KiCad 8+ is available, any ERC/DRC request must return `NOT_CHECKED` with a reason code naming the version found and the version required. It must never look like a pass. `sch export netlist` does exist at 7.0.11, so the netlist path into the mutation engine is not blocked.

## Artifact hashes are not reproducible

`kicad-cli pcb export svg` embeds a wall-clock timestamp (`date 2026/11/19 09:40:43`). Two exports of the same board seconds apart differ at byte 399 and produce different hashes.

This does not affect the job cache, which keys on **inputs** (tool, version, input hashes, arguments) rather than outputs. It does mean content-addressed artifact storage will store a fresh copy of an unchanged drawing every run. Normalise the timestamp out before hashing, or accept the duplication knowingly.

## Open items

- Docker is unavailable, so the isolation story for solvers is unresolved. Options: enable a daemon, run solvers on the founder's machine or a rented server, or accept sanitizer-only isolation for first-party designs.
- KiCad 8+ needs either the PPA (permission), a prepared image, or a different distribution channel.
- `pip` reaches PyPI (MuJoCo 4.0.1 downloaded), so the Phase B physics work is not blocked by the package network.
- Timings on a real 48 V BLDC board are still unknown; S0.3 has to pick that board first.
