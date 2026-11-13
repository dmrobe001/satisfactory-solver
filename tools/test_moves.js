// Command-line checks of the machine-moves engine: node tools/test_moves.js
const fs = require("fs");
const path = require("path");
const Moves = require("../src/moves.js");
let fails = 0;
function truthy(name, v) { if (!v) fails++; console.log((v ? "ok   " : "FAIL ") + name); }
function eq(name, got, want) { const ok = got === want; if (!ok) fails++; console.log((ok ? "ok   " : "FAIL ") + name + ": got " + got + (ok ? "" : ", want " + want)); }

// Toy game: ore -> ingot (30 -> 30), ingot -> rod (15 -> 15), ingot -> plate (30 -> 20);
// rods are internal (must balance), plates are a building material, screws from rods.
const toy = {
  items: { Ore: { n: "Ore", f: 0 }, Ingot: { n: "Ingot", f: 0 }, Rod: { n: "Rod", f: 0 }, Plate: { n: "Plate", f: 0 },
           Screw: { n: "Screw", f: 0 }, Water: { n: "Water", f: 1 }, Power: { n: "Power", f: 0 } },
  buildings: { Wall: { n: "Wall", cost: [["Plate", 1], ["Screw", 1]] } },
  recipes: [
    { id: "Mine", name: "Mine", m: "Miner", kind: "miner", ins: [], outs: [["Ore", 60]], p: 5 },
    { id: "Smelt", name: "Smelt", m: "Smelter", kind: "machine", ins: [["Ore", 30]], outs: [["Ingot", 30]], p: 4 },
    { id: "Rod", name: "Rod", m: "Constructor", kind: "machine", ins: [["Ingot", 15]], outs: [["Rod", 15]], p: 4 },
    { id: "Plate", name: "Plate", m: "Constructor", kind: "machine", ins: [["Ingot", 30]], outs: [["Plate", 20]], p: 4 },
    { id: "Screw", name: "Screw", m: "Constructor", kind: "machine", ins: [["Rod", 10]], outs: [["Screw", 40]], p: 4 },
  ],
};
let E = new Moves(toy, { recipes: ["Smelt", "Rod", "Plate", "Screw"], lockP5: false });
eq("toy: ingot and rod balance, so 4 recipes - 2 rows = 2 moves", E.dim, 2);
truthy("toy: every move balances exactly", E.basis.every((b) => E.balanced(b.map(Number))));
// rods: 15 n_rod = 10 n_screw -> n_rod in steps of 2, n_screw in steps of 3
eq("toy: rod step", Number(E.steps[E.rIdx.Rod]), 2);
eq("toy: screw step", Number(E.steps[E.rIdx.Screw]), 3);
const s = E.snap([4.3, 2.1, 1.2, 3.4], new Map());
truthy("toy: snap is valid and exact", s.ok && E.balanced(s.n));
const net = E.netOf(s.n);
truthy("toy: ore only drawn, plates and screws not short", net[E.iIdx.Ore] <= 0 && net[E.iIdx.Plate] >= 0 && net[E.iIdx.Screw] >= 0);
// shrink smelters while keeping at least the plates we have
const pins = new Map([[E.iIdx.Plate, net[E.iIdx.Plate]]]);
const big = { n: [10, 4, 8, 6] }; // 300 ingots = 60 for rods + 240 for plates; 60 rods = 60 for screws
truthy("toy: start for shrink is exact", E.balanced(big.n));
const r = E.shrink(big.n, E.rIdx.Smelt, pins);
truthy("toy: shrink finds a smaller smelter count", r && r.n[E.rIdx.Smelt] < 10);
truthy("toy: shrink result exact and valid", r && E.balanced(r.n) && E.valid(r.n, pins));
// item step: screws come in steps of 3 machines x 40 = 120/min
const st = E.itemStep(E.iIdx.Screw);
eq("toy: screw net step", st && Number(st[0]) / Number(st[1]), 120);
// chain moves: Screw needs rods (must balance) -> rods need ingots -> smelters
{
  const ch = E.chainMoves(big.n, E.rIdx.Screw, new Map());
  truthy("toy: chain moves for screws exist and are exact", ch.length > 0 && ch.every((c) => E.balanced(c.vec)));
  truthy("toy: a screw chain includes rods and smelting", ch.some((c) => c.vec[E.rIdx.Rod] && c.vec[E.rIdx.Smelt]));
}
// valve: let rods pile up -> rod no longer constrains, steps drop to 1
E = new Moves(toy, { recipes: ["Smelt", "Rod", "Plate", "Screw"], lockP5: false, valves: { Rod: "surplus" } });
eq("toy: with a rod valve, ingots alone balance: 3 moves", E.dim, 3);
eq("toy: with a rod valve, screw step is 1", Number(E.steps[E.rIdx.Screw]), 1);
// clocks: plate at 50 % changes the ingot balance coefficients
E = new Moves(toy, { recipes: ["Smelt", "Rod", "Plate", "Screw"], lockP5: false, clocks: { Plate: "50" } });
truthy("toy: a 50 % clock still gives exact moves", E.basis.every((b) => E.balanced(b.map(Number))));
truthy("toy: clockFrac 19.2 = 24/125", String(Moves.clockFrac("19.2")) === "24,125");
truthy("toy: clockFrac rejects 5 decimals and > 250", Moves.clockFrac("12.34567") === null && Moves.clockFrac("251") === null);

