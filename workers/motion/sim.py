"""Kinux motion worker: run one MJCF model with MuJoCo and record its trajectory.

Invoked by workers/motion/run.mjs as

    python -I sim.py

with ONE JSON request on stdin, and it writes ONE JSON response on stdout.
Nothing else is read or written. The script never raises to the caller: every
failure becomes {"ok": false, "code": <reason>, "message": ...}.

Requests
--------
{"op": "probe"}
    -> {"ok": true, "mujoco_version": "4.0.1", "python_version": "3.13.x"}

{"op": "run",
 "model": "/abs/path/model.xml",     # the model's own directory is its jail
 "duration": 2.0,                     # s, simulated time
 "record_hz": 1000,                   # samples per second, must divide 1/timestep
 "timestep": 0.001,                   # optional override of <option timestep>
 "integrator": "Euler",               # optional: Euler | RK4 | implicit | implicitfast
 "gravity": [0, 0, -9.81],            # optional override
 "qpos0": {"joint": 0.01},            # optional initial hinge/slide positions
 "qvel0": {"joint": 0.0},             # optional initial hinge/slide velocities
 "controls": [{"actuator": "m", "value": 1.0, "t_on": 0.0, "initial": 0.0}]}
    -> {"ok": true, "trajectory": {...}, "model_files": [...]}

Containment (the reason this file has a preflight at all)
--------------------------------------------------------
MJCF can name other files: <include file>, <mesh file>, <texture file*>,
<hfield file>, <skin file>, <model file>, <flexcomp file>, and the compiler's
assetdir/meshdir/texturedir. MuJoCo opens whatever path it is given, absolute
or relative, and an assets dict does NOT stop it: a name missing from the dict
falls back to the filesystem (checked against mujoco 4.0.1). So before MuJoCo
sees the model, preflight() walks the main file and every include, and refuses
the model unless every file-bearing attribute is a relative path with no '..'
segment whose real path (symlinks resolved) is inside the model's directory.
DOCTYPE/ENTITY declarations and <extension>/<plugin> elements are refused
outright. Any attribute named file*, or *dir, on any element, counts as a path.
"""

import hashlib
import json
import math
import os
import sys
import xml.etree.ElementTree as ET

MAX_STEPS = 5_000_000
MAX_SAMPLES = 200_000
MAX_INCLUDES = 64
MAX_INCLUDE_DEPTH = 8
MAX_XML_BYTES = 4 * 1024 * 1024
INTEGRATORS = {"Euler": 0, "RK4": 1, "implicit": 2, "implicitfast": 3}
REFUSED_ELEMENTS = {"extension", "plugin", "instance"}


def out(obj):
    sys.stdout.write(json.dumps(obj, allow_nan=False, separators=(",", ":")))
    sys.stdout.flush()


def fail(code, message):
    out({"ok": False, "code": code, "message": str(message)[:4000]})
    sys.exit(0)


class Refused(Exception):
    pass


def is_path_attr(name):
    return name.startswith("file") or name.endswith("dir")


def contained(root, rel):
    """Resolve rel against root and require the real path to stay inside root."""
    if not isinstance(rel, str) or rel == "":
        raise Refused("empty file path")
    if "\x00" in rel or "\\" in rel:
        raise Refused(f"file path {rel!r} contains a NUL or a backslash")
    if os.path.isabs(rel) or rel.startswith("~"):
        raise Refused(f"file path {rel!r} is absolute; only paths inside the model directory are allowed")
    if ".." in rel.replace("\\", "/").split("/"):
        raise Refused(f"file path {rel!r} has a '..' segment; only paths inside the model directory are allowed")
    real = os.path.realpath(os.path.join(root, rel))
    if os.path.commonpath([root, real]) != root:
        raise Refused(f"file path {rel!r} resolves outside the model directory (to {real})")
    return real


