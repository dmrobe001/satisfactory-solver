// Command-line checks of the lattice-clock engine: node tools/test_lattice.js
const fs = require("fs");
const path = require("path");
const L = require("../src/lattice.js");
let fails = 0;
function eq(name, got, want) {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? "ok   " : "FAIL ") + name + ": got " + got + (ok ? "" : ", want " + want));
}
function truthy(name, v) { if (!v) fails++; console.log((v ? "ok   " : "FAIL ") + name); }

// A toy game: ore (mined) -> ingot -> plate; plates are a build material.
const toy = (extra = []) => ({
  items: { Ore: { n: "Ore", f: 0 }, Ingot: { n: "Ingot", f: 0 }, Plate: { n: "Plate", f: 0 }, Rod: { n: "Rod", f: 0 }, Power: { n: "Power", f: 0 } },
  buildings: { Wall: { n: "Wall", cost: [["Plate", 2], ["Rod", 1]] } },
  recipes: [
    { id: "Mine", kind: "miner", mc: 2.5, ins: [], outs: [["Ore", 60]] },
    { id: "Smelt", kind: "machine", mc: 2.5, ins: [["Ore", 30]], outs: [["Ingot", 30]] },
    { id: "Plate", kind: "machine", mc: 2.5, ins: [["Ingot", 30]], outs: [["Plate", 20]] },
  ].concat(extra),
});

{
  const lat = new L(toy());
  const S = lat.rIdx.Smelt, P = lat.rIdx.Plate;
  eq("toy: lattice dimension", lat.dim, 1);
  const e = lat.evaluate(new Map());
  // ingot balance: y_s = y_p; ore 30 y_s / 1e6 is a multiple of 15 -> y_s in 500 000 Z
  eq("toy: smelter step is 50%", L.fmtPct(e.rows[S].step), "50%");
  eq("toy: plate step is 50%", L.fmtPct(e.rows[P].step), "50%");
  eq("toy: smallest plate clock 50%", L.fmtPct(e.rows[P].smallest), "50%");
  const bad = lat.evaluate(new Map([[P, L.parsePct("70")]]));
  truthy("toy: 70% plate rejected (not a lattice point)", !bad.ok && bad.reason === "lattice");
  const good = lat.evaluate(new Map([[P, L.parsePct("350")]]));
  truthy("toy: 350% plate accepted", good.ok);
  eq("toy: smelter forced to 350%", L.fmtPct(good.rows[S].lo) + "/" + L.fmtPct(good.rows[S].hi), "350%/350%");
  // machine rule: 250.0001%... is not a multiple of 50% anyway; check the rule itself
  truthy("machine rule: 350% = 2 x 175%", L.machineOK(L.parsePct("350")));
  truthy("machine rule: 500.0001% = 3 x 166.6667%", L.machineOK(L.parsePct("500.0001")));
  truthy("machine rule: 500.0002% fails (3 machines, not a whole step each)", !L.machineOK(L.parsePct("500.0002")));
  truthy("machine rule: up to 250% anything goes", L.machineOK(L.parsePct("249.9999")));
}

{
  // A rod recipe also uses ingots, so plates can take any clock: the rods absorb the rest.
  const lat = new L(toy([{ id: "Rod", kind: "machine", mc: 2.5, ins: [["Ingot", 15]], outs: [["Rod", 15]] }]));
  const e = lat.evaluate(new Map());
  eq("toy+rod: plate step", L.fmtPct(e.rows[lat.rIdx.Plate].step), "0.0001%");
  eq("toy+rod: smelter step still 50%", L.fmtPct(e.rows[lat.rIdx.Smelt].step), "50%");
  // pin plate 100%: smelter >= 100% by the cone (ingots must come from it)
  const p = lat.evaluate(new Map([[lat.rIdx.Plate, L.parsePct("100")]]));
  eq("toy+rod: smelter lower bound 100%", L.fmtPct(p.rows[lat.rIdx.Smelt].lo), "100%");
  eq("toy+rod: smelter smallest 100%", L.fmtPct(p.rows[lat.rIdx.Smelt].smallest), "100%");
  // and pinning the smelter too fixes the rods: 2 x (150% - 100%) = 100%
  const q = lat.evaluate(new Map([[lat.rIdx.Plate, L.parsePct("100")], [lat.rIdx.Smelt, L.parsePct("150")]]));
  eq("toy+rod: rods forced to 100%", L.fmtPct(q.rows[lat.rIdx.Rod].lo) + "/" + L.fmtPct(q.rows[lat.rIdx.Rod].hi), "100%/100%");
}

{
  // A fixed-clock consumer (like the augmentor) takes whole machines only.
  const g = toy([{ id: "Fixed", kind: "augment", mc: 1, ins: [["Plate", 10]], outs: [] }]);
  g.buildings = {}; // plates are now internal: only Fixed consumes them
  const lat = new L(g);
  const e = lat.evaluate(new Map());
  eq("fixed: steps of 100%", L.fmtPct(e.rows[lat.rIdx.Fixed].step), "100%");
  // 1 fixed machine eats 10 plates/min = 50% of a plate constructor; ore = 15/min: fine
  eq("fixed: plate smallest 50%", L.fmtPct(e.rows[lat.rIdx.Plate].smallest), "50%");
}

{
  // Real data: every basis vector balances every internal item exactly and
  // draws raw resources in multiples of 15 per minute.
  const game = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/game.json")));
  const lat = new L(game);
  let worst = "";
  for (const b of lat.basis0) {
    lat.items.forEach((k, i) => {
      const c = lat.cls[k];
      if (c !== "internal" && c !== "raw") return;
      let num = 0n, den = 1n; // exact sum of rate * y / 1e6
      for (const [j, [p, q]] of lat.rates[i]) { const y = b.get(j) || 0n; if (!y) continue; num = num * q + p * y * den; den = den * q; }
      if (c === "internal" && num !== 0n) worst = k;
      if (c === "raw" && (num % (15n * 1000000n * den)) !== 0n) worst = k;
    });
  }
  truthy("real: every basis vector balances internal items and raw multiples of 15" + (worst ? " (" + worst + ")" : ""), !worst);
  const t0 = Date.now();
  const e = lat.evaluate(new Map());
  truthy("real: unpinned sheet is feasible", e.ok);
  truthy("real: Space Elevator parts cannot run (not build materials)", !e.rows[lat.rIdx.SpaceElevatorPart_1].run);
  truthy("real: Iron Plate can run", e.rows[lat.rIdx.IronPlate].run);
  truthy("real: evaluation under 2 s (" + (Date.now() - t0) + " ms)", Date.now() - t0 < 2000);
  const lat2 = new L(game, { overrides: { SpaceElevatorPart_1: "free" } });
  truthy("real: marking Smart Plating free lets it run", lat2.evaluate(new Map()).rows[lat2.rIdx.SpaceElevatorPart_1].run);
}

console.log(fails ? fails + " FAILED" : "all passed");
process.exit(fails ? 1 : 0);
