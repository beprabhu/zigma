// GET /api/fetch-image?url=<encoded> — proxy remote images so the canvas isn't tainted, CORS
// doesn't block, and COEP (next.config.ts) sees a same-origin response.
// Also accepts Zepto product PAGE urls (…/pn/<slug>/pvid/<uuid>): those are resolved to the
// product's primary CDN image first (lib/zepto.ts), so CSVs can carry page links directly.
//
// This is a server on the office network fetching caller-supplied URLs, which makes it an SSRF
// primitive unless it refuses to look inward. So it allows any PUBLIC host — a sheet legitimately
// points at whatever brand CDN it likes — and denies everything private: loopback, RFC 1918,
// link-local (where cloud metadata lives), unique-local, and any name that RESOLVES to one of
// those, checked again on every redirect hop so a public URL cannot bounce inward. The one
// exception is the app's own origin, minus /api: the bundled sample sheet points at /samples/*,
// and a URL the caller could already load directly is nothing gained by refusing.
//
// The same request is bounded in time and size. A dead link in a thousand-row sheet must fail
// its row, not hold a server connection open indefinitely; and an image proxy has no business
// buffering a response that could not be an image.
import { NextRequest, NextResponse } from 'next/server';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BROWSER_UA, ZEPTO_CDN_PREFIX, zeptoImagePathsFromHtml, zeptoPvidFromUrl } from '@/lib/zepto';

/** The whole request — page resolution, redirects, headers and body — shares this one budget. */
const TIMEOUT_MS = 20_000;
/** Product photography tops out in single-digit MB; anything past this is not a tile source. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * The ranges a caller must not be able to reach through this server.
 *
 * 100.64.0.0/10 (RFC 6598 shared address space) is deliberately NOT here, though the textbook
 * says it should be. On Zepto's network that range is not the internal estate — it is where the
 * corporate resolver puts the company's own PUBLIC assets: zepto.com answers 100.64.1.8 and the
 * S3 product-image bucket answers 100.64.1.6, both fetched happily and both refused by an earlier
 * version of this guard. Blocking it bought nothing an attacker cares about — reaching this
 * machine's own services means 127/8, and the LAN means RFC 1918, both still refused — while
 * breaking the single thing the proxy exists to do.
 */
function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||          // link-local, incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::' || v6 === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return isPrivateV4(mapped[1]);
    return /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6); // fc00::/7 unique-local, fe80::/10 link-local
  }
  return true; // not an address at all — never trust it
}

