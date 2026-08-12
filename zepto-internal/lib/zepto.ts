// Resolve Zepto product PAGE urls (www.zepto.com/pn/<slug>/pvid/<uuid>) into image CDN urls.
// The CDN image id is a separate asset uuid with no derivable relation to the pvid, so the only
// mapping is the page itself: its embedded Next.js payload carries the gallery right next to the
// pvid as `"<pvid>","images":[{"path":"cms/product_variant/<id>.jpeg"},…]`. Server-side only —
// zepto.com sends no CORS headers, and COEP (next.config.ts) blocks cross-origin fetches anyway.

const PAGE_URL_RE = /^https?:\/\/(?:www\.)?zepto\.com\/pn\/[^/]+\/pvid\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// w-1024 matches the pipeline's preprocess cap (lib/pipeline.ts); q-80 keeps compression
// artifacts out of composites. The tr: segment is ImageKit params — safe to tune.
export const ZEPTO_CDN_PREFIX =
  'https://cdn.zeptonow.com/production/tr:w-1024,pr-true,f-auto,q-80/';

// Zepto blocks default fetch UAs; a browser UA is enough (no auth or store cookie needed).
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** The pvid when `url` is a Zepto product page, else null. Cheap — safe to call per fetch. */
export function zeptoPvidFromUrl(url: string): string | null {
  const m = PAGE_URL_RE.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Gallery image paths (`cms/product_variant/<id>.jpeg`, primary first) for `pvid`, parsed out
 * of the page HTML. The payload repeats the gallery several times (hero preload, og:image,
 * hydration data); we take the array adjacent to the pvid because the page also embeds the
 * galleries of every "recommended" product — matching on path alone grabs the wrong SKUs.
 */
export function zeptoImagePathsFromHtml(html: string, pvid: string): string[] {
  // The payload lives inside an escaped JS string, so quotes may appear as \" — hence \\?" .
  const anchor = new RegExp(pvid + '\\\\?",\\\\?"images\\\\?":\\s*(\\[)', 'i');
  const m = anchor.exec(html);
  if (!m) return [];
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [];
  let chunk = html.slice(start, end + 1);
  if (chunk.includes('\\"')) chunk = chunk.replace(/\\"/g, '"');
  try {
    const items = JSON.parse(chunk) as Array<{ path?: string }>;
    return items.map((it) => it?.path).filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}
