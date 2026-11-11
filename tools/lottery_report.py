#!/usr/bin/env python3
"""Summarise data/recipe_lottery.json (see tools/recipe_lottery.py).

Per recipe, among the runs where it was the one drawn for its item:
  feasible   share of those runs that could make the whole bill of materials
  effect     change in T attributable to it, relative to the average of its
             item's recipes: a linear model log T = sum of per-recipe effects
             (centred within each item), fitted by least squares on the
             feasible runs; +/- is one standard error
  used       share of feasible runs in which the solution actually ran it
Usage: python3 tools/lottery_report.py [data/recipe_lottery.json] [--md FILE]
"""
import json, math, sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
args = [a for a in sys.argv[1:] if not a.startswith("--")]
md = sys.argv[sys.argv.index("--md") + 1] if "--md" in sys.argv else None
if md in args:
    args.remove(md)
data = json.loads(Path(args[0] if args else ROOT / "data" / "recipe_lottery.json").read_text())
game = json.loads((ROOT / "data" / "game.json").read_text())
NAME = {r["id"]: r["name"] for r in game["recipes"]}
INAME = {k: v["n"] for k, v in game["items"].items()}
G = data["groups"]
runs = data["runs"]
ok = [r for r in runs if r["T"]]
T = np.array([r["T"] for r in ok])
out = []
p = lambda s="": out.append(s)
p("%d random selections, %d feasible (%.0f %%)" % (len(runs), len(ok), 100 * len(ok) / len(runs)))
q = np.percentile(T, [0, 10, 25, 50, 75, 90, 100])
p("T over feasible selections (min): best %.1f, 10%% %.1f, quartiles %.1f / %.1f / %.1f, 90%% %.1f, worst %.1f"
  % tuple(q))
p()
# design matrix: per group, sum-to-zero coding
cols, colmap = [], {}
for k in sorted(G):
    rs = G[k]
    for rid in rs[1:]:
        colmap[(k, rid)] = len(cols)
        cols.append((k, rid))
X = np.zeros((len(ok), len(cols) + 1))
X[:, -1] = 1
for i, r in enumerate(ok):
    for k, rs in G.items():
        rid = r["pick"][k]
        if rid == rs[0]:
            for other in rs[1:]:
                X[i, colmap[(k, other)]] = -1
        else:
            X[i, colmap[(k, rid)]] = 1
y = np.log(T)
beta, *_ = np.linalg.lstsq(X, y, rcond=None)
res = y - X @ beta
dof = max(1, len(y) - X.shape[1])
s2 = float(res @ res) / dof
cov = s2 * np.linalg.pinv(X.T @ X)
p("Model fit: residual spread of log T %.3f (vs %.3f total) -> recipe choices one at a time explain %.0f %% of the variance"
  % (math.sqrt(s2), float(np.std(y)), 100 * (1 - s2 / float(np.var(y)))))
p()
rows = []
for k, rs in G.items():
    idx = [colmap.get((k, rid)) for rid in rs]
    for j, rid in enumerate(rs):
        if j == 0:
            vec = np.zeros(X.shape[1]); vec[[c for c in idx[1:]]] = -1
        else:
            vec = np.zeros(X.shape[1]); vec[idx[j]] = 1
        eff = float(vec @ beta)
        se = math.sqrt(max(0.0, float(vec @ cov @ vec)))
        drawn = [r for r in runs if r["pick"][k] == rid]
        fe = [r for r in drawn if r["T"]]
        used = sum(1 for r in fe if rid in r["used"])
        rows.append(dict(item=INAME[k], rid=rid, name=NAME[rid], n=len(drawn),
                         feas=len(fe) / len(drawn) if drawn else float("nan"),
                         eff=eff, se=se, used=used / len(fe) if fe else float("nan")))


def fmt(r):
    return "| %s | %s | %+.1f %% ± %.1f | %.0f %% | %.0f %% | %d |" % (
        r["item"], r["name"], 100 * (math.exp(r["eff"]) - 1), 100 * r["se"], 100 * r["feas"], 100 * r["used"], r["n"])


hdr = "| Item | Recipe | Effect on T | Feasible when drawn | Used when drawn | Draws |\n|---|---|---|---|---|---|"
sig = [r for r in rows if abs(r["eff"]) > 2.5 * r["se"]]
p("Recipes whose effect on T is more than 2.5 standard errors from zero, strongest first:")
p(hdr)
for r in sorted(sig, key=lambda r: r["eff"]):
    p(fmt(r))
p()
groups_feas = []
for k, rs in G.items():
    fs = [r for r in rows if r["item"] == INAME[k]]
    spread = max(r["feas"] for r in fs) - min(r["feas"] for r in fs)
    groups_feas.append((spread, k))
p("Recipes that often make the selection infeasible (feasible when drawn under 60 %):")
p(hdr)
for r in sorted((r for r in rows if r["feas"] < 0.6), key=lambda r: r["feas"]):
    p(fmt(r))
p()
p("All recipes:")
p(hdr)
for r in sorted(rows, key=lambda r: (r["item"], r["eff"])):
    p(fmt(r))
text = "\n".join(out)
print(text)
if md:
    Path(md).write_text(text + "\n")
