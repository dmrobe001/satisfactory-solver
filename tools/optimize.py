#!/usr/bin/env python3
"""Fastest self-building factory for Project Assembly Phase 5.

Finds recipe clocks that make the whole bill of materials (BOM) in the least
time T.  The BOM is
  * every building the factory needs (its machines, extractors and generators,
    plus the support buildings the production sheet bills per machine, lane
    and item type),
  * a fixed list of extra buildings and equipment (FIXED_BUILDINGS, EQUIPMENT),
  * the Phase 5 Space Elevator parts, made in exact proportion.

Model (all rates per minute; see README "Optimizer" for the reasoning)
  x[r]   effective clock of production recipe r, in machines at 100 %
         (clocks are capped at 100 %, so machines n[r] >= x[r])
  u[s]   extraction sources: Miner Mk.3 / Oil Extractor / well pressurizer at
         250 % on the 1.2 resource nodes, water extractors (any number) and
         geothermal generators on geysers
  lam    1 / T
  Each item k has net(k) = made - used:
    BOM items           net(k) >= lam * BOM(k)
    Phase 5 parts       net(k)  = mu * P5(k), mu >= lam  (exact proportions)
    raw resources       net(k) >= 0   (a miner that is not drained backs up)
    everything else     net(k)  = 0
    power (MW)          net >= 0; machines draw their 100 % power whatever the clock
  BOM(k) = b0(k) + sum_j c[k, j] v[j] is linear in the machine counts, so for a
  fixed lam the problem is a linear program; lam is found by bisection.

Steps
  1. continuous LP (bisection on lam), iterated so that the per-item-type
     buildings and the set of BOM items match the solution;
  2. pruning: drop recipes that make under PRUNE of every product they make,
     and solve again, until nothing is dropped;
  3. integer stage: machine counts are fixed (ceil of x), each machine's clock
     is a whole number of 0.0001 % steps, every non-BOM item balances exactly
     (an exact integer lattice), and a mixed-integer program maximises lam.

Usage: python3 tools/optimize.py [--prune 0.05] [--out data/optimized_plan.json]
Needs numpy and highspy (pip install numpy highspy).
"""
import argparse, json, math, sys, time
from fractions import Fraction
from pathlib import Path

import numpy as np
import highspy

ROOT = Path(__file__).resolve().parent.parent
GAME = json.loads((ROOT / "data" / "game.json").read_text())
R_ALL, ITEMS, BLD = GAME["recipes"], GAME["items"], GAME["buildings"]
PE = 1.321929  # power exponent for overclocking

# ---------------------------------------------------------------- inputs ----
FIXED_BUILDINGS = {
    "CeilingLight": 1000, "FloodlightWall": 1000, "BlueprintDesigner_MK3": 30,
    "StandaloneWidgetSign_SmallVeryWide": 1000, "StandaloneWidgetSign_Square": 1000,
    "RailroadBlockSignal": 200, "ResourceSink": 200, "ResourceSinkShop": 1, "CatwalkCross": 2000,
    "DroneTransport": 100, "DroneStation": 200, "Locomotive": 100, "FreightWagon": 500,
    "TrainDockingStation": 300, "StandaloneWidgetSign_Huge": 100, "RadarTower": 200,
    "Elevator": 30, "ElevatorFloorStop": 150, "Portal": 1, "PortalSatellite": 200,
}
EQUIPMENT = {
    "SpikedRebar": 300, "Rebar_Stunshot": 300, "Rebar_Spreadshot": 300, "Rebar_Explosive": 3000,
    "CartridgeStandard": 1000, "CartridgeSmartProjectile": 2000, "CartridgeChaos": 2000,
    "NobeliskExplosive": 300, "NobeliskCluster": 1000, "NobeliskGas": 100, "NobeliskShockwave": 100,
    "NobeliskNuke": 500, "Filter": 400, "HazmatFilter": 200, "Fuel": 100, "TurboFuel": 1000,
    "PackagedRocketFuel": 1000, "PackagedIonizedFuel": 1000, "Battery": 1000,
}
# Phase 5: Nuclear Pasta, Biochemical Sculptor, AI Expansion Server, Ballistic Warp Drive
PHASE5 = {"SpaceElevatorPart_9": 1000, "SpaceElevatorPart_10": 1000,
          "SpaceElevatorPart_11": 256, "SpaceElevatorPart_12": 200}

# Production-sheet rules (src/buildings.js DEFAULT_RULES), with the per-item-type
# rule changed to 5 industrial storage containers and 2 smart splitters.
RULES = {
    "machines": {"PipeHyper": 1, "PowerLine": 2, "PowerPoleMk1": 0.5, "PowerTower": 0.05,
                 "Foundation_8x1_01": 2, "Foundation_Metal_8x1": 2, "Foundation_Asphalt_8x1": 2,
                 "Foundation_ConcretePolished_8x1": 2, "Wall_8x4_01": 2, "Wall_8x4_02": 2,
                 "Wall_Concrete_8x4": 2, "Roof_Orange_01": 1, "Roof_A_01": 1, "Roof_Tar_01": 1,
                 "Roof_Window_01": 1, "Ladder": 1},
    "belts": {"ConveyorPole": 0.04},
    "inLanes": {"ConveyorAttachmentSplitter": 1},
    "outLanes": {"ConveyorAttachmentMerger": 1},
    "fluidLanes": {"PipelineJunction_T": 1},
    "solidTypes": {"StorageContainerMk2": 5, "ConveyorAttachmentSplitterSmart": 2},
    "fluidTypes": {"IndustrialTank": 1},
    "depotItems": {"CentralStorage": 1},
    "pipe1": {"PipelinePump": 0.01},
    "pipe2": {"PipelinePumpMk2": 0.01},
}
BELTS = ["ConveyorBeltMk%d" % k for k in range(1, 7)]
LANE = {**{b: 1 for b in BELTS}, "Pipeline": 1, "PipelineMK2": 1, "RailroadTrack": 1}
EXPENDABLE = ["CartridgeStandard", "CartridgeSmartProjectile", "CartridgeChaos", "SpikedRebar",
              "Rebar_Stunshot", "Rebar_Spreadshot", "Rebar_Explosive", "NobeliskExplosive", "NobeliskGas",
              "NobeliskShockwave", "NobeliskCluster", "NobeliskNuke", "Filter", "HazmatFilter", "Biofuel",
              "Fuel", "TurboFuel", "PackagedBiofuel", "PackagedRocketFuel", "PackagedIonizedFuel", "Battery"]

