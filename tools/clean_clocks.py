#!/usr/bin/env python3
"""Is there a factory with clean clocks (multiples of 1/D, default 1/125 = 0.8 %)?

No power, resource, building or size limits.  Every recipe's total effective
clock y[r] (machines x clock, in machines at 100 %) is a whole number of 1/D
steps; with machine counts free, such a total always splits over machines at
1/D-multiple clocks, so this is the whole condition.  Conditions:
  * Phase 5 parts made in exact proportion, at S times the rate of one AI
    Expansion Server machine at 19.2 % (0.768/min; S = 1 by default)
  * every item that is not a building material nets exactly 0
  * building materials (anything in a non-FICSMAS build cost) net >= 0
  * raw resources (mined, extracted, water) are only drawn, never left over
  * power is ignored
Recipes: everything not depending on hand-gathered items, except Packager
recipes other than Packaged Nitrogen Gas, Packaged Turbofuel and Packaged
Rocket Fuel.  Generators (burning fuel) are in unless --no-generators.

Usage: python3 tools/clean_clocks.py [--d 125] [--s 1 | --min-s] [--no-generators]
The answer is verified in exact rational arithmetic.
"""
import argparse, json, math, sys, time
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import optimize as O  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
KEEP_PACKAGER = {"PackagedNitrogen", "PackagedTurboFuel", "PackagedRocketFuel"}
AI = "SpaceElevatorPart_12"
UNIT_RATE = Fraction(3, 1000)  # S = 1: each part at P5 amount x 0.003 per min (AI server 256 x 0.003 = 0.768)


