# KINUX Phase 0 technical specification

Status: draft for the owner's review, 2026-11-28.

This specification is built from seven research tracks run in parallel: languages, code CAD and AI CAD,
machine representations, simulation engines, synchronisation and AI, the manufacturing compiler, and
strategy. It answers the research questions in `docs/VISION.md` §14 and sets out what Phase 1 builds.
It works together with `docs/DETERMINISM-PLAN.md`.

The research reports' claims carry labels: confirmed, likely or unknown. Vendor claims are unverified.
Where a decision rests on a "likely" or "unknown" finding, this document says so.

---

## 1. Position: what KINUX is, and is not

**Not new, so not the pitch:**
- **Code, GUI and natural language editing one model.** Zoo (KCL, Zookeeper agent) does this for
  mechanical geometry today; Onshape FeatureScript does it structurally.
- **AI that writes, runs and debugs model code.** Zoo, the Onshape FeatureScript MCP server and JITX
  (for PCBs) already do this.
- **Requirement-driven, code-based electronics with simulation in the loop.** JITX and atopile.
- **Mechanical, electronics, simulation and CAM in one tool.** Autodesk Fusion, GUI-first.
- **Mutation testing of requirements.** Research prior art exists:
  - geometric tests for text-to-CAD (CADTests, arXiv 2605.07807);
  - Simulink models (arXiv 2501.07553, 2608.24250).

  Each covers a single domain, but KINUX cannot claim the idea is original.

**The gap no product was found to fill.** All seven tracks agree: none of these five exists as a
combination.
1. One dimensionally typed source spanning mechanical, electrical and control.
2. Deterministic, reproducible builds of geometry and analysis: a lockfile, input hashing and signed receipts.
3. Every verdict carries solver provenance and an "exact / approximate / not checked" label.
4. The adequacy of the requirements is scored by **cross-domain** mutation analysis.
5. Measurements from manufactured parts are fed back as regression tests against predictions.

**Positioning statement.** KINUX is **the build system and test framework for physical machines**:
the trust and evidence layer between human or AI intent and physical manufacture. It is not another
CAD tool. Each piece has precedents. The moat is integrating them coherently and accumulating the
prediction-against-measurement record.

---

## 2. Ontology: the machine model

$$\mathcal{M} = (G,\,P,\,C,\,E,\,I,\,R,\,M_f)\quad\text{verified under}\quad(X,\,U)$$

| Symbol | Meaning | Authority (native format, by reference) |
|---|---|---|
| G | Geometry | OCCT B-rep; STEP AP242 |
| P | Materials, mass properties | KINUX material library (every value sourced) |
| C | Topology: parts, ports, connections, joints, frames | KINUX core graph; SysML v2 interchange |
| E | Energy, electrical, power | KiCad / IPC-2581; SPICE decks |
| I | Information: control, firmware, sensors | FMU / Modelica; source code references |
| R | Requirements | KINUX check grammar; SysML v2 interchange |
| M_f | Manufacturing: process, tolerances, inspection plan | STEP AP242 PMI; QIF MBD and Plan |
| X | Environment and operating conditions (loads, temperature, supply, duty) | KINUX load cases and blocks |
| U | Uncertainty (tolerances, scatter, model error) | Every KINUX quantity |

**Behaviour is derived, never declared:**

$$B=\mathrm{Sim}(G,P,C,E,I;X,U)$$

**The verification relation:**

$$V_r=\mathrm{Check}_r(B)\in\{\text{PASS},\text{FAIL},\text{NOT\_CHECKED}\}$$

**Production feasibility:**

$$\text{Producible}=\mathrm{Feasible}(G,P\mid\text{factory capability})$$

Uncertainty is native: the languages track found no studied language carries uncertainty in its standard semantics.

---

## 3. Universal Machine Representation (UMR)

**Architecture: a core typed graph with discipline payloads by reference** (track 3). A single
monolithic IR would re-implement AP242, IPC-2581 and FMI badly. Pure file federation loses the
cross-discipline checks.

