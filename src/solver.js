/* Satisfactory production-sheet solver.
 *
 * Pure logic, no DOM.  Works in the browser (window.SatSolver) and in node
 * (module.exports) so it can be tested from the command line.
 *
 * State per recipe r:
 *   c[r]  clock as a fraction (0 = recipe disabled, 1 = 100%)
 *   f[r]  net production floor for the recipe's primary (first) output, per min
 *   n[r]  number of machines (always a whole number)
 *
 * Flows are kept incrementally: prod[k] and cons[k] are the total
 * production and consumption of item k over the whole sheet.  Power is an
 * ordinary item ("Power", in MW) except that Alien Power Augmentors multiply
 * the produced power by (1 + B), with B the sum of their boosts.
 *
 * Policies (see README for the reasoning):
 *  - target(k) = max floor over active recipes whose primary output is k.
 *  - An item is in deficit when net(k) < target(k).
 *  - Sizing a recipe: the smallest whole n that makes net(primary) reach its
 *    target, with the other producers held fixed.  A by-product also drives sizing
 *    when this recipe is that by-product's designated producer.
 *  - Designated producer of item k: its only active producer; or, when several
 *    are active, the only active one marked flexible (x[r]).  None otherwise.
 *  - Propagation: when a recipe's consumption changes, each of its inputs is
 *    checked; if that input has a designated producer, that producer is
 *    re-sized, and so on recursively (a worklist until nothing changes).
 *  - "Manual" recipes (augmentors, Main Portal, well pressurizer) are never
 *    sized automatically; their machine count is typed in.
 */
