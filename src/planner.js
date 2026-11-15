/* Factory planner engine: whole machines upstream of what you set, fluids exact.
 * Pure logic, no DOM.  window.SatPlanner in the browser, module.exports in node.
 *
 * Rows are the recipes of data/recipe_set.json (tools/select_recipes.py) plus
 * one source per raw resource, the geothermal generators, the Main Portal and
 * the augmentor.  A row's LEVEL is machines x clock (1 = one machine at 100 %).
 *
 *   set      you typed machines and clock; nothing changes them
 *   auto     whole machines at 100 %: the fewest that cover the demand for the
 *            items the row is the MAKER of (one maker per item, from the data)
 *   trim     an auto row that currently balances a fluid: its level is solved,
 *            not rounded, and shown as ceil(level) machines at an equal clock
 *   source   draws exactly what is used (miners at up to 250 %).  A tenth of the world's
 *            nodes is the yardstick, not a limit: drawing more is reported, not refused
 *
 * Rules
 *   solids   net >= build need + the row's minimum net; a surplus is fine
 *   fluids, raw resources, nuclear waste: net = 0 exactly ("exact" items)
 *   power    1.3 x generated + 500 MW >= drawn  (one fueled augmentor)
 *
 * Each fluid has a maker and, for some, a sink (a recipe that absorbs a
 * surplus).  Whichever of the two is on auto can be the fluid's trim.  The trim
 * levels of all fluids are the solution of one small linear system; of the
 * possible assignments the first valid one is used (maker first), where valid
 * means every trim covers what it must make and is not negative.
 *
 * The counts are a fixed point: demand -> machines -> power, buildings, inputs
 * -> demand.  Counts only rise while iterating; a second pass lowers any count
 * that ended above its need and lets the rest follow again. */
