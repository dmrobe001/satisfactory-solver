// Build the page's default sheet (data/default_plan.json) from a plan
// exported by the older "factory ledger" tool.
//
//   node tools/import_plan.js [data/old_plan_factory_ledger.json]
//
// What is kept from the old plan: which recipes run, their clocks, and the
// machine counts of the recipes nothing else drives (end products, recipes
// that share an output with another running recipe, generators).  Every
// recipe that is the only running producer of something another running
// recipe consumes is re-sized by the solver, layer by layer from the top.
// Extraction is replaced by the defaults below.
//
// The old plan's "needs" become floors (except Alien Power Matrix and
// Singularity Cells, which the augmentor and portal recipes now consume).
// Items with several running producers cannot propagate, so a balancing pass
// scales those producers (keeping their ratio) until net production meets
// the floor.  Finally each running recipe's floor is set to the net
// production of its first output, so the sheet reproduces itself when a
// clock is changed later.
const fs = require("fs");
const path = require("path");
const Solver = require("../src/solver.js");

const ROOT = path.join(__dirname, "..");
const game = JSON.parse(fs.readFileSync(path.join(ROOT, "data/game.json")));
const oldPath = process.argv[2] || path.join(ROOT, "data/old_plan_factory_ledger.json");
const old = JSON.parse(fs.readFileSync(oldPath));
const S = new Solver(game);
const idx = (id) => S.rIdx[id];

// ---- defaults that replace the old plan's extraction --------------------
const clocks = {};   // recipe id -> clock
const counts = {};   // recipe id -> machines from the old plan
for (const rec of game.recipes) {
  if (rec.kind === "miner") clocks[rec.id] = /^Miner3_Pure_/.test(rec.id) ? 2.5 : 0;
}
clocks.OilExtractor_Pure = 2.5;
clocks.WaterExtractor = 2.5;
// Pure resource wells: only nitrogen.  Water and crude oil already have a
// running extractor; a second running producer would stop propagation.
clocks.Well_Pure_NitrogenGas = 1;
const manual = { Augmenter30: 1, MainPortal: 1, WellPressurizer: 1 };
// Producers the old plan was missing (it consumed these with no source).
const added = { Alternate_EnrichedCoal: 1, DarkEnergy: 1 };
// Needs that the new tool models as consumption instead of floors.
const NOT_FLOORS = new Set(["AlienPowerFuel", "SingularityCell"]);

// ---- recipes and clocks from the old plan --------------------------------
const skipped = [];
for (const x of old.recs) {
  let id = null;
  if (x.r.startsWith("Recipe_")) id = x.r.slice(7, -2);
  else if (x.r.startsWith("gen:")) {
    const [, g, f] = x.r.split(":");
    id = `Burn_${f.slice(5, -2)}_${g.slice(5, -2)}`;
  } else { skipped.push(x.r); continue; } // mine:, oil:, water:, frack:, pressurize:
  if (idx(id) === undefined) { skipped.push(x.r); continue; }
  clocks[id] = x.c;
  counts[id] = x.n;
}

// ---- load: clocks, manual counts, old counts everywhere -----------------
const sheet = { c: {}, f: {}, n: {} };
Object.assign(clocks, added);
for (const [id, c] of Object.entries(clocks)) if (c > 0) sheet.c[id] = c;
for (const [id, n] of Object.entries(counts)) if (sheet.c[id]) sheet.n[id] = n;
Object.assign(sheet.n, manual);
S.load(sheet);

// Floors from the old plan's needs.
const short = (cls) => cls.replace(/^(Desc_|BP_)/, "").replace(/_C$/, "");
for (const nd of old.opt.needs) {
  const key = short(nd.it);
  const k = S.itemIdx[key];
  if (k === undefined || NOT_FLOORS.has(key)) continue;
  for (const r of S.primaryOf[k]) if (S.isActive(r)) S.f[r] = nd.v;
}

