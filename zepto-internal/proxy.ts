// The door. This app is served on 0.0.0.0 from developer Macs, which puts its pages — and the
// Azure budget behind them — one URL away from everyone on the office network. When
// ZIGMA_ACCESS_TOKEN is set, every request has to carry that token; when it is unset, nothing
// here runs and a plain `pnpm dev` behaves exactly as it always has.
//
// The token is a shared password, not an identity: it says "this browser was given the link",
// nothing about who is holding it. That is the right size of lock for an internal tool whose
// worst case is someone else's Azure bill.
//
// Three ways in, checked in order:
//   ?token=<secret> on any page URL — the link an admin shares. It sets the cookie and redirects
//     to the same URL with the query stripped, so the secret never sits in the address bar.
//   the cookie that link set — httpOnly, so page scripts (and anything injected into one) never
//     see it; sameSite=lax, so a link from elsewhere still opens the app.
//   Authorization: Bearer <secret> — for curl and scripts.
import { NextRequest, NextResponse } from 'next/server';

const COOKIE = 'zigma_access';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Equal-time comparison: a plain === leaks how many leading characters matched. */
function sameSecret(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function proxy(req: NextRequest) {
  const expected = process.env.ZIGMA_ACCESS_TOKEN?.trim();
  if (!expected) return NextResponse.next();

  const url = req.nextUrl;
  const offered = url.searchParams.get('token');
  if (offered !== null) {
    if (!sameSecret(offered, expected)) return refuse(req);
    const clean = url.clone();
    clean.searchParams.delete('token');
    const res = NextResponse.redirect(clean);
    res.cookies.set(COOKIE, expected, {
      httpOnly: true,
      sameSite: 'lax',
      secure: url.protocol === 'https:',
      path: '/',
      maxAge: COOKIE_MAX_AGE_S,
    });
    return res;
  }

  const cookie = req.cookies.get(COOKIE)?.value ?? '';
  if (sameSecret(cookie, expected)) return NextResponse.next();

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim() ?? '';
  if (sameSecret(bearer, expected)) return NextResponse.next();

  return refuse(req);
}

function refuse(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Access token required' }, { status: 401 });
  }
  // A page, so a person is looking: say what is needed in words, not a JSON blob.
  const html = `<!doctype html><meta charset="utf-8"><title>Zigma — access token required</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:6rem auto;padding:0 1.5rem;color:#222}code{background:#eee;padding:.1em .35em;border-radius:4px}</style>
<h1 style="font-size:1.25rem">This Zigma needs an access token</h1>
<p>Open the link you were given — it ends in <code>?token=…</code>. Once you have opened it once in this browser, you can use the plain address.</p>`;
  return new NextResponse(html, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export const config = {
  // Everything except Next's own build assets, which are hashed and hold nothing private.
  matcher: ['/((?!_next/).*)'],
};
