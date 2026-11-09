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

  const BELTS = [1, 2, 3, 4, 5, 6].map((k) => "ConveyorBeltMk" + k);
  const PIPES = ["Pipeline", "PipelineMK2"];
  const RAIL = "RailroadTrack";
  const PER_MACHINE = ["PipeHyper", "PowerLine", "Foundation_8x1_01", "PowerPoleMk1", "PowerPoleMk2", "PowerPoleMk3", "PowerTower"];
  const DEFAULTS = () => ({
    timescale: 60,
    lane: Object.fromEntries(BELTS.concat(PIPES, [RAIL]).map((k) => [k, 1])),
    perMachine: { PipeHyper: 1, PowerLine: 2, Foundation_8x1_01: 4, PowerPoleMk1: 0, PowerPoleMk2: 0, PowerPoleMk3: 1, PowerTower: 0.05 },
    extra: {},
  });
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
    const d = DEFAULTS();
    settings = Object.assign(d, o.settings || {});
    settings.lane = Object.assign(d.lane, (o.settings || {}).lane || {});
    settings.perMachine = Object.assign(DEFAULTS().perMachine, (o.settings || {}).perMachine || {});
    settings.extra = Object.assign({}, (o.settings || {}).extra || {});
    S.load(o.sheet || {});
  }

  // Default sheet: built by tools/import_plan.js from the user's earlier plan.
  function loadDefault() {
    settings = DEFAULTS();
    S.load(window.DEFAULT_PLAN || {});
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
    else clockCell = `<input class="cell-in clk" type="number" id="clk-${r}" min="0" max="${rec.mc * 100}" step="any" aria-label="Clock %">`;
    const floorCell = S.hasFloor(r)
      ? `<input class="cell-in flr" type="number" id="flr-${r}" min="0" step="any" aria-label="Floor per minute">`
      : `<span class="fixed">—</span>`;
    const field = (label, inner, cls = "") => `<div class="fld ${cls}"><span class="fl">${label}</span>${inner}</div>`;
    tr.innerHTML =
      `<div class="band b-mid">` +
        `<div class="rhead"><span class="rn">${esc(rec.name)}${rec.alt ? '<span class="alt">alt</span>' : ""}</span>` +
        `<span class="rm">${esc(mname(rec))} · layer ${rec.layer}</span></div>` +
        `<div class="fields">` +
          field("Clock %", clockCell) +
          field("Machines", `<input class="cell-in cnt" type="number" id="cnt-${r}" min="0" step="1" aria-label="Machines">`) +
          (S.hasFloor(r) ? field("Floor /min", floorCell) + field("Surplus /min", `<span class="need c-sur"></span>`) : "") +
          field("Build need", `<span class="need c-need"></span>`) +
        `</div>` +
      `</div>` +
      `<div class="band b-in"><span class="fl">Inputs <i>per machine · total</i></span><div class="flow"></div></div>` +
      `<div class="band b-out"><div class="outs"><span class="fl">Outputs <i>per machine · total</i></span><div class="flow"></div></div>` +
        `<div class="fields pwr">` +
          field("MW @100%", `<span class="pw c-p100"></span>`) + field("MW @clock", `<span class="pw c-pclk"></span>`) + field("MW total", `<span class="pw c-ptot"></span>`) +
        `</div>` +
      `</div>`;
    const search = (rec.name + " " + mname(rec) + " " + rec.ins.concat(rec.outs).map(([k]) => IT[k].n).join(" ")).toLowerCase();
    return {
      tr, rec, search,
      inFlow: $(".b-in .flow", tr), outFlow: $(".b-out .flow", tr),
      clk: $(".clk", tr), flr: $(".flr", tr), cnt: $(".cnt", tr),
      need: $(".c-need", tr), sur: $(".c-sur", tr), p100: $(".c-p100", tr), pclk: $(".c-pclk", tr), ptot: $(".c-ptot", tr),
      flags: { in: false, mid: false, out: false },
    };
  });
  rows.forEach((row) => tbody.appendChild(row.tr));

  tbody.addEventListener("input", (e) => {
    const t = e.target;
    const tr = t.closest(".row");
    if (!tr) return;
    const r = +tr.dataset.r;
    if (t.classList.contains("clk")) {
      if (t.type === "checkbox") S.setClock(r, t.checked ? 1 : 0);
      else { if (t.value === "" || isNaN(+t.value)) return; S.setClock(r, +t.value / 100); }
    } else if (t.classList.contains("flr")) {
      if (t.value !== "" && isNaN(+t.value)) return;
      S.setFloor(r, +t.value || 0);
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
    const comp = {};
    let machines = 0, solid = 0, fluid = 0;
    R.forEach((rec, r) => {
      const b = S.buildings(r);
      if (!b) return;
      comp[rec.m] = (comp[rec.m] || 0) + b;
      machines += b;
      const [s, f] = S.lanes(r);
      solid += s * b; fluid += f * b;
    });
    const add = (k, v) => { if (v > 0) comp[k] = (comp[k] || 0) + Math.ceil(v - 1e-9); };
    BELTS.forEach((k) => add(k, solid * (settings.lane[k] || 0)));
    PIPES.forEach((k) => add(k, fluid * (settings.lane[k] || 0)));
    add(RAIL, (solid + fluid) * (settings.lane[RAIL] || 0));
    PER_MACHINE.forEach((k) => add(k, machines * (settings.perMachine[k] || 0)));
    const total = {};
    for (const k of Object.keys(B)) {
      const t = (comp[k] || 0) + (+settings.extra[k] || 0);
      if (t) total[k] = t;
    }
    const bom = new Float64Array(KEYS.length);
    for (const [k, t] of Object.entries(total)) {
      for (const [it, q] of B[k].cost) bom[S.itemIdx[it]] += t * q;
    }
    const ts = Math.max(1e-6, +settings.timescale || 60);
    const need = bom.map((q) => q / ts);
    const deficit = new Uint8Array(KEYS.length);
    const target = new Float64Array(KEYS.length);
    for (let k = 0; k < KEYS.length; k++) { deficit[k] = S.inDeficit(k) ? 1 : 0; target[k] = S.target(k); }
    derived = { comp, total, machines, solid, fluid, bom, need, deficit, target, ts };
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
  function setVal(input, v) {
    if (!input) return;
    if (document.activeElement === input) return;
    input.value = v;
  }

  function refresh() {
    derive();
    const pw = S.power();
    rows.forEach((row, r) => {
      const rec = row.rec;
      const active = S.isActive(r);
      const c = S.c[r];
      row.tr.classList.toggle("on", active);
      row.tr.classList.toggle("idle", !active);
      if (row.clk) {
        if (row.clk.type === "checkbox") row.clk.checked = c > 0;
        else setVal(row.clk, c > 0 ? trim((c * 100).toFixed(3)) : "0");
      }
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
          if (derived.target[k] < nd - 1e-9) fmid = true;
        }
      }
      row.need.innerHTML = needH;
      if (row.sur) {
        const k0 = S.outs[r][0][0];
        row.sur.textContent = active ? fmt(S.net(k0)) + unit(k0) : "";
        row.sur.title = "Net production of " + iname(k0) + " after every running consumer";
      }
      row.tr.classList.toggle("w-in", fin);
      row.tr.classList.toggle("w-out", fout);
      row.tr.classList.toggle("w-mid", fmid);
      row.flags = { in: fin, mid: fmid, out: fout };
      // count
      setVal(row.cnt, String(S.n[r] || 0));
      // flows
      row.inFlow.innerHTML = flowHTML(S.ins[r], r, active, false);
      row.outFlow.innerHTML = flowHTML(S.outs[r], r, active, true);
      // power
      const p1 = S.machinePower(r, 1), pc = S.machinePower(r, c > 0 ? c : 0), pt = active ? pc * S.n[r] : 0;
      const pcell = (el, v) => { el.textContent = rec.p === 0 ? "—" : fmt(v); el.classList.toggle("gen", v < 0); };
      pcell(row.p100, p1); pcell(row.pclk, pc); pcell(row.ptot, pt);
    });
    renderSummary(pw);
    applyFilter();
    renderActiveTab();
    $("#io").value = JSON.stringify(snapshot());
  }

  function renderSummary(pw) {
    const def = derived.deficit.reduce((a, b) => a + b, 0);
    const orange = rows.filter((x) => x.flags.mid && x.tr.classList.contains("on")).length;
    const warn = !S.converged;
    $("#summary").innerHTML =
      `<div class="stat ${pw.deficit ? "bad" : ""}"><span class="lbl">Power supply / demand</span><span class="val">${fmt(pw.supply)} / ${fmt(pw.demand)} <small>MW</small></span></div>` +
      `<div class="stat ${pw.deficit ? "bad" : ""}"><span class="lbl">Net power</span><span class="val">${fmt(pw.net)} <small>MW${pw.boost ? ` · boost +${fmt(pw.boost * 100)}%` : ""}</small></span></div>` +
      `<div class="stat"><span class="lbl">Production buildings</span><span class="val">${derived.machines.toLocaleString("en-US")}</span></div>` +
      `<div class="stat"><span class="lbl">Lanes solid / fluid</span><span class="val">${derived.solid} / ${derived.fluid}</span></div>` +
      `<div class="stat ${def ? "bad" : ""}"><span class="lbl">Items in deficit</span><span class="val">${def}</span></div>` +
      `<div class="stat"><span class="lbl"><label for="sum-ts">Build time (min)</label></span><span class="val"><input type="number" id="sum-ts" min="0.01" step="any" value="${esc(settings.timescale)}"></span></div>` +
      (warn ? `<div class="stat warn"><span class="lbl">Feedback loop</span><span class="val"><small>update stopped after 20 000 steps</small></span></div>` : "");
  }
  $("#summary").addEventListener("change", (e) => {
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
      row.tr.hidden = !vis;
      if (vis) n++;
    });
    $("#rowCount").textContent = `${n} of ${rows.length} recipes`;
  }
  ["#q", "#show", "#kind"].forEach((s) => $(s).addEventListener("input", applyFilter));

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

  function status(k) {
    if (derived.deficit[k]) return `<span class="pill bad">deficit</span>`;
    if (derived.need[k] > 1e-9 && derived.target[k] < derived.need[k] - 1e-9) return `<span class="pill warn">floor below need</span>`;
    const net = S.net(k);
    if (net > S.tol(k) + derived.target[k]) return `<span class="pill">surplus</span>`;
    return `<span class="pill ok">balanced</span>`;
  }
  function findItem(k) {
    $("#q").value = iname(k);
    $("#show").value = "all"; $("#kind").value = "all";
    showTab("recipes"); applyFilter();
  }

  function renderBalance() {
    const tb = $("#balance tbody");
    const ks = [];
    for (let k = 0; k < KEYS.length; k++) if (S.prod[k] > 1e-9 || S.cons[k] > 1e-9 || derived.target[k] > 0) ks.push(k);
    ks.sort((a, b) => (derived.deficit[b] - derived.deficit[a]) || iname(a).localeCompare(iname(b)));
    tb.innerHTML = ks.length ? ks.map((k) => {
      const m = S.mult(k);
      return `<tr><td><button class="linkish" type="button" data-k="${k}">${esc(iname(k))}</button></td>` +
        `<td class="n">${fmt(S.prod[k] * m)}${unit(k)}</td><td class="n">${fmt(S.cons[k])}${unit(k)}</td>` +
        `<td class="n">${fmt(S.net(k))}${unit(k)}</td><td class="n">${derived.target[k] ? fmt(derived.target[k]) : ""}</td>` +
        `<td class="n">${derived.need[k] > 1e-9 ? fmt(derived.need[k]) : ""}</td><td>${status(k)}</td></tr>`;
    }).join("") : `<tr><td colspan="7" class="note">Nothing is running yet. Set a clock above 0% on a recipe to start.</td></tr>`;
  }
  $("#balance").addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) findItem(+b.dataset.k); });

  const bKeys = Object.keys(B).sort((a, b) => B[a].n.localeCompare(B[b].n));
  function renderBuildings() {
    const tb = $("#buildings tbody");
    const q = $("#bq").value.trim().toLowerCase();
    const all = $("#bshow").value === "all";
    const ks = bKeys.filter((k) => (all || derived.total[k] || +settings.extra[k]) && (!q || B[k].n.toLowerCase().includes(q)));
    // keep focus while typing in an Extra field
    const fid = document.activeElement && document.activeElement.id;
    tb.innerHTML = ks.length ? ks.map((k) => {
      const cost = B[k].cost.map(([it, q2]) => `${fmt(q2)} ${esc(IT[it].n)}`).join(", ");
      return `<tr><td>${esc(B[k].n)}</td><td class="n">${fmt(derived.comp[k] || 0)}</td>` +
        `<td class="n"><input class="cell-in" type="number" min="0" step="1" id="ex-${esc(k)}" data-b="${esc(k)}" value="${settings.extra[k] || ""}" aria-label="Extra ${esc(B[k].n)}"></td>` +
        `<td class="n"><b>${fmt(derived.total[k] || 0)}</b></td><td class="note">${cost}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="note">No buildings yet. Switch Show to “All buildings” to add some by hand.</td></tr>`;
    if (fid && fid.startsWith("ex-")) { const el = document.getElementById(fid); if (el) { el.focus(); const v = el.value; el.value = ""; el.value = v; } }
  }
  $("#buildings").addEventListener("input", (e) => {
    const k = e.target.dataset.b; if (!k) return;
    const v = +e.target.value;
    if (v > 0) settings.extra[k] = v; else delete settings.extra[k];
    save(); refresh();
  });
  ["#bq", "#bshow"].forEach((s) => $(s).addEventListener("input", renderBuildings));

  function renderMaterials() {
    $("#bomNote").textContent = `Total build cost of every building on the Buildings tab, divided by the build time of ${fmt(derived.ts)} min.`;
    const tb = $("#materials tbody");
    const ks = [];
    for (let k = 0; k < KEYS.length; k++) if (derived.bom[k] > 1e-9) ks.push(k);
    ks.sort((a, b) => iname(a).localeCompare(iname(b)));
    tb.innerHTML = ks.length ? ks.map((k) => `<tr><td><button class="linkish" type="button" data-k="${k}">${esc(iname(k))}</button></td>` +
      `<td class="n">${fmt(derived.bom[k])}</td><td class="n">${fmt(derived.need[k])}</td><td class="n">${fmt(S.net(k))}</td>` +
      `<td class="n">${derived.target[k] ? fmt(derived.target[k]) : ""}</td><td>${status(k)}</td></tr>`).join("")
      : `<tr><td colspan="6" class="note">No buildings yet, so nothing to build.</td></tr>`;
  }
  $("#materials").addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) findItem(+b.dataset.k); });

  function kvInputs(el, keys, obj, group) {
    if (!el.dataset.built) {
      el.innerHTML = keys.map((k) => `<label for="set-${group}-${k}">${esc(B[k] ? B[k].n : k)}</label>` +
        `<input class="cell-in" type="number" min="0" step="any" id="set-${group}-${k}" data-g="${group}" data-k="${k}">`).join("");
      el.dataset.built = "1";
    }
    keys.forEach((k) => setVal(document.getElementById(`set-${group}-${k}`), obj[k]));
  }
  function renderSettings() {
    setVal($("#set-timescale"), settings.timescale);
    kvInputs($("#laneSet"), BELTS.concat(PIPES, [RAIL]), settings.lane, "lane");
    kvInputs($("#machSet"), PER_MACHINE, settings.perMachine, "perMachine");
  }
  $("#tab-settings").addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "set-timescale") { if (+t.value > 0) settings.timescale = +t.value; }
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
    S.reset(); settings = DEFAULTS(); save(); refresh(); $("#ioMsg").textContent = "Sheet cleared.";
  });

  function hideBanner() { $("#exampleBanner").hidden = true; }
  $("#bannerClear").addEventListener("click", () => { S.reset(); settings = DEFAULTS(); hideBanner(); save(); refresh(); });

  /* ---- boot ---- */
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { saved = null; }
  try { const s = JSON.parse(localStorage.getItem(STORE + ".sort") || "null"); if (s) { sortKey = s[0]; sortDir = s[1]; } } catch (e) { /* ignore */ }
  if (saved && saved.sheet) applySnapshot(saved);
  else { loadDefault(); $("#exampleBanner").hidden = false; }
  applySort();
  refresh();
})();
