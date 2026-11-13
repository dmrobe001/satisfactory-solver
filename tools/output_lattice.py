#!/usr/bin/env python3
"""The output lattice of a coupled group of balance equations.

Takes the recipe choice in data/separate.json and its largest group of
coupled net-0 equations (the Phase 5 cluster).  Within the group, each
equation whose item has a single producer fixes that producer's count from
its consumers' counts; the recipes not fixed this way are the *outputs*
(chosen freely).  The whole-machine solutions form a lattice L; projected
onto the output counts it is a lattice L_F of full rank, and the condition
"every forced count comes out whole" is exactly n_F in L_F.

Z^F / L_F is a finite abelian group; its Smith normal form gives invariant
factors d_1 | d_2 | ... and, for each d_i > 1, one congruence
    sum_f a_if * n_f == 0  (mod d_i)
on the output counts.  Together the congruences are necessary and sufficient.
Also reported per output: its solo step (the fewest machines of that output
alone, every other output at 0) and its free step (the smallest change in it
any combination allows).

Exact integer arithmetic throughout.  --raw30 adds the rule that each raw
draw of the group is a multiple of 30/min.

Usage: python3 tools/output_lattice.py [--raw30]  ->  data/output_lattice[_raw30].json
"""
import argparse, json, math, sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blocks as B

ROOT = Path(__file__).resolve().parent.parent


def kernel(rows, W):
    """Integer basis of {x in Z^W : r . x = 0 for every row r} (column reduction)."""
    basis = [[int(i == j) for j in range(W)] for i in range(W)]
    for r in rows:
        vals = [sum(c * b[j] for j, c in r.items()) for b in basis]
        live = [(b, v) for b, v in zip(basis, vals) if v]
        zero = [b for b, v in zip(basis, vals) if not v]
        while len(live) > 1:
            live.sort(key=lambda t: abs(t[1]))
            pb, pv = live[0]
            nxt = [(pb, pv)]
            for b, v in live[1:]:
                q = v // pv
                b = [x - q * y for x, y in zip(b, pb)]
                v = v - q * pv
                (nxt if v else zero).append((b, v) if v else b)
            live = nxt
        basis = zero
    return basis


def hnf_basis(vecs, n):
    """A basis (rows) of the lattice spanned by integer vectors in Z^n, upper triangular."""
    rows = [list(v) for v in vecs if any(v)]
    out = []
    for col in range(n):
        piv = [r for r in rows if r[col]]
        rest = [r for r in rows if not r[col]]
        while len(piv) > 1:
            piv.sort(key=lambda r: abs(r[col]))
            p = piv[0]
            nxt = [p]
            for r in piv[1:]:
                q = r[col] // p[col]
                r = [a - q * b for a, b in zip(r, p)]
                (nxt if r[col] else rest).append(r)
            piv = nxt
        if piv:
            p = piv[0]
            if p[col] < 0: p = [-a for a in p]
            out.append(p)
        rows = [r for r in rest if any(r)]
    return out


