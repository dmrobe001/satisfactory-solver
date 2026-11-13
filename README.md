# Satisfactory Production Sheet

A one-page tool for planning factories in Satisfactory 1.0. It lists every
recipe in the game, plus synthetic "recipes" for miners, extractors,
generators, the Alien Power Augmentor and the Main Portal. You set clock
speeds and production adjustments; machine counts, power, lanes, buildings and
the bill of materials follow.

The finished page is `dist/satisfactory-sheet.html` (a single self-contained
file; open it in a browser, or publish it as a claude.ai artifact). Sheets
import from and export to `.json` files; export uses the artifact `downloads`
capability, so the button only appears on claude.ai.

## Layout

| Path | What it is |
| --- | --- |
| `tools/build_data.py` | Downloads the community game data and writes `data/game.json`. Hand-entered constants (miner rates, geothermal, augmentor, nuclear waste) live at the top. |
| `data/game.json` | Compact recipe/item/building data the page uses. |
| `src/solver.js` | The update rules, no DOM. Runs in node and in the browser. |
| `src/app.js`, `src/style.css`, `src/index.html` | The page. |
| `tools/build.py` | Inlines everything into `dist/satisfactory-sheet.html`, `dist/lattice-clocks.html` and `dist/recipe-matrix.html`. |
| `tools/test_solver.js` | Command-line checks of the solver. |
| `src/lattice.js`, `src/lattice_app.js`, `src/lattice.css`, `src/lattice.html` | The second page, lattice clocks (engine, page script, styles, page). |
| `tools/test_lattice.js` | Command-line checks of the lattice engine. |
| `src/buildings.js` | Building counts and bill of materials (support-building rules, lanes, extras), shared by the production sheet and the recipe matrix. |
| `src/matrix_app.js`, `src/matrix.css`, `src/matrix.html` | The third page, recipe matrix. |
| `tools/optimize.py` | Optimizer: the fastest self-building factory for Phase 5 (needs `pip install numpy highspy`). Writes `data/optimized_plan.json`. |
| `tools/check_plan.js` | Re-checks an optimizer plan with the production sheet's own solver and bill-of-materials code. |
| `src/moves.js`, `src/moves_app.js`, `src/moves.css`, `src/moves.html` | The fourth page, machine moves (engine, page script, styles, page). |
| `tools/test_moves.js` | Command-line checks of the machine-moves engine. |
| `tools/moves_start.py` | The machine-moves page's item rules and default start: fewest whole machines (all at 100 %) for one exact Phase 5 batch, raw draws in multiples of 30. Writes `data/moves_start.json`. |
| `tools/tiers.py` | Unlock tier of every recipe and item (for sorting). Writes `data/tiers.json`. |
| `tools/clean_clocks.py` | Is there a recipe combination with clean clock totals (denominators up to 125)? Integer program, verified exactly. |
| `tools/import_plan.js` | Turns a plan exported from the older "factory ledger" tool (`data/old_plan_factory_ledger.json`) into the page's default sheet, `data/default_plan.json`. |

## Rebuild

```sh
python3 tools/build_data.py --fetch   # only when the game data changes
node tools/import_plan.js             # re-derive the default sheet
python3 tools/build.py
node tools/test_solver.js
node tools/test_lattice.js
node tools/test_moves.js
```

## Update rules

* A recipe runs when its clock is above 0%.
* Machine counts are whole numbers. Editing a recipe's clock or adjustment
  re-sizes it to the fewest machines that cover its first output's target:
  the consumption by the running recipes, plus the build need, plus the
  adjustment. Any recipe's count can also
  be typed in; its suppliers follow.
* Then each input of that recipe (power included) is checked. If exactly one
  running recipe produces it, that producer is re-sized the same way, and the
  check repeats from there (a worklist that stops when nothing changes, or
  after 20 000 steps in a runaway feedback loop).
* If two or more running recipes produce an input, the one with its
  Flexible box ticked is re-sized instead. With no flexible producer, or
  several, none is touched. Deficits show as yellow on the consumers' inputs
  and red on the producers' outputs. A power deficit marks every running
  generator red. Ticking Flexible re-sizes that recipe at once.
* The adjustment is extra net production wanted beyond consumers and build
  need; it may be negative (accept a shortfall supplied elsewhere). Generators
  have none; they follow power demand. When several running recipes share an
  output, the largest adjustment applies.
