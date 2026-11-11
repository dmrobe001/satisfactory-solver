#!/usr/bin/env python3
"""Recipe-count budget: the fastest build time T with at most K distinct recipes.

Same model as the continuous stage of tools/optimize.py, plus a 0/1 switch per
production recipe (generators included; miners, extractors, wells and geysers are
not recipes here): a recipe can run only when switched on, and at most K may be
on.  For a fixed lam = 1/T this is a mixed-integer feasibility problem; lam is
found by bisection.  The bill of materials (item-type counts, which items are
billed) is taken from the all-recipe optimum.  Each recipe set found is then
re-solved as an ordinary continuous problem ("polished"), with its own item-type
counts.

Usage: python3 tools/recipe_budget.py [--k 140,130,...] [--jobs 4] [--time 60]
Writes data/recipe_budget.json and data/recipe_budget.md.
"""
import argparse, json, sys, time
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import optimize as O  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BIG = 6000.0  # machines; no recipe comes near this
ST = {}


def setup(b0=None, usable=None):
    recs, raw, have = O.scope()
    O.MAKEABLE.update(have)
    for k in list(O.EQUIPMENT):
        if k not in have:
            O.EQUIPMENT.pop(k)
    V = O.make_vars(recs)
    ST.update(recs=recs, raw=raw, V=V, b0=b0, usable=usable)


def capture(model, lam):
    """The LP that Model.lp would solve, without solving it."""
    box = {}
    real = O.solve
    O.solve = lambda *a, **k: (box.update(a=a), (False, None, None))[1]
    try:
        model.lp(lam, ST["b0"], ST["usable"])
    finally:
        O.solve = real
    return box.get("a")


def feasible(model, lam, K, tl):
    a = capture(model, lam)
    if a is None:
        return None, False
    nv, cost, rows, lb, ub = a
    V = ST["V"]
    rec = [j for j, v in enumerate(V) if v.kind == "recipe" and model.allowed[j]]
    y = {j: nv + i for i, j in enumerate(rec)}
    n2 = nv + len(rec)
    rows = list(rows)
    for j in rec:
        rows.append(({j: 1.0, y[j]: -BIG}, None, 0.0))
    rows.append(({y[j]: 1.0 for j in rec}, None, float(K)))
    lb2 = list(lb) + [0.0] * len(rec)
    ub2 = list(ub) + [1.0] * len(rec)
    integ = [0] * nv + [1] * len(rec)
    t = time.time()
    ok, sol, _ = O.solve(n2, [0.0] * n2, rows, lb2, ub2, integer=integ, time_limit=tl)
    timed_out = (not ok) and time.time() - t >= tl * 0.95
    if ST.get("verbose"):
        print("    K=%d lam=%.6g T=%.2f: %s in %.1f s" % (K, lam, 1 / lam, "feasible" if ok else ("time limit" if timed_out else "infeasible"), time.time() - t), flush=True)
    if not ok:
        return None, timed_out
    on = [j for j in rec if sol[y[j]] > 0.5 and sol[j] > 1e-7]
    return on, False


def run_k(args):
    K, lam_all, tl = args
    V = ST["V"]
    model = O.Model(V, ST["raw"])
    hi, lo, best, tos = lam_all, 0.0, None, 0
    probe = lam_all * 0.9
    while lo == 0.0 and probe > lam_all * 0.05:  # find a feasible lower bracket
        on, to = feasible(model, probe, K, tl)
        tos += to
        if on is not None:
            lo, best = probe, on
        else:
            hi, probe = probe, probe * 0.75
    if best is None:
        return {"K": K, "T_budget": None, "timeouts": tos}
    while hi - lo > 0.002 * hi:
        mid = (lo + hi) / 2
        on, to = feasible(model, mid, K, tl)
        tos += to
        if on is not None: lo, best = mid, on
        else: hi = mid
    # polish: the chosen recipes as an ordinary continuous problem
    m2 = O.Model(V, ST["raw"])
    keep = set(best)
    m2.allowed = [(v.kind != "recipe") or (j in keep) for j, v in enumerate(V)]
    try:
        lam2, x2, _ = O.continuous(m2, 0.0, lambda s: None, max_rounds=4)
        used = sorted(V[j].id for j in range(len(V)) if V[j].kind == "recipe" and x2[j] > 1e-6)
        Tp = 1 / lam2
    except RuntimeError:
        used, Tp = sorted(V[j].id for j in best), None
    return {"K": K, "T_budget": 1 / lo, "T_polished": Tp, "recipes": used, "n_recipes": len(used), "timeouts": tos}


