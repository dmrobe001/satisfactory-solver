#!/usr/bin/env python3
"""Choose recipes so the balance equations separate as much as possible.

A recipe that touches two or more net-0 items (inputs or outputs) links their
equations: a "bridge".  With no bridges, every net-0 item's equation involves
its own recipes only, and the system splits into independent equations.

Integer program (HiGHS): y_r = 1 if recipe r is chosen.
  * every usable item that some non-gathered recipe can make, and every
    Phase 5 part, is made by a chosen recipe;
  * every input of a chosen recipe is made by a chosen recipe (or is raw), by
    a derivation that starts at raw resources: each needed item gets a level,
    and the producer that witnesses it has all its inputs at lower levels;
  * every net-0 item a chosen recipe makes has a chosen consumer;
  * minimise the merges sum_r (k_r - 1) y_r over bridges (k_r = net-0 items
    touched), then the number of recipes.
The chosen set is then checked with a linear program: it must run with every
balance exact, every usable item net >= 0 and each target made at a positive
rate.  Item rules as in tools/blocks.py (open model: usable items free).

Usage: python3 tools/separate.py [--time 300]  ->  data/separate.json
"""
import argparse, collections, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blocks as B
import optimize as O

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--time", type=float, default=300)
    ap.add_argument("--levels", type=int, default=40)
    ap.add_argument("--no-p5", action="store_true", help="do not require the Phase 5 parts")
    ap.add_argument("--out", default="separate")
    ap.add_argument("--skip", default="", help="usable items not required (comma separated)")
    a = ap.parse_args()
    recs = B.pool("all", B.RAW, p5=True, generators=True)
    items, nets, cls, *_ = B.model(recs, open_usable=True)
    M, T = len(recs), a.levels
    touch = [sorted(k for k in d if cls.get(k) == "balance") for d in nets]
    raw = set(B.RAW)
    ins = [[k for k, v in d.items() if v < 0 and k != "Power"] for d in nets]
    outs = [[k for k, v in d.items() if v > 0 and k != "Power"] for d in nets]
    makers = collections.defaultdict(list)
    for j in range(M):
        for k in outs[j]: makers[k].append(j)
    # makeable items (reachability over the whole pool)
    have = set(raw); ch = True
    while ch:
        ch = False
        for j in range(M):
            if all(k in have for k in ins[j]):
                for k in outs[j]:
                    if k not in have: have.add(k); ch = True
    targets = {k for k in have if cls.get(k) == "free" and k != "Power"} | (set() if a.no_p5 else set(B.PHASE5))
    targets -= set(x for x in a.skip.split(",") if x)
    need_items = [k for k in items if k not in raw and k != "Power" and k in have]
    # variables: y_r (M), z_i (needed), L_i (level), w_{r,i} (r witnesses i)
    idx = {}
    def var(name):
        idx[name] = len(idx); return idx[name]
    for j in range(M): var(("y", j))
    for k in need_items: var(("z", k)); var(("L", k))
    W = [(j, k) for k in need_items for j in makers[k] if all(x in have for x in ins[j])]
    for j, k in W: var(("w", j, k))
    nv = len(idx)
    lb, ub, integ, cost = [0.0] * nv, [1.0] * nv, [1] * nv, [0.0] * nv
    for k in need_items:
        ub[idx[("L", k)]] = T; integ[idx[("L", k)]] = 0
    for j in range(M):
        cost[idx[("y", j)]] = max(0, len(touch[j]) - 1) + 0.001
    rows = []
    for k in targets:
        rows.append(({idx[("z", k)]: 1}, 1, None))
    for j in range(M):
        for k in ins[j]:
            if k in raw: continue
            if ("z", k) not in idx:  # input never makeable: recipe impossible
                rows.append(({idx[("y", j)]: 1}, None, 0)); break
            rows.append(({idx[("z", k)]: 1, idx[("y", j)]: -1}, 0, None))      # z_k >= y_r
    for k in need_items:
        ws = [idx[("w", j, k)] for j in makers[k] if ("w", j, k) in idx]
        d = {w: 1 for w in ws}; d[idx[("z", k)]] = -1
        rows.append((d, 0, None))                                            # sum w >= z
    for j, k in W:
        w = idx[("w", j, k)]
        rows.append(({w: 1, idx[("y", j)]: -1}, None, 0))                    # w <= y
        for x in ins[j]:
            if x in raw: continue
            # L_k >= L_x + 1 - (T+1)(1 - w)
            rows.append(({idx[("L", k)]: 1, idx[("L", x)]: -1, w: -(T + 1)}, 1 - (T + 1), None))
    for k in need_items:
        if cls.get(k) != "balance": continue
        cons = [j for j in range(M) if k in ins[j]]
        for j in makers[k]:
            d = {idx[("y", c)]: 1 for c in cons}; d[idx[("y", j)]] = d.get(idx[("y", j)], 0) - 1
            rows.append((d, 0, None))                                        # a consumer if made
    print(f"{M} recipes, {len(targets)} targets, {nv} variables, {len(rows)} rows", flush=True)
    import time
    t0 = time.time()
    ok, x, obj = O.solve(nv, cost, rows, lb, ub, integer=integ, time_limit=a.time,
                         options={"mip_rel_gap": 0.0})
    print("solved in %.1f s (limit %g s; if it hit the limit, the result is the best found, not proven)" % (time.time() - t0, a.time))
    if not ok or x is None:
        print("no solution"); return 1
    chosen = [j for j in range(M) if x[idx[("y", j)]] > 0.5]
    merges = sum(max(0, len(touch[j]) - 1) for j in chosen)
    print(f"chosen {len(chosen)} recipes, {sum(len(touch[j]) >= 2 for j in chosen)} bridges, {merges} merges")
    # LP check: the chosen set runs with exact balances and makes every target
    sub = [recs[j] for j in chosen]
    s_items, s_nets, s_cls, *_ = B.model(sub, open_usable=True)
    lrows = []
    for k in s_items:
        col = {j: float(d[k]) for j, d in enumerate(s_nets) if d.get(k)}
        if s_cls[k] == "balance": lrows.append((col, 0.0, 0.0))
        elif s_cls[k] == "raw": lrows.append((col, None, 0.0))
        elif k in targets: lrows.append((col, 1.0, None))
        elif k != "Power": lrows.append((col, 0.0, None))
    ok2, x2, _ = O.solve(len(sub), [1.0] * len(sub), lrows, [0.0] * len(sub), [None] * len(sub))
    print("runs with exact balances and makes every target:", bool(ok2))
    # coupled groups
    par = {}
    def f(k):
        par.setdefault(k, k)
        while par[k] != k: par[k] = par[par[k]]; k = par[k]
        return k
    for j in chosen:
        for k in touch[j]: f(k)
        for k in touch[j][1:]: par[f(k)] = f(touch[j][0])
    groups = collections.defaultdict(list)
    for k in list(par): groups[f(k)].append(k)
    gl = sorted(groups.values(), key=len, reverse=True)
    print("equation groups by size:", [len(g) for g in gl])
    out = {"recipes": [recs[j]["id"] for j in chosen], "names": {recs[j]["id"]: recs[j]["name"] for j in chosen},
           "bridges": {recs[j]["id"]: touch[j] for j in chosen if len(touch[j]) >= 2},
           "groups": [sorted(g) for g in gl], "merges": merges, "lp_ok": bool(ok2)}
    (ROOT / "data" / f"{a.out}.json").write_text(json.dumps(out, indent=1))
    print("  independent equations:", ", ".join(sorted(g[0] for g in gl if len(g) == 1)))
    for g in gl:
        if len(g) > 1:
            br = [recs[j]["name"] for j in chosen if len(touch[j]) >= 2 and touch[j][0] in g]
            print(f"  {len(g)} equations: {', '.join(sorted(g))}\n     bridges: {'; '.join(br)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