* Build need (bill of materials ÷ build time) depends on the buildings, which
  depend on machine counts. After every edit the sheet hands the build need to
  the solver, which re-sizes each changed item's designated producer, and
  repeats (up to 20 rounds) until the build need stops changing. A by-product also drives
  sizing when its recipe is the item's designated producer (the only running
  producer, or the only flexible one among several).
* Surplus machines (on every running recipe with outputs) = machine count
  minus the fractional count needed to meet the first output's target, with
  the other producers held fixed: (net − target) / net output per machine.
  Negative means the item is short.
* Orange: a build material is short of its target (shown with red/yellow;
  the item's status reads "build need short" when only the build need is
  uncovered).

## Data and assumptions

Recipe data is the game's Docs.json as extracted by
[SatisfactoryTools](https://github.com/greeny/SatisfactoryTools) (`data/data1.0.json`).
Buildables added in updates 1.1 and 1.2 (Personnel Elevator, Buffer Stop,
Priority Merger, Conveyor Wall Hole and Throughput Monitor, Hypertube
Junction/Branch, new beams, Roll-Up Gates, Corner Road Barrier, Basic Shelf
Unit, Large Fan/Vent, Fluid Truck and Station, SPWN, Pipeline T-Junction,
walkways, vehicle paths, FICSMAS pieces) come from the Official Satisfactory
Wiki's copy of the current game data (`Template:DocsRecipes.json` and friends
on satisfactory.wiki.gg). Comparing the two sources, 1.1 and 1.2 changed no
existing production recipe or build cost.

FICSMAS (the seasonal event) is included behind a toggle: its 15 crafting
recipes, a hand-gathered FICSMAS Gift source and its buildables. A recipe or
building counts as FICSMAS if it touches an item made by the wiki's
"ficsmas"-season recipes (or the Gift). With the toggle off they are hidden
and contribute nothing, including the ordinary materials they would use.
Numbers entered by hand, worth checking if something looks off:

* Miners Mk.1/2/3: 60/120/240 per minute on a normal node; impure ×0.5, pure ×2.
* Water extractor 120 m³/min; oil extractor 120 m³/min normal; resource well
  satellite 60 m³/min normal (pressurizer 150 MW, entered by count).
* Geothermal average 100/200/400 MW (impure/normal/pure), fixed clock.
* Nuclear waste: 50 per uranium rod, 10 per plutonium rod, none for ficsonium.
* Alien Power Augmentor: +500 MW and +10% of grid production; +30% when fed
  5 Alien Power Matrix/min. Boosts add up and multiply all generated power.
  (The matrix rate and the stacking rule are from community sources, not the
  game files.)
* Main Portal: 250 MW from the game files, plus 2 Singularity Cells/min.
* Consumer power scales with clock^1.321929; generator output linearly.
* Architecture build costs. The extracted recipes hold only each piece's base
  cost; in 1.0 the Customizer material adds its own. From the wiki's
  Foundations, Walls and Roofs pages, every size and shape in a set costs:
  * foundations, ramps, quarter pipes, foundation stairs: 5 Concrete plus
    FICSIT 2 Iron Plate, Grip Metal 2 Steel Beam, Coated Concrete 2 Plastic,
    Concrete or Asphalt 2 Concrete;
  * walls: 2 Concrete (windows 2 Silica) plus FICSIT 2 Iron Plate, Steel
    2 Steel Beam, Concrete 2 Concrete (frame windows already include theirs);
  * roofs: 3 Concrete plus FICSIT 2 Iron Plate, Tar 2 Concrete, Metal 2 Steel
    Beam, Glass 2 Silica. `Roof_A_*` are the Metal set's straight pieces
    (labelled FICSIT in the data).
  * Added by hand: Stairs Left/Right (5 Concrete, 4 Iron Plate) and the 2 m
    and 4 m Coated Concrete foundations, which the data lacks.

## Computed buildings

Besides the machines themselves, the Buildings tab bills support buildings as
rate × basis, rounded up per building. Every rate is editable under Settings.
The defaults:

