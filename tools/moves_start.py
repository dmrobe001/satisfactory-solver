#!/usr/bin/env python3
"""Starting ratios for the machine-moves page.

Recipe set: every production recipe (generators included) reachable without
hand-gathered items, leaving out all Unpackage recipes and every Packager
recipe except Packaged Fuel, Packaged Turbofuel, Packaged Rocket Fuel and
Packaged Ionized Fuel.  Every machine at 100 %.

Item rules (the page reads them from the output, so they live here only):
  accumulate  net >= 0, no minimum: everything the build gun uses (any
              building cost), ammunition, filters, and fuels (solid generator
              fuels, packaged fuels and batteries; not nuclear fuel rods),
              plus the Phase 5 parts
  raw         mined or extracted: only drawn, in whole multiples of 30/min
  balance     everything else (all other fluids and intermediates): net 0

The Phase 5 recipes run at one exact batch: the fewest whole machines that
make the four parts in proportion (1000 : 1000 : 256 : 200) and that the rest
of the factory can feed exactly; that is 192 AI Expansion Servers per minute
(the lattice step of the page's engine; 3x the 64/min the Phase 5 machines
alone would allow, because of the balances upstream).

A linear program finds the fewest machines (fractional), then an integer
program the fewest whole machines, with the raw draws as whole multiples of 30.

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


FUEL_SOLIDS = {"CompactedCoal", "PetroleumCoke"}   # solid generator fuels beyond the expendables list
RODS = {"NuclearFuelRod", "PlutoniumFuelRod", "FicsoniumFuelRod"}
RAW_STEP = 30


def rules(raw):
    acc = set(EXPENDABLE) | FUEL_SOLIDS | set(O.PHASE5)
    acc |= {it for b in O.BLD.values() if not b.get("xmas") for it, _ in b["cost"]}
    for r in O.R_ALL:  # any solid a generator burns
        if r["kind"] == "burn":
            acc |= {k for k, _ in r["ins"] if not O.ITEMS.get(k, {}).get("f")}
    acc -= RODS | raw
    return {it for it in acc if not O.ITEMS.get(it, {}).get("f")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=float, default=192.0)
    ap.add_argument("--time", type=float, default=600)
    a = ap.parse_args()
    recs, raw = recipe_set()
    acc = rules(raw)
    rates = []
    for r in recs:
        d = {}
        for k, v in r["ins"]:
            if k != "Power": d[k] = d.get(k, 0) - v
        for k, v in r["outs"]:
            if k != "Power": d[k] = d.get(k, 0) + v
        rates.append(d)
    items = sorted({k for d in rates for k in d})
    n = len(recs)
    raw_used = [k for k in items if k in raw]
    aux = {k: n + t for t, k in enumerate(raw_used)}   # raw draw = 30 * aux
    nv = n + len(aux)
    rows, irows = [], []
    for k in items:
        fr = {j: O.frac(d[k]) for j, d in enumerate(rates) if d.get(k)}
        rhs = Fraction(a.batch) * O.PHASE5[k] / 256 if k in O.PHASE5 else Fraction(0)
        L = rhs.denominator
        for c in fr.values(): L = L * c.denominator // math.gcd(L, c.denominator)
        ic = {j: int(c * L) for j, c in fr.items()}
        r = int(rhs * L)
        if k in O.PHASE5: lo, hi = r, r
        elif k in raw: ic[aux[k]] = RAW_STEP * L; lo, hi = 0, 0
        elif k in acc: lo, hi = 0, None
        else: lo, hi = 0, 0
        irows.append((ic, lo, hi))
        rows.append(({j: float(c) for j, c in ic.items()}, None if lo is None else float(lo), None if hi is None else float(hi)))
    cost = [1.0] * n + [0.0] * len(aux)
    ok, x, obj = O.solve(nv, cost, rows, [0.0] * nv, [None] * nv)
    if not ok:
        print("infeasible"); return 1
    base = {recs[j]["id"]: round(x[j], 6) for j in range(n) if x[j] > 1e-7}
    print("linear program: %.1f machines (fractional)" % obj, flush=True)
    ok, xi, obj2 = O.solve(nv, cost, rows, [0.0] * nv, [None] * nv, integer=[1] * nv, time_limit=a.time)
    whole = None
    if ok and xi is not None:
        N = [int(round(v)) for v in xi]
        good = all((lo is None or sum(c * N[j] for j, c in ic.items()) >= lo) and
                   (hi is None or sum(c * N[j] for j, c in ic.items()) <= hi) for ic, lo, hi in irows)
        if good:
            whole = {recs[j]["id"]: N[j] for j in range(n) if N[j]}
            print("integer program: %d whole machines, verified exactly" % sum(N[:n]))
        else:
            print("integer program: rounding broke a balance; not used")
    else:
        print("integer program: nothing found in the time limit")
    p5rec = [r["id"] for r in recs if any(k in O.PHASE5 for k, _ in r["outs"])]
    out = {"recipes": [r["id"] for r in recs], "base": base, "n": whole, "batch": a.batch,
           "rules": {"accumulate": sorted(acc), "raw": sorted(raw), "rawStep": RAW_STEP, "fixed": p5rec},
           "note": "base: fewest machines (fractional, all at 100 %) for one exact Phase 5 batch; "
                   "n: fewest whole machines for the same, raw draws in multiples of 30/min (integer program)"}
    (ROOT / "data" / "moves_start.json").write_text(json.dumps(out, indent=1))
    print("%d recipes in the set, %d used, %.1f machines for %g AI Expansion Servers/min"
          % (n, len(base), obj, a.batch))
    return 0


if __name__ == "__main__":
    sys.exit(main())
