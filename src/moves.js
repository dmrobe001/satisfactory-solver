/* Machine moves: whole-machine factories that balance exactly, and the moves
 * between them.
 *
 * Pure logic, no DOM; window.SatMoves in the browser, module.exports in node.
 *
 * Model
 *   n[r]   whole number of machines of recipe r, each at a fixed clock c[r]
 *          (a rational, default 100 %).
 *   Items fall in classes:
 *     balance   net exactly 0 (fluids that are not raw, and products that are
 *               neither building materials nor equipment, unless turned into a
 *               valve)
 *     surplus   net >= 0 (building materials, equipment, Phase 5 parts; a
 *               "valve" can be closed to make one balance instead)
 *     raw       mined or extracted: net <= 0 (only drawn)
 *   With "lock Phase 5" the four parts are also held in exact proportion.
 *   The balance rows and the Phase 5 ratio are integer linear equations in n,
 *   so the valid n form an integer lattice L intersected with the cone of the
 *   inequalities.  A reduced basis of L (column reduction, then LLL) gives the
 *   moves: adding any integer combination of them to a valid n keeps every
 *   balance exact.
 */
(function (root) {
  "use strict";
  const EXTRACT = { miner: 1, extractor: 1, well: 1 };
  const EXPENDABLE = ["CartridgeStandard", "CartridgeSmartProjectile", "CartridgeChaos",
    "SpikedRebar", "Rebar_Stunshot", "Rebar_Spreadshot", "Rebar_Explosive",
    "NobeliskExplosive", "NobeliskGas", "NobeliskShockwave", "NobeliskCluster", "NobeliskNuke",
    "Filter", "HazmatFilter", "Biofuel", "Fuel", "TurboFuel", "PackagedBiofuel", "PackagedRocketFuel",
    "PackagedIonizedFuel", "Battery"];
  const PHASE5 = { SpaceElevatorPart_9: 1000, SpaceElevatorPart_10: 1000, SpaceElevatorPart_12: 256, SpaceElevatorPart_11: 200 };
  const babs = (a) => (a < 0n ? -a : a);
  const bgcd = (a, b) => { a = babs(a); b = babs(b); while (b) [a, b] = [b, a % b]; return a; };

  /* Best rational p/q (q <= 1000) for a rate; exact for every rate in the data. */
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
    return [BigInt(h1), BigInt(k1)];
  }
  /* Clock as an exact fraction of 100 %, from a percentage with up to 4 decimals. */
  function clockFrac(pct) {
    const s = String(pct).trim().replace(",", ".");
    const m = /^(\d+)(?:\.(\d{0,4}))?$/.exec(s);
    if (!m) return null;
    const dec = (m[2] || "");
    const num = BigInt(m[1] + dec.padEnd(4, "0"));
    let p = num, q = 1000000n; // pct * 10^4 / 10^6
    const g = bgcd(p, q) || 1n;
    p /= g; q /= g;
    if (p <= 0n || p > q * 5n / 2n) return null; // (0, 250 %]
    return [p, q];
  }

  function Moves(game, opts) {
    opts = opts || {};
    this.game = game;
    this.opts = opts;
    const byId = {};
    game.recipes.forEach((r) => (byId[r.id] = r));
    this.R = (opts.recipes || []).map((id) => byId[id]).filter((r) => r && !EXTRACT[r.kind] && r.kind !== "gather");
    this.rIdx = {};
    this.R.forEach((r, j) => (this.rIdx[r.id] = j));
    this.clock = this.R.map((r) => {
      const c = opts.clocks && opts.clocks[r.id];
      return (c && clockFrac(c)) || [1n, 1n];
    });
    this.clockPct = this.R.map((r, j) => Number(this.clock[j][0]) / Number(this.clock[j][1]) * 100);
    this.lockP5 = opts.lockP5 !== false;
    // item classes
    const raw = new Set(), bm = new Set(EXPENDABLE.concat(Object.keys(PHASE5)));
    for (const r of game.recipes) if (EXTRACT[r.kind]) for (const [k] of r.outs) raw.add(k);
    for (const b of Object.values(game.buildings)) if (!b.xmas) for (const [k] of b.cost) bm.add(k);
    const used = new Set();
    this.R.forEach((r) => r.ins.concat(r.outs).forEach(([k]) => k !== "Power" && used.add(k)));
    this.items = [...used].sort();
    this.iIdx = {};
    this.items.forEach((k, i) => (this.iIdx[k] = i));
    const valves = opts.valves || {};
    this.cls = this.items.map((k) => {
      const fluid = !!(game.items[k] && game.items[k].f);
      if (raw.has(k)) return "raw";
      let c = bm.has(k) && !fluid ? "surplus" : "balance";
      if (!fluid && (valves[k] === "surplus" || valves[k] === "balance")) c = valves[k];
      return c;
    });
    this.defaultCls = this.items.map((k) => {
      const fluid = !!(game.items[k] && game.items[k].f);
      return raw.has(k) ? "raw" : bm.has(k) && !fluid ? "surplus" : "balance";
    });
    this.fluid = this.items.map((k) => !!(game.items[k] && game.items[k].f));
    // exact per-machine rates at the chosen clock: rate[i] = [[j, p, q]]
    const NI = this.items.length, M = this.R.length;
    this.exact = Array.from({ length: NI }, () => new Map()); // j -> [p, q]
    this.R.forEach((r, j) => {
      const [cp, cq] = this.clock[j];
      const add = (k, v, s) => {
        if (k === "Power") return;
        const m = this.exact[this.iIdx[k]];
        const [p, q] = frac(v);
        const old = m.get(j) || [0n, 1n];
        let np = old[0] * q * cq + s * p * cp * old[1], nq = old[1] * q * cq;
        const g = bgcd(np, nq) || 1n;
        m.set(j, [np / g, nq / g]);
      };
      r.ins.forEach(([k, v]) => add(k, v, -1n));
      r.outs.forEach(([k, v]) => add(k, v, 1n));
    });
    this.rate = this.exact.map((m) => { const a = new Map(); for (const [j, [p, q]] of m) if (p) a.set(j, Number(p) / Number(q)); return a; });
    // power per machine (MW, + = draw): the sheet's rule, p * c^pe, generators p * c
    this.power = this.R.map((r, j) => {
      const c = this.clockPct[j] / 100;
      return r.p > 0 ? r.p * Math.pow(c, r.pe || 1.321929) : r.p * c;
    });
    this._build();
  }

  /* Integer rows: balance items, then the Phase 5 ratio. */
  Moves.prototype._rows = function () {
    const rows = [];
    const scale = (m) => { // Map j -> [p,q] to integer Map
      let L = 1n;
      for (const [, [, q]] of m) L = (L * q) / bgcd(L, q);
      const out = new Map();
      for (const [j, [p, q]] of m) if (p) out.set(j, (p * L) / q);
      return out;
    };
    this.items.forEach((k, i) => { if (this.cls[i] === "balance" && this.exact[i].size) rows.push({ item: i, coef: scale(this.exact[i]) }); });
    if (this.lockP5) {
      const p5 = Object.keys(PHASE5).filter((k) => this.iIdx[k] !== undefined);
      for (let a = 0; a + 1 < p5.length; a++) {
        const A = this.exact[this.iIdx[p5[a]]], B = this.exact[this.iIdx[p5[a + 1]]];
        const m = new Map();
        const js = new Set([...A.keys(), ...B.keys()]);
        for (const j of js) {
          const [ap, aq] = A.get(j) || [0n, 1n], [bp, bq] = B.get(j) || [0n, 1n];
          // a * P5_b - b * P5_a
          const pb = BigInt(PHASE5[p5[a + 1]]), pa = BigInt(PHASE5[p5[a]]);
          const np = ap * pb * bq - bp * pa * aq, nq = aq * bq;
          if (np) { const g = bgcd(np, nq); m.set(j, [np / g, nq / g]); }
        }
        if (m.size) rows.push({ item: -1, coef: scale(m) });
      }
    }
    return rows;
  };

  Moves.prototype._build = function () {
    const M = this.R.length;
    this.rows = this._rows();
    // column reduction: basis of {n in Z^M : row . n = 0 for all rows}
    let basis = [];
    for (let j = 0; j < M; j++) { const b = new Array(M).fill(0n); b[j] = 1n; basis.push(b); }
    const rows = this.rows.slice().sort((a, b) => a.coef.size - b.coef.size);
    for (const row of rows) {
      const vals = basis.map((b) => { let s = 0n; for (const [j, c] of row.coef) if (b[j]) s += c * b[j]; return s; });
      let live = [];
      const zero = [];
      basis.forEach((b, i) => (vals[i] ? live.push([b, vals[i]]) : zero.push(b)));
      while (live.length > 1) {
        let mi = 0;
        for (let i = 1; i < live.length; i++) if (babs(live[i][1]) < babs(live[mi][1])) mi = i;
        const [pb, pv] = live[mi];
        const next = [[pb, pv]];
        for (let i = 0; i < live.length; i++) {
          if (i === mi) continue;
          const [b, v] = live[i];
          const q = v / pv;
          if (q) for (let t = 0; t < M; t++) if (pb[t]) b[t] -= q * pb[t];
          const nv = v - q * pv;
          if (nv) next.push([b, nv]); else zero.push(b);
        }
        live = next;
      }
      basis = zero; // the pivot (if any) leaves the kernel
      let big = 0n;
      for (const b of basis) for (const x of b) { const a = babs(x); if (a > big) big = a; }
      if (big > 1n << 30n) basis = lll(basis); // keep the numbers small enough for floating Gram-Schmidt
    }
    this.basis = lll(basis);
    this.dim = this.basis.length;
    this.K = this.basis.map((b) => b.map(Number));
    // a move bigger than this many machines cannot be applied exactly in floating point
    this.huge = this.basis.map((b) => b.some((x) => babs(x) > 1n << 40n));
    // steps: the smallest change of n[r] any move combination allows
    this.steps = new Array(M).fill(0n);
    for (const b of this.basis) for (let j = 0; j < M; j++) if (b[j]) this.steps[j] = bgcd(this.steps[j], b[j]);
    // per-move net change of every item, for fast checks
    this.moveNet = this.K.map((v) => this.netOf(v));
  };

  /* LLL reduction (delta 0.99) of BigInt vectors with floating Gram-Schmidt. */
  function lll(B) {
    B = B.filter((b) => b.some((x) => x));
    const n = B.length;
    if (n <= 1) return B;
    const m = B[0].length;
    const F = B.map((b) => b.map(Number));
    const dot = (a, b) => { let s = 0; for (let t = 0; t < m; t++) s += a[t] * b[t]; return s; };
    const mu = Array.from({ length: n }, () => new Float64Array(n));
    const Bn = new Float64Array(n);
    const star = [];
    for (let i = 0; i < n; i++) {
      const v = F[i].slice();
      for (let j = 0; j < i; j++) {
        mu[i][j] = Bn[j] ? dot(F[i], star[j]) / Bn[j] : 0;
        for (let t = 0; t < m; t++) v[t] -= mu[i][j] * star[j][t];
      }
      star.push(v); Bn[i] = dot(v, v);
    }
    const sub = (k, j, q) => { // b_k -= q b_j
      const qb = BigInt(q);
      for (let t = 0; t < m; t++) if (B[j][t]) { B[k][t] -= qb * B[j][t]; F[k][t] = Number(B[k][t]); }
      for (let l = 0; l < j; l++) mu[k][l] -= q * mu[j][l];
      mu[k][j] -= q;
    };
    let k = 1, guard = 0;
    while (k < n && guard++ < 200000) {
      for (let j = k - 1; j >= 0; j--) { const q = Math.round(mu[k][j]); if (q) sub(k, j, q); }
      if (Bn[k] >= (0.99 - mu[k][k - 1] * mu[k][k - 1]) * Bn[k - 1]) { k++; continue; }
      const mm = mu[k][k - 1], Bnew = Bn[k] + mm * mm * Bn[k - 1];
      [B[k], B[k - 1]] = [B[k - 1], B[k]]; [F[k], F[k - 1]] = [F[k - 1], F[k]];
      for (let j = 0; j < k - 1; j++) { const t = mu[k][j]; mu[k][j] = mu[k - 1][j]; mu[k - 1][j] = t; }
      mu[k][k - 1] = Bnew ? mm * Bn[k - 1] / Bnew : 0;
      Bn[k] = Bnew ? Bn[k - 1] * Bn[k] / Bnew : 0;
      Bn[k - 1] = Bnew;
      for (let i = k + 1; i < n; i++) {
        const t = mu[i][k];
        mu[i][k] = mu[i][k - 1] - mm * t;
        mu[i][k - 1] = t + mu[k][k - 1] * mu[i][k];
      }
      k = Math.max(k - 1, 1);
    }
    // shortest first; sign so the largest entry is positive
    return B.map((b) => {
      let big = 0n;
      for (const x of b) if (babs(x) > babs(big)) big = x;
      return big < 0n ? b.map((x) => -x) : b;
    }).sort((a, b) => norm1(a) - norm1(b));
  }
  const norm1 = (b) => b.reduce((s, x) => s + Math.abs(Number(x)), 0);

  /* Net per minute of every item for machine counts n (Number array). */
  Moves.prototype.netOf = function (n) {
    const out = new Float64Array(this.items.length);
    this.rate.forEach((m, i) => { let s = 0; for (const [j, a] of m) if (n[j]) s += a * n[j]; out[i] = s; });
    return out;
  };
  Moves.prototype.powerOf = function (n) {
    let s = 0;
    for (let j = 0; j < n.length; j++) if (n[j]) s += this.power[j] * n[j];
    return s; // + = draw
  };

  /* Exact: does n satisfy every balance row (and the Phase 5 ratio)? */
  Moves.prototype.balanced = function (n) {
    for (const row of this.rows) {
      let s = 0n;
      for (const [j, c] of row.coef) if (n[j]) s += c * BigInt(n[j]);
      if (s !== 0n) return false;
    }
    return true;
  };

  const EPS = 1e-7;
  /* Violations of the inequalities for counts n and nets net: returns a list of
   * {kind, i or j, amount} (empty = valid).  pins: Map item index -> minimum net. */
  Moves.prototype.violations = function (n, net, pins) {
    const v = [];
    for (let j = 0; j < n.length; j++) if (n[j] < 0) v.push({ kind: "count", j, amount: -n[j] });
    for (let i = 0; i < net.length; i++) {
      const c = this.cls[i], x = net[i], tol = EPS * (1 + Math.abs(x));
      if (c === "surplus" && x < -tol) v.push({ kind: "short", i, amount: -x });
      else if (c === "raw" && x > tol) v.push({ kind: "raw", i, amount: x });
      if (pins && pins.has(i) && x < pins.get(i) - tol) v.push({ kind: "pin", i, amount: pins.get(i) - x });
    }
    return v;
  };
  /* Size of the violation, in machines (items scaled by their largest per-machine rate). */
  Moves.prototype.badness = function (n, net, pins) {
    let s = 0;
    for (const x of this.violations(n, net, pins)) {
      if (x.kind === "count") s += x.amount * 10;
      else {
        let r = 1;
        for (const [, a] of this.rate[x.i]) r = Math.max(r, Math.abs(a));
        s += x.amount / r;
      }
    }
    return s;
  };

  /* Nearest valid lattice point to a real target t (machines per recipe):
   * Babai rounding in the reduced basis, then a greedy repair with single and
   * paired moves.  Returns {n, ok, left} (left = remaining violations). */
  Moves.prototype.snap = function (t, pins) {
    const M = this.R.length, d = this.dim, K = this.K;
    let n = new Array(M).fill(0);
    if (d) {
      // Gram-Schmidt of the basis
      const star = [], Bn = [];
      for (let i = 0; i < d; i++) {
        const v = K[i].slice();
        for (let j = 0; j < i; j++) {
          const mu = Bn[j] ? dotA(K[i], star[j]) / Bn[j] : 0;
          for (let x = 0; x < M; x++) v[x] -= mu * star[j][x];
        }
        star.push(v); Bn.push(dotA(v, v));
      }
      const r = t.slice();
      const c = new Array(d).fill(0);
      for (let i = d - 1; i >= 0; i--) {
        c[i] = Bn[i] ? Math.round(dotA(r, star[i]) / Bn[i]) : 0;
        if (c[i]) for (let x = 0; x < M; x++) r[x] -= c[i] * K[i][x];
      }
      for (let i = 0; i < d; i++) if (c[i]) for (let x = 0; x < M; x++) n[x] += c[i] * K[i][x];
    }
    return this.repair(n, pins);
  };
  /* Snap using only the recipes with a positive target (the others stay at 0):
   * a valid point there is also a valid point of the full lattice.  Falls back
   * to the full snap when that does not work. */
  Moves.prototype.snapSupport = function (t, pins) {
    const keep = this.R.filter((r, j) => t[j] > 0).map((r) => r.id);
    if (keep.length && keep.length < this.R.length) {
      const sub = new Moves(this.game, Object.assign({}, this.opts, { recipes: keep }));
      const subPins = new Map();
      if (pins) for (const [i, v] of pins) { const k = sub.iIdx[this.items[i]]; if (k !== undefined) subPins.set(k, v); }
      const res = sub.snap(sub.R.map((r) => t[this.rIdx[r.id]]), subPins);
      if (res.ok) {
        const n = new Array(this.R.length).fill(0);
        sub.R.forEach((r, j) => (n[this.rIdx[r.id]] = res.n[j]));
        if (this.balanced(n) && this.valid(n, pins)) return { n, ok: true, left: [] };
      }
    }
    return this.snap(t, pins);
  };

  const dotA = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  Moves.prototype.repair = function (n, pins, maxSteps) {
    n = n.slice();
    let net = this.netOf(n), bad = this.badness(n, net, pins);
    const d = this.dim;
    const tryMove = (coefs) => { // [[i, c]]
      const n2 = n.slice(), net2 = Float64Array.from(net);
      for (const [i, c] of coefs) {
        const v = this.K[i], dn = this.moveNet[i];
        for (let x = 0; x < v.length; x++) if (v[x]) n2[x] += c * v[x];
        for (let x = 0; x < dn.length; x++) net2[x] += c * dn[x];
      }
      return [n2, net2, this.badness(n2, net2, pins)];
    };
    for (let step = 0; step < (maxSteps || 4000) && bad > 0; step++) {
      let best = null;
      for (let i = 0; i < d; i++) for (const c of [1, -1]) {
        const res = tryMove([[i, c]]);
        if (res[2] < bad - 1e-12 && (!best || res[2] < best[2])) best = res;
      }
      if (!best) { // pairs: the first move touches something broken, the second is any move
        const v = this.violations(n, net, pins);
        const first = new Set();
        for (const x of v) {
          if (x.kind === "count") this.K.forEach((m, i) => { if (m[x.j]) first.add(i); });
          else this.moveNet.forEach((m, i) => { if (Math.abs(m[x.i]) > 1e-12) first.add(i); });
        }
        for (const i of first) {
          for (let k = 0; k < d; k++) {
            if (k === i) continue;
            for (const a of [1, -1]) for (const b of [1, -1]) {
              const res = tryMove([[i, a], [k, b]]);
              if (res[2] < bad - 1e-12 && (!best || res[2] < best[2])) best = res;
            }
          }
          if (best) break;
        }
      }
      if (!best) break;
      [n, net, bad] = best;
    }
    return { n, ok: bad === 0, left: this.violations(n, net, pins) };
  };

  /* Exact step of item i's net: the smallest positive change any integer
   * combination of moves can make (gcd of the moves' exact net changes).
   * Returns [p, q] (per minute) or null when no move changes it. */
  Moves.prototype.itemStep = function (i) {
    const ex = this.exact[i];
    if (!ex.size) return null;
    let gp = 0n, gq = 1n;
    for (const v of this.basis) {
      let np = 0n, nq = 1n;
      for (const [j, [p, q]] of ex) if (v[j]) {
        np = np * q + v[j] * p * nq; nq = nq * q;
        const g = bgcd(np, nq) || 1n; np /= g; nq /= g;
      }
      if (!np) continue;
      // gcd(gp/gq, np/nq) = gcd(gp*nq, np*gq) / (gq*nq)
      const a = babs(gp * nq), b = babs(np * gq), q = gq * nq;
      const g = bgcd(a, b), h = bgcd(g, q) || 1n;
      gp = g / h; gq = q / h;
    }
    return gp ? [gp, gq] : null;
  };

  /* Moves that change recipe j: basis vectors with a nonzero entry there. */
  Moves.prototype.movesFor = function (j) {
    const out = [];
    this.K.forEach((v, i) => { if (v[j]) out.push(i); });
    return out;
  };

  /* Apply sum c_i K_i to n (Number arrays). */
  Moves.prototype.apply = function (n, coefs) {
    const n2 = n.slice();
    for (const [i, c] of coefs) { const v = this.K[i]; for (let x = 0; x < v.length; x++) if (v[x]) n2[x] += c * v[x]; }
    return n2;
  };
  Moves.prototype.valid = function (n, pins, net) {
    return this.violations(n, net || this.netOf(n), pins).length === 0;
  };

  /* "Shrink this": a combination of up to `depth` moves (coefficients +-1, +-2)
   * that lowers n[j] and keeps n valid (from a broken start: no worse).  Candidates: the moves touching j and
   * the shortest other moves.  Best = fewest machines of j, then fewest
   * machines in all, then the smallest change.  Returns {coefs, n} or null. */
  Moves.prototype.shrink = function (n, j, pins, opts) {
    opts = opts || {};
    const depth = opts.depth || 3, width = opts.width || 14, budget = opts.budget || 400000;
    const touch = this.movesFor(j).slice(0, width);
    const others = this.K.map((v, i) => i).filter((i) => !this.K[i][j]).slice(0, Math.max(0, width - Math.floor(touch.length / 2)));
    const cand = touch.concat(others);
    const net0 = this.netOf(n);
    const total0 = n.reduce((a, b) => a + b, 0);
    const bad0 = this.badness(n, net0, pins); // a broken start may not get worse
    let best = null, evals = 0;
    const C = [1, -1, 2, -2];
    const consider = (coefs) => {
      let dj = 0;
      for (const [i, c] of coefs) dj += c * this.K[i][j];
      if (dj >= 0) return;
      evals++;
      const n2 = this.apply(n, coefs);
      for (let x = 0; x < n2.length; x++) if (n2[x] < 0) return;
      const net2 = Float64Array.from(net0);
      for (const [i, c] of coefs) { const dn = this.moveNet[i]; for (let x = 0; x < dn.length; x++) net2[x] += c * dn[x]; }
      if (this.badness(n2, net2, pins) > bad0 + 1e-9) return;
      const tot = n2.reduce((a, b) => a + b, 0);
      const size = coefs.reduce((a, [i, c]) => a + Math.abs(c) * norm1(this.basis[i]), 0);
      const key = [n2[j], tot, size];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2]))))
        best = { coefs: coefs.map((x) => x.slice()), n: n2, key, dTotal: tot - total0 };
    };
    const L = cand.length;
    // depth 1, 2, 3 over candidate indices; the first chosen move must touch j
    for (let a = 0; a < L && evals < budget; a++) {
      if (!this.K[cand[a]][j]) continue;
      for (const ca of C) {
        consider([[cand[a], ca]]);
        if (depth < 2) continue;
        for (let b = 0; b < L && evals < budget; b++) {
          if (b === a) continue;
          for (const cb of C) {
            consider([[cand[a], ca], [cand[b], cb]]);
            if (depth < 3) continue;
            for (let c = b + 1; c < L && evals < budget; c++) {
              if (c === a) continue;
              for (const cc of [1, -1]) consider([[cand[a], ca], [cand[b], cb], [cand[c], cc]]);
            }
          }
        }
      }
    }
    if (best) best.evals = evals;
    return best;
  };

  /* Nearest clean clock (a multiple of 1/125, 1/100, 1/80 or 1/64 of 100 %: the
   * denominators up to 125 that a 4-decimal percentage can show), as a percent string. */
  Moves.cleanClock = function (pct) {
    let best = null;
    for (const d of [125, 100, 80, 64]) {
      const k = Math.max(1, Math.round(pct / 100 * d));
      const v = 100 * k / d;
      if (v > 250) continue;
      if (!best || Math.abs(v - pct) < Math.abs(best - pct) - 1e-12) best = v;
    }
    return String(+best.toFixed(4));
  };

  /* Chain moves for recipe j: short, readable moves built the way one would by
   * hand.  Start from {j}; while some must-balance item touched by the chosen
   * recipes lacks a producer (or a consumer), add one (recipes already running
   * first), branching over the alternatives; whenever the chosen recipes admit a
   * balanced combination that changes j (the lattice of that small set), record
   * it.  Returns [{vec, size, plus, minus}] (vec over this.R; plus/minus: valid
   * from n in that direction), shortest first. */
  Moves.prototype.chainMoves = function (n, j, pins, opts) {
    opts = opts || {};
    const maxSet = opts.maxSet || 9, maxNodes = opts.maxNodes || 400, want = opts.want || 6;
    const M = this.R.length, found = new Map();
    const prod = new Map(), cons = new Map(); // balance item index -> recipe indices
    this.items.forEach((k, i) => {
      if (this.cls[i] !== "balance") return;
      const p = [], c = [];
      for (const [r, a] of this.rate[i]) (a > 0 ? p : c).push(r);
      const order = (list) => list.sort((x, y) => (n[y] > 0) - (n[x] > 0) || x - y);
      prod.set(i, order(p)); cons.set(i, order(c));
    });
    const lockRows = this.lockP5;
    let nodes = 0;
    const net0 = this.netOf(n);
    const record = (vec) => {
      let big = 0, size = 0;
      for (const x of vec) { size += Math.abs(x); big = Math.max(big, Math.abs(x)); }
      if (!vec[j] || big > 1e6) return;
      if (vec[j] < 0) vec = vec.map((x) => -x);
      const key = vec.join(",");
      if (found.has(key)) return;
      const test = (c) => {
        const n2 = n.slice(), net2 = Float64Array.from(net0);
        for (let x = 0; x < M; x++) if (vec[x]) n2[x] += c * vec[x];
        this.rate.forEach((m, i) => { let d = 0; for (const [r, a] of m) if (vec[r]) d += a * vec[r]; net2[i] += c * d; });
        return this.badness(n2, net2, pins || null) <= this.badness(n, net0, pins || null) + 1e-9 && n2.every((x) => x >= 0);
      };
      found.set(key, { vec, size, plus: test(1), minus: test(-1) });
    };
    const seen = new Set();
    const visit = (set) => {
      if (nodes++ > maxNodes || found.size >= want * 3) return;
      const key = set.slice().sort((a, b) => a - b).join(",");
      if (seen.has(key)) return;
      seen.add(key);
      // the balanced combinations of just these recipes
      const sub = new Moves(this.game, Object.assign({}, this.opts, { recipes: set.map((r) => this.R[r].id), lockP5: lockRows }));
      for (const b of sub.K) {
        const vec = new Array(M).fill(0);
        sub.R.forEach((r, x) => (vec[this.rIdx[r.id]] = b[x]));
        if (vec[j]) record(vec);
      }
      if (set.length >= maxSet) return;
      // the first must-balance item the set cannot balance on its own: add a producer or consumer
      const inSet = new Set(set);
      for (const r of set) {
        for (const [k] of this.R[r].ins.concat(this.R[r].outs)) {
          const i = this.iIdx[k];
          if (i === undefined || this.cls[i] !== "balance") continue;
          const p = prod.get(i).filter((x) => inSet.has(x)), c = cons.get(i).filter((x) => inSet.has(x));
          if (p.length && c.length) continue;
          const cand = (p.length ? cons.get(i) : prod.get(i)).filter((x) => !inSet.has(x)).slice(0, 4);
          for (const x of cand) visit(set.concat([x]));
          return;
        }
      }
    };
    visit([j]);
    return [...found.values()].sort((a, b) => (b.plus || b.minus) - (a.plus || a.minus) || a.size - b.size).slice(0, want);
  };

  /* Product chains for surplus item i: for each recipe that makes it, the chain
   * moves through that recipe whose net effect raises item i.  Returns
   * [{item, via, vec, size, gain}] (gain: per-minute rise of item i), where vec
   * is oriented so that + makes more of the item. */
  Moves.prototype.productChains = function (i, n, opts) {
    const out = [];
    const makers = [...this.rate[i]].filter(([, a]) => a > 0).map(([r]) => r);
    for (const r of makers) {
      for (const c of this.chainMoves(n, r, null, Object.assign({ want: 4 }, opts || {}))) {
        let g = 0;
        for (const [x, a] of this.rate[i]) if (c.vec[x]) g += a * c.vec[x];
        if (g > 1e-9) out.push({ item: i, via: r, vec: c.vec, size: c.size, gain: g });
      }
    }
    return out;
  };

  Moves.PHASE5 = PHASE5;
  Moves.clockFrac = clockFrac;
  if (typeof module !== "undefined" && module.exports) module.exports = Moves;
  else root.SatMoves = Moves;
})(typeof window !== "undefined" ? window : this);
