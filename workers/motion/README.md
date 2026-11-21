# Motion worker (MuJoCo)

The first piece behind the "Robotics sandbox / kinematic rig" panel, and the motion half of the joint actuator demo (`docs/PLAN.md` section 6). It follows `docs/STEPS.md` S4.5: **recorded playback first.** The cloud runs MuJoCo and records the joint state at a fixed rate, the browser does the joint math from the recording, and live physics (WASM) comes later.

| File | What it does |
|---|---|
| `sim.py` | The only code that touches MuJoCo. One JSON request on stdin, one JSON reply on stdout. Checks the model's file paths, runs it, records it |
| `run.mjs` | Finds the interpreter, starts `sim.py` with `execFile` and an argument array (no shell), applies the timeout, stores artifacts by hash |
| `analysis.mjs` | Pure measurements over a trajectory: period from zero crossings, angle range, settling time, peak torque |
| `assertions.mjs` | The closed check language |
| `verify.mjs` | Records at timestep h and h/2, runs the checks, applies the convergence rule, emits contract events |
| `load-export.mjs` | The joint load export (`kinux.joint_load/1`) for a structural worker |
| `fixtures/` | The hand-check models. Their comments give every number the hand calculations use |
| `requirements.txt` | `mujoco==4.0.1` |

## Interpreter

The worker uses `KINUX_PYTHON` if it is set. If that interpreter fails, it does not fall back to another one, because you asked for that one. If `KINUX_PYTHON` is not set, it uses `<repo>/.venv/bin/python`. To set up the venv:

```sh
python3 -m venv .venv && .venv/bin/pip install -r workers/motion/requirements.txt
```

The child runs as `python -I sim.py`. It has a minimal environment and a scratch temp directory as cwd. A timeout (default 60 s) SIGKILLs it. If no interpreter can import mujoco, every check is `NOT_CHECKED` with `reason_code: tool_missing`, and in `tests/motion.test.mjs` the MuJoCo tests are reported as `# SKIP <reason>`, not as passing.

## The trajectory artifact (`kinux.mj_trajectory/1`)

A run steps the model for a fixed `duration` and records a sample every `1/record_hz` seconds. The record interval must be a whole number of timesteps. Each sample holds:

- `t`
- `qpos` and `qvel` (full vectors, addressed per joint by `joints[i].qpos_adr` and `dof_adr`)
- `actuator_force` (the actuator side, before the gear)
- `qfrc_actuator` (the joint side, gear x force)

The state and the forces in a sample come from the same instant: `mj_forward` runs at that state, and the constraint warmstart is restored afterwards, so the recording rate cannot change the trajectory. `peak_qfrc_actuator` is taken over every integration step, not only over the samples. The artifact also carries:

- the model files with their hashes
- the MuJoCo version
- the timestep and integrator
- the joint table: name, type, body, parent body, axis, anchor
- the actuator table and the controls

The artifact is stored as canonical JSON (sorted keys, shortest round-trip floats) at `artifacts/<sha256 hex>`, the same layout as `server/run/store.mjs`, and announced with a `test.artifact` event of kind `mj_trajectory`.

**Reproducibility: byte-identical on the same machine, value-reproducible across machines.** On the same MuJoCo build and platform, two runs of the same request produce identical bytes and the same hash. The test checks this. MuJoCo is deterministic for a fixed build, and the artifact has no wall-clock fields. A different CPU, compiler or SIMD path can change the last bits of floating-point results, so the hash is not promised across machines, only the values within tolerance.

Controls are a closed list of steps: `{actuator, value, t_on, initial}`. Before `t_on` the control is `initial` (default 0), from `t_on` on it is `value`. A constant input is a step at `t_on = 0`. Initial hinge or slide positions and velocities go in `qpos0` and `qvel0`.

## Checks

```
peak_torque(<joint>)                      < x | > x | between a and b    N*m (or Nm)
angle(<joint>)                            < x | > x | between a and b    rad (or deg)
settling_time(<joint>, <target>, <band>)  < x                            s (or ms); target and band in rad
```

