# Determinism plan: hardware parts and robotics

Status: plan, not yet built. Written 2026-11-28 from five research reports (CAD kernel,
Gmsh + CalculiX with experiments on this machine, MuJoCo, cross-machine floating point,
and an audit of Kinux itself). Every rule below cites the finding it rests on.

The goal: **the same input gives the same verdict, on every machine, every time**, for
machined parts (Antropi's metal parts first) and robot assemblies, with proof that anyone can
check without trusting an AI.

---

## 1. What "deterministic" means, formally

Notation:

- **I**: the input. That is the part scripts, materials, load cases, check suite, robot model and controls.
- **E**: the execution context. That is the image digest, CPU architecture and ISA level, thread and BLAS
  environment, floating-point control state, and tool and library versions.
- **R(I,E)**: the raw output (bytes). **Q(I,E)**: the quantities of interest (numbers the checks
  read). **V(I,E)**: the verdicts.

| Tier | Promise | Scope |
|---|---|---|
| **A, bitwise** | R(I,E1) = R(I,E2), byte for byte | Same image digest, same CPU arch and ISA level, same pinned environment |
| **B, verdict-stable** | V(I,E1) = V(I,E2), and every q in Q agrees within a declared tolerance: \|q1 − q2\| ≤ max(atol, rtol·\|q\|) | Any two *supported* contexts, including x86-64 vs arm64 |
| **C, unstable** | No PASS or FAIL. The verdict is `NOT_CHECKED` with reason `numerically_unstable` | Any quantity inside its guard band, or a Tier B disagreement seen in calibration |

**Verdict rule** (every check, every domain): with limit L, measured q, margin m = (L − q)/|L|
(sign set so that m > 0 means "on the good side"), and guard band g = k · rtol_q (k = 10):

- PASS only if m > g.
- FAIL only if m < −g.
- Otherwise NOT_CHECKED, `numerically_unstable`.

Discrete outputs must match exactly for Tier B, or the check is unstable. Discrete outputs are things like
topology counts, element counts, collision sets, convergence flags and solver choice.

Why tiers: a container pins the software, not the hardware. Different CPUs (x86 with and
without AVX-512, arm64) give different bits even with the same binaries. MuJoCo's own docs
guarantee exact reproducibility only "within a single version, on the same architecture",
and an x86 AVX-512 vs non-AVX-512 trajectory difference was closed upstream as "working as
intended". Tier A is the strongest promise that is physically true. Tier B is the promise a
person actually needs: the same answer.

---

## 2. Where nondeterminism comes from, and what removes it

| Source | Where it bites | Removed by | Residual |
|---|---|---|---|
| Thread count, summation order | Gmsh meshing (6 different meshes in 6 runs at 4 threads), CalculiX SPOOLES (values differ at about 1e-6 at 4 threads), OCCT parallel booleans and meshing, MuJoCo thread pool | Single thread everywhere, enforced by flags *and* environment | None within Tier A |
| Pseudo-random seeds | Gmsh `Mesh.RandomSeed`, MuJoCo PGS ordering, our own Villain noise | Fixed seeds, recorded in the receipt | None |
| Timestamps and metadata | STEP `FILE_NAME` time, author and OCCT version; CalculiX `.frd` `1UDATE/1UTIME`; KiCad SVG/GLB (already handled) | Fixed values at write time, plus header normalisation | None |
| Heap or pointer order | OCCT maps keyed by shape pointer (documented for offset and shell) | One part per fresh process | Other OCCT algorithms not yet proven; tested by double runs |
| BLAS/LAPACK kernel dispatch | CalculiX through system BLAS alternatives, OpenBLAS CPU-specific kernels | Pinned image; record the resolved library paths; `OPENBLAS_CORETYPE` if OpenBLAS is present | Cross-arch: Tier B |
| FMA contraction, libm, SIMD width | Every solver, across CPUs | Pinned image (same binaries) | Cross-arch: Tier B |
| Tool versions | Every tool: Gmsh 5.0 changes meshing, MuJoCo changes numerics in nearly every minor release (3.8 to 4.0.1), OCCT 7.x to 8.0 | Exact versions pinned by hash; a version change means re-baselining | None, by policy |
| Solver selection | CalculiX picks the first solver it was built with | `SOLVER=SPOOLES` explicitly; refuse if the log says otherwise | None |
| Non-converged solves | MuJoCo Newton line search, CalculiX increments, Gmsh optimisers | Detect and return NOT_CHECKED | None |
| Chaotic dynamics | Contact-rich robot motion | Compare quantities of interest, not trajectories; perturbation test | Real; handled by Tier C |

---

## 3. The execution context

1. **One container image**, referenced by digest, holds every solver and library at exact versions.
   - Python packages are pinned by wheel sha256: build123d, cadquery-ocp-novtk, mujoco and numpy.
   - System packages are pinned: gmsh, calculix-ccx, ngspice, kicad, and the BLAS/LAPACK/ARPACK/SPOOLES builds.
   - CI today uses a floating `ubuntu-24.04` with unpinned `apt-get`. That changes.
2. **Supported contexts** are declared. To start: `linux/amd64 x86-64-v3` (the reference), `linux/amd64 x86-64-v4`
   (AVX-512) and `linux/arm64`. Each is a separate Tier A context.
3. **At start-up, Kinux probes and records the context.** It checks:
   - the image digest;
   - `uname -m`;
   - the CPU flags and ISA level;
   - the resolved shared libraries (`ldd` of each solver);
   - all thread and BLAS variables;
   - that floating-point rounding is round-to-nearest and flush-to-zero is off.

   If the image or ISA is not a supported context, it refuses to issue verdicts.
4. **Every solver runs under `env -i` plus a fixed allow-list.** The allow-list is:
   - `PATH=/usr/bin:/bin`, `LC_ALL=C`, `TZ=UTC`;
   - `HOME` and `TMPDIR` set to the work directory;
   - `OMP_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1`, `MKL_NUM_THREADS=1`;
   - `CCX_NPROC_EQUATION_SOLVER=1`, `CCX_NPROC_STIFFNESS=1`, `CCX_NPROC_RESULTS=1`, `NUMBER_OF_CPUS=1`.

   The FEA worker already does most of this. KiCad and ngspice are brought into line.

---

## 4. Rules per tool

### 4.1 CAD geometry: build123d on OpenCascade (new)

- **Parts as code.** A part is a build123d script with typed parameters. The script's hash is the part's identity input.
- **One part per fresh Python process** (`python -I`, minimal env). This avoids OCCT's heap-order effects and
  `Interface_Static`, which is global to the process.
- **No parallel algorithms.**
  - Kinux's geometry wrapper calls booleans with `SetRunParallel(False)`. build123d's `_bool_op` turns it on.
  - The mesher runs with `isInParallel=False`.
  - A CI test proves that serial gives the same result on every run.
- **STEP export:**
  - Always pass a fixed `timestamp` and a label.
  - Set `write.step.schema` (AP242), `write.precision.mode` and `write.step.product.name` explicitly.
  - Then normalise the HEADER: fixed author, organization, authorization, preprocessor and originating system.
- **Identity.** A part's identity has two hashes:
  - **Tier A:** the sha256 of the normalised STEP.
  - **Tier B:** a geometric fingerprint, which is:
    - topology counts (solids, shells, faces, edges, vertices);
    - the multiset of surface types;
    - `BRepCheck` validity;
    - volume, area and centre of mass (rtol 1e-6);
    - the bounding box from exact geometry (1e-6 of the diagonal);
    - the principal moments.
- **Mass properties** come from the exact geometry with a fixed `Eps`, never from a triangulation.
- **Meshes for display** (GLB, STL) are derived artifacts. They are never part of identity.

### 4.2 Gmsh (meshing for CalculiX)

- Today Kinux passes `-nt 1`. It will also pass `Mesh.MaxNumThreads1D/2D/3D 1`.
  - An experiment showed that pinning only some of these three did not make meshes repeatable. Pinning all three did.
- Set these explicitly, never from user input:
  - `Mesh.RandomSeed 1`
  - `Mesh.Algorithm 6`
  - `Mesh.Algorithm3D 1`
  - element order and size
  - the optimiser flags
- Use a fixed output name, because line 2 of the `.inp` records the filename.
- Hash the mesh. Record its element and node counts as discrete outputs.

### 4.3 CalculiX (structure, heat, modes)

- Solve with `*STATIC, SOLVER=SPOOLES`. Refuse if the solver ccx reports in its log is not SPOOLES.
  Iterative solvers are allowed only under a looser, declared tolerance tier, because they differ by up to 1e-2 between thread counts.
- Hash the deck and the `.dat` file.
  - Remove the `1UDATE`/`1UTIME` lines from `.frd` before hashing, or don't hash `.frd` at all.
- Record ccx, SPOOLES, ARPACK, BLAS and LAPACK by their resolved paths and versions.
- Keep the mesh-convergence rule (already in Kinux): at least three meshes, settling, or NOT_CHECKED.
- Tier B tolerances, from the experiments, to be confirmed by cross-architecture calibration:

| Quantity | Tolerance |
|---|---|
| Displacement, stress | rtol 1e-5, plus atol 1e-9·max\|value\| |
| Eigenfrequencies | rtol 1e-6 |
| Mode shapes | MAC ≥ 0.999 after sign normalisation; degenerate pairs are compared as subspaces |
| Temperatures | rtol 1e-5 |

### 4.4 MuJoCo (robot motion)

- **Pin** the exact wheel by sha256, the Python version, numpy, and the platform tag.
- **Hash** every `opt` field and every enable/disable flag: timestep, integrator, solver, iterations, tolerance,
  ls_iterations, noslip, cone, jacobian, warmstart, island, nativeccd, multiccd and sleep.
- **Disable:** never `mju_threadpool`, never MJX or Warp for verdicts, and no plugins (already refused).
- **Initial state:** start from `mj_resetData` with explicit qpos0, qvel0 and a zero warmstart. Restore the warmstart after any
  extra `mj_forward` (already done).
- **Hash the compiled model** (`mj_saveModel` bytes), not only the XML. Convex hulls and mesh inertia change
  between versions.
- **Model from geometry:** a robot model is generated from the assembly. Mass, centre of mass and inertia come from 4.1, never typed in.
- **Non-convergence** (iterations at the maximum, line search exhausted) means NOT_CHECKED.
- **Across machines:** compare the quantities of interest (peak torque, settling time, overshoot, collision set and
  first-contact time, RMS tracking error). Never compare raw trajectories after contact.
- **Stability test, on every verdict:**
  - the result must hold at timestep h and at h/2 (already in Kinux);
  - it must hold under a 1e-9 perturbation of qpos0.

  If the verdict flips, it is unstable.
- **Villain faults with noise** (sensor noise, friction scatter) use a recorded integer seed, never system entropy.

### 4.5 ngspice and KiCad (existing)

These already follow this design. KiCad's environment gains `LC_ALL=C` and `TZ=UTC`, and the receipt gains its context.

---

## 5. Hashing and receipts

Each result carries three hashes:

1. **Exact:** canonical JSON, sorted keys, SI units, doubles written as `%.17g`. This is Tier A.
2. **Quantised:** each quantity rounded to N significant digits from its tolerance. This is a fast Tier B check
   only. Rounding has boundary cases, so the tolerance comparison is the real Tier B check.
3. **Discrete:** topology, counts, convergence flags, collision sets.

**Receipt v2.** This is a schema bump: the v1 schema is closed. It contains:

- **Inputs:** the hashes of part scripts, materials (with their sources), load cases, the suite and the robot model.
- **Context:** the image digest, arch and ISA level, the probed library paths and versions, the environment
  allow-list values, and the floating-point control state.
- **Tool versions:** build123d, OCP/OCCT, gmsh, ccx, mujoco, ngspice, kicad-cli.
- **Settings:** every pinned option (Gmsh options, solver, MuJoCo `opt`), and seeds.
- **Results:** the output hashes (exact, quantised, discrete), and every quantity with its margin, guard band and verdict.
- **The tier achieved.**
- **A signature.** Ed25519 through `node:crypto`, over the canonical receipt. It excludes `created`, so the id never
  depends on the clock. Sigstore and in-toto come later.

Two commands sit on top of the receipt:

- **`kinux verify-receipt`** works offline and needs no model. It checks the signature, the hashes of the files supplied, and
  that every verdict is PASS with its margin outside the guard band.
- **The order guard hook** calls it before any manufacturing order (Antropi's form or their MCP).

Content-addressed caching for CalculiX and MuJoCo results is keyed on input hash, context, versions and settings.
Only reproducible results are cached, as the ngspice cache already does.

---

## 6. Where agents fit

- **Agents propose; the deterministic layer decides.** Specialist subagents (geometry, structure, motion,
  manufacturability) and the Villain propose in closed grammars:
  - part parameter edits;
  - new checks;
  - stimulus and load cases;
  - faults.

  No agent touches the execution context, the solvers' settings or a verdict.
- **The model may change; the layer stays still.** Swapping Fable, Opus or Sonnet changes which proposals are
  made, never how a proposal is judged. This is enforced by the existing "no model in the verdict path" test, extended to
  the new workers.
- **Every agent decision is replayable without a model.** The design session, the team, the Villain and the review logs replay
  from their logs. Replay must reproduce every verdict at Tier A.

---

## 7. Proof: the tests that keep it true

| Test | Proves | When |
|---|---|---|
| Double run per tool (CAD, Gmsh, ccx, MuJoCo, ngspice): byte-identical outputs | Tier A on one host | Every change |
| Unpinned runs must *differ* (4 threads, parallel OCCT) | The pins carry the load, and the guards are not decorative | Every change |
| Fresh-process vs warm-process CAD build | Heap-order independence | Every change |
| Golden corpus with analytic answers: cantilever, plate with hole (stress concentration about 3), bar conduction, beam modes, pendulum period, two-link arm static torque | Solvers are *right*, not only repeatable | Every change |
| Cross-architecture CI on x86-64-v3, x86-64-v4 and arm64 | Tier B, and the tolerance calibration | Every release |
| Guard-band tests: a quantity at the limit ± ε | No PASS or FAIL inside the band | Every change |
| Perturbation tests (MuJoCo qpos0 ± 1e-9, timestep h vs h/2) | Unstable verdicts are caught | Every change |
| Receipt round trip: sign, tamper, verify | Receipts can be trusted | Every change |
| Replay of design, team and Villain logs | Agent outcomes reproduce without a model | Every change |

**Release rule:** any Tier A mismatch, or any Tier B verdict disagreement, blocks a release.

---

## 8. Work plan

Each workstream is owned by one subagent working in its own git worktree, under an orchestrator that reviews and
integrates. Workstreams that share files are serialised.

| # | Workstream | Deliverable | Acceptance | Est. |
|---|---|---|---|---|
| W0 | Execution context | Pinned image (digest), context probe, refusal of unsupported contexts, `env -i` allow-list for every solver | Probe recorded in every run; KiCad/ngspice env aligned | 3 d |
| W1 | Receipts v2 + signing | Schema v2, Ed25519 signing, `kinux verify-receipt`, migration from v1 | Tamper tests fail closed; verification needs no network | 3 d |
| W2 | Verdict stability | Guard bands per quantity class, `numerically_unstable`, discrete-output rules | Guard-band tests pass across every existing worker | 2 d |
| W3 | CAD worker | Fresh-process build123d runner, serial booleans and mesher, STEP normalisation, fingerprint, mass properties | Double-run identical; unpinned parallel shown to differ (or proven equal); fingerprint stable | 5 d |
| W4 | FEA hardening | Gmsh thread and seed and algorithm pins, SPOOLES enforcement, `.frd` stripping, library recording, ccx and MuJoCo cache | The experiment's 4-thread failure reproduced as a test and fixed by the pins | 3 d |
| W5 | MuJoCo hardening | `opt` hashing, compiled-model hash, non-convergence detection, perturbation test, quantity-of-interest comparison | Double-run identical; perturbation flags a chaotic case | 3 d |
| W6 | Golden corpus | The analytic cases in §7 across CAD → mesh → ccx and MuJoCo | Every case within its tolerance of the analytic answer | 3 d |
| W7 | Cross-arch CI | x86-64-v3, x86-64-v4 and arm64 runners, Tier B comparison, tolerance calibration report | The first calibration report published; any disagreement goes to Tier C | 3 d + runner setup |
| W8 | First real part | Actuator bracket: script, machinability and structure checks, Villain, release package, order guard | A signed package verifies offline; ordered from Antropi; inspection compared with the prediction | 5 d |

Order:

1. W0, W1 and W2 come first; the rest depend on them.
2. W3, W4 and W5 then run in parallel.
3. W6 and W7 follow.
4. W8 closes the loop.

That is about 4–5 weeks of work, shortened by running W3–W5 in parallel.

---

## 8b. Progress

- **W4 (FEA hardening): done** (Gmsh and CalculiX).
  - Every mesh pins `General.NumThreads`, `Mesh.MaxNumThreads1D/2D/3D`, `Mesh.RandomSeed`, `Mesh.Algorithm` and `Mesh.Algorithm3D`. It records them and the mesh hash.
  - Every generated deck names `SOLVER=SPOOLES`.
  - ccx's own log is checked, and a run that used more than one CPU, or another solver, is refused (`checkCcxLog`).
  - The resolved SPOOLES, ARPACK, LAPACK and BLAS libraries are recorded in `tool_versions.calculix_libs`.
  - Tests:
    - the same input meshes to the same bytes;
    - **unpinned 4-thread Gmsh does not reproduce its own mesh**, so the pins are shown to carry load;
    - a real solve reports one CPU and SPOOLES.

## 9. Open risks

- **Untested OCCT algorithms.** Other OCCT algorithms may depend on heap order (only offset and shell is documented). Mitigation: fresh processes and double-run tests on every operation we use.
- **Parallel OCCT, unproven.** Whether serial and parallel OCCT give identical results is undocumented. Mitigation: we never run parallel.
- **Near-tolerance topology.** Cross-architecture last-bit drift can flip a topology decision that sits near a tolerance. Mitigation: discrete outputs must match, else the check is unstable.
- **Chaotic robot cases.** Contact-rich cases may exceed Tier B tolerances in quantities of interest too. Mitigation: perturbation tests send them to Tier C. They are reported, not hidden.
- **Upgrades re-baseline.** Upgrading any pinned tool re-baselines every stored result. Upgrades are deliberate, versioned events.
- **Silent BLAS switches.** If someone installs OpenBLAS or MKL into the image, the system BLAS alternatives switch silently. Mitigation: the context probe records the resolved paths, and a change refuses verdicts.

## 10. Decisions needed

1. **A container registry for the pinned image.** Which registry, and who can publish to it?
2. **CI runners.** Which runners for x86-64-v4 and arm64? GitHub-hosted arm64 runners are an option.
3. **Signing-key custody.** A local key for now; Sigstore later.
4. **D1, the licence.** Needed before any receipt or package leaves this repository.