- **The core owns** identity, hierarchy, ports and interfaces, frames, units, parameters, constraints,
  requirements, traceability, provenance and uncertainty.
- **Payloads are content-addressed native artifacts.** Each carries a checkable *semantic summary*:
  mass, bounding box, pin list, FMU variables.

**Conventions:**
- Every quantity is `Quantity{value, unit (SI dimension vector), uncertainty?}`, and uncertainty is
  one of interval, normal σ or tolerance reference.
- Rotations are quaternions, angles are radians internally, and they are converted at export (USD and MJCF use degrees).
- Every entity has a **stable semantic ID**, such as `arm.link1.mount_face`, never a kernel topology
  index. This avoids CAD's topological-naming problem (track 5).

**Entities for the proof of concept** (outline):
```
Machine, Frame, Parameter(source: user|derived|ai), Part(geometry, material, mass_props, frames, ports, mfg, bom_item),
GeomRef(generator script hash | STEP hash, lod meshes, pmi_ref), MassProps(method computed|measured|declared),
Material(sourced), Assembly, Joint(type, frames, axis, limits, damping, friction),
Actuator(kind, drives, gear_ratio, Kt, R, L, rated/peak torque, electrical port, bom_item),
Port(domain mech|elec|signal|data, type, unit), Connection(port_a, port_b; domain+unit checked),
BehaviourRef(FMU|Modelica|code, variable map, sample time), ElectricalRef(KiCad/IPC-2581, pin→port),
Requirement(text, metric expression, applies_to, priority),
Verification(requirement, method analysis|sim|test|inspection, solver{name,version,settings},
             input hashes, result Quantity+uncertainty, status pass|fail|not_checked|stale, receipt),
MfgSpec(process, tolerances → AP242 PMI or general class, finish), BomItem, Drawing,
Provenance(author human|agent|import, tool+version, derived_from, why, signature), Assumption(text, affects, expires_when)
```

**Storage and versioning:**
- **Staleness:** a Verification goes stale the moment any of its input hashes changes.
- **Storage:** the graph is git-friendly text (JSON, canonical form), with binary payloads in a
  content-addressed store.
- **Commits** are immutable; branches and tags are the only mutable pointers, as in the SysML v2 API.

**Import and export, rather than replace:**
- **Export:** URDF, MJCF and SDF (as views), USD with UsdPhysics, glTF, STEP AP242 with PMI, PDF
  drawings, BOM (CSV or an AAS submodel), FMU/SSP, and QIF MBD and Plan.
- **Import:** STEP (bought parts), URDF and MJCF, FMUs, KiCad and IPC-2581.

---

## 4. The language decision

**(b) first, (c) at the edges, (a) deferred.** This is track 1's recommendation, and the strategy and
code CAD tracks agree.

1. **An embedded Python SDK** (`kinux` package) whose only job is to build a typed UMR graph.
   - Python has the largest AI corpus and the CAD libraries (build123d), and iterates fastest.
   - Python errors only appear at runtime. That is covered by a strict **KINUX validation pass** over
     the UMR: static dimension checks, reference checks and constraint checks, with machine-readable
     diagnostics.
2. **Adopt existing languages at the edges:**
   - **Modelica / FMI 3.0** as the backend for coupled behaviour (B, E, I). Measured AI pass rates on
     Modelica are poor, so it is not a source language.
   - **SysML v2 textual** for import and export of requirements and structure (R, C). It was adopted by
     the OMG in 2025 and has an ISQ/SI units library. Its tooling is young.
   - **Avoid** ModelingToolkit's AGPL parts (licence change, July 2026).
3. **The KINUX surface language comes later** (month 12 or later), as a thin front end over a stable
   UMR. A new language starts with no corpus, so AI would generate it worst exactly when it matters.
   The illustrative syntax in VISION.md §2 stays the design target for it.

---

## 5. Engineering kernel: the minimum viable set for the proof of concept

