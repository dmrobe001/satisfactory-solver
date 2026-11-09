#!/usr/bin/env python3
"""Convert the community-extracted Satisfactory 1.0 data into the compact
recipe list the solver uses (data/game.json).

Source: SatisfactoryTools (greeny/SatisfactoryTools, data/data1.0.json),
itself extracted from the game's Docs.json.  Download it with

    python3 tools/build_data.py --fetch

or put it at raw/data1.0.json yourself.  All rates in the output are per
minute at 100% clock; fluids are in cubic metres (the source already uses
m^3 for fluid recipe amounts and MJ per m^3 for fluid energy values).

Everything the source data does not contain (miner/extractor rates by node
purity, geothermal output, augmenter and portal behaviour, nuclear waste) is
written out by hand below, in one place, so it is easy to correct.
"""
import json
import math
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "data1.0.json"
OUT = ROOT / "data" / "game.json"
URL = "https://raw.githubusercontent.com/greeny/SatisfactoryTools/master/data/data1.0.json"
# The Official Satisfactory Wiki keeps the current game data (1.2) as JSON.
# It only supplements the 1.0 extraction above: 1.1 and 1.2 changed no
# existing recipe or build cost, but added buildables.
WIKI = ROOT / "raw" / "wiki"
WIKI_URL = "https://satisfactory.wiki.gg/index.php?title=Template:{}.json&action=raw"
WIKI_FILES = ["DocsRecipes", "DocsBuildings", "DocsItems"]

# ---- Hand-entered game constants (1.0) ------------------------------------
PURITY = [("Impure", 0.5), ("Normal", 1.0), ("Pure", 2.0)]
MINERS = [("Desc_MinerMk1_C", 1, 60.0), ("Desc_MinerMk2_C", 2, 120.0), ("Desc_MinerMk3_C", 3, 240.0)]
WATER_EXTRACTOR = ("Desc_WaterPump_C", 120.0)          # m^3/min, no purity
OIL_EXTRACTOR = ("Desc_OilPump_C", 120.0)              # m^3/min on a normal node
WELL_SATELLITE = ("Desc_FrackingExtractor_C", 60.0)    # m^3/min per normal satellite node
WELL_RESOURCES = ["Desc_Water_C", "Desc_LiquidOil_C", "Desc_NitrogenGas_C"]
GEOTHERMAL_MW = {"Impure": 100.0, "Normal": 200.0, "Pure": 400.0}  # time-averaged output
AUGMENTER_MW = 500.0
AUGMENTER_MATRIX_PER_MIN = 5.0
PORTAL_SINGULARITY_PER_MIN = 2.0   # Singularity Cells consumed by a running Main Portal     # Alien Power Matrix consumed by a fueled augmenter
# Waste produced per fuel rod burned in a Nuclear Power Plant.
NUCLEAR_WASTE = {"Desc_NuclearFuelRod_C": ("Desc_NuclearWaste_C", 50.0),
                 "Desc_PlutoniumFuelRod_C": ("Desc_PlutoniumWaste_C", 10.0)}
GATHERED = ["Desc_Leaves_C", "Desc_Wood_C", "Desc_Mycelia_C", "Desc_HogParts_C",
            "Desc_SpitterParts_C", "Desc_StingerParts_C", "Desc_HatcherParts_C", "Desc_Crystal_C",
            "Desc_Crystal_mk2_C", "Desc_Crystal_mk3_C", "Desc_WAT1_C", "Desc_WAT2_C"]
CLOCK_EXP = 1.321929  # power ~ clock^1.321929 for consumers (log2 2.5)
MAX_CLOCK = 2.5


def short(cls):
    """Desc_IronPlate_C -> IronPlate"""
    s = cls
    for p in ("Desc_", "BP_", "Recipe_"):
        if s.startswith(p):
            s = s[len(p):]
    return s[:-2] if s.endswith("_C") else s


# ---- Architecture material costs (Customizer) ------------------------------
# The extracted build recipes hold only each piece's base cost; in 1.0 the
# chosen material adds its own cost.  Source: satisfactory.wiki.gg pages
# Foundations, Walls and Roofs (fetched 2026-11-09).  Every size, ramp,
# quarter pipe and stair of a set costs the same.
#   foundation-type pieces: 5 Concrete + material
#   walls: 2 Concrete (windows: 2 Silica) + material
#   roofs: 3 Concrete + material
MATERIAL_ADDON = {
    "ficsit": [("IronPlate", 2.0)],
    "steel": [("SteelPlate", 2.0)],      # Steel Beam (walls, Metal roofs, Grip Metal)
    "concrete": [("Cement", 2.0)],       # Concrete / Asphalt foundations, concrete walls, Tar roofs
    "plastic": [("Plastic", 2.0)],       # Coated (polished) concrete foundations
    "glass": [("Silica", 2.0)],          # Glass roofs
}
# Pieces missing from both data sources (wiki Walls page: Stairs).
EXTRA_BUILDINGS = {
    "Stairs_Left_01": {"n": "Stairs Left", "cost": [["Cement", 5.0], ["IronPlate", 4.0]]},
    "Stairs_Right_01": {"n": "Stairs Right", "cost": [["Cement", 5.0], ["IronPlate", 4.0]]},
}
FOUNDATION_PREFIXES = ("Foundation_", "Ramp", "InvertedRamp", "QuarterPipe", "DownQuarterPipe", "Stair_")


