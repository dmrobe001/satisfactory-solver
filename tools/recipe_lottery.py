#!/usr/bin/env python3
"""How much does the choice of alternate recipes matter?

For every item that more than one in-scope production recipe makes as its main
(first) product, pick one of those recipes at random and leave the others out;
then solve only the continuous stage of tools/optimize.py (same bill of
materials, resources and rules).  Generators are not drawn: every fuel stays
available, and so do the
Unpackage recipes.  Repeated with different seeds, this shows the spread of T and,
per recipe, how T differs when it is the one chosen.

Usage: python3 tools/recipe_lottery.py [--n 200] [--seed 1] [--jobs 4]
Writes data/recipe_lottery.json.
"""
import argparse, json, math, random, sys, time
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import optimize as O  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def setup():
    recs, raw, have = O.scope()
    O.MAKEABLE.update(have)
    for k in list(O.EQUIPMENT):
        if k not in have:
            O.EQUIPMENT.pop(k)
    groups = {}
    for r in recs:
        if r["kind"] != "machine" or r["name"].startswith("Unpackage"):
            continue  # unpackaging is not an alternate: alone it would leave a fluid with no source
        groups.setdefault(r["outs"][0][0], []).append(r["id"])
    groups = {k: sorted(v) for k, v in groups.items() if len(v) > 1}
    return recs, raw, groups


RECS = RAW = GROUPS = None


def init():
    global RECS, RAW, GROUPS
    RECS, RAW, GROUPS = setup()


def one(seed):
    rng = random.Random(seed)
    pick = {k: rng.choice(v) for k, v in sorted(GROUPS.items())}
    drop = {rid for k, v in GROUPS.items() for rid in v if rid != pick[k]}
    recs = [r for r in RECS if r["id"] not in drop]
    V = O.make_vars(recs)
    model = O.Model(V, RAW)
    t = time.time()
    try:
        lam, x, _ = O.continuous(model, 0.0, lambda s: None, max_rounds=4)
        T = 1 / lam if lam > 1e-6 else None
    except RuntimeError:
        T = None
    used = sorted(V[j].id for j in range(len(V)) if x is not None and T and x[j] > 1e-6 and V[j].kind == "recipe") if T else []
    return {"seed": seed, "T": T, "pick": pick, "used": used, "sec": round(time.time() - t, 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--out", default=str(ROOT / "data" / "recipe_lottery.json"))
    a = ap.parse_args()
    init()
    print("%d items with more than one recipe (%d recipes in those groups)"
          % (len(GROUPS), sum(len(v) for v in GROUPS.values())), flush=True)
    seeds = list(range(a.seed, a.seed + a.n))
    res = []
    with Pool(a.jobs, initializer=init) as pool:
        for i, r in enumerate(pool.imap_unordered(one, seeds), 1):
            res.append(r)
            if i % 10 == 0:
                ok = [x["T"] for x in res if x["T"]]
                print("%d done, %d feasible, best T %.1f, median %.1f" % (i, len(ok), min(ok or [0]),
                      sorted(ok)[len(ok) // 2] if ok else 0), flush=True)
            if i % 25 == 0:
                Path(a.out).write_text(json.dumps({"groups": GROUPS, "runs": res}))
    Path(a.out).write_text(json.dumps({"groups": GROUPS, "runs": sorted(res, key=lambda r: r["seed"])}))
    print("wrote", a.out)


if __name__ == "__main__":
    main()
