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


def main():
    if "--fetch" in sys.argv or not RAW.exists():
        RAW.parent.mkdir(exist_ok=True)
        print("downloading", URL)
        urllib.request.urlretrieve(URL, RAW)
    d = json.loads(RAW.read_text())
    items_src, recipes_src, bsrc = d["items"], d["recipes"], d["buildings"]

    items = {}

    def item(cls):
        k = short(cls)
        if k not in items:
            src = items_src.get(cls)
            if src is None:
                src = bsrc.get(cls, {"name": k})
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
