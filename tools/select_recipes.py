#!/usr/bin/env python3
"""Recipe selection for the tenth-of-the-world factory (continuous linear program).

The factory draws at most one tenth of the world's raw supply (a Miner Mk.3, Oil
Extractor or well pressurizer on every node, all at 250 %) and has to

  1. make every part needed to build itself again: its machines, miners and
     generators, the support buildings the production sheet bills (foundations,
     walls, roofs, power lines, belts, pipes, splitters, storage ...) and a tenth
     of the optimizer's extra buildings;
  2. make a tenth of the optimizer's equipment list;
  3. make the Project Assembly Phase 5 parts;
  4. feed one Ficsonium-burning Nuclear Power Plant at 100 %, one Main Portal
     and one fueled Alien Power Augmentor, continuously;
  5. power itself;
  6. leave SHARDS power shards per minute over.

1-3 are stocks; the objective is the least time T in which all of them are made.
4-6 are rates that hold throughout.

Model (rates per minute)
  x[r]  machines of recipe r at 100 %, continuous.  A machine draws its 100 %
        power (the time average, for variable-power machines) in proportion to x.
  one source per raw resource: the average Mk.3 miner (or extractor, or
        pressurizer with its average satellites) on that resource's nodes at
        250 %, at most (number of nodes) / 10 of them.  It draws 2.5 x its 100 %
        power (the same linear rule).  Water is unlimited (extractors at 100 %).
        At 100 % the tenth would hold 408 SAM ore per minute, and the augmentor
        alone needs 600, so the supply has to be the overclocked one.
  geothermal generators: every geyser in the world, always on.
  for each item k, with lam = 1 / T:
        solid         net(k) >= lam * stock(k) + rate(k)
        fluid         net(k)  = 0   (a fluid cannot be sunk or left to pile up)
        nuclear waste net(k)  = 0   (same reason)
     stock(k) = fixed list + the materials of every building, linear in x.
  power: 1.3 * generated + 500 MW (the augmentor) >= drawn.
  For a fixed lam this is a linear program; the best lam is found by bisection.
  (--free-fluids drops the fluid equalities, to see what they cost.)

Recipes in scope: everything that needs no hand-gathered item, without the
Packager recipes other than the four packaged fuels.  Only the Ficsonium plant
is fixed.  Three groups of recipes are kept in the result whatever the program
uses, because the planner page needs them: the recipes of START (the page's
starting table; its counts and clocks play no part here), all Dark Matter
recipes, and the fluid sinks (SINK).

Selection
  1. the optimum with every recipe allowed (T0).  A vertex of a linear program
     is already sparse: about one recipe per item.
  2. backward elimination of what redundancy is left.  A recipe in use is
     redundant if it is the only maker of nothing (it makes under 100 % of each
     of its products; power counts as a product).  Of the redundant recipes
     that are not protected, ban the one whose loss costs the least time,
     re-optimizing over ALL remaining recipes each time, so a banned recipe may
     be replaced by one that was idle, and its partner may change level.
     Stop when the next ban would push T above T0 * (1 + --budget).
     Banning only ever raises T, so a recipe whose loss was once too costly stays
     necessary, and stale costs are lower bounds (lazy re-evaluation).
  The result is the set in use at the end plus the protected recipes.

Usage: python3 tools/select_recipes.py [--budget 0.01]   ->  data/recipe_set.json
Needs numpy and highspy (pip install numpy highspy).
"""
import argparse, json, math, sys, time
from fractions import Fraction
from pathlib import Path

import numpy as np
import highspy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import optimize as O  # noqa: E402  (game data, building rules, bill-of-materials helpers)

ROOT = Path(__file__).resolve().parent.parent
ITEMS, BLD, R_ALL = O.ITEMS, O.BLD, O.R_ALL
BY_ID = {r["id"]: r for r in R_ALL}

