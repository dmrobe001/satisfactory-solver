/* Lattice clocks: which effective clocks each recipe can take.
 *
 * Pure logic, no DOM; runs in the browser (window.SatLattice) and in node.
 *
 * Model
 *   y[r]  effective clock of recipe r (machines x clock) in units of 0.0001 %,
 *         i.e. 1 000 000 = one machine at 100 %.  Always a whole number.
 *   Items fall in four classes:
 *     raw        extracted (miners, extractors, wells): net = -15 m per min,
 *                m a whole number >= 0
 *     gathered   picked up by hand: net <= 0, any amount
 *     free       used by some build-gun recipe or as equipment: net >= 0
 *     internal   everything else: net = 0
 *   Power is ignored.  Recipes with a fixed clock (Alien Power Augmenter,
 *   Main Portal) take whole machines only: y = 1 000 000 x n.
 *
 * The whole-number conditions (internal balances, raw multiples of 15, whole
 * machines) define a lattice L of y vectors.  The sign conditions define a
 * polyhedral cone.  Pins (y[r] = v) cut both.  For each recipe we report
 *   offset, step   y[r] can only be offset + step x k  (exact; from L)
 *   lo, hi         y[r] range over the cone (linear programming, so integer
 *                  points near the ends of the range are not guaranteed)
 */
