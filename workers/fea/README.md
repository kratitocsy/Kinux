# FEA worker (CalculiX + Gmsh)

Phase B's finite element slices (docs/PLAN.md section 9): one small, validated slice per kind. Each runs the real **CalculiX `ccx` 2.21** solver on meshes made by the real **Gmsh 4.12.1**, and is checked against a hand calculation in `tests/fea.test.mjs`. Nothing is mocked.

| File | What it does |
|---|---|
| `exec.mjs` | Runs `ccx` and `gmsh` with `execFile`, an argument array, `shell: false`, its own process group killed on timeout, a minimal environment, single-threaded |
| `geo.mjs` | Parametric box geometry, and the default-deny sanitizer for design-supplied `.geo` text |
| `mesh.mjs` | Runs Gmsh, parses its `.inp` export, keeps only volume elements, turns physical surfaces into node sets and face triangles |
| `deck.mjs` | Writes CalculiX decks from the parsed mesh: nodes, elements, sets, material, consistent face loads |
| `inp-sanitize.mjs` | Default-deny sanitizer for design-supplied CalculiX decks, including `*INCLUDE` containment |
| `ccx.mjs` | Runs a deck as job `job` in a fresh temp directory and parses `job.dat` |
| `materials.mjs` | Unit conventions, a nominal steel, and the material check (`no_material_data`) |
| `study.mjs` | The convergence rule, verdicts, and contract `test.result` events |
| `slices.mjs` | The four slices, plus their standard checks and tolerances (`SLICE_CHECKS`) |

Units: mm, N, MPa, tonne/mm³, s, K, mW (conductivity in mW/(mm K), the same number as W/(m K)).

## What is verified

All slices use quadratic tetrahedra (C3D10 / DC3D10) on boxes, solved at 3 mesh sizes.

| Slice | Model | Quantity | Hand calculation | Tolerance vs hand calc | Convergence tolerance |
|---|---|---|---|---|---|
| Static stress | Steel cantilever 200 x 10 x 10 mm, root face clamped, 100 N spread as a uniform shear traction over the tip face (consistent nodal loads) | Tip deflection: mean −u_z of the tip-face nodes | δ = FL³/(3EI) = 1.52381 mm | 1% | 0.5% |
| | | Bending stress at mid-span, outer fibre | σ = Mc/I = 60.000 MPa | 2% | 1% |
| Thermal conduction | Rod 100 x 10 x 10 mm, 100 °C at x=0, 0 °C at x=L, other faces insulated, k = 50 | Heat flow through x=0 (sum of RFL reactions) | Q = kAΔT/L = 5000 mW | 0.1% | 0.1% |
| | | Largest nodal departure from the linear profile | 0 K | ≤ 1e-3 K | 1e-3 K absolute |
| Thermal stress | Bar 100 x 10 x 10 mm, u_x = 0 on both end faces, free sideways, heated uniformly by 100 K | Mean σ_xx over all integration points | σ = −EαΔT = −252 MPa | 0.1% | 0.1% |
| Modal | The static cantilever, ρ = 7.85e-9 t/mm³ | Lowest natural frequency | f₁ = (1.875²/2π)·√(EI/(ρAL⁴)) = 208.879 Hz | 1% | 0.5% |

**Where the cantilever stress is read.** At a clamped root the 3D stress departs from beam theory: Poisson contraction is suppressed there and stress concentrates at the edges (Saint-Venant). So the stress is **not** read at the root. It is read at mid-span, x = L/2, which is 10 beam depths from the root and from the loaded tip. CalculiX prints σ_xx at the integration points with their coordinates (`*EL PRINT S, COORD`). The worker fits σ_xx = a + bx + cz + dxz by least squares to every integration point in the band 0.3L to 0.7L, and evaluates the fit at x = L/2 on the top and bottom faces. Deflection is the primary check. The stress check is secondary.