# Version 1.2 resource nodes (satisfactory.wiki.gg "Resource node", "Resource Well",
# "Geothermal Generator"): impure, normal, pure.
NODES = {"OreIron": (39, 42, 46), "OreGold": (0, 9, 8), "OreCopper": (13, 29, 13), "Stone": (15, 50, 29),
         "Coal": (15, 31, 16), "RawQuartz": (3, 7, 7), "Sulfur": (6, 5, 5), "OreUranium": (3, 2, 0),
         "OreBauxite": (5, 6, 6), "SAM": (10, 6, 3)}
OIL_NODES = (10, 12, 8)
# Wells: (number of wells, satellites impure/normal/pure).  The wiki gives totals only, so
# each well is modelled as an average well (an approximation, see README).
WELLS = {"NitrogenGas": (6, (2, 7, 36)), "LiquidOil": (3, (8, 6, 4))}
GEYSERS = (9, 13, 9)
GEO_MW = (100, 200, 400)  # average output
OC = 2.5                  # extraction clock
PUR = ("Impure", "Normal", "Pure")

# Recipes left out by choice (a smaller factory with fewer recipes; see README):
# standard Aluminum Ingot and Caterium Wire.
EXCLUDE = ["IngotAluminum", "Alternate_Wire_2"]

ITEM_KEYS = list(ITEMS)
MAKEABLE = set()  # items reachable without hand gathering (filled in main)
FLUID = {k for k, v in ITEMS.items() if v["f"]}


def frac(x):
    f = Fraction(x).limit_denominator(1000)
    if abs(float(f) - x) > 1e-6 * max(1, abs(x)):
        raise ValueError("no small fraction for %r" % x)
    return f


# ---------------------------------------------------------- the variables ----
class Var:
    """A column: a production recipe or an extraction source.  rates: item -> net
    per unit (exact Fraction); per unit = one machine at 100 % (recipes) or one
    source at its fixed clock.  power: MW per unit (+ = draw).  build: building
    key -> count per unit; s, f, inl, outl: lanes per unit."""
    def __init__(self, vid, kind, rates, power, build, s, f, inl, outl, ub=None, rec=None, gen=0.0):
        self.id, self.kind, self.rates, self.power = vid, kind, rates, power
        self.build, self.s, self.f, self.inl, self.outl, self.ub, self.rec = build, s, f, inl, outl, ub, rec
        self.gen = gen  # MW generated per unit (scales with clock)
        self.machines = sum(build.values())


def lanes_of(rec):
    s = f = inl = outl = 0
    for k, _ in rec["ins"]:
        if k == "Power":
            continue
        if k in FLUID: f += 1
        else: s += 1; inl += 1
    for k, _ in rec["outs"]:
        if k == "Power":
            continue
        if k in FLUID: f += 1
        else: s += 1; outl += 1
    return s, f, inl, outl


def scope():
    """Production recipes reachable from mined/extracted resources only."""
    raw = set()
    for r in R_ALL:
        if r["kind"] in ("miner", "extractor", "well"):
            raw.update(k for k, _ in r["outs"])
    have = set(raw) | {"Power"}
    cand = [r for r in R_ALL if r["kind"] in ("machine", "burn") and not r.get("xmas")]
    changed = True
    while changed:
        changed = False
        for r in cand:
            if all(k in have for k, _ in r["ins"]):
                for k, _ in r["outs"]:
                    if k not in have:
                        have.add(k); changed = True
    recs = [r for r in cand if all(k in have for k, _ in r["ins"])]
    return recs, raw, have


def make_vars(recs):
    V = []
    for r in recs:
        rates = {}
        for k, v in r["ins"]:
            rates[k] = rates.get(k, 0) - frac(v)
        gen = 0.0
        for k, v in r["outs"]:
            if k == "Power":
                gen = v
                continue
            rates[k] = rates.get(k, 0) + frac(v)
        rates = {k: v for k, v in rates.items() if v != 0}
        s, f, inl, outl = lanes_of(r)
        V.append(Var(r["id"], "recipe", rates, max(r["p"], 0.0), {r["m"]: 1}, s, f, inl, outl, rec=r, gen=gen))
    by_id = {r["id"]: r for r in R_ALL}
    for ore, cnt in NODES.items():
        for i, pu in enumerate(PUR):
            if not cnt[i]:
                continue
            r = by_id["Miner3_%s_%s" % (pu, ore)]
            V.append(Var(r["id"], "miner", {ore: frac(r["outs"][0][1]) * Fraction(5, 2)}, r["p"] * OC ** PE,
                         {"MinerMk3": 1}, 1, 0, 0, 1, ub=cnt[i], rec=r))
    for i, pu in enumerate(PUR):
        r = by_id["OilExtractor_" + pu]
        V.append(Var(r["id"], "oil", {"LiquidOil": frac(r["outs"][0][1]) * Fraction(5, 2)}, r["p"] * OC ** PE,
                     {"OilPump": 1}, 0, 1, 0, 0, ub=OIL_NODES[i], rec=r))
    pres = by_id["WellPressurizer"]
    for fl, (nw, sats) in WELLS.items():
        tot = sum(Fraction(c * q) for c, q in zip(sats, (30, 60, 120))) * Fraction(5, 2)
        nsat = Fraction(sum(sats), nw)
        V.append(Var("Well_" + fl, "well", {fl: tot / nw}, pres["p"] * OC ** PE,
                     {"FrackingSmasher": 1, "FrackingExtractor": nsat}, 0, nsat, 0, 0, ub=nw))
    w = by_id["WaterExtractor"]
    V.append(Var(w["id"], "water", {"Water": frac(w["outs"][0][1])}, w["p"], {"WaterPump": 1}, 0, 1, 0, 0, rec=w))
    for i, pu in enumerate(PUR):
        V.append(Var("Geothermal_" + pu, "geo", {}, 0.0, {"GeneratorGeoThermal": 1}, 0, 0, 0, 0,
                     ub=GEYSERS[i], gen=GEO_MW[i]))
    return V