def smith(Bm):
    """Smith normal form D = U Bm V of an m x r integer matrix; returns (diag, U)."""
    m, n = len(Bm), len(Bm[0])
    A = [row[:] for row in Bm]
    U = [[int(i == j) for j in range(m)] for i in range(m)]
    for t in range(min(m, n)):
        while True:
            # pivot: smallest nonzero in the remaining block
            best = None
            for i in range(t, m):
                for j in range(t, n):
                    if A[i][j] and (best is None or abs(A[i][j]) < abs(A[best[0]][best[1]])):
                        best = (i, j)
            if best is None:
                return [A[i][i] for i in range(t)], U
            i, j = best
            A[t], A[i] = A[i], A[t]; U[t], U[i] = U[i], U[t]
            for row in A: row[t], row[j] = row[j], row[t]
            done = True
            for i in range(t + 1, m):  # clear column t (row operations, tracked in U)
                q = A[i][t] // A[t][t]
                if q:
                    A[i] = [a - q * b for a, b in zip(A[i], A[t])]
                    U[i] = [a - q * b for a, b in zip(U[i], U[t])]
                if A[i][t]: done = False
            for j in range(t + 1, n):  # clear row t (column operations)
                q = A[t][j] // A[t][t]
                if q:
                    for row in A: row[j] -= q * row[t]
                if A[t][j]: done = False
            if not done:
                continue
            # divisibility: every remaining entry must be a multiple of the pivot
            bad = next(((i, j) for i in range(t + 1, m) for j in range(t + 1, n) if A[i][j] % A[t][t]), None)
            if bad:
                i = bad[0]
                A[t] = [a + b for a, b in zip(A[t], A[i])]
                U[t] = [a + b for a, b in zip(U[t], U[i])]
                continue
            if A[t][t] < 0:
                A[t] = [-a for a in A[t]]; U[t] = [-a for a in U[t]]
            break
    return [A[i][i] for i in range(min(m, n))], U


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw30", action="store_true")
    ap.add_argument("--src", default="separate")
    a = ap.parse_args()
    d = json.loads((ROOT / "data" / f"{a.src}.json").read_text())
    R = {r["id"]: r for r in B.RECIPES}; R["Phase5Sink"] = B.SINK
    recs = [R[i] for i in d["recipes"]]
    items, nets, cls, *_ = B.model(recs, open_usable=True)
    g = set(d["groups"][0])
    J = [j for j, n in enumerate(nets) if any(k in g for k in n)]
    sub = [recs[j] for j in J]
    sn = [nets[j] for j in J]
    W = len(J)
    def introw(k):
        col = {x: sn[x][k] for x in range(W) if sn[x].get(k)}
        L = 1
        for v in col.values(): L = L * v.denominator // math.gcd(L, v.denominator)
        return {x: int(v * L) for x, v in col.items()}, L
    rows = [introw(k)[0] for k in sorted(g)]
    aux = 0
    if a.raw30:
        raws = sorted({k for n in sn for k in n if cls.get(k) == "raw"})
        for k in raws:
            r, L = introw(k)
            r[W + aux] = -30 * L; aux += 1
            rows.append(r)
    K = kernel(rows, W + aux)
    K = [v[:W] for v in K]
    # forced recipes: sole producers of a group item; the rest are outputs
    prod = {}
    for k in g:
        p = [x for x in range(W) if sn[x].get(k, 0) > 0]
        if len(p) == 1: prod[k] = p[0]
    forced = sorted(set(prod.values()))
    F = [x for x in range(W) if x not in forced]
    print(f"group: {len(g)} equations, {W} recipes, {len(forced)} forced, {len(F)} outputs, kernel rank {len(K)}")
    # projection onto outputs is injective iff kernel rank == len(F)
    PF = hnf_basis([[v[x] for x in F] for v in K], len(F))
    over = {}
    for k, x in prod.items(): over.setdefault(x, []).append(k)
    for x, ks in over.items():
        if len(ks) > 1: print("  forced twice:", sub[x]["name"], "by", ks)
    for k in g:
        if k not in prod: print("  several producers:", k)
    Bm = [list(r) for r in zip(*PF)]  # columns = basis vectors
    diag, U = smith(Bm)
    rnk = len(diag)
    index = math.prod(diag)
    inv = [x for x in diag if x != 1]
    print("rank %d in %d outputs; torsion index %d, invariant factors %s" % (rnk, len(F), index, inv))
    names = [sub[x]["name"] for x in F]
    equal = []
    for i in range(rnk, len(F)):
        row = U[i]; gg = 0
        for c in row: gg = math.gcd(gg, c)
        row = [c // gg for c in row] if gg else row
        equal.append({names[f]: row[f] for f in range(len(F)) if row[f]})
        print("  equation: " + " + ".join(f"{v}·[{k}]" for k, v in equal[-1].items()) + " = 0")
    # congruences: (U n)_i == 0 mod d_i for d_i > 1
    congr = []
    for i, di in enumerate(diag):
        if di == 1: continue
        coef = [c % di for c in U[i]]
        congr.append({"mod": di, "terms": {names[f]: coef[f] for f in range(len(F)) if coef[f]}})
    # per-output steps
    import numpy as np  # noqa
    Binv = None
    # solve Bm c = k e_f exactly with fractions: Gaussian elimination on the triangular basis
    n = len(F)
    steps = []
    pivots = [next(c for c in range(n) if row[c]) for row in PF]
    for f in range(n):
        # rational c with sum_r c_r PF[r] = e_f, if e_f is in the span (PF in echelon form)
        resid = [Fraction(int(i == f)) for i in range(n)]
        c = []
        for row, pc in zip(PF, pivots):
            cr = resid[pc] / row[pc]
            c.append(cr)
            for col in range(n): resid[col] -= cr * row[col]
        if any(resid):
            solo = 0  # this output cannot run alone: an equation ties it to others
        else:
            solo = 1
            for x in c: solo = solo * x.denominator // math.gcd(solo, x.denominator)
        free = 0
        for v in PF: free = math.gcd(free, v[f])
        steps.append({"recipe": names[f], "id": sub[F[f]]["id"], "solo": solo, "free": free})
    steps.sort(key=lambda s: -s["solo"])
    for s in steps:
        print(f"  {s['recipe']:<42} solo step {s['solo'] or 'tied':>8}   free step {s['free']}")
    for c in congr:
        print(f"  mod {c['mod']}: " + " + ".join(f"{v}·[{k}]" for k, v in c["terms"].items()) + " == 0")
    out = {"raw30": a.raw30, "group": sorted(g), "recipes": [r["id"] for r in sub],
           "forced": [sub[x]["id"] for x in forced], "outputs": [sub[x]["id"] for x in F],
           "index": index, "invariant_factors": inv, "congruences": congr, "equations": equal, "steps": steps}
    name = "output_lattice" + ("" if a.src == "separate" else "_" + a.src) + ("_raw30" if a.raw30 else "")
    (ROOT / "data" / f"{name}.json").write_text(json.dumps(out, indent=1))
    print("wrote data/%s.json" % name)


if __name__ == "__main__":
    main()