**Expected small departures.** Beam theory leaves out shear deflection. Timoshenko shear adds FL/(κGA) ≈ 0.003 mm (+0.19%). The fully clamped root adds a slight stiffening. The FEA deflection converges from below to about 0.2% under Euler-Bernoulli, well inside 1%.

**The conduction and thermal-stress slices are easy for the solver.** A linear temperature field and a uniform stress are represented exactly by these elements at any mesh size. These two slices therefore check units, boundary conditions, material input, load application and output parsing. They do not test discretisation error. The cantilever and modal slices do.

## The convergence rule

From `study.mjs`, applied to every quantity:

1. At least **3** mesh levels, each finer than the last. Fewer gives `NOT_CHECKED` / `mesh_not_converged`. A single mesh can never PASS.
2. The relative change between the two finest meshes must be at most the quantity's convergence tolerance. A quantity whose exact value is 0 uses an absolute tolerance instead.
3. That last change must be no larger than the change before it, unless it is already below a tenth of the tolerance. The sequence has to be settling, not wandering.
4. If the rule fails, the verdict is `NOT_CHECKED` / `mesh_not_converged`. It is never PASS, and never FAIL either, because an unconverged number says nothing about the design. No `measured` value is reported.
5. If the rule holds, the finest-mesh value is the measurement. It is compared with the reference (`relTol`) or with a design limit (`max` / `min`), which gives PASS or FAIL.

The tests demonstrate the rule. Linear tetrahedra (C3D4) at 20, 15 and 10 mm give tip deflections of about 0.40, 0.56 and 0.69 mm against the true 1.52 mm. That is shear locking: believable and badly wrong. The rule catches it because the value is still changing about 25% per step.

## Reason codes

| Situation | Verdict / reason_code |
|---|---|
| Gmsh error, no volume elements, degenerate geometry, `.geo` rejected by the sanitizer | `NOT_CHECKED` / `mesh_failed` |
| Convergence rule not met | `NOT_CHECKED` / `mesh_not_converged` |
| Required property missing or non-physical (checked before anything runs) | `NOT_CHECKED` / `no_material_data` |
| Contact keywords in a design deck | `NOT_CHECKED` / `unsupported_contact` |
| Solver divergence, singular system | `NOT_CHECKED` / `sim_nonconverge` |
| Design deck rejected by the sanitizer | `NOT_CHECKED` / `netlist_unsupported` |
| Binary missing / timeout / other solver failure, unreadable output, or ccx ignored a card of a generated deck | `ERROR` / `tool_missing`, `timeout`, `tool_error` |

`provenance: real` is only attached to results built from numbers CalculiX actually printed in `job.dat`. A `NOT_CHECKED` result carries no measured number.

Note: `workers/ngspice/verdict.mjs` maps `mesh_failed` and `mesh_not_converged` to `ERROR`. This worker follows the plan ("If the mesh fails or that check fails, the verdict is NOT_CHECKED") and maps them to `NOT_CHECKED`. Both are allowed by the contract, but the two mappings should be unified.

## Reproducibility

Gmsh runs with `-nt 1`, CalculiX with `OMP_NUM_THREADS=1` and `CCX_NPROC_*=1`, `TZ=UTC`, `LC_ALL=C`. Results come only from `job.dat`, which holds no timestamp. (`job.frd` holds a date and time, so it is not used.) The tests check that three solves of the same mesh give the same deck hash and a byte-identical `job.dat`.

## Input safety

Both input languages can reach outside their job. Both behaviours are proven in the tests against the raw binaries, the way the ngspice spike proved `.control` shell escape.

