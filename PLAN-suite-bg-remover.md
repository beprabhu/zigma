# Plan — Zesku Suite: multi-product shell + BG Remover integration

**Goal.** Turn `zepto-internal` (the Next.js SKU Compositor) into a product **suite** with sidebar
navigation, port the local **bg-remover** into it as (a) a shared engine used inside the Compositor
workflow and (b) a standalone **BG Remover** product with batch/CSV support and a configurable
**safe-area tile fitting** mode. Keep everything shadcn — reuse the existing `components/ui/*`,
add missing primitives only from the official registry via the shadcn MCP.

**Source repos (read-only during the port):**
- `~/Documents/sku-compositor/zepto-internal` — Next.js 16 / React 19 / Tailwind v4 / shadcn (`base-nova` style, Base UI). This is the base and stays the home of the suite.
- `~/Documents/bg-remover` — stdlib Python static server + two vanilla HTML apps. All inference is in-browser (vendored transformers.js + onnxruntime-web, models under `static/models/`), plus an optional RMBG-2.0 PyTorch sidecar (`hq_server.py`, port 5002). The Swift/Vision CLI (`bgremove.swift`) is unwired/vestigial — **not ported**.

---

## 1. Target architecture

```
zepto-internal/
  app/
    layout.tsx                  # root: SidebarProvider + AppSidebar + SidebarInset
    page.tsx                    # suite home — product launcher cards (from lib/products.ts)
    compositor/page.tsx         # current app/page.tsx moved here (product 1)
    bg-remover/page.tsx         # product 2 (new)
    api/
      generate/  fetch-image/  compress/    # existing proxies (unchanged)
      remove-hq/route.ts        # NEW — proxy to RMBG-2.0 sidecar (+ /health passthrough)
  components/
    app-sidebar.tsx             # suite nav (built on ui/sidebar), driven by lib/products.ts
    product-header.tsx          # SidebarTrigger + product title + ThemeToggle
    bg-remover/                 # product-2 components (see §4–5)
    ui/                         # existing 21 primitives + additions (§6)
  lib/
    products.ts                 # product registry: {slug, name, icon, description}
    bg/
      engine.ts                 # model registry, load/warm/cache, WebGPU→WASM fallback, 2-pass infer
      refine.ts                 # edge-refinement CV pipeline (port of index.html:338–708)
      metrics.ts                # bbox / center-of-mass / density / logo-box (port of index.html:725–799)
      safe-area.ts              # subject-bbox → scale/anchor into safe area on a tile (§5)
      types.ts
  public/
    vendor/                     # onnxruntime-web wasm+mjs (copied from node_modules, postinstall)
    models/<org>/<name>/…       # ONNX weights — gitignored, populated by scripts/setup-models.mjs
  scripts/setup-models.mjs      # copy from ../bg-remover/static/models (or download from HF)
  next.config.ts                # + COOP/COEP headers on every route (SharedArrayBuffer)
```

**Adding product N later** = 3 steps: entry in `lib/products.ts` → `app/<slug>/page.tsx` →
optional `components/<slug>/`. Sidebar and home page populate themselves from the registry.

---

## 2. Phase 1 — Suite shell & navigation (S)

1. Add shadcn `sidebar` (pulls its own deps: sheet, skeleton, tooltip…) via MCP add command.
2. `lib/products.ts` — registry with Compositor + BG Remover entries (lucide icons).
3. `components/app-sidebar.tsx` — icon-collapsible sidebar: suite name header, one menu item per
   product, active state from `usePathname()`, footer with ThemeToggle.
4. Move `app/page.tsx` → `app/compositor/page.tsx`; drop its private header (replaced by
   `product-header.tsx`); adjust the `--pane-h` calc for the new chrome.
5. New `app/page.tsx` — launcher: one Card per product (name, description, "Open").
6. Root `layout.tsx` wraps children in `SidebarProvider` + `AppSidebar` + `SidebarInset`.

