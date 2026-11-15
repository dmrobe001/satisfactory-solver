/* Factory planner page: state, rendering and events around SatPlanner (src/planner.js). */
(function () {
  "use strict";
  const G = window.GAME, SET = window.RECIPE_SET;
  const P = window.SatPlanner.create(G, SET);
  const $ = (id) => document.getElementById(id);
  const KEY = "tenth-world-planner-v1";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (x, d) => (Math.abs(x) < 5e-7 ? "0" : Math.abs(x) >= 1000 ? x.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : x.toFixed(d != null ? d : Math.abs(x) >= 100 ? 1 : Math.abs(x) >= 10 ? 2 : 3).replace(/\.?0+$/, ""));
  const clockText = (c) => String(Math.round(c * 1e4) / 1e4);
  const mins = (t) => (!isFinite(t) ? "never" : t >= 120 ? num(t / 60, 1) + " h" : num(t, 1) + " min");
  const iname = (k) => P.itemName(k);

  let st = load() || P.defaultState();
  let res = null, sel = null;
  const undo = [];

  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY) || "null"); return clean(s); } catch (e) { return null; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(exportPlan())); } catch (e) { /* storage may be off */ } }
  function exportPlan() { return { app: "tenth-world-planner", v: 1, rows: st.rows, min: st.min, T: st.T || null, lean: !!st.lean }; }
  /* A plan from storage or a file: keep only what the page knows. */
  function clean(s) {
    if (!s || typeof s !== "object" || !s.rows) return null;
    const out = { rows: {}, min: {}, T: +s.T > 0 ? +s.T : null, lean: !!s.lean };
    for (const [id, u] of Object.entries(s.rows)) {
      if (id in P.rowIdx && P.rows[P.rowIdx[id]].kind === "recipe" && u) out.rows[id] = { n: Math.max(0, Math.round(+u.n || 0)), clock: Math.min(250, Math.max(0, +u.clock || 0)) };
    }
    for (const [id, q] of Object.entries(s.min || {})) if (id in P.rowIdx && +q > 0) out.min[id] = +q;
    return out;
  }
  function change(fn) {
    undo.push(JSON.stringify(st));
    if (undo.length > 60) undo.shift();
    fn();
    refresh();
  }
  function refresh() {
    res = P.solve(st);
    save();
    render();
  }

  // ---- rendering ----
  function render() {
    const focus = document.activeElement && document.activeElement.id;
    $("btnUndo").disabled = !undo.length;
    $("sv-mach").textContent = num(res.machines, 0);
    $("sv-pow").innerHTML = num(res.power.supply / 1000, 2) + " / " + num(res.power.draw / 1000, 2) + " <small>GW</small>";
    $("st-pow").classList.toggle("bad", res.power.supply < res.power.draw - 1e-6);
    $("sv-p5").textContent = mins(res.T5);
    $("sv-re").innerHTML = mins(res.Trebuild) + (res.limit ? " <small>" + esc(iname(res.limit)) + "</small>" : "");
    $("st-re").classList.toggle("warn", res.Trebuild > res.T * (1 + 1e-6));
    $("sv-iss").textContent = res.issues.length;
    $("st-iss").classList.toggle("bad", res.issues.length > 0);
    if (document.activeElement !== $("inT")) $("inT").value = st.T || "";
    for (const b of $("segLean").children) b.setAttribute("aria-pressed", String(!!st.lean === (b.dataset.lean === "1")));
    const raw = res.issues.filter((i) => i.kind === "raw"), other = res.issues.filter((i) => i.kind !== "raw");
    const show = other.slice(0, 6).map((i) => i.text);
    if (raw.length) show.push("More than a tenth of the world's supply is drawn of: " + raw.map((i) => P.rows[P.rowIdx[i.row]].name.replace(/^.*: /, "")).join(", ") + " (Raw supply tab)");
    $("issues").innerHTML = show.map((t) => '<div class="iss">' + esc(t) + "</div>").join("") +
      (other.length > 6 ? '<div class="more">and ' + (other.length - 6) + " more; see the Items tab.</div>" : "");
    renderRows(); renderSide(); renderItems(); renderRaw(); renderBuild();
    $("planText").value = JSON.stringify(exportPlan(), null, 1);
    if (focus && $(focus)) $(focus).focus();
  }

  const byItem = () => Object.fromEntries(res.items.map((i) => [i.key, i]));

  function renderRows() {
    const q = $("q").value.trim().toLowerCase(), onlySet = $("onlySet").checked, onlyBad = $("onlyBad").checked;
    const items = byItem();
    let html = "", layer = null, shown = 0;
    res.rows.forEach((r, i) => {
      const row = P.rows[i];
      if (row.kind === "source" || row.kind === "geo") return;
      const bad = r.short;
      if (onlySet && r.role !== "set") return;
      if (onlyBad && !bad) return;
      if (q && !(row.name + " " + row.machineName + " " + row.ins.concat(row.outs).map(([k]) => iname(k)).join(" ")).toLowerCase().includes(q)) return;
      if (row.layer !== layer) { layer = row.layer; html += '<tr class="layer"><td colspan="8">' + (layer ? layer + " step" + (layer > 1 ? "s" : "") + " from raw" : "made from nothing") + "</td></tr>"; }
      shown++;
      const fixed = row.kind === "fixed";
      const it = r.main ? items[r.main] : null;
      const isSet = r.role === "set";
      html += '<tr data-id="' + row.id + '" class="' + (sel === row.id ? "sel " : "") + (bad ? "bad " : "") + (r.n ? "" : "zero") + '">' +
        '<td class="rcell"><span class="rn">' + esc(row.name) + (row.alt ? '<span class="alt">alt</span>' : "") +
        '<span class="role ' + r.role + '">' + (r.role === "trim" ? "trims " + esc(iname(r.trims)) : r.role) + "</span></span>" +
        '<span class="rm">' + esc(row.machineName) + "</span></td>" +
        (fixed ? '<td class="n">1</td><td class="n">100</td>'
          : '<td class="n"><input class="num-in' + (isSet ? " is-set" : "") + '" id="n-' + row.id + '" data-f="n" type="number" min="0" step="1" value="' + r.n + '" aria-label="Machines, ' + esc(row.name) + '"></td>' +
            '<td class="n"><input class="num-in' + (isSet ? " is-set" : "") + '" id="c-' + row.id + '" data-f="clock" type="number" min="0" max="250" step="any" value="' + clockText(r.clock) + '" aria-label="Clock, ' + esc(row.name) + '"></td>') +
        '<td class="n need">' + (r.req > 1e-9 || r.short ? num(r.req, 3) : "") + "</td>" +
        '<td class="n">' + (it ? num(it.net) : "") + "</td>" +
        '<td class="n">' + (fixed || !r.main ? "" : '<input class="num-in" id="m-' + row.id + '" data-f="min" type="number" min="0" step="any" value="' + (st.min[row.id] || "") + '" aria-label="Minimum net, ' + esc(row.name) + '">') + "</td>" +
        '<td class="n">' + (r.gen ? '<span class="gen">+' + num(r.gen, 0) + "</span>" : r.mw ? num(r.mw, 0) : "") + "</td>" +
        "<td>" + (fixed ? "" : (isSet ? '<button class="btn sm" type="button" data-act="auto" title="Let the page size this row">Auto</button> ' : "") +
          (r.req > 1e-9 && (isSet ? Math.abs(r.level - r.req) > 1e-6 : r.role === "auto" && r.level - r.req > 1e-6)
            ? '<button class="btn sm" type="button" data-act="fit" title="Set to the fewest machines, clocked to exactly what is needed">Fit</button>' : "")) + "</td></tr>";
    });
    $("rbody").innerHTML = html || '<tr><td colspan="8" class="note">No rows match.</td></tr>';
    $("rowCount").textContent = shown + " rows";
  }

  function renderSide() {
    const el = $("side");
    if (!sel || !(sel in P.rowIdx)) { el.innerHTML = '<div class="note">Select a recipe to see what it takes and makes, and who else makes or uses each item.</div>'; return; }
    const i = P.rowIdx[sel], row = P.rows[i], r = res.rows[i], items = byItem();
    const flow = (list, sign) => list.map(([k, q]) => {
      const it = items[k];
      const others = res.rows.map((rr, j) => ({ rr, row: P.rows[j] })).filter(({ rr, row: o }) => o.id !== row.id && rr.level > 1e-9 &&
        (sign < 0 ? o.outs : o.ins).some(([kk]) => kk === k));
      const bad = it && it.status !== "ok";
      return "<tr><td>" + esc(iname(k)) + (G.items[k] && G.items[k].f ? ' <span class="who">fluid</span>' : "") + '</td><td class="n">' + num(q * r.level) +
        '</td><td class="n' + (bad ? " bad" : "") + '">' + (it ? num(it.net) : "") + '</td></tr><tr><td colspan="3" class="who">' +
        (sign < 0 ? "made by " : "used by ") + (others.length ? others.map(({ row: o }) => '<button class="linkish" type="button" data-go="' + o.id + '">' + esc(o.name) + "</button>").join(", ") : "nothing else") +
        (it && it.maker && sign > 0 && it.maker !== row.id ? "; demand is followed by " + esc(P.rows[P.rowIdx[it.maker]].name) : "") + "</td></tr>";
    }).join("");
    const head = '<thead><tr><th>Item</th><th class="n">This row /min</th><th class="n">Factory net</th></tr></thead>';
    el.innerHTML = '<div class="side-head"><h2>' + esc(row.name) + '</h2><div class="meta">' + esc(row.machineName) + " · " + num(r.n, 0) + " at " + clockText(r.clock) + " % = " + num(r.level, 3) +
      " machines at 100 %" + (r.req > 1e-9 ? " · needs " + num(r.req, 3) : "") + (r.mw ? " · " + num(r.mw, 0) + " MW" : "") + (r.gen ? " · makes " + num(r.gen, 0) + " MW" : "") + "</div></div>" +
      (r.short ? '<div class="issues"><div class="iss">Below what is asked of it. Fit sets it to ' + Math.ceil(r.req - 1e-7) + " at " + clockText(100 * r.req / Math.ceil(r.req - 1e-7)) + " %.</div></div>" : "") +
      (row.ins.length ? '<h3>Takes</h3><table class="flowtab">' + head + "<tbody>" + flow(row.ins, -1) + "</tbody></table>" : "") +
      (row.outs.length ? '<h3>Makes</h3><table class="flowtab">' + head + "<tbody>" + flow(row.outs, 1) + "</tbody></table>" : "") +
      (row.lp != null ? '<p class="note">The recipe selection ran this at ' + num(row.lp, 2) + " machines (a slower Phase 5 pace, about " + num(row.lp * SET.start_scale, 2) + " at the starting pace).</p>" : "");
  }

  function renderItems() {
    const q = $("iq").value.trim().toLowerCase();
    const rows = res.items.filter((i) => !q || iname(i.key).toLowerCase().includes(q))
      .sort((a, b) => (a.status === "ok") - (b.status === "ok") || iname(a.key).localeCompare(iname(b.key)));
    $("ibody").innerHTML = rows.map((i) => '<tr class="' + (i.status !== "ok" ? "bad" : "") + '"><td>' + esc(iname(i.key)) + "</td><td>" +
      (i.raw ? "raw, net 0" : i.exact ? (i.fluid ? "fluid, net 0" : "waste, net 0") : "solid, net ≥ need") + '</td><td class="n">' + num(i.made) + '</td><td class="n">' + num(i.used) +
      '</td><td class="n">' + (i.need ? num(i.need) : "") + '</td><td class="n">' + (i.min ? num(i.min) : "") + '</td><td class="n">' + num(i.net) +
      '</td><td class="n">' + (i.stock ? mins(i.time).replace(" min", "") : "") + "</td><td>" + (i.maker ? '<button class="linkish" type="button" data-go="' + i.maker + '">' + esc(P.rows[P.rowIdx[i.maker]].name) + "</button>" : "") + "</td></tr>").join("");
    $("itemCount").textContent = rows.length + " items";
  }

  function renderRaw() {
    let html = "";
    res.rows.forEach((r, i) => {
      const row = P.rows[i];
      if (row.kind !== "source" && row.kind !== "geo") return;
      const rate = row.outs.length ? row.outs[0][1] : 0;
      const drawn = rate * r.level, lim = row.cap != null && rate ? row.cap * row.maxClock * rate : null;
      const share = lim ? drawn / lim : null;
      html += '<tr class="' + (r.over ? "bad" : "") + '"><td>' + esc(row.name) + '</td><td class="n">' + (rate ? num(drawn) : "") + '</td><td class="n">' + (lim ? num(lim) : rate ? "no limit" : "") +
        "</td><td>" + (share != null ? '<span class="meter' + (share > 1 + 1e-9 ? " over" : "") + '"><i style="width:' + Math.min(100, 100 * share).toFixed(1) + '%"></i></span> ' + num(100 * share, 0) + " %" : "") +
        '</td><td class="n">' + num(r.n, 1) + (row.cap != null ? " of " + num(row.cap, 1) : "") + '</td><td class="n">' + clockText(r.clock) + '</td><td class="n">' +
        (r.gen ? '<span class="gen">+' + num(r.gen, 0) + "</span>" : num(r.mw, 0)) + "</td></tr>";
    });
    $("wbody").innerHTML = html;
  }

  function renderBuild() {
    const B = G.buildings;
    const rows = Object.entries(res.buildings).sort((a, b) => b[1] - a[1]);
    $("bbody").innerHTML = rows.map(([k, n]) => "<tr><td>" + esc(B[k].n) + '</td><td class="n">' + num(n, 0) + "</td></tr>").join("");
    const total = rows.reduce((a, [, n]) => a + n, 0);
    $("buildNote").textContent = num(total, 0) + " buildings in all, spread over " + mins(res.T) + ". " +
      (res.gathered.length ? "Gathered by hand and not timed: " + res.gathered.map((g) => num(g.amount, 0) + " " + iname(g.key)).join(", ") + "." : "");
  }

  // ---- events ----
  $("rbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    const id = tr.dataset.id, act = e.target.dataset && e.target.dataset.act;
    if (act === "auto") { change(() => { delete st.rows[id]; }); return; }
    if (act === "fit") {
      const r = res.rows[P.rowIdx[id]];
      const n = Math.max(1, Math.ceil(r.req - 1e-7));
      change(() => { st.rows[id] = { n, clock: Math.ceil(1e6 * r.req / n - 1e-6) / 1e4 }; });
      return;
    }
    if (e.target.tagName === "INPUT") return;
    sel = id; renderRows(); renderSide();
  });
  $("rbody").addEventListener("change", (e) => {
    const t = e.target, tr = t.closest("tr[data-id]");
    if (!tr || !t.dataset.f) return;
    const id = tr.dataset.id, r = res.rows[P.rowIdx[id]], v = +t.value;
    if (t.dataset.f === "min") { change(() => { if (v > 0) st.min[id] = v; else delete st.min[id]; }); return; }
    if (!(v >= 0)) { render(); return; }
    change(() => {
      const cur = st.rows[id] || { n: r.n, clock: Math.round(r.clock * 1e4) / 1e4 };
      st.rows[id] = t.dataset.f === "n" ? { n: Math.round(v), clock: cur.clock } : { n: cur.n, clock: Math.min(250, v) };
    });
  });
  document.addEventListener("click", (e) => {
    const go = e.target.dataset && e.target.dataset.go;
    if (!go) return;
    sel = go; showTab("recipes"); $("q").value = ""; $("onlySet").checked = $("onlyBad").checked = false;
    renderRows(); renderSide();
    const tr = $("rbody").querySelector('tr[data-id="' + go + '"]');
    if (tr) tr.scrollIntoView({ block: "center" });
  });
  for (const id of ["q", "onlySet", "onlyBad"]) $(id).addEventListener("input", renderRows);
  $("iq").addEventListener("input", renderItems);
  $("inT").addEventListener("change", (e) => change(() => { st.T = +e.target.value > 0 ? +e.target.value : null; }));
  $("segLean").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) change(() => { st.lean = b.dataset.lean === "1"; }); });
  $("btnUndo").addEventListener("click", () => { if (undo.length) { st = JSON.parse(undo.pop()); refresh(); } });
  $("btnReset").addEventListener("click", () => change(() => { st = P.defaultState(); }));
  function showTab(name) {
    for (const b of $("tabs").children) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    for (const p of document.querySelectorAll("main > .panel")) p.hidden = p.id !== "tab-" + name;
  }
  $("tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); });
  const say = (t) => { $("saveMsg").textContent = t; };
  $("btnCopy").addEventListener("click", () => {
    const ta = $("planText");
    const fallback = () => { ta.select(); say("Selected; copy with Ctrl+C."); };
    try { navigator.clipboard.writeText(ta.value).then(() => say("Copied."), fallback); } catch (e) { fallback(); }
  });
  function loadText(text) {
    let s = null;
    try { s = clean(JSON.parse(text)); } catch (e) { s = null; }
    if (!s) { say("That is not a plan from this page."); return; }
    change(() => { st = s; });
    say("Loaded.");
  }
  $("btnLoad").addEventListener("click", () => loadText($("planText").value));
  $("fileState").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => loadText(String(rd.result));
    rd.readAsText(f);
    e.target.value = "";
  });

  refresh();
})();
