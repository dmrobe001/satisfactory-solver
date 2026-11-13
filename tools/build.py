#!/usr/bin/env python3
"""Inline data, CSS and JS into the pages: dist/satisfactory-sheet.html
(production sheet), dist/lattice-clocks.html (lattice clocks),
dist/recipe-matrix.html (recipe matrix) and dist/machine-moves.html
(machine moves).

The page has no <html>/<head>/<body> wrapper because it is published as a
claude.ai artifact, which adds that skeleton.  Browsers open it fine as is.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = ROOT / "src"
page = (src / "index.html").read_text()
game = json.loads((ROOT / "data" / "game.json").read_text())
data = "window.GAME = " + json.dumps(game, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/") + ";"
for marker, text in [("/*__CSS__*/", (src / "style.css").read_text()),
                     ("/*__DATA__*/", data),
                     ("/*__PLAN__*/", "window.DEFAULT_PLAN = " + (ROOT / "data" / "default_plan.json").read_text() + ";"),
                     ("/*__SOLVER__*/", (src / "solver.js").read_text()),
                     ("/*__BUILDINGS__*/", (src / "buildings.js").read_text()),
                     ("/*__APP__*/", (src / "app.js").read_text())]:
    assert marker in page, marker
    page = page.replace(marker, text)
out = ROOT / "dist" / "satisfactory-sheet.html"
out.parent.mkdir(exist_ok=True)
out.write_text(page)
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")

page = (src / "lattice.html").read_text()
for marker, text in [("/*__CSS__*/", (src / "style.css").read_text()),
                     ("/*__LCSS__*/", (src / "lattice.css").read_text()),
                     ("/*__DATA__*/", data),
                     ("/*__LATTICE__*/", (src / "lattice.js").read_text()),
                     ("/*__LAPP__*/", (src / "lattice_app.js").read_text())]:
    assert marker in page, marker
    page = page.replace(marker, text)
out = ROOT / "dist" / "lattice-clocks.html"
out.write_text(page)
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")

page = (src / "matrix.html").read_text()
for marker, text in [("/*__CSS__*/", (src / "style.css").read_text()),
                     ("/*__MCSS__*/", (src / "matrix.css").read_text()),
                     ("/*__DATA__*/", data),
                     ("/*__PLAN__*/", "window.DEFAULT_PLAN = " + (ROOT / "data" / "default_plan.json").read_text() + ";"),
                     ("/*__SOLVER__*/", (src / "solver.js").read_text()),
                     ("/*__BUILDINGS__*/", (src / "buildings.js").read_text()),
                     ("/*__MAPP__*/", (src / "matrix_app.js").read_text())]:
    assert marker in page, marker
    page = page.replace(marker, text)
out = ROOT / "dist" / "recipe-matrix.html"
out.write_text(page)
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")

page = (src / "moves.html").read_text()
for marker, text in [("/*__CSS__*/", (src / "style.css").read_text()),
                     ("/*__VCSS__*/", (src / "moves.css").read_text()),
                     ("/*__DATA__*/", data),
                     ("/*__PLAN__*/", "window.MOVES_START = " + (ROOT / "data" / "moves_start.json").read_text() + ";\n"
                      "window.MOVES_TIERS = " + (ROOT / "data" / "tiers.json").read_text() + ";"),
                     ("/*__MOVES__*/", (src / "moves.js").read_text()),
                     ("/*__VAPP__*/", (src / "moves_app.js").read_text())]:
    assert marker in page, marker
    page = page.replace(marker, text)
out = ROOT / "dist" / "machine-moves.html"
out.write_text(page)
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")

# building blocks: the block libraries in data/blocks/
POOLS = [("std_t0", "Iron, copper, limestone"), ("std_coal", "+ coal")]
items, mach = {}, {}
pools = []
for name, title in POOLS:
    f = ROOT / "data" / "blocks" / f"{name}.json"
    if not f.exists():
        continue
    p = json.loads(f.read_text())
    p["name"], p["title"] = name, title
    pools.append(p)
    for k in p["classes"]:
        items[k] = game["items"].get(k, {}).get("n", k)
    for r in p["recipes"]:
        mach[r["m"]] = game["buildings"].get(r["m"], {}).get("n", r["m"])
bdata = "window.BLOCKS = " + json.dumps({"pools": pools, "items": items, "machines": mach}, separators=(",", ":")) + ";"
page = (src / "blocks.html").read_text()
for marker, text in [("/*__CSS__*/", (src / "style.css").read_text()),
                     ("/*__BCSS__*/", (src / "blocks.css").read_text()),
                     ("/*__DATA__*/", bdata),
                     ("/*__BAPP__*/", (src / "blocks_app.js").read_text())]:
    assert marker in page, marker
    page = page.replace(marker, text)
out = ROOT / "dist" / "building-blocks.html"
out.write_text(page)
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
