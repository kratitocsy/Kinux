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
                found[key] = [label, 1, hing, slide, mass, ext, mass / total, n_axes, lat, up, ground]
        for c in kids[b]:
            walk(c)

    walk(1)
    return list(found.values())


rows = []
for n in sys.argv[1:]:
    try:
        for p in parts_of(n):
            rows.append([n.replace("_mj_description", ""), p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10]])
    except Exception as e:
        print("could not load", n, "-", type(e).__name__, str(e)[:80])

X = np.array([[r[3], r[4], r[7], r[5], np.log(max(r[6], 1e-3)), r[8], r[9], r[10], 3 * r[11]] for r in rows], float)
X = (X - X.mean(0)) / (X.std(0) + 1e-9)
print(f"{'robot':10}{'part':22}{'x':>2} {'hng':>3} {'sld':>3} {'kg':>6} {'ext m':>6} {'share':>6} {'ax':>2} {'gnd':>3}   closest on other robots")
for i, r in enumerate(rows):
    dist = np.linalg.norm(X - X[i], axis=1)
    out = []
    for j in np.argsort(dist):
        if rows[j][0] != r[0]:
            out.append(f"{rows[j][0]}:{rows[j][1]}({dist[j]:.2f})")
        if len(out) == 2:
            break
    print(f"{r[0]:10}{str(r[1])[:21]:22}{r[2]:>2} {r[3]:>3} {r[4]:>3} {r[5]:6.2f} {r[6]:6.2f} {r[7]:6.2f} {r[8]:>2} {int(r[11]):>3}   {', '.join(out)}")
