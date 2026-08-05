// POST /api/compress — raw PNG body, header x-tinify-key. Returns compressed image bytes.
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const key = req.headers.get('x-tinify-key');
  if (!key) return NextResponse.json({ error: 'Missing x-tinify-key header' }, { status: 400 });
  const png = await req.arrayBuffer();
  if (!png.byteLength) return NextResponse.json({ error: 'Empty body' }, { status: 400 });

  const auth = 'Basic ' + Buffer.from('api:' + key).toString('base64');
  try {
    const shrink = await fetch('https://api.tinify.com/shrink', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/octet-stream' },
      body: png,
    });
    const meta = await shrink.json().catch(() => ({}));
    if (!shrink.ok) {
      console.error(`[compress] TinyPNG error ${shrink.status}:`, JSON.stringify(meta).slice(0, 500));
      return NextResponse.json({ error: meta?.message || `TinyPNG returned ${shrink.status}` }, { status: shrink.status });
    }
    const outUrl = shrink.headers.get('location') || meta?.output?.url;
    if (!outUrl) return NextResponse.json({ error: 'TinyPNG response missing output URL' }, { status: 502 });
    const dl = await fetch(outUrl, { headers: { 'Authorization': auth } });
    if (!dl.ok) return NextResponse.json({ error: `TinyPNG download failed (${dl.status})` }, { status: 502 });
    const buf = await dl.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'X-Input-Size': String(png.byteLength),
        'X-Output-Size': String(buf.byteLength),
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `TinyPNG request failed: ${(e as Error).message}` }, { status: 502 });
  }
}
