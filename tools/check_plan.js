// Independent check of an optimizer plan with the production sheet's own code:
//   node tools/check_plan.js [data/optimized_plan.json]
// Loads the plan into SatSolver, bills buildings with SatBuildings.compute (the
// sheet's rules, with the plan's settings), and reports, per item, net production
// against what the bill of materials, the equipment list and Phase 5 need over T.
const fs = require("fs");
const path = require("path");
const Solver = require("../src/solver.js");
const SB = require("../src/buildings.js");
const game = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/game.json")));
const plan = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, "../data/optimized_plan.json")));
const S = new Solver(game);
S.load(plan.sheet);
const settings = SB.normalize(plan.settings);
const b = SB.compute(S, game, settings);
const opt = plan.optimizer;
const T = opt.T_min;
const want = new Float64Array(S.itemKeys.length);
for (let k = 0; k < want.length; k++) want[k] = b.bom[k];
for (const [k, q] of Object.entries(opt.equipment)) want[S.itemIdx[k]] += q;
for (const [k, q] of Object.entries(opt.phase5)) want[S.itemIdx[k]] += q;
const gathered = new Set(game.recipes.filter((r) => r.kind === "gather").flatMap((r) => r.outs.map(([k]) => k)));
let worst = 0, worstK = null, fails = 0;
const rows = [];
for (let k = 0; k < want.length; k++) {
  if (k === S.P) continue;
  const net = S.net(k), key = S.itemKeys[k];
  if (want[k] > 0 && !gathered.has(key)) {
    const t = net > 0 ? want[k] / net : Infinity;
    rows.push([t, game.items[key].n, want[k], net]);
    if (t > worst) { worst = t; worstK = game.items[key].n; }
  } else if (want[k] <= 0 && Math.abs(net) > 1e-6 * Math.max(1, S.prod[k]) && !(net < 0 && S.producersOf[k].every((r) => S.R[r].kind !== "machine" || !S.n[r]) && S.prod[k] === 0)) {
    // raw resources: draw may be below miner capacity (miners back up), never above
    const raw = S.producersOf[k].some((r) => ["miner", "extractor", "well"].includes(S.R[r].kind));
    if (!(raw && net >= 0)) { fails++; console.log("FAIL unbalanced " + game.items[key].n + ": net " + net); }
  }
}
rows.sort((a, c) => c[0] - a[0]);
console.log("slowest items (minutes to make what is needed):");
for (const [t, n, w, net] of rows.slice(0, 8)) console.log("  " + n.padEnd(32) + t.toFixed(1).padStart(8) + "   need " + w.toFixed(0) + ", net " + net.toFixed(3) + "/min");
const fullPower = S.R.reduce((a, r, i) => a + (S.n[i] && r.p > 0 && r.kind === "machine" ? S.n[i] * r.p : 0), 0);
const pw = S.power();
console.log("T from the sheet's code: " + worst.toFixed(1) + " min (" + worstK + "); optimizer said " + T.toFixed(1));
console.log("power: made " + pw.supply.toFixed(0) + " MW; drawn " + pw.demand.toFixed(0) + " MW by the sheet's clock^1.32 rule; production machines at full power " + fullPower.toFixed(0) + " MW");
console.log("buildings billed: " + Object.values(b.total).reduce((a, x) => a + x, 0) + " (" + b.machines + " machines)");
if (Math.abs(worst - T) > 1e-3 * T) { fails++; console.log("FAIL T differs"); }
console.log(fails ? fails + " problem(s)" : "ok");
process.exit(fails ? 1 : 0);
