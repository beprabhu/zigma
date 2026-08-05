# Zesku

Zepto's internal image suite. One Next.js app, a sidebar, and a growing set of tools that share
the same components and pipelines.

| Product | Route | What it does |
|---|---|---|
| **Compositor** | `/compositor` | CSV of product image URLs → branded composite tiles via Azure GPT-Image-2, TinyPNG compression, ZIP export. |
| **BG Remover** | `/bg-remover` | Strips backgrounds in the browser (single, batch or CSV), and fits cutouts into a customisable safe area on a tile. |

## Run

```bash
pnpm install
pnpm setup:bg     # one-time: fetches the ONNX weights + WASM runtime (see below)
pnpm dev          # http://localhost:3000
```

`http://localhost:3000/compositor?mock=1` runs the compositor without an Azure key — generation
is mocked, which is the fastest way to exercise the whole pipeline including background removal.

## Adding a product to the suite

Three steps, no plumbing:

1. Add an entry to `PRODUCTS` in [`lib/products.ts`](lib/products.ts) (slug, name, description, lucide icon).
2. Create `app/<slug>/page.tsx` and render `<ProductHeader title="…" />` at the top.
3. Optionally add `components/<slug>/` for its own components.

The sidebar ([`components/app-sidebar.tsx`](components/app-sidebar.tsx)) and the launcher on `/`
both read that array, so nothing else needs editing.

## Background removal

All inference runs **in the browser** — no image ever leaves the machine. Input takes files,
clipboard pastes and CSVs of URLs; **HEIC/HEIF** photos (iPhone) are converted to JPEG at
intake ([`lib/bg/heic.ts`](lib/bg/heic.ts), lazy-loaded libheif), so everything downstream sees
an ordinary image. transformers.js drives
onnxruntime-web against ONNX weights served from `public/models/`, with the WASM runtime in
`public/vendor/`. Both directories are gitignored and created by `pnpm setup:bg`, which copies
the weights from the `bg-remover` prototype when it is present next to this repo and otherwise
downloads them from HuggingFace — either way the suite ends up fully self-contained. Pass
`--link` to symlink instead and save the ~850 MB of duplication.

Each model tries the **WebGPU** backend first (GPU) and falls back to multithreaded WASM (CPU);
the header badge shows which one is actually live.

### Batch throughput

Batches run through a **pool of two Web Workers** ([`lib/bg/pool.ts`](lib/bg/pool.ts) +
[`lib/bg/bg.worker.ts`](lib/bg/bg.worker.ts)), each holding its own model instance. Inference is
only about a third of an image's cost; the rest — decode, resize/normalise, matte application,
refinement — is single-threaded CPU work. Two workers let one image's CPU stages overlap
another's GPU stage, which is what keeps the GPU busy instead of idling between images.

Measured on an M4 Pro (940×940 source, warm model), the levers that got it there:

| | per image |
|---|---|
| main-thread engine, fp32, two-pass | ~670 ms |
| single pass | ~290 ms |
| fp16 weights | ~250 ms |
| worker pool (2), engine only | **~200 ms** |

The compositor still calls the engine directly on the main thread — it generates one tile at a
time, so pooling would buy it nothing. `disposePool()` on unmount is not optional: each worker
pins a model instance in GPU memory.

### Memory

A batch keeps every result alive, so per-image retention is what decides whether a run finishes
or dies with `Out of memory at ImageData creation`. Four rules keep it bounded, and all of them
were learned by exhausting a 24 GB machine on 3000px product photos:

- **Everything is capped at `MAX_EDGE` (2048).** The matte is inferred at 1024² and upscaled, so
  a 4000px source buys no extra mask precision — only 4× the memory in every buffer. The cap is
  applied during `createImageBitmap`, so the full-size bitmap is never materialised at all.
- **Cutouts are stored compressed**, as lossless WebP plus a ≤512px preview bitmap
  ([`BgCutout`](lib/bg/batch.ts)). A 3000px cutout is 36 MB as RGBA and under 2 MB as WebP; the
  UI only ever draws the preview, and export decodes the master one image at a time.
