// HEIC → JPEG fallback conversion, via macOS's own `sips`.
//
// The browser-side decoder (heic-to, libheif WASM) handles most files, but libheif builds trail
// Apple's encoder — real iPhone photos have failed it before ("format not supported"). Apple's
// system decoder by definition reads every file an iPhone produces, and this app runs on
// developer Macs, so shelling out to sips is the one conversion path that cannot fall behind.
// The client tries the in-browser decoder first and only posts here when that fails.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function POST(request: Request): Promise<Response> {
  if (process.platform !== 'darwin') {
    return new Response('HEIC fallback conversion needs macOS (sips)', { status: 501 });
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (!bytes.length) return new Response('Empty body', { status: 400 });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zesku-heic-'));
  const src = path.join(dir, 'in.heic');
  const out = path.join(dir, 'out.jpg');
  try {
    await fs.writeFile(src, bytes);
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', src, '--out', out]);
    const jpeg = await fs.readFile(out);
    return new Response(new Uint8Array(jpeg), {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return new Response(`sips could not convert this file: ${message}`, { status: 422 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