# ------------------------------------------------------- bill of materials ----
def unit_buildings(v):
    """Buildings per unit of v, unrounded: its own machines plus per-machine and per-lane rules."""
    b = dict(v.build)
    m, s, f = v.machines, v.s, v.f

    def add(k, q):
        if q and k in BLD:
            b[k] = b.get(k, 0) + q
    for k, q in RULES["machines"].items(): add(k, q * m)
    belts = 0
    for k in BELTS: add(k, s * LANE[k]); belts += s * LANE[k]
    add("Pipeline", f * LANE["Pipeline"]); add("PipelineMK2", f * LANE["PipelineMK2"])
    add("RailroadTrack", (s + f) * LANE["RailroadTrack"])
    for k, q in RULES["belts"].items(): add(k, q * belts)
    for k, q in RULES["inLanes"].items(): add(k, q * v.inl)
    for k, q in RULES["outLanes"].items(): add(k, q * v.outl)
    for k, q in RULES["fluidLanes"].items(): add(k, q * f)
    for k, q in RULES["pipe1"].items(): add(k, q * f * LANE["Pipeline"])
    for k, q in RULES["pipe2"].items(): add(k, q * f * LANE["PipelineMK2"])
    return b


def cost_vec(bmap):
    out = {}
    for k, q in bmap.items():
        for it, c in BLD[k]["cost"]:
            out[it] = out.get(it, 0.0) + float(q) * c
    return out


def type_counts(active_vars, bom_items):
    seen = set()
    for v in active_vars:
        if v.rec is not None:
            seen.update(k for k, _ in v.rec["ins"] + v.rec["outs"])
        else:
            seen.update(v.rates)
    seen.discard("Power")
    solid = sum(1 for k in seen if k not in FLUID)
    fluid = sum(1 for k in seen if k in FLUID)
    return solid, fluid, len(bom_items)


def fixed_buildings(solid, fluid, depot):
    b = dict(FIXED_BUILDINGS)
    for base, n in (("solidTypes", solid), ("fluidTypes", fluid), ("depotItems", depot)):
        for k, q in RULES[base].items():
            b[k] = b.get(k, 0) + q * n
    return b


def bom_exact(counts, V, extra_items=True):
    """The production sheet's bill of materials (src/buildings.js compute) for whole
    machine counts.  counts: var index -> units (whole machines or sources; wells
    count pressurizers).  Returns (buildings, bom item -> amount)."""
    comp = {}
    machines = solid = fluid = inl = outl = 0
    seen = set()
    for j, n in counts.items():
        if n <= 0:
            continue
        v = V[j]
        for k, q in v.build.items():
            comp[k] = comp.get(k, 0) + q * n
        # pressurizer + its extractors are machines; lanes per unit
        machines += v.machines * n
        solid += v.s * n; fluid += v.f * n; inl += v.inl * n; outl += v.outl * n
        if v.rec is not None:
            seen.update(k for k, _ in v.rec["ins"] + v.rec["outs"])
        else:
            seen.update(v.rates)
    seen.discard("Power")
    comp = {k: math.ceil(q - 1e-9) for k, q in comp.items()}  # average wells -> whole extractors

    def add(k, q):
        if q > 0 and k in BLD:
            comp[k] = comp.get(k, 0) + math.ceil(q - 1e-9)
    for k in BELTS: add(k, solid * LANE[k])
    add("Pipeline", fluid * LANE["Pipeline"]); add("PipelineMK2", fluid * LANE["PipelineMK2"])
    add("RailroadTrack", (solid + fluid) * LANE["RailroadTrack"])
    ntypes_s = sum(1 for k in seen if k not in FLUID)
    ntypes_f = sum(1 for k in seen if k in FLUID)
    basis = {"machines": machines, "inLanes": inl, "outLanes": outl, "fluidLanes": fluid,
             "solidTypes": ntypes_s, "fluidTypes": ntypes_f,
             "belts": sum(comp.get(k, 0) for k in BELTS), "pipe1": comp.get("Pipeline", 0),
             "pipe2": comp.get("PipelineMK2", 0)}
    for base in ("machines", "inLanes", "outLanes", "fluidLanes", "solidTypes", "fluidTypes", "belts", "pipe1", "pipe2"):
        for k, q in RULES[base].items(): add(k, basis[base] * q)
    made = {k for j, n in counts.items() if n > 0 for k, q in V[j].rates.items() if q > 0}

    def bom_items(extra):
        has = set()
        for k in set(comp) | set(FIXED_BUILDINGS) | set(extra):
            if comp.get(k, 0) + FIXED_BUILDINGS.get(k, 0) + extra.get(k, 0):
                has.update(it for it, _ in BLD[k]["cost"])
        has.update(k for k in EXPENDABLE if k in made)
        if extra_items:
            has.update(EQUIPMENT)
        return has
    depot = len(bom_items({}))
    dc = {}
    for _ in range(2):
        dc = {k: math.ceil(depot * q - 1e-9) for k, q in RULES["depotItems"].items()}
        depot = len(bom_items(dc))
    basis["depotItems"] = depot
    for k, q in RULES["depotItems"].items(): add(k, depot * q)
    total = {k: comp.get(k, 0) + FIXED_BUILDINGS.get(k, 0) for k in set(comp) | set(FIXED_BUILDINGS)}
    total = {k: t for k, t in total.items() if t}
    bom = {}
    for k, t in total.items():
        for it, c in BLD[k]["cost"]:
            bom[it] = bom.get(it, 0) + t * c
    if extra_items:
        for k, q in EQUIPMENT.items():
            bom[k] = bom.get(k, 0) + q
    return total, bom, basis


