#!/usr/bin/env python3
"""Inline data, CSS and JS into the two pages: dist/satisfactory-sheet.html
(production sheet) and dist/lattice-clocks.html (lattice clocks).

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