// Driven recipes (sole running producer of a consumed first output) start
// at zero and are filled in by propagation.
const driven = (r) => {
  const k = S.outs[r][0] && S.outs[r][0][0];
  if (k === undefined) return false;
  const act = S.activeProducers(k);
  return act.length === 1 && act[0] === r && S.consumersOf[k].some((q) => q !== r && S.isActive(q));
};
const order = S.R.map((_, r) => r).filter((r) => S.isActive(r)).sort((a, b) => S.R[b].layer - S.R[a].layer);
for (const r of order) if (driven(r)) S.setN(r, 0);
// Propagate from the top layer down, re-sizing every recipe on the way so
// floors take effect.
function sweep() {
  for (const r of order) {
    if (!S.manual[r] && (driven(r) || S.f[r] > 0) && S.activeProducers(S.outs[r][0][0]).length === 1) S.setN(r, S.size(r));
    S.propagate(r);
  }
}
sweep(); sweep();

// Balance items with several running producers: scale the producers whose
// first output is that item and that are not themselves driven by a
// by-product, keeping their ratio.
const drivenAny = (r) => S.outs[r].some(([k], j) => {
  const act = S.activeProducers(k);
  return act.length === 1 && act[0] === r && S.consumersOf[k].some((q) => q !== r && S.isActive(q));
});
let rounds = 0;
function balance() {
for (let i = 0; i < 200; i++, rounds++) {
  let moved = false;
  for (let k = 0; k < S.itemKeys.length; k++) {
    const prods = S.primaryOf[k].filter((r) => S.isActive(r) && !S.manual[r] && !drivenAny(r));
    if (!prods.length) continue;
    if (S.activeProducers(k).length < 2 && !S.inDeficit(k)) continue;
    const gap = S.target(k) - S.net(k);
    if (Math.abs(gap) <= 1e-9 * Math.max(1, S.cons[k])) continue;
    let made = 0;
    for (const r of prods) made += S.n[r] * S.outs[r][0][1] * S.c[r] * S.mult(k);
    if (made <= 0) {
      if (gap > 0) { const r = prods[0]; S.setN(r, gap / (S.outs[r][0][1] * S.c[r] * S.mult(k))); S.propagate(r); moved = true; }
      continue;
    }
    const scale = Math.max(0, (made + gap) / made);
    for (const r of prods) { S.setN(r, S.n[r] * scale); S.propagate(r); }
    moved = true;
  }
  if (!moved) break;
}
}
for (let i = 0; i < 5; i++) { balance(); sweep(); }
// Drop added producers that ended up unused.
for (const id of Object.keys(added)) {
  const r = idx(id);
  if (S.n[r] < 1e-9) { S.setClock(r, 0); S.f[r] = 0; }
}

// ---- floors: lock in the surplus each running recipe now makes ----------
for (const r of order) {
  const k = S.outs[r][0] && S.outs[r][0][0];
  if (k === undefined || k === S.P) continue;
  const net = S.net(k);
  if (net > 1e-6) S.f[r] = Math.round(net * 1e4) / 1e4;
}

const out = S.dump();
fs.writeFileSync(path.join(ROOT, "data/default_plan.json"), JSON.stringify(out, null, 1));

// ---- report ---------------------------------------------------------------
const nm = (k) => game.items[S.itemKeys[k]].n;
console.log("balancing rounds:", rounds);
console.log("skipped old entries (replaced by defaults):", skipped.join(", "));
console.log("\nrecipe                                    old n  ->  new n   clock");
for (const r of order) {
  const id = S.R[r].id;
  const o = counts[id];
  console.log(S.R[r].name.padEnd(42), String(o === undefined ? "-" : o).padStart(6), " -> ", S.n[r].toFixed(2).padStart(7), "  ", (S.c[r] * 100).toFixed(1) + "%");
}
const pw = S.power();
console.log(`\npower: supply ${pw.supply.toFixed(0)} MW, demand ${pw.demand.toFixed(0)} MW, net ${pw.net.toFixed(0)}`);
console.log("items in deficit:");
for (let k = 0; k < S.itemKeys.length; k++) if (S.inDeficit(k)) console.log("  ", nm(k), "net", S.net(k).toFixed(3));
console.log("\nold 'needs' vs new net production:");
for (const nd of old.opt.needs) {
  const k = S.itemIdx[nd.it.replace(/^(Desc_|BP_)/, "").replace(/_C$/, "")];
  if (k === undefined) { console.log("  ?", nd.it); continue; }
  const net = S.net(k);
  const flag = net < nd.v - 1e-6 ? "  SHORT" : "";
  console.log("  " + nm(k).padEnd(34), String(nd.v).padStart(8), net.toFixed(3).padStart(10) + flag);
}
