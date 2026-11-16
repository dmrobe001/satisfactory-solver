#!/usr/bin/env node
/* Command-line checks of the planner engine (src/planner.js) on data/recipe_set.json. */
const path = require("path");
const G = require(path.join(__dirname, "..", "data", "game.json"));
const SET = require(path.join(__dirname, "..", "data", "recipe_set.json"));
const P = require(path.join(__dirname, "..", "src", "planner.js")).create(G, SET);
let fails = 0;
const ok = (name, cond, got) => { console.log((cond ? "ok   " : "FAIL ") + name + (cond ? "" : ": got " + JSON.stringify(got))); if (!cond) fails++; };
const row = (res, id) => res.rows[P.rowIdx[id]];
const item = (res, k) => res.items.find((i) => i.key === k);
const exactOff = (res) => res.items.filter((i) => i.exact && Math.abs(i.net) > 1e-6).map((i) => i.key + " " + i.net);
const shortAuto = (res) => res.rows.filter((r) => r.short && r.role !== "set").map((r) => r.id);

const st0 = P.defaultState();
const r0 = P.solve(st0);
ok("start: settles", r0.settled, r0.settled);
ok("start: every fluid, raw resource and waste nets 0", exactOff(r0).length === 0, exactOff(r0));
ok("start: the given rows keep their machines and clocks",
  SET.start.every((s) => row(r0, s.id).role === "set" && row(r0, s.id).n === s.n && Math.abs(row(r0, s.id).clock - s.clock) < 1e-9), null);
ok("start: auto rows are whole machines at 100 %",
  r0.rows.every((r) => r.role !== "auto" || (Number.isInteger(r.n) && Math.abs(r.clock - 100) < 1e-9)), null);
ok("start: trims run at or below 100 % on the fewest machines",
  r0.rows.every((r) => r.role !== "trim" || (r.clock <= 100 + 1e-9 && r.n === Math.ceil(r.level - 1e-7))), r0.rows.filter((r) => r.role === "trim"));
ok("start: no auto row is short", shortAuto(r0).length === 0, shortAuto(r0));
ok("start: power covers the draw", r0.power.supply >= r0.power.draw - 1e-6, r0.power);
ok("start: Phase 5 takes 400 min", Math.abs(r0.T5 - 400) < 1e-6, r0.T5);
const p5 = Object.entries(SET.phase5).map(([k, q]) => item(r0, k).net / q);
ok("start: Phase 5 parts in exact proportion", p5.every((v) => Math.abs(v - p5[0]) < 1e-12), p5);
ok("start: Singularity Cell and Alien Power Matrix made exactly as used", ["SingularityCell", "AlienPowerFuel"].every((k) => Math.abs(item(r0, k).net) < 1e-9), null);
ok("start: 1.3125 power shards a minute spare (17 made, 15 to Alien Power Matrix, 0.6875 to Ionized Fuel)", Math.abs(item(r0, "CrystalShard").net - 1.3125) < 1e-9, item(r0, "CrystalShard").net);
const raw = (res, k) => item(res, k).made;
ok("start: the fuel cluster's fluids balance by its own numbers", ["LiquidFuel", "LiquidTurboFuel", "RocketFuel", "IonizedFuel", "HeavyOilResidue"].every((k) => Math.abs(item(r0, k).net) < 1e-9), null);
ok("start: sulfur drawn is exactly 650 /min, Sulfuric Acid trims to 5 at 88 %", Math.abs(raw(r0, "Sulfur") - 650) < 1e-9 && row(r0, "SulfuricAcid").n === 5 && Math.abs(row(r0, "SulfuricAcid").clock - 88) < 1e-9, [raw(r0, "Sulfur"), row(r0, "SulfuricAcid")]);
ok("start: alumina solution, aluminum scrap and aluminum ingots net exactly 0", ["AluminaSolution", "AluminumScrap", "AluminumIngot"].every((k) => Math.abs(item(r0, k).net) < 1e-9), null);
ok("start: the aluminum rows are whole machines at 100 % (16 Alumina Solution, 10 Electrode Scrap, 34 Aluminum Ingot)",
  [["AluminaSolution", 16], ["Alternate_ElectroAluminumScrap", 10], ["IngotAluminum", 34]].every(([id, n]) => row(r0, id).n === n && row(r0, id).clock === 100), null);
