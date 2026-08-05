// HEIC/HEIF intake. Browsers cannot decode Apple's HEIC in <img> or createImageBitmap, so a
// .heic file is converted to JPEG once, at the moment it enters the queue — everything
// downstream (thumbnails, the engine, exports, saved projects) then sees an ordinary image and
// nothing else needs to know the format existed. The converter (heic2any, libheif compiled to
// JS) is ~1 MB and main-thread, so it is imported lazily and only ever loads when a HEIC file
// actually shows up.

/**
 * Detected by extension as well as MIME type: Chrome on macOS reports image/heic, but other
 * platforms hand over HEIC files with an empty type string.
 */
export function isHeicFile(file: File): boolean {
  if (/^image\/hei[cf](-sequence)?$/.test(file.type)) return true;
  return /\.hei[cf]$/i.test(file.name);
}

/** Converts one HEIC file to a JPEG File with the same name stem. Throws on a broken file. */
export async function convertHeicFile(file: File): Promise<File> {
  const name = file.name.replace(/\.hei[cf]$/i, '') + '.jpg';
  try {
    // The /next build is the one that bundles cleanly under Next.js. heic-to tracks current
    // libheif releases — heic2any was tried first and its 2019-era libheif rejects real iPhone
    // photos with ERR_LIBHEIF "format not supported".
    const { heicTo } = await import('heic-to/next');
    const blob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
    return new File([blob], name, { type: 'image/jpeg' });
  } catch (wasmError) {
    // libheif trails Apple's encoder, so some genuine iPhone files still refuse. The dev
    // server runs on a Mac, and Apple's own decoder (sips, via /api/convert-heic) reads every
    // file an iPhone can produce — the one conversion path that cannot fall behind.
    const res = await fetch('/api/convert-heic', { method: 'POST', body: file }).catch(() => null);
    if (!res?.ok) {
      throw wasmError instanceof Error ? wasmError : new Error(String(wasmError));
    }
    return new File([await res.blob()], name, { type: 'image/jpeg' });
  }
}

/**
 * Passes non-HEIC files through untouched and converts the HEIC ones. Failures are reported,
 * not thrown: one corrupt phone photo must not void the rest of the drop.
 */
export async function normalizeHeicFiles(
  files: File[],
  onError: (file: File, error: unknown) => void,
): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) {
    if (!isHeicFile(file)) {
      out.push(file);
      continue;
    }
    try {
      out.push(await convertHeicFile(file));
    } catch (e) {
      onError(file, e);
    }
  }
  return out;
}