- **`peak_torque`** is the largest |joint-side actuator torque| over every integration step.
- **`angle`** covers every recorded sample. `<` bounds the maximum, `>` bounds the minimum, and `between` bounds both, inclusive.
- **`settling_time`** is the earliest recorded time after which every sample stays within the band. If the joint never settles, the check FAILs. If the joint enters the band only at the last sample, the check is NOT_CHECKED, because the record is too short to show it stays there.

Only hinge joints are supported. The grammar has no escape hatch. If a check cannot be evaluated, it is `NOT_CHECKED` with `out_of_scope`. That covers a line that is not in the grammar, a wrong unit, an unknown joint, a non-hinge joint, or a peak torque on a joint with no actuator.

**The convergence rule.** `verifyMotion` records at h and at h/2 and reports the h/2 result. A check gets a verdict only if both of these hold:

- the verdict is the same at h and at h/2
- the measured value moved by no more than max(abs_tol, 1% of the value)

abs_tol is 1e-6 in SI units, or one record interval for settling time. Otherwise the check is `NOT_CHECKED` with `sim_nonconverge`. A run that MuJoCo flags as unstable (bad qpos, qvel or qacc), or that goes non-finite, is also `sim_nonconverge`. Other reason codes:

| Cause | Verdict and reason_code |
|---|---|
| Refused or uncompilable model, bad request | `NOT_CHECKED` `out_of_scope` |
| Timeout | `ERROR` `timeout` |
| No JSON reply from the child | `ERROR` `tool_error` |

Every result is wrapped by `toTestResultEvent`, which validates it with `validateEvent` from `contracts/check-run.mjs` and throws on a shape the contract rejects.

## Joint load export (`kinux.joint_load/1`)

`exportJointLoad(trajectory, joint)` turns a motor-driven hinge into a load a structural (FEA) worker can apply. This is the one-way motion to structure chain. Nothing here calls an FEA worker. This shape is the contract:

```json
{
  "format": "kinux.joint_load/1",
  "joint": "shoulder",
  "actuators": [{ "name": "servo", "gear": 1 }],
  "body": "arm",
  "parent_body": "housing",
  "axis_local": [0, -1, 0],
  "anchor_local": [0, 0, 0],
  "sign": "positive torque turns the child body about +axis by the right-hand rule; the parent body (housing) receives the equal and opposite reaction",
  "units": { "t": "s", "torque": "N*m" },
  "t": [0, 0.005, "..."],
  "torque": [0, 0.98, "..."],
  "peak": { "abs": 62.14, "signed": 62.14, "t": 0.1 },
  "source": { "trajectory_sha256": "sha256:...", "model_sha256": "sha256:...", "mujoco_version": "4.0.1", "timestep": 0.001, "integrator": "implicitfast", "record_hz": 200 }
}
```

- **`torque`** is the joint-side actuator torque about the joint axis at each sample.
- **`peak`** covers every integration step, so `peak.abs` is at least max |torque|.
- **The axis and anchor** are in the child body's frame.
- **A consumer** applies `-torque` about the axis to the parent (housing) at the anchor. For a static check it can use `peak`; for a fatigue or transient check it can use the series.

`checkJointLoad` validates the shape. The load is stored as a `test.artifact` of kind `other`.

## What is verified

Each item below is in `tests/motion.test.mjs`, against real MuJoCo 4.0.1.

- **Physical pendulum, small-angle period.** m = 1 kg, d = 0.5 m, I_cm = 1/12 kg m², so I_pivot = 1/3 kg m². This is a physical pendulum, chosen over a simple pendulum because MuJoCo bodies have real inertia. The analytic period is T = 2π√(I/(m·g·d)) = 1.637947 s. Released at 0.01 rad, the finite-amplitude correction is +6.25e-6 relative. The period is measured from upward zero crossings, each located on the cubic Hermite interpolant from qpos and qvel, averaged over 9 cycles.
  - Tolerance: 2e-5 relative to the small-angle formula, and 1e-6 relative to the amplitude-corrected value.