def init(b0, usable, verbose=False):
    setup(b0, usable)
    ST["verbose"] = verbose


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", default="")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--time", type=float, default=60)
    ap.add_argument("--cache", help="save/reuse the all-recipe optimum (bill of materials) here")
    a = ap.parse_args()
    setup()
    V = ST["V"]
    model = O.Model(V, ST["raw"])
    seen = {}
    real_best = model.best

    def rec_best(b0, usable, tol=1e-6):
        seen["b0"], seen["usable"] = b0, usable
        return real_best(b0, usable, tol)
    model.best = rec_best
    cache = Path(a.cache) if a.cache else None
    if cache and cache.exists():
        c = json.loads(cache.read_text())
        lam_all, x, seen["b0"], seen["usable"] = c["lam"], c["x"], c["b0"], set(c["usable"])
    else:
        lam_all, x, _ = O.continuous(model, 0.0, lambda s: None, max_rounds=6)
        if cache:
            cache.write_text(json.dumps({"lam": lam_all, "x": x, "b0": seen["b0"], "usable": sorted(seen["usable"])}))
    n_all = sum(1 for j, v in enumerate(V) if v.kind == "recipe" and x[j] > 1e-6)
    print("all recipes: T = %.2f min with %d recipes running" % (1 / lam_all, n_all), flush=True)
    ks = [int(k) for k in a.k.split(",")] if a.k else list(range(n_all - 5, 50, -5))
    out = []
    with Pool(a.jobs, initializer=init, initargs=(seen["b0"], seen["usable"], a.verbose)) as pool:
        for r in pool.imap_unordered(run_k, [(k, lam_all, a.time) for k in ks]):
            out.append(r)
            print("K = %3d: T = %s (budget model), %s polished, %s recipes, %d timeouts" % (
                r["K"], "%.2f" % r["T_budget"] if r["T_budget"] else "infeasible",
                "%.2f" % r["T_polished"] if r.get("T_polished") else "-", r.get("n_recipes", "-"), r["timeouts"]),
                flush=True)
    out.sort(key=lambda r: -r["K"])
    (ROOT / "data" / "recipe_budget.json").write_text(json.dumps(
        {"T_all": 1 / lam_all, "n_all": n_all, "runs": out}, indent=1))
    # report: the frontier and which recipes leave as K shrinks
    NAME = {r["id"]: r["name"] for r in ST["recs"]}
    lines = ["| K (budget) | Recipes used | T (min) | vs. all recipes |", "|---|---|---|---|",
             "| all | %d | %.2f | |" % (n_all, 1 / lam_all)]
    for r in out:
        if r["T_budget"]:
            T = r["T_polished"] or r["T_budget"]
            lines.append("| %d | %d | %.2f | +%.1f %% |" % (r["K"], r["n_recipes"], T, 100 * (T * lam_all - 1)))
        else:
            lines.append("| %d | | infeasible | |" % r["K"])
    lines.append("")
    feas = [r for r in out if r["T_budget"]]
    for prev, cur in zip(feas, feas[1:]):
        gone = sorted(NAME[i] for i in set(prev["recipes"]) - set(cur["recipes"]))
        new = sorted(NAME[i] for i in set(cur["recipes"]) - set(prev["recipes"]))
        lines.append("**K %d -> %d**: dropped %s%s" % (prev["K"], cur["K"], ", ".join(gone) or "none",
                                                     ("; added " + ", ".join(new)) if new else ""))
        lines.append("")
    (ROOT / "data" / "recipe_budget.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