# ------------------------------------------------------------- LP helpers ----
def solve(nv, cost, rows, lb, ub, integer=None, time_limit=None, sense_max=False, start=None):
    """rows: list of (dict col->coef, lo, hi).  Returns (status, x, obj)."""
    h = highspy.Highs()
    h.setOptionValue("output_flag", False)
    if time_limit:
        h.setOptionValue("time_limit", float(time_limit))
    inf = highspy.kHighsInf
    lp = highspy.HighsLp()
    lp.num_col_ = nv
    lp.num_row_ = len(rows)
    lp.col_cost_ = np.array(cost, dtype=float)
    lp.col_lower_ = np.array([(-inf if v is None else v) for v in lb], dtype=float)
    lp.col_upper_ = np.array([(inf if v is None else v) for v in ub], dtype=float)
    lp.row_lower_ = np.array([(-inf if r[1] is None else r[1]) for r in rows], dtype=float)
    lp.row_upper_ = np.array([(inf if r[2] is None else r[2]) for r in rows], dtype=float)
    cols = [[] for _ in range(nv)]
    for i, (d, _, _) in enumerate(rows):
        for j, a in d.items():
            if a:
                cols[j].append((i, a))
    start, idx, val = [0], [], []
    for c in cols:
        for i, a in c:
            idx.append(i); val.append(a)
        start.append(len(idx))
    lp.a_matrix_.format_ = highspy.MatrixFormat.kColwise
    lp.a_matrix_.start_ = np.array(start, dtype=np.int32)
    lp.a_matrix_.index_ = np.array(idx, dtype=np.int32)
    lp.a_matrix_.value_ = np.array(val, dtype=float)
    if sense_max:
        lp.sense_ = highspy.ObjSense.kMaximize
    if integer:
        lp.integrality_ = [highspy.HighsVarType.kInteger if integer[j] else highspy.HighsVarType.kContinuous
                           for j in range(nv)]
    h.passModel(lp)
    if start is not None:
        hs = highspy.HighsSolution()
        hs.col_value = list(map(float, start))
        hs.value_valid = True
        h.setSolution(hs)
    h.run()
    st = h.getModelStatus()
    ok = st == highspy.HighsModelStatus.kOptimal
    sol = h.getSolution()
    x = list(sol.col_value) if sol.value_valid else None
    if not ok and integer and x is not None and h.getInfo().mip_gap < 1e9:
        ok = True  # time limit with a feasible incumbent
    return ok, x, (h.getInfo().objective_function_value if x is not None else None)


# ------------------------------------------------------- continuous stage ----
class Model:
    def __init__(self, V, raw):
        self.V, self.raw = V, raw
        self.items = sorted({k for v in V for k in v.rates})
        self.ub = [v.ub for v in V]
        self.unitB = [cost_vec(unit_buildings(v)) for v in V]
        self.allowed = [True] * len(V)

    def lp(self, lam, b0, usable, objective="machines"):
        V = self.V
        nv = len(V) + 1  # + mu
        MU = len(V)
        rows = []
        for k in self.items:
            d = {}
            for j, v in enumerate(V):
                if not self.allowed[j]:
                    continue
                a = float(v.rates.get(k, 0))
                if k in usable:
                    a -= lam * self.unitB[j].get(k, 0.0)
                if a:
                    d[j] = a
            if k in PHASE5:
                d[MU] = -PHASE5[k]
                rows.append((d, 0.0, 0.0))
            elif k in usable:
                rows.append((d, lam * b0.get(k, 0.0), None))
            elif k in self.raw:
                rows.append((d, 0.0, None))
            else:
                rows.append((d, 0.0, 0.0))
        # usable items no recipe touches still need lam * b0 <= 0
        for k in usable:
            if k not in self.items and k not in PHASE5 and b0.get(k, 0) > 0:
                return None
        pw = {j: v.gen - v.power for j, v in enumerate(V) if self.allowed[j] and (v.gen or v.power)}
        rows.append((pw, 0.0, None))
        lb = [0.0] * nv
        ub = [(u if self.allowed[j] else 0.0) for j, u in enumerate(self.ub)] + [None]
        lb[MU] = lam
        cost = [v.machines if objective == "machines" else 0.0 for v in V] + [0.0]
        ok, x, _ = solve(nv, cost, rows, lb, ub)
        return x if ok else None

    def best(self, b0, usable, tol=1e-6):
        lo, hi = 0.0, 1e-4
        while self.lp(hi, b0, usable) is not None:
            lo, hi = hi, hi * 2
            if hi > 10:
                raise RuntimeError("unbounded")
        while hi - lo > tol * hi:
            mid = (lo + hi) / 2
            if self.lp(mid, b0, usable) is not None: lo = mid
            else: hi = mid
        return lo, self.lp(lo, b0, usable)


def continuous(model, prune, log, max_rounds=30):
    V = model.V
    usable = set(EQUIPMENT) | set(PHASE5) | {it for k in FIXED_BUILDINGS for it, _ in BLD[k]["cost"]}
    usable |= {it for c in model.unitB for it in c}  # first pass: anything a building could use
    solid, fluid, depot = 60, 10, 60
    x = None
    for rnd in range(max_rounds):
        b0 = cost_vec(fixed_buildings(solid, fluid, depot))
        for k, q in EQUIPMENT.items(): b0[k] = b0.get(k, 0) + q
        b0 = {k: q for k, q in b0.items() if k in MAKEABLE}  # hand-gathered parts are not timed
        lam, x = model.best(b0, usable)
        if x is None:
            raise RuntimeError("infeasible")
        act = [j for j, v in enumerate(V) if x[j] > 1e-9]
        # BOM items of this solution
        bom = dict(b0)
        for j in act:
            for k, q in model.unitB[j].items(): bom[k] = bom.get(k, 0) + q * x[j]
        new_usable = {k for k, q in bom.items() if q > 1e-9} | set(PHASE5)
        ns, nf, nd = type_counts([V[j] for j in act], [k for k in new_usable if k not in PHASE5])
        # prune: recipes making under `prune` of every product they make
        dropped = []
        if prune:
            made = {}
            for j in act:
                for k, q in V[j].rates.items():
                    if q > 0: made[k] = made.get(k, 0) + float(q) * x[j]
            for j in act:
                v = V[j]
                if v.kind != "recipe":
                    continue
                share = [float(q) * x[j] / made[k] for k, q in v.rates.items() if q > 0 and made[k] > 0]
                if v.gen:
                    share.append(1.0 if not share else max(share))  # generators judged by power below
                if share and max(share) < prune:
                    dropped.append(j)
            pgen = sum(V[j].gen * x[j] for j in act)
            for j in act:
                v = V[j]
                if v.gen and v.kind == "recipe" and v.gen * x[j] < prune * pgen and j not in dropped:
                    dropped.append(j)
        log("round %d: T = %.1f min (%.2f h), %d recipes + sources active, %d solid / %d fluid types, %d BOM items%s"
            % (rnd + 1, 1 / lam, 1 / lam / 60, len(act), ns, nf, nd,
               (", pruning " + ", ".join(V[j].id for j in dropped)) if dropped else ""))
        for j in dropped:
            model.allowed[j] = False
        stable = (ns, nf, nd) == (solid, fluid, depot) and new_usable == usable
        solid, fluid, depot, usable = ns, nf, nd, new_usable
        if stable and not dropped:
            break
    # everything never used is out from now on
    for j in range(len(V)):
        if x[j] <= 1e-9:
            model.allowed[j] = False
    return lam, x, usable



