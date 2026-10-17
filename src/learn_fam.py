import pickle, sys, numpy as np, warnings
from sklearn.linear_model import Ridge
from sklearn.ensemble import GradientBoostingRegressor
warnings.filterwarnings("ignore")
rng = np.random.default_rng(0)
FEAT = ["hinges", "slides", "mass share", "mass", "log size", "n axes", "lateral", "up", "ground end"]

def load(tag):
    meta, out = pickle.load(open(f"pairs_{tag}.pkl", "rb"))
    return meta, out

def pairfeat(meta, ti, di):
    zt, zd = meta[ti][2], meta[di][2]
    return np.concatenate([np.abs(zt - zd), zt, zd])

def evaluate(tag, reps=5):
    meta, out = load(tag)
    robots = sorted(set(m[1] for m in meta))
    P = []  # (ti, di, gain)
    for ti, pool, g in out:
        for di in pool: P.append((ti, di, g[di]))
    rules = ["learned ridge", "learned boosted trees", "M2 distance", "size", "mass share", "joint count", "random", "best in pool"]
    res = {r: {} for r in rules}
    for rep in range(reps):
        perm = rng.permutation(robots); folds = [set(perm[i::5]) for i in range(5)]
        for H in folds:
            tr = [p for p in P if meta[p[0]][1] not in H and meta[p[1]][1] not in H]
            Xtr = np.array([pairfeat(meta, a, b) for a, b, _ in tr]); ytr = np.clip([g for *_, g in tr], -3, 1)
            rid = Ridge(alpha=3.0).fit(Xtr[:, :9], ytr)
            gbm = GradientBoostingRegressor(n_estimators=150, max_depth=3, subsample=0.8, random_state=0).fit(Xtr, ytr)
            for ti, pool, g in out:
                if meta[ti][1] not in H: continue
                pool = list(pool); gv = np.clip([g[d] for d in pool], -3, 1)
                F = np.array([pairfeat(meta, ti, d) for d in pool])
                zt = meta[ti][2]; raw = lambda d: meta[d][3]
                def tie(key):
                    k = np.array(key); w = np.isclose(k, k.min()); return gv[w].mean()
                vals = {"learned ridge": gv[int(np.argmax(rid.predict(F[:, :9])))], "learned boosted trees": gv[int(np.argmax(gbm.predict(F)))],
                        "M2 distance": tie([np.linalg.norm(meta[d][2] - zt) for d in pool]),
                        "size": tie([abs(raw(d)[4] - raw(ti)[4]) for d in pool]), "mass share": tie([abs(raw(d)[2] - raw(ti)[2]) for d in pool]),
                        "joint count": tie([abs(raw(d)[0] - raw(ti)[0]) for d in pool]), "random": gv.mean(), "best in pool": gv.max()}
                for r in rules: res[r].setdefault(ti, []).append(vals[r])
    per = {r: np.array([np.mean(v) for _, v in sorted(res[r].items())]) for r in rules}
    print(f"\n===== task: {tag}  ({len(per['random'])} targets, whole robot FAMILIES held out, {reps} random splits) =====")
    print(f"{'donor chosen by':24}{'mean gain':>10}{'95% CI':>20}")
    for r in rules:
        v = per[r]; bs = [rng.choice(v, len(v)).mean() for _ in range(2000)]
        print(f"{r:24}{v.mean():>+10.3f}   [{np.percentile(bs,2.5):+.3f}, {np.percentile(bs,97.5):+.3f}]")
    for a in ["learned ridge", "learned boosted trees"]:
        for b in ["size", "M2 distance", "random"]:
            d = per[a] - per[b]; bs = [rng.choice(d, len(d)).mean() for _ in range(2000)]
            print(f"  {a} minus {b:12} = {d.mean():+.3f}  CI [{np.percentile(bs,2.5):+.3f}, {np.percentile(bs,97.5):+.3f}]  better on {100*np.mean(d>0):.0f}%")
    P_all = np.array([pairfeat(meta, a, b) for a, b, _ in P]); y = np.clip([g for *_, g in P], -3, 1)
    rid = Ridge(alpha=3.0).fit(P_all[:, :9], y)
    print("  ridge weights on |feature difference| (negative = bigger difference hurts):")
    for n, w in sorted(zip(FEAT, rid.coef_), key=lambda t: t[1]): print(f"     {n:12}{w:+.3f}")

for tag in sys.argv[1:]: evaluate(tag)