SHARE = Fraction(1, 10)      # of the world's nodes and geysers
CLOCK = Fraction(5, 2)       # extraction clock of miners, oil extractors and pressurizers
SHARDS = 1.0                 # spare power shards per minute
AUG_BOOST, AUG_MW, AUG_FUEL = 0.3, 500.0, 5.0   # fueled Alien Power Augmentor
KEEP_PACKAGER = {"Fuel", "PackagedTurboFuel", "PackagedRocketFuel", "PackagedIonizedFuel"}
WASTE = {"NuclearWaste", "PlutoniumWaste"}
DARK = ["DarkEnergy", "DarkMatter", "Alternate_DarkMatter_Crystallization", "Alternate_DarkMatter_Trap"]
# The planner's frame for fluids (see "frame" below): the recipe that takes up a
# fluid's surplus when its by-product supply runs ahead of its use.
SINK = {"DarkEnergy": "Alternate_DarkMatter_Crystallization", "HeavyOilResidue": "PetroleumCoke",
        "DissolvedSilica": "Alternate_Silica_Distilled"}

# Where the planner page starts: (machines, clock %, recipe id) for the top of the factory.
# The linear program does not have to meet these; it only keeps these recipes in the set.
START = [
    # fixed by one Ficsonium reactor
    (1, 100, "Burn_FicsoniumFuelRod_GeneratorNuclear"), (1, 40, "FicsoniumFuelRod"), (1, 20, "Ficsonium"),
    (2, 100, "Burn_PlutoniumFuelRod_GeneratorNuclear"), (1, 80, "PlutoniumFuelRod"),
    (2, 60, "PlutoniumCell"), (1, 40, "Plutonium"), (1, 80, "NonFissileUranium"),
    (4, 100, "Burn_NuclearFuelRod_GeneratorNuclear"),
    # Phase 5 in 400 min, in exact proportion (tools/nice_top.py, first result)
    (7, 90, "SpaceElevatorPart_9"),    # Nuclear Pasta
    (2, 62.5, "SpaceElevatorPart_10"),  # Biochemical Sculptor
    (1, 16, "SpaceElevatorPart_12"),   # AI Expansion Server
    (1, 50, "SpaceElevatorPart_11"),   # Ballistic Warp Drive
    (1, 65, "SingularityCell"), (4, 80, "PressureConversionCube"),
    (1, 100, "SpaceElevatorPart_7"),   # Assembly Director System
    (2, 75, "SpaceElevatorPart_5"),    # Adaptive Control Unit
    (1, 50, "SpaceElevatorPart_8"),    # Thermal Propulsion Rocket
    (2, 75, "SpaceElevatorPart_4"),    # Modular Engine
    (1, 75, "SpaceElevatorPart_6"),    # Magnetic Field Generator
    (1, 40, "TemporalProcessor"),      # Neural-Quantum Processor
    (2, 100, "AlienPowerFuel"), (4, 90, "SuperpositionOscillator"), (4, 85, "SyntheticPowerShard"),
    (5, 84, "QuantumEnergy"), (1, 100, "DarkEnergy"), (6, 100, "DarkMatter"),
    (1, 10, "NobeliskShockwave"),      # Pulse Nobelisk, from the cluster's spare Nobelisks
    # the acid side: with Non-Fissile Uranium these take 220 sulfuric acid a minute, so Sulfuric
    # Acid trims to 5 at 88 % and the sulfur total is 430 (cluster) + 220 = 650
    (2, 80, "UraniumCell"), (2, 70, "Alternate_NuclearFuelRod_1"),      # Encased Uranium Cell, Uranium Fuel Unit
    (3, 100, "Battery"), (2, 80, "Alternate_SuperStateComputer"),
    (1, 20, "Alternate_InstantScrap"),
    # aluminum: alumina solution, scrap and ingots all net exactly 0 at whole machines
    #   alumina 16 x 120 = 10 x 180 (Electrode Scrap) + 3 x 40 (Battery)
    #   scrap   10 x 300 + 60 (Instant Scrap) = 34 x 90
    #   ingots  34 x 60 = 180 + 1200 + 360 + 15 + 45 + 240 (the six rows below)
    (16, 100, "AluminaSolution"), (10, 100, "Alternate_ElectroAluminumScrap"), (34, 100, "IngotAluminum"),
    (6, 100, "AluminumSheet"),                 # Alclad Aluminum Sheet
    (8, 100, "Alternate_AlcladCasing"),
    (16, 100, "Alternate_SteelBeam_Aluminum"),  # Aluminum Beam (steel beams)
    (2, 100, "Alternate_AluminumRod"),         # Aluminum Rod (iron rods)
    (1, 75, "GasTank"),                        # Empty Fluid Tank
    (2, 100, "FicsiteIngot_AL"),
    (5, 90, "FusedModularFrame"),
    # nitric acid: Non-Fissile Uranium takes 12 and Quartz Purification 10 per machine, and
    # Quartz Purification runs at twice Distilled Silica (dissolved silica 60 vs 120), so nitric
    # acid is 0.4 + 2/3 x Distilled Silica machines: clean only for a multiple of 3.  At 9,
    # Quartz Purification trims to 18 and Nitric Acid to 6.4 = 8 at 80 %.
    (9, 100, "Alternate_Silica_Distilled"),
    # petroleum coke: with the cluster's own heavy oil residue balanced, Petroleum Coke trims to
    # Rubber/2 + Plastic/4 machines and makes 60 x Rubber + 30 x Plastic coke.  Electrode
    # Aluminum Scrap takes 600 and Petroleum Diamonds 1,440; the rest burns in coal generators at
    # 25 each, so 2 x Rubber + Plastic = 3 (mod 5).  Rubber must cover at least 33 machines' worth
    # and Plastic 15, and the only clean coke clocks in reach are whole machines: 36 Rubber and
    # 16 Plastic give 22 Petroleum Coke at 100 %, 2,640 coke, 600 to burn in 24 generators.
    # (Sinking it in more Petroleum Diamonds takes extra Particle Accelerators, whose bill of
    # materials costs more than it saves.)
    (36, 100, "Rubber"), (16, 100, "Plastic"),
    (2, 100, "Alternate_Diamond_Petroleum"), (1, 100, "Alternate_Diamond_OilBased"),
    (24, 100, "Burn_PetroleumCoke_GeneratorCoal"),   # Fused Modular Frame: at 100 % the five would take more Aluminum Casing than 8 Alclad Casing make
]
PINNED = {"Burn_FicsoniumFuelRod_GeneratorNuclear": 1.0}   # requirement 4

