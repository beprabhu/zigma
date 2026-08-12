// GET /api/fetch-image?url=<encoded> — proxy remote images so the canvas isn't tainted and CORS doesn't block.
// Also accepts Zepto product PAGE urls (…/pn/<slug>/pvid/<uuid>): those are resolved to the
// product's primary CDN image first (lib/zepto.ts), so CSVs can carry page links directly.
import { NextRequest, NextResponse } from 'next/server';
import { BROWSER_UA, ZEPTO_CDN_PREFIX, zeptoImagePathsFromHtml, zeptoPvidFromUrl } from '@/lib/zepto';

export async function GET(req: NextRequest) {
  let target = req.nextUrl.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return NextResponse.json({ error: 'Provide a valid http(s) url param' }, { status: 400 });
  }
  try {
    const pvid = zeptoPvidFromUrl(target);
    if (pvid) {
      const page = await fetch(target, {
        redirect: 'follow',
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(30_000),
      });
      if (!page.ok) {
        return NextResponse.json({ error: `Upstream ${page.status} for ${target}` }, { status: 502 });
      }
      const paths = zeptoImagePathsFromHtml(await page.text(), pvid);
      if (!paths.length) {
        return NextResponse.json({ error: `No gallery found on ${target}` }, { status: 502 });
      }
      target = ZEPTO_CDN_PREFIX + paths[0];
    }
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
