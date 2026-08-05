# Plan — PNG file-size budget for exports

**Goal.** Every exported tile lands under a CDN file-size budget you set, while staying a `.png`.
Today a 512×512 export ranges roughly 100–200 KB (measured up to 332 KB on a detailed tile)
because PNG is lossless — size follows image complexity, not dimensions.

**Decisions already locked (from your answers):**

| Decision | Choice |
|---|---|
| Output format | **PNG only** — WebP is off the table |
| When quality alone can't hit the budget | **Reduce dimensions too** |
| Availability | **A toggle** — off by default, exports behave exactly as today |

---

## 1. Feasibility — both risky assumptions verified before planning

The browser's `canvas.toBlob('image/png')` gives **zero control** over encoding: it always emits
a 32-bit truecolor PNG. So hitting a budget in PNG requires writing our own encoder. Two things
had to be true, and I proved both in the running app before writing this plan:

**(a) We can hand-write a palette PNG in the browser.** I built a color-type-3 PNG (IHDR + PLTE +
tRNS + IDAT + IEND), compressing the IDAT with the built-in `CompressionStream('deflate')` —
which emits exactly the zlib stream PNG requires — and CRC32 from our existing `lib/zip.ts`.
The browser decoded it back correctly at the right size **with transparency intact**. No new
dependency needed.

**(b) Quantization actually hits the budget.** Measured on a realistic detailed 512×512 tile with
a soft alpha edge:

| Encoding | Size | vs today |
|---|---|---|
| Browser PNG (today) | **332 KB** | — |
| PNG-8, 256 colors | **57 KB** | −83% |
| PNG-8, 128 colors | 46 KB | −86% |
| PNG-8, 64 colors | 38 KB | −89% |
| PNG-8, 32 colors | 30 KB | −91% |

All four decoded correctly at 512×512 with alpha.

**Two conclusions that shape the whole plan:**

1. **This beats TinyPNG substantially** (83% vs its typical 60–70%), runs locally in milliseconds,
   needs no API key, and has no rate limit or network round-trip.
2. **Dimension reduction will almost never trigger.** At 256 colors a worst-case tile is 57 KB, so
   any budget of ~75 KB or higher is met at full quality and full size. The downscale rung is a
   genuine last resort, which is the right place for it.

---

## 2. What gets built

```
lib/bg/png8.ts     NEW  quantizer + PNG-8 encoder (pure, worker-safe)
lib/bg/budget.ts   NEW  the search: try encodings until one fits
lib/bg/bg.worker.ts     + an 'encode' message type (reuses the existing pool)
lib/bg/pool.ts          + poolEncode() client
app/bg-remover/page.tsx + toggle, budget input, export wiring, per-file reporting
lib/zip.ts              (unchanged — crc32 is already exported-adjacent, may need exporting)
```

### 2.1 `lib/bg/png8.ts`

- **Histogram-based median cut in RGBA space.** Alpha is part of the color key so soft cutout
  edges get their own palette entries; alpha range is weighted slightly higher than RGB since a
  wrong alpha is more visible than a wrong hue.
- **Optional Floyd–Steinberg dithering** to suppress banding on gradients (costs size and time;
  a setting, not a default decision I should make blind).
- **Encoder**: filter byte 0 per scanline (filtering rarely helps palette images),
  `CompressionStream('deflate')` for IDAT, chunk writer with CRC32.
- API: `encodePng8(pixels: ImageData, opts: { colors: number; dither: boolean }): Promise<Uint8Array>`

**Known engineering task — performance.** My throwaway feasibility quantizer took **975 ms** at
256 colors because it sorts raw pixel-index arrays repeatedly. Production builds a histogram
first (pre-quantize to 5 bits/channel, collapsing 262 k pixels to a few thousand buckets) and
median-cuts over buckets. Target **< 150 ms** per attempt; this is the main thing to benchmark
during implementation, not to assume.

### 2.2 `lib/bg/budget.ts` — the ladder

Per image, stop at the first rung that fits:

```
0. truecolor PNG (today's output)     ← best quality; often already fits a generous budget
1. PNG-8 @ 256 colors
2. PNG-8 @ 128
3. PNG-8 @ 64
4. PNG-8 @ 32
5. downscale ×0.85 and repeat 1–4     ← only if enabled; floor at a minimum edge (e.g. 256 px)
```