def read_xml(path):
    with open(path, "rb") as f:
        data = f.read(MAX_XML_BYTES + 1)
    if len(data) > MAX_XML_BYTES:
        raise Refused(f"{os.path.basename(path)} is larger than {MAX_XML_BYTES} bytes")
    text = data.decode("utf-8", errors="replace")
    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        raise Refused(f"{os.path.basename(path)} has a DOCTYPE/ENTITY declaration; these are refused")
    try:
        return data, ET.fromstring(data)
    except ET.ParseError as e:
        raise Refused(f"{os.path.basename(path)} is not well-formed XML: {e}")


def preflight(model_path):
    """Return the list of files the model reads, or raise Refused."""
    root = os.path.realpath(os.path.dirname(os.path.abspath(model_path)))
    main = os.path.realpath(os.path.abspath(model_path))
    if os.path.commonpath([root, main]) != root or not os.path.isfile(main):
        raise Refused("model file not found")

    files = {}      # real path -> bytes (for hashing)
    dirs = [""]     # compiler asset/mesh/texture dirs, each already checked
    assets = []     # relative asset paths, checked against every dir below
    count = [0]

    def walk(path, depth):
        data, tree = read_xml(path)
        files[path] = data
        for el in tree.iter():
            tag = el.tag if isinstance(el.tag, str) else ""
            if tag in REFUSED_ELEMENTS:
                raise Refused(f"<{tag}> is refused: plugins are not allowed in design-supplied models")
            for name, value in el.attrib.items():
                if not is_path_attr(name):
                    continue
                if tag == "include" and name == "file":
                    # MuJoCo resolves every include, nested or not, against the
                    # MAIN model's directory (verified on 4.0.1).
                    real = contained(root, value)
                    count[0] += 1
                    if count[0] > MAX_INCLUDES:
                        raise Refused(f"more than {MAX_INCLUDES} includes")
                    if depth + 1 > MAX_INCLUDE_DEPTH:
                        raise Refused(f"includes nest deeper than {MAX_INCLUDE_DEPTH}")
                    if not os.path.isfile(real):
                        raise Refused(f"included file {value!r} not found")
                    walk(real, depth + 1)
                elif name.endswith("dir"):
                    contained(root, value)
                    dirs.append(value)
                else:
                    contained(root, value)
                    assets.append(value)

    walk(main, 0)
    # An asset path is joined to assetdir/meshdir/texturedir by MuJoCo; check
    # every combination so no prefix can carry it outside.
    for a in assets:
        for d in dirs:
            for d2 in dirs:
                real = contained(root, os.path.join(d, d2, a) if (d or d2) else a)
                if os.path.isfile(real):
                    with open(real, "rb") as f:
                        files[real] = f.read()
    listed = []
    for real, data in sorted(files.items()):
        listed.append({"path": os.path.relpath(real, root), "sha256": "sha256:" + hashlib.sha256(data).hexdigest()})
    return root, main, listed


def finite_list(arr):
    vals = [float(x) for x in arr]
    for v in vals:
        if not math.isfinite(v):
            raise FloatingPointError("non-finite state")
    return vals


