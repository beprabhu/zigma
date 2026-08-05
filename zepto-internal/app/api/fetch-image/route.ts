// GET /api/fetch-image?url=<encoded> — proxy remote images so the canvas isn't tainted and CORS doesn't block.
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return NextResponse.json({ error: 'Provide a valid http(s) url param' }, { status: 400 });
  }
  try {
    const upstream = await fetch(target, { redirect: 'follow' });
    if (!upstream.ok) {
      return NextResponse.json({ error: `Upstream ${upstream.status} for ${target}` }, { status: 502 });
    }
    const buf = await upstream.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `Failed to fetch image: ${(e as Error).message}` }, { status: 502 });
  }
}