**Verify:** `/` shows launcher, sidebar switches products, compositor works exactly as before
(`?mock=1` run: CSV → generate → export ZIP).

## 3. Phase 2 — BG-removal engine port (M) — the foundation both features share

1. **Runtime:** npm `@huggingface/transformers` (pinned) instead of the unpinned vendored
   `transformers.min.mjs`. Postinstall script copies the *matching* `onnxruntime-web/dist`
   wasm+mjs artifacts into `public/vendor/`. Engine sets `env.allowRemoteModels=false`,
   `env.localModelPath='/models/'`, `env.backends.onnx.wasm.wasmPaths='/vendor/'`.
2. **Cross-origin isolation:** `next.config.ts` `headers()` → `Cross-Origin-Opener-Policy:
   same-origin` + `Cross-Origin-Embedder-Policy: require-corp` on `/:path*` (threaded WASM needs
   SharedArrayBuffer). ⚠ This breaks the `tweakcn.com/live-preview` script in `layout.tsx` —
   remove it (its own comment already says "remove before deploying").
3. **Models:** `scripts/setup-models.mjs` populates `public/models/` from
   `../bg-remover/static/models` when present, else downloads from HF. Gitignored. All four
   browser models kept (RMBG-1.4 fp32 168MB, BiRefNet-512 fp16 452MB, BEN2 fp16 209MB, MODNet
   fp16 12MB) — they lazy-load per selection, so present-on-disk is the only cost.
4. **`lib/bg/engine.ts`:** port of the proven logic — model registry (incl. RMBG-1.4's inline
   processor overrides), per-model cache + warm-up, WebGPU with WASM fallback, the 2-pass
   full+zoom inference with uncertainty fusion, alpha compositing. Runs on the main thread as
   today (worker offload = later enhancement).
5. **`lib/bg/refine.ts` + `metrics.ts`:** straight ports — pure TypedArray/canvas code.
6. **RMBG-2.0 sidecar:** stays a Python service. `app/api/remove-hq/route.ts` proxies to
   `HQ_SERVER_URL` (default `http://127.0.0.1:5002`). UI shows the "RMBG-2.0 (server)" model
   only when `/health` responds; README documents starting it from the bg-remover venv.

**Verify:** temporary harness page removes bg from `bg-remover/static/test/bed.webp` +
`puff.webp`; visually compare against the committed reference outputs; confirm WebGPU active
(console) and WASM fallback works; sidecar path returns a PNG when `hq_server.py` runs.

## 4. Phase 3 — BG Remover product: single + batch + CSV (M)

`app/bg-remover/page.tsx`, two tabs (existing `Tabs`): **Remove** and **Tile fit** (§5).

1. **Input:** dropzone accepting image files (multi), drag-drop, clipboard paste — *and* CSV
   upload reusing `lib/csv.ts` auto-detection (image-URL columns flattened to one item per URL,
   title column → output filename). Remote URLs load through existing `/api/fetch-image`.
2. **Controls:** model Select (4 local + server when healthy), "Refine edges" Checkbox,
   output background (transparent / white / custom color).
3. **Queue:** same pattern as compositor (`QueueItem`-style state, status badges, per-row retry ✕/↻);
   sequential processing with Progress bar + cancel; before/after compare on click (Dialog).
4. **Export:** per-item PNG download + "Export ZIP" via `lib/zip.ts`; optional TinyPNG pass
   through existing `/api/compress` when a key is set.

**Verify:** 6-image mixed batch (files + CSV URLs) end-to-end; failure row shows error and
doesn't stop the run; ZIP contents named from titles/filenames.

## 5. Phase 4 — Safe-area tile fitting (M)

The bbox groundwork already exists (`metrics.ts` port). New `lib/bg/safe-area.ts`:

- **Inputs (all live-editable):** tile size (presets 512/1024/2048/custom + "SKU tile 600×768");
  safe area as per-side margins in px or %; anchor (9-position grid, default bottom-center);
  fill slider (% of safe area the subject may occupy, default 100); upscale allowed toggle;
  background (transparent/white/custom).