def piece_material(key):
    """(kind, material) for an architecture piece, or None for anything else."""
    k = key
    if k.startswith("Roof_"):
        if k.startswith("Roof_Orange"): return "roof", "ficsit"
        if k.startswith("Roof_Tar"): return "roof", "concrete"
        if k.startswith("Roof_Window"): return "roof", "glass"
        # Roof_A_* are the straight pieces of the Metal set (its corners are
        # Roof_Metal_*); the data labels them "(FICSIT)" by mistake.
        if k.startswith("Roof_A_") or k.startswith("Roof_Metal"): return "roof", "steel"
        return None
    if k.startswith(("Wall_", "SteelWall_", "WallSet_")):
        if "Frame" in k or "Thin" in k or k[-2:] in ("05", "06", "07"):
            return None  # frame walls and steel-framed windows already cost their full price
        if "Steel" in k or k == "Wall_8x4_02": return "wall", "steel"
        if "Concrete" in k: return "wall", "concrete"
        return "wall", "ficsit"
    if k.startswith(FOUNDATION_PREFIXES) and "Frame" not in k and "Glass" not in k \
            and "Passthrough" not in k:
        if "Grip" in k or "Metal" in k: return "foundation", "steel"
        if "Polished" in k: return "foundation", "plastic"
        if "Asphalt" in k or "Concrete" in k: return "foundation", "concrete"
        return "foundation", "ficsit"
    return None


BASE_COST = {"foundation": {"Cement": 5.0}, "wall": {"Cement": 2.0}, "roof": {"Cement": 3.0}}


def add_material_costs(buildings):
    for key, b in EXTRA_BUILDINGS.items():
        buildings.setdefault(key, dict(b))
    changed = 0
    for key, b in buildings.items():
        pm = piece_material(key)
        if not pm:
            continue
        kind, mat = pm
        cost = dict((i, q) for i, q in b["cost"])
        base = BASE_COST[kind]
        window = kind == "wall" and cost == {"Silica": 2.0}
        if cost != base and not window:
            print("warning: unexpected base cost, left alone:", key, b["cost"], file=sys.stderr)
            continue
        for item_key, q in MATERIAL_ADDON[mat]:
            cost[item_key] = cost.get(item_key, 0.0) + q
        b["cost"] = [[i, q] for i, q in cost.items()]
        if key.startswith("Roof_A_"):
            b["n"] = b["n"].replace("(FICSIT)", "(Metal)")
        changed += 1
    print(f"material costs added to {changed} architecture pieces")


