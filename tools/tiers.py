#!/usr/bin/env python3
"""Unlock tier ("milestone number") of every recipe and item, for sorting.

Source: the SatisfactoryTools 1.0 extraction (raw/data1.0.json; fetch it with
tools/build_data.py --fetch), whose schematics carry their HUB tier, cost,
prerequisites and unlocked recipes.

Policy
  milestone or HUB-upgrade unlock    the schematic's tier (HUB upgrades: 0)
  MAM research                       the highest tier among what it takes to
                                     get there: the MAM itself, the research's cost items, the
                                     schematics it requires, the recipe's
                                     ingredients and the machine it runs in
  hard-drive alternate               the same, with the schematics it requires
                                     in place of a cost (the hard drive itself
                                     is gathered: tier 0)
  item                               the lowest tier of any recipe that makes
                                     it; mined or extracted resources take the
                                     extractor's tier, gathered items 0
  recipe with several unlocks        the lowest
Resource-sink and customization schematics are ignored.  The definitions are
recursive, so they are iterated to a fixed point.

Usage: python3 tools/tiers.py  ->  data/tiers.json
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INF = 99


def short(cls):
    s = cls
    for p in ("Desc_", "BP_", "Recipe_", "Build_"):
        if s.startswith(p):
            s = s[len(p):]
    return s[:-2] if s.endswith("_C") else s


def main():
    d = json.loads((ROOT / "raw" / "data1.0.json").read_text())
    S, R = d["schematics"], d["recipes"]
    unlocks = {}  # recipe class -> [schematic class]
    for sc, s in S.items():
        if s["type"] in ("EST_Milestone", "EST_Tutorial", "EST_MAM", "EST_Alternate"):
            for rc in s["unlock"]["recipes"]:
                unlocks.setdefault(rc, []).append(sc)
    makers = {}  # item class -> [recipe class]
    for rc, r in R.items():
        for p in r["products"]:
            makers.setdefault(p["item"], []).append(rc)
    # extractors: resource item -> extractor building classes
    extract = {}
    liquid = lambda ic: d["items"].get(ic, {}).get("liquid")
    for m in d["miners"].values():
        allowed = m["allowedResources"] or [r for r in d["resources"]
                                            if (m["allowSolids"] and not liquid(r)) or (m["allowLiquids"] and liquid(r))]
        for res in allowed:
            extract.setdefault(res, []).append(m["className"])
    extract.setdefault("Desc_Water_C", []).append("Desc_WaterPump_C")  # not listed among the miners
    RANK = {"EST_Tutorial": 0, "EST_Milestone": 0, "EST_MAM": 1, "EST_Alternate": 2}
    st = {sc: (INF, 9, "") for sc in S}   # (tier, rank, name): on a tie the milestone wins
    rt = {rc: (INF, 9, "") for rc in R}
    it = {}

    def item_t(ic):
        return it.get(ic, (INF,))[0]

    def bld_t(bc):  # building class -> tier of its build recipe
        return item_t(bc.replace("Build_", "Desc_", 1)) if bc.startswith("Build_") else item_t(bc)

    changed = True
    while changed:
        changed = False
        for sc, s in S.items():
            if s["type"] in ("EST_Milestone", "EST_Tutorial"):
                v = (s["tier"], 0, s["name"])
            elif s["type"] in ("EST_MAM", "EST_Alternate"):
                t = max([item_t(c["item"]) for c in s["cost"] if c["item"] != "Desc_HardDrive_C"] +
                        [st[q][0] for q in s["requiredSchematics"] if q in st] + [item_t("Desc_Mam_C")])
                v = (t, RANK[s["type"]], s["name"])
            else:
                continue
            if v != st[sc]:
                st[sc] = v; changed = True
        for rc, r in R.items():
            best = (INF, 9, "")
            need = [item_t(i["item"]) for i in r["ingredients"]] + [bld_t(m) for m in r["producedIn"]]
            for sc in unlocks.get(rc, []):
                t, rank, name = st[sc]
                if S[sc]["type"] in ("EST_MAM", "EST_Alternate"):
                    t = max([t] + need)
                best = min(best, (t, rank, name))
            if not unlocks.get(rc) and r["producedIn"]:
                # unlocked with no schematic (available from the start, or with its machine)
                best = (max(need), 0, "with its machine")
            if best != rt[rc]:
                rt[rc] = best; changed = True
        for ic in set(makers) | set(extract) | set(d["items"]):
            cand = [rt[rc] for rc in makers.get(ic, [])]
            if ic in extract:
                cand += [(bld_t(m), 0, "extracted") for m in extract[ic]]
            if not cand and ic in d["items"] and not makers.get(ic):
                cand = [(0, 0, "gathered")]
            v = min(cand) if cand else (INF, 9, "")
            if v != it.get(ic):
                it[ic] = v; changed = True
    # the engine's ids: production recipes keep their short class name;
    # generators, miners and extractors are looked up by their building
    out = {"items": {}, "recipes": {}}
    for ic, (t, _, name) in it.items():
        if t < INF:
            out["items"][short(ic)] = [t, name]
    for rc, (t, _, name) in rt.items():
        if t < INF:
            out["recipes"][short(rc)] = [t, name]
    (ROOT / "data" / "tiers.json").write_text(json.dumps(out, indent=0, sort_keys=True))
    print(len(out["items"]), "items,", len(out["recipes"]), "recipes")


if __name__ == "__main__":
    main()
