// How long Azure asked us to wait after a 429. Pure and dependency-free on purpose: the server
// route parses it out of the upstream response, and keeping it here means the client never has
// to interpret Azure's headers itself — it receives one number.

/**
 * Milliseconds to wait, from a 429's `Retry-After` header (delta-seconds or an HTTP-date) or,
 * failing that, the "Please retry after N seconds" sentence Azure puts in the error message.
 * null when nothing stated a time — the caller picks its own back-off.
 */
export function parseRetryAfter(header: string | null, message: string, now = Date.now()): number | null {
  if (header) {
    const value = header.trim();
    if (/^\d+$/.test(value)) return Number(value) * 1000;
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const m = /retry after (\d+) second/i.exec(message);
  return m ? Number(m[1]) * 1000 : null;
}
