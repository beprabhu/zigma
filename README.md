# SKU Compositor

Standalone web app version of the Figma "SKU Compositor" plugin. Bulk-generates composite
product tiles from a CSV using Azure OpenAI GPT-Image-2, then compresses them with TinyPNG
and exports a ZIP.

## Run

```bash
node server.js
# open http://localhost:3000
```

No dependencies — plain Node (18+) and vanilla JS frontend.

## Flow

1. **Upload CSV** — one row per tile. Image URL columns, title column, and offer/discount
   column are auto-detected (override in Settings → Custom).
2. **Queue** — each row shows source thumbnails, status badge, reload (↻) and remove (✕).
3. **Generate & Populate** — per row (sequential): fetch images → downscale to max 1024px →
   PNG → Azure `/openai/v1/images/edits` (`gpt-image-2`, `background:auto`, `quality:low`) →
   result placed into the tile's image container. Results appear progressively in a 4-per-row grid.
4. **Compress with TinyPNG** — sends each rendered tile PNG through TinyPNG (via server proxy).
5. **Download ZIP** — all tiles (compressed versions if available) as `sku-tiles.zip`.

## Tile template

Replicates the Figma "SKU tile" frame (75×96, rendered at 8× = 600×768 px):

- White rounded frame (r12)
- **Title** — 11px demibold `#424957`, centered, 2-line ellipsis
- **Image container** — 75×75, bottom-anchored (extends 12px past frame, clipped)
- **Offer bar** — full-width `#ef4372` bar at bottom, 10px bold white **Discount text**;
  hidden when the row has no offer value

Template defaults (fallback title/offer, image fit, offer visibility) are editable in the
left panel and re-render generated tiles live.

## Keys

Entered in the UI, persisted to localStorage:

- **Azure endpoint** — e.g. `https://your-resource.openai.azure.com`
- **Azure API key**
- **TinyPNG API key**

## Testing without Azure

Open `http://localhost:3000/?mock=1` — generation is mocked (source images placed side by side
on white with a shared baseline). Sample assets: `public/samples/sample.csv` (regenerate with
`node scripts/make-samples.js`).

## API (server proxies)

| Route | Purpose |
|---|---|
| `GET /api/fetch-image?url=` | Fetch remote images (avoids CORS / canvas tainting) |
| `POST /api/generate` | Azure images/edits call (multipart built server-side) |
| `POST /api/compress` | TinyPNG shrink + download (key via `x-tinify-key` header) |