| Basis | Buildings per unit of basis |
|---|---|
| running machine (extractors and generators included, hand gathering not) | 2 each of FICSIT, Steel (Metal), Asphalt and Coated (Polished) 1 m foundations; 2 each of FICSIT, Steel and Concrete 4 m walls; 1 each of FICSIT, Metal, Tar and Window flat roofs; 1 ladder; 1 hypertube; 2 power line; 0.5 Power Pole Mk.1; 0.05 power tower |
| computed conveyor belt (all marks) | 1/25 conveyor pole |
| solid input lane (recipe × machines) | 1 splitter |
| solid output lane | 1 merger |
| fluid lane (input or output) | 1 pipeline T-junction |
| solid item type made or used | 1 industrial storage container, 1 smart splitter |
| fluid type made or used | 1 industrial fluid buffer |
| depot item | 1 dimensional depot uploader |
| computed pipeline, per mark | 1/100 pump of the same mark |

A depot item is any item in the bill of materials, plus any expendable the
sheet makes (ammo, rebar, Nobelisks, gas filters, portable fuels, batteries).
Because uploaders add their own materials to the bill, the count is iterated
twice.

Default extras (editable on the Buildings tab): 100 ceiling lights, 100
wall-mounted flood lights, 3 Blueprint Designer Mk.3, 100 label signs (4 m),
100 square signs (2 m), 20 block signals, 20 AWESOME Sinks, 1 AWESOME Shop,
200 catwalk intersections, 10 drones, 10 drone ports, 10 electric locomotives,
50 freight cars, 30 freight platforms, 10 large billboards, 20 radar towers,
3 personnel elevators, 15 elevator floor stops, 20 satellite portals.
Sheets saved before this calibration get the new rates, and the default extras
under any extras they already had.

## Default sheet

`tools/import_plan.js` builds the default from the old plan:

* Recipes and clocks come from the old plan's `recs`. Machine counts are kept
  only where nothing else decides them (end products, generators, items made
  by two or more running recipes); every recipe that is the only running
  producer of a consumed item is re-sized by propagation, top layer down.
* Only the counts and clocks in the export's `recs` are used; `needs`, `plan`
  and `ban` are ignored. End products (items nothing in the sheet consumes)
  get an adjustment equal to what the export's count and clock make, so they keep
  their machines; everything consumed is sized to its consumers.
* Items with several running producers can't propagate, so the script
  scales those producers, keeping their ratio, until supply meets demand
  (water, rubber, steel ingots, dark matter, power).
* Extraction: every pure Mk.3 miner, the pure oil extractor and the water
  extractor run at 250%; other miners are off. Of the pure resource wells
  only nitrogen runs, since a second running water or oil producer would
  stop propagation. One fueled augmentor, one Main Portal, one pressurizer.
* Balancing runs with fractional counts; at the end every count is rounded
  up, and any multi-producer item the rounding left short is raised again.

## Lattice clocks (second page)

`dist/lattice-clocks.html` answers a different question: which *effective
clocks* (machines x clock, in steps of 0.0001 %) can each recipe take so that
every balance comes out exactly, with machine counts as low as possible?

Definitions:

* Effective clock y of a recipe, in units of 0.0001 % (1 000 000 = one
  machine at 100 %). One machine may run at any clock up to 250 %. Above
  that, y must divide evenly over n machines in 0.0001 % steps, with each
  machine between a minimum (a setting, default 100 %) and 250 %; the page
  reports the fewest n that works. An empty minimum means only
  n = ceil(y / 250 %) is allowed. A minimum above 125 % leaves gaps.
* Items: raw resources (anything a miner, extractor or well makes) are drawn
  in whole multiples of 15/min; gathered items in any amount; build
  materials (any build-gun cost) and equipment (ammo, rebar, Nobelisks,
  filters, portable fuels, batteries; with FICSMAS, snowballs, fireworks and
  the Wonder Star) need net >= 0; every other item net = 0.
  Power is ignored. Augmentor and Main Portal: whole machines only. Any
  internal item can be switched to "surplus allowed" on the Items tab.
* All recipes are in scope (FICSMAS behind its toggle); miners, extractors
  and gathering are replaced by the raw/gathered rules.

Method:

* Exact part. The whole-number conditions define a lattice. `src/lattice.js`
  finds a basis by integer column reduction (Hermite-style, BigInt), starting
  from unit vectors and, constraint by constraint, combining vectors until one
  carries the gcd, then dropping it. Pins (y_r = v) are applied the same way
  to an affine lattice. Each recipe's possible values are then exactly
  offset + step x Z.
