#!/usr/bin/env python3
"""Nice clocks for the top of the tenth-world factory (the planner's starting table).

Looks for machine counts and clocks for the recipes at the top of the chain such that
  * the four Phase 5 parts come out in exact proportion (1000 : 1000 : 256 : 200),
    finishing in T minutes;
  * Singularity Cells are made at exactly the rate used (Main Portal 2/min,
    Ficsonium, Ballistic Warp Drive) and Alien Power Matrix at exactly 5/min;
  * Dark Matter Residue and Excited Photonic Matter balance exactly;
  * every other part is made at least as fast as it is used (plus the build need of
    Superposition Oscillators and Neural-Quantum Processors), with little waste;
  * some power shards are left over after the Alien Power Matrix and Ionized Fuel;
  * every clock is "nice".

A row at level L (machines at 100 %) runs on n = ceil(L) machines at clock L / n.
Nice = small denominator of that clock as a fraction (92.5 % = 37/40 has 40), and
only denominators made of 2s and 5s, because the game sets clocks in steps of
0.0001 %: 2/3 cannot be typed in exactly, and an inexact clock breaks a fluid balance.
Solutions are ranked by the largest denominator, then the sum of denominators,
then how far the clocks are from 100 %.

The nuclear chain is fixed by one Ficsonium reactor and is already nice:
Ficsonium Fuel Rod 40 %, Ficsonium 20 %, 2 Plutonium plants, Plutonium Fuel Rod
80 %, 2 Encased Plutonium Cell at 60 %, Plutonium Pellet 40 %, Non-Fissile Uranium
80 %, 4 Uranium plants.

Usage: python3 tools/nice_top.py [--tmin 300] [--tmax 520] [--top 5]
Exact rational arithmetic throughout (fractions); a run takes a minute or two.
"""
import argparse, bisect, math, sys
from fractions import Fraction as F
from itertools import product

STOCK_SPO, STOCK_NQP, STOCK_PIF = 215, 30, 100   # bill of materials: oscillators, processors; packaged ionized fuel


def split(L):
    """(machines, clock) for level L."""
    n = max(1, math.ceil(L))
    return n, L / n


def smooth(q):
    """True if q has no prime factor other than 2 and 5: the game sets clocks in steps of
    0.0001 %, so only such a clock can be typed in exactly (2/3 = 66.6667 % cannot)."""
    for p in (2, 5):
        while q % p == 0:
            q //= p
    return q == 1


def den(L):
    """Denominator of the clock of level L; a very large number if the game cannot set it exactly."""
    if L <= 0:
        return 1
    q = split(L)[1].denominator
    return q if smooth(q) else 10 ** 9


def nice_levels(lo, hi, maxden):
    """Levels in [lo, hi] whose clock has denominator <= maxden, nicest first."""
    out = set()
    for n in range(max(1, math.ceil(lo)), math.ceil(hi) + 1):
        for q in range(1, maxden + 1):
            if not smooth(q):
                continue
            for p in range(1, q + 1):
                L = F(n * p, q)
                if lo <= L <= hi and math.ceil(L) == n:
                    out.add(L)
    return sorted(out, key=lambda L: (den(L), L))


def pick(req, slack, maxden=40):
    """The nicest level >= req with at most `slack` relative surplus; exact if nothing nicer."""
    c = nice_levels(req, req * (1 + slack), maxden)
    best = c[0] if c else req
    return best if den(best) < den(req) else req


