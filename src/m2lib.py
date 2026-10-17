import sys, importlib
import numpy as np
import mujoco


def parts_of(name):
    mod = importlib.import_module("robot_descriptions." + name)
    m = mujoco.MjModel.from_xml_path(mod.MJCF_PATH)
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    kids = {i: [] for i in range(m.nbody)}
    for i in range(1, m.nbody):
        kids[int(m.body_parentid[i])].append(i)
    total = float(m.body_mass.sum())
    found = {}
    allz = d.geom_xpos[:, 2]
    zmin, zmax = float(allz.min()), float(allz.max())
    height = max(zmax - zmin, 1e-3)
    root = d.xpos[1].copy()
    for i in range(1, m.nbody):
        if int(m.body_jntnum[i]) and int(m.jnt_type[int(m.body_jntadr[i])]) == 0:
            root = d.xpos[i].copy()
            break
    scale = max(float(np.ptp(d.geom_xpos, axis=0).max()), 1e-3)

    def walk(b):
        chain = [b]
        while len(kids[b]) == 1:
            b = kids[b][0]
            chain.append(b)
        hing = slide = free = 0
        for x in chain:
            adr, n = int(m.body_jntadr[x]), int(m.body_jntnum[x])
            for j in range(adr, adr + n):
                t = int(m.jnt_type[j])
                hing += t == 3
                slide += t == 2
                free += t == 0
        if (hing + slide) > 0 and free == 0:
            mass = float(sum(m.body_mass[x] for x in chain))
            start = d.xpos[chain[0]]
            pts = [d.geom_xpos[g] for g in range(m.ngeom) if int(m.geom_bodyid[g]) in chain]
            ext = max(float(np.linalg.norm(p - start)) for p in pts) if pts else 0.0
            axes = []
            for x in chain:
                adr, n = int(m.body_jntadr[x]), int(m.body_jntnum[x])
                for j in range(adr, adr + n):
                    if int(m.jnt_type[j]) == 3:
                        a = d.xaxis[0] * 0
                        a = d.xmat[x].reshape(3, 3) @ m.jnt_axis[j]
                        axes.append(tuple(np.round(np.abs(a), 1)))
            n_axes = len(set(axes))
            rel = (start - root) / scale
            lat = abs(float(rel[1]))
            up = float(rel[2])
            low = min(float(p[2]) for p in pts) if pts else zmax
            ground = 1.0 if (low - zmin) < 0.03 * height + 0.02 else 0.0
            label = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_BODY, chain[0])
            key = (hing, slide, round(mass, 2), round(ext, 2))
            if key in found:
                found[key][1] += 1
            else:
                found[key] = [label, 1, hing, slide, mass, ext, mass / total, n_axes, lat, up, ground, list(chain)]
        for c in kids[b]:
            walk(c)

    walk(1)
    return list(found.values())