# The fuel and munitions cluster, decided by hand (tools/fuel_cluster.py checks it exactly):
# (machines, clock %, recipe id).  Here it runs at exactly these levels, and no other
# recipe may touch its fluids, so they balance by these numbers alone.
CLUSTER = [
    (8, 100, "Alternate_HeavyOilResidue"), (6, 100, "Alternate_DilutedFuel"), (4, 100, "Alternate_RocketFuel_Nitro"),
    (6, 100, "Alternate_Turbofuel"), (1, 27.5, "IonizedFuel"),
    (141, 100, "Burn_RocketFuel_GeneratorFuel"), (3, 100, "Burn_IonizedFuel_GeneratorFuel"),
    (3, 100, "Burn_LiquidFuel_GeneratorFuel"), (5, 250, "Burn_LiquidTurboFuel_GeneratorFuel"),
    (1, 1.25, "PackagedRocketFuel"), (1, 2.5, "PackagedIonizedFuel"), (1, 37.5, "PackagedTurboFuel"), (1, 12.5, "Fuel"),
    (2, 100, "GunpowderMK2"),          # Smokeless Powder
    (2, 100, "Gunpowder"),             # Black Powder
    (2, 100, "Cartridge"),             # Rifle Ammo
    (1, 75, "CartridgeChaos"),         # Turbo Rifle Ammo
    (1, 100, "CartridgeSmart"),        # Homing Rifle Ammo
    (1, 100, "Nobelisk"), (1, 50, "NobeliskCluster"), (1, 50, "NobeliskNuke"), (1, 100, "Rebar_Explosive"),
    (1, 100, "FilterGasMask"), (1, 100, "Alternate_PolyesterFabric"),
    (5, 91, "Alternate_IngotSteel_2"),  # Compacted Steel Ingot: takes the compacted coal that is left
]
CLUSTER_FLUIDS = {"LiquidFuel", "LiquidTurboFuel", "RocketFuel", "IonizedFuel"}
# Left out by choice: every copper ingot recipe but Copper Alloy Ingot (iron is plentiful and
# Leached Copper is a chore to set up), and the two recipes that would make polymer resin or
# compacted coal on the side of the cluster.
BANNED = ["IngotCopper", "Alternate_PureCopperIngot", "Alternate_CopperIngot_Tempered", "Alternate_CopperIngot_Leached",
          "Alternate_IronIngot_Leached", "Alternate_CateriumIngot_Leached",   # the other acid-leaching recipes, same chore
          "Alternate_PolymerResin", "Alternate_EnrichedCoal"]

