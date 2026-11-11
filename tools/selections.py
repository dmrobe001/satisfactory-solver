#!/usr/bin/env python3
"""Continuous optimum for hand-picked one-recipe-per-item selections.

  lottery-best   for each item, the recipe with the best (most negative) fitted
                 effect on T in data/recipe_lottery.json
  dominant       solve with every recipe allowed; for each item keep the recipe
                 that makes most of it (items the solution does not make take
                 the lottery-best recipe)
  splits         the dominant selection, with every combination of choices for
                 the items whose dominant recipe made under SPLIT of the item
Writes data/selections.json.  Usage: python3 tools/selections.py [--split 0.8]
"""
import argparse, itertools, json, math, sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import optimize as O  # noqa: E402
import recipe_lottery as L  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def lottery_effects(data):
    G, ok = data["groups"], [r for r in data["runs"] if r["T"]]
    cols = [(k, rid) for k in sorted(G) for rid in G[k][1:]]
    ci = {c: i for i, c in enumerate(cols)}
    X = np.zeros((len(ok), len(cols) + 1)); X[:, -1] = 1
    for i, r in enumerate(ok):
        for k, rs in G.items():
            rid = r["pick"][k]
            if rid == rs[0]:
                for o in rs[1:]: X[i, ci[(k, o)]] = -1
            else:
                X[i, ci[(k, rid)]] = 1
    beta = np.linalg.lstsq(X, np.log([r["T"] for r in ok]), rcond=None)[0]
    eff = {}
    for k, rs in G.items():
        rest = [beta[ci[(k, o)]] for o in rs[1:]]
        eff[rs[0]] = -sum(rest)
        for o, b in zip(rs[1:], rest): eff[o] = b
    return eff


def solve_pick(pick):
    """Continuous T with only the picked recipe for each grouped item."""
    drop = {rid for k, v in L.GROUPS.items() for rid in v if rid != pick[k]}
    V = O.make_vars([r for r in L.RECS if r["id"] not in drop])
    try:
        lam, x, _ = O.continuous(O.Model(V, L.RAW), 0.0, lambda s: None, max_rounds=4)
    except RuntimeError:
        return None, {}
    if lam <= 1e-6:
        return None, {}
    return 1 / lam, {V[j].id: x[j] for j in range(len(V)) if x[j] > 1e-6}


def shares(xmap):
    """Per grouped item: {recipe: share of the item's production by group recipes}."""
    rec = {r["id"]: r for r in L.RECS}
    out = {}
    for k, rs in L.GROUPS.items():
        made = {rid: xmap.get(rid, 0) * rec[rid]["outs"][0][1] for rid in rs}
        tot = sum(made.values())
        if tot > 0:
            out[k] = {rid: m / tot for rid, m in made.items() if m > 0}
    return out


def task(args):
    name, pick = args
    T, xm = solve_pick(pick)
    return name, pick, T, xm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", type=float, default=0.8)
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    L.init()
    data = json.loads((ROOT / "data" / "recipe_lottery.json").read_text())
    eff = lottery_effects(data)
    NAME = {r["id"]: r["name"] for r in L.RECS}
    INAME = {k: v["n"] for k, v in O.ITEMS.items()}
    best = {k: min(v, key=lambda rid: eff[rid]) for k, v in L.GROUPS.items()}
    # the all-recipe optimum
    V = O.make_vars(L.RECS)
    lam, x, _ = O.continuous(O.Model(V, L.RAW), 0.0, lambda s: None, max_rounds=4)
    T_all = 1 / lam
    sh = shares({V[j].id: x[j] for j in range(len(V)) if x[j] > 1e-6})
    dom = dict(best)
    for k, s in sh.items():
        dom[k] = max(s, key=s.get)
    split_items = sorted(k for k, s in sh.items() if max(s.values()) < a.split)
    print("all recipes: T = %.2f min" % T_all)
    print("items split in the all-recipe optimum (dominant recipe under %.0f %%):" % (100 * a.split))
    for k in split_items:
        print("  %-28s %s" % (INAME[k], ", ".join("%s %.0f%%" % (NAME[r], 100 * v)
                                                   for r, v in sorted(sh[k].items(), key=lambda t: -t[1]))))
    jobs = [("lottery-best", best), ("dominant", dom)]
    opts = [sorted(sh[k], key=lambda r: -sh[k][r]) for k in split_items]
    for combo in itertools.product(*opts):
        p = dict(dom)
        for k, rid in zip(split_items, combo): p[k] = rid
        if p != dom:
            jobs.append(("split:" + ",".join(NAME[r] for k, r in zip(split_items, combo) if r != dom[k]), p))
    print("%d selections to solve" % len(jobs), flush=True)
    res = []
    with Pool(a.jobs, initializer=L.init) as pool:
        for name, pick, T, xm in pool.imap_unordered(task, jobs):
            res.append({"name": name, "T": T, "pick": pick, "used": sorted(xm)})
    res.sort(key=lambda r: (r["T"] is None, r["T"] or 0))
    for r in res:
        print("%8s  %s" % ("%.2f" % r["T"] if r["T"] else "infeas.", r["name"]))
    diff = {INAME[k]: (NAME[best[k]], NAME[dom[k]]) for k in L.GROUPS if best[k] != dom[k]}
    print("lottery-best vs dominant differ on %d items:" % len(diff))
    for k, (b, d) in sorted(diff.items()):
        print("  %-28s lottery-best %-40s dominant %s" % (k, b, d))
    (ROOT / "data" / "selections.json").write_text(json.dumps(
        {"T_all": T_all, "split_items": split_items, "shares": sh, "runs": res}, indent=1))


if __name__ == "__main__":
    main()