- **The decoded original is released the moment a cutout exists.** The before/after view
  re-decodes from `item.source` on demand rather than pinning a full-resolution bitmap per row.
- **ImageBitmaps and canvases are freed explicitly** (`releaseItem`, `releaseCanvas`). They live
  outside the JS heap, so GC will not reclaim them promptly on its own.

Two more things matter for batch speed, both learned the hard way:

- **Memoise anything rendered per queue item.** Every finished image patches React state, and
  un-memoised rows/cells re-rendered the whole queue on each patch — at ~28 items that cost
  more per image than the inference did.
- **The second "zoom" pass is off by default.** It re-runs the model on a tight crop for sharper
  edges at roughly double the cost; the "High detail" checkbox turns it back on.

### Models

| Model | Size | Notes |
|---|---|---|
| RMBG-2.0 | — | Best quality. Runs on a **local Python sidecar**, not in the browser (see below). |
| RMBG-1.4 | 84 MB (fp16) | Default. Good balance for packaged goods. |
| BiRefNet | 452 MB | Sharpest edges, heaviest download. Static 512×512 export — the dynamic-shape exports crash onnxruntime-web. |
| BEN2 | 209 MB | Strong on complex subjects. |
| MODNet | 12 MB | Fastest, tuned for people rather than products. |

Weights download lazily on first use of each model and are then cached by the browser.

### The RMBG-2.0 sidecar (optional)

RMBG-2.0 is PyTorch and too heavy for the browser runtime, so it stays a local service:

```bash
cd ~/Documents/bg-remover && venv/bin/python hq_server.py    # serves :5002
```

`/api/remove-hq` proxies to it (override with `HQ_SERVER_URL`) and its `GET` handler is a health
probe — the UI hides the RMBG-2.0 option whenever the sidecar is down. The proxy exists because
the app is cross-origin isolated and cannot fetch another port directly.

### Cross-origin isolation

