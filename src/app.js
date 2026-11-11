/* UI for the production sheet.  Expects GAME (data/game.json) and SatSolver. */
(function () {
  "use strict";
  const G = window.GAME;
  const S = new window.SatSolver(G);
  const R = G.recipes;
  const IT = G.items;
  const KEYS = S.itemKeys;
  const B = G.buildings;
  const STORE = "satisfactory-sheet.v3";

  const SB = window.SatBuildings;
  const { BELTS, PIPES, RAIL, RULE_BASES, DEFAULT_RULES, DEFAULT_EXTRA, CAL, cloneRules, DEFAULTS } = SB;
  let settings = DEFAULTS();

  const KIND_GROUP = { machine: "machine", miner: "extract", extractor: "extract", well: "extract", gather: "extract",
    burn: "power", geo: "power", augment: "power", manual: "special" };

  /* ---- helpers ---- */
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function trim(s) { return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s; }
  function fmt(x) {
    if (!isFinite(x)) return "∞";
    const a = Math.abs(x);
    if (a < 1e-4) return "0";
    if (a >= 10000) return Math.round(x).toLocaleString("en-US");
    if (a >= 100) return trim(x.toFixed(1));
    if (a >= 1) return trim(x.toFixed(2));
    return trim(x.toPrecision(3));
  }
  const iname = (k) => IT[KEYS[k]].n;
  const unit = (k) => (k === S.P ? " MW" : IT[KEYS[k]].f ? " m³" : "");
  const mname = (rec) => (rec.m === "Gathering" ? "By hand" : B[rec.m] ? B[rec.m].n : rec.m);
  const fixedClock = (rec) => rec.mc <= 1;

  /* ---- persistence ---- */
  let saveTimer = 0;
  function snapshot() { return { v: 1, sheet: S.dump(), settings }; }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(snapshot())); } catch (e) { /* storage unavailable */ }
    }, 250);
  }
  function applySnapshot(o) {
    settings = SB.normalize(o.settings);
    S.load(o.sheet || {});
    applyFicsmas();
  }

  /* FICSMAS recipes and buildings only count while the toggle is on. */
  function applyFicsmas() {
    S.setGroup("xmas", !!settings.ficsmas);
    const cb = document.getElementById("ficsmas");
    if (cb) cb.checked = !!settings.ficsmas;
  }

  // Default sheet: built by tools/import_plan.js from the user's earlier plan.
  function loadDefault() {
    settings = DEFAULTS();
    S.load(window.DEFAULT_PLAN || {});
    applyFicsmas();
  }

  /* ---- recipe rows ---- */
  const tbody = $("#rows");
  const rows = R.map((rec, r) => {
    const tr = document.createElement("div");
    tr.className = "row";
    tr.dataset.r = r;
    const manual = S.manual[r];
    if (manual) tr.classList.add("manual");
    let clockCell;
    if (manual) clockCell = `<span class="fixed">fixed 100%</span>`;
    else if (fixedClock(rec)) clockCell = `<label class="fixed"><input type="checkbox" class="clk" id="clk-${r}"> on</label>`;
    else clockCell = `<input class="cell-in clk" type="number" id="clk-${r}" min="0" max="${rec.mc * 100}" step="0.0001" aria-label="Clock %">`;
    const floorCell = S.hasFloor(r)
      ? `<input class="cell-in flr" type="number" id="flr-${r}" step="any" aria-label="Adjustment per minute">`
      : `<span class="fixed">—</span>`;
    const field = (label, inner, cls = "") => `<div class="fld ${cls}"><span class="fl">${label}</span>${inner}</div>`;
    tr.innerHTML =
      `<div class="band b-mid">` +
        `<div class="rhead"><div class="rline"><span class="rn">${esc(rec.name)}${rec.alt ? '<span class="alt">alt</span>' : ""}${rec.xmas ? '<span class="alt">FICSMAS</span>' : ""}</span>` +
          (manual ? "" : `<label class="flx-l" title="When several running recipes make the same item, the one flexible recipe among them is re-sized to balance it"><input type="checkbox" class="flx" id="flx-${r}"> flexible</label>`) + `</div>` +
        `<span class="rm">${esc(mname(rec))} · layer ${rec.layer}</span></div>` +
        `<div class="fields">` +
          field("Clock %", clockCell) +
          field("Machines", `<input class="cell-in cnt" type="number" id="cnt-${r}" min="0" step="1" aria-label="Machines">`) +
          (S.hasFloor(r) ? field("Adjustment /min", floorCell) : "") +
          (rec.outs.length ? field("Surplus machines", `<span class="need c-sur" title="Machines of this recipe beyond what ${esc(IT[rec.outs[0][0]].n)} needs: consumers plus build need plus adjustment, with the other producers as they are"></span>`) : "") +
          field("Build need", `<span class="need c-need"></span>`) +
        `</div>` +
      `</div>` +
      `<div class="band b-in"><span class="fl">Inputs <i>per machine · total</i></span><div class="flow"></div></div>` +
      `<div class="band b-out"><div class="outs"><span class="fl">Outputs <i>per machine · total</i></span><div class="flow"></div></div>` +
        `<div class="fields pwr">` +
          field("MW @100%", `<span class="pw c-p100"></span>`) + field("MW @clock", `<span class="pw c-pclk"></span>`) + field("MW total", `<span class="pw c-ptot"></span>`) +
        `</div>` +
      `</div>`;
    if (rec.xmas) tr.classList.add("xmas");
    const search = (rec.name + " " + mname(rec) + " " + rec.ins.concat(rec.outs).map(([k]) => IT[k].n).join(" ")).toLowerCase();
    return {
      tr, rec, search,
      inFlow: $(".b-in .flow", tr), outFlow: $(".b-out .flow", tr),
      clk: $(".clk", tr), flr: $(".flr", tr), cnt: $(".cnt", tr), flx: $(".flx", tr),
      need: $(".c-need", tr), sur: $(".c-sur", tr), p100: $(".c-p100", tr), pclk: $(".c-pclk", tr), ptot: $(".c-ptot", tr),
      flags: { in: false, mid: false, out: false },
    };
  });
  { const frag = document.createDocumentFragment(); rows.forEach((row) => frag.appendChild(row.tr)); tbody.appendChild(frag); }

  tbody.addEventListener("input", (e) => {
    const t = e.target;
    const tr = t.closest(".row");
    if (!tr) return;
    const r = +tr.dataset.r;
    if (t.classList.contains("clk")) {
      if (t.type === "checkbox") S.setClock(r, t.checked ? 1 : 0);
      else { if (t.value === "" || isNaN(+t.value)) return; S.setClock(r, Math.round(+t.value * 1e4) / 1e6); } // percent, kept to 4 decimals
    } else if (t.classList.contains("flr")) {
      if (t.value !== "" && isNaN(+t.value)) return;
      S.setFloor(r, +t.value || 0);
    } else if (t.classList.contains("flx")) {
      S.setFlex(r, t.checked);
    } else if (t.classList.contains("cnt")) {
      if (t.value === "" || isNaN(+t.value)) return;
      S.setCount(r, +t.value);
    } else return;
    hideBanner();
    save();
    refresh();
  });
  tbody.addEventListener("change", (e) => {
    // normalise what is shown once the user leaves a field (e.g. clamped clocks)
    if (e.target.classList.contains("cell-in")) { e.target.dataset.dirty = ""; refresh(); }
  });

  /* ---- which fields each recipe shows ---- */
  const VIEW = ["mach", "in", "out", "power"];
  let view = { mach: true, in: true, out: true, power: true };
  try { view = Object.assign(view, JSON.parse(localStorage.getItem(STORE + ".view") || "{}")); } catch (e) { /* ignore */ }
  function applyView() {
    VIEW.forEach((k) => {
      $("#sheet").classList.toggle("hide-" + k, !view[k]);
      const cb = $("#view-" + k); if (cb) cb.checked = view[k];
    });
  }
  $("#viewSet").addEventListener("change", (e) => {
    const k = e.target.dataset.v; if (!k) return;
    view[k] = e.target.checked;
    try { localStorage.setItem(STORE + ".view", JSON.stringify(view)); } catch (err) { /* ignore */ }
    applyView();
  });
  applyView();

  /* ---- derived numbers ---- */
  let derived = null;
  function derive() {
    const b = SB.compute(S, G, settings);
    const deficit = new Uint8Array(KEYS.length);
    const target = new Float64Array(KEYS.length);
    for (let k = 0; k < KEYS.length; k++) { deficit[k] = S.inDeficit(k) ? 1 : 0; target[k] = S.target(k); }
    derived = Object.assign(b, { deficit, target });
    return derived;
  }

  function flowHTML(list, r, active, isOut) {
    const c = S.c[r], n = S.n[r];
    const cc = c > 0 ? c : 1;
    let h = "";
    for (const [k, v] of list) {
      const per = v * cc;
      const def = derived.deficit[k] ? " def" : "";
      h += `<span class="it${def}">${esc(iname(k))}</span><span class="rt">${fmt(per)}${unit(k)}` +
        (active && n > 0 ? ` <i>· ${fmt(per * n)}</i>` : "") + `</span>`;
    }
    const rec = R[r];
    if (isOut && rec.boost) h += `<span class="it">Grid boost</span><span class="rt">+${rec.boost * 100}%</span>`;
    return h || `<span class="it fixed">—</span><span></span>`;
  }

  /* ---- refresh ---- */
  // Only touch the DOM when a value actually changes: rewriting hundreds of
  // unchanged cells makes the browser restyle and re-lay-out every row.
  function setHTML(el, h) { if (el._h !== h) { el._h = h; el.innerHTML = h; } }
  function setText(el, t) { if (el._t !== t) { el._t = t; el.textContent = t; } }
  function setVal(input, v) {
    if (!input) return;
    if (document.activeElement === input) return;
    input.value = v;
  }

  /* Build need depends on machine counts (through the buildings) and machine
   * counts on build need, so settle the two before drawing. */
  window.__sheet = { S, get derived() { return derived; }, get settings() { return settings; } }; // for debugging from the console
  function settle() {
    derive();
    for (let i = 0; i < 20; i++) { if (!S.setNeed(derived.need)) break; derive(); }
  }
  function refresh() {
    settle();
    const pw = S.power();
    rows.forEach((row, r) => {
      const rec = row.rec;
      const active = S.isActive(r);
      const c = S.c[r];
      row.tr.classList.toggle("on", active);
      row.tr.classList.toggle("idle", !active);
      if (row.clk) {
        if (row.clk.type === "checkbox") row.clk.checked = c > 0;
        else setVal(row.clk, c > 0 ? trim((c * 100).toFixed(4)) : "0");
      }
      if (row.flx && row.flx.checked !== !!S.x[r]) row.flx.checked = !!S.x[r];
      if (row.flr) setVal(row.flr, S.f[r] ? trim(S.f[r].toFixed(4)) : "0");
      // flags
      let fin = false, fout = false, fmid = false;
      if (active) {
        for (const [k] of S.ins[r]) if (derived.deficit[k]) fin = true;
        for (const [k] of S.outs[r]) if (derived.deficit[k]) fout = true;
      }
      let needH = "";
      for (const [k] of S.outs[r]) {
        const nd = derived.need[k];
        if (nd > 1e-9) {
          needH += `<div>${fmt(nd)}${unit(k)}${S.outs[r].length > 1 ? ` <span class="fixed">${esc(iname(k))}</span>` : ""}</div>`;
          if (derived.deficit[k]) fmid = true;
        }
      }
      setHTML(row.need, needH);
      if (row.sur) {
        const k0 = S.outs[r][0][0];
        const sm = S.surplusMachines(r);
        setText(row.sur, isNaN(sm) ? "—" : (sm > 0 ? "+" : "") + fmt(sm));
      }
      row.tr.classList.toggle("w-in", fin);
      row.tr.classList.toggle("w-out", fout);
      row.tr.classList.toggle("w-mid", fmid);
      row.flags = { in: fin, mid: fmid, out: fout };
      // count
      setVal(row.cnt, String(S.n[r] || 0));
      // flows
      setHTML(row.inFlow, flowHTML(S.ins[r], r, active, false));
      setHTML(row.outFlow, flowHTML(S.outs[r], r, active, true));
      // power
      const p1 = S.machinePower(r, 1), pc = S.machinePower(r, c > 0 ? c : 0), pt = active ? pc * S.n[r] : 0;
      const pcell = (el, v) => { setText(el, rec.p === 0 ? "—" : fmt(v)); el.classList.toggle("gen", v < 0); };
      pcell(row.p100, p1); pcell(row.pclk, pc); pcell(row.ptot, pt);
    });
    renderSummary(pw);
    applyFilter();
    renderActiveTab();
  }

  // Summary tiles are built once; refreshes only change their text and state.
  const sumEl = $("#summary");
  sumEl.innerHTML =
    `<div class="stat" id="st-pw"><span class="lbl">Power supply / demand</span><span class="val"><span id="sv-pw"></span> <small>MW</small></span></div>` +
    `<div class="stat" id="st-net"><span class="lbl">Net power</span><span class="val"><span id="sv-net"></span> <small id="sv-boost"></small></span></div>` +
    `<div class="stat"><span class="lbl">Production buildings</span><span class="val" id="sv-mach"></span></div>` +
    `<div class="stat"><span class="lbl">Lanes solid / fluid</span><span class="val" id="sv-lanes"></span></div>` +
    `<div class="stat" id="st-def"><span class="lbl">Items in deficit</span><span class="val" id="sv-def"></span></div>` +
    `<div class="stat"><span class="lbl"><label for="sum-ts">Build time (min)</label></span><span class="val"><input type="number" id="sum-ts" min="0.01" step="any"></span></div>` +
    `<div class="stat warn" id="st-loop" hidden><span class="lbl">Feedback loop</span><span class="val"><small>update stopped after 20 000 steps</small></span></div>`;
  const SV = {};
  ["st-pw", "sv-pw", "st-net", "sv-net", "sv-boost", "sv-mach", "sv-lanes", "st-def", "sv-def", "sum-ts", "st-loop"].forEach((id) => (SV[id] = document.getElementById(id)));
  function renderSummary(pw) {
    const def = derived.deficit.reduce((a, b) => a + b, 0);
    SV["st-pw"].classList.toggle("bad", pw.deficit);
    SV["st-net"].classList.toggle("bad", pw.deficit);
    setText(SV["sv-pw"], `${fmt(pw.supply)} / ${fmt(pw.demand)}`);
    setText(SV["sv-net"], fmt(pw.net));
    setText(SV["sv-boost"], `MW${pw.boost ? ` · boost +${fmt(pw.boost * 100)}%` : ""}`);
    setText(SV["sv-mach"], derived.machines.toLocaleString("en-US"));
    setText(SV["sv-lanes"], `${derived.solid} / ${derived.fluid}`);
    SV["st-def"].classList.toggle("bad", def > 0);
    setText(SV["sv-def"], String(def));
    setVal(SV["sum-ts"], String(settings.timescale));
    if (SV["st-loop"].hidden === S.converged) SV["st-loop"].hidden = S.converged;
  }
  sumEl.addEventListener("change", (e) => {
    if (e.target.id === "sum-ts") { settings.timescale = +e.target.value || 60; save(); refresh(); }
  });

  /* ---- sorting & filtering ---- */
  let sortKey = "layer", sortDir = 1;
  const outName = (rec) => (rec.outs.length ? IT[rec.outs[0][0]].n : "￿");
  const cmp = {
    name: (a, b) => a.rec.name.localeCompare(b.rec.name),
    output: (a, b) => outName(a.rec).localeCompare(outName(b.rec)) || cmp.name(a, b),
    machine: (a, b) => mname(a.rec).localeCompare(mname(b.rec)) || cmp.name(a, b),
    layer: (a, b) => a.rec.layer - b.rec.layer || cmp.output(a, b),
  };
  function applySort() {
    const sorted = rows.slice().sort((a, b) => sortDir * cmp[sortKey](a, b));
    const frag = document.createDocumentFragment();
    sorted.forEach((x) => frag.appendChild(x.tr));
    tbody.appendChild(frag);
    document.querySelectorAll("#sortSeg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sort === sortKey ? "true" : "false"));
    $("#sortDir").textContent = sortDir > 0 ? "▲" : "▼";
  }
  function setSort(k) {
    if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
    try { localStorage.setItem(STORE + ".sort", JSON.stringify([sortKey, sortDir])); } catch (e) { /* ignore */ }
    applySort();
  }
  $("#sortSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSort(b.dataset.sort); });
  $("#sortDir").addEventListener("click", () => setSort(sortKey));

  function applyFilter() {
    const q = $("#q").value.trim().toLowerCase();
    const show = $("#show").value, kind = $("#kind").value;
    let n = 0;
    rows.forEach((row, r) => {
      let vis = true;
      if (q && !q.split(/\s+/).every((w) => row.search.includes(w))) vis = false;
      if (vis && kind !== "all" && KIND_GROUP[row.rec.kind] !== kind) vis = false;
      if (vis && show === "active" && !S.isActive(r)) vis = false;
      if (vis && show === "flag" && !(row.flags.in || row.flags.mid || row.flags.out)) vis = false;
      if (vis && row.rec.xmas && !settings.ficsmas) vis = false;
      if (row.tr.hidden === vis) row.tr.hidden = !vis;
      if (vis) n++;
    });
    const total = settings.ficsmas ? rows.length : rows.filter((x) => !x.rec.xmas).length;
    setText($("#rowCount"), `${n} of ${total} recipes`);
  }
  ["#q", "#show", "#kind"].forEach((s) => $(s).addEventListener("input", applyFilter));
  $("#ficsmas").addEventListener("change", (e) => {
    settings.ficsmas = e.target.checked;
    applyFicsmas(); hideBanner(); save(); refresh();
  });

  /* ---- tabs ---- */
  let tab = "recipes";
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) showTab(b.dataset.tab);
  });
  function showTab(t) {
    tab = t;
    document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t ? "true" : "false"));
    document.querySelectorAll("main > section").forEach((s) => (s.hidden = s.id !== "tab-" + t));
    renderActiveTab();
  }
  function renderActiveTab() {
    if (tab === "balance") renderBalance();
    else if (tab === "buildings") renderBuildings();
    else if (tab === "materials") renderMaterials();
    else if (tab === "settings") renderSettings();
  }


  // The three tables below are built once at load, one row per item or
  // building.  Rendering only shows/hides rows and updates changed numbers,
  // so switching tabs or typing never rebuilds them.
  function hide(el, h) { if (el.hidden !== h) el.hidden = h; }
  function pill(k) {
    if (derived.deficit[k] && derived.need[k] > 1e-9 && S.net(k) >= S.adjust(k) - S.tol(k)) return ["warn", "build need short"];
    if (derived.deficit[k]) return ["bad", "deficit"];
    if (S.net(k) > S.tol(k) + derived.target[k]) return ["", "surplus"];
    return ["ok", "balanced"];
  }
  function setPill(el, k) {
    const [cls, txt] = pill(k);
    if (el._c !== cls) { el._c = cls; el.className = "pill " + cls; }
    setText(el, txt);
  }
  function findItem(k) {
    $("#q").value = iname(k);
    $("#show").value = "all"; $("#kind").value = "all";
    showTab("recipes"); applyFilter();
  }
  const itemOrder = KEYS.map((_, k) => k).sort((a, b) => iname(a).localeCompare(iname(b)));
  function buildRows(tbodySel, keys, cells) {
    const tb = $(tbodySel);
    tb.innerHTML = keys.map((k) => `<tr data-k="${k}" hidden>${cells(k)}</tr>`).join("") +
      `<tr class="empty" hidden><td colspan="9" class="note"></td></tr>`;
    const out = {};
    tb.querySelectorAll("tr[data-k]").forEach((tr) => {
      out[tr.dataset.k] = { tr, td: tr.querySelectorAll("td"), pill: tr.querySelector(".pill"), input: tr.querySelector("input") };
    });
    return { tb, rows: out, empty: tb.querySelector("tr.empty") };
  }
  const itemLink = (k) => `<td><button class="linkish" type="button" data-k="${k}">${esc(iname(k))}</button></td>`;

  const balT = buildRows("#balance tbody", itemOrder,
    (k) => itemLink(k) + `<td class="n"></td><td class="n"></td><td class="n"></td><td class="n"></td><td class="n"></td><td><span class="pill"></span></td>`);
  setText(balT.empty.firstChild, "Nothing is running yet. Set a clock above 0% on a recipe to start.");
  let balDefFirst = "";
  function renderBalance() {
    let n = 0;
    const order = [];
    for (const k of itemOrder) {
      const x = balT.rows[k];
      const show = S.prod[k] > 1e-9 || S.cons[k] > 1e-9 || Math.abs(derived.target[k]) > 1e-9;
      hide(x.tr, !show);
      if (!show) continue;
      n++;
      if (derived.deficit[k]) order.push(k);
      const td = x.td;
      setText(td[1], fmt(S.prod[k] * S.mult(k)) + unit(k));
      setText(td[2], fmt(S.cons[k]) + unit(k));
      setText(td[3], fmt(S.net(k)) + unit(k));
      setText(td[4], S.adjust(k) ? fmt(S.adjust(k)) : "");
      setText(td[5], derived.need[k] > 1e-9 ? fmt(derived.need[k]) : "");
      setPill(x.pill, k);
    }
    // Deficits go to the top; rows only move when that set changes.
    const sig = order.join(",");
    if (sig !== balDefFirst) {
      balDefFirst = sig;
      const frag = document.createDocumentFragment();
      const first = new Set(order);
      order.forEach((k) => frag.appendChild(balT.rows[k].tr));
      itemOrder.forEach((k) => { if (!first.has(k)) frag.appendChild(balT.rows[k].tr); });
      frag.appendChild(balT.empty);
      balT.tb.appendChild(frag);
    }
    hide(balT.empty, n > 0);
  }
  $("#balance").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) findItem(+b.dataset.k); });

  const bKeys = Object.keys(B).sort((a, b) => B[a].n.localeCompare(B[b].n));
  const bldT = buildRows("#buildings tbody", bKeys, (k) => {
    const cost = B[k].cost.map(([it, q2]) => `${fmt(q2)} ${esc(IT[it].n)}`).join(", ");
    return `<td>${esc(B[k].n)}</td><td class="n"></td>` +
      `<td class="n"><input class="cell-in" type="number" min="0" step="1" id="ex-${esc(k)}" data-b="${esc(k)}" aria-label="Extra ${esc(B[k].n)}"></td>` +
      `<td class="n"><b></b></td><td class="note">${cost}</td>`;
  });
  bKeys.forEach((k) => { const x = bldT.rows[k]; x.total = x.td[3].firstChild; x.lname = B[k].n.toLowerCase(); });
  setText(bldT.empty.firstChild, "No buildings yet. Switch Show to “All buildings” to add some by hand.");
  function renderBuildings() {
    const q = $("#bq").value.trim().toLowerCase();
    const all = $("#bshow").value === "all";
    let n = 0;
    for (const k of bKeys) {
      const x = bldT.rows[k];
      const show = (settings.ficsmas || !B[k].xmas) && (all || derived.total[k] || +settings.extra[k]) && (!q || x.lname.includes(q));
      hide(x.tr, !show);
      if (!show) continue;
      n++;
      setText(x.td[1], fmt(derived.comp[k] || 0));
      setVal(x.input, settings.extra[k] ? String(settings.extra[k]) : "");
      setText(x.total, fmt(derived.total[k] || 0));
    }
    hide(bldT.empty, n > 0);
  }
  $("#buildings").addEventListener("input", (e) => {
    const k = e.target.dataset.b; if (!k) return;
    const v = +e.target.value;
    if (v > 0) settings.extra[k] = v; else delete settings.extra[k];
    save(); refresh();
  });
  ["#bq", "#bshow"].forEach((sel) => $(sel).addEventListener("input", renderBuildings));

  const matT = buildRows("#materials tbody", itemOrder,
    (k) => itemLink(k) + `<td class="n"></td><td class="n"></td><td class="n"></td><td class="n"></td><td><span class="pill"></span></td>`);
  setText(matT.empty.firstChild, "No buildings yet, so nothing to build.");
  function renderMaterials() {
    setText($("#bomNote"), `Total build cost of every building on the Buildings tab, divided by the build time of ${fmt(derived.ts)} min.`);
    let n = 0;
    for (const k of itemOrder) {
      const x = matT.rows[k];
      const show = derived.bom[k] > 1e-9;
      hide(x.tr, !show);
      if (!show) continue;
      n++;
      setText(x.td[1], fmt(derived.bom[k]));
      setText(x.td[2], fmt(derived.need[k]));
      setText(x.td[3], fmt(S.net(k)));
      setText(x.td[4], S.adjust(k) ? fmt(S.adjust(k)) : "");
      setPill(x.pill, k);
    }
    hide(matT.empty, n > 0);
  }
  $("#materials").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) findItem(+b.dataset.k); });

  function kvInputs(el, keys, obj, group) {
    if (!el.dataset.built) {
      el.innerHTML = keys.map((k) => `<label for="set-${group}-${k}">${esc(B[k] ? B[k].n : k)}</label>` +
        `<input class="cell-in" type="number" min="0" step="any" id="set-${group}-${k}" data-g="${group}" data-k="${k}">`).join("");
      el.dataset.built = "1";
    }
    keys.forEach((k) => setVal(document.getElementById(`set-${group}-${k}`), obj[k]));
  }
  function renderRules() {
    const el = $("#ruleSet");
    if (!el.dataset.built) {
      el.innerHTML = RULE_BASES.map(([b, label, note]) => `<h3>${esc(label)} <span class="count" id="rb-${b}"></span></h3>` +
        `<div class="kv">` + Object.keys(DEFAULT_RULES[b]).filter((k) => B[k]).map((k) =>
          `<label for="set-r-${b}-${k}">${esc(B[k].n)}</label>` +
          `<input class="cell-in" type="number" min="0" step="any" id="set-r-${b}-${k}" data-basis="${b}" data-k="${k}">`).join("") +
        `</div><p class="note">${esc(note)}</p>`).join("");
      el.dataset.built = "1";
    }
    RULE_BASES.forEach(([b]) => {
      setText(document.getElementById("rb-" + b), derived ? "basis " + fmt(derived.basis[b] || 0) : "");
      Object.keys(DEFAULT_RULES[b]).forEach((k) => { const i = document.getElementById(`set-r-${b}-${k}`); if (i) setVal(i, settings.rules[b][k] || 0); });
    });
  }
  function renderSettings() {
    setVal($("#io"), JSON.stringify(snapshot()));
    setVal($("#set-timescale"), settings.timescale);
    kvInputs($("#laneSet"), BELTS.concat(PIPES, [RAIL]), settings.lane, "lane");
    renderRules();
  }
  $("#tab-settings").addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "set-timescale") { if (+t.value > 0) settings.timescale = +t.value; }
    else if (t.dataset.basis) settings.rules[t.dataset.basis][t.dataset.k] = Math.max(0, +t.value || 0);
    else if (t.dataset.g) settings[t.dataset.g][t.dataset.k] = Math.max(0, +t.value || 0);
    else return;
    save(); refresh();
  });
  $("#ioCopy").addEventListener("click", () => {
    const ta = $("#io");
    const done = (m) => ($("#ioMsg").textContent = m);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(() => done("Copied."), () => { ta.select(); done("Selected; press Ctrl+C to copy."); });
    } else { ta.select(); done("Selected; press Ctrl+C to copy."); }
  });
  $("#ioLoad").addEventListener("click", () => {
    try {
      const o = JSON.parse($("#io").value);
      applySnapshot(o); save(); refresh(); $("#ioMsg").textContent = "Sheet loaded.";
    } catch (e) { $("#ioMsg").textContent = "That text is not a saved sheet. Paste the whole block copied from this page."; }
  });
  $("#ioExample").addEventListener("click", () => { loadDefault(); save(); refresh(); $("#ioMsg").textContent = "Default plan loaded."; });
  let clearArmed = false;
  $("#ioClear").addEventListener("click", (e) => {
    if (!clearArmed) { clearArmed = true; e.target.textContent = "Click again to clear"; setTimeout(() => { clearArmed = false; e.target.textContent = "Clear sheet"; }, 3000); return; }
    clearArmed = false; e.target.textContent = "Clear sheet";
    S.reset(); settings = DEFAULTS(); applyFicsmas(); save(); refresh(); $("#ioMsg").textContent = "Sheet cleared.";
  });

  /* ---- import / export (a .json file) ---- */
  const ioTop = (m) => setText($("#ioTopMsg"), m);
  let downloads = null;
  if (window.claude && window.claude.use) {
    window.claude.use("downloads").then((d) => { downloads = d; $("#btnExport").hidden = !d; }).catch(() => {});
  }
  $("#btnExport").addEventListener("click", async () => {
    if (!downloads) return;
    const day = new Date().toISOString().slice(0, 10);
    const data = JSON.stringify(Object.assign({ app: "satisfactory-production-sheet" }, snapshot()), null, 1);
    try {
      await downloads.save({ filename: `satisfactory-sheet-${day}.json`, data });
      ioTop("Exported.");
    } catch (e) {
      const code = e && e.code;
      ioTop(code === "declined" ? "Export cancelled." : code === "rate_limited" ? "A save prompt is already open."
        : "Export isn't available here. Copy the text under Settings & notes instead.");
      if (code !== "declined" && code !== "rate_limited") $("#btnExport").hidden = true;
    }
  });
  $("#fileImport").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    f.text().then((txt) => {
      let o;
      try { o = JSON.parse(txt); } catch (err) { ioTop(`${f.name} is not a JSON file.`); return; }
      if (!o || !o.sheet) { ioTop(`${f.name} is not a sheet exported from this page.`); return; }
      applySnapshot(o); hideBanner(); save(); refresh();
      ioTop(`Imported ${f.name}.`);
    }, () => ioTop(`Could not read ${f.name}.`));
  });

  function hideBanner() { $("#exampleBanner").hidden = true; }
  $("#bannerClear").addEventListener("click", () => { S.reset(); settings = DEFAULTS(); applyFicsmas(); hideBanner(); save(); refresh(); });

  /* ---- boot ---- */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { saved = null; }
  try { const s = JSON.parse(localStorage.getItem(STORE + ".sort") || "null"); if (s) { sortKey = s[0]; sortDir = s[1]; } } catch (e) { /* ignore */ }
  if (saved && saved.sheet) applySnapshot(saved);
  else { loadDefault(); $("#exampleBanner").hidden = false; }
  applySort();
  refresh();
})();
