#!/usr/bin/env python3
"""Building blocks: the Hilbert basis of whole-machine factories.

A factory is a whole number of machines per recipe, every machine at 100 %.
It is *valid* when
  balance  every fluid and every unusable item nets exactly 0;
  pile     every usable item nets >= 0 (anything the build gun uses,
           ammunition, filters, every fuel including batteries and all three
           nuclear fuel rods, and power shards);
  raw      every mined or extracted resource is only drawn, in whole
           multiples of 30 per minute.
Valid factories add up to valid factories.  A valid factory is a *block* when
it cannot be split into two smaller valid factories.  Every valid factory is a
sum of blocks (not always in one way), and because machine counts cannot go
negative the set of blocks is finite and unique: the Hilbert basis of the
cone (equations, inequalities) intersected with the lattice (integers, raw
draws in multiples of 30).  Computed with Normaliz (PyNormaliz).

Restricting the recipes only removes blocks, never changes them: a block of a
smaller recipe pool is exactly a block of the bigger pool that uses only
those recipes.  So pools can grow one recipe at a time.

Recipe pools: "standard" means no hard-drive alternates (Compacted Coal,
Polyester Fabric and Turbofuel are MAM unlocks, so standard, although the data
calls them alternates; the Automated Miner, the only machine recipe for the
Portable Miner, is counted as standard too, by choice).  Production recipes reachable from the allowed raw resources
without hand-gathered items; no Unpackage recipes; Packager recipes only for
Packaged Fuel, Turbofuel, Rocket Fuel and Ionized Fuel.  Generators are left
out (power is not modeled), except the nuclear plant burning uranium and
plutonium rods, whose waste feeds later recipes.  The Main Portal and the
Alien Power Augmentor are included as consumers of Singularity Cells and
Alien Power Matrices (which therefore must balance).  "Phase 5" is a stand-in
recipe that consumes the four Phase 5 parts at 250 : 250 : 64 : 50 per
minute (Nuclear Pasta, Biochemical Sculptor, AI Expansion Server, Ballistic
Warp Drive): the smallest output whole Phase 5 machines can make in exact
proportion (500, 125, 16 and 50 machines), so every in-proportion output of
whole Phase 5 machines is a whole number of these.

Usage:
  python3 tools/blocks.py --pool standard --raw OreIron,OreCopper,Stone --dry
  python3 tools/blocks.py --pool standard --raw OreIron,OreCopper,Stone --name t0
Writes data/blocks/<name>.json.
"""
import argparse
import json
import math
import sys
import time
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
G = json.loads((ROOT / "data" / "game.json").read_text())
ITEMS, RECIPES, BLD = G["items"], G["recipes"], G["buildings"]
EXTRACT = ("miner", "extractor", "well")
KEEP_PACKAGER = {"Fuel", "PackagedTurboFuel", "PackagedRocketFuel", "PackagedIonizedFuel"}
KEEP_BURN = {"Burn_NuclearFuelRod_GeneratorNuclear", "Burn_PlutoniumFuelRod_GeneratorNuclear"}
EXTRA = {"MainPortal", "Augmenter30"}
# Flagged "alternate" in the data (their class names start with Alternate_) but
# unlocked by MAM research, not by hard drives: standard recipes in 1.0.
MAM_NOT_ALT = {"Alternate_EnrichedCoal", "Alternate_PolyesterFabric", "Alternate_Turbofuel",
               "Alternate_AutomatedMiner"}  # the Portable Miner's only machine recipe: counted as standard by choice
EXPENDABLE = {"CartridgeStandard", "CartridgeSmartProjectile", "CartridgeChaos", "SpikedRebar",
              "Rebar_Stunshot", "Rebar_Spreadshot", "Rebar_Explosive", "NobeliskExplosive", "NobeliskGas",
              "NobeliskShockwave", "NobeliskCluster", "NobeliskNuke", "Filter", "HazmatFilter",
              "Biofuel", "Fuel", "TurboFuel", "PackagedBiofuel", "PackagedRocketFuel", "PackagedIonizedFuel",
              "Battery", "CompactedCoal", "PetroleumCoke",
              "NuclearFuelRod", "PlutoniumFuelRod", "FicsoniumFuelRod", "CrystalShard"}