* Approximate part. The sign conditions define a cone; ranges come from
  linear programs (a small dense simplex in the same file). The homogeneous
  cone is extremely degenerate, so zero right-hand sides are perturbed by
  about 1e-7 machine (fixed seed). The shift is linear in the perturbation, so
  each bound is solved at sizes 1 and 2 and extrapolated to 0 (b = 2 b1 - b2),
  then rounded onto the recipe's progression; values under 5e-7 machine are
  zero. Linear programming ignores integrality, so a value inside a range can
  still be impossible near its ends.
* A pin is accepted when it is in the recipe's progression, inside its range
  and passes the machine rule, and the full re-evaluation succeeds.
  The page lists the recipes whose possible values, range or smallest value
  changed.

"Use sheet's recipes" reads a production-sheet export and turns every recipe
that is not running there off.

## Recipe matrix (third page)

`dist/recipe-matrix.html` is a recipe x product table. Choose products; the
rows are the recipes that make or use at least one of them and the columns are
every product those recipes touch. Each cell is base / actual: the recipe's
net rate of that product for one machine at 100 % (power in MW), then that
rate x clock x count. Clock and count are typed in (whole machines; nothing is
resized). A Hide tickbox per row hides it unless "Show hidden" is on (hidden
rows still count). Two frozen footer rows cover every recipe in the sheet:
the rebuild rate (bill of materials from `src/buildings.js` divided by the
rebuild time) and net = made - used - rebuild. It starts from the production
sheet's default plan and imports production-sheet exports as well as its own.

## Optimizer (Phase 5 build time)

`python3 tools/optimize.py` looks for the factory that makes its whole bill of
materials in the least time T, and writes `data/optimized_plan.json`, a
production-sheet export (import it into the sheet or the matrix; the sheet's
rebuild time is set to T). `node tools/check_plan.js` re-checks that file with
the pages' own code. (The Phase 5 amounts were swapped, 256 Ballistic Warp Drives and 200 AI Expansion Servers, until the fix in the commit that added `tools/clean_clocks.py`; the plan and the results below are from after the fix.) A run from scratch takes roughly half an hour;
`--cache FILE` keeps the continuous result for re-runs of the integer stages.

**What is made.** The bill of materials is
* every building the factory needs: its machines, extractors and generators,
  plus the sheet's support rules (per machine, lane and pipe), with the
  per-item-type rule set to 5 industrial storage containers and 2 smart
  splitters per solid item type (1 fluid buffer per fluid type);
* the fixed list of extra buildings and equipment at the top of the script;
* the Phase 5 parts (1,000 Nuclear Pasta, 1,000 Biochemical Sculptors,
  256 AI Expansion Servers, 200 Ballistic Warp Drives), in exact proportion.

**Rules.**
* Items in the bill of materials need net >= (amount) / T; Phase 5 parts are in
  exact proportion; every other item balances exactly (net = 0).
* Raw resources: Miner Mk.3, Oil Extractors and well pressurizers all at 250 %,
  on the 1.2 nodes (wiki counts); any number of water extractors at 100 %;
  geothermal generators on geysers (average output). A source may be drawn
  below capacity (it backs up); its power and buildings count in full.
* Clocks are capped at 100 %, and a machine draws its full 100 % power at any
  clock; generators make power in proportion to clock (fuel burned).
  Net power >= 0.
* No Somersloops (no augmentors, no amplification); recipes that need
  hand-gathered items are left out. The Gas Nobelisk needs Biomass, so it is
  dropped from the list; Dimensional Depot Uploaders need Mercer Spheres, which
  are reported as gathered by hand and not timed.
* Wells: the wiki gives satellite totals only (nitrogen: 6 wells, 2/7/36
  impure/normal/pure; oil: 3 wells, 8/6/4), so each well is an average well.
  The sheet cannot overclock a pressurizer, so its pressurizer power reads low.

**Method.**
1. Continuous linear program. For a fixed lam = 1/T every constraint is
   linear (the bill of materials is linear in the machine counts), so the best
   lam is found by bisection, solving with HiGHS (an open-source linear and
   mixed-integer solver). The item-type counts and the set of
   bill-of-materials items are taken from the previous solution and the
   solve is repeated until they stop changing.
2. Pruning: recipes that make under 5 % (`--prune`) of every product they make,
   and generators under 5 % of the power, are removed and the problem solved
   again, until nothing is removed.
3. Whole machines: a mixed-integer program with whole machine counts (each
   clock <= 100 %) and whole sources, bisecting lam down from the continuous
   optimum.