def run(req):
    try:
        import mujoco
        import numpy as np  # noqa: F401  (mujoco depends on it)
    except Exception as e:  # pragma: no cover - exercised via tool_missing tests
        fail("tool_missing", f"cannot import mujoco: {e}")

    model_path = req.get("model")
    if not isinstance(model_path, str):
        fail("bad_request", "model must be a path string")
    try:
        root, main, model_files = preflight(model_path)
    except Refused as e:
        fail("model_refused", e)
    except OSError as e:
        fail("model_refused", f"cannot read model: {e}")

    try:
        os.chdir(root)  # any path MuJoCo resolves on its own lands in the jail
        m = mujoco.MjModel.from_xml_path(main)
    except Exception as e:
        fail("model_compile", e)

    if "timestep" in req:
        m.opt.timestep = float(req["timestep"])
    if "integrator" in req:
        if req["integrator"] not in INTEGRATORS:
            fail("bad_request", f"integrator must be one of {sorted(INTEGRATORS)}")
        m.opt.integrator = INTEGRATORS[req["integrator"]]
    if "gravity" in req:
        m.opt.gravity[:] = [float(x) for x in req["gravity"]]

    dt = float(m.opt.timestep)
    duration = float(req.get("duration", 0))
    record_hz = float(req.get("record_hz", 0))
    if not (dt > 0 and duration > 0 and record_hz > 0):
        fail("bad_request", "timestep, duration and record_hz must be positive")
    n_steps = round(duration / dt)
    stride = round(1.0 / (record_hz * dt))
    if abs(n_steps * dt - duration) > 1e-9 * max(1.0, duration):
        fail("bad_request", f"duration {duration} is not a whole number of timesteps {dt}")
    if stride < 1 or abs(stride * dt * record_hz - 1.0) > 1e-9:
        fail("bad_request", f"record interval 1/{record_hz} s is not a whole number of timesteps {dt}")
    if n_steps > MAX_STEPS:
        fail("too_long", f"{n_steps} steps exceeds the limit of {MAX_STEPS}")
    if n_steps // stride + 1 > MAX_SAMPLES:
        fail("too_long", f"{n_steps // stride + 1} samples exceeds the limit of {MAX_SAMPLES}")

    def name(obj, i):
        return mujoco.mj_id2name(m, obj, i) or f"#{i}"

    jtypes = {0: "free", 1: "ball", 2: "slide", 3: "hinge"}
    joints = []
    jindex = {}
    for j in range(m.njnt):
        jn = name(mujoco.mjtObj.mjOBJ_JOINT, j)
        jindex[jn] = j
        joints.append({
            "name": jn,
            "type": jtypes.get(int(m.jnt_type[j]), "unknown"),
            "qpos_adr": int(m.jnt_qposadr[j]),
            "dof_adr": int(m.jnt_dofadr[j]),
            "body": name(mujoco.mjtObj.mjOBJ_BODY, int(m.jnt_bodyid[j])),
            "parent_body": name(mujoco.mjtObj.mjOBJ_BODY, int(m.body_parentid[int(m.jnt_bodyid[j])])),
            "axis_local": [float(x) for x in m.jnt_axis[j]],
            "anchor_local": [float(x) for x in m.jnt_pos[j]],
        })
    actuators = []
    aindex = {}
    for a in range(m.nu):
        an = name(mujoco.mjtObj.mjOBJ_ACTUATOR, a)
        aindex[an] = a
        trn = int(m.actuator_trntype[a])
        target = int(m.actuator_trnid[a][0])
        actuators.append({
            "name": an,
            "joint": name(mujoco.mjtObj.mjOBJ_JOINT, target) if trn == 0 else None,
            "gear": float(m.actuator_gear[a][0]),
        })

    d = mujoco.MjData(m)

    def set_scalar_joint(field, values):
        if not isinstance(values, dict):
            fail("bad_request", f"{field} must be an object of joint -> number")
        for jn, v in values.items():
            if jn not in jindex:
                fail("bad_request", f"{field}: unknown joint {jn!r}")
            j = jindex[jn]
            if jtypes.get(int(m.jnt_type[j])) not in ("hinge", "slide"):
                fail("bad_request", f"{field}: joint {jn!r} is not hinge or slide")
            if field == "qpos0":
                d.qpos[int(m.jnt_qposadr[j])] = float(v)
            else:
                d.qvel[int(m.jnt_dofadr[j])] = float(v)

    set_scalar_joint("qpos0", req.get("qpos0", {}))
    set_scalar_joint("qvel0", req.get("qvel0", {}))

    controls = []
    for c in req.get("controls", []):
        if c.get("actuator") not in aindex:
            fail("bad_request", f"controls: unknown actuator {c.get('actuator')!r}")
        controls.append((aindex[c["actuator"]], float(c.get("value", 0)), float(c.get("t_on", 0)), float(c.get("initial", 0))))

    def apply_controls():
        for a, value, t_on, initial in controls:
            # A tiny epsilon so t_on that lands exactly on a step boundary is on.
            d.ctrl[a] = value if d.time >= t_on - 1e-12 else initial

    t_rec, qpos, qvel, act, qfrc = [], [], [], [], []
    nv = m.nv
    peak = [{"abs": 0.0, "signed": 0.0, "t": 0.0} for _ in range(nv)]

    def note_peaks(t):
        for i in range(nv):
            v = float(d.qfrc_actuator[i])
            if abs(v) > peak[i]["abs"]:
                peak[i] = {"abs": abs(v), "signed": v, "t": t}

    def record():
        # State and forces at the same instant: forward() recomputes forces
        # from (qpos, qvel, ctrl) at d.time without advancing the state.
        # The warmstart is restored so the recording rate cannot change the
        # constraint solver's starting point, and with it the trajectory.
        apply_controls()
        ws = d.qacc_warmstart.copy()
        mujoco.mj_forward(m, d)
        d.qacc_warmstart[:] = ws
        t_rec.append(round(d.time, 12))
        qpos.append(finite_list(d.qpos))
        qvel.append(finite_list(d.qvel))
        act.append(finite_list(d.actuator_force))
        qfrc.append(finite_list(d.qfrc_actuator))
        note_peaks(t_rec[-1])

    bad = [mujoco.mjtWarning.mjWARN_BADQPOS, mujoco.mjtWarning.mjWARN_BADQVEL, mujoco.mjtWarning.mjWARN_BADQACC]
    try:
        record()
        for k in range(1, n_steps + 1):
            t_before = d.time
            apply_controls()
            mujoco.mj_step(m, d)
            # qfrc_actuator after mj_step is the force that acted during this
            # step, so the peak covers every integration step, not just samples.
            note_peaks(round(t_before, 12))
            if any(d.warning[w].number > 0 for w in bad):
                fail("diverged", f"MuJoCo reported an unstable simulation at t={d.time:.6g} s (bad qpos/qvel/qacc)")
            if k % stride == 0:
                d.time = k * dt  # avoid accumulating float drift in the clock
                record()
    except FloatingPointError:
        fail("diverged", f"state became non-finite at t={d.time:.6g} s")

    inv = {v: k for k, v in INTEGRATORS.items()}
    traj = {
        "format": "kinux.mj_trajectory/1",
        "mujoco_version": mujoco.mj_versionString(),
        "model_files": model_files,
        "timestep": dt,
        "integrator": inv.get(int(m.opt.integrator), str(int(m.opt.integrator))),
        "gravity": [float(x) for x in m.opt.gravity],
        "duration": n_steps * dt,
        "record_hz": record_hz,
        "steps": n_steps,
        "joints": joints,
        "actuators": actuators,
        "controls": [{"actuator": actuators[a]["name"], "value": v, "t_on": t, "initial": i} for a, v, t, i in controls],
        "t": t_rec,
        "qpos": qpos,
        "qvel": qvel,
        "actuator_force": act,
        "qfrc_actuator": qfrc,
        "peak_qfrc_actuator": peak,
    }
    out({"ok": True, "trajectory": traj})


def main():
    try:
        req = json.loads(sys.stdin.read(1024 * 1024))
    except Exception as e:
        fail("bad_request", f"request is not JSON: {e}")
    op = req.get("op") if isinstance(req, dict) else None
    if op == "probe":
        try:
            import mujoco
        except Exception as e:
            fail("tool_missing", f"cannot import mujoco: {e}")
        out({"ok": True, "mujoco_version": mujoco.mj_versionString(), "python_version": sys.version.split()[0]})
    elif op == "run":
        run(req)
    else:
        fail("bad_request", f"unknown op {op!r}")


if __name__ == "__main__":
    main()