(function (root) {
  "use strict";
  const REL = 1e-9;
  const MANUAL = { augment: 1, manual: 1 };
  const MAX_STEPS = 20000;
  /* Round up to a whole machine, forgiving float noise just above an integer. */
  const whole = (x) => (x > 1e-6 ? Math.ceil(x - 1e-6) : 0);

  function Solver(game) {
    this.game = game;
    const itemKeys = Object.keys(game.items);
    this.itemKeys = itemKeys;
    this.itemIdx = {};
    itemKeys.forEach((k, i) => (this.itemIdx[k] = i));
    this.P = this.itemIdx.Power;
    const R = game.recipes;
    this.R = R;
    this.integer = true; // whole machine counts; tools may switch it off
    this.rIdx = {};
    R.forEach((r, i) => (this.rIdx[r.id] = i));
    const NI = itemKeys.length;
    this.ins = R.map((r) => r.ins.map(([k, v]) => [this.itemIdx[k], v]));
    this.outs = R.map((r) => r.outs.map(([k, v]) => [this.itemIdx[k], v]));
    this.manual = R.map((r) => !!MANUAL[r.kind]);
    this.producersOf = Array.from({ length: NI }, () => []);
    this.consumersOf = Array.from({ length: NI }, () => []);
    this.primaryOf = Array.from({ length: NI }, () => []);
    R.forEach((r, i) => {
      this.outs[i].forEach(([k], j) => {
        this.producersOf[k].push(i);
        if (j === 0) this.primaryOf[k].push(i);
      });
      this.ins[i].forEach(([k]) => this.consumersOf[k].push(i));
      if (r.p > 0) this.consumersOf[this.P].push(i);
    });
    this.reset();
  }

  Solver.prototype.reset = function () {
    const NR = this.R.length, NI = this.itemKeys.length;
    this.c = new Float64Array(NR);
    this.f = new Float64Array(NR);
    this.n = new Float64Array(NR);
    this.x = new Uint8Array(NR); // "flexible": absorbs imbalances when several producers run
    this.R.forEach((r, i) => { if (this.manual[i]) this.c[i] = 1; });
    this.off = new Uint8Array(NR); // recipes switched out (e.g. FICSMAS) keep c/f/n but count for nothing
    if (this.offGroups) for (const g of this.offGroups) this.R.forEach((r, i) => { if (r[g]) this.off[i] = 1; });
    this.prod = new Float64Array(NI);
    this.cons = new Float64Array(NI);
    this.B = 0;
    this.converged = true;
  };

  /* Per-machine power draw (MW) at clock c; negative = generation. */
  Solver.prototype.machinePower = function (r, c) {
    const rec = this.R[r];
    if (c <= 0) return 0;
    return rec.p > 0 ? rec.p * Math.pow(c, rec.pe) : rec.p * c;
  };

  Solver.prototype.contrib = function (r, sign) {
    if (this.off[r]) return;
    const n = this.n[r], c = this.c[r];
    if (n === 0 || c === 0) return;
    const s = sign * n * c;
    for (const [k, v] of this.ins[r]) this.cons[k] += s * v;
    for (const [k, v] of this.outs[r]) this.prod[k] += s * v;
    const rec = this.R[r];
    if (rec.p > 0) this.cons[this.P] += sign * n * rec.p * Math.pow(c, rec.pe);
    if (rec.boost) this.B += s * rec.boost;
  };

  Solver.prototype.whole = whole;

  Solver.prototype.setN = function (r, n) {
    this.contrib(r, -1);
    this.n[r] = n;
    this.contrib(r, +1);
  };

  Solver.prototype.isActive = function (r) {
    return !this.off[r] && this.c[r] > 0 && (!this.manual[r] || this.n[r] > 0);
  };

  Solver.prototype.activeProducers = function (k) {
    return this.producersOf[k].filter((r) => this.isActive(r));
  };

  /* The one recipe re-sized for item k, or -1 (see header). */
  Solver.prototype.driver = function (k) {
    const act = this.activeProducers(k);
    if (act.length === 1) return act[0];
    let d = -1;
    for (const r of act) if (this.x[r] && !this.manual[r]) { if (d >= 0) return -1; d = r; }
    return d;
  };

  Solver.prototype.mult = function (k) {
    return k === this.P ? 1 + this.B : 1;
  };

  Solver.prototype.net = function (k) {
    return this.prod[k] * this.mult(k) - this.cons[k];
  };

  Solver.prototype.target = function (k) {
    let t = 0;
    for (const r of this.primaryOf[k]) if (this.isActive(r) && this.f[r] > t) t = this.f[r];
    return t;
  };

  Solver.prototype.tol = function (k) {
    return 1e-6 * Math.max(1, this.cons[k], this.prod[k]);
  };

  Solver.prototype.inDeficit = function (k) {
    return this.net(k) < this.target(k) - this.tol(k);
  };

  /* Machines recipe r needs, holding everything else fixed. */
  Solver.prototype.size = function (r) {
    if (this.manual[r]) return this.n[r];
    const c = this.c[r];
    if (c <= 0) return 0;
    const n0 = this.n[r];
    let best = 0;
    this.outs[r].forEach(([k, rate], j) => {
      if (j > 0) {
        if (this.driver(k) !== r) return;
        if (this.consumersOf[k].length === 0) return;
      }
      let selfIn = 0;
      for (const [k2, v] of this.ins[r]) if (k2 === k) selfIn += v * c;
      const out = rate * c;
      const m = this.mult(k);
      const prodOthers = this.prod[k] - n0 * out;
      const consOthers = this.cons[k] - n0 * selfIn;
      const per = m * out - selfIn;
      if (per <= 0) return;
      const need = (this.target(k) + consOthers - m * prodOthers) / per;
      if (need > best) best = need;
    });
    return this.integer ? whole(best) : best;
  };

  /* Re-size the sole active producers of r's inputs, recursively. */
  Solver.prototype.propagate = function (start) {
    const queue = [];
    const queued = new Uint8Array(this.R.length);
    const pushInputs = (r) => {
      const keys = this.ins[r].map(([k]) => k);
      if (this.R[r].p > 0) keys.push(this.P);
      for (const k of keys) {
        const d = this.driver(k);
        if (d >= 0 && d !== r && !queued[d]) {
          queued[d] = 1;
          queue.push(d);
        }
      }
    };
    pushInputs(start);
    let steps = 0;
    this.converged = true;
    while (queue.length) {
      if (++steps > MAX_STEPS) { this.converged = false; break; }
      const p = queue.shift();
      queued[p] = 0;
      const nn = this.size(p);
      if (Math.abs(nn - this.n[p]) > REL * (1 + Math.abs(this.n[p]))) {
        this.setN(p, nn);
        pushInputs(p);
      }
    }
    return steps;
  };

  /* ---- User edits ------------------------------------------------------ */
  Solver.prototype.setClock = function (r, c) {
    const mc = this.R[r].mc;
    c = Math.max(0, Math.min(mc, +c || 0));
    if (this.manual[r]) return;
    this.contrib(r, -1);
    this.c[r] = c;
    this.contrib(r, +1);
    this.setN(r, this.size(r));
    this.propagate(r);
  };

  /* Generators, augmentors and recipes without products take no floor. */
  Solver.prototype.hasFloor = function (r) {
    const o = this.outs[r];
    return !this.manual[r] && o.length > 0 && o[0][0] !== this.P;
  };

  Solver.prototype.setFloor = function (r, f) {
    if (!this.hasFloor(r)) return;
    this.f[r] = Math.max(0, +f || 0);
    if (!this.manual[r]) this.setN(r, this.size(r));
    this.propagate(r);
  };

  Solver.prototype.setCount = function (r, n) {
    n = Math.max(0, +n || 0);
    this.setN(r, this.integer ? whole(n) : n);
    this.propagate(r);
  };

  /* Mark a recipe flexible.  Turning it on re-sizes it at once, so it takes up
   * whatever imbalance its outputs have now, then propagates to its suppliers. */
  Solver.prototype.setFlex = function (r, on) {
    this.x[r] = on ? 1 : 0;
    if (!on || this.manual[r] || !this.isActive(r)) return;
    this.setN(r, this.size(r));
    this.propagate(r);
  };

  /* Switch a group of recipes (those with rec[flag] set, e.g. "xmas") on or
   * off.  Off recipes keep their clock, floor and count but contribute
   * nothing; their suppliers are re-sized either way. */
  Solver.prototype.setGroup = function (flag, on) {
    this.offGroups = this.offGroups || new Set();
    if (on) this.offGroups.delete(flag); else this.offGroups.add(flag);
    const touched = [];
    this.R.forEach((rec, r) => {
      if (!rec[flag] || !this.off[r] === !!on) return;
      if (on) { this.off[r] = 0; this.contrib(r, +1); } else { this.contrib(r, -1); this.off[r] = 1; }
      touched.push(r);
    });
    for (const r of touched) this.propagate(r);
  };

  /* ---- Bulk load (no propagation; trusts the saved numbers) ------------ */
  Solver.prototype.load = function (s) {
    this.reset();
    for (const [id, v] of Object.entries(s.c || {})) {
      const r = this.rIdx[id];
      if (r !== undefined && !this.manual[r]) this.c[r] = v;
    }
    for (const [id, v] of Object.entries(s.f || {})) {
      const r = this.rIdx[id];
      if (r !== undefined && this.hasFloor(r)) this.f[r] = v;
    }
    for (const id of s.x || []) { const r = this.rIdx[id]; if (r !== undefined && !this.manual[r]) this.x[r] = 1; }
    for (const [id, v] of Object.entries(s.n || {})) {
      const r = this.rIdx[id]; if (r !== undefined) this.n[r] = this.integer ? whole(v) : v;
    }
    for (let r = 0; r < this.R.length; r++) this.contrib(r, +1);
  };

  Solver.prototype.dump = function () {
    const s = { c: {}, f: {}, n: {}, x: [] };
    this.R.forEach((rec, r) => {
      if (this.c[r] && !this.manual[r]) s.c[rec.id] = this.c[r];
      if (this.f[r]) s.f[rec.id] = this.f[r];
      if (this.n[r]) s.n[rec.id] = this.n[r];
      if (this.x[r]) s.x.push(rec.id);
    });
    return s;
  };

  /* ---- Derived numbers --------------------------------------------------- */
  Solver.prototype.lanes = function (r) {
    if (this.R[r].kind === "gather") return [0, 0];
    let s = 0, f = 0;
    for (const [k] of this.ins[r].concat(this.outs[r])) {
      if (k === this.P) continue;
      if (this.game.items[this.itemKeys[k]].f) f++; else s++;
    }
    return [s, f];
  };

  Solver.prototype.buildings = function (r) {
    if (this.R[r].kind === "gather" || !this.isActive(r)) return 0;
    return this.n[r];
  };

  /* Power summary: produced (with boost), consumed, net, target. */
  Solver.prototype.power = function () {
    const P = this.P;
    return { base: this.prod[P], boost: this.B, supply: this.prod[P] * (1 + this.B),
      demand: this.cons[P], net: this.net(P), target: this.target(P), deficit: this.inDeficit(P) };
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Solver;
  else root.SatSolver = Solver;
})(typeof window !== "undefined" ? window : this);
