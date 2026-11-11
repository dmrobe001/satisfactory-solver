/* Recipe matrix page.  Expects GAME, DEFAULT_PLAN, SatSolver and SatBuildings. */
(function () {
  "use strict";
  const G = window.GAME;
  const SB = window.SatBuildings;
  const S = new window.SatSolver(G);
  // machine counts are whole numbers, as on the production sheet; nothing is resized here
  const R = G.recipes, IT = G.items, B = G.buildings, KEYS = S.itemKeys, P = S.P;
  const STORE = "satisfactory-matrix.v1";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function trim(s) { return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s; }
  function fmt(x) {
    if (!isFinite(x)) return "∞";
    const a = Math.abs(x);
    if (a < 1e-6) return "0";
    const sgn = x < 0 ? "−" : x > 0 ? "+" : "";
    let t;
    if (a >= 10000) t = Math.round(a).toLocaleString("en-US");
    else if (a >= 100) t = trim(a.toFixed(1));
    else if (a >= 1) t = trim(a.toFixed(2));
    else t = trim(a.toPrecision(3));
    return sgn + t;
  }
  const iname = (k) => IT[KEYS[k]].n;
  const unit = (k) => (k === P ? "MW" : IT[KEYS[k]].f ? "m³/min" : "/min");
  const mname = (rec) => (rec.m === "Gathering" ? "By hand" : B[rec.m] ? B[rec.m].n : rec.m);

  /* net base rate (one machine, 100 %) of every product per recipe; power as MW produced */
  const base = R.map((rec, r) => {
    const m = new Map();
    for (const [k, v] of S.ins[r]) m.set(k, (m.get(k) || 0) - v);
    for (const [k, v] of S.outs[r]) m.set(k, (m.get(k) || 0) + v);
    if (rec.p) m.set(P, (m.get(P) || 0) - rec.p);
    for (const [k, v] of m) if (Math.abs(v) < 1e-12) m.delete(k);
    return m;
  });
  function actual(r, k) {
    if (S.off[r] || !(S.c[r] > 0) || !(S.n[r] > 0)) return 0;
    if (k === P) return -S.machinePower(r, S.c[r]) * S.n[r];
    return base[r].get(k) * S.c[r] * S.n[r];
  }

  /* ---- state ---- */
  let settings = SB.DEFAULTS();
  let sel = new Set();        // item keys (strings)
  let hidden = new Set();     // recipe ids
  let showHidden = false;
  function snapshotSheet() { return S.dump(); }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ v: 1, sheet: snapshotSheet(), settings, sel: [...sel], hidden: [...hidden], showHidden }));
    } catch (e) { /* storage unavailable */ }
  }
  function loadSheet(sheet, st) {
    settings = SB.normalize(st || {});
    S.load({ c: (sheet || {}).c || {}, n: (sheet || {}).n || {} });
    S.setGroup("xmas", !!settings.ficsmas);
  }

  /* ---- product picker ---- */
  const allItems = KEYS.map((k, i) => i).sort((a, b) => iname(a).localeCompare(iname(b)));
  const pq = $("#pq"), plist = $("#plist");
  let cursor = 0, listShown = [];
  const visibleItem = (i) => settings.ficsmas || !IT[KEYS[i]].xmas;
  function renderList() {
    const q = pq.value.trim().toLowerCase();
    listShown = allItems.filter((i) => visibleItem(i) && (!q || iname(i).toLowerCase().includes(q))).slice(0, 200);
    if (cursor >= listShown.length) cursor = 0;
    plist.innerHTML = listShown.length ? listShown.map((i, j) =>
      `<label class="${j === cursor ? "cur" : ""}" data-i="${i}"><input type="checkbox" ${sel.has(KEYS[i]) ? "checked" : ""}> ${esc(iname(i))}<span class="k">${IT[KEYS[i]].f ? "fluid" : i === P ? "power" : ""}</span></label>`).join("")
      : `<div class="none">No product matches.</div>`;
  }
  function openList() { renderList(); plist.hidden = false; }
  function closeList() { plist.hidden = true; }
  pq.addEventListener("focus", openList);
  pq.addEventListener("input", () => { cursor = 0; openList(); });
  pq.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { cursor = Math.min(listShown.length - 1, cursor + 1); renderList(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { cursor = Math.max(0, cursor - 1); renderList(); e.preventDefault(); }
    else if (e.key === "Enter") { const i = listShown[cursor]; if (i !== undefined) toggle(KEYS[i]); e.preventDefault(); }
    else if (e.key === "Escape") { closeList(); pq.blur(); }
  });
  plist.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
  plist.addEventListener("click", (e) => {
    const l = e.target.closest("label[data-i]"); if (!l) return;
    e.preventDefault();
    toggle(KEYS[+l.dataset.i]);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".pick")) closeList(); });
  function toggle(key) { if (sel.has(key)) sel.delete(key); else sel.add(key); renderList(); changed(); }
  function renderChips() {
    $("#chips").innerHTML = [...sel].filter((k) => k in IT).sort((a, b) => IT[a].n.localeCompare(IT[b].n))
      .map((k) => `<span class="chip">${esc(IT[k].n)}<button type="button" data-k="${esc(k)}" aria-label="Remove ${esc(IT[k].n)}">×</button></span>`).join("");
  }
  $("#chips").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) { sel.delete(b.dataset.k); renderList(); changed(); } });
  $("#btnAll").addEventListener("click", () => { allItems.forEach((i) => { if (visibleItem(i)) sel.add(KEYS[i]); }); changed(); });
  $("#btnNone").addEventListener("click", () => { sel.clear(); changed(); });
  $("#btnRunning").addEventListener("click", () => {
    sel.clear();
    R.forEach((rec, r) => { if (!S.off[r] && S.c[r] > 0 && S.n[r] > 0) for (const k of base[r].keys()) sel.add(KEYS[k]); });
    changed();
  });

  /* ---- the table: rebuilt when the selection, hidden set or FICSMAS changes ---- */
  const table = $("#matrix");
  let shownRows = [], shownCols = [], cellOf = null, footA = [], footB = [];
  const order = R.map((_, r) => r).sort((a, b) => R[a].layer - R[b].layer || R[a].name.localeCompare(R[b].name));
  function build() {
    const selIdx = new Set([...sel].map((k) => S.itemIdx[k]).filter((x) => x !== undefined));
    shownRows = order.filter((r) => {
      if (S.off[r] && !settings.ficsmas) return false;
      if (hidden.has(R[r].id) && !showHidden) return false;
      for (const k of base[r].keys()) if (selIdx.has(k)) return true;
      return false;
    });
    const colSet = new Set();
    for (const r of shownRows) for (const k of base[r].keys()) colSet.add(k);
    shownCols = [...colSet].sort((a, b) => (selIdx.has(b) - selIdx.has(a)) || (a === P) - (b === P) || iname(a).localeCompare(iname(b)));
    table.classList.toggle("showhid", showHidden);
    if (!shownRows.length) {
      table.innerHTML = `<tbody><tr><td class="empty-msg">${sel.size ? "No recipe makes or uses the selected products." : "Pick one or more products above (or “Products in use”) to see the recipes that make or use them."}</td></tr></tbody>`;
      cellOf = null;
      setStatus();
      return;
    }
    let h = "<thead><tr><th class=\"rc\">Recipe</th><th>Clock %</th><th>Count</th><th class=\"colhide\">Hide</th>";
    for (const k of shownCols) h += `<th class="${selIdx.has(k) ? "sel" : ""}">${esc(iname(k))}<span class="u">${unit(k)}</span></th>`;
    h += "</tr></thead><tbody>";
    for (const r of shownRows) {
      const rec = R[r];
      const fixed = rec.mc <= 1;
      h += `<tr data-r="${r}"><th class="rc"><span class="rn">${esc(rec.name)}</span><span class="rm">${esc(mname(rec))} · layer ${rec.layer}</span></th>` +
        `<td class="e">${S.manual[r] ? '<span class="rm">fixed 100%</span>' : fixed
          ? `<input type="checkbox" class="clk" aria-label="On">`
          : `<input class="cell-in num clk" type="number" min="0" max="${rec.mc * 100}" step="any" aria-label="Clock %">`}</td>` +
        `<td class="e"><input class="cell-in num cnt" type="number" min="0" step="1" aria-label="Count"></td>` +
        `<td class="e colhide"><input type="checkbox" class="hid" aria-label="Hide"></td>`;
      for (const k of shownCols) h += base[r].has(k) ? `<td class="v" data-k="${k}"><span class="b"></span> / <span class="a"></span></td>` : "<td></td>";
      h += "</tr>";
    }
    h += "</tbody><tfoot><tr class=\"f1\"><th class=\"rc\" title=\"Bill of materials of every building the sheet needs, divided by the rebuild time\">Rebuild /min</th><td></td><td></td><td class=\"colhide\"></td>";
    for (const k of shownCols) h += `<td class="v" data-k="${k}"></td>`;
    h += "</tr><tr class=\"f2\"><th class=\"rc\" title=\"Made minus used minus rebuild, over every recipe in the sheet\">Net /min</th><td></td><td></td><td class=\"colhide\"></td>";
    for (const k of shownCols) h += `<td class="v" data-k="${k}"></td>`;
    h += "</tr></tfoot>";
    table.innerHTML = h;
    // index the cells for in-place updates
    cellOf = new Map();
    for (const tr of table.tBodies[0].rows) {
      const r = +tr.dataset.r, cells = [];
      for (const td of tr.querySelectorAll("td.v")) cells.push([+td.dataset.k, td, td.firstChild, td.lastChild]);
      cellOf.set(r, { tr, cells, clk: $(".clk", tr), cnt: $(".cnt", tr), hid: $(".hid", tr) });
    }
    footA = [...table.tFoot.rows[0].querySelectorAll("td.v")];
    footB = [...table.tFoot.rows[1].querySelectorAll("td.v")];
    const f2 = table.tFoot.rows[1].getBoundingClientRect().height;
    table.style.setProperty("--f2h", Math.round(f2) + "px");
    update();
  }

  /* ---- numbers only ---- */
  let derived = null;
  function setText(el, t) { if (el._t !== t) { el._t = t; el.textContent = t; } }
  function setVal(input, v) { if (document.activeElement !== input && input.value !== v) input.value = v; }
  function updateRow(r) {
    const x = cellOf && cellOf.get(r); if (!x) return;
    const rec = R[r];
    x.tr.classList.toggle("on", !S.off[r] && S.c[r] > 0 && S.n[r] > 0);
    x.tr.classList.toggle("hid", hidden.has(rec.id));
    if (x.clk) { if (x.clk.type === "checkbox") x.clk.checked = S.c[r] > 0; else setVal(x.clk, trim((S.c[r] * 100).toFixed(4))); }
    setVal(x.cnt, String(S.n[r]));
    if (x.hid.checked !== hidden.has(rec.id)) x.hid.checked = hidden.has(rec.id);
    for (const [k, td, b, a] of x.cells) {
      const v = actual(r, k);
      setText(b, fmt(base[r].get(k)));
      setText(a, fmt(v));
      td.className = "v " + (Math.abs(v) < 1e-9 ? "zero" : v > 0 ? "pos" : "neg");
    }
  }
  function update() {
    derived = SB.compute(S, G, settings);
    if (cellOf) {
      for (const r of cellOf.keys()) updateRow(r);
      shownCols.forEach((k, j) => {
        const need = derived.need[k] || 0;
        setText(footA[j], need > 1e-9 ? fmt(-need) : "0");
        const net = S.net(k) - need;
        setText(footB[j], fmt(net));
        footB[j].className = "v" + (net < -1e-6 * Math.max(1, S.cons[k]) ? " neg" : "");
      });
    }
    setStatus();
  }
  function setStatus() {
    const running = R.reduce((a, rec, r) => a + (!S.off[r] && S.c[r] > 0 && S.n[r] > 0 ? 1 : 0), 0);
    setText($("#mstatus"), `${shownRows.length} recipe${shownRows.length === 1 ? "" : "s"} × ${shownCols.length} product${shownCols.length === 1 ? "" : "s"} shown · ` +
      `${running} recipes running in the sheet · ${Math.round(derived ? derived.machines : 0).toLocaleString("en-US")} machines · ` +
      `rebuild time ${fmt(derived ? derived.ts : settings.timescale).replace("+", "")} min`);
  }
  function changed() { renderChips(); build(); save(); }

  /* ---- edits ---- */
  table.addEventListener("input", (e) => {
    const tr = e.target.closest("tr[data-r]"); if (!tr) return;
    const r = +tr.dataset.r, t = e.target;
    if (t.classList.contains("clk")) {
      if (t.type === "checkbox") setClock(r, t.checked ? 1 : 0);
      else { if (t.value === "" || isNaN(+t.value)) return; setClock(r, +t.value / 100); }
    } else if (t.classList.contains("cnt")) {
      if (t.value === "" || isNaN(+t.value)) return;
      S.setN(r, S.whole(Math.max(0, +t.value)));
    } else if (t.classList.contains("hid")) {
      if (t.checked) hidden.add(R[r].id); else hidden.delete(R[r].id);
      updateRow(r); save(); return;
    } else return;
    update(); save();
  });
  table.addEventListener("change", (e) => { if (e.target.classList.contains("cell-in")) { update(); } });
  function setClock(r, c) {
    if (S.manual[r]) return;
    c = Math.max(0, Math.min(R[r].mc, c));
    S.contrib(r, -1); S.c[r] = c; S.contrib(r, +1);
  }

  $("#showHidden").addEventListener("change", (e) => { showHidden = e.target.checked; changed(); });
  $("#ficsmas").addEventListener("change", (e) => { settings.ficsmas = e.target.checked; S.setGroup("xmas", settings.ficsmas); if (!settings.ficsmas) for (const k of [...sel]) if (IT[k] && IT[k].xmas) sel.delete(k); renderList(); changed(); });
  $("#timescale").addEventListener("input", (e) => { if (+e.target.value > 0) { settings.timescale = +e.target.value; update(); save(); } });

  /* ---- header actions ---- */
  const msg = (t) => setText($("#ioMsg"), t);
  function syncControls() {
    $("#showHidden").checked = showHidden;
    $("#ficsmas").checked = !!settings.ficsmas;
    $("#timescale").value = settings.timescale;
  }
  $("#btnDefault").addEventListener("click", () => {
    const d = window.DEFAULT_PLAN;
    loadSheet(d.sheet || d, d.settings);
    syncControls(); changed(); msg("Loaded the production sheet's default plan.");
  });
  let zeroArmed = false;
  $("#btnZero").addEventListener("click", (e) => {
    if (!zeroArmed) { zeroArmed = true; e.target.textContent = "Click again to zero"; setTimeout(() => { zeroArmed = false; e.target.textContent = "Set all counts to 0"; }, 3000); return; }
    zeroArmed = false; e.target.textContent = "Set all counts to 0";
    R.forEach((_, r) => { if (S.n[r]) S.setN(r, 0); });
    update(); save(); msg("Every count set to 0 (clocks kept).");
  });
  let downloads = null;
  if (window.claude && window.claude.use) {
    window.claude.use("downloads").then((d) => { downloads = d; $("#btnExport").hidden = !d; }).catch(() => {});
  }
  $("#btnExport").addEventListener("click", async () => {
    if (!downloads) return;
    const day = new Date().toISOString().slice(0, 10);
    const data = JSON.stringify({ app: "satisfactory-recipe-matrix", v: 1, sheet: snapshotSheet(), settings, sel: [...sel], hidden: [...hidden], showHidden }, null, 1);
    try { await downloads.save({ filename: `recipe-matrix-${day}.json`, data }); msg("Exported."); }
    catch (err) {
      const code = err && err.code;
      msg(code === "declined" ? "Export cancelled." : code === "rate_limited" ? "A save prompt is already open." : "Export isn't available here.");
      if (code !== "declined" && code !== "rate_limited") $("#btnExport").hidden = true;
    }
  });
  $("#fileState").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    f.text().then((txt) => {
      let o;
      try { o = JSON.parse(txt); } catch (err) { msg(`${f.name} is not a JSON file.`); return; }
      if (!o || !o.sheet) { msg(`${f.name} is not a production-sheet or matrix export.`); return; }
      loadSheet(o.sheet, o.settings);
      if (o.app === "satisfactory-recipe-matrix") {
        sel = new Set(o.sel || []); hidden = new Set(o.hidden || []); showHidden = !!o.showHidden;
        msg(`Imported ${f.name}.`);
      } else msg(`Took the clocks, counts and building settings from ${f.name}.`);
      syncControls(); renderList(); changed();
    }, () => msg(`Could not read ${f.name}.`));
  });

  /* ---- start ---- */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { saved = null; }
  if (saved && saved.sheet) {
    loadSheet(saved.sheet, saved.settings);
    sel = new Set(saved.sel || []); hidden = new Set(saved.hidden || []); showHidden = !!saved.showHidden;
  } else {
    const d = window.DEFAULT_PLAN;
    loadSheet(d.sheet || d, d.settings);
  }
  syncControls();
  renderChips();
  build();
  if (!cellOf) update();
})();
