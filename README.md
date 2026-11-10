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
| `tools/build.py` | Inlines everything into `dist/satisfactory-sheet.html`. |
| `tools/test_solver.js` | Command-line checks of the solver. |
| `tools/import_plan.js` | Turns a plan exported from the older "factory ledger" tool (`data/old_plan_factory_ledger.json`) into the page's default sheet, `data/default_plan.json`. |

## Rebuild

```sh
python3 tools/build_data.py --fetch   # only when the game data changes
node tools/import_plan.js             # re-derive the default sheet
python3 tools/build.py
node tools/test_solver.js
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