PHASE5 = {"SpaceElevatorPart_9": 250, "SpaceElevatorPart_10": 250, "SpaceElevatorPart_12": 64, "SpaceElevatorPart_11": 50}
SINK = {"id": "Phase5Sink", "name": "Phase 5 (250 : 250 : 64 : 50 /min)", "m": "Phase5", "kind": "sink",
        "ins": [[k, float(v)] for k, v in PHASE5.items()], "outs": [], "alt": 0}
RAW = sorted({k for r in RECIPES if r["kind"] in EXTRACT for k, _ in r["outs"]})
RAW_STEP = 30


def frac(x):
    return Fraction(x).limit_denominator(1000)


def pile_items():
    acc = set(EXPENDABLE)
    acc |= {k for b in BLD.values() if not b.get("xmas") for k, _ in b["cost"]}
    acc -= set(RAW) | {"SingularityCell", "AlienPowerFuel"}
    return {k for k in acc if not ITEMS.get(k, {}).get("f")}


def pool(kind, raw_ok, extra_ids=(), drop_ids=(), p5=False, generators=False):
    """Recipes reachable from raw_ok; kind 'standard' (no alternates) or 'all'."""
    cand = []
    for r in RECIPES:
        if r.get("xmas"):
            continue
        ok = (r["kind"] == "machine" and not (r["m"] == "Packager" and r["id"] not in KEEP_PACKAGER)
              and not r["id"].startswith("Unpackage")) or r["id"] in KEEP_BURN or r["id"] in EXTRA \
            or (generators and r["kind"] == "burn")
        if not ok or r["id"] in drop_ids:
            continue
        if kind == "standard" and r.get("alt") and r["id"] not in MAM_NOT_ALT and r["id"] not in extra_ids:
            continue
        if not p5 and any(k in PHASE5 for k, _ in r["outs"]):
            continue
        cand.append(r)
    have = set(raw_ok) | {"Power"}
    changed = True
    while changed:
        changed = False
        for r in cand:
            if all(k in have for k, _ in r["ins"]):
                for k, _ in r["outs"]:
                    if k not in have:
                        have.add(k); changed = True
    recs = [r for r in cand if all(k in have for k, _ in r["ins"])]
    if p5 and all(k in have for k in PHASE5):
        recs.append(SINK)
    return recs


def model(recs, open_usable=False):
    """Integer rows: equations, inequalities (>= 0), congruences (== 0 mod m).
    open_usable: usable items (and power) are free, like inputs and outputs that
    cross block boundaries; only net-0 items and raw draws constrain."""
    pile = pile_items()
    nets = []
    for r in recs:
        d = {}
        power = -r.get("p", 0) if open_usable and r.get("kind") != "sink" else 0
        for k, v in r["ins"]:
            if k != "Power": d[k] = d.get(k, 0) - frac(v)
        for k, v in r["outs"]:
            if k != "Power": d[k] = d.get(k, 0) + frac(v)
        if power: d["Power"] = frac(power)   # MW, + = produced (machines draw, generators make)
        nets.append(d)
    items = sorted({k for d in nets for k in d})
    M = len(recs)
    eqs, ineqs, congs, cls = [], [], [], {}
    for k in items:
        col = [d.get(k, Fraction(0)) for d in nets]
        L = 1
        for c in col: L = L * c.denominator // math.gcd(L, c.denominator)
        row = [int(c * L) for c in col]
        if k in RAW:
            cls[k] = "raw"
            ineqs.append([-x for x in row])
            congs.append(row + [RAW_STEP * L])
        elif k == "Power":
            cls[k] = "free"
        elif k in pile:
            cls[k] = "free" if open_usable else "pile"
            if not open_usable:
                ineqs.append(row)
        else:
            cls[k] = "balance"
            eqs.append(row)
    for j in range(M):
        e = [0] * M; e[j] = 1; ineqs.append(e)
    return items, nets, cls, eqs, ineqs, congs


