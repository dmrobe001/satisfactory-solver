#!/usr/bin/env python3
"""Unlock tier ("milestone number") of every recipe and item, for sorting.

Source: the SatisfactoryTools 1.0 extraction (raw/data1.0.json; fetch it with
tools/build_data.py --fetch), whose schematics carry their HUB tier, cost,
prerequisites and unlocked recipes.

Policy: for each tier k = 0..9, take everything reachable using only the
milestones (and HUB upgrades) of tier <= k, closed under
  MAM research or hard-drive alternate   reachable once the MAM, its cost items
                                         and the schematics it requires are
                                         (the hard drive itself counts as gathered)
  recipe                                 reachable once a schematic that unlocks
                                         it is; for a MAM or alternate unlock, its
                                         ingredients and machine too; a recipe no
                                         schematic unlocks needs its ingredients
                                         and machine
  item                                   reachable once a recipe that makes it is;
                                         gathered items always
  mined or extracted resource            reachable once its extractor is (in the
                                         game one starts by picking it up)
The tier of anything is the first k that reaches it (a least fixed point, so
cycles such as ore -> research cost -> ingot -> ore do not inflate it).  A raw
resource is then shown at the first tier at which some recipe can use it.
So a milestone recipe gets its milestone's tier, and a MAM or alternate unlock
the highest tier among what it takes to unlock and make it.  Resource-sink and
customization schematics are ignored.

Usage: python3 tools/tiers.py  ->  data/tiers.json
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


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
    users = {}  # item class -> [recipe class] that consume it (machine recipes)
    for rc, r in R.items():
        if r["inMachine"]:
            for i in r["ingredients"]:
                users.setdefault(i["item"], []).append(rc)
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
    gathered = {ic for ic in d["items"] if not makers.get(ic) and ic not in extract}
    gathered.add("Desc_HardDrive_C")
    st, rt, it = {}, {}, {}   # first tier at which each is reachable, with its source

    def reach(k):
        """Everything reachable using only milestones up to tier k (least fixed point)."""
        S_ok, R_ok, I_ok = set(), set(), set(gathered)
        mach_ok = lambda rc: all(m.replace("Build_", "Desc_", 1) in I_ok for m in R[rc]["producedIn"])
        grow = True
        while grow:
            grow = False
            for sc, s in S.items():
                if sc in S_ok:
                    continue
                if s["type"] in ("EST_Milestone", "EST_Tutorial"):
                    ok = s["tier"] <= k
                elif s["type"] in ("EST_MAM", "EST_Alternate"):
                    ok = ("Desc_Mam_C" in I_ok and all(c["item"] in I_ok for c in s["cost"])
                          and all(q in S_ok for q in s["requiredSchematics"] if q in S))
                else:
                    ok = False
                if ok:
                    S_ok.add(sc); grow = True
            for rc, r in R.items():
                if rc in R_ok:
                    continue
                ings = all(i["item"] in I_ok for i in r["ingredients"])
                ok = False
                for sc in unlocks.get(rc, []):
                    if sc in S_ok and (S[sc]["type"] in ("EST_Milestone", "EST_Tutorial") or (ings and mach_ok(rc))):
                        ok = True
                if not unlocks.get(rc) and r["producedIn"] and ings and mach_ok(rc):
                    ok = True
                if ok:
                    R_ok.add(rc); grow = True
                    for p in r["products"]:
                        if p["item"] not in I_ok:
                            I_ok.add(p["item"])
            for ic in extract:
                if ic in I_ok:
                    continue
                ok = any(m in I_ok for m in extract[ic]) or not extract[ic]
                if ok:
                    I_ok.add(ic); grow = True
        return S_ok, R_ok, I_ok

    for k in range(10):
        S_ok, R_ok, I_ok = reach(k)
        for sc in S_ok:
            st.setdefault(sc, (k, RANK[S[sc]["type"]], S[sc]["name"]))
        for rc in R_ok:
            if rc not in rt:
                srcs = [st[q] for q in unlocks.get(rc, []) if q in st]
                rt[rc] = (k,) + (min(srcs)[1:] if srcs else (0, "with its machine"))
        for ic in I_ok:
            if ic not in it:
                if ic in gathered:
                    it[ic] = (0, 0, "gathered")
                elif ic in extract and not any(rc in R_ok for rc in makers.get(ic, [])):
                    it[ic] = (k, 0, "extracted")
                else:
                    srcs = [rt[rc] for rc in makers.get(ic, []) if rc in rt and rt[rc][0] == k]
                    it[ic] = min(srcs) if srcs else (k, 0, "extracted")
    # a raw resource is shown at the first tier where some recipe can use it
    for ic in extract:
        u = [rt[q][0] for q in users.get(ic, []) if q in rt]
        if ic in it and u and min(u) > it[ic][0]:
            it[ic] = (min(u), 0, "extracted; first used")
    # the engine's ids: production recipes keep their short class name;
    # generators, miners and extractors are looked up by their building
    out = {"items": {}, "recipes": {}}
    for ic, (t, _, name) in it.items():
        out["items"][short(ic)] = [t, name]
    for rc, (t, _, name) in rt.items():
        out["recipes"][short(rc)] = [t, name]
    (ROOT / "data" / "tiers.json").write_text(json.dumps(out, indent=0, sort_keys=True))
    print(len(out["items"]), "items,", len(out["recipes"]), "recipes")


if __name__ == "__main__":
    main()
