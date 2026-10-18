# AGENTS.md

## What this is

Buildless static site — a browser game ("Where People Live") on a Leaflet map.
There is **no package.json, no build, no lint, no tests, no CI**. All app code is
three files: `index.html`, `wherepeoplelive.js`, `wherepeoplelive.css`.

## Run / verify

Data is loaded with `fetch()`, so opening `index.html` via `file://` fails.
Serve over HTTP:

```sh
python3 -m http.server 8000   # from repo root, open http://localhost:8000
```

Verification is manual: load the page, play a guess, check the browser console.
Note the game deliberately waits ~4s on the splash screen after load (`init()`),
and map tiles come from Esri's online service (network required).

## Architecture (not obvious from filenames)

- Vendored libs are committed at pinned versions in the repo root
  (`leaflet-1.9.4-min.js`, `turf-7.4.0-min.js`, `leaflet-1.9.4.css`). There is no
  package manager — never edit or "upgrade" them in place.
- `index.html` wires everything through inline `on*` handlers
  (`onkeydown="searchName()"`, `onclick="restartGame()"`, `window.onload = init`).
  Every entry function in `wherepeoplelive.js` must stay a **global**; do not
  convert to ES modules without also rewriting those handlers.
- Startup fetches (begin at script parse, while splash shows): `cities5000.txt`
  (15 MB GeoNames TSV), `countries.json` (PT-BR country labels + centroid),
  `boundaries.json` (pre-simplified GeoJSON `GeometryCollection`).
- `cities5000.txt` is parsed by **hardcoded column indexes** in `processDB()`:
  0=id, 1=name, 3=alternatenames, 4=lat, 5=lon, 7=feature code, 9=admin1,
  14=population. Capital detection is `row[7]=="PPLC" && row[9]==""`. If you
  regenerate this file, keep the standard GeoNames column order.
- Search matching: input normalized by `convertSearchName()` (strip `' "-.`,
  drop diacritics, lowercase) → `nameIndex` Map whose value is a number for
  unique names or an array on collision. Indexing and lookup must use the exact
  same normalization.
- Game state persists in localStorage key `state`
  (`{guessed:[], revealed:[]}` of geonameids). A stale state from your testing
  carries over between loads — use the `X` button (`restartGame()`) for a clean
  run.
- UI strings, code comments, and country names are **Brazilian Portuguese**.
  Keep new ones consistent with the surrounding language.

## Performance patterns are intentional — don't "simplify" them away

- `copyString()`: prevents V8 SlicedString from pinning the whole 15 MB buffer.
- `nearCities()`: bounding-box prefilter before `turf.distance` (~70k calls per
  guess otherwise); also handles the antimeridian wrap.
- `saveState()`: debounced batch write — one guess marks dozens of cities.
- `updateVisibleCities()`: renders only in-viewport cities on a canvas renderer;
  draw order is non-capitals (pop ascending) below capitals.
- `processDB()` sorts an `Int32Array` of row indexes instead of the city objects
  to keep them out of dictionary mode.

Comments above these explain the "why" — preserve them when touching the code.

## Deploy / assets

- No deploy automation in the repo. Production is served from S3:
  `temp/index.html` (gitignored scratch dir) just redirects to
  `https://wherepeoplelive.s3.amazonaws.com/index.html`.
- `index.html` references `title.webp` (~400 KB). `title.png` (2.5 MB) exists
  but is untracked — keep the page on the webp.
