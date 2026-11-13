/* Building blocks page.  Expects BLOCKS = {pools: [{name, title, ...pool json}], items: {id: name}, machines: {id: name}}. */
(function () {
  "use strict";
  const D = window.BLOCKS;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const iname = (k) => D.items[k] || k;
  const fmt = (x) => { const a = Math.abs(x); const t = a >= 1000 ? Math.round(a).toLocaleString("en-US") : String(+a.toFixed(3)); return t; };
  let P = null, sel = null, sortKey = "machines", sortDir = 1;

  function prep(p) {
    const rid = {};
    p.recipes.forEach((r) => (rid[r.id] = r));
    const modes = new Set(p.rays.map((b) => JSON.stringify(b.n)));
    p.blocks.forEach((b, i) => {
      b.id = i + 1;
      b.makes = Object.entries(b.net).filter(([k, v]) => p.classes[k] === "pile" && v > 1e-9).sort((x, y) => iname(x[0]).localeCompare(iname(y[0])));
      b.draws = Object.entries(b.net).filter(([k, v]) => p.classes[k] === "raw" && v < -1e-9).sort((x, y) => x[1] - y[1]);
      b.k = b.makes.length;
      b.mode = modes.has(JSON.stringify(b.n));
    });
    p.rid = rid;
    p.ready = true;
  }
  function choose(i) {
    P = D.pools[i];
    if (!P.ready) prep(P);
    sel = null;
    document.querySelectorAll("#pools button").forEach((b, j) => b.setAttribute("aria-selected", j === i ? "true" : "false"));
    const used = new Set();
    P.blocks.forEach((b) => Object.keys(b.n).forEach((r) => used.add(r)));
    const prods = [...new Set(P.blocks.flatMap((b) => b.makes.map((m) => m[0])))].sort((a, b) => iname(a).localeCompare(iname(b)));
    $("#fMake").innerHTML = `<option value="">any product</option>` + prods.map((k) => `<option value="${esc(k)}">${esc(iname(k))}</option>`).join("");
    $("#fRec").innerHTML = `<option value="">any recipe</option>` + P.recipes.filter((r) => used.has(r.id)).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
    $("#fK").value = "";
    $("#fModes").checked = false;
    const big = Math.max(...P.blocks.map((b) => b.machines));
    $("#stats").innerHTML = [["Blocks", P.blocks.length.toLocaleString("en-US")], ["Elementary modes", P.rays.length], ["Recipes used", used.size + " / " + P.recipes.length],
      ["Dimension", P.info.dim], ["Largest block", big.toLocaleString("en-US") + " <small>machines</small>"], ["Computed in", (P.seconds.rays + P.seconds.hilbert).toFixed(1) + " <small>s</small>"]]
      .map(([l, v]) => `<div class="stat"><span class="lbl">${l}</span><span class="val">${v}</span></div>`).join("");
    render();
  }
  function list() {
    const mk = $("#fMake").value, rc = $("#fRec").value, K = +$("#fK").value || 0, modes = $("#fModes").checked;
    const L = P.blocks.filter((b) => (!mk || b.makes.some((m) => m[0] === mk)) && (!rc || b.n[rc]) && (!K || b.k <= K) && (!modes || b.mode));
    L.sort((a, b) => (a[sortKey] - b[sortKey]) * sortDir || a.machines - b.machines || a.id - b.id);
    return L;
  }
  function render() {
    const L = list(), mk = $("#fMake").value;
    const shown = L.slice(0, 1000);
    $("#bbody").innerHTML = shown.map((b) => `<tr data-id="${b.id}" class="${b.id === sel ? "sel" : ""}">
      <td class="n">${b.id}${b.mode ? '<span class="badge">mode</span>' : ""}</td>
      <td class="n">${b.machines.toLocaleString("en-US")}</td>
      <td class="n">${b.k}</td>
      <td><div class="chips">${b.makes.map(([k, v]) => `<span class="chip make ${k === mk ? "hit" : ""}">${esc(iname(k))} ${fmt(v)}</span>`).join("")}</div></td>
      <td><div class="chips">${b.draws.map(([k, v]) => `<span class="chip draw">${esc(iname(k))} ${fmt(v)}</span>`).join("")}</div></td></tr>`).join("");
    $("#rowCount").textContent = L.length.toLocaleString("en-US") + " blocks" + (L.length > shown.length ? " (first " + shown.length + " shown; filter or sort to see others)" : "");
    document.querySelectorAll("#btab th.sortable").forEach((th) => th.setAttribute("aria-sort", th.dataset.sort === sortKey ? (sortDir < 0 ? "descending" : "ascending") : "none"));
    side();
  }
  function side() {
    const host = $("#side");
    const b = sel && P.blocks[sel - 1];
    if (!b) { host.innerHTML = `<div class="side-empty">Select a block to see its machines.</div>`; return; }
    const recs = Object.entries(b.n).sort((x, y) => y[1] - x[1]);
    host.innerHTML = `<h2>Block ${b.id}${b.mode ? '<span class="badge">elementary mode</span>' : ""}</h2>
      <div class="meta">${b.machines.toLocaleString("en-US")} machines in ${recs.length} recipe${recs.length === 1 ? "" : "s"} · makes ${b.k} product${b.k === 1 ? "" : "s"}</div>
      <h3>Machines</h3><table>${recs.map(([r, c]) => `<tr><td>${esc(P.rid[r] ? P.rid[r].name : r)}<span class="rm">${esc(P.rid[r] ? D.machines[P.rid[r].m] || P.rid[r].m : "")}</span></td><td class="n">${c.toLocaleString("en-US")}</td></tr>`).join("")}</table>
      <h3>Net /min</h3><table>${b.makes.map(([k, v]) => `<tr><td>${esc(iname(k))}</td><td class="n pos">+${fmt(v)}</td></tr>`).join("")}${b.draws.map(([k, v]) => `<tr><td>${esc(iname(k))} <span class="rm">raw, ${fmt(-v / 30)} × 30</span></td><td class="n neg">−${fmt(-v)}</td></tr>`).join("")}</table>
      <p class="note">Every intermediate and fluid nets exactly 0.</p>`;
  }
  $("#bbody").addEventListener("click", (e) => { const tr = e.target.closest("tr"); if (!tr) return; sel = +tr.dataset.id; render(); });
  $("#btab thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = 1; }
    render();
  });
  ["#fMake", "#fRec", "#fK", "#fModes"].forEach((s) => $(s).addEventListener("change", render));
  $("#fK").addEventListener("input", render);
  $("#pools").innerHTML = D.pools.map((p, i) => `<button role="tab" type="button" data-i="${i}">${esc(p.title)} <small>(${p.blocks.length.toLocaleString("en-US")})</small></button>`).join("");
  $("#pools").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) choose(+b.dataset.i); });
  choose(0);
})();
