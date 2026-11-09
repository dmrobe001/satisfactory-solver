// Command-line checks of the solver: node tools/test_solver.js
const fs = require("fs");
const path = require("path");
const Solver = require("../src/solver.js");
const game = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/game.json")));
const s = new Solver(game);
const id = (x) => { const r = s.rIdx[x]; if (r === undefined) throw new Error("no recipe " + x); return r; };
const item = (x) => s.itemIdx[x];
let fails = 0;
function check(name, got, want, tol = 1e-6) {
  const ok = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  if (!ok) fails++;
  console.log((ok ? "ok   " : "FAIL ") + name + ": got " + got + (ok ? "" : ", want " + want));
}
function truthy(name, v) { if (!v) fails++; console.log((v ? "ok   " : "FAIL ") + name); }

// Chain: ore -> ingot -> plate, powered by coal.
for (const r of ["Miner2_Normal_OreIron", "IngotIron", "IronPlate", "Miner1_Normal_Coal",
                 "WaterExtractor", "Burn_Coal_GeneratorCoal"]) s.setClock(id(r), 1);
s.setFloor(id("IronPlate"), 60);
check("plates: 60/min at 20/min per constructor", s.n[id("IronPlate")], 3);
check("ingots: 90/min at 30 per smelter", s.n[id("IngotIron")], 3);
check("ore miners: 90/120 rounds up to 1", s.n[id("Miner2_Normal_OreIron")], 1);
check("iron plate net = floor", s.net(item("IronPlate")), 60);
const pw = s.power();
truthy("power covered", pw.net >= 0 && !pw.deficit);
check("coal gens: whole number covering demand", s.n[id("Burn_Coal_GeneratorCoal")], Math.ceil(pw.demand / 75 - 1e-6));
truthy("every count is whole", Array.from(s.n).every((x) => x === Math.round(x)));

// Halving the plate clock doubles constructors but keeps ingot demand.
s.setClock(id("IronPlate"), 0.5);
check("plates at 50% clock", s.n[id("IronPlate")], 6);
check("ingots unchanged", s.n[id("IngotIron")], 3);

// A typed count is rounded to a whole machine and pushes upstream.
s.setCount(id("IronPlate"), 7.4);
check("typed 7.4 plates -> 8", s.n[id("IronPlate")], 8);
check("ingots follow typed count: 8 x 15/min / 30 -> 4", s.n[id("IngotIron")], 4);

// A second active ingot recipe blocks propagation: nothing upstream moves.
s.setCount(id("IronPlate"), 6);
s.setClock(id("Alternate_IngotIron"), 1);
const before = s.n[id("IngotIron")];
s.setFloor(id("IronPlate"), 120);
check("two ingot producers: ingots not updated", s.n[id("IngotIron")], before);
truthy("ingot deficit flagged", s.inDeficit(item("IronIngot")));

// Generators take no floor.
s.setFloor(id("Burn_Coal_GeneratorCoal"), 1000);
check("generator floor ignored", s.f[id("Burn_Coal_GeneratorCoal")], 0);

// Turning the recipe off removes its consumption again.
s.reset();
s.setClock(id("IngotIron"), 1); s.setClock(id("Miner1_Normal_OreIron"), 1);
s.setFloor(id("IngotIron"), 30); s.setClock(id("IngotIron"), 0);
check("disabled recipe frees its miners", s.n[id("Miner1_Normal_OreIron")], 0);

// Augmentor boost: 1 x 10% augmentor plus coal generators against a fixed
// 1000 MW demand (4 Main Portals).
s.reset();
s.setClock(id("Burn_Coal_GeneratorCoal"), 1);
s.setCount(id("Augmenter10"), 1);
s.setCount(id("MainPortal"), 4);
s.setClock(id("Burn_Coal_GeneratorCoal"), 1); // re-size now that demand exists
const p2 = s.power();
const want = Math.ceil((1000 / 1.1 - 500) / 75 - 1e-6);
check("with augmentor: ceil((demand/1.1 - 500)/75) gens", s.n[id("Burn_Coal_GeneratorCoal")], want);
truthy("net power >= 0", p2.net >= -1e-6);

// A feedback loop (plastic <-> rubber alternates) still converges.
s.reset();
for (const r of ["Alternate_RecycledRubber", "Alternate_Plastic_1", "Rubber", "Plastic",
                 "OilExtractor_Normal", "WaterExtractor"]) s.setClock(id(r), 1);
s.setFloor(id("Alternate_RecycledRubber"), 100);
truthy("loop converged (rubber net " + s.net(item("Rubber")).toFixed(3) + ")", s.converged);

// The default plan loads without deficits.
s.reset();
s.load(JSON.parse(fs.readFileSync(path.join(__dirname, "../data/default_plan.json"))));
const def = s.itemKeys.filter((k, i) => s.inDeficit(i));
truthy("default plan has no deficits " + JSON.stringify(def), def.length === 0);

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