# ------------------------------------------------- whole machine counts ----
def whole_counts(model, x, usable, lam_lp, log, time_limit=60):
    """Mixed-integer program over the recipes the continuous stage kept: whole
    machines n (x <= n, power and buildings billed per machine) and whole
    sources, for a fixed lam; lam is bisected down from the continuous optimum."""
    V = model.V
    act = [j for j in range(len(V)) if model.allowed[j] and x[j] > 1e-9]
    recs = [j for j in act if V[j].kind == "recipe"]
    srcs = [j for j in act if V[j].kind != "recipe"]
    ci = {j: i for i, j in enumerate(act)}       # x / count columns
    ni = {j: len(act) + i for i, j in enumerate(recs)}  # machine columns
    MU = len(act) + len(recs)
    nv = MU + 1
    ns, nf, nd = type_counts([V[j] for j in act], [k for k in usable if k not in PHASE5])
    b0 = cost_vec(fixed_buildings(ns, nf, nd))
    for k, q in EQUIPMENT.items(): b0[k] = b0.get(k, 0) + q
    b0 = {k: q for k, q in b0.items() if k in MAKEABLE}
    items = sorted({k for j in act for k in V[j].rates})
    unitB = model.unitB

    def run(lam):
        rows = []
        for k in items:
            d = {}
            for j in act:
                a = float(V[j].rates.get(k, 0))
                if a: d[ci[j]] = a
                if k in usable:
                    b = unitB[j].get(k, 0.0)
                    if b:
                        col = ni[j] if j in ni else ci[j]
                        d[col] = d.get(col, 0) - lam * b
            if k in PHASE5:
                d[MU] = -PHASE5[k]; rows.append((d, 0.0, 0.0))
            elif k in usable:
                rows.append((d, lam * b0.get(k, 0.0), None))
            elif k in model.raw:
                rows.append((d, 0.0, None))
            else:
                rows.append((d, 0.0, 0.0))
        pw = {}
        for j in act:
            if V[j].gen: pw[ci[j]] = V[j].gen
            if V[j].power:
                col = ni[j] if j in ni else ci[j]
                pw[col] = pw.get(col, 0) - V[j].power
        rows.append((pw, 0.0, None))
        for j in recs:  # x <= n
            rows.append(({ci[j]: 1.0, ni[j]: -1.0}, None, 0.0))
        lb = [0.0] * nv; lb[MU] = lam
        ub = [None] * nv
        integ = [0] * nv
        for j in srcs:
            ub[ci[j]] = V[j].ub
            integ[ci[j]] = 1
        for j in recs:
            integ[ni[j]] = 1
        cost = [0.0] * nv
        for j in recs: cost[ni[j]] = V[j].machines
        for j in srcs: cost[ci[j]] = V[j].machines
        ok, sol, _ = solve(nv, cost, rows, lb, ub, integer=integ, time_limit=time_limit)
        return sol if ok else None
    lo, hi = 0.0, lam_lp
    best = None
    sol = run(lam_lp * 0.97)
    if sol is not None:
        lo, best = lam_lp * 0.97, sol
    else:
        hi = lam_lp * 0.97
    for _ in range(7):
        mid = (lo + hi) / 2 if lo else hi * 0.9
        sol = run(mid)
        if sol is not None: lo, best = mid, sol
        else: hi = mid
        if lo and hi - lo < 0.002 * hi:
            break
    if best is None:
        raise RuntimeError("no whole-machine plan found")
    xx = [0.0] * len(V)
    n, cnt = {}, {}
    for j in act:
        xx[j] = best[ci[j]]
        if j in ni:
            nn = int(round(best[ni[j]]))
            if nn > 0 and xx[j] > 1e-9: n[j] = nn
        else:
            c = int(round(best[ci[j]]))
            if c > 0: cnt[j] = c
    log("whole machines: T = %.1f min at most (continuous %.1f), %d machines, %d sources"
        % (1 / lo, 1 / lam_lp, sum(n.values()), sum(cnt.values())))
    return xx, n, cnt

# --------------------------------------------------------- integer stage ----
def int_kernel(M, m):
    """Basis (list of int vectors of length m) of {q in Z^m : M q = 0}; M rows are dicts."""
    basis = [[1 if i == j else 0 for i in range(m)] for j in range(m)]
    for row in M:
        vals = [sum(c * b[i] for i, c in row.items()) for b in basis]
        nz = [j for j, a in enumerate(vals) if a]
        while len(nz) > 1:
            nz.sort(key=lambda j: abs(vals[j]))
            p = nz[0]
            for j in nz[1:]:
                t = vals[j] // vals[p]
                if t:
                    bj, bp = basis[j], basis[p]
                    basis[j] = [a - t * b for a, b in zip(bj, bp)]
                    vals[j] -= t * vals[p]
            nz = [j for j in nz if vals[j]]
        if nz:
            basis.pop(nz[0])
    return lll(basis)


def lll(B, delta=0.99):
    """LLL reduction.  B holds exact Python ints; the Gram-Schmidt data is recomputed
    in floating point (numpy QR) after each change, which is ample for these sizes."""
    B = [list(b) for b in B if any(b)]
    n = len(B)
    if n <= 1:
        return B

    def gso():
        A = np.array([[float(a) for a in b] for b in B]).T
        Q, Rm = np.linalg.qr(A)
        d = np.diag(Rm)
        mu = (Rm / d[:, None]).T  # mu[i][j] = R[j][i] / R[j][j]
        return mu, d * d
    mu, nn = gso()
    k = 1
    it = 0
    while k < n:
        it += 1
        if it > 200000:
            break
        changed = False
        for j in range(k - 1, -1, -1):
            qv = int(round(mu[k][j]))
            if qv:
                B[k] = [a - qv * b for a, b in zip(B[k], B[j])]
                mu[k][:j + 1] -= qv * mu[j][:j + 1]
                changed = True
        if changed:
            mu, nn = gso()
        if nn[k] >= (delta - mu[k][k - 1] ** 2) * nn[k - 1]:
            k += 1
        else:
            B[k], B[k - 1] = B[k - 1], B[k]
            mu, nn = gso()
            k = max(k - 1, 1)
    return B


