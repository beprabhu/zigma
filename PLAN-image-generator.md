# Plan — Image Generator (product 4 of the Zesku suite)

Text → image via Azure GPT-Image's **generations** endpoint (`/openai/v1/images/generations`),
driven by an **MD brief** + a **CSV of rows**. Every row becomes one generated image: the
prompt is the MD file followed by the row's cells labelled with their column headers.

## The prompt contract (the core of the product)

For a CSV like:

```csv
name,subject,use
diwali-banner,Diya lamps on a festive table,Homepage hero for the Diwali sale
combo-pack,3 snack packets fanned out,Category page thumbnail
```

and an uploaded `brief.md`, each row's prompt is assembled as:

```
<full contents of brief.md>

---
Generate an image for this row:
name: diwali-banner
subject: Diya lamps on a festive table
use: Homepage hero for the Diwali sale
```

- **All columns are sent by default**, labelled with their header names (that is the ask:
  "send the rows along with the column names along with md file").
- Per-column checkboxes let a column be excluded from the prompt (e.g. an internal ID column).
- Empty cells are skipped.
- The exact assembled prompt is shown in the row's dialog — inspectable, copyable, never a
  black box (same ethos as the region report and budget report).
- Char-count guard: MD + row length is shown, with a warning past ~30k chars (API prompt cap).

## Flow

1. Drop **brief.md** (`.md`/`.txt`) — content shown in a collapsible editable textarea, so it
   can be tweaked inline without re-uploading. Session-only, not persisted.
2. Drop **the CSV** — headers + rows parsed with the existing `lib/csv.ts`. A **Name column**
   picker (auto-detected, remappable, cutouts-preserving remap semantics like BG remover)
   names tiles and exported files; column checkboxes control prompt inclusion.
   One dropzone routes by extension (suite convention), two summary chips show what's loaded.
3. **Generate all** — rows fan out to Azure in parallel groups (`mapWithLimit`, a
   "Parallel requests" setting like the compositor's, default 3, cap 8). Per-row failures mark
   the row and never sink the batch. Progress: "N of M — K at a time".
4. Results land in the **grid-as-queue** (shared `ResultCell`): before generation a cell shows
   the row's name + a prompt snippet on a muted card (there is no source image — rows are
   text); after, the generated image. Status line + hover-trash delete, exactly like the other
   two products.
5. **Click a cell → dialog**: assembled prompt (scrollable, one-click copy) beside the
   generated image; footer = Regenerate · Download PNG (Save As flow) · Close. Live-updates
   during a regenerate (held by id, like the others).
6. **Export ZIP** through `pickSave`/`saveTo`, files named by the Name column with the
   numbering toggle.

## Files

| File | Change |
|---|---|
| `lib/products.ts` | Add `image-generator` entry (ImagePlusIcon) — sidebar + launcher pick it up automatically |
| `app/api/generate/route.ts` | Add `mode: 'edits' \| 'generations'`. Generations = JSON POST to `origin + /openai/v1/images/generations` with `{model: 'gpt-image-2', prompt, size, quality, n: 1}` → `{b64}`. Edits path untouched (compositor + BG remover depend on it) |
| `lib/pipeline.ts` | `callAzureGenerate(prompt, {endpoint, apiKey, size, quality})` → HTMLImageElement; `mockGenerate(prompt)` renders the prompt text onto a placeholder canvas for keyless `?mock=1` testing |
| `lib/gen.ts` (new) | `buildRowPrompt(md, headers, row, excludedCols)` + the queue-item type. Pure and unit-testable |
| `app/image-generator/page.tsx` (new) | The product page: dropzone, mapping card, settings, grid, dialog, export |
| `components/image-generator/` (new, small) | Cell + dialog if they don't fold into the page; grid shell is the shared `ResultCell` |
| `README.md` | Product table row + a short section with the prompt contract |

## Settings (persisted `skuc_` keys)

- Azure endpoint + API key — **the same shared keys** the compositor and AI edit use
  (`skuc_azureEndpoint` / `skuc_azureKey`); paste either the edits or generations URL, the
  route keeps only the origin.
- `skuc_genSize` — 1024×1024 · 1536×1024 · 1024×1536 · auto
- `skuc_genQuality` — low / medium / high (default low, same as the compositor)
- `skuc_genParallel` — parallel requests, default 3, cap 8

## Edge cases

- **CSV with actual image URLs**: v1 treats them as prompt text — this product is
  generations-only by design. (Future option: auto-offer the edits pipeline when an image
  column is detected; not in scope now.)
- MD missing: allowed — rows generate from their own fields; the brief chip just shows empty.
- CSV remap after generating: rows matched by content, finished images kept (same
  no-work-thrown-away rule as the BG remover's remap).
- 429s: surface per-row error with the message; parallel setting description says to step down.

## Verification

All in `?mock=1` (keyless): MD + CSV in → placeholder cells with prompt snippets → generate →
mock images carrying the prompt text → dialog shows the assembled prompt containing BOTH the
MD content and every `header: value` line → regenerate → ZIP export through a stubbed save
picker → typecheck + lint. Real-Azure smoke needs the key, left to a manual run.

## Defaults chosen (flag if wrong)

- One image per row (`n: 1`) — variants can come later.
- TinyPNG / PNG size budget not wired into v1's export (easy to add, same shared keys).
- All columns included in the prompt by default, checkboxes to exclude.