# A tenth of the optimizer's extra buildings (the production sheet's defaults), one shop,
# one Main Portal and one augmentor.
FIXED = {k: v / 10 for k, v in O.FIXED_BUILDINGS.items()}
FIXED.update(ResourceSinkShop=1, Portal=1, AlienPowerBuilding=1)
EQUIP = {k: v / 10 for k, v in O.EQUIPMENT.items()}
PHASE5 = dict(O.PHASE5)


def log(s):
    print(s, flush=True)


# ------------------------------------------------------------------ columns ----
def sources():
    """One column per raw resource: the average machine on a tenth of its nodes, at CLOCK."""
    V = []
    pc = float(CLOCK)
    for ore, cnt in O.NODES.items():
        n = sum(cnt)
        rate = Fraction(sum(c * q for c, q in zip(cnt, (120, 240, 480))), n) * CLOCK
        p = BY_ID["Miner3_Normal_" + ore]["p"] * pc
        v = O.Var("Miner_" + ore, "miner", {ore: rate}, p, {"MinerMk3": 1}, 1, 0, 0, 1, ub=float(n * SHARE))
        v.name = "Miner Mk.3: " + ITEMS[ore]["n"]
        V.append(v)
    n = sum(O.OIL_NODES)
    rate = Fraction(sum(c * q for c, q in zip(O.OIL_NODES, (60, 120, 240))), n) * CLOCK
    v = O.Var("Extractor_LiquidOil", "oil", {"LiquidOil": rate}, BY_ID["OilExtractor_Normal"]["p"] * pc,
              {"OilPump": 1}, 0, 1, 0, 0, ub=float(n * SHARE))
    v.name = "Oil Extractor"
    V.append(v)
    for fl, (nw, sats) in O.WELLS.items():
        tot = Fraction(sum(c * q for c, q in zip(sats, (30, 60, 120))), nw) * CLOCK
        nsat = Fraction(sum(sats), nw)
        v = O.Var("Well_" + fl, "well", {fl: tot}, BY_ID["WellPressurizer"]["p"] * pc,
                  {"FrackingSmasher": 1, "FrackingExtractor": nsat}, 0, nsat, 0, 0, ub=float(nw * SHARE))
        v.name = "Resource Well: " + ITEMS[fl]["n"]
        V.append(v)
    w = BY_ID["WaterExtractor"]
    v = O.Var("WaterExtractor", "water", {"Water": Fraction(120)}, w["p"], {"WaterPump": 1}, 0, 1, 0, 0)
    v.name = "Water Extractor"
    V.append(v)
    ng = sum(O.GEYSERS)
    mw = sum(c * q for c, q in zip(O.GEYSERS, O.GEO_MW)) / ng
    v = O.Var("Geothermal", "geo", {}, 0.0, {"GeneratorGeoThermal": 1}, 0, 0, 0, 0, ub=float(ng), gen=mw)   # every geyser
    v.name = "Geothermal Generator"
    v.lb = v.ub
    V.append(v)
    # continuous consumers; their buildings are in FIXED
    v = O.Var("MainPortal", "fixed", {"SingularityCell": Fraction(-2)}, BY_ID["MainPortal"]["p"], {}, 1, 0, 1, 0, ub=1.0)
    v.name, v.lb = "Main Portal", 1.0
    V.append(v)
    v = O.Var("Augmenter30", "fixed", {"AlienPowerFuel": Fraction(-AUG_FUEL)}, 0.0, {}, 1, 0, 1, 0, ub=1.0)
    v.name, v.lb = "Alien Power Augmentor (fueled)", 1.0
    V.append(v)
    return V


def recipe_scope():
    recs, raw, have = O.scope()
    recs = [r for r in recs if not (r["m"] == "Packager" and r["id"] not in KEEP_PACKAGER)]
    cl = {rid for _, _, rid in CLUSTER}
    out = [r for r in recs if r["id"] in BANNED or
           (r["id"] not in cl and any(k in CLUSTER_FLUIDS for k, _ in r["ins"] + r["outs"]))]
    recs = [r for r in recs if r not in out]
    return recs, raw, have, out


