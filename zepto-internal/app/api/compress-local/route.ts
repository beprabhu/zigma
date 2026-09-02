// POST /api/compress-local — raw PNG body, compressed entirely on this machine via
// pngquant (lossy palette quantization) + oxipng (lossless deflate squeeze). No API key,
// no network. Options via headers: x-colors (2–256, default 256), x-lossless ('1' skips
// quantization). Returns image bytes with X-Input-Size / X-Output-Size, mirroring
// /api/compress so callers can swap between the two.
import { NextRequest, NextResponse } from 'next/server';
import { PayloadTooLarge, readBodyCapped } from '@/lib/api-guard';
import { execFile } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Next's server process often lacks the interactive shell's PATH (e.g. when launched from a
// GUI), so probe Homebrew's install locations explicitly before falling back to PATH lookup.
const BREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

async function findBinary(name: string): Promise<string | null> {
  for (const dir of BREW_DIRS) {
    const candidate = join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  try {
    await run(name, ['--version']);
    return name;
  } catch {
    return null;
  }
}

/** A 4K RGBA PNG is ~30 MB; nothing this tool exports is bigger. */
const MAX_PNG_BYTES = 40 * 1024 * 1024;

export async function POST(req: NextRequest) {
  let png: Uint8Array<ArrayBuffer>;
  try {
    png = await readBodyCapped(req, MAX_PNG_BYTES);
  } catch (e) {
    if (e instanceof PayloadTooLarge) return e.response();
    throw e;
  }
  if (!png.byteLength) return NextResponse.json({ error: 'Empty body' }, { status: 400 });

  const lossless = req.headers.get('x-lossless') === '1';
  const colors = Math.min(256, Math.max(2, Number(req.headers.get('x-colors')) || 256));

  const [pngquant, oxipng] = await Promise.all([findBinary('pngquant'), findBinary('oxipng')]);
  if (!pngquant && !oxipng) {
    return NextResponse.json(
      { error: 'Neither pngquant nor oxipng found — install with: brew install pngquant oxipng' },
      { status: 503 },
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'compress-local-'));
  const src = join(dir, 'in.png');
  const dst = join(dir, 'out.png');
  try {
    await writeFile(src, png);

    if (!lossless && pngquant) {
      // --skip-if-larger exits 98/99 and writes nothing when quantizing wouldn't help.
      await run(pngquant, [
        '--force', '--skip-if-larger', '--speed', '1', String(colors), '--output', dst, src,
      ]).catch(() => {});
      try {
        await access(dst);
      } catch {
        await copyFile(src, dst);
      }
    } else {
      await copyFile(src, dst);
    }

    if (oxipng) await run(oxipng, ['-o', 'max', '--strip', 'safe', '--quiet', dst]);

    const out = await readFile(dst);
    // Never hand back a larger file than we were given.
    const best = out.byteLength < png.byteLength ? out : png;
    return new NextResponse(new Uint8Array(best), {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'X-Input-Size': String(png.byteLength),
        'X-Output-Size': String(best.byteLength),
      },
    });
  } catch (e) {
    // The exec error names the binary's path and the temp file — the log's business, not the
    // browser's. The response says what failed; the detail is one server log line away.
    console.error('[compress-local] compression failed', e);
    return NextResponse.json({ error: 'Compression failed on the server — the file was exported uncompressed.' }, { status: 500 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
