// Stage 1 of catalogue vision-QC: download every image in a CSV and tile them into numbered
// 4x4 contact sheets that vision agents can judge. Generic over CSV shape — it finds the URL,
// id and name columns by header pattern.
//
//   node scripts/qc/fetch-and-sheet.mjs <csv> <outDir> [limit]
//
// Produces in <outDir>:
//   cache/            downloaded originals (re-runs are free)
//   sheets/sheet-NNN.jpg + sheets/manifest.json   (cell -> {id, name, url})
//   broken.csv        URLs that failed or returned undecodable bytes, with diagnosis

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const APP = path.resolve(new URL('.', import.meta.url).pathname, '../..');
const require = createRequire(
  await fs.realpath(path.join(APP, 'node_modules/@huggingface/transformers/package.json')),
);
const sharp = require('sharp');

const [csvPath, outDir, limitArg] = process.argv.slice(2);
if (!csvPath || !outDir) {
  console.error('usage: node fetch-and-sheet.mjs <csv> <outDir> [limit]');
  process.exit(1);
}
const LIMIT = limitArg ? parseInt(limitArg, 10) : Infinity;
const CONCURRENCY = 24;
const COLS = 4, ROWS = 4, CELL = 360, LABEL = 26, PAD = 6;

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

const keyFor = (url) => url.replace(/[^a-z0-9]/gi, '_').slice(-90);

const rows = parseCsv(await fs.readFile(csvPath, 'utf8'));
const header = rows[0];
const col = (re) => header.findIndex((c) => re.test(c));
const cUrl = [col(/imagekit/i), col(/imgpath/i), col(/image_?url/i), col(/^url$/i)].find((i) => i >= 0);
const cId = [col(/row_id/i), col(/^id$/i)].find((i) => i >= 0);
const cName = [col(/product_name/i), col(/^name$/i), col(/title/i)].find((i) => i >= 0);
if (cUrl === undefined) { console.error('no URL column found in header:', header.join(', ')); process.exit(1); }

const items = [];
const seen = new Set();
let rowCount = 0;
for (const r of rows.slice(1)) {
  const url = r[cUrl];
  if (!url?.startsWith('http')) continue;
  rowCount++;
  if (rowCount > LIMIT) break;
  if (seen.has(url)) continue;
  seen.add(url);
  items.push({ id: cId !== undefined ? r[cId] : `row-${rowCount}`, name: cName !== undefined ? r[cName] : '', url });
}

const CACHE = path.join(outDir, 'cache');
const SHEETS = path.join(outDir, 'sheets');
await fs.mkdir(CACHE, { recursive: true });
await fs.rm(SHEETS, { recursive: true, force: true });
await fs.mkdir(SHEETS, { recursive: true });
console.log(`${rowCount} rows, ${items.length} unique images`);

const broken = [];
const ok = [];
let done = 0;
const started = Date.now();
let cursor = 0;
async function lane() {
  for (;;) {
    const i = cursor++;
    if (i >= items.length) return;
    const it = items[i];
    try {
      const cached = path.join(CACHE, keyFor(it.url));
      let buf;
      try { buf = await fs.readFile(cached); if (!buf.length) throw new Error('empty'); }
      catch {
        const res = await fetch(it.url, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100) throw new Error('empty response');
        await fs.writeFile(cached, buf);
      }
      // decode check now, so undecodable bytes land in broken.csv instead of a blank sheet cell
      await sharp(buf).metadata();
      ok.push(it);
    } catch (e) {
      broken.push({ ...it, error: String(e.message || e).slice(0, 120) });
    }
    done++;
    if (done % 300 === 0) console.log(`  ${done}/${items.length} (${(done / ((Date.now() - started) / 1000)).toFixed(0)}/s, ${broken.length} broken)`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, lane));

const esc = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
await fs.writeFile(path.join(outDir, 'broken.csv'),
  ['id,name,error,url', ...broken.map((b) => [b.id, esc(b.name), esc(b.error), b.url].join(','))].join('\n'));

const W = COLS * (CELL + PAD) + PAD, H = ROWS * (CELL + LABEL + PAD) + PAD;
const manifest = [];
let sheetNo = 0;
for (let off = 0; off < ok.length; off += COLS * ROWS) {
  const batch = ok.slice(off, off + COLS * ROWS);
  const comp = [];
  const cells = [];
  for (let i = 0; i < batch.length; i++) {
    const it = batch[i];
    const cx = (i % COLS) * (CELL + PAD) + PAD;
    const cy = Math.floor(i / COLS) * (CELL + LABEL + PAD) + PAD;
    comp.push({ input: { text: { text: `#${i + 1}`, font: 'sans-serif bold', dpi: 150, rgba: true } }, left: cx + 4, top: cy + 3 });
    const buf = await fs.readFile(path.join(CACHE, keyFor(it.url)));
    comp.push({
      input: await sharp(buf).resize(CELL, CELL, { fit: 'contain', background: '#fff' }).png().toBuffer(),
      left: cx, top: cy + LABEL,
    });
    cells.push({ cell: i + 1, id: it.id, name: it.name, url: it.url });
  }
  sheetNo++;
  const file = `sheet-${String(sheetNo).padStart(3, '0')}.jpg`;
  await sharp({ create: { width: W, height: H, channels: 3, background: '#c9c9cf' } })
    .composite(comp).jpeg({ quality: 80 }).toFile(path.join(SHEETS, file));
  manifest.push({ sheet: file, cells });
}
await fs.writeFile(path.join(SHEETS, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(JSON.stringify({ rows: rowCount, unique: items.length, imagesOk: ok.length, broken: broken.length, sheets: sheetNo, secs: +(((Date.now() - started) / 1000)).toFixed(1) }));
