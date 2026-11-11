/* UI for the lattice-clock page.  Expects GAME and SatLattice. */
(function () {
  "use strict";
  const G = window.GAME;
  const L = window.SatLattice;
  const STORE = "satisfactory-lattice.v1";
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = L.fmtPct;
  const B = G.buildings;
  const mname = (rec) => (B[rec.m] ? B[rec.m].n : rec.m);
  const mod = (a, m) => ((a % m) + m) % m;

  /* ---- state ---- */
  let settings = { ficsmas: false, overrides: {}, minPer: "100" };
  let pins = new Map(); // recipe id -> BigInt units (0.0001 %), in the order they were set
  try {
    const o = JSON.parse(localStorage.getItem(STORE) || "null");
    if (o) {
      settings = Object.assign(settings, o.settings || {});
      for (const [id, v] of o.pins || []) pins.set(id, BigInt(v));
    }
  } catch (e) { /* storage unavailable or bad: start fresh */ }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify({ settings, pins: [...pins].map(([id, v]) => [id, v.toString()]) })); } catch (e) { /* ignore */ }
  }

  let lat = null, res = null;
  const sigs = new Map();     // recipe id -> signature of its last shown result
  let affected = new Set();   // ids changed by the last accepted edit

  /* base: what each recipe can do with no pins at all (same FICSMAS and item rules). */
  let base = null;
  function rebuild() {
    lat = new L(G, { ficsmas: settings.ficsmas, overrides: settings.overrides });
    const b = lat.evaluate(new Map());
    base = new Set();
    if (b.ok) lat.R.forEach((rec, r) => { const d = b.rows[r]; if (d.run && d.smallest !== null) base.add(rec.id); });
  }
  /* Impossible: possible with no pins, not turned off by hand, but now it cannot run
   * or has no valid value left in its range. */
  function impossible(id, d) {
    if (!d || !base.has(id) || pins.get(id) === 0n) return false;
    const pv = pins.get(id);
    if (pv !== undefined && !(rowById.get(id) || {}).fixed && !L.machineOK(pv)) return true; // pin no longer splits over machines
    return !d.run || (d.smallest === null && !pins.has(id));
  }
  function pinsIdx(p) {
    const m = new Map();
    for (const [id, v] of p) { const r = lat.rIdx[id]; if (r !== undefined) m.set(r, v); }
    return m;
  }

  /* ---- describing a result row ---- */
  function allowedText(x) {
    if (x.step === 0n) return x.offset === 0n ? "off" : "only " + fmt(x.offset);
    if (x.offset === 0n) return x.step === 1n ? "any" : "multiples of " + fmt(x.step);
    return fmt(x.offset) + " + multiples of " + fmt(x.step);
  }
  function rangeText(x) {
    if (!x.run) return "cannot run";
    return fmt(x.lo) + " – " + (x.hi === null ? "∞" : fmt(x.hi));
  }
  /* " = n × per" for the fewest machines that work (always=true: also for one machine). */
  function machinesText(y, fixed, always) {
    if (fixed) { const n = y / L.UNIT; return n > 1n || always ? ` = ${n} machine${n === 1n ? "" : "s"} at 100%` : ""; }
    const n = L.split(y);
    if (n === null) return " — no machine split allowed";
    if (n === 1n) return always ? " = 1 machine" : "";
    return ` = ${n} × ${fmt(y / n)}`;
  }
  const sigOf = (x) => x ? [x.step, x.offset, x.lo, x.hi, x.run, x.smallest, x.lo > 0n ? L.split(x.lo) : ""].join("|") : "";
  const shortOf = (x) => x ? (x.run ? allowedText(x) + ", " + rangeText(x) : "cannot run") : "—";

  /* ---- rows, built once ---- */
  const recs = G.recipes.filter(L.inScope);
  const rowsEl = $("#lrows");
  const rows = recs.map((rec) => {
    const el = document.createElement("div");
    el.className = "lrow";
    el.dataset.id = rec.id;
    el.innerHTML =
      `<div><span class="rn">${esc(rec.name)}</span>${rec.alt ? '<span class="alt">alt</span>' : ""}${rec.xmas ? '<span class="alt">FICSMAS</span>' : ""}` +
      `<span class="rm">${esc(mname(rec))} · layer ${rec.layer}${rec.mc <= 1 ? " · fixed clock" : ""}</span></div>` +
      `<div class="pincell"><input class="cell-in pin" type="text" inputmode="decimal" placeholder="free" aria-label="Effective clock % for ${esc(rec.name)}">` +
      `<label><input type="checkbox" class="offbox"> off</label><span class="msg"></span></div>` +
      `<div class="v c-allow" data-l="Possible"></div><div class="v c-range" data-l="Range"></div><div class="v c-small" data-l="Smallest valid"></div>`;
    const search = (rec.name + " " + mname(rec) + " " + rec.ins.concat(rec.outs).map(([k]) => (G.items[k] || { n: k }).n).join(" ")).toLowerCase();
    return { el, rec, search, pin: $(".pin", el), off: $(".offbox", el), msg: $(".msg", el),
      allow: $(".c-allow", el), range: $(".c-range", el), small: $(".c-small", el), fixed: rec.mc <= 1 };
  });
  { const f = document.createDocumentFragment(); rows.forEach((x) => f.appendChild(x.el)); rowsEl.appendChild(f); }
  const rowById = new Map(rows.map((x) => [x.id = x.rec.id, x]));

  const itemsEl = $("#irows");
  const itemKeys = Object.keys(G.items).filter((k) => k !== "Power").sort((a, b) => G.items[a].n.localeCompare(G.items[b].n));
  const KIND = { raw: "Raw resource", gathered: "Gathered", free: "Build material / equipment", internal: "Internal" };
  const RULE = { raw: "drawn in multiples of 15/min", gathered: "any amount used", free: "net ≥ 0", internal: "net = 0 exactly" };
  const irows = itemKeys.map((k) => {
    const el = document.createElement("div");
    el.className = "lrow";
    el.dataset.k = k;
    el.innerHTML = `<div><span class="rn">${esc(G.items[k].n)}</span>${G.items[k].xmas ? '<span class="alt">FICSMAS</span>' : ""}</div>` +
      `<div class="c-kind"></div><div class="c-rule"></div><div class="pincell"><label><input type="checkbox" class="surplus"> allow surplus</label></div>`;
    return { k, el, kind: $(".c-kind", el), rule: $(".c-rule", el), box: $(".surplus", el) };
  });
  { const f = document.createDocumentFragment(); irows.forEach((x) => f.appendChild(x.el)); itemsEl.appendChild(f); }
  const irowByK = new Map(irows.map((x) => [x.k, x]));

  /* ---- evaluate and draw ---- */
  function setText(el, t) { if (el._t !== t) { el._t = t; el.textContent = t; } }
  function setHTML(el, h) { if (el._h !== h) { el._h = h; el.innerHTML = h; } }

  /* Try a new set of pins (and lattice); on success make it current. */
  function attempt(newPins, label) {
    const t0 = performance.now();
    const out = lat.evaluate(pinsIdx(newPins));
    const ms = performance.now() - t0;
    if (!out.ok) return { ok: false, out };
    pins = newPins; res = out;
    affected = new Set();
    const changes = [], broken = [];
    for (const x of rows) {
      const r = lat.rIdx[x.id];
      const now = r === undefined ? null : res.rows[r];
      const s = sigOf(now);
      const before = sigs.get(x.id);
      const imp = impossible(x.id, now);
      if (before !== undefined && before !== s) {
        affected.add(x.id);
        if (imp && !x._imp) broken.push([x, x._last, now]); else changes.push([x, x._last, now]);
      }
      sigs.set(x.id, s); x._last = now; x._imp = imp;
    }
    setText($("#sv-ms"), Math.round(ms) + " ms");
    showChange(label, changes, broken);
    save();
    render();
    return { ok: true };
  }

  function showChange(label, changes, broken) {
    $(".change").classList.remove("bad");
    if (!label) return;
    const n = changes.length + broken.length;
    setText($("#chgWhat"), label + (n ? ` — ${n} recipe${n === 1 ? "" : "s"} changed` : " — no other recipe changed") +
      (broken.length ? `, ${broken.length} now impossible` : ""));
    const item = ([x, a, b], cls) =>
      `<span class="ci${cls}"><b>${esc(x.rec.name)}</b>: ${esc(shortOf(a))} <span class="arrow">→</span> ${esc(b && b.run ? shortOf(b) + ", no valid value" : "cannot run")}</span>`;
    const head = broken.length ? `<div class="ci-head imp">Now impossible (${broken.length})</div>` + broken.map((c) => item(c, " imp")).join("") +
      (changes.length ? `<div class="ci-head">Other changes</div>` : "") : "";
    const rest = changes.slice(0, 300).map(([x, a, b]) =>
      `<span class="ci"><b>${esc(x.rec.name)}</b>: ${esc(shortOf(a))} <span class="arrow">→</span> ${esc(shortOf(b))}</span>`).join("");
    setHTML($("#chgList"), head + rest + (changes.length > 300 ? `<span class="ci">… and ${changes.length - 300} more</span>` : ""));
  }
  function showReject(text) {
    $(".change").classList.add("bad");
    setText($("#chgWhat"), text);
    setHTML($("#chgList"), "");
  }

  function render() {
    const q = $("#q").value.trim().toLowerCase();
    const show = $("#show").value;
    let shown = 0, off = 0, run = 0;
    for (const x of rows) {
      const r = lat.rIdx[x.id];
      const inLat = r !== undefined;
      const d = inLat ? res.rows[r] : null;
      const pv = pins.get(x.id);
      const isOff = pv === 0n;
      if (inLat && isOff) off++;
      if (d && d.run) run++;
      let vis = inLat;
      if (vis && q && !x.search.includes(q)) vis = false;
      if (vis) {
        if (show === "run") vis = d.run || pv !== undefined || impossible(x.id, d);
        else if (show === "pinned") vis = pv !== undefined;
        else if (show === "affected") vis = affected.has(x.id);
        else if (show === "cant") vis = !d.run;
        else if (show === "imp") vis = impossible(x.id, d);
        else if (show === "restricted") vis = d.run && (d.step !== 1n || d.offset !== 0n || d.lo > 0n || d.hi !== null);
      }
      if (x.el.hidden !== !vis) x.el.hidden = !vis;
      if (!vis) continue;
      shown++;
      x.el.classList.toggle("cant", !d.run);
      x.el.classList.toggle("imp", impossible(x.id, d));
      x.el.classList.toggle("pinned", pv !== undefined && pv > 0n);
      x.el.classList.toggle("off", isOff);
      x.el.classList.toggle("hit", affected.has(x.id));
      if (document.activeElement !== x.pin) { const t = pv !== undefined && pv > 0n ? fmt(pv).replace(/[%,]/g, "") : ""; if (x.pin.value !== t) x.pin.value = t; }
      if (x.off.checked !== isOff) x.off.checked = isOff;
      x.pin.disabled = isOff;
      setText(x.allow, allowedText(d));
      setText(x.range, rangeText(d));
      if (!d.run) setHTML(x.small, "—");
      else if (pv !== undefined) setHTML(x.small, esc(fmt(pv)) + "<small>" + esc(machinesText(pv, x.fixed, true)) + " · pinned</small>");
      else if (d.smallest === null) setHTML(x.small, "<small>none in range</small>");
      else setHTML(x.small, `<button type="button" class="linkish use" data-v="${d.smallest}" title="Pin this value">${esc(fmt(d.smallest))}</button><small>${esc(machinesText(d.smallest, x.fixed))}</small>`);
    }
    setText($("#rowCount"), shown + " shown");
    setText($("#sv-pins"), String([...pins].filter(([id, v]) => v > 0n && lat.rIdx[id] !== undefined).length));
    setText($("#sv-off"), String(off));
    setText($("#sv-run"), String(run));
    setText($("#sv-dim"), String(res.dim));
    renderItems();
  }

  function renderItems() {
    const inLat = new Set(lat.items);
    for (const x of irows) {
      const vis = inLat.has(x.k);
      if (x.el.hidden !== !vis) x.el.hidden = !vis;
      if (!vis) continue;
      const c = lat.cls[x.k];
      setText(x.kind, KIND[c] + (settings.overrides[x.k] ? " (changed)" : ""));
      setText(x.rule, RULE[c]);
      const editable = c === "free" || c === "internal";
      x.box.disabled = !editable;
      x.box.checked = c === "free";
    }
  }

  /* ---- pinning ---- */
  function nearest(d, v, fixed) {
    if (d.step === 0n) return [];
    const ok = (y) => y > 0n && (fixed || L.machineOK(y)) && y >= d.lo && (d.hi === null || y <= d.hi);
    const out = [];
    let y = v - mod(v - d.offset, d.step);
    for (let i = 0; i < 2000 && y > 0n && out.length < 1; i++, y -= d.step) if (ok(y)) out.push(y);
    y = v - mod(v - d.offset, d.step) + d.step;
    for (let i = 0; i < 2000 && out.length < 2; i++, y += d.step) if (ok(y)) out.push(y);
    if (d.hi !== null && out.length === 0 && ok(d.hi)) out.push(d.hi);
    return out.sort((a, b) => (a < b ? -1 : 1));
  }

  function pinRecipe(x, v) {
    const r = lat.rIdx[x.id];
    let d = res.rows[r];
    // a recipe that is already pinned shows only its pin: judge the new value
    // against what it could take with that pin removed
    if (pins.has(x.id) && v !== null) {
      const rest = new Map(pins); rest.delete(x.id);
      const e0 = lat.evaluate(pinsIdx(rest));
      if (e0.ok) d = e0.rows[r];
    }
    setText(x.msg, "");
    const name = x.rec.name;
    if (v === null) {
      if (!pins.has(x.id)) return;
      const np = new Map(pins); np.delete(x.id);
      attempt(np, `Unpinned ${name}`);
      return;
    }
    // quick checks against what the page already shows, for a clear message
    let why = "";
    if (v > 0n && !x.fixed && !L.machineOK(v)) {
      const n0 = L.machinesFor(v), mp = L.getMinPer();
      why = `${fmt(v)} cannot be split evenly (whole 0.0001% steps) over ${n0}` +
        (mp === null || v / mp <= n0 ? " machines" : ` to ${v / mp} machines (each at least ${fmt(mp)})`);
    } else if (v > 0n && x.fixed && v % L.UNIT !== 0n) why = `${name} has a fixed clock: whole machines only (multiples of 100%)`;
    else if (v > 0n && (d.step === 0n ? v !== d.offset : mod(v - d.offset, d.step) !== 0n)) why = `${fmt(v)} is not one of the possible values (${allowedText(d)})`;
    else if (v > 0n && (v < d.lo || (d.hi !== null && v > d.hi))) why = `${fmt(v)} is outside the range ${rangeText(d)}`;
    if (!why) {
      const np = new Map(pins); np.delete(x.id); np.set(x.id, v);
      const res2 = attempt(np, v === 0n ? `Turned off ${name}` : `Pinned ${name} to ${fmt(v)}`);
      if (res2.ok) return;
      why = res2.out.reason === "lattice" ? `${fmt(v)} conflicts with the other pins` : `with ${fmt(v)} the balances cannot all be met (some item would go negative)`;
      if (v === 0n) why = `turning ${name} off leaves the other pins impossible`;
    }
    const near = v > 0n ? nearest(d, v, x.fixed) : [];
    setText(x.msg, why + (near.length ? ". Nearest: " + near.map(fmt).join(", ") : ""));
    showReject(`Not applied: ${name} — ${why}.`);
    render();
  }

  rowsEl.addEventListener("change", (e) => {
    const el = e.target.closest(".lrow"); if (!el) return;
    const x = rowById.get(el.dataset.id); if (!x) return;
    if (e.target.classList.contains("pin")) {
      const t = e.target.value.trim();
      if (t === "") { pinRecipe(x, null); return; }
      const v = L.parsePct(t);
      if (v === null) { setText(x.msg, "Type a percentage with at most 4 decimals, e.g. 112.5"); return; }
      if (v === 0n) { pinRecipe(x, 0n); return; }
      pinRecipe(x, v);
    } else if (e.target.classList.contains("offbox")) {
      pinRecipe(x, e.target.checked ? 0n : null);
    }
  });
  rowsEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("pin")) e.target.blur(); });
  rowsEl.addEventListener("click", (e) => {
    const b = e.target.closest("button.use"); if (!b) return;
    const x = rowById.get(b.closest(".lrow").dataset.id);
    pinRecipe(x, BigInt(b.dataset.v));
  });
  ["#q", "#show"].forEach((s) => $(s).addEventListener("input", render));

  /* ---- sorting: reorder the prebuilt rows once per change ---- */
  let sortKey = "layer", sortDir = 1;
  try { const v = JSON.parse(localStorage.getItem(STORE + ".sort") || "null"); if (v) { sortKey = v[0]; sortDir = v[1]; } } catch (e) { /* ignore */ }
  const outName = (rec) => (rec.outs.length ? (G.items[rec.outs[0][0]] || { n: rec.outs[0][0] }).n : "\uffff");
  const cmp = {
    name: (a, b) => a.rec.name.localeCompare(b.rec.name),
    output: (a, b) => outName(a.rec).localeCompare(outName(b.rec)) || cmp.name(a, b),
    machine: (a, b) => mname(a.rec).localeCompare(mname(b.rec)) || cmp.name(a, b),
    layer: (a, b) => a.rec.layer - b.rec.layer || cmp.output(a, b),
  };
  function applySort() {
    if (!cmp[sortKey]) sortKey = "layer";
    const f = document.createDocumentFragment();
    rows.slice().sort((a, b) => sortDir * cmp[sortKey](a, b)).forEach((x) => f.appendChild(x.el));
    rowsEl.appendChild(f);
    document.querySelectorAll("#sortSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === sortKey)));
    $("#sortDir").textContent = sortDir > 0 ? "▲" : "▼";
  }
  function setSort(k) {
    if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
    try { localStorage.setItem(STORE + ".sort", JSON.stringify([sortKey, sortDir])); } catch (e) { /* ignore */ }
    applySort();
  }
  $("#sortSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSort(b.dataset.sort); });
  $("#sortDir").addEventListener("click", () => setSort(sortKey));
  applySort();

  itemsEl.addEventListener("change", (e) => {
    if (!e.target.classList.contains("surplus")) return;
    const x = irowByK.get(e.target.closest(".lrow").dataset.k);
    const prev = Object.assign({}, settings.overrides);
    const want = e.target.checked ? "free" : "internal";
    if (lat.defaultCls[x.k] === want) delete settings.overrides[x.k]; else settings.overrides[x.k] = want;
    rebuild();
    const r = attempt(pins, `${G.items[x.k].n}: ${want === "free" ? "surplus allowed" : "must balance exactly"}`);
    if (!r.ok) { settings.overrides = prev; rebuild(); showReject(`Not applied: ${G.items[x.k].n} must stay ${want === "free" ? "exact" : "free"} — the current pins would become impossible.`); render(); }
  });

  /* ---- machine split setting ---- */
  function applyMinPer() {
    const t = String(settings.minPer || "").trim();
    L.setMinPer(t === "" ? null : (L.parsePct(t) || 1000000n));
  }
  applyMinPer();
  $("#minPer").value = settings.minPer || "";
  $("#minPer").addEventListener("change", (e) => {
    const t = e.target.value.trim();
    if (t !== "" && L.parsePct(t) === null) { e.target.value = settings.minPer || ""; return; }
    settings.minPer = t;
    applyMinPer();
    const mp = L.getMinPer();
    if (t !== "") e.target.value = fmt(mp).replace("%", "");
    settings.minPer = e.target.value;
    attempt(pins, mp === null ? "Machine split: fewest machines only" : `Machine split: 2+ machines each at least ${fmt(mp)}`);
  });

  /* ---- export / import of the page's own state (a .json file) ---- */
  const STATE_APP = "satisfactory-lattice-clocks";
  let downloads = null;
  if (window.claude && window.claude.use) {
    window.claude.use("downloads").then((d) => { downloads = d; $("#btnExport").hidden = !d; }).catch(() => {});
  }
  $("#btnExport").addEventListener("click", async () => {
    if (!downloads) return;
    const day = new Date().toISOString().slice(0, 10);
    const data = JSON.stringify({ app: STATE_APP, v: 1, settings, pins: [...pins].map(([id, v]) => [id, fmt(v).replace("%", "").replace(/,/g, "")]) }, null, 1);
    try {
      await downloads.save({ filename: `lattice-clocks-${day}.json`, data });
      showNote("Exported the pins and settings.");
    } catch (e) {
      const code = e && e.code;
      showReject(code === "declined" ? "Export cancelled." : code === "rate_limited" ? "A save prompt is already open." : "Export isn't available here.");
      if (code !== "declined" && code !== "rate_limited") $("#btnExport").hidden = true;
    }
  });
  $("#fileState").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    f.text().then((txt) => {
      let o;
      try { o = JSON.parse(txt); } catch (err) { showReject(`${f.name} is not a JSON file.`); return; }
      if (!o || o.app !== STATE_APP || !Array.isArray(o.pins)) {
        showReject(o && o.sheet ? `${f.name} is a production-sheet export: use “Use sheet's recipes” for that.` : `${f.name} is not a state exported from this page.`);
        return;
      }
      const np = new Map();
      for (const [id, v] of o.pins) { const y = L.parsePct(String(v)); if (y !== null && rowById.has(id)) np.set(id, y); }
      const prev = settings;
      settings = Object.assign({ ficsmas: false, overrides: {}, minPer: "100" }, o.settings || {});
      settings.overrides = Object.assign({}, settings.overrides);
      $("#ficsmas").checked = !!settings.ficsmas;
      $("#minPer").value = settings.minPer || "";
      applyMinPer();
      rebuild();
      sigs.clear(); // a fresh start: no change list against the old state
      const r = attempt(np, `Imported ${f.name}: ${np.size} pin${np.size === 1 ? "" : "s"}`);
      if (!r.ok) {
        settings = prev; $("#ficsmas").checked = !!settings.ficsmas; $("#minPer").value = settings.minPer || "";
        applyMinPer(); rebuild(); attempt(pins, "");
        showReject(`Not applied: the pins in ${f.name} are impossible with this data.`);
      }
    }, () => showReject(`Could not read ${f.name}.`));
  });
  function showNote(text) { $(".change").classList.remove("bad"); setText($("#chgWhat"), text); setHTML($("#chgList"), ""); }

  /* ---- header actions ---- */
  $("#ficsmas").checked = !!settings.ficsmas;
  $("#ficsmas").addEventListener("change", (e) => {
    settings.ficsmas = e.target.checked;
    rebuild();
    const r = attempt(pins, "FICSMAS " + (settings.ficsmas ? "on" : "off"));
    if (!r.ok) { settings.ficsmas = !settings.ficsmas; e.target.checked = settings.ficsmas; rebuild(); showReject("Not applied: the current pins would become impossible."); render(); }
  });
  $("#btnClear").addEventListener("click", () => { attempt(new Map(), "Cleared all pins"); });
  $("#btnAllOn").addEventListener("click", () => {
    const np = new Map([...pins].filter(([, v]) => v !== 0n));
    attempt(np, "Turned every recipe back on");
  });
  $("#fileSheet").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      let o;
      try { o = JSON.parse(rd.result); } catch (err) { showReject("That file is not JSON."); return; }
      const sh = o && o.sheet;
      if (!sh || typeof sh !== "object") { showReject("That file is not a production-sheet export (no “sheet”)."); return; }
      const c = sh.c || {}, n = sh.n || {};
      const running = (rec) => (n[rec.id] || 0) > 0 && (rec.mc <= 1 || (c[rec.id] || 0) > 0);
      const np = new Map();
      for (const [id, v] of pins) { const rec = rowById.get(id); if (rec && running(rec.rec) && v > 0n) np.set(id, v); }
      let offN = 0;
      for (const x of rows) if (!running(x.rec)) { np.set(x.id, 0n); offN++; }
      const r = attempt(np, `Kept the ${rows.length - offN} recipes running in ${f.name}; turned the other ${offN} off`);
      if (!r.ok) showReject("Not applied: with only the sheet's recipes, the current pins are impossible. Clear pins first.");
    };
    rd.readAsText(f);
  });

  /* ---- tabs ---- */
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]"); if (!b) return;
    for (const t of $("#tabs").querySelectorAll("button")) t.setAttribute("aria-selected", String(t === b));
    for (const p of document.querySelectorAll(".panel")) p.hidden = p.id !== "tab-" + b.dataset.tab;
  });

  /* ---- start ---- */
  rebuild();
  let first = attempt(pins, "");
  if (!first.ok) { pins = new Map(); attempt(pins, ""); showReject("Saved pins were no longer possible and have been cleared."); }
})();
