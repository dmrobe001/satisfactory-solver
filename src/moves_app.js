/* Machine moves page.  Expects GAME, MOVES_PLAN and SatMoves. */
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
  const pctText = (p) => trim(Number(p).toFixed(4));
  const mname = (r) => (B[r.m] ? B[r.m].n : r.m);
  const iname = (k) => (IT[k] ? IT[k].n : k);

  /* ---- state ---- */
  let st = null;          // {recipes, clocks, n, valves, pins, lockP5}
  let E = null, nArr = [], netArr = null, pins = new Map();
  let selected = null, preview = null, sortKey = "n", sortDir = -1, lastShrink = null;
  const history = [];

  function fromSheet(sheet) {
    const recipes = [], clocks = {}, n = {};
    for (const [id, v] of Object.entries((sheet && sheet.n) || {})) {
      const r = byId[id];
      if (!r || !PROD(r) || !(v > 0)) continue;
      recipes.push(id);
      const c = (sheet.c && sheet.c[id]) || 1;
      clocks[id] = pctText(c * 100);
      n[id] = Math.round(v);
    }
    return { recipes, clocks, n, valves: {}, pins: {}, lockP5: true };
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) { /* storage unavailable */ } }
  function push() { history.push(JSON.stringify(st)); if (history.length > 100) history.shift(); $("#btnUndo").disabled = false; }

  /* Build the engine for st; keep the counts if they are still exact and valid,
   * otherwise snap to the nearest valid factory at the same effective rates. */
  function rebuild(targetEff, why) {
    const t0 = performance.now();
    E = new Moves(G, { recipes: st.recipes, clocks: st.clocks, valves: st.valves, lockP5: st.lockP5 });
    st.recipes = E.R.map((r) => r.id);
    pins = new Map();
    for (const [k, v] of Object.entries(st.pins)) if (E.iIdx[k] !== undefined && isFinite(v)) pins.set(E.iIdx[k], +v);
    nArr = E.R.map((r) => st.n[r.id] || 0);
    let msg = "";
    if (!E.balanced(nArr) || !E.valid(nArr, pins)) {
      const t = E.R.map((r, j) => {
        const eff = targetEff ? targetEff[r.id] : (st.n[r.id] || 0) * E.clockPct[j] / 100;
        return (eff || 0) / (E.clockPct[j] / 100);
      });
      const res = E.snap(t, pins);
      nArr = res.n;
      msg = (why ? why + " " : "") + (res.ok ? "Snapped to the nearest valid factory." :
        "Snapped, but " + res.left.length + " condition" + (res.left.length > 1 ? "s are" : " is") + " still broken (see Status).");
      const ai = E.iIdx.SpaceElevatorPart_12;
      if (!res.ok && ai !== undefined && res.left.some((v) => v.kind === "pin" && Moves.PHASE5[E.items[v.i]])) {
        const s = E.itemStep(ai);
        if (s) msg += " At these clocks Phase 5 only comes in batches of " + fmt(Number(s[0]) / Number(s[1])) + " AI Expansion Servers per minute.";
      }
    }
    syncN();
    netArr = E.netOf(nArr);
    selected = selected && E.rIdx[selected] !== undefined ? selected : null;
    preview = null; lastShrink = null;
    if (msg) banner(msg + " (" + Math.round(performance.now() - t0) + " ms)");
    else if (why !== undefined) banner(why || "");
    render();
  }
  function syncN() { st.n = {}; E.R.forEach((r, j) => { if (nArr[j]) st.n[r.id] = nArr[j]; }); save(); }
  function effMap() { const m = {}; E.R.forEach((r, j) => (m[r.id] = nArr[j] * E.clockPct[j] / 100)); return m; }

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
        <td class="n"><input class="clk" type="text" inputmode="decimal" value="${pctText(E.clockPct[j])}" aria-label="Clock of ${esc(r.name)}, percent"></td>
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
  $("#rbody").addEventListener("change", (e) => {
    const inp = e.target.closest("input.clk");
    if (!inp) return;
    const j = +inp.closest("tr").dataset.j, r = E.R[j];
    const v = inp.value.trim().replace(",", ".");
    if (!Moves.clockFrac(v)) { inp.value = pctText(E.clockPct[j]); banner("A clock is a percentage above 0 and at most 250, with up to 4 decimals."); return; }
    push();
    const eff = effMap();
    st.clocks[r.id] = trim(Number(v).toFixed(4));
    rebuild(eff, "Clock of " + r.name + " set to " + st.clocks[r.id] + " %.");
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
  function effectsText(coefs) {
    const dn = new Float64Array(E.items.length);
    for (const [i, c] of coefs) { const m = E.moveNet[i]; for (let x = 0; x < m.length; x++) dn[x] += c * m[x]; }
    const parts = [];
    const sur = [], raw = [];
    dn.forEach((v, i) => {
      if (Math.abs(v) < 1e-9) return;
      if (E.cls[i] === "surplus") sur.push([i, v]);
      else if (E.cls[i] === "raw") raw.push([i, v]);
    });
    sur.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    if (sur.length) parts.push("surplus " + sur.slice(0, 4).map(([i, v]) => iname(E.items[i]) + " " + fmt(v, true)).join(", ") + (sur.length > 4 ? ", …" : ""));
    if (raw.length) parts.push("raw " + raw.slice(0, 3).map(([i, v]) => iname(E.items[i]) + " " + fmt(v, true)).join(", ") + (raw.length > 3 ? ", …" : ""));
    let dp = 0;
    const d = deltaOf(coefs);
    d.forEach((x, j) => (dp -= x * E.power[j]));
    if (Math.abs(dp) > 1e-9) parts.push("power " + fmt(dp, true) + " MW");
    return parts.join(" · ");
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
    let html = `<div class="side-head"><h2>${esc(r.name)}</h2><div class="meta">${esc(mname(r))} · ${nArr[j].toLocaleString("en-US")} machines at ${pctText(E.clockPct[j])} % · ${s ? "step " + s : "fixed by the exact balances"} · ${mv.length} move${mv.length === 1 ? "" : "s"}</div></div>`;
    html += `<div class="shrink"><div class="row1"><button class="btn primary" type="button" id="btnShrink" ${nArr[j] > 0 && mv.length ? "" : "disabled"}>Shrink this</button><span class="count">searches combinations of up to 3 moves</span>${nArr[j] === 0 ? ` <button class="btn danger" type="button" id="btnRemove">Remove recipe</button>` : ""}</div><div class="res" id="shrinkRes">${shrinkHtml(j)}</div></div>`;
    html += mv.length ? mv.map((i) => {
      const self = E.K[i][j];
      const plus = [[i, self > 0 ? 1 : -1]], minus = [[i, self > 0 ? -1 : 1]]; // "+" raises this recipe
      const hugeMsg = E.huge[i] ? "This move changes some recipe by more than a trillion machines" : "";
      const wp = hugeMsg || why(plus), wm = hugeMsg || why(minus);
      return `<div class="move" data-i="${i}" data-s="${self > 0 ? 1 : -1}"><div class="mh"><span class="mt">Move ${i + 1} · ${Math.abs(self)} machine${Math.abs(self) === 1 ? "" : "s"} of this</span>
        <span class="btns"><button class="btn" type="button" data-c="-1" ${wm ? `disabled title="${esc(wm)}"` : `title="Apply: ${Math.abs(self)} fewer of this"`}>−</button><button class="btn" type="button" data-c="1" ${wp ? `disabled title="${esc(wp)}"` : `title="Apply: ${Math.abs(self)} more of this"`}>+</button></span></div>
        <div class="chips">${chipsFor(deltaOf(plus), j)}</div><div class="eff">${esc(effectsText(plus))} <i>(for +; − is the reverse)</i></div>${wm && wp ? `<div class="why">Both directions blocked: ${esc(wm)}.</div>` : ""}</div>`;
    }).join("") : `<div class="side-empty">No move changes this recipe: the exact balances fix its machine count. Opening a valve on the Items tab or changing a clock can free it.</div>`;
    side.innerHTML = html;
  }
  function shrinkHtml(j) {
    if (!lastShrink || lastShrink.j !== j) return "";
    const s = lastShrink.res;
    if (!s) return `<span class="why">No combination of up to 3 moves lowers it without breaking something. Try lowering a minimum, opening a valve, or a different clock.</span>`;
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
      const eff = effMap();
      st.recipes = st.recipes.filter((id) => id !== selected);
      delete st.n[selected]; delete st.clocks[selected];
      selected = null;
      rebuild(eff, "Recipe removed.");
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
    const key = m ? m.dataset.i : null;
    if (key === hoverKey) return;
    hoverKey = key;
    if (!m) return;
    preview = deltaOf([[+m.dataset.i, +m.dataset.s]]);
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
      const eff = effMap();
      st.valves[sel.dataset.k] = sel.value;
      rebuild(eff, iname(sel.dataset.k) + ": " + (sel.value === "balance" ? "must balance." : "surplus allowed."));
      return;
    }
    const inp = e.target.closest("input.pin");
    if (inp) {
      push();
      const v = inp.value.trim().replace(",", ".");
      if (v === "") delete st.pins[inp.dataset.k];
      else if (isFinite(+v)) st.pins[inp.dataset.k] = +v;
      save();
      pins = new Map();
      for (const [k, x] of Object.entries(st.pins)) if (E.iIdx[k] !== undefined) pins.set(E.iIdx[k], +x);
      lastShrink = null;
      render();
    }
  });

  /* ---- toolbar ---- */
  $("#lockP5").addEventListener("change", (e) => { push(); const eff = effMap(); st.lockP5 = e.target.checked; rebuild(eff, st.lockP5 ? "Phase 5 held in exact proportion." : "Phase 5 ratio released."); });
  $("#btnSnap").addEventListener("click", () => {
    push();
    const t = E.R.map((r, j) => nArr[j]);
    const res = E.snap(t, pins);
    nArr = res.n; syncN(); netArr = E.netOf(nArr); preview = null; lastShrink = null;
    banner(res.ok ? "Snapped; everything holds." : "Snapped, but " + res.left.length + " condition(s) still broken.");
    render();
  });
  $("#btnClean").addEventListener("click", () => { push(); const eff = effMap(); E.R.forEach((r, j) => (st.clocks[r.id] = Moves.cleanClock(E.clockPct[j]))); rebuild(eff, "Every clock rounded to a clean value."); });
  $("#btnAll100").addEventListener("click", () => { push(); const eff = effMap(); st.recipes.forEach((id) => (st.clocks[id] = "100")); rebuild(eff, "Every clock set to 100 %."); });
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
    const eff = effMap();
    st.recipes.push(r.id); st.clocks[r.id] = "100";
    e.target.value = "";
    selected = r.id;
    rebuild(eff, r.name + " added at 0 machines.");
  });
  $("#btnUndo").addEventListener("click", () => {
    if (!history.length) return;
    st = JSON.parse(history.pop());
    $("#btnUndo").disabled = !history.length;
    $("#lockP5").checked = st.lockP5;
    rebuild(null, "Undone.");
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
    if (o && o.app === "satisfactory-machine-moves") next = Object.assign({ valves: {}, pins: {}, lockP5: true }, o.state);
    else if (o && o.sheet) {
      next = fromSheet(o.sheet);
      if (o.moves) Object.assign(next, { valves: o.moves.valves || {}, pins: o.moves.pins || {}, lockP5: o.moves.lockP5 !== false });
    } else if (o && o.n) next = fromSheet(o);
    if (!next || !next.recipes.length) { banner("That file has no production recipes with machines."); return; }
    if (st) push();
    st = next;
    $("#lockP5").checked = st.lockP5;
    selected = null;
    // default minimums, set before any snapping: keep the Phase 5 parts at the loaded rate
    if (!Object.keys(st.pins).length) {
      const probe = new Moves(G, { recipes: st.recipes, clocks: st.clocks, valves: st.valves, lockP5: false });
      const net = probe.netOf(probe.R.map((r) => st.n[r.id] || 0));
      for (const k of Object.keys(Moves.PHASE5)) { const i = probe.iIdx[k]; if (i !== undefined && net[i] > 1e-9) st.pins[k] = Math.floor(net[i] * 1e4) / 1e4; }
    }
    rebuild(null, label || "");
    if (label && !E.valid(nArr, pins)) banner(label + " Some conditions could not be met; the Status box and the Items tab show which.");
  }
  $("#fileState").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => { try { loadObject(JSON.parse(t), "Imported " + f.name + "."); } catch (err) { banner("Could not read that file as JSON."); } });
    e.target.value = "";
  });
  $("#btnDefault").addEventListener("click", () => { st && push(); st = null; loadObject({ sheet: window.MOVES_PLAN }, "Loaded the optimizer plan."); });
  let downloads = null;
  if (window.claude && window.claude.use) {
    window.claude.use("downloads").then((d) => { downloads = d; $("#btnExport").hidden = !d; }).catch(() => {});
  }
  $("#btnExport").addEventListener("click", async () => {
    if (!downloads) return;
    const sheet = { c: {}, n: {}, f: {}, x: [] };
    E.R.forEach((r, j) => { if (nArr[j]) { sheet.n[r.id] = nArr[j]; sheet.c[r.id] = E.clockPct[j] / 100; } });
    const data = JSON.stringify({ app: "satisfactory-production-sheet", v: 1, sheet, settings: {},
      moves: { valves: st.valves, pins: st.pins, lockP5: st.lockP5 } }, null, 1);
    const day = new Date().toISOString().slice(0, 10);
    try { await downloads.save({ filename: `machine-moves-${day}.json`, data }); $("#ioMsg").textContent = "Exported."; }
    catch (err) { $("#ioMsg").textContent = err && err.code === "declined" ? "Export cancelled." : "Export failed."; }
  });

  /* ---- start ---- */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { saved = null; }
  if (saved && saved.recipes && saved.recipes.length) { st = Object.assign({ valves: {}, pins: {}, lockP5: true }, saved); $("#lockP5").checked = st.lockP5; rebuild(null, ""); }
  else loadObject({ sheet: window.MOVES_PLAN }, "");
})();
