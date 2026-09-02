// Client-side image pipeline: fetch via proxy, preprocess, call Azure, decode result.

import { readImageQuality, type ImageQuality } from '@/lib/quality';
import { acquireRpmSlot, clearPenalty, penalize } from '@/lib/rate';
import { recordUsage, type AzureUsage } from '@/lib/usage';

/**
 * The same-origin URL that serves a remote image through the proxy.
 *
 * Exported so an `<img src>` can point straight at it. That is worth doing rather than fetching
 * into a blob: the browser then owns the request — native lazy-loading, its own cache, and no
 * object URL for anyone to leak — which is what makes it safe to put a preview on every row of a
 * sheet with thousands of them.
 */
export function proxiedImageUrl(url: string): string {
  return '/api/fetch-image?url=' + encodeURIComponent(url);
}

export async function loadImageFromUrl(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  const res = await fetch(proxiedImageUrl(url), { signal });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to fetch ${url}`);
  }
  const blob = await res.blob();
  return blobToImage(blob);
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Image decode failed')); };
    img.src = URL.createObjectURL(blob);
  });
}

// Downscale to max 1024px on longest side, convert to PNG data URL.
export function preprocess(img: HTMLImageElement): string {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const scale = Math.min(1, 1024 / Math.max(iw, ih));
  const w = Math.round(iw * scale), h = Math.round(ih * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/png');
}

export function b64ToImage(b64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Result image decode failed'));
    img.src = 'data:image/png;base64,' + b64;
  });
}

// Mock composite: draw source images side by side on white (for testing without Azure, ?mock=1).
export function mockComposite(images: HTMLImageElement[]): Promise<HTMLImageElement> {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1024, 1024);
  const n = images.length;
  const cell = 1024 / n;
  images.forEach((img, i) => {
    const s = Math.min((cell * 0.9) / img.naturalWidth, 900 / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    ctx.drawImage(img, i * cell + (cell - w) / 2, 1000 - h, w, h); // shared baseline
  });
  return new Promise((resolve) => {
    const out = new Image();
    out.onload = () => resolve(out);
    out.src = c.toDataURL('image/png');
  });
}

/** An Azure answer that was not an image. `status` is Azure's; 429 carries its stated wait. */
export class AzureError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = 'AzureError';
  }
}

/** One rate-limited retry, as reported to a caller that wants to show it. */
export interface RetryInfo {
  attempt: number;
  of: number;
  /** When the tab will let the row try again. */
  until: number;
}

/** 429 retries per call — five attempts in all, each one paced by the shared gate. */
const RATE_LIMIT_RETRIES = 4;

/**
 * The proxy round trip, retried through the shared gate on 429.
 *
 * The retry lives HERE, not in the route, because a 429 is information every lane needs: the
 * moment one row learns Azure is throttling, penalize() holds the whole tab, and the next
 * acquireRpmSlot — this one and every other lane's — waits it out together, then re-admits at
 * the pace Azure asked for. A route that slept and retried privately would leave the other
 * lanes firing into the same limit. The body is built once by the caller and re-sent as-is;
 * the hop it re-sends over is localhost, and the Azure leg costs the same wherever the loop is.
 */
async function postGenerate(
  body: string,
  signal: AbortSignal | undefined,
  onRetry: ((retry: RetryInfo) => void) | undefined,
): Promise<{ b64: string; usage: AzureUsage | null }> {
  for (let attempt = 0; ; attempt++) {
    await acquireRpmSlot(signal);
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      clearPenalty();
      return json;
    }
    const error = new AzureError(
      json.error || `Generate failed (${res.status})`,
      res.status,
      typeof json.retryAfterMs === 'number' ? json.retryAfterMs : null,
    );
    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) throw error;
    const wait = penalize(error.retryAfterMs);
    onRetry?.({ attempt: attempt + 1, of: RATE_LIMIT_RETRIES, until: Date.now() + wait });
  }
}

export async function callAzure(
  images: HTMLImageElement[],
  opts: {
    endpoint: string;
    apiKey: string;
    prompt: string;
    /** Omit — the suite-wide Settings value applies. Only pass to pin one call site. */
    quality?: ImageQuality;
    /** 'auto' (default) follows the input's aspect; pass '1024x1024' to force a square tile. */
    size?: 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
    /** Stop button support: aborts the proxy request (the route forwards the abort to Azure). */
    signal?: AbortSignal;
    /** Told each time a 429 schedules another attempt — for a row that wants to say so. */
    onRetry?: (retry: RetryInfo) => void;
  },
): Promise<HTMLImageElement> {
  // Encoded once: a retry re-sends these bytes rather than re-encoding every source canvas.
  const body = JSON.stringify({
    endpoint: opts.endpoint,
    apiKey: opts.apiKey,
    prompt: opts.prompt,
    images: images.map(preprocess),
    background: 'auto',
    // Suite-wide, from Settings → Quality (lib/quality.ts). Products no longer pass this.
    quality: opts.quality ?? readImageQuality(),
    size: opts.size ?? 'auto',
  });
  const json = await postGenerate(body, opts.signal, opts.onRetry);
  recordUsage('edits', json.usage);
  return b64ToImage(json.b64);
}

/**
 * Text-to-image: no source image, so this hits the generations endpoint via the proxy's
 * `mode: 'generations'` branch. `size` matters more here than for edits — with no input to
 * follow, 'auto' lets the model pick the shape, so callers wanting a consistent set pass one.
 */
/**
 * The URL a given endpoint + mode will actually be called at. The proxy keeps only the ORIGIN
 * of whatever is pasted and appends the path the mode needs, so a value copied from the Azure
 * portal works in every product regardless of which image path it happens to carry.
 *
 * Exported so the settings UI can SHOW that resolution rather than silently discarding half of
 * what the user typed — a field that ignores part of its own input has to say so.
 * Returns null while the value is not yet a parseable URL (i.e. mid-typing).
 */
export function azureImageUrl(endpoint: string, mode: 'edits' | 'generations'): string | null {
  const trimmed = endpoint.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    return new URL(trimmed).origin + `/openai/v1/images/${mode}`;
  } catch {
    return null;
  }
}

export async function callAzureGenerate(
  prompt: string,
  opts: {
    endpoint: string;
    apiKey: string;
    /** Omit — the suite-wide Settings value applies. Only pass to pin one call site. */
    quality?: ImageQuality;
    size?: 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
    /** Stop button support: aborts the proxy request (the route forwards the abort to Azure). */
    signal?: AbortSignal;
    /** Told each time a 429 schedules another attempt — for a row that wants to say so. */
    onRetry?: (retry: RetryInfo) => void;
  },
): Promise<HTMLImageElement> {
  const body = JSON.stringify({
    mode: 'generations',
    endpoint: opts.endpoint,
    apiKey: opts.apiKey,
    prompt,
    // Suite-wide, from Settings → Quality (lib/quality.ts).
    quality: opts.quality ?? readImageQuality(),
    size: opts.size ?? '1024x1024',
  });
  const json = await postGenerate(body, opts.signal, opts.onRetry);
  recordUsage('generations', json.usage);
  return b64ToImage(json.b64);
}

/**
 * Keyless stand-in for callAzureGenerate under ?mock=1. It paints the prompt itself onto the
 * canvas, so a mock run still proves the RIGHT prompt reached the call — a blank placeholder
 * would pass whether or not the brief and row were assembled correctly.
 */
export async function mockGenerate(
  prompt: string,
  size = 1024,
  signal?: AbortSignal,
): Promise<HTMLImageElement> {
  // A short abortable delay so mock runs exercise the Stop button the way real Azure calls
  // do — an instant mock made cancellation untestable without spending money.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, 350);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#2b2b3d');
  grad.addColorStop(1, '#4a2f52');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('MOCK GENERATION', 48, 84);

  ctx.font = '22px monospace';
  ctx.fillStyle = '#e6e6f0';
  const maxWidth = size - 96;
  const lines: string[] = [];
  for (const rawLine of prompt.split('\n')) {
    let line = '';
    for (const word of rawLine.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
    if (lines.length > 34) break;
  }
  lines.slice(0, 34).forEach((line, i) => ctx.fillText(line, 48, 140 + i * 26));

  return new Promise((resolve) => {
    const out = new Image();
    out.onload = () => resolve(out);
    out.src = c.toDataURL('image/png');
  });
}