[`next.config.ts`](next.config.ts) sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` on every route. Those two headers are what expose
`SharedArrayBuffer`, which onnxruntime-web needs for its multithreaded WASM backend. Without them
inference silently drops to a single thread and the larger models fail to allocate.

The trade-off: **cross-origin scripts and assets are blocked**. That is why the tweakcn
live-preview script was removed from the root layout. Anything third-party added later needs
`Cross-Origin-Resource-Policy` headers or it will not load.

### Product only

Catalogue images often carry a composited colour strip or badge, and the models keep it — not
wrongly, since it *is* a salient object; our definition of "subject" is just narrower than
theirs. The optional **Product only** pass ([`lib/bg/regions.ts`](lib/bg/regions.ts)) labels the
matte's connected regions and drops the ones that read as vector artwork rather than photography:

- **palette** (the lead signal) — a vector panel is a handful of exact colours (fill + text), so
  its top four quantised bins cover ~90%+ of it; a photograph spreads across hundreds of bins
  (measured: strip 0.93, badge 0.94, product 0.59). Colour-independent, so strips of any colour
  work — including strips the same colour as the packaging, since regions are judged on their own
  statistics, never compared to each other.
- **flatness** — the fallback that catches gradient-filled panels (wide palette, near-zero local
  variation). Gated by a colour cap so smooth photographed packaging stays safe on its own
  evidence: a real pouch measured *smoother* than a panel but had 1,122 colours.
- **fill ratio** — corroborates: panels are rectangles. Relaxed to 0.8 when the palette is
  decisive, because the matte erodes rounded corners (a real badge measured 0.86).

It runs after refinement and **before** the bbox is measured, so tile fit stops reserving space
for a strip that is no longer there. Two invariants: the most product-like region is never
dropped (a wrong guess costs a leftover panel, never the product), and the rule is never "keep
the biggest blob" — a combo shot has two disconnected products and that rule would eat one.

Off by default; when off the code path does not run at all. The region pass only separates
regions the matte left **disconnected** — a strip physically touching the product merges into
one region it cannot split. That case is covered by the **band detector**
([`lib/bg/bands.ts`](lib/bg/bands.ts)), which runs first and works on source colours instead of
the matte: colours that paint a near-solid rectangle flush against an image edge, spanning most
of it while staying out of the frame's centre, are masked box-and-all (text and badges
included). Stacked two-colour strips merge only when they actually tile the edge, a box that
covers nearly everything the matte kept is discarded (a flat full-bleed pack shot is shaped
exactly like a strip — deleting the product is the one unrecoverable failure), and each box is
padded a few pixels so the anti-aliased fringe goes with it. Known blind spots, all failing
toward a leftover strip rather than a lost product: a panel the same colour as the backdrop, a
two-tone backdrop whose second colour reads as a panel candidate (rejected by the slab-rim
guard), and a strip whose exact colour also appears on the packaging nearby.

### Working files (.zesku)

"Save project" in the BG Remover packs every finished cutout, its subject bounds and the current
safe-area settings into a `.zesku` file; drop it back on the dropzone later to resume tile
fitting without re-running any model. The format ([`lib/bg/project.ts`](lib/bg/project.ts)) is a
STORE-method ZIP — `manifest.json` plus the lossless WebP masters — so renaming it to `.zip`
opens it anywhere. Originals are deliberately not saved: restored items show as
`restored · <origin>` and cannot be re-run (there is nothing to re-run on), but everything
downstream — previews, tile fit, export — works identically.

### Safe-area tile fitting

[`lib/bg/safe-area.ts`](lib/bg/safe-area.ts) fits a cutout into a configurable safe area:
tile size (512/1024/2048 or the 600×768 SKU tile), per-side margins in px or %, a 9-position
anchor, a fill percentage, an upscale guard and a tile background. `renderTile()` is cheap enough
to re-run on every slider tick as long as the caller passes the `bounds` measured once per cutout.

### File-size budget

PNG is lossless, so identical dimensions never mean identical bytes — size follows image
complexity, and the same tile can export anywhere from 60 KB to 300 KB while
`canvas.toBlob('image/png')` offers no knob to turn. **Limit file size**, in the BG Remover's
Compression card, puts a CDN ceiling on that without leaving PNG.

[`lib/bg/budget.ts`](lib/bg/budget.ts) climbs down a ladder and stops at the first rung that fits,
so a generous budget costs one encode and loses nothing:

1. **Truecolor** — byte-for-byte what the browser encoder produces today.
2. **256 → 128 → 64 → 32 colours** — a palette PNG written by hand in
   [`lib/bg/png8.ts`](lib/bg/png8.ts), because no browser API emits PNG-8. Measured on a detailed
   512×512 cutout: **332 KB truecolor → 57 KB at 256 colours**, which is why the lower rungs are
   for tight budgets rather than everyday use.
3. **Downscale** — 0.85× steps, never below a 256 px long edge, and only when *Shrink dimensions
   if needed* is on and every palette has already missed.

Off by default, and off reproduces today's export exactly. The format stays PNG at every rung, so
nothing downstream changes. It runs before TinyPNG, so a key set alongside it only takes the file
further under the ceiling. `CompressionStream` is required; without it the switch is disabled and
exports are uncapped.

Degradation is never silent — the export report gives the counts (untouched, quantised,
downscaled and to what size, still over budget), and any file that was shrunk or that missed the
budget is named in a toast. A shrunk tile must not be something anyone discovers on the CDN.

## Layout

```
app/
  page.tsx              suite launcher
  compositor/           product 1
  bg-remover/           product 2
  api/                  fetch-image · generate · compress · remove-hq
components/
  app-sidebar.tsx  product-header.tsx
  bg-remover/           product 2's components
  ui/                   shadcn primitives (base-nova style, on Base UI)
lib/
  products.ts           the suite registry
  bg/                   engine · refine · metrics · safe-area · batch
  csv.ts  tile.ts  zip.ts  pipeline.ts
scripts/setup-bg-assets.mjs
```

`lib/bg/refine.ts` and `lib/bg/metrics.ts` are ports of the bg-remover prototype's tuned
classical-CV code (guided-filter matting, halo correction, shadow flood-cut, subject metrics).
Their constants are load-bearing — changing them is a visual regression, not a refactor.

## Scripts

| Command | Purpose |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm setup:bg` | Populate `public/models` + `public/vendor` (`--link` to symlink instead of copying) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm format` | eslint / prettier |