// Real data: the optimizer plan is exact at its own clocks.
const G = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/game.json")));
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/optimized_plan.json"))).sheet;
const ids = Object.keys(plan.n).filter((id) => { const x = G.recipes.find((r) => r.id === id); return x && (x.kind === "machine" || x.kind === "burn"); });
const clocks = {};
for (const id of ids) clocks[id] = String(+((plan.c[id] || 1) * 100).toFixed(4));
const t0 = Date.now();
E = new Moves(G, { recipes: ids, clocks });
const ms = Date.now() - t0;
truthy("plan: moves built in under 2 s (" + ms + " ms, " + E.dim + " moves)", ms < 2000);
truthy("plan: every move balances exactly", E.basis.every((b) => E.balanced(b.map(Number))));
const n = E.R.map((r) => plan.n[r.id]);
truthy("plan: the optimizer plan is exact here (Phase 5 in proportion)", E.balanced(n));
truthy("plan: and valid", E.valid(n, new Map()));
const top = n.map((x, j) => [x, j]).sort((a, b) => b[0] - a[0])[0][1];
const p5 = new Map();
const pn = E.netOf(n);
for (const k of Object.keys(Moves.PHASE5)) if (E.iIdx[k] !== undefined) p5.set(E.iIdx[k], pn[E.iIdx[k]] - 1e-9);
const sh = E.shrink(n, top, p5);
truthy("plan: shrink of the largest recipe stays exact and keeps Phase 5", !sh || (E.balanced(sh.n) && E.valid(sh.n, p5)));

// raw steps: ore drawn in multiples of 60 -> smelters (30 ore each) come in even numbers
E = new Moves(toy, { recipes: ["Smelt", "Rod", "Plate", "Screw"], lockP5: false, rawStep: 60 });
truthy("toy: with a raw step of 60, every move keeps ore a multiple of 60", E.basis.every((b) => Number(b[E.rIdx.Smelt]) % 2 === 0) && E.dim === 2);
truthy("toy: balanced() checks the raw step", E.balanced([2, 0, 2, 0]) && !E.balanced([1, 0, 1, 0]));
// fixed recipes: no move changes them
E = new Moves(toy, { recipes: ["Smelt", "Rod", "Plate", "Screw"], lockP5: false, fixed: ["Plate"] });
truthy("toy: a fixed recipe is 0 in every move, one move fewer", E.dim === 1 && E.basis.every((b) => !b[E.rIdx.Plate]) && E.basis.every((b) => E.isMove(b.map(Number))));

// the start: Phase 5 fixed at one batch, raw draws in multiples of 30, every rule holds
{
  const S = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/moves_start.json")));
  const t1 = Date.now();
  const A = new Moves(G, { recipes: S.recipes, accumulate: S.rules.accumulate, rawStep: S.rules.rawStep, fixed: S.rules.fixed });
  truthy("start: engine built in under 3 s (" + (Date.now() - t1) + " ms, " + A.dim + " moves)", Date.now() - t1 < 3000);
  const n0 = A.R.map((r) => S.n[r.id] || 0);
  truthy("start: exact (net-0 items and raw multiples of 30) and valid", A.balanced(n0) && A.valid(n0, null));
  const net0 = A.netOf(n0);
  truthy("start: every raw draw is a multiple of 30", A.items.every((k, i) => A.cls[i] !== "raw" || Math.abs(net0[i] / 30 - Math.round(net0[i] / 30)) < 1e-6));
  eq("start: 192 AI Expansion Servers/min", Math.round(net0[A.iIdx.SpaceElevatorPart_12] * 1e6) / 1e6, 192);
  truthy("start: every move leaves the Phase 5 recipes alone", A.basis.every((b) => S.rules.fixed.every((id) => !b[A.rIdx[id]])));
  truthy("start: packaged fuel and batteries pile up, nuclear rods balance", A.cls[A.iIdx.Fuel] === "surplus" && A.cls[A.iIdx.Battery] === "surplus" &&
    (A.iIdx.NuclearFuelRod === undefined || A.cls[A.iIdx.NuclearFuelRod] === "balance"));
  const w = A.R.findIndex((r) => r.id === "Alternate_Wire_1");
  const ch = A.chainMoves(n0, w, null);
  truthy("start: Iron Wire chains are exact moves", ch.length > 0 && ch.every((c) => A.isMove(c.vec)));
  const wire = A.productChains(A.iIdx.Wire, n0);
  truthy("start: product chains for Wire are exact and raise Wire", wire.length > 0 && wire.every((c) => A.isMove(c.vec) && c.gain > 0));
}

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
