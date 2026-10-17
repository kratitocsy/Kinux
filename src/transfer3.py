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
NT = 20; SEEDS = 3

def model_of(n): return mujoco.MjModel.from_xml_path(importlib.import_module("robot_descriptions." + n + "_mj_description").MJCF_PATH)

def limb_data(m, chain, n, rng, g=9.81):
    d = mujoco.MjData(m); dofs = []
    for x in chain:
        adr, k = int(m.body_jntadr[x]), int(m.body_jntnum[x])
        for j in range(adr, adr + k):
            if int(m.jnt_type[j]) == 3: dofs.append((j, int(m.jnt_qposadr[j]), int(m.jnt_dofadr[j])))
    mass = float(sum(m.body_mass[x] for x in chain)); mujoco.mj_forward(m, d)
    ext = max(np.linalg.norm(d.geom_xpos[k] - d.xpos[chain[0]]) for k in range(m.ngeom) if int(m.geom_bodyid[k]) in chain)
    X = np.zeros((n, 2 * MAXD)); Y = np.zeros((n, MAXD))
    for i in range(n):
        d.qpos[:] = m.qpos0; d.qvel[:] = 0
        for k, (j, qa, da) in enumerate(dofs[:MAXD]):
            lo, hi = m.jnt_range[j] if m.jnt_limited[j] else (-np.pi, np.pi)
            q = rng.uniform(lo, hi); d.qpos[qa] = q
            X[i, 2*k], X[i, 2*k+1] = np.sin(q), np.cos(q)
        mujoco.mj_forward(m, d)
        for k, (j, qa, da) in enumerate(dofs[:MAXD]): Y[i, k] = d.qfrc_bias[da] / (mass * g * ext + 1e-9)
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

pre = [fit(l["X"][:600], l["Y"][:600], 0) for l in limbs]
def ft(base, Xt, Yt, lr, it):
    r = copy.deepcopy(base); r.warm_start = True; r.max_iter = it; r.learning_rate_init = lr; r.fit(Xt, Yt); return r
def run(proto, di, Xt, Yt, s):
    D = limbs[di]
    if proto == "sequential": return ft(pre[di], Xt, Yt, 3e-4, 100)
    if proto == "gentle": return ft(pre[di], Xt, Yt, 5e-5, 30)
    if proto == "mixed":
        Xm = np.vstack([D["X"][:300]] + [Xt] * 15); Ym = np.vstack([D["Y"][:300]] + [Yt] * 15)
        return fit(Xm, Ym, s)
PROTOS = ["sequential", "gentle", "mixed"]
def one_target(ti):
    T = limbs[ti]; Xe, Ye = T["X"][700:], T["Y"][700:]
    others = [d for d in range(N) if limbs[d]["robot"] != T["robot"]]
    dist = {d: np.linalg.norm(limbs[d]["z"] - T["z"]) for d in others}
    near = sorted(others, key=lambda d: dist[d])[:3]
    far = list(np.random.default_rng(ti).choice(others, 6, replace=False))
    out = {p: {"control": [], "near": [], "rand": []} for p in PROTOS}
    for s in range(SEEDS):
        Xt, Yt = T["X"][600 + s*NT: 600 + (s+1)*NT], T["Y"][600 + s*NT: 600 + (s+1)*NT]
        base = np.mean((fit(Xt, Yt, s).predict(Xe) - Ye) ** 2)
        g = lambda r: float(np.clip((base - np.mean((r.predict(Xe) - Ye) ** 2)) / base, -3, 1))
        for p in PROTOS:
            out[p]["control"].append(g(run(p, ti, Xt, Yt, s)))
            out[p]["near"].append(np.mean([g(run(p, d, Xt, Yt, s)) for d in near]))
            out[p]["rand"].append(np.mean([g(run(p, d, Xt, Yt, s)) for d in far]))
    return {p: {k: float(np.mean(v)) for k, v in out[p].items()} for p in PROTOS}
res = Parallel(n_jobs=2)(delayed(one_target)(ti) for ti in range(N))
print(f"\n{'protocol':12}{'perfect donor (control)':>26}{'M2-nearest 3':>16}{'random 6':>12}{'near>rand':>12}")
for p in PROTOS:
    c = np.mean([r[p]["control"] for r in res]); n_ = np.mean([r[p]["near"] for r in res]); r_ = np.mean([r[p]["rand"] for r in res])
    w = np.mean([r[p]["near"] > r[p]["rand"] for r in res])
    print(f"{p:12}{c:>+26.2f}{n_:>+16.2f}{r_:>+12.2f}{100*w:>11.0f}%")