4. Exact clocks: with the machine counts fixed, each machine's clock is a whole
   number of 0.0001 % steps. The exact balances (rational recipe rates) and the
   Phase 5 proportions define an integer lattice; its basis is found by integer
   column reduction and reduced with LLL (Lenstra-Lenstra-Lovasz). Every
   integer point of the lattice balances exactly, so the result is checked in
   exact rational arithmetic, not to a tolerance.
   * If a lattice step is longer than 5 % of a clock (small machine counts along
     a chain of exact ratios, such as the Phase 5 parts, can make the only step
     longer than a clock's whole range), one machine is added to the recipe that
     shortens it most.
   * Directions up to 0.3 % of a clock are solved continuously and rounded, with
     every constraint tightened by the most rounding can move it; only the long
     directions are searched as integers. A full integer search, started from
     the rounded point, then tries to improve it (a plain integer search stalls
     or runs out of memory here).

**Current result** (with the Phase 5 fix; standard Aluminum Ingot and Caterium
Wire left out by choice, `--exclude`, for a smaller factory with fewer
recipes). T = 68.2 min: 65.7 min continuous, 67.4 min with whole machines. The
plan has 111 recipes on 10,621 machines plus 1,051 sources and 503,791
buildings in all. Power is 380 GW, from 1,510 rocket-fuel generators and 7 of
the 9 pure geysers. Every bauxite and nitrogen node, every crude oil node and
oil well, and every pure coal node is used, so those are what bind; quartz,
SAM and iron are not all used, because each miner costs 151 MW and its
buildings. These are good solutions, not proven optima: the integer stages fix
choices made by the stage before them. (Results before the fix, with the
swapped Phase 5 mix, were 68.2 min with all recipes and 69.9 min with the two
left out.)

## Machine moves (fourth page)

`dist/machine-moves.html` works with whole machines, every one at 100 %: only
the number of machines of each recipe changes. The rules:

* the four Phase 5 recipes are fixed at one exact batch (192 AI Expansion
  Servers per minute: the fewest whole machines that make the parts in
  proportion *and* that whole machines upstream can feed exactly; the Phase 5
  machines alone would allow 64/min);
* every fluid and intermediate nets exactly 0, except what the build gun uses
  (any building cost), ammunition, filters and fuels (solid generator fuels,
  packaged fuels, batteries; not nuclear fuel rods), which may pile up with no
  minimum;
* raw resources are only drawn, in whole multiples of 30/min.

The machine counts that satisfy the exact rules form an integer lattice (a raw
draw that must be a multiple of 30 becomes an equation with one extra integer
unknown). Its reduced basis (big-integer column reduction, with
Lenstra-Lenstra-Lovasz reduction along the way) is a list of **moves**, and the
page changes the factory only by moves, so every exact rule stays exact. The
item rules live in `tools/moves_start.py`, which writes them into
`data/moves_start.json` for the page.

* **Start.** Every recipe that needs no hand-gathered items (246), leaving out
  Unpackage recipes and the Packager recipes other than Packaged Fuel,
  Turbofuel, Rocket Fuel and Ionized Fuel, at the fewest whole machines that
  satisfy the rules (`tools/moves_start.py`, an integer program verified
  exactly): __START__. Power is not part of the problem.
* **Products tab.** Every product with its unlock tier, rule, net per minute
  and build cost (the items it takes to construct every machine now in the
  factory). Net-0 rows are tinted. Tiers come from `tools/tiers.py`
  (`data/tiers.json`): the milestone tier of the recipe that makes the item;
  for MAM and hard-drive unlocks, the highest tier among what it takes to
  unlock and make it (research cost, prerequisites, ingredients, machine).
* Selecting a product opens its **move sheet**: one column per unblocked move
  that changes the product's net or the machines that make or use it, one row
  per recipe a column changes, with its current count. Candidates are the
  product's own chains, the chain moves of each recipe that makes or uses it,
  and the lattice basis, each in both directions.
* **Recipes tab.** Select a recipe for its chain moves (the recipe plus the
  suppliers and consumers it needs), the product chains through it, and the
  lattice moves; **Shrink this** searches combinations of up to three moves for
  the one that lowers it most. **Step** is the smallest change in a recipe's
  count any combination of moves can make.
* Import takes this page's exports (production-sheet files with every clock at
  100 %) that satisfy the rules.

The engine in `src/moves.js` also accepts per-recipe clocks (used by the tests),
but the page keeps every machine at 100 %.
