// Proxy to the optional Qwen2.5-VL sidecar — Ollama, running the one model that answers the
// question 33 geometry numbers structurally cannot: "is there anything in this frame besides
// the product?" Props, flat-lays and stray banners are half of all bad cutouts, and the fitted
// tree model stalls near 65% recall on them because none of its inputs encode "a bowl".
//
//   ollama serve && ollama pull qwen2.5vl:7b
//
// Same shape as remove-hq: the browser cannot call port 11434 directly (this app is
// cross-origin isolated, so a cross-origin fetch without CORP headers is blocked), so the call
// is routed through here to keep it same-origin.
//
//   GET  -> health probe; reports whether the vision model is actually pulled, not just that
//           Ollama answered, so the UI can hide the pass instead of failing per image
//   POST -> JPEG bytes in, {extra, what} out
import { NextRequest, NextResponse } from 'next/server';
import { PayloadTooLarge, readBodyCapped } from '@/lib/api-guard';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.SEMANTIC_MODEL ?? 'qwen2.5vl:7b';
/** The white-flattened cutout the checker looks at — a PNG, single-digit MB. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Measured 93.1% recall on semantic defects / 77.0% specificity, zero-shot, over 405 labelled
 * catalogue images. Two harness lessons are baked into it and must not be undone:
 *
 *  1. ONE short question. An earlier variant folded extras and damage into a single checklist
 *     and collapsed to 12% — it answered "no problem" to everything with an empty reason.
 *  2. The image must be the cutout ALONE, flattened onto white (see renderForSemantic). Fed the
 *     side-by-side judging sheet on a transparency checkerboard, the same model scored 20% and
 *     once named the checkerboard itself as the extra object.
 *
 * The face clauses follow the catalogue owner's 2026-08-15 ruling: a face is fine on genuine
 * worn clothing, never on anything else, and a presenting hand is bad either way.
 */
const PROMPT = `This is a product photo for an online store catalogue. It should show exactly ONE retail product and nothing else.

Look carefully at everything in the image. Is anything present besides the single product itself?

Things that count as extra:
- props or decoration: bowls, plates, spoons, cloth, flowers, leaves, scattered ingredients, food styling, stands or pedestals
- the product's contents spilled or smeared outside the package (loose food, powder, cream swatches)
- floating text, banners, badges, labels, or marketing graphics that are NOT printed on the package
- a person's face or body shown with a product that is NOT clothing
- a hand holding, pinching or presenting the product (this counts even for clothing)
- more than one unit of the item, several colour variants, or multiple photos combined

Things that do NOT count as extra:
- pictures, text and logos printed ON the product's own packaging
- one product shown together with its own retail box
- a multi-piece set sold as one product (a pair of gloves, a tool kit)
- clothing worn on a person, including that person's face

Answer with ONLY this JSON:
{"extra": "yes" or "no", "what": "<name the extra thing briefly, or empty>"}`;

export async function GET() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json(
        { available: false, reason: `Ollama returned ${res.status}` },
        { status: 503 },
      );
    }
    // Ollama being up is not the same as the model being pulled: without this check every
    // image would fail one at a time with a 404 instead of the pass simply staying hidden.
    const body = (await res.json()) as { models?: { name?: string }[] };
    const has = (body.models ?? []).some((m) => m.name === MODEL);
    if (!has) {
      return NextResponse.json(
        { available: false, reason: `${MODEL} is not pulled — run: ollama pull ${MODEL}` },
        { status: 503 },
      );
    }
    return NextResponse.json({ available: true, model: MODEL });
  } catch (e) {
    return NextResponse.json({ available: false, reason: (e as Error).message }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readBodyCapped(req, MAX_IMAGE_BYTES);
  } catch (e) {
    if (e instanceof PayloadTooLarge) return e.response();
    throw e;
  }
  if (!body.byteLength) return NextResponse.json({ error: 'Empty body' }, { status: 400 });

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Greedy and seeded: the same cutout must produce the same verdict on a re-run, or the
      // flag stops being reproducible evidence. Matches the settings the 93% eval measured.
      body: JSON.stringify({
        model: MODEL,
        prompt: PROMPT,
        images: [Buffer.from(body).toString('base64')],
        stream: false,
        options: { temperature: 0, seed: 7, num_predict: 100 },
      }),
      // The first call pulls ~6 GB of weights into memory; steady state is ~6 s per image.
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json(
        { error: text || `Ollama returned ${res.status}` },
        { status: res.status },
      );
    }

    const raw = String(((await res.json()) as { response?: string }).response ?? '').trim();
    // Strict parse only. No regex salvage, no substring repair, no defaulting a malformed
    // answer to "no" — a silent default would quietly mark unreadable rows clean, which is the
    // one failure mode a quality flag cannot have. Unparsed rows report themselves as unparsed
    // and the caller leaves the item's verdict alone.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return NextResponse.json({ parsed: false, raw: raw.slice(0, 200) });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return NextResponse.json({ parsed: false, raw: raw.slice(0, 200) });
    }
    const answer = parsed as { extra?: unknown; what?: unknown };
    const extra = String(answer.extra ?? '').toLowerCase();
    if (extra !== 'yes' && extra !== 'no') {
      return NextResponse.json({ parsed: false, raw: raw.slice(0, 200) });
    }
    return NextResponse.json({
      parsed: true,
      extra: extra === 'yes',
      what: String(answer.what ?? '').slice(0, 120),
      model: MODEL,
    });
  } catch (e) {
    // Same rule as remove-hq: the address and the start command go to the log, not the client.
    console.error(`[semantic] Ollama unreachable at ${OLLAMA_URL} — start it with: ollama serve`, e);
    return NextResponse.json(
      { error: 'The semantic-check sidecar is not running. Turn the check off, or ask whoever runs this server to start it.' },
      { status: 502 },
    );
  }
}