**No new engines are needed** (track 4). Already integrated: ngspice, CalculiX, Gmsh, MuJoCo and
KiCad. Add build123d with OCCT, and python-control. Both are permissive.

| Job | Engine | Exact or approximate | Validity boundary stated to the user |
|---|---|---|---|
| Geometry, STEP | build123d / OCCT (fresh process, serial, normalised STEP) | Exact B-rep | Tolerances come from PMI, not geometry |
| Mass and inertia | OCCT GProp × sourced density | Exact for homogeneous solids | Fasteners, cables and motor internals are lumped or declared |
| Kinematics, reach | Closed form (KINUX), cross-checked in MuJoCo | Exact | Rigid links, no backlash |
| Joint torques | MuJoCo inverse dynamics on a fixed trajectory | Exact to floating point | Rigid bodies; friction as modelled |
| Collision | Exact B-rep clearance (OCCT BRepExtrema); MuJoCo contact for motion | Clearance exact; contact approximate | Contact forces are not valid for impact design |
| Link stress and deflection | Beam hand calculation first, then Gmsh + CalculiX (single thread, SPOOLES, convergence) | Discretised | Linear elastic, small deflection; singular stresses are NOT_CHECKED; no fatigue |
| Motor sizing | Analytic, from the datasheet's Kt and R plus the trajectory's RMS torque | Exact given the model | 25 °C datasheet values; no saturation |
| Motor heat | Lumped RC (as the board-heat and thermal workers already do) | Model | Ambient, convection and duty are stated assumptions; needs testing |
| Control | python-control (linearised), closed loop in MuJoCo | Exact for the linear model | Small signal only |
| Electronics | KiCad + ngspice | Numerical | Device-model validity |
| BOM | UMR roll-up | Exact | Supplier data freshness |

**Excluded from the kernel:**
- **Isaac Sim:** proprietary, needs a GPU, not deterministic. It may be an optional viewer.
- **PyBullet:** stagnant.
- **FEMM:** Windows only.

**Added after the proof of concept:** Drake or Chrono as an independent cross-check solver, Elmer
for motor electromagnetics, and Code_Aster for nonlinear and fatigue analysis.

