// Second stage of tools/moves_start.py: move the whole-machine seed (raw draws
// free) onto the full rules (raw draws in multiples of rawStep), exactly.
//   1. a particular whole-machine solution x0 with the Phase 5 recipes at the
//      seed's counts (column reduction with one extra unknown);
//   2. Babai's nearest plane: the moves m nearest to seed - x0, so x0 + m is
//      the lattice point next to the seed;
//   3. greedy repair with single and paired moves until nothing is negative.
// Usage: node tools/moves_snap.js data/moves_start.json   (rewrites its "n")
const fs = require("fs");
const path = require("path");
const Moves = require("../src/moves.js");
const G = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/game.json")));
const file = process.argv[2];
const S = JSON.parse(fs.readFileSync(file));
const R = S.rules;
const E = new Moves(G, { recipes: S.recipes, accumulate: R.accumulate, rawStep: R.rawStep, fixed: R.fixed });
const vals = {};
for (const id of R.fixed) vals[id] = S.seed[id] || 0;
const x0 = E.particular(vals);
if (!x0) { console.error("no whole-machine solution with these Phase 5 counts"); process.exit(1); }
const t = E.R.map((r) => S.seed[r.id] || 0);
const m = E.babai(t.map((v, j) => v - x0[j]));
const rep = E.repair(x0.map((v, j) => v + m[j]), null, 20000);
const n = rep.n;
const ok = rep.ok && E.balanced(n) && R.fixed.every((id) => n[E.rIdx[id]] === vals[id]);
const tot = (a) => a.reduce((x, y) => x + y, 0);
console.log("seed %d machines -> %d (%s)", tot(t), tot(n), ok ? "exact and valid" : "not valid: " + JSON.stringify(rep.left.slice(0, 4)));
if (!ok) process.exit(1);
S.n = Object.fromEntries(E.R.map((r, j) => [r.id, n[j]]).filter((x) => x[1]));
fs.writeFileSync(file, JSON.stringify(S, null, 1));