# -------------------------------------------------------------------- model ----
class Model:
    def __init__(self, free_fluids=False):
        recs, self.raw, self.have, self.left_out = recipe_scope()
        O.MAKEABLE.clear(); O.MAKEABLE.update(self.have)
        O.FIXED_BUILDINGS.clear(); O.FIXED_BUILDINGS.update(FIXED)
        self.V = V = O.make_vars(recs)[:len(recs)] + sources()
        for v in V:
            if not hasattr(v, "name"):
                v.name = v.rec["name"]
            if not hasattr(v, "lb"):
                v.lb = 0.0
            if v.id in PINNED:
                v.lb = v.ub = PINNED[v.id]
        for n, c, rid in CLUSTER:
            v = V[[w.id for w in V].index(rid)]
            v.lb = v.ub = n * c / 100
        self.col = {v.id: j for j, v in enumerate(V)}
        self.equip = {k: q for k, q in EQUIP.items() if k in self.have}
        self.dropped_equipment = sorted(set(EQUIP) - set(self.equip))
        unitB = [O.cost_vec(O.unit_buildings(v)) for v in V]
        items = {k for v in V for k in v.rates} | {k for c in unitB for k in c} | set(PHASE5) | set(self.equip)
        items |= {it for b in FIXED for it, _ in BLD[b]["cost"]}
        self.items = sorted(k for k in items if k in self.have)
        self.row = {k: i for i, k in enumerate(self.items)}
        ni, nv = len(self.items), len(V)
        self.A = np.zeros((ni, nv)); self.B = np.zeros((ni, nv))
        for j, v in enumerate(V):
            for k, q in v.rates.items():
                self.A[self.row[k], j] = float(q)
            for k, q in unitB[j].items():
                if k in self.row:
                    self.B[self.row[k], j] = q
        self.eq = np.array([(k in O.FLUID and not free_fluids) or k in WASTE for k in self.items])
        self.rate = np.zeros(ni)
        self.rate[self.row["CrystalShard"]] = SHARDS
        self.pw = np.array([(1 + AUG_BOOST) * v.gen - v.power for v in V])
        self.cost = np.array([float(v.machines) for v in V])
        self.lb = np.array([v.lb for v in V]); self.ub = np.array([np.inf if v.ub is None else v.ub for v in V])
        self.types = (60, 10, 60)
        self.nlp = 0

    def stock0(self):
        """Fixed stock: extra buildings, per-item-type buildings, equipment, Phase 5."""
        b = O.cost_vec(O.fixed_buildings(*self.types))
        for src in (self.equip, PHASE5):
            for k, q in src.items():
                b[k] = b.get(k, 0) + q
        s = np.zeros(len(self.items))
        for k, q in b.items():
            if k in self.row:
                s[self.row[k]] = q
        return s

    def lp(self, lam, banned):
        """Fewest machines that meet everything for this lam, or None."""
        self.nlp += 1
        M = self.A - lam * self.B
        lo = lam * self.stock0() + self.rate
        hi = np.where(self.eq, lo, np.inf)
        M = np.vstack([M, self.pw]); lo = np.append(lo, -AUG_MW); hi = np.append(hi, np.inf)
        ub = self.ub.copy()
        if banned:
            ub[list(banned)] = 0.0
        inf = highspy.kHighsInf
        h = highspy.Highs(); h.setOptionValue("output_flag", False)
        lpm = highspy.HighsLp()
        lpm.num_col_, lpm.num_row_ = M.shape[1], M.shape[0]
        lpm.col_cost_ = self.cost
        lpm.col_lower_ = self.lb; lpm.col_upper_ = np.where(np.isinf(ub), inf, ub)
        lpm.row_lower_ = lo; lpm.row_upper_ = np.where(np.isinf(hi), inf, hi)
        Mt = M.T
        nz = Mt != 0
        lpm.a_matrix_.format_ = highspy.MatrixFormat.kColwise
        lpm.a_matrix_.start_ = np.concatenate([[0], np.cumsum(nz.sum(axis=1))]).astype(np.int32)
        lpm.a_matrix_.index_ = np.nonzero(nz)[1].astype(np.int32)
        lpm.a_matrix_.value_ = Mt[nz]
        h.passModel(lpm); h.run()
        if h.getModelStatus() != highspy.HighsModelStatus.kOptimal:
            return None
        return np.array(h.getSolution().col_value)

    def best(self, banned, hi=None, floor=None, tol=2e-5):
        """Largest feasible lam (bisection).  hi: a known upper bound; floor: give up
        (return None) if lam = floor is infeasible."""
        if floor is not None:
            x = self.lp(floor, banned)
            if x is None:
                return None, None
            lo = floor
        else:
            lo, x = 0.0, None
        if hi is None:
            hi = 1e-4
            while True:
                xx = self.lp(hi, banned)
                if xx is None:
                    break
                lo, x, hi = hi, xx, hi * 2
        else:
            xx = self.lp(hi, banned)
            if xx is not None:
                return hi, xx
        while hi - lo > tol * hi:
            mid = (lo + hi) / 2
            xx = self.lp(mid, banned)
            if xx is not None: lo, x = mid, xx
            else: hi = mid
        return lo, x

    def settle(self, banned, hi=None):
        """best(), repeated until the per-item-type building counts match the solution."""
        for _ in range(6):
            lam, x = self.best(banned, hi)
            act = [self.V[j] for j in np.nonzero(x > 1e-7)[0]]
            st = lam * self.stock0() + (self.A * 0 + lam * self.B) @ x
            nbom = int(np.sum(st > 1e-12))
            t = O.type_counts([v for v in act if v.kind != "fixed"], range(nbom))
            if t == self.types:
                break
            self.types = t
            hi = None
        return lam, x


