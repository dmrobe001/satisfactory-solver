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

// Chain: ore -> ingot -> plate, powered by coal.
for (const r of ["Miner2_Normal_OreIron", "IngotIron", "IronPlate", "Miner1_Normal_Coal",
                 "WaterExtractor", "Burn_Coal_GeneratorCoal"]) s.setClock(id(r), 1);
s.setFloor(id("IronPlate"), 60);
check("plates: 60/min at 20/min per constructor", s.n[id("IronPlate")], 3);
check("ingots: 90/min at 30 per smelter", s.n[id("IngotIron")], 3);
check("ore miners: 90/120", s.n[id("Miner2_Normal_OreIron")], 0.75);
check("iron plate net = floor", s.net(item("IronPlate")), 60);
const pw = s.power();
check("power balanced", pw.net, 0);
check("coal gens sized from demand", s.n[id("Burn_Coal_GeneratorCoal")], pw.demand / 75);
check("water extractor follows generators", s.n[id("WaterExtractor")], s.n[id("Burn_Coal_GeneratorCoal")] * 45 / 120);

// Halving the plate clock doubles constructors but keeps ingot demand.
s.setClock(id("IronPlate"), 0.5);
check("plates at 50% clock", s.n[id("IronPlate")], 6);
check("ingots unchanged", s.n[id("IngotIron")], 3);

// A second active ingot recipe blocks propagation: nothing upstream moves.
s.setClock(id("Alternate_IngotIron"), 1);
const before = s.n[id("IngotIron")];
s.setFloor(id("IronPlate"), 120);
check("two ingot producers: ingots not updated", s.n[id("IngotIron")], before);
console.log("ingot deficit flagged:", s.inDeficit(item("IronIngot")));
if (!s.inDeficit(item("IronIngot"))) fails++;

// Turning the recipe off removes its consumption again.
s.reset();
s.setClock(id("IngotIron"), 1); s.setClock(id("Miner1_Normal_OreIron"), 1);
s.setFloor(id("IngotIron"), 30); s.setClock(id("IngotIron"), 0);
check("disabled recipe frees its miners", s.n[id("Miner1_Normal_OreIron")], 0);

// Augmentor boost: 1 x 10% augmentor plus coal; generators shrink by 1/1.1.
s.reset();
s.setClock(id("Burn_Coal_GeneratorCoal"), 1); s.setFloor(id("Burn_Coal_GeneratorCoal"), 1100);
check("coal only: 1100/75 gens", s.n[id("Burn_Coal_GeneratorCoal")], 1100 / 75);

s.setCount(id("Augmenter10"), 1);
s.setFloor(id("Burn_Coal_GeneratorCoal"), 1100);
check("with augmentor: (1100/1.1 - 500)/75 gens", s.n[id("Burn_Coal_GeneratorCoal")], (1100 / 1.1 - 500) / 75);
check("net power = floor", s.net(s.P), 1100);

// A feedback loop (plastic <-> rubber alternates) still converges.
s.reset();
for (const r of ["Alternate_RecycledRubber", "Alternate_Plastic_1", "Rubber", "Plastic",
                 "OilExtractor_Normal", "WaterExtractor"]) s.setClock(id(r), 1);
s.setFloor(id("Alternate_RecycledRubber"), 100);
console.log("loop converged:", s.converged, "rubber net", s.net(item("Rubber")).toFixed(3));
if (!s.converged) fails++;
console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
