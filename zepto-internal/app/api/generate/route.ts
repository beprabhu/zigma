// POST /api/generate — two Azure image APIs behind one route, selected by `mode`:
//   mode 'edits' (default) — { endpoint, apiKey, prompt, images: [dataURL, ...], quality,
//     background, size } → multipart to /openai/v1/images/edits. Editing SOURCE images; what
//     the Compositor and the BG Remover's AI edit use.
//   mode 'generations' — { endpoint, apiKey, prompt, quality, size } → JSON to
//     /openai/v1/images/generations. Text only, no input image; what the Image Generator uses.
// Both answer { b64 }. 'edits' stays the default so existing callers are untouched.
import { NextRequest, NextResponse } from 'next/server';
import { parseRetryAfter } from '@/lib/retry-after';
import { PayloadTooLarge, isAzureImageEndpoint, readBodyCapped } from '@/lib/api-guard';

/**
 * Waits between 5xx attempts, jittered so the lanes a batch runs do not retry in lockstep, and
 * abort-aware so the Stop button ends a wait as promptly as it ends a request.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Only what a retry can actually fix, and only briefly. A 5xx means Azure or something in front
 * of it hiccuped; one or two spaced attempts recover most of those, and stopping there keeps a
 * dead deployment from holding the request open for minutes. A 429 is NOT retried here — it goes
 * back to the client at once with Azure's stated wait, because the client's shared throttle
 * (lib/rate.ts) can hold every lane in the tab, which one request sleeping here cannot.
 * Every other 4xx is the request's own fault, and retrying it buys the same answer again.
 */
const RETRY_5XX_DELAYS_MS = [1_000, 2_000];

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function dataUrlToBuffer(dataUrl: string): Buffer {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) throw new Error('Invalid data URL');
  return Buffer.from(m[3], m[2] ? 'base64' : 'utf8');
}

export async function POST(req: NextRequest) {
  let body: {
    endpoint?: string; apiKey?: string; prompt?: string;
    images?: string[]; quality?: string; background?: string; size?: string;
    mode?: 'edits' | 'generations' | 'ping';
  };
  try {
    // Up to a handful of 1024px references as base64 data URLs; a body past this is not a
    // generation request.
    body = JSON.parse(new TextDecoder().decode(await readBodyCapped(req, MAX_BODY_BYTES)));
  } catch (e) {
    if (e instanceof PayloadTooLarge) return e.response();
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // size 'auto' (the API default) follows the INPUT's aspect ratio — callers sending cropped
  // references pass an explicit size so the output stays a square tile.
  const {
    endpoint, apiKey, prompt, images, quality = 'low', background = 'auto', size = 'auto',
    mode = 'edits',
  } = body || {};
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) return NextResponse.json({ error: 'Missing/invalid Azure endpoint' }, { status: 400 });
  // Bring-your-own-endpoint, but it has to BE Azure: with the caller's key attached, an
  // unconstrained origin would make this route a proxy anyone on the network could aim anywhere.
  if (!isAzureImageEndpoint(endpoint)) {
    return NextResponse.json(
      { error: 'The endpoint must be an Azure OpenAI resource (https://<resource>.openai.azure.com or .services.ai.azure.com)' },
      { status: 400 },
    );
  }
  if (!apiKey) return NextResponse.json({ error: 'Missing Azure API key' }, { status: 400 });

  // mode 'ping' — the Settings modal's free credential check: GET the models index, which
  // authenticates without generating anything. Proves host + key, NOT that gpt-image-2 is
  // deployed on the resource — only a real generation proves that.
  if (mode === 'ping') {
    try {
      const res = await fetch(new URL(endpoint).origin + '/openai/v1/models', {
        headers: { 'api-key': apiKey, Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return NextResponse.json({ ok: true });
      const detail =
        res.status === 401 || res.status === 403
          ? 'Azure rejected the API key.'
          : `Azure answered ${res.status}.`;
      return NextResponse.json({ error: detail }, { status: res.status });
    } catch (e) {
      return NextResponse.json(
        { error: `Could not reach the resource: ${(e as Error).message}` },
        { status: 502 },
      );
    }
  }

  if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
  // Only edits needs an input image; generations is text-only by definition.
  if (mode === 'edits' && (!Array.isArray(images) || images.length === 0)) {
    return NextResponse.json({ error: 'No images provided' }, { status: 400 });
  }

  // Accept either a bare resource URL or a full API URL pasted from the Azure portal — keep
  // only the origin, then append the path this mode needs. That is why pasting the edits URL
  // into the Image Generator (or vice versa) still works.
  const origin = new URL(endpoint).origin;
  const generations = mode === 'generations';
  const url = origin + (generations ? '/openai/v1/images/generations' : '/openai/v1/images/edits');

  let payload: BodyInit;
  const headers: Record<string, string> = { 'api-key': apiKey, 'Authorization': `Bearer ${apiKey}` };

  if (generations) {
    // JSON, not multipart: there is no file part to send. `background` is deliberately omitted
    // — its default is 'auto' anyway, and passing it has no input image to key off.
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify({ model: 'gpt-image-2', prompt, quality, size, n: 1 });
  } else {
    const fd = new FormData();
    fd.append('model', 'gpt-image-2');
    fd.append('prompt', prompt);
    fd.append('background', background);
    fd.append('quality', quality);
    fd.append('size', size);
    (images ?? []).forEach((dataUrl, i) => {
      const buf = dataUrlToBuffer(dataUrl);
      fd.append('image[]', new Blob([new Uint8Array(buf)], { type: 'image/png' }), `image_${i}.png`);
    });
    payload = fd;
  }

  try {
    // req.signal fires when the browser aborts (the Stop button) — forwarding it drops the
    // Azure connection instead of letting an unwanted generation run to completion.
    let upstream: Response;
    let retried = 0;
    for (;;) {
      upstream = await fetch(url, { method: 'POST', headers, body: payload, signal: req.signal });
      if (upstream.status < 500 || retried >= RETRY_5XX_DELAYS_MS.length || req.signal.aborted) break;
      // Drain before waiting so the socket is returned rather than held across the pause.
      await upstream.text().catch(() => undefined);
      const base = RETRY_5XX_DELAYS_MS[retried];
      await sleep(Math.round(base * (0.8 + Math.random() * 0.4)), req.signal);
      retried += 1;
    }
    const text = await upstream.text();
    let json: {
      error?: { message?: string } | string;
      data?: { b64_json?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 2000) }; }
    if (!upstream.ok) {
      const err = json?.error;
      const msg = (typeof err === 'object' ? err?.message : err) || `Azure returned ${upstream.status}`;
      console.error(`[generate] Azure error ${upstream.status} from ${url}:`, text.slice(0, 1000));
      if (upstream.status === 429) {
        return NextResponse.json(
          { error: msg, rateLimited: true, retryAfterMs: parseRetryAfter(upstream.headers.get('retry-after'), msg) },
          { status: 429 },
        );
      }
      return NextResponse.json({ error: msg, ...(retried ? { retried } : null) }, { status: upstream.status });
    }
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) return NextResponse.json({ error: 'Azure response missing image data' }, { status: 502 });
    // usage passthrough: the client-side ledger (lib/usage.ts) totals tokens per mode for the
    // Settings modal's Usage pane. Absent on API versions that don't report it — pass null.
    return NextResponse.json({ b64, usage: json?.usage ?? null });
  } catch (e) {
    return NextResponse.json({ error: `Azure request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