ok("start: bauxite drawn is exactly 1950 /min", Math.abs(raw(r0, "OreBauxite") - 1950) < 1e-9, raw(r0, "OreBauxite"));
ok("start: compacted coal is used up exactly", Math.abs(item(r0, "CompactedCoal").net) < 1e-9, item(r0, "CompactedCoal").net);
ok("start: copper ingots come from Copper Alloy Ingot only", r0.rows.filter((r) => r.main === "CopperIngot" && r.level > 0).map((r) => r.id).join() === "Alternate_CopperAlloyIngot", null);
ok("start: every clock in the table is one the game can set exactly", SET.start.every((s) => Number.isInteger(s.clock * 1e4)), null);
ok("start: nothing is short and nothing is unbalanced", r0.issues.length === 0 && r0.rows.every((r) => !r.short), r0.issues);
ok("start: all 31 geysers run", row(r0, "Geothermal").n === 31, row(r0, "Geothermal").n);
ok("start: the table's Dark Matter Residue and Photonic Matter numbers balance", ["DarkEnergy", "QuantumEnergy"].every((k) => Math.abs(item(r0, k).net) < 1e-6), null);

// one more Nuclear Pasta machine: upstream follows, fluids stay exact
const st1 = JSON.parse(JSON.stringify(st0));
st1.rows.SpaceElevatorPart_9 = { n: 8, clock: 90 };
st1.rows.PressureConversionCube = { n: 4, clock: 90 };
const r1 = P.solve(st1);
ok("more pasta: Copper Powder machines rise", row(r1, "CopperDust").n > row(r0, "CopperDust").n, [row(r0, "CopperDust").n, row(r1, "CopperDust").n]);
ok("more pasta: fluids still net 0", exactOff(r1).length === 0, exactOff(r1));
ok("more pasta: no auto row is short", shortAuto(r1).length === 0, shortAuto(r1));

// a set fluid maker that is too small is reported, not hidden
const st2 = JSON.parse(JSON.stringify(st0));
st2.rows.QuantumEnergy = { n: 4, clock: 84 };
const r2 = P.solve(st2);
ok("Photonic Matter set too low: reported as short", item(r2, "QuantumEnergy").status === "short" && r2.issues.some((i) => i.item === "QuantumEnergy"), item(r2, "QuantumEnergy"));
delete st2.rows.QuantumEnergy;
const r2b = P.solve(st2);
ok("Photonic Matter on auto: trimmed back to 5 at 84 %", row(r2b, "QuantumEnergy").role === "trim" && row(r2b, "QuantumEnergy").n === 5 && Math.abs(row(r2b, "QuantumEnergy").clock - 84) < 1e-6, row(r2b, "QuantumEnergy"));

// Dark Matter Residue: maker or sink takes the difference
const st3 = JSON.parse(JSON.stringify(st0));
delete st3.rows.DarkEnergy;
st3.rows.SuperpositionOscillator = { n: 6, clock: 100 };
st3.rows.Alternate_DarkMatter_Trap = { n: 0, clock: 100 };   // or the Trap, on auto, would take the residue to make crystals
const r3 = P.solve(st3);
ok("more residue than is used: the sink (Crystallization) trims it", row(r3, "Alternate_DarkMatter_Crystallization").role === "trim" && Math.abs(item(r3, "DarkEnergy").net) < 1e-6,
  [row(r3, "Alternate_DarkMatter_Crystallization"), item(r3, "DarkEnergy").net]);
st3.rows.SuperpositionOscillator = { n: 1, clock: 100 };
const r3b = P.solve(st3);
ok("less residue than is used: the maker (Dark Matter Residue) trims it", row(r3b, "DarkEnergy").role === "trim" && Math.abs(item(r3b, "DarkEnergy").net) < 1e-6,
  [row(r3b, "DarkEnergy"), item(r3b, "DarkEnergy").net]);

// a minimum net pulls its maker up
const st4 = JSON.parse(JSON.stringify(st0));
st4.min.Cable = 500;
const r4 = P.solve(st4);
ok("minimum net of Cable: its row grows and the net meets it", row(r4, "Cable").n > row(r0, "Cable").n && item(r4, "Cable").net >= 500 - 1e-6,
  [row(r4, "Cable").n, item(r4, "Cable").net]);

// exact-demand mode
const r5 = P.solve(Object.assign(JSON.parse(JSON.stringify(st0)), { lean: true }));
ok("exact demand: settles, fluids net 0, fewer machines", r5.settled && exactOff(r5).length === 0 && r5.machines < r0.machines, [r5.settled, exactOff(r5), r5.machines, r0.machines]);
ok("exact demand: power covers the draw", r5.power.supply >= r5.power.draw - 1e-6, r5.power);
ok("exact demand: rebuilds itself within the Phase 5 time", r5.Trebuild <= r5.T * (1 + 1e-6), [r5.Trebuild, r5.T]);

console.log(fails ? fails + " failed" : "all passed");
process.exit(fails ? 1 : 0);