def describe(recs, items, cls, eqs):
    import numpy as np
    rank = np.linalg.matrix_rank(np.array(eqs, dtype=float)) if eqs else 0
    return {"recipes": len(recs), "items": len(items), "balance": sum(v == "balance" for v in cls.values()),
            "pile": sum(v in ("pile", "free") for v in cls.values()), "raw": sum(v == "raw" for v in cls.values()),
            "dim": len(recs) - int(rank)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", default="standard", choices=["standard", "all"])
    ap.add_argument("--raw", default=",".join(RAW), help="allowed raw resources (comma separated)")
    ap.add_argument("--add", default="", help="extra recipe ids (e.g. alternates)")
    ap.add_argument("--drop", default="", help="recipe ids to leave out")
    ap.add_argument("--p5", action="store_true", help="include the Phase 5 recipes and the Phase 5 stand-in")
    ap.add_argument("--name", default=None)
    ap.add_argument("--dry", action="store_true", help="only describe the pool")
    ap.add_argument("--rays", action="store_true", help="only the extreme rays (elementary modes)")
    ap.add_argument("--dual", action="store_true", help="Normaliz's dual algorithm (cost grows with the answer)")
    ap.add_argument("--product", default="", help="only blocks whose sole usable output is this item (a face of the cone)")
    ap.add_argument("--open", action="store_true",
                    help="usable items and power are free (inputs or outputs across blocks); all generators included")
    ap.add_argument("--no-step", action="store_true", help="drop the multiples-of-30 rule (for comparison)")
    a = ap.parse_args()
    raw_ok = [x for x in a.raw.split(",") if x]
    recs = pool(a.pool, raw_ok, [x for x in a.add.split(",") if x], [x for x in a.drop.split(",") if x], a.p5,
                generators=a.open)
    items, nets, cls, eqs, ineqs, congs = model(recs, open_usable=a.open)
    if a.product:
        # every other usable item nets exactly 0: move its inequality to the equations
        keep = []
        for k in items:
            if cls[k] == "pile" and k != a.product:
                col = [nets[j].get(k, Fraction(0)) for j in range(len(recs))]
                L = 1
                for c in col: L = L * c.denominator // math.gcd(L, c.denominator)
                row = [int(c * L) for c in col]
                eqs.append(row)
                if row in ineqs: ineqs.remove(row)
    info = describe(recs, items, cls, eqs)
    print(json.dumps(info))
    if a.dry:
        for r in recs: print("  ", r["id"], "|", r["name"])
        return 0
    import PyNormaliz as N
    t0 = time.time()
    kw = {"inequalities": ineqs}
    if not a.no_step: kw["congruences"] = congs
    if eqs: kw["equations"] = eqs
    C = N.Cone(**kw)
    rays = C.ExtremeRays()
    t1 = time.time()
    print("extreme rays (elementary modes):", len(rays), "in %.1f s" % (t1 - t0), flush=True)
    if a.dual and not a.rays:
        C.Compute("HilbertBasis", "DualMode")
    hb = [] if a.rays else C.HilbertBasis()
    t2 = time.time()
    if not a.rays:
        print("Hilbert basis (blocks):", len(hb), "in %.1f s" % (t2 - t1), flush=True)

    def block(v):
        n = {recs[j]["id"]: int(x) for j, x in enumerate(v) if x}
        net = {}
        for j, x in enumerate(v):
            if x:
                for k, c in nets[j].items(): net[k] = net.get(k, 0) + c * int(x)
        return {"n": n, "machines": int(sum(v)), "net": {k: float(c) for k, c in net.items() if c}}

    out = {"open": a.open, "pool": a.pool, "raw": raw_ok, "add": a.add, "drop": a.drop, "p5": a.p5, "info": info,
           "recipes": [{"id": r["id"], "name": r["name"], "m": r["m"]} for r in recs],
           "classes": cls, "seconds": {"rays": round(t1 - t0, 2), "hilbert": round(t2 - t1, 2)},
           "rays": sorted((block(v) for v in rays), key=lambda b: b["machines"]),
           "blocks": sorted((block(v) for v in hb), key=lambda b: b["machines"])}
    name = a.name or "pool"
    d = ROOT / "data" / "blocks"
    d.mkdir(exist_ok=True)
    (d / f"{name}.json").write_text(json.dumps(out, indent=0))
    print("wrote", d / f"{name}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
