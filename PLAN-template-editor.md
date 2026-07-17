# Template editor: Figma-style basic editing for tiles

## What you get

A template editor in the left panel replacing the current fixed "Template preview": a **layers list** (Frame, Title, Image, Offer), **click-to-select** on the preview canvas, and a **properties inspector** that shows editable controls for the selected layer. Every edit re-renders the template preview *and* all generated tiles live. Settings persist in localStorage and survive reloads; a **Reset to default** button restores the original Figma spec.

## Editable properties

| Layer | Properties |
|---|---|
| **Frame** | width, height, corner radius, background color |
| **Title** | text y-position, x-offset, font size, line height, font weight, color, text-box width, max lines, alignment |
| **Image** | size (width/height), x/y offset, fit (cover/contain) |
| **Offer bar** | width, height, y-offset, background color, text color, font size, font weight, corner radius, padding |
| **All layers** | stacking order (move up/down in layers list), show/hide |

## How it works

### 1. `tile.js` — template becomes data, renderer reads it
- Replace the hardcoded `TILE` constant with a `DEFAULT_TEMPLATE` object: per-layer property objects plus a `layerOrder: ['image', 'title', 'offer']` array (frame is always the backdrop/clip, not reorderable).
- `renderTile(canvas, opts, template)` takes the template as a parameter and draws layers in `layerOrder` sequence. Positions become explicit x/y + offsets instead of derived constants. Export scale adjusts so output resolution stays ~600px wide regardless of tile width.
- Add `hitTest(template, x, y)` → returns the topmost layer at a point (for click-to-select), and rounded-rect support for the offer bar.

### 2. `app.js` — template state + persistence
- `state.template` = deep-merged `DEFAULT_TEMPLATE` + saved `localStorage('skuc_template')`. Saved on every edit (debounced). Old keys (`tplFit` etc.) fold into the template object; existing title/offer text fields stay as-is.
- All `renderTile` call sites pass `state.template`. Edits invalidate `item.compressed` (already the existing pattern).

### 3. New editor UI (index.html + styles.css + app.js)
- **Layers list**: 4 rows with visibility toggle (eye), name, and ▲▼ reorder buttons for the 3 content layers. Clicking a row selects it.
- **Canvas click-to-select**: click on the template preview → `hitTest` → select that layer; selected layer gets a dashed outline drawn on the preview (outline is preview-only, never exported).
- **Inspector**: renders controls for the selected layer — number inputs with drag-to-scrub for dimensions/offsets, native color pickers for colors, small selects for weight/fit/alignment. Grouped compactly (two columns) so it doesn't blow up the panel height.
- **Reset to default** button with confirm.

### 4. Downstream fixes
- ZIP/compress/download already read from `item.canvas`, so they inherit new dimensions automatically; only the fixed `600×768` canvas attributes in index.html and the CSS preview sizing need to become dynamic.

## Out of scope (this pass)
Dragging layers on canvas, adding/deleting arbitrary layers, fonts beyond the system stack, per-tile (non-template) overrides. All possible later; say so if any is actually needed now.