(function (root) {
  "use strict";
  const EPS = 1e-7;
  const BELTS = [1, 2, 3, 4, 5, 6].map((k) => "ConveyorBeltMk" + k);

  function create(G, SET) {
    const IT = G.items, B = G.buildings;
    const byId = Object.fromEntries(G.recipes.map((r) => [r.id, r]));
    const fluid = (k) => !!(IT[k] && IT[k].f);
    const rows = [];
    const lanes = (ins, outs) => {
      let s = 0, f = 0, inl = 0, outl = 0;
      for (const [k] of ins) { if (fluid(k)) f++; else { s++; inl++; } }
      for (const [k] of outs) { if (fluid(k)) f++; else { s++; outl++; } }
      return { s, f, inl, outl };
    };
    for (const r of SET.recipes) {
      const g = byId[r.id];
      const ins = g.ins.filter(([k]) => k !== "Power"), outs = g.outs.filter(([k]) => k !== "Power");
      const pw = g.outs.find(([k]) => k === "Power");
      rows.push(Object.assign({ id: g.id, name: g.name.replace(/^Alternate: /, ""), alt: !!g.alt, machine: g.m, machineName: B[g.m].n,
        layer: g.layer, kind: "recipe", ins, outs, gen: pw ? pw[1] : 0, p: Math.max(g.p, 0), pe: g.pe || 1, vp: !!g.vp,
        build: { [g.m]: 1 }, maxClock: 1, lp: r.lp_machines }, lanes(ins, outs)));
    }
    const portal = byId.MainPortal;
    rows.push({ id: "MainPortal", name: "Main Portal", machine: "Portal", machineName: B.Portal.n, layer: portal.layer, kind: "fixed",
      ins: portal.ins.slice(), outs: [], gen: 0, p: SET.portal.mw, pe: 1, build: {}, maxClock: 1, s: 1, f: 0, inl: 1, outl: 0 });
    rows.push({ id: "Augmenter30", name: "Alien Power Augmentor (fueled)", machine: "AlienPowerBuilding", machineName: B.AlienPowerBuilding.n,
      layer: byId.Augmenter30.layer, kind: "fixed", ins: [["AlienPowerFuel", SET.augmentor.fuel_per_min]], outs: [], gen: 0, p: 0, pe: 1,
      build: {}, maxClock: 1, s: 1, f: 0, inl: 1, outl: 0 });
    rows.sort((a, b) => b.layer - a.layer || a.name.localeCompare(b.name));
    for (const s of SET.sources) {
      const mk = Object.keys(s.buildings)[0];
      const isF = s.item && fluid(s.item);
      const nsat = s.buildings.FrackingExtractor || 0;
      rows.push({ id: s.id, name: s.name, machine: mk, machineName: B[mk].n, layer: 0, kind: s.kind === "geo" ? "geo" : "source",
        ins: [], outs: s.item ? [[s.item, s.rate / s.clock]] : [], gen: s.gen_mw, p: s.mw / s.clock, pe: G.recipes[0].pe || 1.321929,
        build: s.buildings, maxClock: s.clock, cap: s.max, s: s.item && !isF ? 1 : 0, f: isF ? (nsat || 1) : 0, inl: 0, outl: s.item && !isF ? 1 : 0 });
    }
    const R = rows.length;
    const rowIdx = Object.fromEntries(rows.map((r, i) => [r.id, i]));

    // items
    const keys = [], itemIdx = {};
    const item = (k) => { if (!(k in itemIdx)) { itemIdx[k] = keys.length; keys.push(k); } return itemIdx[k]; };
    const POWER = item("Power");
    for (const r of rows) { r.ini = r.ins.map(([k, q]) => [item(k), q]); r.outi = r.outs.map(([k, q]) => [item(k), q]); }
    for (const k of Object.keys(SET.equipment)) item(k);
    for (const k of Object.keys(SET.phase5)) item(k);
    for (const b of Object.keys(B)) for (const [k] of B[b].cost) item(k);
    const K = keys.length;
    const isFluid = keys.map(fluid);
    const made0 = new Uint8Array(K);
    for (const r of rows) for (const [k] of r.outi) made0[k] = 1;
    const exact = new Uint8Array(K);
    for (const k of SET.exact) if (k in itemIdx) exact[itemIdx[k]] = 1;
    const maker = new Int32Array(K).fill(-1), sink = new Int32Array(K).fill(-1);
    for (const [k, id] of Object.entries(SET.maker)) if (k in itemIdx && id in rowIdx) maker[itemIdx[k]] = rowIdx[id];
    for (const [k, id] of Object.entries(SET.sink)) if (k in itemIdx && id in rowIdx) sink[itemIdx[k]] = rowIdx[id];
    // raw items: every source of the item, in the listed order
    const rawSources = {};
    rows.forEach((r, i) => { if (r.kind === "source") (rawSources[r.outi[0][0]] = rawSources[r.outi[0][0]] || []).push(i); });
    const isRaw = new Uint8Array(K);
    for (const k of Object.keys(rawSources)) isRaw[k] = 1;
    // fluids balanced by a recipe trim
    const trimItems = [];
    for (let k = 0; k < K; k++) if (exact[k] && !isRaw[k] && (maker[k] >= 0 || sink[k] >= 0)) trimItems.push(k);
    // items each row is the maker of
    const makes = rows.map(() => []);
    for (let k = 0; k < K; k++) if (maker[k] >= 0 && !isRaw[k]) makes[maker[k]].push(k);
    const outRate = (r, k) => { let q = 0; for (const [kk, v] of rows[r].outi) if (kk === k) q += v; return q; };
    const netRate = (r, k) => { let q = 0; for (const [kk, v] of rows[r].outi) if (kk === k) q += v; for (const [kk, v] of rows[r].ini) if (kk === k) q -= v; return q; };
    const P5 = Object.entries(SET.phase5).map(([k, q]) => [itemIdx[k], q]);
    const AUG = SET.augmentor;

    function defaultState() {
      const st = { rows: {}, min: {}, T: null };
      for (const s of SET.start) st.rows[s.id] = { n: s.n, clock: s.clock };
      for (const [id, d] of Object.entries(SET.defaults || {})) st.rows[id] = { n: d.n, clock: d.clock };
      for (const [id, q] of Object.entries(SET.min_net || {})) st.min[id] = q;
      return st;
    }

    /* Buildings and bill of materials for whole counts N (tools/optimize.py bom_exact). */
    function bill(N, madeNow) {
      const comp = {};
      let machines = 0, solid = 0, fl = 0, inl = 0, outl = 0;
      const seen = new Uint8Array(K);
      for (let i = 0; i < R; i++) {
        const n = N[i], r = rows[i];
        if (!(n > 0)) continue;
        for (const [b, q] of Object.entries(r.build)) { comp[b] = (comp[b] || 0) + q * n; machines += q * n; }
        solid += r.s * n; fl += r.f * n; inl += r.inl * n; outl += r.outl * n;
        for (const [k] of r.ini) seen[k] = 1;
        for (const [k] of r.outi) seen[k] = 1;
      }
      for (const b of Object.keys(comp)) comp[b] = Math.ceil(comp[b] - 1e-9);
      machines = Math.ceil(machines - 1e-9); fl = Math.ceil(fl - 1e-9);
      const add = (b, q) => { if (q > 0 && B[b]) comp[b] = (comp[b] || 0) + Math.ceil(q - 1e-9); };
      for (const b of BELTS) add(b, solid);
      add("Pipeline", fl); add("PipelineMK2", fl); add("RailroadTrack", solid + fl);
      let st = 0, ft = 0;
      for (let k = 0; k < K; k++) if (seen[k] && k !== POWER) { if (isFluid[k]) ft++; else st++; }
      const basis = { machines, inLanes: inl, outLanes: outl, fluidLanes: fl, solidTypes: st, fluidTypes: ft,
        belts: BELTS.reduce((a, b) => a + (comp[b] || 0), 0), pipe1: comp.Pipeline || 0, pipe2: comp.PipelineMK2 || 0 };
      const apply = (base) => { for (const [b, q] of Object.entries(SET.rules[base] || {})) add(b, basis[base] * q); };
      ["machines", "inLanes", "outLanes", "fluidLanes", "solidTypes", "fluidTypes", "belts", "pipe1", "pipe2"].forEach(apply);
      const extra = SET.extra_buildings;
      const bomItems = (more) => {
        const has = new Uint8Array(K);
        for (const b of new Set(Object.keys(comp).concat(Object.keys(extra), Object.keys(more)))) {
          if ((comp[b] || 0) + (extra[b] || 0) + (more[b] || 0)) for (const [k] of B[b].cost) has[itemIdx[k]] = 1;
        }
        for (const k of SET.expendable) if (k in itemIdx && madeNow[itemIdx[k]] > 1e-9) has[itemIdx[k]] = 1;
        for (const k of Object.keys(SET.equipment)) has[itemIdx[k]] = 1;
        return has.reduce((a, x) => a + x, 0);
      };
      let depot = bomItems({});
      let dc = {};
      for (let pass = 0; pass < 2; pass++) {
        dc = {};
        for (const [b, q] of Object.entries(SET.rules.depotItems || {})) dc[b] = Math.ceil(depot * q - 1e-9);
        depot = bomItems(dc);
      }
      basis.depotItems = depot;
      apply("depotItems");
      const total = {};
      for (const b of new Set(Object.keys(comp).concat(Object.keys(extra)))) {
        const t = (comp[b] || 0) + (extra[b] || 0);
        if (t) total[b] = t;
      }
      const bom = new Float64Array(K);
      for (const [b, t] of Object.entries(total)) for (const [k, q] of B[b].cost) bom[itemIdx[k]] += t * q;
      for (const [k, q] of Object.entries(SET.equipment)) bom[itemIdx[k]] += q;
      return { total, bom, basis };
    }

    /* Dense Gaussian elimination with partial pivoting; null if singular. */
    function gauss(A, b) {
      const n = b.length;
      for (let c = 0; c < n; c++) {
        let p = c;
        for (let i = c + 1; i < n; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
        if (Math.abs(A[p][c]) < 1e-12) return null;
        [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
        for (let i = c + 1; i < n; i++) {
          const m = A[i][c] / A[c][c];
          if (!m) continue;
          for (let j = c; j < n; j++) A[i][j] -= m * A[c][j];
          b[i] -= m * b[c];
        }
      }
      const x = new Array(n);
      for (let i = n - 1; i >= 0; i--) {
        let s = b[i];
        for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
        x[i] = s / A[i][i];
      }
      return x;
    }

    function solve(state) {
      const st = state || defaultState();
      const isSet = new Uint8Array(R), auto = new Uint8Array(R);
      const L = new Float64Array(R);       // level
      const n = new Float64Array(R);       // whole machines of auto rows (monotone while iterating)
      const N = new Float64Array(R), C = new Float64Array(R);
      for (let i = 0; i < R; i++) {
        const r = rows[i], u = st.rows[r.id];
        if (r.kind === "fixed") { L[i] = 1; N[i] = 1; C[i] = 1; }
        else if (r.kind === "geo") { L[i] = r.cap; N[i] = r.cap; C[i] = 1; }
        else if (r.kind === "recipe") {
          if (u) { isSet[i] = 1; N[i] = Math.max(0, Math.round(+u.n || 0)); C[i] = Math.max(0, +u.clock || 0) / 100; L[i] = N[i] * C[i]; }
          else auto[i] = 1;
        }
      }
      const minNet = new Float64Array(K);
      for (const [id, q] of Object.entries(st.min || {})) if (id in rowIdx && rows[rowIdx[id]].outi.length) minNet[rows[rowIdx[id]].outi[0][0]] += +q || 0;

      // trim candidates per fluid: the maker and the sink, when on auto
      const cands = trimItems.map((k) => [maker[k], sink[k]].filter((r) => r >= 0 && auto[r]));
      const isCand = new Uint8Array(R);
      for (const c of cands) for (const r of c) isCand[r] = 1;
      const lean = !!st.lean;
      const choice = cands.map(() => 0);       // index into cands[i]; sticky between iterations
      const free = new Int32Array(R).fill(-1);  // row -> the fluid it trims now
      const req = new Float64Array(R);          // level each maker needs for its solids (and power)
      const made = new Float64Array(K), used = new Float64Array(K), need = new Float64Array(K);
      let T = Infinity, T5 = Infinity, bl = null, draw = 0, genRaw = 0, issues = [];

      const flows = () => {
        made.fill(0); used.fill(0);
        for (let i = 0; i < R; i++) {
          const l = L[i]; if (!l) continue;
          for (const [k, q] of rows[i].outi) made[k] += q * l;
          for (const [k, q] of rows[i].ini) used[k] += q * l;
        }
      };

      /* What a row would run at as an ordinary auto row, from the last evaluation's demand. */
      const ordinary = (i) => (lean ? Math.max(0, reqOf(i, -1)) : Math.max(n[i], Math.ceil(reqOf(i, -1) - EPS)));
      /* Solve the trims for one assignment; returns the worst violation (0 = valid). */
      const tryCombo = (ch, apply) => {
        const fr = [], fk = [];
        const taken = new Set();
        for (let i = 0; i < trimItems.length; i++) {
          if (!cands[i].length) continue;
          const r = cands[i][ch[i]];
          if (taken.has(r)) return Infinity;
          taken.add(r); fr.push(r); fk.push(trimItems[i]);
        }
        const m = fr.length;
        if (!m) return 0;
        const A = fk.map((k) => fr.map((r) => netRate(r, k)));
        const b = fk.map((k) => {
          let s = 0;
          for (let i = 0; i < R; i++) {
            if (taken.has(i)) continue;
            const l = auto[i] ? (isCand[i] ? ordinary(i) : n[i]) : L[i];
            if (l) s -= netRate(i, k) * l;
          }
          return s;
        });
        const x = gauss(A, b);
        if (!x) return Infinity;
        let bad = 0;
        for (let j = 0; j < m; j++) {
          const lo = Math.max(0, reqOf(fr[j], fk[j]));
          if (x[j] < lo - EPS) bad = Math.max(bad, lo - x[j]);
        }
        if (apply) {
          for (let i = 0; i < R; i++) if (isCand[i] && !taken.has(i)) n[i] = ordinary(i);
          free.fill(-1);
          for (let j = 0; j < m; j++) { free[fr[j]] = fk[j]; L[fr[j]] = Math.max(0, x[j]); }
        }
        return bad;
      };
      /* Level row r needs for the items it makes, leaving out the fluid it would trim. */
      let dem = null;  // demand per item from the last evaluation
      const reqOf = (r, skip) => {
        if (!dem) return 0;
        let q = 0;
        for (const k of makes[r]) {
          if (k === skip || (exact[k] && k !== POWER)) continue;
          const rate = k === POWER ? rows[r].gen : outRate(r, k);
          if (rate <= 0) continue;
          const others = (k === POWER ? genRaw : made[k]) - rate * L[r];
          q = Math.max(q, (dem[k] - others) / rate);
        }
        return q;
      };
      const pickCombo = () => {
        if (!trimItems.length) return;
        if (tryCombo(choice, false) > EPS) {
          // enumerate assignments, fewest sinks first
          const opts = [];
          const rec = (i, ch) => {
            if (i === cands.length) { opts.push(ch.slice()); return; }
            for (let c = 0; c < Math.max(1, cands[i].length); c++) { ch[i] = c; rec(i + 1, ch); }
          };
          rec(0, cands.map(() => 0));
          opts.sort((a, b) => a.reduce((s, v) => s + v, 0) - b.reduce((s, v) => s + v, 0));
          let best = null, bestBad = Infinity;
          for (const o of opts) {
            const bad = tryCombo(o, false);
            if (bad < bestBad) { best = o; bestBad = bad; if (bad <= EPS) break; }
          }
          if (best) for (let i = 0; i < choice.length; i++) choice[i] = best[i];
        }
        tryCombo(choice, true);
      };

      const evaluate = () => {
        for (let i = 0; i < R; i++) if (auto[i] && free[i] < 0) L[i] = n[i];
        pickCombo();
        for (let i = 0; i < R; i++) if (auto[i]) {
          if (free[i] < 0) L[i] = n[i];
          N[i] = L[i] > 1e-9 ? Math.ceil(L[i] - 1e-7) : 0; C[i] = N[i] ? L[i] / N[i] : 1;
        }
        // sources draw what is used
        for (const i of Object.values(rawSources).flat()) { L[i] = 0; N[i] = 0; C[i] = 1; }
        flows();
        for (const [k, list] of Object.entries(rawSources)) {
          let want = Math.max(0, used[k] - made[k]);
          list.forEach((i, j) => {
            const r = rows[i], rate = r.outi[0][1];
            const capL = r.cap == null ? Infinity : r.cap * r.maxClock;
            const l = j === list.length - 1 ? want / rate : Math.min(want / rate, capL);
            want -= l * rate;
            L[i] = l;
            N[i] = l > 1e-9 ? Math.ceil(l / r.maxClock - 1e-9) : 0;
            C[i] = N[i] ? l / N[i] : 1;
          });
        }
        flows();
        // Phase 5 pace and the rebuild time
        T5 = 0;
        for (const [k, q] of P5) { const v = made[k] - used[k]; T5 = Math.max(T5, v > 1e-9 ? q / v : Infinity); }
        T = st.T > 0 ? +st.T : T5;
        bl = bill(N, made);
        need.fill(0);
        if (isFinite(T)) {
          for (let k = 0; k < K; k++) if (bl.bom[k] && made0[k]) need[k] = bl.bom[k] / T;
          for (const [k, q] of P5) need[k] += q / T;
        }
        // power
        draw = 0; genRaw = 0;
        for (let i = 0; i < R; i++) {
          const r = rows[i];
          if (N[i] && r.p) draw += N[i] * r.p * Math.pow(C[i], r.pe);
          if (r.gen) genRaw += r.gen * L[i];
        }
        dem = new Float64Array(K);
        for (let k = 0; k < K; k++) dem[k] = used[k] + need[k] + minNet[k];
        dem[POWER] = (draw - AUG.mw) / (1 + AUG.boost);
        for (let i = 0; i < R; i++) req[i] = makes[i].length ? Math.max(0, reqOf(i, free[i])) : 0;
      };

      const settle = () => {
        if (lean) {
          /* Levels follow demand exactly.  Whole-machine effects (power at a clock, buildings)
           * make the map jumpy, so: damped steps toward the demand first, then only upward
           * steps until nothing is short. */
          for (let it = 0; it < 500; it++) {
            evaluate();
            const up = it >= 120;
            let d = 0;
            for (let i = 0; i < R; i++) {
              if (!auto[i] || free[i] >= 0) continue;
              const gap = req[i] - n[i];
              if (up) { if (gap > 1e-9) { n[i] = req[i]; d = Math.max(d, gap); } }
              else { n[i] += 0.7 * gap; d = Math.max(d, Math.abs(gap)); }
            }
            if (d < 1e-9) { evaluate(); return true; }
          }
          return false;
        }
        for (let it = 0; it < 400; it++) {
          evaluate();
          let changed = false;
          for (let i = 0; i < R; i++) {
            if (!auto[i] || free[i] >= 0) continue;
            const want = Math.ceil(req[i] - EPS);
            if (want > n[i]) { n[i] = want; changed = true; }
          }
          if (!changed) {
            const before = Array.from(free);
            evaluate();
            if (before.every((v, i) => v === free[i])) return true;
          }
        }
        return false;
      };

      let settled = settle();
      // lower what ended above its need
      for (let pass = 0; pass < 4 && settled && !lean; pass++) {
        let any = false;
        for (let i = 0; i < R; i++) {
          if (!auto[i] || free[i] >= 0) continue;
          const want = Math.max(0, Math.ceil(req[i] - EPS));
          if (want >= n[i]) continue;
          const keep = Float64Array.from(n), keepCh = choice.slice();
          const before = n.reduce((a, b) => a + b, 0);
          n[i] = want;
          const ok = settle();
          if (ok && n.reduce((a, b) => a + b, 0) < before) any = true;
          else { n.set(keep); keepCh.forEach((v, j) => { choice[j] = v; }); settle(); }
        }
        if (!any) break;
      }
      if (!settled) issues.push({ kind: "unsettled", text: "The counts did not settle; the figures shown are the last iteration." });

      // ---- report ----
      const supply = (1 + AUG.boost) * genRaw + AUG.mw;
      const outRows = rows.map((r, i) => {
        const role = r.kind !== "recipe" ? r.kind : isSet[i] ? "set" : free[i] >= 0 ? "trim" : "auto";
        const main = r.outi.length ? r.outi[0][0] : -1;
        return { id: r.id, role, n: N[i], clock: C[i] * 100, level: L[i], req: req[i], trims: free[i] >= 0 ? keys[free[i]] : null,
          mw: r.p && N[i] ? N[i] * r.p * Math.pow(C[i], r.pe) : 0, gen: r.gen * L[i], main: main >= 0 ? keys[main] : null,
          short: makes[i].length > 0 && L[i] < req[i] - 1e-6, over: r.cap != null && r.kind === "source" && L[i] > r.cap * r.maxClock + 1e-6 };
      });
      const items = [];
      let Tre = 0, limit = null;
      const gathered = [];
      for (let k = 0; k < K; k++) {
        if (k === POWER) continue;
        const net = made[k] - used[k];
        const want = need[k] + minNet[k];
        if (!made0[k]) { if (bl.bom[k]) gathered.push({ key: keys[k], amount: bl.bom[k] }); continue; }
        if (!made[k] && !used[k] && !want && !bl.bom[k]) continue;
        let status = "ok";
        if (exact[k]) { if (Math.abs(net) > 1e-6 * Math.max(1, made[k])) status = net > 0 ? "surplus" : "short"; }
        else if (net < want - 1e-6 * Math.max(1, want)) status = "short";
        const t = bl.bom[k] > 0 ? (net - minNet[k] > 1e-9 ? bl.bom[k] / (net - minNet[k]) : Infinity) : 0;
        if (bl.bom[k] > 0 && t > Tre) { Tre = t; limit = keys[k]; }
        items.push({ key: keys[k], fluid: isFluid[k], exact: !!exact[k], raw: !!isRaw[k], made: made[k], used: used[k], net, need: need[k],
          min: minNet[k], stock: bl.bom[k], time: t, status, maker: maker[k] >= 0 ? rows[maker[k]].id : null });
      }
      for (const it of items) {
        if (it.status === "ok") continue;
        issues.push({ kind: it.exact ? "exact" : "short", item: it.key,
          text: it.exact ? (IT[it.key].n + (it.status === "surplus" ? " piles up: " : " is short: ") + fmt(Math.abs(it.net)) + " /min" +
            (it.fluid ? " (nothing on auto can balance it)" : ""))
            : IT[it.key].n + " is short by " + fmt(it.net < 0 ? -it.net + (it.need + it.min) : it.need + it.min - it.net) + " /min" });
      }
      if (supply < draw - 1e-6) issues.push({ kind: "power", text: "Power is short by " + fmt(draw - supply) + " MW" });
      if (!isFinite(T)) issues.push({ kind: "phase5", text: "A Phase 5 part has no net production, so there is no pace to build against" });
      return { rows: outRows, items, issues, gathered, T, T5, Trebuild: Tre, limit, power: { generated: genRaw, supply, draw },
        machines: N.reduce((a, v, i) => a + (rows[i].kind === "fixed" ? 0 : Math.ceil(v - 1e-9)), 0), buildings: bl.total, basis: bl.basis, settled };
    }

    function fmt(x) { return Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2); }

    return { rows, rowIdx, keys, itemIdx, maker: SET.maker, sink: SET.sink, defaultState, solve, itemName: (k) => (IT[k] ? IT[k].n : k) };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SatPlanner = api;
})(typeof window !== "undefined" ? window : this);