def active(model, x, tol=1e-6):
    return [j for j in range(len(x)) if x[j] > tol]


def shares(model, x):
    """For each column in use: {product: its share of that product's total make}.  Power counts as a product."""
    V = model.V
    made = np.where(model.A > 0, model.A, 0) @ x
    gen = sum(v.gen * x[j] for j, v in enumerate(V))
    out = {}
    for j in active(model, x):
        v = V[j]
        sh = {k: float(q) * x[j] / made[model.row[k]] for k, q in v.rates.items() if q > 0 and made[model.row[k]] > 1e-9}
        if v.gen:
            sh["Power"] = v.gen * x[j] / gen
        out[j] = sh
    return out


def select(model, budget, protected):
    """Backward elimination of redundant recipes (see the module docstring)."""
    V = model.V
    lam0, x0 = model.settle(set())
    T0 = 1 / lam0
    log("every recipe allowed: T0 = %.1f min, %d recipes in use" % (T0, sum(1 for j in active(model, x0) if V[j].kind == "recipe")))
    floor = lam0 / (1 + budget)
    banned, needed, stale, trace = set(), set(), {}, []
    lam, x = lam0, x0
    while True:
        sh = shares(model, x)
        cand = [j for j in sh if V[j].kind == "recipe" and V[j].id not in protected and j not in needed
                and sh[j] and max(sh[j].values()) < 0.999]
        if not cand:
            break
        for j in cand:
            stale.setdefault(j, lam)      # an upper bound on lam without j
        cand.sort(key=lambda j: -stale[j])
        best_j = best_lam = best_x = None
        for j in cand:
            if best_lam is not None and stale[j] <= best_lam:
                break                      # nothing further down can beat the best found
            l, xx = model.best(banned | {j}, hi=min(stale[j], lam), floor=floor)
            if l is None:
                needed.add(j); stale[j] = 0.0
                continue
            stale[j] = l
            if best_lam is None or l > best_lam:
                best_j, best_lam, best_x = j, l, xx
        if best_j is None:
            break
        banned.add(best_j)
        was = max(sh[best_j].values())
        lam, x = best_lam, best_x
        nact = sum(1 for j in active(model, x) if V[j].kind == "recipe")
        trace.append({"banned": V[best_j].id, "name": V[best_j].name, "share_before": round(was, 4),
                      "T_min": round(1 / lam, 2), "recipes_in_use": nact})
        log("  - %-42s (made %4.1f %%)  T = %6.1f min (+%.2f %%), %d recipes in use"
            % (V[best_j].name, 100 * was, 1 / lam, 100 * (lam0 / lam - 1), nact))
    kept = [(V[j].name, 1 / stale[j] if stale[j] else math.inf) for j in sorted(needed)
            if x[j] > 1e-6]
    for name, t in kept:
        log("  kept: %-42s (without it T %s)" % (name, "> %.1f min" % (1 / floor)))
    lam, x = model.settle(banned, hi=lam * 1.001)
    return T0, x0, lam, x, banned, trace


