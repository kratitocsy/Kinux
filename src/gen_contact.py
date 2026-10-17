import sys, importlib, warnings, copy, pickle
import numpy as np, mujoco
from scipy.stats import spearmanr
from sklearn.neural_network import MLPRegressor
from joblib import Parallel, delayed
from m2lib import parts_of
warnings.filterwarnings("ignore")
MAXD = 7
FAM = {"go2":"uq","go1":"uq","a1":"uq","anymal_c":"an","anymal_b":"an","panda":"fr","fr3":"fr","ur5e":"ur","ur10e":"ur",
       "shadow_hand":"sh","leap_hand":"lp","allegro_hand":"al"}
SEEDS = 3; POOL = 28; NTS = [20]

def model_of(n): return mujoco.MjModel.from_xml_path(importlib.import_module("robot_descriptions." + n + "_mj_description").MJCF_PATH)

def limb_data(m, chain, n, rng, g=9.81):
    d = mujoco.MjData(m); dofs = []
    for x in chain:
        adr, k = int(m.body_jntadr[x]), int(m.body_jntnum[x])
        for j in range(adr, adr + k):
            if int(m.jnt_type[j]) == 3: dofs.append((j, int(m.jnt_qposadr[j]), int(m.jnt_dofadr[j])))
    mujoco.mj_forward(m, d)
    gs = [k for k in range(m.ngeom) if int(m.geom_bodyid[k]) in chain]
    far = max(gs, key=lambda k: np.linalg.norm(d.geom_xpos[k] - d.xpos[chain[0]]))
    tipbody = int(m.geom_bodyid[far])
    ext = float(np.linalg.norm(d.geom_xpos[far] - d.xpos[chain[0]]))
    R0 = d.xmat[chain[0]].reshape(3, 3).copy()
    X = np.zeros((n, 2 * MAXD + 3)); Y = np.zeros((n, MAXD))
    jp = np.zeros((3, m.nv))
    for i in range(n):
        d.qpos[:] = m.qpos0; d.qvel[:] = 0
        for k, (j, qa, da) in enumerate(dofs[:MAXD]):
            lo, hi = m.jnt_range[j] if m.jnt_limited[j] else (-np.pi, np.pi)
            q = rng.uniform(lo, hi); d.qpos[qa] = q
            X[i, 2*k], X[i, 2*k+1] = np.sin(q), np.cos(q)
        mujoco.mj_forward(m, d)
        f = rng.normal(size=3); f /= np.linalg.norm(f)
        X[i, 2*MAXD:] = R0.T @ f
        jp[:] = 0; mujoco.mj_jac(m, d, jp, None, d.geom_xpos[far], tipbody)
        for k, (j, qa, da) in enumerate(dofs[:MAXD]): Y[i, k] = (jp[:, da] @ f) / (ext + 1e-9)
    return X, np.clip(Y, -5, 5)

def fit(X, Y, seed): return MLPRegressor(hidden_layer_sizes=(64, 64), max_iter=300, random_state=seed).fit(X, Y)

rng = np.random.default_rng(0); limbs = []
for n in sys.argv[1:]:
    try:
        m = model_of(n)
        for p in parts_of(n + "_mj_description"):
            if 2 <= p[2] <= MAXD and p[3] == 0:
                limbs.append(dict(robot=n, part=str(p[0]), fam=FAM.get(n, n), m=m, chain=p[11],
                                  f=[p[2], p[3], p[6], p[4], np.log(max(p[5], 1e-3)), p[7], p[8], p[9], 3*p[10]],
                                  hing=p[2], share=p[6], lext=np.log(max(p[5], 1e-3))))
    except Exception as e: print("skip", n, str(e)[:60])
F = np.array([l["f"] for l in limbs], float); F = (F - F.mean(0)) / (F.std(0) + 1e-9)
for l, z in zip(limbs, F): l["z"] = z
for l in limbs: l["X"], l["Y"] = limb_data(l["m"], l["chain"], 900, rng)
for l in limbs: l.pop("m"); l.pop("chain")
N = len(limbs); print(N, "limbs from", len(set(l["robot"] for l in limbs)), "robots", flush=True)