**Licences:**
- GPL tools (CalculiX, Gmsh's command line, Code_Aster, Xyce) run as separate processes over files. GPL, unlike AGPL, also permits a hosted service.
- In-process libraries stay permissive or LGPL.
- KiCad's CC-BY-SA libraries must not be bundled into KINUX outputs.
- ngspice's licence page returned 403 during research, so its licence must be verified before it is written down.

---

## 6. Synchronisation and the AI contract

1. **Single source of truth:** the versioned UMR graph.
2. **One edit algebra for every author.** The GUI, source and AI all emit the same typed operations:
   `set_param`, `place`, `connect`, `assign_model`, `add_requirement`… This generalises KINUX's design
   session and IDX's proposal → response pattern. The GUI edits declared parameters and structure;
   free-form code is read-only in the GUI.
3. **Discipline views are compiled projections:**
   - the KiCad board outline and placement come from G and C;
   - the netlist from E;
   - simulation decks from G, P, E and I.

   An edit made in a native tool comes back as a proposal and is judged; it is never silently merged.
4. **Incremental re-verification.** Each derived artifact is an action keyed by its inputs' hashes
   (Bazel style), with **early cutoff**. Impact analysis is reachability from the edited nodes
   through typed trace links.
5. **The AI contract:**
   - AI may only emit typed edits that cite a requirement, inside a leased region (the team leases that exist today).
   - Requirements and checks are read-only to designers; changing them is a separate, audited role.
   - The validation pipeline runs in order: schema → units → references → reaches the model → affected
     subgraph re-verified → acceptance (no regression, no worse ERC/DRC/interference, progress) →
     branch → a person merges.
   - Errors are SARIF-like, each with:
     - a stable code;
     - the semantic IDs involved;
     - measured value against limit, with units;
     - the before and after;
     - suggested fixes with an applicability level.
   - Every session replays from its log, byte for byte.
6. **Evaluation of agents:** pass rate, regressions introduced, edits needed, mutation robustness, and
   explicit tests for gaming the checks.

---

## 7. Manufacturing compiler, first scope

**Process:** 6061/7075 aluminium parts for the arm (links, brackets, joint housings), on 3-axis
milling with up to 3 setups.

**Computed deterministically** from the B-rep (feature recognition over its face-adjacency graph) and
a **versioned capability file** (tools, machine envelope, stock, thread catalogue):
- minimum wall and rib thickness;
- inside corner radius against the cutter, and pocket depth against tool diameter;
- tool access and undercuts from the allowed setup directions;
- hole depth against diameter, and standard drill sizes;
- threads: catalogue size, depth against diameter, and material below blind threads;
- the part fits the machine envelope and the stock;
- sharp external edges are covered;
- every dimension is toleranced, explicitly or by a general class;
- the tolerance stack across bore, seat and link length, against the arm's accuracy budget.

**Advisory unless the factory supplies its data:** achievable tolerance and process capability per
feature, tool stock, fixturing, cost and lead time, and finish allowances. Vendor DFM numbers disagree
(Protolabs, Hubs, Xometry, Fictiv), so limits come from the capability file and are never hard-coded.

**Release package** (a hashed manifest):
- STEP AP242 with semantic PMI;
- a PDF drawing derived from that PMI;
- QIF MBD and QIF Plan (characteristics with stable IDs);
- the material and temper, the finish, and the tolerance standard and edition (ASME Y14.5-2018 or ISO 8015 / ISO 2768);
- the BOM;
- the DFM report and waiver list;
- an optional reference CAM file (non-binding);
- an STL for preview;
- the signed receipt.

**From prediction to measurement:**
- Each dimension's stable ID is written into both the AP242 PMI and the QIF characteristics.
- QIF Results from the factory join back to the design automatically: nominal, predicted and measured are stored against the revision.
- PDF-only reports go through a balloon-mapping step, with a person confirming it.

**Manufacturer adapter** (also exposed over MCP):
- The interface is `capabilities → dfm → quote → submit → status → results`.
- A person approves before any submission or payment.
- **No major on-demand manufacturer was found with a public ordering API or an official MCP server.**
  JLCPCB has a partner API, and SendCutSend publishes an ordering guide written for agents.
- The first adapter is manual: export, then upload.

**Antropi:**
- **Public facts:** YC Fall 2026. Their software turns a design into machining programs, simulates them,
  and has **an engineer approve before cutting**, which is the natural hand-off point for KINUX. Parts ship with an inspection report.
- **Not public:** any API.
- **To validate directly with them:** which formats they accept (AP242 PMI? QIF?), whether they could
  emit QIF Results, whether they would publish a capability file, and how their approval step works.

---

## 8. Open versus proprietary

This follows what worked for Zoo, Modelica, OpenUSD and MuJoCo. The final call rests on **D1, the licence**.

- **Open** (Apache-2.0; specifications under CC-BY-4.0):
  - the language spec;
  - the UMR schema and `contracts/`;
  - the SDK, the reference compiler and the unit checker;
  - the check grammars and the *public* mutation operators;
  - the solver adapters and the MCP tool definitions;
  - the release-package and QIF mapping spec, offered as an open standard to factories;
  - examples and the validation suite.
- **Proprietary:**
  - the hosted verification service (the reference machine);
  - **hidden** mutation operators, which guard against gaming;
  - signed receipts, which are only worth something if the signer is trusted;
  - factory integrations;
  - **the prediction-against-measurement dataset**;
  - on-premises deployments.
- **Trademark:** the "KINUX-verified" mark stays under KINUX's control.

---

## 9. Smallest working product: about 12 weeks

**"A two-link arm that verifies itself."** This is the PoC in VISION.md §13.

- **Input:** a Python SDK file `arm.py` (bodies, materials, two revolute joints, two catalogue motors,
  requirements with units), or a natural-language prompt to the KINUX agent.
- **Compile:** units, references and constraints are checked, and `arm.umr.json` is written.
- **Verify:**
  - STEP;
  - reach and self-collision over a sweep;
  - joint torque at a 2 kg payload;
  - link stress and deflection;
  - motor heat;
  - BOM;
  - a mutation score for the requirement suite.

  Each verdict carries provenance and its exact, approximate or not-checked label.
- **Output:** STEP, UMR, BOM, the report, the signed receipt, and the Studio views (Part, Assembly, Robot rig).
- **Demo script:**
  1. Prompt the agent.
  2. The agent writes `arm.py`.
  3. The compiler rejects a units error and the agent fixes it.
  4. The motor-torque check fails and the agent picks a larger motor.
  5. Everything passes.
  6. The mutation score shows a weak suite missed a too-thin forearm; a stress check is added and the score rises.
  7. The rerun hashes are byte-identical.
- **Success criteria:**
  - 5 of 5 identical hashes.
  - Every solver figure within 1% of its hand calculation (FL³/3EI, τ = m·g·r).
  - The 95% intervals of the weak and thorough suites don't overlap.
  - The agent reaches all-pass in 10 or fewer iterations in at least 4 of 5 trials.
  - Zero silent passes.
- **Then (Phase 7):** machine one link (Antropi), measure its deflection and dimensions, and record the
  gap between measurement and prediction in the UMR.

---

## 10. Phase plan, revised from VISION.md §12

The order is around one vertical slice, the arm. No phase is dropped.

| Step | Contents | VISION phase |
|---|---|---|
| S1 | Determinism foundation: context probe, receipt v2 + signing, guard bands (DETERMINISM-PLAN W0–W2; W4 done) | 2, 6 |
| S2 | UMR schema v0 + Python SDK + validation pass (units, references, constraints, SARIF-like errors) | 1, 3 (embedded) |
| S3 | Geometry worker (build123d) + mass properties + material library | 2 |
| S4 | Arm kernel: kinematics, MuJoCo dynamics, CalculiX links, motor sizing and heat, BOM | 5 |
| S5 | Verification for the UMR: requirements engine, provenance, staleness, cross-domain mutation | 6 |
| S6 | Agent contract on the UMR edit algebra; Studio Part, Assembly and Robot tabs; the `kinux` terminal IDE | 4, 10 |
| S7 | Manufacturing compiler v0 (DFM, AP242 PMI, QIF, package) + manual Antropi adapter; machine and measure one link | 7, 9 |
| Later | KINUX surface language; SysML v2 / Modelica interchange; PCB in the UMR; firmware; desktop app | 3, 8 |

---

## 11. Top risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Scope:** 10 phases | Freeze the SWP subset; one machine category; no new physics |
| 2 | **Unvalidated demand** | Show the SWP to about 5 robotics teams and look for 2 letters of intent; validate Antropi in person |
| 3 | **Incumbents:** Zoo, Onshape, JITX or atopile extend their reach | Interoperate rather than compete on geometry: import STEP, URDF, MJCF, KiCad and build123d, so nobody has to switch to get value |
| 4 | **False confidence** | Validity envelopes, convergence bands, NOT_CHECKED by default, the measurement loop, and the wording "scored, never certified" |
| 5 | **Licences and dependencies** | Out-of-process GPL tools, pinned versions, and a legal review (D1) before outside contributors arrive |
| 6 | **Lossy round-trips** between UMR, SysML v2 and Modelica | Test them in S2 on the arm |

## 12. Decisions for the owner

1. **Approve the language order:** Python SDK first, surface language later.
2. **Approve the open/proprietary split** (§8), and decide **D1, the licence**.
3. **New dependencies:** build123d and python-control (both permissive); later Modelica/FMI tooling.
4. **Customer validation:** who are the first 5 robotics teams to show the SWP to?
5. **Antropi:** whether and when to contact them; this document lists the questions to ask.
