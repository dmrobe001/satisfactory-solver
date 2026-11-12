/* Machine moves page.  Expects GAME, MOVES_PLAN, MOVES_START and SatMoves. */
(function () {
  "use strict";
  const G = window.GAME, Moves = window.SatMoves;
  const STORE = "satisfactory-moves.v1";
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
  let st = null;          // {recipes, n, base, batches, valves, pins, lockP5}; every machine at 100 %
  let E = null, nArr = [], netArr = null, pins = new Map();
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

  function fromSheet(sheet) {
    // the plan's effective rates (machines x clock) become the recipe ratios to aim for
    const recipes = [], base = {};
    for (const [id, v] of Object.entries((sheet && sheet.n) || {})) {
      const r = byId[id];
      if (!r || !PROD(r) || !(v > 0)) continue;
      recipes.push(id);
      base[id] = v * ((sheet.c && sheet.c[id]) || 1);
    }
    return { recipes, n: {}, base, batches: 1, valves: {}, pins: {}, lockP5: true };
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) { /* storage unavailable */ } }
  function push() { history.push(JSON.stringify(st)); if (history.length > 100) history.shift(); $("#btnUndo").disabled = false; }

  /* Phase 5 batch at the current recipes and valves (AI Expansion Servers per
   * minute), or 0 when the ratio is unlocked or there is no AI Expansion Server. */
  let batch = 0;
  function p5pins() {
    const ai = E.iIdx.SpaceElevatorPart_12;
    batch = 0;
    if (st.lockP5 && ai !== undefined) { const s = E.itemStep(ai); if (s) batch = Number(s[0]) / Number(s[1]); }
    pins = new Map();
    for (const [k, v] of Object.entries(st.pins)) if (E.iIdx[k] !== undefined && isFinite(v) && !(batch && Moves.PHASE5[k])) pins.set(E.iIdx[k], +v);
    if (batch) for (const k of Object.keys(Moves.PHASE5)) if (E.iIdx[k] !== undefined) pins.set(E.iIdx[k], st.batches * batch * Moves.PHASE5[k] / 256 - 1e-9);
  }
  /* The real-valued factory to snap to: the base ratios, scaled to the batches. */
  function target() {
    const base = E.R.map((r) => (st.base[r.id] !== undefined ? st.base[r.id] : st.n[r.id] || 0));
    const ai = E.iIdx.SpaceElevatorPart_12;
    if (batch && ai !== undefined) {
      const have = E.netOf(base)[ai];
      if (have > 0) { const f = st.batches * batch / have; return base.map((x) => x * f); }
    }
    return base;
  }
  /* Build the engine for st; keep the counts if they are still exact and valid
   * (unless force), otherwise snap to the nearest valid factory. */
  function rebuild(why, force) {
    const t0 = performance.now();
    E = new Moves(G, { recipes: st.recipes, valves: st.valves, lockP5: st.lockP5 });
    st.recipes = E.R.map((r) => r.id);
    p5pins();
    nArr = E.R.map((r) => st.n[r.id] || 0);
    let msg = "";
    let startK = null; // the start's whole counts times the batches are exact, when the recipes still allow it
    if (force && st.startN) {
      const c = E.R.map((r) => (st.startN[r.id] || 0) * st.batches);
      if (c.some((x) => x) && E.balanced(c) && E.valid(c, pins)) startK = c;
    }
    if (startK) { nArr = startK; msg = why || ""; }
    else if (force || !nArr.some((x) => x) || !E.balanced(nArr) || !E.valid(nArr, pins)) {
      const res = E.snapSupport(target(), pins);
      nArr = res.n;
      msg = (why ? why + " " : "") + (res.ok ? "Snapped to the nearest valid factory." :
        "Snapped, but " + res.left.length + " condition" + (res.left.length > 1 ? "s are" : " is") + " still broken (see Status).");
      msg += " (" + Math.round(performance.now() - t0) + " ms)";
    }
    syncN();
    netArr = E.netOf(nArr);
    selected = selected && E.rIdx[selected] !== undefined ? selected : null;
    preview = null; lastShrink = null;
    $("#batches").value = st.batches;
    $("#batches").disabled = !batch;
    $("#batchInfo").textContent = batch ? "1 batch = " + fmt(batch) + " AI Expansion Servers/min" : st.lockP5 ? "no Phase 5 in these recipes" : "ratio unlocked";
    banner(msg || why || "");
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
    const v = E.violations(nArr, netArr, pins);
    $("#sv-valid").textContent = v.length ? v.length + " broken" : "valid";
    $("#st-valid").classList.toggle("bad", v.length > 0);
    const ai = E.iIdx.SpaceElevatorPart_12;
    if (ai !== undefined) {
      const s = E.itemStep(ai);
      $("#sv-p5").innerHTML = fmt(netArr[ai]) + " <small>AI servers/min" + (s ? ", step " + fmt(Number(s[0]) / Number(s[1])) : ", fixed") + "</small>";
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
        <td class="n ${s > Math.max(4, nArr[j] / 4) ? "big" : ""}" title="${s ? "Machine count changes in steps of " + s : "Fixed: no move changes it"}">${s ? s.toLocaleString("en-US") : "fixed"}</td>
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
    if (n2.every((x) => x >= 0) && E.badness(n2, net2, pins) <= E.badness(nArr, netArr, pins) + 1e-9) return "";
    const v = E.violations(n2, net2, pins);
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
    if (E.badness(n2, net2, pins) <= E.badness(nArr, netArr, pins) + 1e-9 && n2.every((x) => x >= 0)) return "";
    const v = E.violations(n2, net2, pins);
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
    html += `<div class="shrink"><div class="row1"><button class="btn primary" type="button" id="btnShrink" ${nArr[j] > 0 && mv.length ? "" : "disabled"}>Shrink this</button><span class="count">searches combinations of up to 3 moves</span>${nArr[j] === 0 ? ` <button class="btn danger" type="button" id="btnRemove">Remove recipe</button>` : ""}</div><div class="res" id="shrinkRes">${shrinkHtml(j)}</div></div>`;
    chains = nArr ? E.chainMoves(nArr, j, pins) : [];
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
    }).join("") : `<div class="side-empty">No move changes this recipe: the exact balances fix its machine count. Opening a valve on the Items tab or adding a recipe can free it.</div>`;
    side.innerHTML = html;
  }
  function shrinkHtml(j) {
    if (!lastShrink || lastShrink.j !== j) return "";
    const s = lastShrink.res;
    if (!s) return `<span class="why">No combination of up to 3 moves lowers it without breaking something. Try lowering a minimum, opening a valve, or adding a recipe.</span>`;
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
        const res = E.shrink(nArr, j, pins);
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
      delete st.n[selected]; delete st.base[selected];
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

  /* ---- items tab ---- */
  function renderItems() {
    const viol = new Set(E.violations(nArr, netArr, pins).filter((v) => v.i !== undefined).map((v) => v.i));
    const order = E.items.map((k, i) => i).sort((a, b) => {
      const c = { balance: 0, surplus: 1, raw: 2 };
      return c[E.cls[a]] - c[E.cls[b]] || iname(E.items[a]).localeCompare(iname(E.items[b]));
    });
    $("#ibody").innerHTML = order.map((i) => {
      const k = E.items[i], cls = E.cls[i], s = E.itemStep(i);
      const ctl = cls === "raw" ? `<span class="cls">raw: only drawn</span>` : E.fluid[i] ? `<span class="cls">fluid: must balance</span>` :
        `<select data-k="${esc(k)}" aria-label="Rule for ${esc(iname(k))}"><option value="balance" ${cls === "balance" ? "selected" : ""}>must balance</option><option value="surplus" ${cls === "surplus" ? "selected" : ""}>surplus allowed</option></select>${cls !== E.defaultCls[i] ? ' <span class="cls">(changed)</span>' : ""}`;
      const pin = st.pins[k];
      return `<tr class="${viol.has(i) ? "bad" : ""}"><td>${esc(iname(k))}</td><td>${ctl}</td><td class="n">${fmt(netArr[i])}</td>
        <td class="n">${s ? fmt(Number(s[0]) / Number(s[1])) : cls === "balance" ? "0" : "fixed"}</td>
        <td class="n">${cls === "balance" ? "" : `<input class="pin" type="text" inputmode="decimal" data-k="${esc(k)}" value="${pin !== undefined ? esc(trim(Number(pin).toFixed(4))) : ""}" placeholder="none">`}</td></tr>`;
    }).join("");
  }
  $("#ibody").addEventListener("change", (e) => {
    const sel = e.target.closest("select");
    if (sel) {
      push();
      st.valves[sel.dataset.k] = sel.value;
      rebuild(iname(sel.dataset.k) + ": " + (sel.value === "balance" ? "must balance." : "surplus allowed."));
      return;
    }
    const inp = e.target.closest("input.pin");
    if (inp) {
      push();
      const v = inp.value.trim().replace(",", ".");
      if (v === "") delete st.pins[inp.dataset.k];
      else if (isFinite(+v)) st.pins[inp.dataset.k] = +v;
      save();
      p5pins();
      lastShrink = null;
      render();
    }
  });

  /* ---- toolbar ---- */
  $("#lockP5").addEventListener("change", (e) => {
    push();
    st.lockP5 = e.target.checked;
    if (!st.lockP5) { // keep at least the current Phase 5 output as minimums
      for (const k of Object.keys(Moves.PHASE5)) { const i = E.iIdx[k]; if (i !== undefined && netArr[i] > 0) st.pins[k] = Math.floor(netArr[i] * 1e4) / 1e4; }
    }
    rebuild(st.lockP5 ? "Phase 5 held in exact proportion." : "Phase 5 ratio released; the current output is kept as minimums (Items tab).", st.lockP5);
  });
  $("#batches").addEventListener("change", (e) => {
    const k = Math.max(1, Math.round(+e.target.value || 1));
    if (k === st.batches) { e.target.value = k; return; }
    push();
    st.batches = k;
    rebuild("Sized to " + k + " Phase 5 batch" + (k > 1 ? "es" : "") + ".", true);
  });
  $("#btnSnap").addEventListener("click", () => {
    push();
    const res = E.snapSupport(target(), pins);
    nArr = res.n; syncN(); netArr = E.netOf(nArr); preview = null; lastShrink = null;
    banner(res.ok ? "Snapped; everything holds." : "Snapped, but " + res.left.length + " condition(s) still broken.");
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
    $("#lockP5").checked = st.lockP5;
    rebuild("Undone.");
  });
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    document.querySelectorAll("#tabs button").forEach((x) => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    document.querySelectorAll("main > .panel").forEach((p) => (p.hidden = p.id !== "tab-" + b.dataset.tab));
    if (b.dataset.tab === "items") renderItems();
  });

  function render() {
    renderSummary(); renderTable(); renderSide();
    if (!$("#tab-items").hidden) renderItems();
    fillAdd();
  }

  /* ---- import / export ---- */
  function loadObject(o, label) {
    let next;
    if (o && o.app === "satisfactory-machine-moves") next = Object.assign({ valves: {}, pins: {}, lockP5: true, batches: 1, base: {}, n: {} }, o.state);
    else if (o && o.sheet) {
      next = fromSheet(o.sheet);
      if (o.moves && o.moves.n100) Object.assign(next, { valves: o.moves.valves || {}, pins: o.moves.pins || {}, lockP5: o.moves.lockP5 !== false,
        batches: o.moves.batches || 1, n: Object.assign({}, o.sheet.n) });
    } else if (o && o.n) next = fromSheet(o);
    if (!next || !next.recipes.length) { banner("That file has no production recipes with machines."); return; }
    if (st) push();
    st = next;
    $("#lockP5").checked = st.lockP5;
    selected = null;
    rebuild(label || "", !Object.keys(st.n).length);
  }
  $("#fileState").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => { try { loadObject(JSON.parse(t), "Imported " + f.name + "."); } catch (err) { banner("Could not read that file as JSON."); } });
    e.target.value = "";
  });
  $("#btnDefault").addEventListener("click", () => { st && push(); st = null; loadObject({ sheet: window.MOVES_PLAN }, "Loaded the optimizer plan."); });
  function startState() {
    const S = window.MOVES_START;
    return { app: "satisfactory-machine-moves", state: { recipes: S.recipes.slice(), base: Object.assign({}, S.base),
      n: Object.assign({}, S.n || {}), startN: S.n ? Object.assign({}, S.n) : null, batches: 1, valves: Object.assign({}, S.valves || {}), pins: {}, lockP5: true } };
  }
  $("#btnStart").addEventListener("click", () => { st && push(); st = null; loadObject(startState(), "Loaded the all-recipe start."); });
  let downloads = null;
  if (window.claude && window.claude.use) {
    window.claude.use("downloads").then((d) => { downloads = d; $("#btnExport").hidden = !d; }).catch(() => {});
  }
  $("#btnExport").addEventListener("click", async () => {
    if (!downloads) return;
    const sheet = { c: {}, n: {}, f: {}, x: [] };
    E.R.forEach((r, j) => { if (nArr[j]) { sheet.n[r.id] = nArr[j]; sheet.c[r.id] = 1; } });
    const data = JSON.stringify({ app: "satisfactory-production-sheet", v: 1, sheet, settings: {},
      moves: { valves: st.valves, pins: st.pins, lockP5: st.lockP5, batches: st.batches, n100: true } }, null, 1);
    const day = new Date().toISOString().slice(0, 10);
    try { await downloads.save({ filename: `machine-moves-${day}.json`, data }); $("#ioMsg").textContent = "Exported."; }
    catch (err) { $("#ioMsg").textContent = err && err.code === "declined" ? "Export cancelled." : "Export failed."; }
  });

  /* ---- start ---- */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { saved = null; }
  if (saved && saved.recipes && saved.recipes.length && saved.base) { st = Object.assign({ valves: {}, pins: {}, lockP5: true, batches: 1 }, saved); $("#lockP5").checked = st.lockP5; rebuild(""); }
  else loadObject(startState(), "");
})();