UNIT = 10 ** 6  # clock steps per 100 % (0.0001 %)
TWO = False     # --two-clocks: a recipe's machines may run at two adjacent clocks
SHORT = 3000    # lattice directions up to this length (0.3 % of a clock) are rounded, not searched


def integer_stage(model, x, n, cnt, log, time_limit=120):
    V = model.V
    recs = sorted(n)
    srcs = sorted(cnt)
    counts = dict(n); counts.update(cnt)
    _, bom, _ = bom_exact(counts, V)
    bom = {k: q for k, q in bom.items() if k in MAKEABLE}
    usable = set(bom) | set(PHASE5)
    raw = model.raw
    items = sorted({k for j in recs for k in V[j].rates} | {k for j in srcs for k in V[j].rates})
    m = len(recs)
    col = {j: i for i, j in enumerate(recs)}

    def lattice_for(n):
        """Integer basis of the clocks q (one per recipe, n[j] machines each) that
        balance every non-BOM item exactly and keep Phase 5 in proportion."""
        eq = []
        for k in items:
            if k in usable or k in raw:
                continue
            d = {}
            for j in recs:
                a = V[j].rates.get(k)
                if a: d[col[j]] = a * (1 if TWO else n[j])
            if d:
                eq.append(d)
        p5 = list(PHASE5)
        for a, b in zip(p5, p5[1:]):  # net_a * P5_b - net_b * P5_a = 0
            d = {}
            for j in recs:
                ca, cb = V[j].rates.get(a, 0), V[j].rates.get(b, 0)
                c = (ca * PHASE5[b] - cb * PHASE5[a]) * (1 if TWO else n[j])
                if c: d[col[j]] = c
            eq.append(d)
        Mint = []
        for d in eq:  # scale each row to integers
            L = 1
            for c in d.values(): L = L * Fraction(c).denominator // math.gcd(L, Fraction(c).denominator)
            Mint.append({i: int(c * L) for i, c in d.items()})
        return int_kernel(Mint, m), len(Mint)

    def longest(K):
        return max(K, key=lambda b: sum(a * a for a in b))

    def bump(n, K, why):
        """One more machine (at a lower clock) on the recipe of the longest lattice
        direction that shortens it most.  Small machine counts along a chain of exact
        ratios can make the only whole-number step longer than a clock's range."""
        v = longest(K)
        cands = sorted((i for i in range(m) if v[i]), key=lambda i: -abs(v[i]))[:6]
        best = None
        for i in cands:
            j = recs[i]
            n2 = dict(n); n2[j] += 1
            K2, _ = lattice_for(n2)
            score = max(abs(a) for a in longest(K2))
            if best is None or score < best[0]:
                best = (score, j, n2, K2)
        log("  %s: one more %s (%d -> %d machines); longest step %d -> %d"
            % (why, V[best[1]].rec["name"], n[best[1]], best[2][best[1]], max(abs(a) for a in v), best[0]))
        return best[2], best[3]

    n = dict(n)
    t0 = time.time()
    K, neq = lattice_for(n)
    for _ in range(0 if TWO else 12):  # with two clocks the lattice does not depend on n
        if max(abs(a) for a in longest(K)) <= UNIT // 20:  # a step of at most 5 % of a clock
            break
        n, K = bump(n, K, "coarse lattice")
    d = len(K)
    log("integer stage: %d recipes, %d exact balances, lattice of dimension %d (%.1f s), largest basis entry %d"
        % (m, neq, d, time.time() - t0, max((abs(a) for b in K for a in b), default=0)))
    def mip(n, K):
        d = len(K)
        # MIP over z (d integers) + lam; q = K^T z
        LAM = d
        nv = d + 1
        rows = []
        for i in range(m):  # 1 <= q_i <= UNIT (two clocks: 1 <= total steps <= n UNIT)
            lo_i, hi_i = (1, n[recs[i]] * UNIT) if TWO else (1, UNIT)
            rows.append(({t: float(K[t][i]) for t in range(d) if K[t][i]}, float(lo_i), float(hi_i)))

        def net_row(k):
            """net(k) in UNIT-scaled y: coefficient per z, plus source constant."""
            dd = {}
            for t in range(d):
                s = sum(V[j].rates.get(k, 0) * (1 if TWO else n[j]) * K[t][col[j]] for j in recs)
                if s: dd[t] = float(s) / UNIT
            const = sum(float(V[j].rates.get(k, 0)) * cnt[j] for j in srcs)
            return dd, const
        for k in items:
            if k in raw:
                dd, c = net_row(k)
                rows.append((dd, -c, None))
            elif k in usable and k not in PHASE5:
                dd, c = net_row(k)
                dd[LAM] = -bom.get(k, 0.0)
                rows.append((dd, -c, None))
        for k in PHASE5:
            dd, c = net_row(k)
            dd[LAM] = -PHASE5[k]
            rows.append((dd, -c, None))
        for k in usable:
            if k not in items and bom.get(k, 0) > 0:
                raise RuntimeError("BOM item %s is not made" % k)
        # power: generation scales with clock, draw is per machine
        dd = {}
        for t in range(d):
            s = sum(V[j].gen * (1 if TWO else n[j]) * K[t][col[j]] for j in recs)
            if s: dd[t] = s / UNIT
        const = sum(V[j].gen * cnt[j] for j in srcs) - sum(V[j].power * n[j] for j in recs) - sum(V[j].power * cnt[j] for j in srcs)
        rows.append((dd, -const, None))
        # start near the continuous solution: least-squares z
        Kf = np.array(K, dtype=float).T  # m x d
        q0 = np.array([x[j] * UNIT if TWO else x[j] / n[j] * UNIT for j in recs])
        z0 = np.linalg.lstsq(Kf, q0, rcond=None)[0]
        cost = [0.0] * d + [1.0]
        lb = [None] * d + [0.0]
        ub = [None] * d + [None]
        # Short lattice directions are solved continuously and rounded afterwards;
        # each row is tightened by the most that rounding can move it (half the sum
        # of its short coefficients), so the rounded point still satisfies it.  Only
        # the long directions are searched as integers.  Full search as a fallback.
        for hybrid in (True, False):
            short = [hybrid and sum(a * a for a in K[t]) <= SHORT ** 2 for t in range(d)]
            tight = []
            for dd, lo, hi in rows:
                delta = 0.5 * sum(abs(a) for t, a in dd.items() if t < d and short[t])
                tight.append((dd, None if lo is None else lo + delta, None if hi is None else hi - delta))
            integ = [0 if short[t] else 1 for t in range(d)] + [0]
            ok, sol, obj = solve(nv, cost, tight, lb, ub, integer=integ, time_limit=time_limit, sense_max=True)
            if ok:
                if not hybrid:
                    return sol
                log("  %d of %d lattice directions rounded, %d searched as integers"
                    % (sum(short), d, d - sum(short)))
                # polish: the rounded point starts a full integer search on the untightened rows
                zr = [round(v) for v in sol[:d]]
                lam_r = sol[d]
                ok2, sol2, obj2 = solve(nv, cost, rows, lb, ub, integer=[1] * d + [0], time_limit=time_limit,
                                        sense_max=True, start=zr + [lam_r])
                if ok2 and sol2[d] > lam_r:
                    log("  polished: T %.2f -> %.2f min" % (1 / lam_r, 1 / sol2[d]))
                    return sol2
                return zr + [lam_r]
        return None

    for attempt in range(6):
        sol = mip(n, K)
        if sol is not None:
            break
        n, K = bump(n, K, "no whole-number point")
        d = len(K)
    else:
        raise RuntimeError("integer stage infeasible")
    z = [int(round(sol[t])) for t in range(d)]
    q = {j: sum(z[t] * K[t][col[j]] for t in range(d)) for j in recs}
    return n, cnt, q, None


