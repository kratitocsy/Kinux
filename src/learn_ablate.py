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
    rules = ["full (target+donor+diff)", "differences only", "donor features only", "target features only", "M2 distance", "size", "joint count", "random", "best in pool"]
    res = {r: {} for r in rules}
    for rep in range(reps):
        perm = rng.permutation(robots); folds = [set(perm[i::5]) for i in range(5)]
        for H in folds:
            tr = [p for p in P if meta[p[0]][1] not in H and meta[p[1]][1] not in H]
            Xtr = np.array([pairfeat(meta, a, b) for a, b, _ in tr]); ytr = np.clip([g for *_, g in tr], -3, 1)
            mk = lambda cols: GradientBoostingRegressor(n_estimators=150, max_depth=3, subsample=0.8, random_state=0).fit(Xtr[:, cols], ytr)
            COLS = {"full": list(range(27)), "diff": list(range(9)), "donor": list(range(18, 27)), "target": list(range(9, 18))}
            mods = {k: mk(c) for k, c in COLS.items()}
            for ti, pool, g in out:
                if meta[ti][1] not in H: continue
                pool = list(pool); gv = np.clip([g[d] for d in pool], -3, 1)
                F = np.array([pairfeat(meta, ti, d) for d in pool])
                zt = meta[ti][2]; raw = lambda d: meta[d][3]
                def tie(key):
                    k = np.array(key); w = np.isclose(k, k.min()); return gv[w].mean()
                pk = lambda k: gv[int(np.argmax(mods[k].predict(F[:, COLS[k]])))]
                rng_t = np.random.default_rng(ti)
                vals = {"full (target+donor+diff)": pk("full"), "differences only": pk("diff"), "donor features only": pk("donor"),
                        "target features only": gv[int(rng_t.integers(len(pool)))],
                        "M2 distance": tie([np.linalg.norm(meta[d][2] - zt) for d in pool]),
                        "size": tie([abs(raw(d)[4] - raw(ti)[4]) for d in pool]),                         "joint count": tie([abs(raw(d)[0] - raw(ti)[0]) for d in pool]), "random": gv.mean(), "best in pool": gv.max()}
                for r in rules: res[r].setdefault(ti, []).append(vals[r])
    per = {r: np.array([np.mean(v) for _, v in sorted(res[r].items())]) for r in rules}
    print(f"\n===== task: {tag}  ({len(per['random'])} targets, whole robot FAMILIES held out, {reps} random splits) =====")
    print(f"{'donor chosen by':24}{'mean gain':>10}{'95% CI':>20}")
    for r in rules:
        v = per[r]; bs = [rng.choice(v, len(v)).mean() for _ in range(2000)]
        print(f"{r:24}{v.mean():>+10.3f}   [{np.percentile(bs,2.5):+.3f}, {np.percentile(bs,97.5):+.3f}]")
    for a in ["full (target+donor+diff)", "differences only", "donor features only"]:
        for b in ["size", "random", "donor features only"]:
            if a == b: continue
            d = per[a] - per[b]; bs = [rng.choice(d, len(d)).mean() for _ in range(2000)]
            print(f"  {a} minus {b:12} = {d.mean():+.3f}  CI [{np.percentile(bs,2.5):+.3f}, {np.percentile(bs,97.5):+.3f}]  better on {100*np.mean(d>0):.0f}%")

for tag in sys.argv[1:]: evaluate(tag)
