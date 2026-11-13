/* Machine moves page.  Expects GAME, MOVES_START, MOVES_TIERS and SatMoves.
 *
 * Rules (from MOVES_START.rules, written by tools/moves_start.py):
 *   the Phase 5 recipes are fixed at one exact batch; raw resources are drawn
 *   in multiples of 30/min; build-gun materials, ammunition, filters and fuels
 *   may pile up; everything else nets exactly 0.  Every machine at 100 %. */
(function () {
  "use strict";
  const G = window.GAME, Moves = window.SatMoves;
  const STORE = "satisfactory-moves.v2";
  const START = window.MOVES_START, RULES = START.rules, TIERS = window.MOVES_TIERS || { items: {}, recipes: {} };
  const FIXED = new Set(RULES.fixed);
  const opts = (recipes) => ({ recipes, accumulate: RULES.accumulate, rawStep: RULES.rawStep, fixed: RULES.fixed });
  const R = G.recipes, IT = G.items, B = G.buildings;
  const byId = {};
  R.forEach((r) => (byId[r.id] = r));
  const PROD = (r) => (r.kind === "machine" || r.kind === "burn") && !r.xmas;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const trim = (s) => (s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  function fmt(x, sign) {
    if (!isFinite(x)) return "∞";
    const a = Math.abs(x);
    if (a < 1e-9) return "0";
    const s = x < 0 ? "−" : sign ? "+" : "";
    let t;
    if (a >= 10000) t = Math.round(a).toLocaleString("en-US");
    else if (a >= 100) t = trim(a.toFixed(1));
    else if (a >= 1) t = trim(a.toFixed(3));
    else t = trim(a.toPrecision(4));
    return s + t;
  }
  const mname = (r) => (B[r.m] ? B[r.m].n : r.m);
  const iname = (k) => (IT[k] ? IT[k].n : k);

  /* ---- state ---- */
  let st = null;          // {recipes, n}; every machine at 100 %
  let E = null, nArr = [], netArr = null;
  let chains = [];
  /* Product chains ("make more of X"), indexed by every recipe they touch.
   * Rebuilt in the background after each rebuild of the engine. */
  let pchains = [], pindex = new Map(), pjob = 0;
  function indexProducts() {
    const job = ++pjob;
    pchains = []; pindex = new Map();
    const todo = E.items.map((k, i) => i).filter((i) => E.cls[i] === "surplus" && !Moves.PHASE5[E.items[i]] && [...E.rate[i].values()].some((a) => a > 0));
    const seen = new Set();
    let at = 0;
    const step = () => {
      if (job !== pjob) return; // superseded
      const t0 = performance.now();
      while (at < todo.length && performance.now() - t0 < 30) {
        for (const c of E.productChains(todo[at], nArr)) {
          const key = c.vec.join(",");
          if (seen.has(key)) continue;
          seen.add(key);
          const id = pchains.length;
          pchains.push(c);
          c.vec.forEach((x, j) => { if (x) { if (!pindex.has(j)) pindex.set(j, []); pindex.get(j).push(id); } });
        }
        at++;
      }
      $("#pcStatus").textContent = at < todo.length ? `indexing product chains ${at}/${todo.length}…` : `${pchains.length} product chains`;
      if (at < todo.length) setTimeout(step, 0);
      else if (selected) renderSide();
    };
    setTimeout(step, 0);
  }
  let selected = null, preview = null, sortKey = "n", sortDir = -1, lastShrink = null;
  const history = [];

  function save() { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) { /* storage unavailable */ } }
  function push() { history.push(JSON.stringify(st)); if (history.length > 100) history.shift(); $("#btnUndo").disabled = false; }

  /* Is a state usable: exact, valid, and the Phase 5 recipes at their fixed batch?  "" or why not. */
  function problem(E2, n) {
    for (const id of FIXED) {
      const j = E2.rIdx[id];
      if (j === undefined || n[j] !== (START.n[id] || 0)) return byId[id].name + " must run " + (START.n[id] || 0) + " machines (one Phase 5 batch)";
    }
    if (!E2.balanced(n)) return "the exact balances do not hold (a net-zero item is off, or a raw draw is not a multiple of " + RULES.rawStep + ")";
    const v = E2.violations(n, E2.netOf(n), null);
    if (v.length) return v.length + " condition" + (v.length > 1 ? "s are" : " is") + " broken";
    return "";
  }
  /* Build the engine for st (the counts stay valid: every change is a move). */
  function rebuild(why) {
    E = new Moves(G, opts(st.recipes));
    st.recipes = E.R.map((r) => r.id);
    nArr = E.R.map((r) => st.n[r.id] || 0);
    syncN();
    netArr = E.netOf(nArr);
    selected = selected && E.rIdx[selected] !== undefined ? selected : null;
    preview = null; lastShrink = null;
    banner(why || "");
    render();
    indexProducts();
  }
  function syncN() { st.n = {}; E.R.forEach((r, j) => { if (nArr[j]) st.n[r.id] = nArr[j]; }); save(); }

  function banner(t) { $("#msgText").textContent = t; $("#msgBanner").hidden = !t; }
  $("#msgClose").addEventListener("click", () => banner(""));

  /* ---- summary ---- */
  function renderSummary() {
    const mach = nArr.reduce((a, b) => a + b, 0);
    $("#sv-mach").textContent = mach.toLocaleString("en-US");
    $("#sv-rec").textContent = nArr.filter((x) => x > 0).length + " / " + E.R.length;
    $("#sv-dim").textContent = E.dim;
    const v = E.violations(nArr, netArr, null);
    $("#sv-valid").textContent = v.length ? v.length + " broken" : "valid";
    $("#st-valid").classList.toggle("bad", v.length > 0);
    const ai = E.iIdx.SpaceElevatorPart_12;
    if (ai !== undefined) {
      $("#sv-p5").innerHTML = fmt(netArr[ai]) + " <small>AI servers/min, fixed</small>";
    } else $("#sv-p5").textContent = "–";
    const pw = -E.powerOf(nArr);
    $("#sv-pow").innerHTML = fmt(pw, true) + " <small>MW</small>";
  }

  /* ---- recipe table ---- */
  function rows() {
    const q = $("#q").value.trim().toLowerCase();
    let idx = E.R.map((r, j) => j).filter((j) => !q || E.R[j].name.toLowerCase().includes(q) || mname(E.R[j]).toLowerCase().includes(q));
    const key = (j) => sortKey === "name" ? E.R[j].name : sortKey === "step" ? Number(E.steps[j]) : nArr[j];
    idx.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * sortDir || E.R[a].name.localeCompare(E.R[b].name); });
    return idx;
  }
  function renderTable() {
    const idx = rows();
    const big = Math.max(1, ...nArr);
    $("#rbody").innerHTML = idx.map((j) => {
      const r = E.R[j], s = Number(E.steps[j]);
      const d = preview ? preview[j] : 0;
      return `<tr data-j="${j}" class="${r.id === selected ? "sel" : ""} ${nArr[j] ? "" : "zero"}">
        <td class="rcell"><span class="rn">${esc(r.name)}</span><span class="rm">${esc(mname(r))}</span></td>
        <td class="n">${nArr[j].toLocaleString("en-US")}</td>
        <td class="n ${s > Math.max(4, nArr[j] / 4) ? "big" : ""}" title="${s ? "Machine count changes in steps of " + s : FIXED.has(r.id) ? "Phase 5: fixed at one batch" : "Fixed: no move changes it"}">${s ? s.toLocaleString("en-US") : "fixed"}</td>
        <td class="n d ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d ? (d > 0 ? "+" : "−") + Math.abs(d) : ""}</td></tr>`;
    }).join("");
    $("#rowCount").textContent = idx.length + " recipes";
    document.querySelectorAll("#rtab th.sortable").forEach((th) => th.setAttribute("aria-sort", th.dataset.sort === sortKey ? (sortDir < 0 ? "descending" : "ascending") : "none"));
    void big;
  }
  $("#rtab thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = sortKey === "name" ? 1 : -1; }
    renderTable();
  });
  $("#rbody").addEventListener("click", (e) => {
    if (e.target.closest("input")) return;
    const tr = e.target.closest("tr");
    if (!tr) return;
    selected = E.R[+tr.dataset.j].id; lastShrink = null;
    renderTable(); renderSide();
  });
  $("#q").addEventListener("input", renderTable);

  /* ---- moves panel ---- */
  function deltaOf(coefs) {
    const d = new Array(E.R.length).fill(0);
    for (const [i, c] of coefs) { const v = E.K[i]; for (let x = 0; x < v.length; x++) if (v[x]) d[x] += c * v[x]; }
    return d;
  }
  function chipsFor(d, j0) {
    const idx = d.map((x, j) => j).filter((j) => d[j]).sort((a, b) => (b === j0) - (a === j0) || Math.abs(d[b]) - Math.abs(d[a]));
    const shown = idx.slice(0, 10);
    return shown.map((j) => `<span class="chip ${d[j] > 0 ? "up" : "down"} ${j === j0 ? "self" : ""}">${d[j] > 0 ? "+" : "−"}${Math.abs(d[j])} ${esc(E.R[j].name)}</span>`).join("") +
      (idx.length > shown.length ? `<span class="chip">and ${idx.length - shown.length} more</span>` : "");
  }
  function effectsText(coefs) { return effectsOf(deltaOf(coefs)); }
  /* Effects of a change d in machine counts: surplus, raw draw, power. */
  function effectsOf(d) {
    const dn = E.netOf(d);
    const parts = [], sur = [], raw = [];
    dn.forEach((v, i) => {
      if (Math.abs(v) < 1e-9) return;
      if (E.cls[i] === "surplus") sur.push([i, v]);
      else if (E.cls[i] === "raw") raw.push([i, v]);
    });
    sur.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (sur.length) parts.push("surplus " + sur.slice(0, 4).map(([i, v]) => iname(E.items[i]) + " " + fmt(v, true)).join(", ") + (sur.length > 4 ? ", …" : ""));
    if (raw.length) parts.push("raw " + raw.slice(0, 3).map(([i, v]) => iname(E.items[i]) + " " + fmt(v, true)).join(", ") + (raw.length > 3 ? ", …" : ""));
    let dp = 0;
    d.forEach((x, j) => (dp -= x * E.power[j]));
    if (Math.abs(dp) > 1e-9) parts.push("power " + fmt(dp, true) + " MW");
    return parts.join(" · ");
  }
  /* Why adding c * vec (a change in machine counts) is not allowed, or "". */
  function whyVec(vec, c) {
    const n2 = nArr.map((x, j) => x + c * vec[j]);
    const net2 = E.netOf(n2);
    if (n2.every((x) => x >= 0) && E.badness(n2, net2, null) <= E.badness(nArr, netArr, null) + 1e-9) return "";
    const v = E.violations(n2, net2, null);
    if (!v.length) return "";
    const x = v[0];
    if (x.kind === "count") return E.R[x.j].name + " would go below 0 machines";
    if (x.kind === "short") return iname(E.items[x.i]) + " would run short by " + fmt(x.amount) + "/min";
    if (x.kind === "raw") return iname(E.items[x.i]) + " would be produced instead of drawn";
    return iname(E.items[x.i]) + " would drop below its minimum";
  }
  function why(coefs) {
    const n2 = E.apply(nArr, coefs);
    const net2 = Float64Array.from(netArr);
    for (const [i, c] of coefs) { const m = E.moveNet[i]; for (let x = 0; x < m.length; x++) net2[x] += c * m[x]; }
    if (E.badness(n2, net2, null) <= E.badness(nArr, netArr, null) + 1e-9 && n2.every((x) => x >= 0)) return "";
    const v = E.violations(n2, net2, null);
    if (!v.length) return "";
    const x = v[0];
    if (x.kind === "count") return E.R[x.j].name + " would go below 0 machines";
    if (x.kind === "short") return iname(E.items[x.i]) + " would run short by " + fmt(x.amount) + "/min";
    if (x.kind === "raw") return iname(E.items[x.i]) + " would be produced instead of drawn";
    return iname(E.items[x.i]) + " would drop below its minimum";
  }
  function renderSide() {
    const side = $("#side");
    if (!selected) { side.innerHTML = `<div class="side-empty">Select a recipe to see the moves that change it.</div>`; return; }
    const j = E.rIdx[selected], r = E.R[j], s = Number(E.steps[j]);
    const mv = E.movesFor(j);
    let html = `<div class="side-head"><h2>${esc(r.name)}</h2><div class="meta">${esc(mname(r))} · ${nArr[j].toLocaleString("en-US")} machines · ${s ? "step " + s : "fixed by the exact balances"} · ${mv.length} move${mv.length === 1 ? "" : "s"}</div></div>`;
    html += `<div class="shrink"><div class="row1"><button class="btn primary" type="button" id="btnShrink" ${nArr[j] > 0 && mv.length ? "" : "disabled"}>Shrink this</button><span class="count">searches combinations of up to 3 moves</span>${nArr[j] === 0 && !FIXED.has(r.id) ? ` <button class="btn danger" type="button" id="btnRemove">Remove recipe</button>` : ""}</div><div class="res" id="shrinkRes">${shrinkHtml(j)}</div></div>`;
    chains = nArr ? E.chainMoves(nArr, j, null) : [];
    if (chains.length) {
      html += `<h3 class="sec">Chain moves <span class="count">this recipe plus the suppliers and consumers it needs</span></h3>`;
      html += chains.map((c, ci) => {
        const self = c.vec[j];
        const wp = whyVec(c.vec, 1), wm = whyVec(c.vec, -1);
        return `<div class="move chain" data-ch="${ci}"><div class="mh"><span class="mt">Chain · ${self} machine${self === 1 ? "" : "s"} of this</span>
          <span class="btns"><button class="btn" type="button" data-c="-1" ${wm ? `disabled title="${esc(wm)}"` : `title="Apply: ${self} fewer of this"`}>−</button><button class="btn" type="button" data-c="1" ${wp ? `disabled title="${esc(wp)}"` : `title="Apply: ${self} more of this"`}>+</button></span></div>
          <div class="chips">${chipsFor(c.vec, j)}</div><div class="eff">${esc(effectsOf(c.vec))} <i>(for +; − is the reverse)</i></div>${wm ? `<div class="why">− blocked: ${esc(wm)}.</div>` : ""}${wp ? `<div class="why">+ blocked: ${esc(wp)}.</div>` : ""}</div>`;
      }).join("");
    }
    const pids = (pindex.get(j) || []).filter((id) => pchains[id].via !== j || !chains.some((c) => c.vec.join(",") === pchains[id].vec.join(",")));
    if (pids.length) {
      const rows = pids.map((id) => ({ id, c: pchains[id], wp: whyVec(pchains[id].vec, 1), wm: whyVec(pchains[id].vec, -1) }))
        .sort((a, b) => (!a.wp || !a.wm ? 0 : 1) - (!b.wp || !b.wm ? 0 : 1) || a.c.size - b.c.size).slice(0, 12);
      html += `<h3 class="sec">Product chains through this recipe <span class="count">“make more of X” moves that use it (${pids.length})</span></h3>`;
      html += rows.map(({ id, c, wp, wm }) => `<div class="move chain pchain" data-pc="${id}"><div class="mh"><span class="mt">More ${esc(iname(E.items[c.item]))} · ${fmt(c.gain, true)}/min via ${esc(E.R[c.via].name)}</span>
          <span class="btns"><button class="btn" type="button" data-c="-1" ${wm ? `disabled title="${esc(wm)}"` : `title="Apply: less ${esc(iname(E.items[c.item]))}"`}>−</button><button class="btn" type="button" data-c="1" ${wp ? `disabled title="${esc(wp)}"` : `title="Apply: more ${esc(iname(E.items[c.item]))}"`}>+</button></span></div>
          <div class="chips">${chipsFor(c.vec, j)}</div><div class="eff">${esc(effectsOf(c.vec))}</div>${wm ? `<div class="why">− blocked: ${esc(wm)}.</div>` : ""}${wp ? `<div class="why">+ blocked: ${esc(wp)}.</div>` : ""}</div>`).join("");
    }
    if (chains.length || pids.length) html += `<h3 class="sec">Lattice moves <span class="count">the reduced basis; every exact change is a combination of these</span></h3>`;
    html += mv.length ? mv.map((i) => {
      const self = E.K[i][j];
      const plus = [[i, self > 0 ? 1 : -1]], minus = [[i, self > 0 ? -1 : 1]]; // "+" raises this recipe
      const hugeMsg = E.huge[i] ? "This move changes some recipe by more than a trillion machines" : "";
      const wp = hugeMsg || why(plus), wm = hugeMsg || why(minus);
      return `<div class="move" data-i="${i}" data-s="${self > 0 ? 1 : -1}"><div class="mh"><span class="mt">Move ${i + 1} · ${Math.abs(self)} machine${Math.abs(self) === 1 ? "" : "s"} of this</span>
        <span class="btns"><button class="btn" type="button" data-c="-1" ${wm ? `disabled title="${esc(wm)}"` : `title="Apply: ${Math.abs(self)} fewer of this"`}>−</button><button class="btn" type="button" data-c="1" ${wp ? `disabled title="${esc(wp)}"` : `title="Apply: ${Math.abs(self)} more of this"`}>+</button></span></div>
        <div class="chips">${chipsFor(deltaOf(plus), j)}</div><div class="eff">${esc(effectsText(plus))} <i>(for +; − is the reverse)</i></div>${wm ? `<div class="why">− blocked: ${esc(wm)}.</div>` : ""}${wp ? `<div class="why">+ blocked: ${esc(wp)}.</div>` : ""}</div>`;
    }).join("") : `<div class="side-empty">${FIXED.has(r.id) ? "A Phase 5 recipe: fixed at one exact batch." : "No move changes this recipe: the exact balances fix its machine count. Adding a recipe can free it."}</div>`;
    side.innerHTML = html;
  }
  function shrinkHtml(j) {
    if (!lastShrink || lastShrink.j !== j) return "";
    const s = lastShrink.res;
    if (!s) return `<span class="why">No combination of up to 3 moves lowers it without breaking something. Try adding a recipe.</span>`;
    const d = deltaOf(s.coefs);
    return `<div><b>${nArr[j].toLocaleString("en-US")} → ${s.n[j].toLocaleString("en-US")}</b> machines of this; ${fmt(s.dTotal, true)} machines in all; ${s.coefs.length} move${s.coefs.length > 1 ? "s" : ""} (${s.coefs.map(([i, c]) => (c > 0 ? "+" : "−") + (Math.abs(c) > 1 ? Math.abs(c) + "×" : "") + "move " + (i + 1)).join(", ")}).</div>
      <div class="chips">${chipsFor(d, j)}</div><div class="eff">${esc(effectsText(s.coefs))}</div>
      <div style="margin-top:6px"><button class="btn primary" type="button" id="btnApplyShrink">Apply</button></div>`;
  }
  function applyCoefs(coefs, label) {
    push();
    nArr = E.apply(nArr, coefs);
    for (const [i, c] of coefs) { const m = E.moveNet[i]; for (let x = 0; x < m.length; x++) netArr[x] += c * m[x]; }
    netArr = E.netOf(nArr); // recompute (no drift)
    syncN();
    preview = null; lastShrink = null;
    banner(label || "");
    render();
  }
  $("#side").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.id === "btnShrink") {
      const j = E.rIdx[selected];
      b.disabled = true; b.textContent = "Searching…";
      setTimeout(() => {
        const t0 = performance.now();
        const res = E.shrink(nArr, j, null);
        lastShrink = { j, res };
        renderSide();
        banner("Shrink search: " + (res ? res.evals.toLocaleString("en-US") + " combinations tried" : "nothing found") + " in " + Math.round(performance.now() - t0) + " ms.");
        if (res) { preview = deltaOf(res.coefs); renderTable(); }
      }, 10);
      return;
    }
    if (b.id === "btnApplyShrink") { applyCoefs(lastShrink.res.coefs, "Applied the shrink."); return; }
    if (b.id === "btnRemove") {
      push();
      st.recipes = st.recipes.filter((id) => id !== selected);
      delete st.n[selected];
      selected = null;
      rebuild("Recipe removed.");
      return;
    }
    const chEl = b.closest(".move.chain");
    if (chEl && b.dataset.c) {
      const vec = chEl.dataset.pc !== undefined ? pchains[+chEl.dataset.pc].vec : chains[+chEl.dataset.ch].vec, c = +b.dataset.c;
      push();
      nArr = nArr.map((x, j) => x + c * vec[j]);
      netArr = E.netOf(nArr); syncN(); preview = null; lastShrink = null;
      banner("Applied a chain move.");
      render();
      return;
    }
    const mvEl = b.closest(".move");
    if (mvEl && b.dataset.c) {
      const i = +mvEl.dataset.i, c = +b.dataset.c * +mvEl.dataset.s;
      applyCoefs([[i, c]], "Applied move " + (i + 1) + ".");
    }
  });
  let hoverKey = null;
  $("#side").addEventListener("mouseover", (e) => {
    const m = e.target.closest(".move");
    const key = m ? (m.dataset.pc !== undefined ? "p" + m.dataset.pc : m.dataset.ch !== undefined ? "c" + m.dataset.ch : m.dataset.i) : null;
    if (key === hoverKey) return;
    hoverKey = key;
    if (!m) return;
    preview = m.dataset.pc !== undefined ? pchains[+m.dataset.pc].vec.slice() : m.dataset.ch !== undefined ? chains[+m.dataset.ch].vec.slice() : deltaOf([[+m.dataset.i, +m.dataset.s]]);
    renderTable();
  });
  $("#side").addEventListener("mouseleave", () => {
    hoverKey = null;
    preview = lastShrink && lastShrink.res && lastShrink.j === E.rIdx[selected] ? deltaOf(lastShrink.res.coefs) : null;
    renderTable();
  });

  /* ---- products tab ---- */
  const tierOf = (k) => TIERS.items[k] || null;
  const ruleOf = (i) => Moves.PHASE5[E.items[i]] ? "p5" : E.cls[i] === "balance" ? "zero" : E.cls[i] === "raw" ? "raw" : "pile";
  const RULE_TXT = { zero: "net 0", pile: "piles up", raw: "raw, ×" + RULES.rawStep, p5: "Phase 5 (fixed)", none: "build only" };
  /* Items it takes to build every machine now in the factory. */
  function bom() {
    const out = new Map();
    E.R.forEach((r, j) => {
      if (!nArr[j]) return;
      const b = B[r.m];
      if (b) for (const [k, q] of b.cost) out.set(k, (out.get(k) || 0) + q * nArr[j]);
    });
    return out;
  }
  let pSort = "tier", pDir = 1, product = null;
  function renderProducts() {
    const cost = bom();
    const keys = [...new Set(E.items.concat([...cost.keys()]))];
    const row = (k) => {
      const i = E.iIdx[k], t = tierOf(k);
      return { k, i, name: iname(k), tier: t ? t[0] : 99, via: t ? "Tier " + t[0] + ": " + t[1] : "no unlock found", rule: i === undefined ? "none" : ruleOf(i),
        net: i === undefined ? 0 : netArr[i], bom: cost.get(k) || 0 };
    };
    const q = $("#pq").value.trim().toLowerCase();
    const list = keys.map(row).filter((x) => !q || x.name.toLowerCase().includes(q));
    const ord = { zero: 0, pile: 1, p5: 2, raw: 3, none: 4 };
    const key = (x) => pSort === "name" ? x.name : pSort === "rule" ? ord[x.rule] : x[pSort];
    list.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * pDir || a.tier - b.tier || a.name.localeCompare(b.name); });
    $("#pbody").innerHTML = list.map((x) => `<tr data-k="${esc(x.k)}" class="r-${x.rule} ${x.k === product ? "sel" : ""}">
      <td>${esc(x.name)}</td>
      <td class="n" title="${esc(x.via)}">${x.tier < 99 ? x.tier : "–"}</td>
      <td class="rule">${RULE_TXT[x.rule]}</td>
      <td class="n">${x.i === undefined ? "" : fmt(x.net)}</td>
      <td class="n">${x.bom ? Math.round(x.bom).toLocaleString("en-US") : ""}</td></tr>`).join("");
    $("#pCount").textContent = list.length + " products";
    document.querySelectorAll("#ptab th.sortable").forEach((th) => th.setAttribute("aria-sort", th.dataset.sort === pSort ? (pDir < 0 ? "descending" : "ascending") : "none"));
  }
  $("#ptab thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    if (pSort === th.dataset.sort) pDir = -pDir; else { pSort = th.dataset.sort; pDir = pSort === "net" || pSort === "bom" ? -1 : 1; }
    renderProducts();
  });
  $("#pq").addEventListener("input", renderProducts);
  $("#pbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    product = tr.dataset.k;
    renderProducts();
    computeSheet();
  });

  /* The move sheet for the selected product: the unblocked moves that change
   * its net or the machines that make or use it.  Columns are moves, rows the
   * recipes they touch.  Candidates: the product's own product chains, the
   * chain moves of each recipe that makes or uses it, and the lattice basis,
   * each tried in both directions. */
  let sheet = null, sheetJob = 0;
  const MAXCOL = 30;
  function okDir(vec) {
    const n2 = nArr.map((x, j) => x + vec[j]);
    if (n2.some((x) => x < 0)) return false;
    return E.violations(n2, E.netOf(n2), null).length === 0;
  }
  function computeSheet() {
    const job = ++sheetJob;
    const host = $("#sheet");
    if (!product) { host.innerHTML = `<div class="side-empty">Select a product to see the moves that change it.</div>`; return; }
    const i = E.iIdx[product];
    if (i === undefined) { host.innerHTML = `<div class="side-empty">${esc(iname(product))} is only a building material here: no recipe in the set makes or uses it.</div>`; return; }
    if (!sheet || sheet.item !== product) host.innerHTML = `<div class="side-empty">Finding moves for ${esc(iname(product))}…</div>`;
    const touch = [...E.rate[i].keys()].filter((j) => !FIXED.has(E.R[j].id)).sort((a, b) => (nArr[b] > 0) - (nArr[a] > 0) || nArr[b] - nArr[a]);
    const cols = new Map(); // key -> {vec, src}
    const add = (vec, src) => {
      if (!vec.some((x) => x)) return;
      for (const sgn of [1, -1]) {
        const v = sgn > 0 ? vec.slice() : vec.map((x) => -x);
        const key = v.join(",");
        if (cols.has(key) || !okDir(v)) continue;
        cols.set(key, { vec: v, src: (sgn > 0 ? "" : "reverse of ") + src });
      }
    };
    const tasks = [];
    if (ruleOf(i) === "pile") tasks.push(() => { for (const c of E.productChains(i, nArr)) add(c.vec, "product chain via " + E.R[c.via].name); });
    for (const j of touch.slice(0, 8)) tasks.push(() => { for (const c of E.chainMoves(nArr, j, null, { want: 6 })) add(c.vec, "chain move of " + E.R[j].name); });
    tasks.push(() => {
      E.K.forEach((v, b) => {
        if (E.huge[b]) return;
        if (Math.abs(E.moveNet[b][i]) > 1e-9 || touch.some((j) => v[j])) add(v, "lattice move " + (b + 1));
      });
    });
    let t = 0;
    const step = () => {
      if (job !== sheetJob) return;
      const t0 = performance.now();
      while (t < tasks.length && performance.now() - t0 < 40) tasks[t++]();
      if (t < tasks.length) { $("#sheetStatus").textContent = `finding moves ${t}/${tasks.length}…`; setTimeout(step, 0); return; }
      $("#sheetStatus").textContent = "";
      sheet = { item: product, i, touch, cols: [...cols.values()] };
      renderSheet();
    };
    setTimeout(step, 0);
  }
  function renderSheet() {
    const host = $("#sheet");
    if (!sheet || sheet.item !== product) return;
    const { i, touch } = sheet;
    const rateI = E.rate[i];
    const dI = (vec) => { let s = 0; for (const [j, a] of rateI) if (vec[j]) s += a * vec[j]; return s; };
    const thr = (vec) => { let s = 0; for (const [j, a] of rateI) if (vec[j] && a > 0) s += a * vec[j]; return s; };
    const size = (vec) => vec.reduce((a, x) => a + Math.abs(x), 0);
    const flow = ruleOf(i) === "zero" || ruleOf(i) === "p5"; // the net cannot change: sort by throughput
    const cols = sheet.cols.map((c) => Object.assign(c, { d: dI(c.vec), thr: thr(c.vec), size: size(c.vec), tot: c.vec.reduce((a, x) => a + x, 0) }))
      .sort((a, b) => (flow ? b.thr - a.thr : b.d - a.d) || a.size - b.size);
    const shown = cols.slice(0, MAXCOL);
    sheet.shown = shown;
    const head = `<div class="side-head"><h2>${esc(iname(product))}</h2><div class="meta">${RULE_TXT[ruleOf(i)]} · net ${fmt(netArr[i])}/min · made or used by ${rateI.size} recipe${rateI.size === 1 ? "" : "s"} · ${cols.length} unblocked move${cols.length === 1 ? "" : "s"}${cols.length > MAXCOL ? " (first " + MAXCOL + " shown)" : ""}</div></div>`;
    if (!shown.length) { host.innerHTML = head + `<div class="side-empty">Every move found that touches ${esc(iname(product))} is blocked from here.</div>`; return; }
    // rows: the recipes that make the product, then those that use it, then the rest by how many columns touch them
    const hits = new Map();
    for (const c of shown) c.vec.forEach((x, j) => { if (x) hits.set(j, (hits.get(j) || 0) + 1); });
    const role = (j) => (rateI.get(j) > 0 ? 2 : rateI.get(j) < 0 ? 1 : 0);
    const rowsJ = [...hits.keys()].sort((a, b) => role(b) - role(a) || hits.get(b) - hits.get(a) || E.R[a].name.localeCompare(E.R[b].name));
    const cell = (x) => x ? `<td class="d ${x > 0 ? "up" : "down"}">${x > 0 ? "+" : "−"}${Math.abs(x).toLocaleString("en-US")}</td>` : `<td></td>`;
    const dcell = (v) => `<td class="d ${v > 1e-9 ? "up" : v < -1e-9 ? "down" : ""}">${Math.abs(v) > 1e-9 ? fmt(v, true) : "0"}</td>`;
    let h = head + `<div class="scroll sheet-scroll"><table id="stab"><thead>
      <tr><th class="rc">Move</th><th class="n">Now</th>${shown.map((c, x) => `<th class="mc" title="${esc(c.src + (effectsOf(c.vec) ? " · " + effectsOf(c.vec) : ""))}">${x + 1}</th>`).join("")}</tr>
      <tr class="sum"><th class="rc">Δ ${esc(iname(product))} /min</th><td class="n">${fmt(netArr[i])}</td>${shown.map((c) => dcell(c.d)).join("")}</tr>
      ${flow ? `<tr class="sum"><th class="rc">Δ made /min</th><td class="n">${fmt(thr(nArr))}</td>${shown.map((c) => dcell(c.thr)).join("")}</tr>` : ""}
      <tr class="sum"><th class="rc">Δ machines</th><td class="n">${nArr.reduce((a, b) => a + b, 0).toLocaleString("en-US")}</td>${shown.map((c) => dcell(c.tot)).join("")}</tr>
      <tr class="sum"><th class="rc"></th><td></td>${shown.map((c, x) => `<td><button class="btn" type="button" data-col="${x}" title="Apply move ${x + 1}: ${esc(c.src)}">Apply</button></td>`).join("")}</tr>
      </thead><tbody>`;
    h += rowsJ.map((j) => `<tr class="role${role(j)}"><th class="rc"><span class="rn">${esc(E.R[j].name)}</span><span class="rm">${role(j) === 2 ? "makes it" : role(j) === 1 ? "uses it" : esc(mname(E.R[j]))}</span></th><td class="n">${nArr[j].toLocaleString("en-US")}</td>${shown.map((c) => cell(c.vec[j])).join("")}</tr>`).join("");
    h += `</tbody></table></div><p class="note">Each column is one exact move, already checked: nothing goes below zero machines, nothing that may pile up runs short, and no raw resource is produced. Hover a column number to see where the move came from and its other effects; applying one recomputes the sheet.</p>`;
    host.innerHTML = h;
  }
  $("#sheet").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-col]");
    if (!b || !sheet || !sheet.shown) return;
    const c = sheet.shown[+b.dataset.col];
    push();
    nArr = nArr.map((x, j) => x + c.vec[j]);
    netArr = E.netOf(nArr); syncN(); preview = null; lastShrink = null;
    banner("Applied move " + (+b.dataset.col + 1) + " (" + c.src + ").");
    render();
  });

  const addList = $("#addlist");
  function fillAdd() {
    const have = new Set(st.recipes);
    addList.innerHTML = R.filter((r) => PROD(r) && !have.has(r.id)).map((r) => `<option value="${esc(r.name)}">`).join("");
  }
  $("#addq").addEventListener("change", (e) => {
    const name = e.target.value.trim();
    const r = R.find((x) => PROD(x) && x.name === name && !st.recipes.includes(x.id));
    if (!r) return;
    push();
    st.recipes.push(r.id);
    e.target.value = "";
    selected = r.id;
    rebuild(r.name + " added at 0 machines.");
  });
  $("#btnUndo").addEventListener("click", () => {
    if (!history.length) return;
    st = JSON.parse(history.pop());
    $("#btnUndo").disabled = !history.length;
    rebuild("Undone.");
  });
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tabs button").forEach((x) => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    document.querySelectorAll("main > .panel").forEach((p) => (p.hidden = p.id !== "tab-" + b.dataset.tab));
    render();
  });

  function render() {
    renderSummary();
    if (!$("#tab-recipes").hidden) { renderTable(); renderSide(); }
    if (!$("#tab-products").hidden) { renderProducts(); computeSheet(); }
    fillAdd();
  }

  /* ---- import / export ---- */
  function startState() { return { recipes: START.recipes.slice(), n: Object.assign({}, START.n) }; }
  function loadObject(o, label) {
    let next = null;
    if (o && o.app === "satisfactory-machine-moves" && o.state) next = { recipes: o.state.recipes || [], n: o.state.n || {} };
    else if (o && o.sheet && o.sheet.n) {
      next = { recipes: Object.keys(o.sheet.n).filter((id) => byId[id] && PROD(byId[id])), n: {} };
      for (const id of next.recipes) {
        const c = (o.sheet.c && o.sheet.c[id]) || 1;
        if (Math.abs(c - 1) > 1e-9) { banner("Not imported: " + byId[id].name + " runs at " + trim((c * 100).toFixed(4)) + " %; this page needs every machine at 100 %."); return; }
        next.n[id] = o.sheet.n[id];
      }
      if (o.moves && Array.isArray(o.moves.recipes)) for (const id of o.moves.recipes) if (byId[id] && PROD(byId[id]) && !next.recipes.includes(id)) next.recipes.push(id);
    }
    if (!next || !next.recipes.length) { banner("That file has no production recipes with machines."); return; }
    for (const id of FIXED) if (!next.recipes.includes(id)) next.recipes.push(id);
    const E2 = new Moves(G, opts(next.recipes));
    const why = problem(E2, E2.R.map((r) => next.n[r.id] || 0));
    if (why) { banner("Not imported: " + why + "."); return; }
    if (st) push();
    st = next;
    selected = null;
    rebuild(label || "");
  }
  $("#fileState").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => { try { loadObject(JSON.parse(t), "Imported " + f.name + "."); } catch (err) { banner("Could not read that file as JSON."); } });
    e.target.value = "";
  });
  $("#btnStart").addEventListener("click", () => { if (st) push(); st = startState(); selected = null; rebuild("Back to the start."); });
  let downloads = null;
  if (window.claude && window.claude.use) {
    window.claude.use("downloads").then((d) => { downloads = d; $("#btnExport").hidden = !d; }).catch(() => {});
  }
  $("#btnExport").addEventListener("click", async () => {
    if (!downloads) return;
    const sheet = { c: {}, n: {}, f: {}, x: [] };
    E.R.forEach((r, j) => { if (nArr[j]) { sheet.n[r.id] = nArr[j]; sheet.c[r.id] = 1; } });
    const data = JSON.stringify({ app: "satisfactory-production-sheet", v: 1, sheet, settings: {},
      moves: { n100: true, recipes: st.recipes } }, null, 1);
    const day = new Date().toISOString().slice(0, 10);
    try { await downloads.save({ filename: `machine-moves-${day}.json`, data }); $("#ioMsg").textContent = "Exported."; }
    catch (err) { $("#ioMsg").textContent = err && err.code === "declined" ? "Export cancelled." : "Export failed."; }
  });

  /* ---- start ---- */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { saved = null; }
  if (saved && saved.recipes && saved.n) {
    const E2 = new Moves(G, opts(saved.recipes));
    if (!problem(E2, E2.R.map((r) => saved.n[r.id] || 0))) st = { recipes: saved.recipes, n: saved.n };
  }
  if (!st) st = startState();
  rebuild("");
})();