def main():
    if "--fetch" in sys.argv or not RAW.exists():
        RAW.parent.mkdir(exist_ok=True)
        print("downloading", URL)
        urllib.request.urlretrieve(URL, RAW)
    WIKI.mkdir(parents=True, exist_ok=True)
    for n in WIKI_FILES:
        f = WIKI / f"{n}.json"
        if "--fetch" in sys.argv or not f.exists():
            print("downloading", WIKI_URL.format(n))
            req = urllib.request.Request(WIKI_URL.format(n), headers={"User-Agent": "satisfactory-solver-build/1.0"})
            f.write_bytes(urllib.request.urlopen(req).read())
    wiki = {n: {k: v[-1] for k, v in json.loads((WIKI / f"{n}.json").read_text()).items()} for n in WIKI_FILES}
    d = json.loads(RAW.read_text())
    items_src, recipes_src, bsrc = d["items"], d["recipes"], d["buildings"]

    items = {}

    def item(cls):
        k = short(cls)
        if k not in items:
            src = items_src.get(cls)
            if src is None:
                src = bsrc.get(cls) or wiki["DocsItems"].get(cls) or wiki["DocsBuildings"].get(cls) or {"name": k}
                items[k] = {"n": src["name"], "f": 0}
            else:
                items[k] = {"n": src["name"], "f": 1 if src.get("liquid") else 0}
        return k

    def bname(cls):
        return bsrc[cls]["name"]

    def bpow(cls):
        m = bsrc[cls]["metadata"]
        return float(m.get("powerConsumption", 0))

    recipes = []

    def add(**kw):
        kw.setdefault("ins", [])
        kw.setdefault("outs", [])
        kw.setdefault("p", 0.0)       # MW at 100%: + consumes, - produces
        kw.setdefault("pe", CLOCK_EXP)  # clock exponent of power
        kw.setdefault("kind", "machine")
        kw.setdefault("mc", MAX_CLOCK)  # max clock; 1 = fixed clock (on/off)
        kw["ins"] = [[k, round(v, 6)] for k, v in kw["ins"]]
        kw["outs"] = [[k, round(v, 6)] for k, v in kw["outs"]]
        recipes.append(kw)

    # ---- Machine recipes ---------------------------------------------------
    for cls, r in recipes_src.items():
        if not r["inMachine"] or not r["producedIn"]:
            continue
        mach = r["producedIn"][0]
        per = 60.0 / r["time"]
        if r["isVariablePower"]:
            p = (r["minPower"] + r["maxPower"]) / 2.0
        else:
            p = bpow(mach)
        add(id=short(cls), name=r["name"], m=short(mach), alt=1 if r["alternate"] else 0,
            ins=[(item(i["item"]), i["amount"] * per) for i in r["ingredients"]],
            outs=[(item(i["item"]), i["amount"] * per) for i in r["products"]],
            p=p, vp=1 if r["isVariablePower"] else 0)

    # ---- Miners ------------------------------------------------------------
    resources = d["miners"]["Desc_MinerMk1_C"]["allowedResources"]
    for res in resources:
        for mcls, mark, base in MINERS:
            for q, mult in PURITY:
                k = item(res)
                add(id=f"Miner{mark}_{q}_{k}", name=f"{q} {items[k]['n']} Miner Mk. {mark}",
                    m=short(mcls), kind="miner", outs=[(k, base * mult)], p=bpow(mcls))

    # ---- Extractors --------------------------------------------------------
    k = item("Desc_Water_C")
    add(id="WaterExtractor", name="Water Extractor", m=short(WATER_EXTRACTOR[0]), kind="extractor",
        outs=[(k, WATER_EXTRACTOR[1])], p=bpow(WATER_EXTRACTOR[0]))
    k = item("Desc_LiquidOil_C")
    for q, mult in PURITY:
        add(id=f"OilExtractor_{q}", name=f"{q} Crude Oil Extractor", m=short(OIL_EXTRACTOR[0]),
            kind="extractor", outs=[(k, OIL_EXTRACTOR[1] * mult)], p=bpow(OIL_EXTRACTOR[0]))
    for res in WELL_RESOURCES:
        k = item(res)
        for q, mult in PURITY:
            add(id=f"Well_{q}_{k}", name=f"{q} {items[k]['n']} Well Extractor",
                m=short(WELL_SATELLITE[0]), kind="well", mc=1.0,
                outs=[(k, WELL_SATELLITE[1] * mult)], p=0.0)
    add(id="WellPressurizer", name="Resource Well Pressurizer", m="FrackingSmasher",
        kind="manual", mc=1.0, p=bpow("Desc_FrackingSmasher_C"))

    # ---- Power generation --------------------------------------------------
    PWR = "Power"
    items[PWR] = {"n": "Power (MW)", "f": 0, "power": 1}
    fuel_seen = {}
    for gcls, g in d["generators"].items():
        for f in g["fuel"]:
            fuel_seen.setdefault(f, []).append(gcls)
    for gcls, g in d["generators"].items():
        mw = float(g["powerProduction"])
        for f in g["fuel"]:
            fk = item(f)
            ev = items_src[f]["energyValue"]
            ins = [(fk, mw * 60.0 / ev)]
            if g["waterToPowerRatio"] > 0:
                # ratio is litres of water per MJ
                ins.append((item("Desc_Water_C"), g["waterToPowerRatio"] * mw * 60.0 / 1000.0))
            outs = [(PWR, mw)]
            if f in NUCLEAR_WASTE:
                wk, per_rod = NUCLEAR_WASTE[f]
                outs.append((item(wk), per_rod * ins[0][1]))
            name = f"{items[fk]['n']} (Burning)"
            if len(fuel_seen[f]) > 1:
                name = f"{items[fk]['n']} (Burning, {bname(gcls)})"
            add(id=f"Burn_{fk}_{short(gcls)}", name=name, m=short(gcls), kind="burn",
                ins=ins, outs=outs, p=-mw, pe=1.0)
    for q, _ in PURITY:
        mw = GEOTHERMAL_MW[q]
        add(id=f"Geothermal_{q}", name=f"{q} Geothermal Generator", m="GeneratorGeoThermal",
            kind="geo", mc=1.0, outs=[(PWR, mw)], p=-mw, pe=1.0)

    # ---- Special fixed buildings -------------------------------------------
    add(id="Augmenter10", name="Alien Power Augmentor (10%)", m="AlienPowerBuilding",
        kind="augment", mc=1.0, boost=0.10, outs=[(PWR, AUGMENTER_MW)], p=-AUGMENTER_MW, pe=1.0)
    add(id="Augmenter30", name="Alien Power Augmentor (30%)", m="AlienPowerBuilding",
        kind="augment", mc=1.0, boost=0.30, outs=[(PWR, AUGMENTER_MW)], p=-AUGMENTER_MW, pe=1.0,
        ins=[(item("Desc_AlienPowerFuel_C"), AUGMENTER_MATRIX_PER_MIN)])
    add(id="MainPortal", name="Main Portal", m="Portal", kind="manual", mc=1.0,
        p=bpow("Desc_Portal_C"), ins=[(item("Desc_SingularityCell_C"), PORTAL_SINGULARITY_PER_MIN)])

    # ---- Hand-gathered items -----------------------------------------------
    # Things nothing can mine or craft (plants, creature remains, power slugs,
    # artifacts).  They get a placeholder "recipe" so they can sit in layer 0
    # and so their demand shows up; rate is 1 item/min per "gatherer".
    for cls in GATHERED:
        k = item(cls)
        add(id=f"Gather_{k}", name=f"Gathered {items[k]['n']}", m="Gathering", kind="gather",
            mc=1.0, outs=[(k, 1.0)], p=0.0, pe=1.0)

    # ---- Layers ------------------------------------------------------------
    # Layer 0: anything with no inputs (miners, extractors, geothermal, the
    # photonic-matter converter recipe, the unfueled augmenter).  Layer N:
    # every input can be obtained from some recipe of layer <= N-1.
    INF = 10 ** 9
    item_layer = {}
    for r in recipes:
        r["layer"] = 0 if not r["ins"] else INF
    changed = True
    while changed:
        changed = False
        for r in recipes:
            if r["layer"] < INF:
                for k2, _ in r["outs"]:
                    if item_layer.get(k2, INF) > r["layer"]:
                        item_layer[k2] = r["layer"]
                        changed = True
        for r in recipes:
            if r["ins"]:
                L = 1 + max(item_layer.get(k2, INF) for k2, _ in r["ins"])
                L = min(L, INF)
                if L < r["layer"]:
                    r["layer"] = L
                    changed = True
    for r in recipes:
        if r["layer"] >= INF:
            r["layer"] = -1  # unreachable from raw resources

    # ---- Buildings and their build costs -----------------------------------
    buildings = {}
    for cls, r in recipes_src.items():
        if not r["forBuilding"]:
            continue
        for p in r["products"]:
            bk = short(p["item"])
            if p["item"] in bsrc:
                bn = bsrc[p["item"]]["name"]
            elif p["item"] in items_src:
                bn = items_src[p["item"]]["name"]
            else:
                bn = bk
            buildings[bk] = {"n": bn, "cost": [[item(i["item"]), i["amount"]] for i in r["ingredients"]]}
    # Buildables added in 1.1 and 1.2 (and anything else the 1.0 extraction
    # lacks), taken from the wiki's build-gun recipes.
    added = []
    for cls, r in sorted(wiki["DocsRecipes"].items()):
        if not r.get("inBuildGun"):
            continue
        for p in r["products"]:
            bk = short(p["item"])
            if bk in buildings:
                continue
            wb = wiki["DocsBuildings"].get(p["item"]) or wiki["DocsItems"].get(p["item"]) or {}
            bn = wb.get("name") or r["name"]
            buildings[bk] = {"n": bn, "cost": [[item(i["item"]), float(i["amount"])] for i in r["ingredients"]]}
            added.append(bn)
    print(f"added {len(added)} buildables from the wiki (1.1/1.2):", ", ".join(added))
    add_material_costs(buildings)
    for r in recipes:
        if r["m"] == "Gathering":
            continue
        if r["m"] not in buildings:
            print("warning: no build cost for", r["m"], file=sys.stderr)
            buildings[r["m"]] = {"n": r["m"], "cost": []}
    used = {r["m"] for r in recipes if r["m"] != "Gathering"}
    for k2, b in buildings.items():
        b["prod"] = 1 if k2 in used else 0

    out = {"version": "1.0", "source": URL, "items": items, "recipes": recipes, "buildings": buildings}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":"), sort_keys=False))
    print(f"wrote {OUT}: {len(recipes)} recipes, {len(items)} items, {len(buildings)} buildings")
    unreachable = [r["name"] for r in recipes if r["layer"] < 0]
    if unreachable:
        print("unreachable recipes:", unreachable, file=sys.stderr)


if __name__ == "__main__":
    main()
