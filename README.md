# Satisfactory Production Sheet

A one-page tool for planning factories in Satisfactory 1.0. It lists every
recipe in the game, plus synthetic "recipes" for miners, extractors,
generators, the Alien Power Augmentor and the Main Portal. You set clock
speeds and net-production floors; machine counts, power, lanes, buildings and
the bill of materials follow.

The finished page is `dist/satisfactory-sheet.html` (a single self-contained
file; open it in a browser, or publish it as a claude.ai artifact).

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
* Machine counts are whole numbers. Editing a recipe's clock or floor
  re-sizes it to the fewest machines that cover the consumption of its first
  output by the running recipes, plus the floor. Any recipe's count can also
  be typed in; its suppliers follow.
* Then each input of that recipe (power included) is checked. If exactly one
  running recipe produces it, that producer is re-sized the same way, and the
  check repeats from there (a worklist that stops when nothing changes, or
  after 20 000 steps in a runaway feedback loop).
* If two or more running recipes produce an input, none is touched. Deficits
  show as yellow on the consumers' inputs and red on the producers' outputs.
  A power deficit marks every running generator red.
* A floor is a lower bound on the item's net production. Generators have no
  floor; they follow power demand. when several running
  recipes share an output, the largest floor applies. A by-product also drives
  sizing when its recipe is the only running producer of it.
* Orange: the item's floor is below the rate needed to build every building
  on the sheet within the build time.

## Data and assumptions

Recipe data is the game's Docs.json as extracted by
[SatisfactoryTools](https://github.com/greeny/SatisfactoryTools) (`data/data1.0.json`).
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

## Default sheet

`tools/import_plan.js` builds the default from the old plan:

* Recipes and clocks come from the old plan's `recs`. Machine counts are kept
  only where nothing else decides them (end products, generators, items made
  by two or more running recipes); every recipe that is the only running
  producer of a consumed item is re-sized by propagation, top layer down.
* Only the counts and clocks in the export's `recs` are used; `needs`, `plan`
  and `ban` are ignored. End products (items nothing in the sheet consumes)
  get a floor equal to what the export's count and clock make, so they keep
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