Returns `{ bytes, colors, scale, withinBudget }` so the UI can report exactly what each file
needed. Rung 0 matters: it means a loose budget costs one encode and loses nothing.

### 2.3 Where it runs

Quantization is CPU-heavy and the export already taught us main-thread cost is real. The
**existing worker pool is idle during export**, so I'll add an `encode` message type to
`bg.worker.ts` rather than spawning a second pool — reusing its queue, concurrency cap and
lifecycle. Main-thread fallback when workers are unavailable, same as inference.

### 2.4 UI

In the existing **Compression** card (where the TinyPNG key lives):

- `Switch` — **"Limit file size"** (off by default → today's behaviour, bit-for-bit)
- `Input` — **"Max KB per file"**, default **100** (comfortably above the 57 KB worst case)
- `Switch` — **"Shrink dimensions if needed"** (your choice; on by default when the budget is on)
- Both persisted to localStorage like every other setting.

**Export summary** must be honest about what it did: how many tiles were quantized, how many
needed downscaling (with their final dimensions), and any that missed the budget entirely. Silent
degradation is the failure mode to avoid here — you should never discover a tile got shrunk by
finding it on the CDN.

### 2.5 Interaction with TinyPNG

Kept independent and composable: `render → [TinyPNG if keyed] → [budget pass if enabled] → zip`.
TinyPNG runs first when a key is present (its quantizer is good, and its output may already fit,
ending the ladder at rung 0). The budget pass then guarantees the ceiling TinyPNG cannot promise.
Neither feature requires the other.

---

## 3. Verification plan

Correctness first — this writes a binary format by hand, so "it looked fine" is not enough:

1. **Structural**: signature, chunk order, CRCs, IHDR fields; every output re-decoded via
   `createImageBitmap` and compared against the source for dimensions, sampled RGB, and — the
   easy thing to get wrong — **alpha at soft edges**.
2. **Budget**: run a real batch with a 100 KB cap and assert *every* file in the ZIP is ≤ 100 KB
   by reading the ZIP's own entry sizes, not by trusting the UI.
3. **Visual**: side-by-side of truecolor vs 256/64/32 colors on a real product shot, with and
   without dithering, so you can judge where the quality floor is rather than me guessing.
4. **Performance**: per-image encode time and total export time vs today.
5. **Regression**: toggle off → byte-identical output to the current build.

---

## 4. Risks and open questions

| Risk | Handling |
|---|---|
| **Quantization banding** on smooth gradients / soft shadows | Dithering option; the visual comparison in step 3 is where we decide the default palette size |
| **Encode speed** (975 ms naive) | Histogram-based rewrite; benchmark early, before wiring the UI |
| **Downscaled tiles have varying dimensions** | You chose this; the export summary names every affected file. Alternative if you'd rather keep 512×512 fixed: shrink the subject and pad with transparency (cheap to compress) — say the word and I'll make it the behaviour |
| My encoder underperforms Chrome's on some images | Rung 0 keeps truecolor as an option, so we can never do *worse* than today |

**Open questions for you:**

1. **Default budget** — I've assumed **100 KB**. Right ballpark for the CDN?
2. **Compositor too?** The same 600×768 tiles presumably hit the same CDN. The modules are
   shared-ready; wiring the second product is a small add-on phase.
3. **Dithering default** — on (better gradients, slightly bigger) or off (smaller, faster)? Happy
   to decide this from the step-3 comparison rather than up front.

---

## 5. Phases

| # | Work | Verifiable on its own |
|---|---|---|
| 1 | `png8.ts` — quantizer + encoder, performance-tuned | Structural + alpha round-trip tests; size/time table |
| 2 | `budget.ts` — the ladder | Unit-style: synthetic images at known complexities hit expected rungs |
| 3 | Worker offload (`encode` message + `poolEncode`) | Same outputs as main thread, UI stays responsive |
| 4 | UI: toggle, budget input, export wiring, reporting | Real batch under a 100 KB cap; every ZIP entry verified |
| 5 | Visual review + defaults | Side-by-side comparison; lock palette/dither defaults |
| 6 | *(optional)* Compositor export | Same control, same guarantees |

Phases 1–2 are the substance; 3–4 are wiring. The toggle means the feature is safe to land
half-tuned — off is exactly today's behaviour.