**CalculiX `.inp`.** CalculiX strips all blanks and upper-cases keyword lines, so `* incl ude , input = ../x.inp` is the same card as `*INCLUDE,INPUT=../x.inp`. What a 2.21 deck can reach, from the binary's keyword table and imported symbols:
- `*INCLUDE,INPUT=` reads any path, absolute or `../`. Error messages echo card images, so included content can leak into logs.
- `*SUBMODEL,INPUT=` reads another results file.
- `*VIEWFACTOR,READ/WRITE` reads and writes view-factor files.
- `*SUBSTRUCTURE MATRIX OUTPUT,FILENAME=` writes a file at a chosen path.
- `*RESTART` reads and writes restart files. ccx links `system()` and builds `rm -f …` and `mv temporaryrestartfile …` command lines from the job name. The job name is always the fixed string `job`, so no design text reaches a shell.
- `*USER MATERIAL/ELEMENT/SECTION` call compiled-in user routines. This binary has no `dlopen`.

The sanitizer is default-deny:
- The keyword must be on an allowlist, compared exactly after ccx's own normalisation.
- Parameter names must be on an allowlist. `INPUT`, `FILE*`, `USER`, `READ` and `WRITE` are refused.
- Parameter values must be plain tokens.
- Lines over 132 characters are refused.
- A keyword line ending in `,` has its next line checked as parameters too.
- Contact keywords are refused as `unsupported_contact`.

`*INCLUDE` is resolved by the sanitizer itself. The target must be a bare file name that the design supplied in the `files` map. Its text is sanitised recursively (depth limit 4, cycles refused) and inlined. The deck CalculiX receives contains no `*INCLUDE`, and it runs alone in an empty temp directory. Decks built by `deck.mjs` from typed numbers skip the sanitizer (`generated: true`). Any card that ccx ignores with a warning in such a deck is an `ERROR`.

**Gmsh `.geo`.** `SystemCall "…"` runs a shell command. Gmsh 4.12.1 created `pwned.txt` in the test. `.geo` text can also read files (`Include`, `Merge`, `ShapeFromFile`), write files (`Save`, `Print`, `Printf > "file"`), and set options that name executables (`Solver.Executable0` together with `OnelabRun`). The sanitizer is a default-deny lexer:
- Every identifier must be a geometry keyword on an allowlist, or a variable assigned earlier in the file.
- Dotted option names are refused.
- Strings may only be short plain labels.
- Loops, macros and string functions are refused.

The worker's own box geometry passes the same sanitizer.

**Not covered.** There is no container or OS sandbox. As the spike recorded, there is no Docker daemon. The sanitizers, the empty work directory, and the minimal environment are the only barriers.

## What this does not validate

- **Real part geometry.** Only boxes are validated, and a design `.geo` must name its faces like the box does (`xmin`, `xmax`, …). There is no STEP/CAD import, no fillets, holes or thin walls, and no meshing of real enclosures or brackets. Stress concentrations at features are untested. Peak stress at a sharp re-entrant corner does not converge at all, and this rule would correctly refuse it.
- **Real loads and supports.** Only idealised clamps, uniform tractions, fixed temperatures and uniform heating are covered. Bolted joints, bearing contact, preload, gravity, pressure, convection and radiation are not. Wrong loads give believable wrong answers, and convergence cannot detect that.
- **Contact** of any kind. It is refused as `unsupported_contact`.
- **Material behaviour.** Only linear, isotropic, temperature-independent elasticity and conduction are covered. **Anisotropic, layer-dependent 3D-printed material** is not modelled. Printed parts are much weaker across layers than nominal data assumes. Plasticity, creep, hyperelasticity, and real datasheet uncertainty are out of scope.
- **Failure.** There are no fatigue, buckling, fracture, yield or safety-factor rules. A converged stress is a number, not a strength verdict.
- **Coupled problems.** Thermal stress is one-way with a uniform temperature. Conduction results are not fed into the stress model.
- **Dynamics beyond eigenfrequencies.** There is no damping, forced response or transient analysis. The modal slice gives frequencies, not mode participation or response amplitude.
- **Other solvers.** Elmer, Code_Aster, FEniCS, motor magnetics, and cross-checks between solvers are not covered.
- **Convergence is necessary, not sufficient.** A mesh can look converged and still be wrong, for example with the wrong element type, wrong BCs or wrong units. The hand-calculation tests are what pin these slices down. A design run has only the convergence check.