# -------------------------------------------------------------------- frame ----
def frame(model, x, keep, T):
    """What the planner page needs besides the recipe list.

    maker[item]: the one recipe (or source) whose machine count follows the
        item's demand: the source for raw items, else the kept recipe with the
        item as its first output and the largest share, else the largest
        by-product share.
    sink[fluid]: the recipe that absorbs the fluid when it is in surplus (SINK).
    A kept recipe that is the maker of nothing would never be sized by the page,
    so it gets a default machine count: its level here, scaled from this
    program's Phase 5 pace to the pace of START, rounded to whole machines."""
    V = model.V
    sh = shares(model, x)
    fixed = {rid for _, _, rid in START + CLUSTER}   # set on the page: followers of nothing if anything else makes the item
    maker = {}
    for k in model.items:
        best = None
        for j in keep:
            v = V[j]
            q = v.rates.get(k, 0)
            outs = [o for o, _ in v.rec["outs"]] if v.rec else list(v.rates)
            if v.kind == "fixed" or (q <= 0 and k not in outs):
                continue
            if k not in outs:
                continue
            # the maker should be a row the page leaves on auto, even if it makes the item on the side
            # (Rubber for heavy oil residue): it can be raised when the item's sink needs more
            key = (v.kind != "recipe", v.id not in fixed, bool(outs) and outs[0] == k, sh.get(j, {}).get(k, 0.0), -j)
            if best is None or key > best[0]:
                best = (key, v.id)
        if best:
            maker[k] = best[1]
    # power follows demand through a generator that leaves no waste behind
    maker["Power"] = max((j for j in keep if V[j].gen and V[j].kind == "recipe" and not (set(V[j].rates) & WASTE)
                          and "Ficsonium" not in V[j].id and V[j].id not in {r for _, _, r in CLUSTER}), key=lambda j: (V[j].gen * x[j], V[j].id in SINK.values()), default=None)
    maker["Power"] = V[maker["Power"]].id if maker["Power"] is not None else None
    for k in WASTE:            # nuclear waste is only checked, never steered
        maker.pop(k, None)
    pace = {k: sum(n * c / 100 * float(V[model.col[rid]].rates.get(k, 0)) for n, c, rid in START) for k in PHASE5}
    scale = T * min(pace[k] / PHASE5[k] for k in PHASE5)   # START's Phase 5 pace over this program's
    return maker, scale


