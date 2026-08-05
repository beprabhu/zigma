// Stage 2 of catalogue vision-QC: join agent verdicts back onto every CSV row and build the
// deliverables. Verdict files are JSONL lines {"sheet":"sheet-001.jpg","cell":1,"flags":[...]}
// written by vision agents into <outDir>/verdicts/.
//
//   node scripts/qc/aggregate.mjs <csv> <outDir>
//
// Produces in <outDir>: vision-flagged.csv, vision-results.json, vision-gallery.html
// and prints a summary. Rows whose image was in broken.csv get issue "broken-link".

import fs from 'node:fs/promises';
import path from 'node:path';

const [csvPath, outDir] = process.argv.slice(2);
if (!csvPath || !outDir) {
  console.error('usage: node aggregate.mjs <csv> <outDir>');
  process.exit(1);
}

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

const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'sheets/manifest.json'), 'utf8'));
const cellMap = new Map();
for (const s of manifest) for (const c of s.cells) cellMap.set(`${s.sheet}|${c.cell}`, c);

const VALID = new Set(['clean', 'text', 'strip', 'scene', 'colorbg', 'human', 'multi']);
const verdicts = new Map();
let judged = 0, badLines = 0, unknownCells = 0;
for (const f of (await fs.readdir(path.join(outDir, 'verdicts'))).sort()) {
  if (!f.endsWith('.jsonl')) continue;
  for (const line of (await fs.readFile(path.join(outDir, 'verdicts', f), 'utf8')).split('\n').filter(Boolean)) {
    let v; try { v = JSON.parse(line); } catch { badLines++; continue; }
    const cell = cellMap.get(`${v.sheet}|${v.cell}`);
    if (!cell) { unknownCells++; continue; }
    const flags = (Array.isArray(v.flags) ? v.flags : []).filter((x) => VALID.has(x));
    verdicts.set(cell.url, flags.length ? flags : ['clean']);
    judged++;
  }
}

const brokenUrls = new Set();
try {
  for (const line of (await fs.readFile(path.join(outDir, 'broken.csv'), 'utf8')).split('\n').slice(1).filter(Boolean)) {
    const url = line.slice(line.lastIndexOf(',http') + 1);
    if (url.startsWith('http')) brokenUrls.add(url);
  }
} catch { /* no broken.csv */ }

const rows = parseCsv(await fs.readFile(csvPath, 'utf8'));
const header = rows[0];
const col = (re) => header.findIndex((c) => re.test(c));
const cUrl = [col(/imagekit/i), col(/imgpath/i), col(/image_?url/i), col(/^url$/i)].find((i) => i >= 0);
const cId = [col(/row_id/i), col(/^id$/i)].find((i) => i >= 0);
const cName = [col(/product_name/i), col(/^name$/i), col(/title/i)].find((i) => i >= 0);

const results = [];
for (const r of rows.slice(1)) {
  const url = r[cUrl];
  if (!url?.startsWith('http')) continue;
  const id = cId !== undefined ? r[cId] : `row-${results.length + 1}`;
  const name = cName !== undefined ? r[cName] : '';
  const verdict = brokenUrls.has(url) ? ['broken-link'] : (verdicts.get(url) ?? ['not-judged']);
  results.push({ id, name, url, verdict });
}

const counts = {};
for (const r of results) for (const f of r.verdict) counts[f] = (counts[f] || 0) + 1;
const flagged = results.filter((r) => !(r.verdict.length === 1 && r.verdict[0] === 'clean'));

const esc = (s) => (/[",\n]/.test(String(s ?? '')) ? `"${String(s).replace(/"/g, '""')}"` : String(s ?? ''));
await fs.writeFile(path.join(outDir, 'vision-flagged.csv'),
  ['id,name,issues,url', ...flagged.map((r) => [r.id, esc(r.name), r.verdict.join('+'), r.url].join(','))].join('\n'));
await fs.writeFile(path.join(outDir, 'vision-results.json'), JSON.stringify(results, null, 1));

const groups = {};
for (const r of flagged) (groups[r.verdict.slice().sort().join('+')] ??= []).push(r);
const html = `<!doctype html><meta charset="utf-8"><title>Vision QC</title>
<style>body{font:13px system-ui;margin:20px;background:#101014;color:#ddd}h2{margin:30px 0 8px}
.g{display:flex;flex-wrap:wrap;gap:8px}.c{width:140px}img{width:140px;height:140px;object-fit:contain;background:#fff;border-radius:6px}
.c div{font-size:10px;color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style>
<h1>${results.length} rows · ${results.length - flagged.length} clean · ${flagged.length} flagged</h1>
<p>${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<b>${k}</b>: ${v}`).join(' · ')}</p>
${Object.entries(groups).sort((a, b) => b[1].length - a[1].length).map(([k, rs]) =>
  `<h2>${k} (${rs.length})</h2><div class="g">${rs.slice(0, 150).map((r) =>
    `<span class="c"><img loading="lazy" src="${r.url}"><div title="${r.name}">${r.id}</div></span>`).join('')}</div>`).join('')}`;
await fs.writeFile(path.join(outDir, 'vision-gallery.html'), html);

console.log(JSON.stringify({ rows: results.length, judged, badLines, unknownCells, clean: results.length - flagged.length, flagged: flagged.length, counts }, null, 1));