(function (root) {
  "use strict";
  const UNIT = 1000000n;          // y units per machine at 100 %
  const RAW_STEP = 15n;           // resources come in multiples of 15 per minute
  const MACHINE = 2500000n;       // one machine at 250 %
  const EXPENDABLE = ["CartridgeStandard", "CartridgeSmartProjectile", "CartridgeChaos",
    "SpikedRebar", "Rebar_Stunshot", "Rebar_Spreadshot", "Rebar_Explosive",
    "NobeliskExplosive", "NobeliskGas", "NobeliskShockwave", "NobeliskCluster", "NobeliskNuke",
    "Filter", "HazmatFilter", "Biofuel", "Fuel", "TurboFuel", "PackagedBiofuel", "PackagedRocketFuel",
    "PackagedIonizedFuel", "Battery"];
  const IN_SCOPE = { machine: 1, burn: 1, augment: 1, manual: 1 };
  const EXTRACT = { miner: 1, extractor: 1, well: 1 };

  const abs = (a) => (a < 0n ? -a : a);
  const gcd = (a, b) => { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a; };
  const mod = (a, m) => ((a % m) + m) % m;

  /* Best rational p/q (q <= 1000) for a float rate; exact for every rate in the data. */
  function frac(x) {
    let h0 = 0, h1 = 1, k0 = 1, k1 = 0, v = x;
    for (let i = 0; i < 40; i++) {
      const a = Math.floor(v);
      const h2 = a * h1 + h0, k2 = a * k1 + k0;
      if (k2 > 1000) break;
      h0 = h1; h1 = h2; k0 = k1; k1 = k2;
      if (Math.abs(h1 / k1 - x) < 1e-9 * Math.max(1, Math.abs(x))) break;
      v = 1 / (v - a);
    }
    if (Math.abs(h1 / k1 - x) > 1e-6 * Math.max(1, Math.abs(x))) throw new Error("no small fraction for " + x);
    return [BigInt(h1), BigInt(k1)];
  }

  function Lattice(game, opts) {
    opts = opts || {};
    this.game = game;
    const xmasOn = !!opts.ficsmas;
    this.ficsmas = xmasOn;
    const R = game.recipes.filter((r) => Lattice.inScope(r) && (xmasOn || !r.xmas));
    this.R = R;
    this.rIdx = {};
    R.forEach((r, i) => (this.rIdx[r.id] = i));
    this.fixed = R.map((r) => r.mc <= 1);

    // item classes
    const cls = {};
    for (const r of game.recipes) if (EXTRACT[r.kind]) for (const [k] of r.outs) cls[k] = "raw";
    for (const r of game.recipes) if (r.kind === "gather") for (const [k] of r.outs) if (!cls[k]) cls[k] = "gathered";
    const freeSet = new Set(EXPENDABLE);
    for (const b of Object.values(game.buildings)) if (xmasOn || !b.xmas) for (const [k] of b.cost) freeSet.add(k);
    const used = new Set();
    R.forEach((r) => r.ins.concat(r.outs).forEach(([k]) => used.add(k)));
    used.delete("Power");
    for (const k of used) if (!cls[k]) cls[k] = freeSet.has(k) ? "free" : "internal";
    this.defaultCls = Object.assign({}, cls);
    // user overrides: internal <-> free only
    for (const [k, v] of Object.entries(opts.overrides || {})) if ((cls[k] === "internal" || cls[k] === "free") && (v === "internal" || v === "free")) cls[k] = v;
    this.cls = cls;
    this.items = [...used].sort();
    this.iIdx = {};
    this.items.forEach((k, i) => (this.iIdx[k] = i));

    // exact per-minute rates at 100 %: rows[i] = [[r, num, den], ...] net production
    const rows = this.items.map(() => new Map());
    R.forEach((r, j) => {
      const addF = (k, v, sign) => {
        if (k === "Power") return;
        const m = rows[this.iIdx[k]];
        const [p, q] = frac(v);
        const old = m.get(j) || [0n, 1n];
        const nn = old[0] * q + sign * p * old[1], dd = old[1] * q;
        const g = gcd(nn, dd) || 1n;
        m.set(j, [nn / g, dd / g]);
      };
      r.ins.forEach(([k, v]) => addF(k, v, -1n));
      r.outs.forEach(([k, v]) => addF(k, v, 1n));
    });
    this.rates = rows.map((m) => [...m.entries()].filter(([, [p]]) => p !== 0n));
    this._buildLattice();
  }

  /* Integer row for item i, scaled so all coefficients are whole: returns [coefs Map j->BigInt, scale D]. */
  Lattice.prototype._intRow = function (i) {
    let D = 1n;
    for (const [, [, q]] of this.rates[i]) D = (D * q) / gcd(D, q);
    const m = new Map();
    for (const [j, [p, q]] of this.rates[i]) m.set(j, (p * D) / q);
    return [m, D];
  };

  /* Basis of L by column reduction: start from the unit vectors (plus one slack per
   * congruence) and, constraint by constraint, combine the basis vectors with
   * unimodular moves until only one has a nonzero value, then drop it. */
  Lattice.prototype._buildLattice = function () {
    const NR = this.R.length;
    const cons = []; // {coef: Map(var -> BigInt)}; vars >= NR are slacks
    let nv = NR;
    this.items.forEach((k, i) => {
      const c = this.cls[k];
      if (c !== "internal" && c !== "raw") return;
      const [m] = this._intRow(i);
      if (!m.size) return;
      if (c === "raw") {
        // sum (D a) y = D * 15e6 * s  <=>  net flow is a multiple of 15 per minute
        const [, D] = this._intRow(i);
        m.set(nv++, -D * RAW_STEP * UNIT);
      }
      cons.push(m);
    });
    this.R.forEach((r, j) => { if (this.fixed[j]) { const m = new Map([[j, 1n], [nv++, -UNIT]]); cons.push(m); } });
    cons.sort((a, b) => a.size - b.size);
    // basis vectors as sparse Maps var -> BigInt
    let basis = [];
    for (let v = 0; v < nv; v++) basis.push(new Map([[v, 1n]]));
    for (const row of cons) basis = reduceOn(basis, (b) => dotRow(row, b), null).rest;
    // project onto the recipe coordinates (injective: slacks are determined by y)
    this.basis0 = basis.map((b) => { const m = new Map(); for (const [v, x] of b) if (v < NR && x) m.set(v, x); return m; })
      .filter((b) => b.size);
    this.dim = this.basis0.length;
  };

  function dotRow(row, b) {
    let s = 0n;
    if (row.size < b.size) { for (const [v, c] of row) { const x = b.get(v); if (x) s += c * x; } }
    else for (const [v, x] of b) { const c = row.get(v); if (c) s += c * x; }
    return s;
  }
  function axpy(a, k, b) { // a += k * b (in place)
    for (const [v, x] of b) {
      const n = (a.get(v) || 0n) + k * x;
      if (n) a.set(v, n); else a.delete(v);
    }
  }

  /* Combine basis vectors so at most one has a nonzero value under f.
   * Returns { pivot: vector with value g (or null), g, rest: vectors with value 0 }. */
  function reduceOn(basis, f) {
    const zero = [], live = [];
    for (const b of basis) { const v = f(b); if (v) live.push([b, v]); else zero.push(b); }
    while (live.length > 1) {
      // smallest |value| first
      let mi = 0;
      for (let i = 1; i < live.length; i++) if (abs(live[i][1]) < abs(live[mi][1])) mi = i;
      const [pb, pv] = live[mi];
      const next = [[pb, pv]];
      for (let i = 0; i < live.length; i++) {
        if (i === mi) continue;
        const [b, v] = live[i];
        const q = v / pv; // truncating division
        if (q) axpy(b, -q, pb);
        const nvv = v - q * pv;
        if (nvv) next.push([b, nvv]); else zero.push(b);
      }
      live.length = 0; live.push(...next);
    }
    if (!live.length) return { pivot: null, g: 0n, rest: zero };
    let [pb, g] = live[0];
    if (g < 0n) { for (const [v, x] of pb) pb.set(v, -x); g = -g; }
    return { pivot: pb, g, rest: zero };
  }

  /* ---- pins ---------------------------------------------------------------- */
  Lattice.prototype.clone0 = function () {
    return { y0: new Map(), basis: this.basis0.map((b) => new Map(b)) };
  };

  /* Apply y[r] = v to an affine lattice state {y0, basis}.  Returns the new state, or
   * {error, step, offset} when v is not of the form offset + step*k. */
  function pinState(st, r, v) {
    const { pivot, g, rest } = reduceOn(st.basis.map((b) => new Map(b)), (b) => b.get(r) || 0n);
    const cur = st.y0.get(r) || 0n;
    if (!pivot) {
      if (cur === v) return { y0: st.y0, basis: rest };
      return { error: true, step: 0n, offset: cur };
    }
    if ((v - cur) % g !== 0n) return { error: true, step: g, offset: mod(cur, g) };
    const y0 = new Map(st.y0);
    axpy(y0, (v - cur) / g, pivot);
    return { y0, basis: rest };
  }

  /* Lattice state after all pins (Map r -> BigInt), applied in order. */
  Lattice.prototype.state = function (pins) {
    let st = this.clone0();
    for (const [r, v] of pins) {
      const ns = pinState(st, r, v);
      if (ns.error) return Object.assign(ns, { r, failed: true });
      st = ns;
    }
    return st;
  };

  /* step and offset of every recipe under a state: y[r] in offset + step*Z (step 0: fixed). */
  Lattice.prototype.progressions = function (st) {
    const NR = this.R.length;
    const step = new Array(NR).fill(0n);
    for (const b of st.basis) for (const [v, x] of b) step[v] = gcd(step[v], x);
    return step.map((g, r) => {
      const o = st.y0.get(r) || 0n;
      return { step: g, offset: g ? mod(o, g) : o };
    });
  };

  Lattice.prototype.pinCheck = function (st, r, v) { return pinState(st, r, v); };

  /* Machine rule.  One machine may run at any clock up to 250 %.  With two or
   * more, every machine runs at the same clock, a whole number of 0.0001 %
   * steps, and at least minPer (a setting; null = only the fewest machines,
   * ceil(y / 250 %), are allowed).  split(y) returns the fewest machines that
   * work, or null. */
  let minPer = 1000000n; // 100 %
  Lattice.setMinPer = (v) => { minPer = v === null ? null : (v < 10000n ? 10000n : v > MACHINE ? MACHINE : v); };
  Lattice.getMinPer = () => minPer;
  Lattice.machinesFor = (y) => (y <= 0n ? 0n : (y + MACHINE - 1n) / MACHINE);
  Lattice.split = function (y) {
    if (y <= 0n) return 0n;
    if (y <= MACHINE) return 1n;
    const n0 = Lattice.machinesFor(y);
    const n1 = minPer === null ? n0 : y / minPer;
    for (let n = n0, i = 0; n <= n1 && i < 2000000; n++, i++) if (y % n === 0n) return n;
    return null;
  };
  Lattice.machineOK = (y) => Lattice.split(y) !== null;

  /* Smallest y >= from (and > 0) in offset + step*Z that passes the machine rule. */
  Lattice.smallest = function (offset, step, from, limit) {
    if (step === 0n) return offset > 0n && offset >= from && Lattice.machineOK(offset) ? offset : null;
    let y = from <= 0n ? 1n : from;
    y = y + mod(offset - y, step);
    for (let i = 0; i < (limit || 100000); i++, y += step) if (Lattice.machineOK(y)) return y;
    return null;
  };

  /* ---- linear programming ------------------------------------------------
   * Dense two-phase simplex with Bland's rule (the cone constraints are
   * homogeneous, so the problems are heavily degenerate and cycling is a
   * real risk).  maximize c.x  s.t.  rows (a: dense array, s: "<=", ">=", "=", b),
   * x >= 0.  Returns {status: "optimal"|"infeasible"|"unbounded", x, value}. */
  function simplex(n, rows, c) {
    const EPS = 1e-9, PIV = 1e-8;
    const m = rows.length;
    // normalise to b >= 0 and scale each row to max |a| = 1
    const R = rows.map(({ a, s, b }) => {
      let mx = 0; for (const v of a) if (Math.abs(v) > mx) mx = Math.abs(v);
      const k = (b < 0 ? -1 : 1) / (mx || 1);
      return { a: a.map((v) => v * k), s: b < 0 ? (s === "<=" ? ">=" : s === ">=" ? "<=" : "=") : s, b: b * k };
    });
    let nSlack = 0, nArt = 0;
    for (const r of R) { if (r.s !== "=") nSlack++; if (r.s !== "<=") nArt++; }
    const W = n + nSlack + nArt + 1, RHS = W - 1;
    const T = []; const basis = new Int32Array(m);
    let si = n, ai = n + nSlack;
    const isArt = new Uint8Array(W);
    R.forEach((r, i) => {
      const row = new Float64Array(W);
      for (let j = 0; j < n; j++) row[j] = r.a[j] || 0;
      row[RHS] = r.b;
      if (r.s === "<=") { row[si] = 1; basis[i] = si++; }
      else { if (r.s === ">=") row[si++] = -1; row[ai] = 1; isArt[ai] = 1; basis[i] = ai++; }
      T.push(row);
    });
    const obj = new Float64Array(W); // reduced costs d_j (maximize: enter when d_j > 0)
    function setObjective(cost) {
      obj.fill(0);
      for (let j = 0; j < W - 1; j++) obj[j] = cost[j] || 0;
      obj[RHS] = 0;
      for (let i = 0; i < m; i++) {
        const cb = cost[basis[i]] || 0;
        if (!cb) continue;
        const row = T[i];
        for (let j = 0; j < W; j++) if (row[j]) obj[j] -= cb * row[j];
      }
    }
    function pivot(pr, pc) {
      const prow = T[pr], pv = prow[pc];
      const nz = [];
      for (let j = 0; j < W; j++) if (prow[j] !== 0) { prow[j] /= pv; nz.push(j); }
      prow[pc] = 1;
      for (let i = 0; i < m; i++) {
        if (i === pr) continue;
        const row = T[i], f = row[pc];
        if (f === 0) continue;
        for (const j of nz) row[j] -= f * prow[j];
        row[pc] = 0;
      }
      const f = obj[pc];
      if (f !== 0) { for (const j of nz) obj[j] -= f * prow[j]; obj[pc] = 0; }
      basis[pr] = pc;
    }
    function run(allow) {
      let degen = 0, bland = false;
      for (let it = 0; it < 20000; it++) {
        if (degen > 30) bland = true; // stays on: once cycling is suspected, finish with Bland's rule
        let enter = -1, best = EPS;
        for (let j = 0; j < W - 1; j++) {
          if (!allow(j) || obj[j] <= EPS) continue;
          if (bland) { enter = j; break; }
          if (obj[j] > best) { best = obj[j]; enter = j; }
        }
        if (enter < 0) return "optimal";
        // Harris two-pass ratio test
        let minR = Infinity;
        for (let i = 0; i < m; i++) { const a = T[i][enter]; if (a > PIV) { const r = (Math.max(0, T[i][RHS]) + 1e-12) / a; if (r < minR) minR = r; } }
        if (minR === Infinity) return "unbounded";
        let leave = -1, bestA = 0;
        for (let i = 0; i < m; i++) {
          const a = T[i][enter];
          if (a <= PIV || Math.max(0, T[i][RHS]) / a > minR) continue;
          if (bland ? (leave < 0 || basis[i] < basis[leave]) : a > bestA) { bestA = a; leave = i; }
        }
        degen = T[leave][RHS] / T[leave][enter] < 1e-12 ? degen + 1 : 0;
        pivot(leave, enter);
      }
      return "iterations";
    }
    if (isArt.some((x) => x)) {
      const anyB = R.some((r) => r.s !== "<=" && r.b > 0);
      if (anyB) {
        const c1 = new Float64Array(W); for (let j = 0; j < W - 1; j++) if (isArt[j]) c1[j] = -1;
        setObjective(c1);
        const st = run(() => true);
        if (st === "iterations") return { status: st };
        let infeas = 0;
        for (let i = 0; i < m; i++) if (isArt[basis[i]]) infeas += T[i][RHS];
        if (infeas > 1e-7) return { status: "infeasible" };
      }
      // drive zero-level artificials out of the basis where possible
      for (let i = 0; i < m; i++) {
        if (!isArt[basis[i]]) continue;
        let bj = -1, bv = 1e-9;
        for (let j = 0; j < n + nSlack; j++) if (Math.abs(T[i][j]) > bv) { bv = Math.abs(T[i][j]); bj = j; }
        if (bj >= 0) pivot(i, bj);
      }
    }
    const c2 = new Float64Array(W); for (let j = 0; j < n; j++) c2[j] = c[j] || 0;
    setObjective(c2);
    const st = run((j) => !isArt[j]);
    if (st !== "optimal") return { status: st };
    const x = new Float64Array(n);
    for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = Math.max(0, T[i][RHS]);
    let value = 0; for (let j = 0; j < n; j++) value += (c[j] || 0) * x[j];
    return { status: "optimal", x, value };
  }
  Lattice.simplex = simplex;

  /* Cone rows over a compact set of recipe variables (cols: recipe index per column), plus pins. */
  Lattice.prototype._coneRows = function (cols, width, pinsF, scale) {
    scale = scale || 1;
    if (!this._rowsF) {
      this._rowsF = this.items.map((k, i) => {
        const c = this.cls[k];
        const a = [];
        for (const [j, [p, q]] of this.rates[i]) a.push([j, Number(p) / Number(q)]);
        return { a, s: c === "internal" ? "=" : c === "free" ? ">=" : "<=" };
      });
    }
    const pos = new Map(cols.map((r, j) => [r, j]));
    const rows = [];
    // The cone is homogeneous, so every vertex is massively degenerate and the
    // simplex stalls.  Each zero right-hand side is moved outwards by a small
    // random amount (about 1e-7 machine, 0.00001 %); equalities become a narrow
    // two-sided band.  Fixed seed, so results are reproducible.
    let seed = 12345;
    const eps = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return scale * 1e-7 * (1 + seed / 0x7fffffff); };
    for (const { a, s } of this._rowsF) {
      const d = new Array(width).fill(0); let any = false;
      for (const [r, v] of a) { const j = pos.get(r); if (j !== undefined) { d[j] = v; any = true; } }
      if (!any) continue;
      if (s === "<=") rows.push({ a: d, s, b: eps() });
      else if (s === ">=") rows.push({ a: d, s, b: -eps() });
      else { rows.push({ a: d, s: "<=", b: eps() }); rows.push({ a: d, s: ">=", b: -eps() }); }
    }
    for (const [r, v] of pinsF) { const j = pos.get(r); if (j === undefined) continue; const d = new Array(width).fill(0); d[j] = 1; rows.push({ a: d, s: "=", b: v }); }
    return rows;
  };

  /* Recipes (among cols) that can run with the pinned ones held at zero: the support
   * of the recession cone.  max sum t, t_r <= y_r, t_r <= 1.  Cached per pinned set. */
  Lattice.prototype._support = function (cols, pinned) {
    const key = cols.filter((r) => !pinned.has(r)).join(",");
    if (this._supKey === key) return this._sup;
    const free = cols.filter((r) => !pinned.has(r));
    const n = free.length;
    const rows = this._coneRows(free, 2 * n, new Map());
    for (let j = 0; j < n; j++) {
      const t = new Array(2 * n).fill(0); t[n + j] = 1; t[j] = -1; rows.push({ a: t, s: "<=", b: 0 });
      const u = new Array(2 * n).fill(0); u[n + j] = 1; rows.push({ a: u, s: "<=", b: 1 });
    }
    const c = new Array(2 * n).fill(0); for (let j = 0; j < n; j++) c[n + j] = 1;
    const s = simplex(2 * n, rows, c);
    const sup = new Set();
    if (s.status === "optimal") free.forEach((r, j) => { if (s.x[n + j] > 0.5) sup.add(r); });
    this._supKey = key; this._sup = sup;
    return sup;
  };

  /* Range of every recipe's effective clock (in machines) given pins (Map r -> machines).
   * skip: recipes known to be zero (left out of the programs).
   * Returns {feasible, lo, hi (Infinity when unbounded), grows: Set of recipes that can
   * still scale up freely}. */
  Lattice.prototype.ranges = function (pinsF, skip) {
    const NR = this.R.length;
    const lo = new Float64Array(NR), hi = new Float64Array(NR);
    const cols = [];
    for (let r = 0; r < NR; r++) if (!(skip && skip[r]) && !(pinsF.has(r) && pinsF.get(r) === 0)) cols.push(r);
    const n = cols.length;
    const rows = this._coneRows(cols, n, pinsF);
    const rows2 = this._coneRows(cols, n, pinsF, 2);
    /* The perturbation shifts an optimum linearly in its size, so solve at
     * sizes 1 and 2 and extrapolate to 0 (Richardson): b0 = 2 b(1) - b(2).
     * If the two disagree by more than a clock step the optimal vertex
     * changed between them; keep b(1). */
    const bound = (c, j) => {
      const a = simplex(n, rows, c), b = simplex(n, rows2, c); this.lastLPs += 2;
      if (a.status !== "optimal") return a.status === "unbounded" ? Infinity : 0;
      if (b.status !== "optimal" || Math.abs(a.x[j] - b.x[j]) > 1e-6) return a.x[j];
      return 2 * a.x[j] - b.x[j];
    };
    this.lastLPs = 1;
    const minSum = simplex(n, rows, new Array(n).fill(-1));
    if (minSum.status !== "optimal") return { feasible: false, lo, hi, grows: new Set() };
    const pinnedSet = new Set([...pinsF.keys()]);
    const grows = this._support(cols, pinnedSet);
    this.lastLPs++;
    cols.forEach((r, j) => {
      if (pinsF.has(r)) { lo[r] = hi[r] = pinsF.get(r); return; }
      if (minSum.x[j] > 1e-9) {
        const c = new Array(n).fill(0); c[j] = -1;
        lo[r] = bound(c, j);
      }
      if (grows.has(r)) hi[r] = Infinity;
      else {
        const c = new Array(n).fill(0); c[j] = 1;
        hi[r] = bound(c, j);
      }
    });
    // anything under half a clock step (1e-6 machine) is perturbation noise
    for (let r = 0; r < NR; r++) { if (lo[r] < 5e-7) lo[r] = 0; if (hi[r] < 5e-7) hi[r] = 0; }
    return { feasible: true, lo, hi, grows };
  };

  /* Everything the page shows, for pins Map(r -> BigInt units).
   * Returns {ok, reason?, rows: [{step, offset, lo, hi (BigInt|null = unbounded), run, smallest}]}. */
  Lattice.prototype.evaluate = function (pins) {
    const st = this.state(pins);
    if (st.failed) return { ok: false, reason: "lattice", r: st.r, step: st.step, offset: st.offset };
    const pr = this.progressions(st);
    const skip = pr.map((p) => (p.step === 0n && p.offset === 0n ? 1 : 0));
    const pinsF = new Map([...pins].map(([r, v]) => [r, Number(v) / 1e6]));
    const rg = this.ranges(pinsF, skip);
    if (!rg.feasible) return { ok: false, reason: "cone" };
    const rows = pr.map((p, r) => {
      // round to whole units, then pull each end onto the recipe's progression
      let lo = BigInt(Math.max(0, Math.ceil(rg.lo[r] * 1e6 - 0.5)));
      let hi = rg.hi[r] === Infinity ? null : BigInt(Math.max(0, Math.floor(rg.hi[r] * 1e6 + 0.5)));
      if (p.step > 0n) {
        lo = lo + mod(p.offset - lo, p.step);
        if (hi !== null) hi = hi - mod(hi - p.offset, p.step);
      }
      if (pins.has(r)) lo = hi = pins.get(r);
      if (p.step === 0n) lo = hi = p.offset;
      const run = hi === null || hi > 0n;
      let smallest = null;
      if (run) {
        if (this.fixed[r]) {
          const from = lo > 0n ? lo : 1n;
          if (p.step === 0n) smallest = p.offset > 0n ? p.offset : null;
          else { let y = from + mod(p.offset - from, p.step); if (hi === null || y <= hi) smallest = y; }
        } else {
          const y = Lattice.smallest(p.offset, p.step, lo > 0n ? lo : 1n);
          if (y !== null && (hi === null || y <= hi)) smallest = y;
        }
      }
      return { step: p.step, offset: p.offset, lo, hi, run, smallest };
    });
    return { ok: true, rows, dim: st.basis.length };
  };

  /* Parse a percentage with up to 4 decimals into units of 0.0001 % (BigInt), or null. */
  Lattice.parsePct = function (s) {
    const m = /^\s*(\d+)(?:\.(\d{0,4}))?\s*%?\s*$/.exec(String(s));
    if (!m) return null;
    return BigInt(m[1]) * 10000n + BigInt(((m[2] || "") + "0000").slice(0, 4));
  };
  Lattice.fmtPct = function (y) {
    const neg = y < 0n; if (neg) y = -y;
    const i = y / 10000n, f = (y % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
    return (neg ? "-" : "") + i.toLocaleString("en-US") + (f ? "." + f : "") + "%";
  };

  Lattice.UNIT = UNIT;
  Lattice.inScope = (r) => !!IN_SCOPE[r.kind] && (r.ins.length > 0 || r.outs.some(([k]) => k !== "Power"));
  Lattice.MACHINE = MACHINE;
  Lattice.gcd = gcd;

  if (typeof module !== "undefined" && module.exports) module.exports = Lattice;
  else root.SatLattice = Lattice;
})(typeof window !== "undefined" ? window : this);