# ------------------------------------------------------------- reporting ----
def steps(q, n, j):
    """Clock steps of recipe j summed over its machines."""
    return q[j] if TWO else q[j] * n[j]


def clock_text(q, n, j):
    """Per-machine clock(s) in percent; with two clocks, m machines at a steps and
    the rest at a - 1 (m = total - n (a - 1), a = ceil(total / n))."""
    pct = lambda v: ("%.4f" % (100 * v / UNIT)).rstrip("0").rstrip(".")
    if not TWO:
        return pct(q[j])
    y, nn = q[j], n[j]
    a = -(-y // nn)
    mm = y - nn * (a - 1)
    return pct(a) if mm == nn else "%d x %s + %d x %s" % (mm, pct(a), nn - mm, pct(a - 1))


def evaluate(V, n, cnt, q, raw):
    """Exact nets (Fractions) and the bill of materials for an integer plan."""
    net = {}
    for j in n:
        y = Fraction(steps(q, n, j), UNIT)
        for k, a in V[j].rates.items(): net[k] = net.get(k, 0) + a * y
    for j in cnt:
        for k, a in V[j].rates.items(): net[k] = net.get(k, 0) + a * cnt[j]
    # miners back up: draw only what is used
    counts = dict(n); counts.update(cnt)
    total, bom, basis = bom_exact(counts, V)
    power_gen = sum(V[j].gen * steps(q, n, j) / UNIT for j in n) + sum(V[j].gen * cnt[j] for j in cnt)
    power_use = sum(V[j].power * n[j] for j in n) + sum(V[j].power * cnt[j] for j in cnt)
    return net, total, bom, basis, power_gen, power_use


def trim_sources(V, n, cnt, q):
    """Fewest sources that still cover the draw, pure nodes first."""
    draw = {}
    for j in n:
        y = Fraction(steps(q, n, j), UNIT)
        for k, a in V[j].rates.items(): draw[k] = draw.get(k, 0) - a * y
    out = {}
    by_item = {}
    for j in cnt:
        if V[j].kind == "geo":
            out[j] = cnt[j]; continue
        (k, a), = V[j].rates.items()
        by_item.setdefault(k, []).append(j)
    for k, js in by_item.items():
        need = draw.get(k, 0)
        js.sort(key=lambda j: -V[j].rates[k])
        for j in js:
            ub = V[j].ub if V[j].ub is not None else 10 ** 9
            c = 0 if need <= 0 else min(ub, math.ceil(need / V[j].rates[k]))
            out[j] = c
            need -= c * V[j].rates[k]
        if need > 0:
            raise RuntimeError("not enough %s" % k)
    return {j: c for j, c in out.items() if c}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prune", type=float, default=0.05)
    ap.add_argument("--out", default=str(ROOT / "data" / "optimized_plan.json"))
    ap.add_argument("--time", type=float, default=120)
    ap.add_argument("--two-clocks", action="store_true",
                    help="let each recipe run its machines at two adjacent clocks (m at a steps, the rest at a - 1)")
    ap.add_argument("--steps", type=int, default=10 ** 6,
                    help="clock steps per 100 %% (default 1000000, i.e. 0.0001 %%; 100 = whole percents)")
    ap.add_argument("--cache", help="save/reuse the continuous result in this JSON file")
    ap.add_argument("--exclude", default=",".join(EXCLUDE),
                    help="recipe ids left out, comma-separated (default: %(default)s; '' for none)")
    args = ap.parse_args()
    log = lambda s: print(s, flush=True)
    global UNIT, SHORT, TWO
    UNIT, SHORT, TWO = args.steps, 0.003 * args.steps, args.two_clocks
    if UNIT != 10 ** 6:
        log("clock steps: 1/%d of 100 %% (%.4f %%)" % (UNIT, 100 / UNIT))
    recs, raw, have = scope()
    MAKEABLE.update(have)
    for k in list(EQUIPMENT) + list(PHASE5) + [it for b in FIXED_BUILDINGS for it, _ in BLD[b]["cost"]]:
        if k not in have:
            log("cannot be made without gathered items, dropped from the bill of materials: %s" % ITEMS[k]["n"])
            EQUIPMENT.pop(k, None)
    excl = [e for e in args.exclude.split(",") if e]
    unknown = [e for e in excl if e not in {r["id"] for r in recs}]
    if unknown:
        raise SystemExit("not an in-scope recipe: " + ", ".join(unknown))
    recs = [r for r in recs if r["id"] not in excl]
    if excl:
        log("left out by choice: " + ", ".join(r["name"] for r in R_ALL if r["id"] in excl))
    V = make_vars(recs)
    log("%d production recipes in scope (%d need hand-gathered items and are left out)"
        % (len(recs), sum(1 for r in R_ALL if r["kind"] in ("machine", "burn") and not r.get("xmas")) - len(recs) - len(excl)))
    model = Model(V, raw)
    cache = Path(args.cache) if args.cache else None
    if cache and cache.exists():
        c = json.loads(cache.read_text())
        T0, lam, x, usable, model.allowed = c["T0"], c["lam"], c["x"], set(c["usable"]), c["allowed"]
    else:
        lam0, x0, _ = continuous(model, 0.0, lambda s: log("  " + s))
        T0 = 1 / lam0
        log("continuous optimum without pruning: T = %.1f min" % T0)
        model = Model(V, raw)
        lam, x, usable = continuous(model, args.prune, lambda s: log("  " + s))
        if cache:
            cache.write_text(json.dumps({"T0": T0, "lam": lam, "x": x, "usable": sorted(usable), "allowed": model.allowed}))
    log("continuous optimum after pruning: T = %.1f min" % (1 / lam))
    wc = Path(str(cache) + ".whole.json") if cache else None
    if wc and wc.exists():
        c = json.loads(wc.read_text())
        x, n, cnt = c["x"], {int(k): v for k, v in c["n"].items()}, {int(k): v for k, v in c["cnt"].items()}
    else:
        x, n, cnt = whole_counts(model, x, usable, lam, log, args.time)
        if wc:
            wc.write_text(json.dumps({"x": x, "n": n, "cnt": cnt}))
    n, cnt, q, _ = integer_stage(model, x, n, cnt, log, args.time)
    for _ in range(3):  # sources follow the exact draw; re-run with them fixed
        cnt2 = trim_sources(V, n, cnt, q)
        if cnt2 == cnt:
            break
        cnt = cnt2
        n, cnt, q, _ = integer_stage(model, x, n, cnt, log, args.time)
    net, total, bom, basis, pg, pu = evaluate(V, n, cnt, q, raw)
    # exact checks
    bad = []
    for k, v in net.items():
        if k in raw:
            if v < 0: bad.append((k, float(v)))
        elif k in PHASE5 or k in bom:
            continue
        elif v != 0:
            bad.append((k, float(v)))
    p5r = {k: net.get(k, 0) / PHASE5[k] for k in PHASE5}
    if len(set(p5r.values())) != 1:
        bad.append(("phase 5 proportions", [float(v) for v in p5r.values()]))
    gathered = {ITEMS[k]["n"]: q for k, q in bom.items() if k not in MAKEABLE}
    if gathered:
        log("gathered by hand, not timed: %s" % gathered)
    times = {k: bom[k] / float(net.get(k, 0)) if net.get(k, 0) > 0 else math.inf
             for k in bom if bom[k] > 0 and k in MAKEABLE}
    times.update({k: PHASE5[k] / float(net[k]) if net.get(k, 0) > 0 else math.inf for k in PHASE5})
    T = max(times.values())
    lim = max(times, key=times.get)
    log("integer plan: T = %.1f min (%.2f h), limited by %s; power %.0f MW made, %.0f MW drawn"
        % (T, T / 60, ITEMS[lim]["n"], pg, pu))
    log("exact checks: %s" % ("all non-BOM items balance exactly, Phase 5 in exact proportion" if not bad else bad))
    # production-sheet export
    sheet = {"c": {}, "f": {}, "n": {}}
    for j in n:
        rid = V[j].id
        sheet["c"][rid] = steps(q, n, j) / (n[j] * UNIT)
        sheet["n"][rid] = n[j]
    for j, c in cnt.items():
        v = V[j]
        if v.kind in ("miner", "oil"):
            sheet["c"][v.id] = OC; sheet["n"][v.id] = c
        elif v.kind == "water":
            sheet["c"][v.id] = 1; sheet["n"][v.id] = c
        elif v.kind == "geo":
            sheet["n"][v.id.replace("Geothermal", "Geothermal")] = c; sheet["c"][v.id] = 1
        elif v.kind == "well":
            fl = v.id.split("_", 1)[1]
            nw, sats = WELLS[fl]
            sheet["n"]["WellPressurizer"] = sheet["n"].get("WellPressurizer", 0) + c
            for pur, s in zip(PUR, sats):
                rid = "Well_%s_%s" % (pur, fl)
                k = math.ceil(Fraction(s * c, nw) - Fraction(1, 10 ** 9))
                if k: sheet["c"][rid] = OC; sheet["n"][rid] = k
    # equipment and Phase 5 as adjustments on their makers, so the sheet shows them as wanted
    for k, amt in list(EQUIPMENT.items()) + list(PHASE5.items()):
        makers = [j for j in n if V[j].rec["outs"][0][0] == k]
        if makers:
            j = max(makers, key=lambda j: steps(q, n, j))
            sheet["f"][V[j].id] = sheet["f"].get(V[j].id, 0) + amt / T
    settings = {"timescale": T, "lane": LANE, "rules": RULES, "extra": FIXED_BUILDINGS, "ficsmas": False, "cal": 2}
    out = {"app": "satisfactory-production-sheet", "v": 1, "sheet": sheet, "settings": settings,
           "optimizer": {"T_min": T, "T_continuous_min": 1 / lam, "T_continuous_unpruned_min": T0,
                         "prune": args.prune, "excluded": excl, "clock_steps": UNIT, "two_clocks": TWO, "limited_by": lim, "power_made_MW": pg, "power_drawn_MW": pu,
                         "phase5": PHASE5, "equipment": EQUIPMENT, "extra_buildings": FIXED_BUILDINGS,
                         "checks": "ok" if not bad else str(bad), "gathered_by_hand": gathered,
                         "recipes": sorted(({"id": V[j].id, "name": V[j].rec["name"], "machine": V[j].rec["m"],
                                             "machines": n[j], "clock_pct": clock_text(q, n, j)} for j in n),
                                           key=lambda r: (-r["machines"], r["id"])),
                         "sources": [{"id": V[j].id, "count": c} for j, c in sorted(cnt.items(), key=lambda t: V[t[0]].id)],
                         "buildings": dict(sorted(total.items())),
                         "time_per_item_min": dict(sorted(((ITEMS[k]["n"], round(t, 1)) for k, t in times.items()),
                                                          key=lambda t: -t[1])[:25])}}
    Path(args.out).write_text(json.dumps(out, indent=1))
    log("wrote %s" % args.out)
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
