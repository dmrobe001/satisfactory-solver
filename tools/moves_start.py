#!/usr/bin/env python3
"""Starting ratios for the machine-moves page.

Recipe set: every production recipe (generators included) reachable without
hand-gathered items, leaving out all Unpackage recipes and every Packager
recipe except Packaged Fuel, Packaged Turbofuel, Packaged Rocket Fuel and
Packaged Ionized Fuel.  Every machine at 100 %.

A linear program finds the fewest machines (fractional) that make one exact
Phase 5 batch (AI Expansion Servers at BATCH per minute, the others in
proportion), with the page's item rules: fluids that are not raw and products
that are not building materials, equipment or Phase 5 parts net exactly 0;
building materials, equipment and Phase 5 parts net >= 0; raw resources are
only drawn.  Building materials and equipment may pile up but have no minimum
(no bill of materials): only the Phase 5 parts have a target.  With --closed
they must balance exactly too (the Phase 5 batch then grows to 960 AI
Expansion Servers per minute, and no whole-machine start was found in 5
minutes).

Usage: python3 tools/moves_start.py [--batch 192]   ->  data/moves_start.json
"""
import argparse, json, math, sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import optimize as O  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
KEEP_PACKAGER = {"Fuel", "PackagedTurboFuel", "PackagedRocketFuel", "PackagedIonizedFuel"}
EXPENDABLE = set(O.EXPENDABLE)


def recipe_set():
    raw = set()
    for r in O.R_ALL:
        if r["kind"] in ("miner", "extractor", "well"):
            raw.update(k for k, _ in r["outs"])
    cand = [r for r in O.R_ALL if r["kind"] in ("machine", "burn") and not r.get("xmas")
            and not (r["m"] == "Packager" and r["id"] not in KEEP_PACKAGER)]
    have = set(raw) | {"Power"}
    changed = True
    while changed:
        changed = False
        for r in cand:
            if all(k in have for k, _ in r["ins"]):
                for k, _ in r["outs"]:
                    if k not in have:
                        have.add(k); changed = True
    return [r for r in cand if all(k in have for k, _ in r["ins"])], raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=float, default=192.0)
    ap.add_argument("--time", type=float, default=300)
    ap.add_argument("--closed", action="store_true",
                    help="make building materials and equipment balance exactly too (default: they may pile up, "
                         "with no minimum; only the Phase 5 parts have a target)")
    a = ap.parse_args()
    recs, raw = recipe_set()
    bm = EXPENDABLE | set(O.PHASE5) | {it for b in O.BLD.values() if not b.get("xmas") for it, _ in b["cost"]}
    rates = []
    for r in recs:
        d = {}
        for k, v in r["ins"]:
            if k != "Power": d[k] = d.get(k, 0) - v
        for k, v in r["outs"]:
            if k != "Power": d[k] = d.get(k, 0) + v
        rates.append(d)
    items = sorted({k for d in rates for k in d})
    rows = []
    for k in items:
        coef = {j: d[k] for j, d in enumerate(rates) if d.get(k)}
        fluid = O.ITEMS[k]["f"]
        if k in O.PHASE5:
            v = a.batch * O.PHASE5[k] / 256
            rows.append((coef, v, v))
        elif k in raw:
            rows.append((coef, None, 0.0))
        elif not a.closed and k in bm and not fluid:
            rows.append((coef, 0.0, None))
        else:
            rows.append((coef, 0.0, 0.0))
    n = len(recs)
    ok, x, obj = O.solve(n, [1.0] * n, rows, [0.0] * n, [None] * n)
    if not ok:
        print("infeasible"); return 1
    base = {recs[j]["id"]: round(x[j], 6) for j in range(n) if x[j] > 1e-7}
    print("linear program: %.1f machines (fractional)" % obj, flush=True)
    # whole machines: the same rows with exact integer coefficients, integer counts
    irows = []
    for (coef, lo, hi), k in zip(rows, items):
        fr = {j: O.frac(c) for j, c in coef.items()}
        rhs = Fraction(a.batch) * O.PHASE5[k] / 256 if k in O.PHASE5 else Fraction(0)
        L = rhs.denominator
        for c in fr.values(): L = L * c.denominator // math.gcd(L, c.denominator)
        irows.append(({j: int(c * L) for j, c in fr.items()}, lo, hi, int(rhs * L)))
    hrows = [({j: float(c) for j, c in ic.items()}, None if lo is None else float(r), None if hi is None else float(r))
             for ic, lo, hi, r in irows]
    ok, xi, obj2 = O.solve(n, [1.0] * n, hrows, [0.0] * n, [None] * n, integer=[1] * n, time_limit=a.time)
    whole = None
    if ok and xi is not None:
        N = [int(round(v)) for v in xi]
        good = all((lo is None or sum(c * N[j] for j, c in ic.items()) >= r) and
                   (hi is None or sum(c * N[j] for j, c in ic.items()) <= r) for ic, lo, hi, r in irows)
        if good:
            whole = {recs[j]["id"]: N[j] for j in range(n) if N[j]}
            print("integer program: %d whole machines, verified exactly" % sum(N))
        else:
            print("integer program: rounding broke a balance; not used")
    else:
        print("integer program: nothing found in the time limit")
    closed = sorted(k for k in items if k in bm and k not in O.PHASE5 and not O.ITEMS[k]["f"]) if a.closed else []
    out = {"recipes": [r["id"] for r in recs], "base": base, "n": whole, "batch": a.batch,
           "valves": {k: "balance" for k in closed},
           "note": "base: fewest machines (fractional, all at 100 %) for one exact Phase 5 batch; "
                   "n: fewest whole machines for the same (integer program), when found"}
    (ROOT / "data" / "moves_start.json").write_text(json.dumps(out, indent=1))
    print("%d recipes in the set, %d used, %.1f machines for %g AI Expansion Servers/min"
          % (n, len(base), obj, a.batch))
    return 0


if __name__ == "__main__":
    sys.exit(main())