def mixed(D, Xt, Yt, s):
    Xm = np.vstack([D["X"][:300]] + [Xt] * (300 // len(Xt) // 2 + 1)); Ym = np.vstack([D["Y"][:300]] + [Yt] * (300 // len(Xt) // 2 + 1))
    return fit(Xm, Ym, s)

def one(ti, nt):
    T = limbs[ti]; Xe, Ye = T["X"][700:], T["Y"][700:]
    rg = np.random.default_rng(1000 + ti)
    cand = [d for d in range(N) if limbs[d]["fam"] != T["fam"]]
    pool = list(rg.choice(cand, POOL, replace=False))
    gains = {d: [] for d in pool}
    for s in range(SEEDS):
        Xt, Yt = T["X"][600 + s*nt: 600 + (s+1)*nt], T["Y"][600 + s*nt: 600 + (s+1)*nt]
        base = np.mean((fit(Xt, Yt, s).predict(Xe) - Ye) ** 2)
        for d in pool:
            gains[d].append(float(np.clip((base - np.mean((mixed(limbs[d], Xt, Yt, s).predict(Xe) - Ye) ** 2)) / base, -3, 1)))
    return ti, pool, {d: float(np.mean(v)) for d, v in gains.items()}

import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
fig, axes = plt.subplots(1, len(NTS), figsize=(10, 4), sharey=True); axes = np.atleast_1d(axes)
rng2 = np.random.default_rng(5)
for ax, nt in zip(axes, NTS):
    out = Parallel(n_jobs=2)(delayed(one)(ti, nt) for ti in range(N))
    import pickle; pickle.dump(([(l['robot'],l['fam'],l['z'],l['f']) for l in limbs], out), open('pairs_contact.pkl', 'wb'))
    rules = {"M2 distance": lambda D, T: np.linalg.norm(D["z"] - T["z"]), "joint count": lambda D, T: abs(D["hing"] - T["hing"]),
             "size": lambda D, T: abs(D["lext"] - T["lext"]), "mass share": lambda D, T: abs(D["share"] - T["share"])}
    per = {k: [] for k in list(rules) + ["random", "best in pool"]}
    for ti, pool, g in out:
        T = limbs[ti]; gv = np.array([g[d] for d in pool])
        for k, f in rules.items():
            key = np.array([f(limbs[d], T) for d in pool]); w = np.isclose(key, key.min()); per[k].append(gv[w].mean())
        per["random"].append(gv.mean()); per["best in pool"].append(gv.max())
    print(f"\n=== {nt} target samples, pick 1 donor from a pool of {POOL} cross-family candidates, {N} targets ===")
    print(f"{'rule':14}{'mean gain':>10}{'95% CI':>20}")
    means = []; cis = []
    for k, v in per.items():
        v = np.array(v); bs = [rng2.choice(v, len(v)).mean() for _ in range(2000)]
        lo, hi = np.percentile(bs, [2.5, 97.5]); means.append(v.mean()); cis.append((v.mean() - lo, hi - v.mean()))
        print(f"{k:14}{v.mean():>+10.3f}   [{lo:+.3f}, {hi:+.3f}]")
    m2 = np.array(per["M2 distance"])
    for k in ["random", "joint count", "size", "mass share"]:
        d = m2 - np.array(per[k]); bs = [rng2.choice(d, len(d)).mean() for _ in range(2000)]
        print(f"  M2 minus {k:12} = {d.mean():+.3f}  95% CI [{np.percentile(bs,2.5):+.3f}, {np.percentile(bs,97.5):+.3f}]  M2 better on {100*np.mean(d>0):.0f}% of targets")
    ks = list(per); cols = ["#1b6ca8"] + ["#999"] * 4 + ["#2e8b57"]
    ax.bar(range(len(ks)), means, yerr=np.array(cis).T, color=cols, capsize=3)
    ax.axhline(0, color="k", lw=0.8); ax.set_xticks(range(len(ks))); ax.set_xticklabels(ks, rotation=40, ha="right", fontsize=8)
    ax.set_title(f"{nt} target samples"); 
axes[0].set_ylabel("error reduction vs no donor (0 = no help)")
plt.suptitle("Donor chosen by each rule (contact-force task, mixed training, cross-family donors)"); plt.tight_layout(); plt.close()
