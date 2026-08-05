// Client-side image pipeline: fetch via proxy, preprocess, call Azure, decode result.

export async function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  const res = await fetch('/api/fetch-image?url=' + encodeURIComponent(url));
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

export async function callAzure(
  images: HTMLImageElement[],
  opts: {
    endpoint: string;
    apiKey: string;
    prompt: string;
    quality?: 'low' | 'medium' | 'high';
    /** 'auto' (default) follows the input's aspect; pass '1024x1024' to force a square tile. */
    size?: 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
  },
): Promise<HTMLImageElement> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
      prompt: opts.prompt,
      images: images.map(preprocess),
      background: 'auto',
      // 'low' follows composition instructions noticeably worse; callers doing prompt-driven
      // recomposition (BG Remover AI edits) pass 'medium'. The compositor's default is unchanged.
      quality: opts.quality ?? 'low',
      size: opts.size ?? 'auto',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Generate failed (${res.status})`);
  return b64ToImage(json.b64);
}