function portOf(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/**
 * The image this actually is, read from its first bytes, or null if it is not one.
 *
 * A stored object's declared type cannot be trusted: Zepto's S3 bucket serves genuine JPEGs as
 * `binary/octet-stream`, which is S3's default for anything uploaded without a type. Refusing on
 * the label alone rejected real product photos; accepting the label alone would let this route
 * hand back a page of HTML. The signature is the thing that is actually true.
 */
function sniffImageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  const ascii = (at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  // ISO-BMFF: AVIF and HEIC both carry their brand at offset 4.
  if (ascii(4, 'ftyp')) {
    if (ascii(8, 'avif') || ascii(8, 'avis')) return 'image/avif';
    if (ascii(8, 'heic') || ascii(8, 'heix') || ascii(8, 'mif1')) return 'image/heic';
  }
  return null;
}

/**
 * The hosts this tool exists to read, trusted by NAME rather than by where they resolve.
 *
 * Zepto's own domains land inside 100.64.0.0/10 on the corporate network — shared address space,
 * which the range check below rightly distrusts for a caller-supplied target. That check asks the
 * wrong question here: the danger in an SSRF is the caller CHOOSING an internal address, and no
 * caller can choose what zepto.com resolves to without owning its DNS (the rebinding residual this
 * route already documents). So these names are settled before any address is looked at.
 *
 * It also makes uniform a trust the route was already extending unevenly: the product-page branch
 * below fetches zepto.com with no check at all, while every other zepto.com URL got the strictest
 * treatment and was refused.
 */
const FIRST_PARTY_HOSTS = new Set([
  'zepto.com', 'www.zepto.com',
  'zeptonow.com', 'www.zeptonow.com', 'cdn.zeptonow.com',
]);

/**
 * The catalogue's images are served from an S3 bucket as well as the CDN — real sheets carry
 * `prod-zepto-public-assets.s3.<region>.amazonaws.com` URLs — so the bucket is first-party too.
 * Matched on the bucket name rather than a bare amazonaws.com suffix, which would hand every S3
 * bucket on earth a pass through the guard.
 */
function isFirstParty(host: string): boolean {
  if (FIRST_PARTY_HOSTS.has(host) || host.endsWith('.zeptonow.com')) return true;
  return /^prod-zepto-[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
}

/** Why `target` must not be fetched, or null when it may be. Resolves names to check them. */
async function refusal(target: URL, own: URL): Promise<string | null> {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'Only http(s) URLs are proxied';
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ownHost = own.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === ownHost && portOf(target) === portOf(own) && target.protocol === own.protocol) {
    // Never itself: pointed at /api the proxy would loop, or spend Azure money on the caller's behalf.
    return target.pathname.startsWith('/api/') ? 'The proxy does not fetch its own API routes' : null;
  }
  if (isFirstParty(host)) return null;
  if (host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(host)) {
    return 'Private hosts are not proxied';
  }
  if (isIP(host)) return isPrivateIp(host) ? 'Private addresses are not proxied' : null;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return `Could not resolve ${host}`;
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    return 'Private addresses are not proxied';
  }
  return null;
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url');
  if (!raw || !/^https?:\/\//i.test(raw)) {
    return NextResponse.json({ error: 'Provide a valid http(s) url param' }, { status: 400 });
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: 'Provide a valid http(s) url param' }, { status: 400 });
  }
  const own = req.nextUrl;
  // The caller's own Accept goes upstream: CDNs that negotiate format (f-auto) then hand each
  // device something it can decode, instead of whatever a server-side default happens to get.
  const accept = req.headers.get('accept') || 'image/*,*/*;q=0.8';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const pvid = zeptoPvidFromUrl(target.href);
    if (pvid) {
      // The page host is pinned by zeptoPvidFromUrl's pattern; the CDN URL it yields is checked
      // below like any other target.
      const page = await fetch(target, {
        redirect: 'follow',
        headers: { 'User-Agent': BROWSER_UA },
        signal: controller.signal,
      });
      if (!page.ok) {
        return NextResponse.json({ error: `Upstream ${page.status} for ${target.href}` }, { status: 502 });
      }
      const paths = zeptoImagePathsFromHtml(await page.text(), pvid);
      if (!paths.length) {
        return NextResponse.json({ error: `No gallery found on ${target.href}` }, { status: 502 });
      }
      target = new URL(ZEPTO_CDN_PREFIX + paths[0]);
    }

    // Redirects are followed by hand so every hop is checked: `redirect: 'follow'` would let a
    // public URL answer 302 into an address the guard just refused.
    let upstream: Response;
    for (let hop = 0; ; hop++) {
      const refused = await refusal(target, own);
      if (refused) return NextResponse.json({ error: refused }, { status: 403 });
      upstream = await fetch(target, {
        redirect: 'manual',
        headers: { 'User-Agent': BROWSER_UA, Accept: accept },
        signal: controller.signal,
      });
      const location = upstream.headers.get('location');
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        await upstream.body?.cancel();
        if (hop >= MAX_REDIRECTS) {
          return NextResponse.json({ error: 'Too many redirects' }, { status: 502 });
        }
        target = new URL(location, target);
        continue;
      }
      break;
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return NextResponse.json({ error: `Upstream ${upstream.status} for ${target.href}` }, { status: 502 });
    }

    // An image proxy returns images. A type that names something else — HTML, JSON — is refused on
    // the spot; an octet-stream or a missing type is UNDECIDED and settled by the bytes below,
    // because that is what a store with no type recorded against the object sends.
    const type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const undecided = !type || type.endsWith('/octet-stream');
    if (!type.startsWith('image/') && !undecided) {
      await upstream.body?.cancel();
      return NextResponse.json({ error: `Not an image (${type})` }, { status: 415 });
    }
    const declared = Number(upstream.headers.get('content-length'));
    if (declared > MAX_BYTES) {
      await upstream.body?.cancel();
      return NextResponse.json({ error: `Image is larger than ${MAX_BYTES / (1024 * 1024)} MB` }, { status: 413 });
    }

    // Read in chunks against the cap, not arrayBuffer(): a server that lies about (or omits)
    // its length would otherwise be buffered in full before anyone could measure it.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = upstream.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          return NextResponse.json({ error: `Image is larger than ${MAX_BYTES / (1024 * 1024)} MB` }, { status: 413 });
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const sniffed = sniffImageType(body);
    if (undecided && !sniffed) {
      return NextResponse.json(
        { error: `Not an image (${type || 'no content type'}, and the bytes are not one either)` },
        { status: 415 },
      );
    }
    return new NextResponse(body.buffer, {
      status: 200,
      headers: {
        // The sniffed type wins over an undecided label, so the browser is told what it truly got.
        'Content-Type': sniffed && undecided ? sniffed : type,
        'Cache-Control': 'no-store',
        // The body depends on the caller's Accept (see above), so no cache may serve one client's
        // format to another.
        Vary: 'Accept',
      },
    });
  } catch (e) {
    if (controller.signal.aborted) {
      return NextResponse.json({ error: `Timed out after ${TIMEOUT_MS / 1000}s` }, { status: 504 });
    }
    return NextResponse.json({ error: `Failed to fetch image: ${(e as Error).message}` }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