def solve(T, opts, maxden):
    T = F(T)
    L = {"Ballistic Warp Drive": 200 / T, "Biochemical Sculptor": 500 / T, "AI Expansion Server": 64 / T,
         "Singularity Cell": F(2, 5) + 100 / T, "Alien Power Matrix": F(2)}
    L["Nuclear Pasta"] = (1000 / T + L["Singularity Cell"]) * 2
    exact = list(L)
    worst = max(den(v) for v in L.values())
    if worst > maxden:
        return []
    # followers: at least what is used, nicest within the slack
    L["Pressure Conversion Cube"] = pick(L["Nuclear Pasta"] / 2, opts.slack)
    L["Assembly Director System"] = pick(L["Biochemical Sculptor"] * F(2, 3), opts.slack)
    L["Adaptive Control Unit"] = pick(L["Assembly Director System"] * F(3, 2), opts.slack)
    L["Thermal Propulsion Rocket"] = pick(L["Ballistic Warp Drive"], opts.slack)
    L["Modular Engine"] = pick(L["Thermal Propulsion Rocket"] * F(5, 2), opts.slack)
    L["Magnetic Field Generator"] = pick(256 / T, opts.slack)
    aies, bwd, sing = L["AI Expansion Server"], L["Ballistic Warp Drive"], L["Singularity Cell"]
    spo_req = (15 + 2 * bwd + 4 * aies + STOCK_SPO / T) / 5
    nqp_req = (4 * aies + STOCK_NQP / T) / 3
    if_req = 2 * F(STOCK_PIF, 40) / T      # Ionized Fuel level for the packaged-fuel stock
    spo_c = nice_levels(spo_req, spo_req * F(11, 10), maxden)[:opts.wide]
    nqp_c = nice_levels(nqp_req, nqp_req + F(1, 6), maxden)[:opts.wide]         # up to 0.5 /min spare
    if_c = [v for v in nice_levels(if_req, F(1, 5), 50) if v.denominator in (10, 20, 25, 40, 50)][:4]
    dm_c = nice_levels(F(1, 100), 6, opts.dmden)
    zero = [F(0)]
    dm_v = sorted(zero + [v for v in dm_c if v <= 3])
    found = []
    # stage 1: the encoder rows, kept only where Photonic Matter comes out nice
    stage = []
    for spo, nqp, lif in product(spo_c, nqp_c, if_c):
        sps_c = nice_levels((15 + F(5, 2) * lif + opts.shards[0]) / 5, (15 + F(5, 2) * lif + opts.shards[1]) / 5, maxden)[:opts.wide]
        for sps in sps_c:
            byp = 125 * spo + 75 * nqp + 100 * aies + 20 + 120 + 60 * sps     # residue from the encoders
            epm = byp / 200                                                   # photonic matter they take
            if den(epm) > opts.fluidden:
                continue
            ds = [den(v) for v in (spo, nqp, lif, sps, epm)]
            stage.append(((max(ds), sum(ds)), spo, nqp, lif, sps, byp, epm))
    stage.sort(key=lambda t: t[0])
    # stage 2: the Dark Matter recipes for the best of those
    for _, spo, nqp, lif, sps, byp, epm in stage[:opts.keep]:
        if True:
            want = 30 * spo + 20 * sing + 40 * bwd + 10 * sps                 # crystals used
            for a, b in product(dm_c, dm_c + zero):
                if a > 6 or b > 3:
                    continue
                base = 30 * a + 60 * b - want
                if base > opts.crystals or base + 60 < 0:
                    continue
                # Crystallization levels that leave 0 .. opts.crystals spare crystals
                for c in dm_v[bisect.bisect_left(dm_v, -base / 20):bisect.bisect_right(dm_v, (opts.crystals - base) / 20)]:
                    spare = base + 20 * c
                    r = (40 + 150 * a + 150 * b + 200 * c - byp) / 100         # Dark Matter Residue converter
                    if r < 0 or den(r) > opts.fluidden or (r > 0 and c > 0 and not opts.both):
                        continue
                    rows = dict(L)
                    rows.update({"Superposition Oscillator": spo, "Neural-Quantum Processor": nqp, "Ionized Fuel": lif,
                                 "Packaged Ionized Fuel": lif / 2, "Synthetic Power Shard": sps, "Excited Photonic Matter": epm,
                                 "Dark Matter Crystal": a, "Dark Matter Trap": b, "Dark Matter Crystallization": c,
                                 "Dark Matter Residue": r})
                    ds = [den(v) for k, v in rows.items() if v > 0 and k != "Packaged Ionized Fuel"]
                    score = (max(ds), sum(ds), float(sum(1 - split(v)[1] for v in rows.values() if v > 0)))
                    info = {"T": T, "crystals spare": spare, "shards spare": 5 * sps - 15 - F(5, 2) * lif,
                            "NQP spare": 3 * nqp - 4 * aies, "SPO spare": 5 * spo - 15 - 2 * bwd - 4 * aies,
                            "ionized fuel": 40 * lif}
                    found.append((score, rows, info))
    found.sort(key=lambda t: t[0])
    return found[:opts.top]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tmin", type=float, default=300)
    ap.add_argument("--tmax", type=float, default=520)
    ap.add_argument("--maxden", type=int, default=40, help="largest clock denominator allowed anywhere")
    ap.add_argument("--dmden", type=int, default=10, help="largest denominator tried for the Dark Matter recipes")
    ap.add_argument("--slack", type=float, default=0.2, help="surplus allowed on parts that only have to keep up")
    ap.add_argument("--shards", type=float, nargs=2, default=[0.5, 2.5], help="spare power shards per minute, lowest and highest")
    ap.add_argument("--crystals", type=float, default=10, help="most spare Dark Matter Crystals per minute")
    ap.add_argument("--both", action="store_true", help="allow the Residue converter and Crystallization to run together")
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--wide", type=int, default=1000, help="how many nice levels to try for each free row")
    ap.add_argument("--keep", type=int, default=150, help="how many encoder combinations go on to the Dark Matter stage")
    ap.add_argument("--fluidden", type=int, default=40, help="largest denominator allowed for the two rows that the fluid balances decide")
    ap.add_argument("--times", type=int, default=8, help="how many build times to search, nicest exact rows first")
    opts = ap.parse_args()
    opts.slack = F(opts.slack).limit_denominator(100)
    opts.shards = [F(v).limit_denominator(100) for v in opts.shards]
    # candidate build times: 100 / T with a small denominator makes the exact rows nice
    Ts = sorted({F(100 * m, j) for m in range(1, 41) for j in range(1, 60)
                 if opts.tmin <= 100 * m / j <= opts.tmax})
    def exact_score(T):
        v = [200 / T, 500 / T, 64 / T, F(2, 5) + 100 / T, (1000 / T + F(2, 5) + 100 / T) * 2]
        return (max(map(den, v)), sum(map(den, v)))
    Ts = sorted((T for T in Ts if exact_score(T)[0] <= opts.maxden), key=exact_score)[:opts.times]
    print("build times tried (nicest exact rows first): " + ", ".join(str(T) for T in Ts))
    allf = []
    for T in Ts:
        allf += solve(T, opts, opts.maxden)
    allf.sort(key=lambda t: t[0])
    seen = set()
    for score, rows, info in allf:
        key = tuple(sorted(rows.items()))
        if key in seen:
            continue
        seen.add(key)
        print("\nT = %s min (%.1f): largest denominator %d, sum %d" % (info["T"], float(info["T"]), score[0], score[1]))
        print("   " + ", ".join("%s %.3g /min" % (k, float(v)) for k, v in info.items() if k != "T"))
        for k, v in rows.items():
            if v > 0:
                n, c = split(v)
                print("   %2d x %-8s %-28s (%s)" % (n, ("%.4f" % float(100 * c)).rstrip("0").rstrip(".") + " %", k, c))
        if len(seen) >= opts.top:
            break
    return 0


if __name__ == "__main__":
    sys.exit(main())