- **Math:** subject bbox from alpha>128 scan → `scale = min(safeW/bboxW, safeH/bboxH) × fill`
  (clamped to 1 if upscaling off) → position by anchor → draw onto tile canvas.
- **UI:** `safe-area-controls.tsx` (Slider, ToggleGroup, Inputs) + `safe-area-preview.tsx` —
  live tile preview with dashed safe-area overlay, recomposited from the cached cutout
  (cheap, no re-inference). Preview grid shows every queued item on its tile.
- **Batch:** "Run batch" = for each queued image: remove bg (if not cached) → fit to current
  safe-area config → tile PNG. Continuous with progress; ZIP export; TinyPNG optional.

**Verify:** Lays-style packet (`puff.webp`): remove bg, margins 8%, bottom-center → subject
exactly fills safe area; change fill to 80% → live preview updates without re-inference;
batch of 5 exports consistent tiles.

## 6. Phase 5 — Compositor workflow integration (S)

1. New toggle in the Generate pane: **"Remove background from generated composite"** + model
   picker (compact, disabled until engine ready).
2. `generateItem()` gains a step: `callAzure` result → `bg.remove()` → transparent-PNG
   `resultImage` → existing tile render. New `ItemStatus: 'removing-bg'` + badge in `QueueList`.
3. Works identically in `?mock=1` (mock composite gets bg-removed too — good test path).

**Verify:** mock run with toggle on: tile image layer shows template bg through transparent
regions; real Azure run on one row.

## 7. Phase 6 — Polish (S)

- Model availability check on engine init: missing `public/models/**` → friendly Empty state
  pointing at `pnpm setup:models`.
- `README.md` update: suite structure, model setup, optional sidecar, adding-a-product recipe.
- `pnpm typecheck && pnpm lint`; full manual pass of both products in light+dark.

---

## shadcn component plan

- **Reused (already in repo):** button, card, checkbox, collapsible, empty, field, input, label,
  progress, scroll-area, select, separator, sonner, spinner, tabs, textarea, tooltip, badge,
  alert-dialog.
- **Add via shadcn MCP (official registry, `base-nova` style):** `sidebar` (+its dep tree),
  `slider`, `switch`, `toggle-group`, `dialog`, `dropdown-menu`, `skeleton`.
  No custom primitives — product components compose these only.

## Key decisions & risks

| Decision | Choice | Note |
|---|---|---|
| Where the suite lives | `zepto-internal` (rest of repo = legacy, untouched) | nested git repo stays as-is |
| transformers.js | npm, pinned | vendored copy was version-unpinned; RMBG-1.4 keeps inline processor opts |
| Model weights (841MB) | gitignored `public/models/` + setup script | local tool; object storage only if we ever deploy |
| RMBG-2.0 (844MB, PyTorch) | optional external sidecar behind `/api/remove-hq` | UI hides it when unhealthy; not a JS port candidate |
| COOP/COEP | global headers in next.config | required for threaded WASM; removes tweakcn dev script |
| Inference thread | main thread (as today) | Web Worker offload is a listed future enhancement |
| `bgremove.swift` | dropped | never wired into the web app; macOS-only |

## Open questions (defaults applied unless changed)

1. **Suite branding** — keep **"Zesku"** as the suite name, products "Compositor" and
   "BG Remover"? (Header + metadata + sidebar title.)
2. **Model lineup** — keep all four browser models, or trim to RMBG-1.4 + server RMBG-2.0
   (saves ~660MB disk)? Default: keep all four.
3. **SKU-tile preset** in Tile fit — default output at 600×768 (the 8× Figma frame) alongside
   the square presets? Default: yes.

## Execution order

Phases are sequential (each verifiable on its own): **1 shell → 2 engine → 3 remover →
4 tile fit → 5 compositor hook → 6 polish**. Compositor stays fully functional after every
phase.