# ------------------------------------------------------------------- output ----
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=0.01, help="largest increase of T over the unrestricted optimum (default 0.01)")
    ap.add_argument("--free-fluids", action="store_true", help="let fluids pile up (net >= 0), for comparison only")
    ap.add_argument("--out", default=str(ROOT / "data" / "recipe_set.json"))
    args = ap.parse_args()
    t0 = time.time()
    model = Model(args.free_fluids)
    V = model.V
    log("%d recipes in scope; left out: %s" % (sum(1 for v in V if v.kind == "recipe"), ", ".join(r["name"] for r in model.left_out)))
    if model.dropped_equipment:
        log("equipment that needs gathered items, dropped: " + ", ".join(model.dropped_equipment))
    protected = {rid for _, _, rid in START} | set(DARK) | set(SINK.values()) | {rid for _, _, rid in CLUSTER}
    T0, x0, lam, x, banned, trace = select(model, args.budget, protected)
    T = 1 / lam
    act = active(model, x)
    log("selected: T = %.1f min (%.2f h; +%.2f %% over T0 = %.1f min), %d LPs, %.0f s"
        % (T, T / 60, 100 * (T / T0 - 1), T0, model.nlp, time.time() - t0))
    net = model.A @ x
    stock = model.stock0() + model.B @ x
    need = lam * stock + model.rate
    gen = sum(v.gen * x[j] for j, v in enumerate(V)); draw = sum(v.power * x[j] for j, v in enumerate(V))
    sh = shares(model, x)
    recipes, srcs = [], []
    keep = set(act) | {model.col[rid] for rid in protected}
    for j in sorted(keep, key=lambda j: (-(V[j].rec or {}).get("layer", 0), V[j].id)):
        v = V[j]
        if v.kind == "recipe":
            share = {k: round(q, 4) for k, q in sh.get(j, {}).items()}
            recipes.append({"id": v.id, "name": v.name, "machine": BLD[v.rec["m"]]["n"], "layer": v.rec["layer"],
                            "lp_machines": round(float(x[j]), 4), "share": share,
                            "protected": v.id in protected})
        elif v.kind not in ("fixed",):
            k = next(iter(v.rates), None)
            srcs.append({"id": v.id, "name": v.name, "kind": v.kind, "item": k,
                         "rate": float(v.rates[k]) if k else 0.0, "mw": v.power, "gen_mw": v.gen,
                         "max": v.ub, "lp_units": round(float(x[j]), 4),
                         "buildings": {b: float(q) for b, q in v.build.items()}})
    maker, scale = frame(model, x, keep, T)
    start_ids = {rid for _, _, rid in START + CLUSTER}
    makes = set(maker.values())
    defaults = {r["id"]: {"n": max(1, round(r["lp_machines"] * scale)), "clock": 100} for r in recipes
                if r["id"] not in makes and r["id"] not in start_ids and r["id"] not in DARK
                and r["id"] not in SINK.values() and r["lp_machines"] > 1e-6}
    for s in srcs:
        s["clock"] = 1.0 if s["kind"] in ("water", "geo") else float(CLOCK)
    tight = sorted(((model.items[i], float(net[i] - need[i])) for i in range(len(model.items))
                    if need[i] > 1e-9 and not model.eq[i]), key=lambda t: t[1])
    out = {
        "what": "Recipe set for the tenth-of-the-world factory (tools/select_recipes.py)",
        "T_min": round(T, 2), "T0_min": round(T0, 2), "budget": args.budget, "free_fluids": args.free_fluids,
        "share": float(SHARE), "shards_per_min": SHARDS,
        "augmentor": {"boost": AUG_BOOST, "mw": AUG_MW, "fuel_per_min": AUG_FUEL},
        "portal": {"mw": BY_ID["MainPortal"]["p"], "cells_per_min": 2.0},
        "power": {"generated_mw": round(gen, 1), "with_augmentor_mw": round((1 + AUG_BOOST) * gen + AUG_MW, 1), "drawn_mw": round(draw, 1)},
        "phase5": PHASE5, "equipment": model.equip, "extra_buildings": FIXED, "rules": O.RULES,
        "expendable": O.EXPENDABLE,
        "start": [{"n": n, "clock": c, "id": rid} for n, c, rid in START + CLUSTER],
        "recipes": recipes, "sources": srcs,
        "maker": {k: v for k, v in sorted(maker.items()) if v},
        "sink": {k: v for k, v in SINK.items() if v in {r["id"] for r in recipes}},
        "exact": sorted(k for k in model.items if k in O.FLUID or k in WASTE or k in model.raw),
        "defaults": defaults, "min_net": {"SyntheticPowerShard": SHARDS}, "start_scale": round(scale, 4),
        "left_out": [r["id"] for r in model.left_out], "banned": sorted(V[j].id for j in banned),
        "trace": trace,
        "stock": {model.items[i]: round(float(stock[i]), 2) for i in range(len(model.items)) if stock[i] > 1e-9},
        "binding": [k for k, s in tight if s < 1e-6 * max(1.0, 1.0)][:60],
    }
    Path(args.out).write_text(json.dumps(out, indent=1))
    log("wrote %s: %d recipes, %d sources" % (args.out, len(recipes), len(srcs)))
    log("power: %.0f MW generated (x1.3 + 500 = %.0f), %.0f MW drawn" % (gen, 1.3 * gen + 500, draw))
    for s in srcs:
        if s["max"]:
            log("  %-28s %6.2f of %6.2f" % (s["name"], s["lp_units"], s["max"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