- **Timestep convergence.** The period is measured with semi-implicit Euler at h = 8, 4, 2, 1 and 0.5 ms. Each halving cuts the change by about 4, which is second order, as the theory for the integrator predicts (relative error -(ωh)²/24). The last halving moves the period by under 1 µs. Richardson extrapolation lands within 1e-8 of the analytic value.
- **Torque-driven joint, τ = I·α.** I = 0.01 + 2·0.2² = 0.09 kg m², τ = gear 5 × ctrl 0.9 = 4.5 N m, so α = 50 rad/s², with gravity off.
  - α from the velocity record matches to 1e-12 relative.
  - The joint torque matches to 1e-12.
  - The angle carries exactly the known Euler error αhT/2, and converges at first order.
- **Holding torque.** Once the servo settles, the exported joint torque equals m·g·d·cos θ to 1e-6 relative.
- **Checks on a real trajectory.** One passes, one fails, refusals are NOT_CHECKED, and a timestep-sensitive result is NOT_CHECKED `sim_nonconverge`.
- **Reproducibility.** Two runs give byte-identical artifacts.
- **Containment.** See below.
- **Timeout.** A run killed by the timeout is ERROR `timeout`.
- **Missing tool.** A missing interpreter, or one without mujoco, gives NOT_CHECKED `tool_missing`.
- **Contract shape.** Every event validates, and a full run built from them passes `checkRun`.

### Containment

A design-supplied MJCF may only read files inside its own directory. MuJoCo will open whatever path it is given, including `../` and absolute paths. An assets dict or VFS does not stop it: a name missing from the dict falls back to the filesystem. This was checked on 4.0.1. So `sim.py` walks the main file and every `<include>` before MuJoCo sees them. Every attribute named `file*` or `*dir` on any element is treated as a path. That covers `<include file>`, mesh, texture (including `fileright` and the other cube faces), hfield, skin, model, flexcomp and the compiler's `assetdir`, `meshdir` and `texturedir`. A path is refused unless all of these hold:

- it is relative
- it has no `..` segment, no backslash and no NUL
- its real path, with symlinks resolved, is inside the model directory

Asset paths are checked joined to every compiler directory. Two more kinds of input are refused outright:

- `DOCTYPE` and `ENTITY` declarations
- `<extension>` and `<plugin>` elements

The include nesting depth, include count and XML size are capped. The test covers `..`, absolute paths, a symlink that points outside, a nested include that escapes, mesh, meshdir, texture, an XML entity and a plugin. It also has a positive control: an include in a subdirectory loads and its file is hashed.

## What this does not model

- **No contact validation.** The hand checks have no contacts. Contact forces, friction cones and soft-contact parameters are not compared with anything.
- **No motor electrical model.** An actuator is an ideal torque source or an ideal position servo with a force limit. There is no winding resistance, back-EMF, current limit, driver bandwidth or supply sag, and no link yet to the ngspice driver board.
- **No gearbox compliance, backlash or friction.** The gear is an ideal ratio. Joint `damping` is a viscous term, not a validated friction model. Efficiency losses are not modelled.
- **Recorded playback only.** There is no live physics, interaction or WASM. A change to the design means a new recording.
- **The torque about the axis only.** The joint load export does not include the radial and axial bearing forces or the bending moments that the housing also carries. A structural check that needs them cannot get them from this shape yet.
- **A two-level convergence check can be fooled.** If both h and h/2 give the same wrong answer, for example a peak torque pinned at a force limit because both steps are far too coarse, the check passes the convergence gate. Model timesteps still need engineering judgement. The gate catches a result that moves; it cannot catch one that is consistently wrong.
- **Only hinge joints in checks and exports.** Slide, ball and free joints are recorded but not checked.
- **Rigid bodies.** There are no flexible links, so no structural compliance feeds back into the motion. The chain runs one way.
- **Not a certification.** Like every Kinux check, this is a pre-check linter.
