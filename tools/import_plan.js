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
// Only the old plan's recipe counts and clocks are used ("needs", "plan" and
// "ban" are ignored).  A floor is a net production the user chooses, so the
// only floors set here are for end products, items nothing in the sheet
// consumes: their floor is what the plan's count and clock make, so they keep
// their machines.  Everything that is consumed is re-sized to its consumers:
// driven recipes by propagation, and items with several running producers
// (which cannot propagate) by scaling those producers, keeping their ratio.
// Counts are rounded up to whole machines at the end.
const fs = require("fs");
const path = require("path");
const Solver = require("../src/solver.js");

const ROOT = path.join(__dirname, "..");
const game = JSON.parse(fs.readFileSync(path.join(ROOT, "data/game.json")));
const oldPath = process.argv[2] || path.join(ROOT, "data/old_plan_factory_ledger.json");
const old = JSON.parse(fs.readFileSync(oldPath));
const S = new Solver(game);
S.integer = false; // balance with fractional counts, round up at the end
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
for (const [id, c] of Object.entries(clocks)) if (c > 0) sheet.c[id] = c;
for (const [id, n] of Object.entries(counts)) if (sheet.c[id]) sheet.n[id] = n;
Object.assign(sheet.n, manual);
S.load(sheet);

// Floors: end products keep what the plan makes of them.
const floors = {};
for (const r of S.R.map((_, i) => i)) {
  if (!S.isActive(r) || !S.hasFloor(r)) continue;
  const k = S.outs[r][0][0];
  if (S.consumersOf[k].some((q) => S.isActive(q))) continue;
  const net = S.net(k);
  if (net > 1e-6) { S.f[r] = Math.round(net * 1e4) / 1e4; floors[S.itemKeys[k]] = S.f[r]; }
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

// ---- whole machines -------------------------------------------------------
// Round every count up, re-size the driven recipes top-down (size() now
// rounds up), then raise multi-producer items that rounding left short.
S.integer = true;
for (const r of order) if (!S.manual[r]) S.setN(r, S.whole(S.n[r]));
sweep(); sweep();
for (let i = 0; i < 100; i++) {
  let moved = false;
  for (let k = 0; k < S.itemKeys.length; k++) {
    if (!S.inDeficit(k)) continue;
    const prods = S.primaryOf[k].filter((r) => S.isActive(r) && !S.manual[r]);
    if (!prods.length) continue;
    const gap = S.target(k) - S.net(k);
    let made = 0;
    for (const r of prods) made += S.n[r] * S.outs[r][0][1] * S.c[r] * S.mult(k);
    const scale = made > 0 ? (made + gap) / made : 1;
    for (const r of prods) {
      const nn = made > 0 ? S.whole(S.n[r] * scale) : S.whole(gap / (S.outs[r][0][1] * S.c[r] * S.mult(k)));
      if (nn > S.n[r]) { S.setN(r, nn); S.propagate(r); moved = true; }
    }
  }
  if (!moved) break;
  sweep();
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
console.log("\nend-product floors (item: floor, net now):");
for (const [key, f] of Object.entries(floors)) {
  const k = S.itemIdx[key];
  console.log("  " + nm(k).padEnd(34), String(f).padStart(10), S.net(k).toFixed(3).padStart(10));
}