def build(no_gen):
    recs, raw, have = O.scope()
    recs = [r for r in recs if not (r["m"] == "Packager" and r["id"] not in KEEP_PACKAGER)]
    if no_gen:
        recs = [r for r in recs if r["kind"] != "burn"]
    # reachability after the exclusions
    ok = set(raw) | {"Power"}
    changed = True
    while changed:
        changed = False
        for r in recs:
            if all(k in ok for k, _ in r["ins"]):
                for k, _ in r["outs"]:
                    if k not in ok:
                        ok.add(k); changed = True
    recs = [r for r in recs if all(k in ok for k, _ in r["ins"])]
    bm = {it for k, b in O.BLD.items() if not b.get("xmas") for it, _ in b["cost"]}
    return recs, raw, bm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--d", type=int, default=125)
    ap.add_argument("--union", help="per-recipe choice of denominator, e.g. 125,100,80,64 "
                    "(each recipe's total is a multiple of 1/d for one d of its own)")
    ap.add_argument("--s", type=int, default=1)
    ap.add_argument("--min-s", action="store_true", help="find the smallest scale S that works")
    ap.add_argument("--no-generators", action="store_true")
    ap.add_argument("--grid", help="JSON file {recipe id: denominator} fixing each listed recipe's grid; "
                    "other recipes use --d; the common unit is the lcm")
    ap.add_argument("--recipes-from", help="only the recipes used in this --out file (a heuristic restriction)")
    ap.add_argument("--max-machines", type=float, default=300.0,
                    help="upper bound on any recipe's total, in machines at 100 %% (tightens --union)")
    ap.add_argument("--time", type=float, default=300)
    ap.add_argument("--out")
    a = ap.parse_args()
    recs, raw, bm = build(a.no_generators)
    if a.recipes_from:
        keep = set(json.loads(Path(a.recipes_from).read_text())["recipes"])
        recs = [r for r in recs if r["id"] in keep]
    dens = [int(v) for v in a.union.split(",")] if a.union else None
    grid = {k: int(v) for k, v in json.loads(Path(a.grid).read_text()).items()} if a.grid else None
    D = math.lcm(*dens) if dens else (math.lcm(a.d, *grid.values()) if grid else a.d)
    rates = []
    for r in recs:
        d = {}
        for k, v in r["ins"]:
            if k != "Power": d[k] = d.get(k, 0) - O.frac(v)
        for k, v in r["outs"]:
            if k != "Power": d[k] = d.get(k, 0) + O.frac(v)
        rates.append({k: v for k, v in d.items() if v})
    items = sorted({k for d in rates for k in d})
    R = len(recs)
    SCOL = R  # scale variable
    nv = R + 1
    rows, kinds = [], []
    for k in items:
        coef = {j: rates[j][k] / D for j in range(R) if k in rates[j]}
        if k in O.PHASE5:
            coef[SCOL] = -O.PHASE5[k] * UNIT_RATE
            kind = "eq"
        elif k in raw:
            kind = "le"
        elif k in bm:
            kind = "ge"
        else:
            kind = "eq"
        # scale to integers (exactness: integer data and integer variables)
        L = 1
        for c in coef.values(): L = L * Fraction(c).denominator // math.gcd(L, Fraction(c).denominator)
        icoef = {j: int(c * L) for j, c in coef.items()}
        rows.append((k, icoef, kind))
    for p in O.PHASE5:
        if p not in items:
            print("cannot make", O.ITEMS[p]["n"]); return 1
    print("%d recipes, %d items (%d must balance exactly, %d building materials, %d raw)"
          % (R, len(items), sum(1 for r in rows if r[2] == "eq"), sum(1 for r in rows if r[2] == "ge"),
             sum(1 for r in rows if r[2] == "le")), flush=True)
    hrows = []
    for k, c, kind in rows:
        d = {j: float(v) for j, v in c.items()}
        hrows.append((d, 0.0 if kind in ("eq", "ge") else None, 0.0 if kind in ("eq", "le") else None))
    lb = [0.0] * nv
    ub = [None] * nv
    if grid:  # Y_r = (D / d_r) W_r: recipe r on its own fixed grid
        for j, r in enumerate(recs):
            m = D // grid.get(r["id"], a.d)
            if m > 1:
                w = nv; nv += 1; lb.append(0.0); ub.append(None)
                hrows.append(({j: 1.0, w: -float(m)}, 0.0, 0.0))
    if dens:  # Y_r = sum_k (D / d_k) W_rk, with at most one k per recipe (binary b_rk)
        extra = []
        for j in range(R):
            ws = []
            for dk in dens:
                w, b = nv, nv + 1
                nv += 2
                lb += [0.0, 0.0]; ub += [None, 1.0]
                hrows.append(({w: 1.0, b: -a.max_machines * dk}, None, 0.0))
                ws.append((w, b, D // dk))
            hrows.append(({j: 1.0, **{w: -float(m) for w, _, m in ws}}, 0.0, 0.0))
            hrows.append(({b: 1.0 for _, b, _ in ws}, None, 1.0))
    if a.min_s:
        lb[SCOL] = 1.0
        cost = [0.0] * R + [1.0] + [0.0] * (nv - R - 1)
    else:
        lb[SCOL] = ub[SCOL] = float(a.s)
        cost = [1.0 / D] * R + [0.0] * (nv - R)  # fewest machines at 100 %
    # continuous check first
    ok, x, obj = O.solve(nv, cost, hrows, lb, ub)
    print("continuous (rational clocks allowed): %s" % ("feasible" if ok else "INFEASIBLE"), flush=True)
    if not ok:
        return 1
    t = time.time()
    integ = [1] * nv
    ok, x, obj = O.solve(nv, cost, hrows, lb, ub, integer=integ, time_limit=a.time)
    dt = time.time() - t
    if not ok or x is None:
        print("integer (1/%d steps): no solution found in %.0f s" % (D, dt))
        return 2
    Y = [int(round(v)) for v in x]
    # exact verification
    bad = []
    for k, c, kind in rows:
        v = sum(c[j] * Y[j] for j in c)
        if (kind == "eq" and v != 0) or (kind == "ge" and v < 0) or (kind == "le" and v > 0):
            bad.append(O.ITEMS[k]["n"])
    S = Y[SCOL]
    used = [(recs[j], Y[j]) for j in range(R) if Y[j]]
    print("integer (1/%d steps): %s in %.0f s, S = %d (AI Expansion Server %.3f/min)%s"
          % (D, "FOUND" if not bad else "rounding broke " + ", ".join(bad), dt, S,
             float(256 * UNIT_RATE * S), ""), flush=True)
    print("%d recipes used, %.2f machines at 100 %% in all" % (len(used), sum(y for _, y in used) / D))
    dmax = max(Fraction(y, D).denominator for _, y in used)
    print("largest denominator of a recipe total (machines at 100 %%): %d" % dmax)
    surplus = []
    for k, c, kind in rows:
        if kind == "ge":
            v = Fraction(sum(c[j] * Y[j] for j in c))
            if v > 0: surplus.append(O.ITEMS[k]["n"])
    print("building materials left over:", ", ".join(sorted(surplus)) or "none")
    for r, y in sorted(used, key=lambda t: t[0].get("layer", 0)):
        print("  %-48s %8s machines at 100%%  (%s)" % (r["name"], ("%.3f" % (y / D)).rstrip("0").rstrip("."),
                                                      str(Fraction(y, D))))
    if a.out:
        Path(a.out).write_text(json.dumps({"d": D, "S": S, "recipes": {r["id"]: y for r, y in used},
                                           "verified": not bad}, indent=1))
    return 0 if not bad else 3


if __name__ == "__main__":
    sys.exit(main())
