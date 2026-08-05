// POST /api/generate — { endpoint, apiKey, prompt, images: [dataURL, ...], quality, background }
// Calls Azure OpenAI /openai/v1/images/edits with model gpt-image-2.
import { NextRequest, NextResponse } from 'next/server';

function dataUrlToBuffer(dataUrl: string): Buffer {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) throw new Error('Invalid data URL');
  return Buffer.from(m[3], m[2] ? 'base64' : 'utf8');
}

export async function POST(req: NextRequest) {
  let body: {
    endpoint?: string; apiKey?: string; prompt?: string;
    images?: string[]; quality?: string; background?: string; size?: string;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }

  // size 'auto' (the API default) follows the INPUT's aspect ratio — callers sending cropped
  // references pass an explicit size so the output stays a square tile.
  const { endpoint, apiKey, prompt, images, quality = 'low', background = 'auto', size = 'auto' } = body || {};
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) return NextResponse.json({ error: 'Missing/invalid Azure endpoint' }, { status: 400 });
  if (!apiKey) return NextResponse.json({ error: 'Missing Azure API key' }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
  if (!Array.isArray(images) || images.length === 0) return NextResponse.json({ error: 'No images provided' }, { status: 400 });

  // Accept either a bare resource URL or a full API URL pasted from the Azure portal —
  // keep only the origin, then append the edits path.
  const url = new URL(endpoint).origin + '/openai/v1/images/edits';
  const fd = new FormData();
  fd.append('model', 'gpt-image-2');
  fd.append('prompt', prompt);
  fd.append('background', background);
  fd.append('quality', quality);
  fd.append('size', size);
  images.forEach((dataUrl, i) => {
    const buf = dataUrlToBuffer(dataUrl);
    fd.append('image[]', new Blob([new Uint8Array(buf)], { type: 'image/png' }), `image_${i}.png`);
  });

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Authorization': `Bearer ${apiKey}` },
      body: fd,
    });
    const text = await upstream.text();
    let json: { error?: { message?: string } | string; data?: { b64_json?: string }[] };
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 2000) }; }
    if (!upstream.ok) {
      const err = json?.error;
      const msg = (typeof err === 'object' ? err?.message : err) || `Azure returned ${upstream.status}`;
      console.error(`[generate] Azure error ${upstream.status} from ${url}:`, text.slice(0, 1000));
      return NextResponse.json({ error: msg }, { status: upstream.status });
    }
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) return NextResponse.json({ error: 'Azure response missing image data' }, { status: 502 });
    return NextResponse.json({ b64 });
  } catch (e) {
    return NextResponse.json({ error: `Azure request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
