// Proxy to the optional RMBG-2.0 sidecar — a local PyTorch server that runs the one model too
// heavy for the browser runtime. It lives in the bg-remover prototype:
//
//   cd ~/Documents/bg-remover && venv/bin/python hq_server.py
//
// The browser cannot call port 5002 directly: this app is cross-origin isolated
// (Cross-Origin-Embedder-Policy: require-corp), so any cross-origin fetch without CORP headers
// is blocked. Routing through here keeps it same-origin.
//
//   GET  -> health probe, so the UI can hide the model when the sidecar is down
//   POST -> raw image bytes in, RGBA PNG out
import { NextRequest, NextResponse } from 'next/server';

const HQ_URL = process.env.HQ_SERVER_URL ?? 'http://127.0.0.1:5002';

export async function GET() {
  try {
    const res = await fetch(`${HQ_URL}/health`, {
      signal: AbortSignal.timeout(1500),
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ available: false, reason: `sidecar returned ${res.status}` }, { status: 503 });
    }
    return NextResponse.json({ available: true, url: HQ_URL });
  } catch (e) {
    return NextResponse.json(
      { available: false, reason: (e as Error).message },
      { status: 503 }
    );
  }
}

export async function POST(req: NextRequest) {
  const body = await req.arrayBuffer();
  if (!body.byteLength) return NextResponse.json({ error: 'Empty body' }, { status: 400 });

  try {
    // First load pulls ~844 MB of weights onto the GPU, so the ceiling is generous.
    const res = await fetch(`${HQ_URL}/remove`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json(
        { error: text || `Background server returned ${res.status}` },
        { status: res.status }
      );
    }
    const png = await res.arrayBuffer();
    return new NextResponse(png, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.byteLength) },
    });
  } catch (e) {
    return NextResponse.json(
      {
        error:
          `Cannot reach the RMBG-2.0 sidecar at ${HQ_URL}. ` +
          `Start it with: cd ~/Documents/bg-remover && venv/bin/python hq_server.py (${(e as Error).message})`,
      },
      { status: 502 }
    );
  }
}
