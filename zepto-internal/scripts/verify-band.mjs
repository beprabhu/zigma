// How big is the second-model verify band, really?
//
// quality.needsVerify routes only "uncertain" cutouts to a BiRefNet cross-check, and the
// band is meant to be small — the shadow guard in quality.ts exists precisely so a 14k run
// does not buy thousands of inferences to confirm cast shadows. Meant to be is not measured
// to be, and nothing in the app reports the rate.
//
// This reads saved .zesku projects and counts it. A verdict is only written when the sweep
// actually ran (project.ts stores all four fields or nothing), and needsVerify returns false
// once item.verify exists — so on a finished run "has a verify record" IS the band.
//
//   node --import ./scripts/ts-resolve.mjs scripts/verify-band.mjs <file-or-dir.zesku> [more...]
//
// Two numbers, because they answer different questions:
//   RECORDED  items that already carry a verdict — what the sweep actually spent.
//   PREDICTED needsVerify() replayed over the saved evidence — what it WOULD route today.
// The real function is imported, never re-implemented, so this cannot drift from the app.
// Prints both, the agree/disagree split, and an IoU histogram. The disagreements are the items
// where BiRefNet produced a different cutout that the sweep then discarded.

import { assessQuality, needsVerify } from '../lib/bg/quality.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflateRaw = promisify(zlib.inflateRaw);

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/verify-band.mjs <file-or-dir.zesku> [more...]');
  process.exit(1);
}

// ---- zip reader: positional, ZIP64-aware ---------------------------------------------
// Real projects are 14 GB, so nothing here reads the archive into memory: only the tail, the
// central directory and the one manifest entry are ever touched. ZIP64 because buildZipStream
// switches to it past 4 GiB (lib/zip.ts), and every offset in a project that size is saturated.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const EOCD64_SIG = 0x06064b50;
const LOCATOR_SIG = 0x07064b50;
const U32_MAX = 0xffffffff;
const EOCD_MAX = 22 + 0xffff;

async function readAt(fh, start, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, start);
  return buf.subarray(0, bytesRead);
}

/** Byte range of the central directory, following the ZIP64 locator when fields saturate. */
async function locateCentral(fh, size) {
  const tailStart = Math.max(0, size - EOCD_MAX);
  const tail = await readAt(fh, tailStart, size - tailStart);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory record)');

  let count = tail.readUInt16LE(eocd + 10);
  let centralSize = tail.readUInt32LE(eocd + 12);
  let centralOffset = tail.readUInt32LE(eocd + 16);

  if (count === 0xffff || centralSize === U32_MAX || centralOffset === U32_MAX) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== LOCATOR_SIG) {
      throw new Error('corrupt ZIP64: locator missing');
    }
    const at = Number(tail.readBigUInt64LE(loc + 8));
    const rec = await readAt(fh, at, 56);
    if (rec.readUInt32LE(0) !== EOCD64_SIG) throw new Error('corrupt ZIP64: eocd record missing');
    count = Number(rec.readBigUInt64LE(32));
    centralSize = Number(rec.readBigUInt64LE(40));
    centralOffset = Number(rec.readBigUInt64LE(48));
  }
  return { count, centralSize, centralOffset };
}

/**
 * Pulls the u64s out of a central entry's ZIP64 extra (id 0x0001). Spec order is uncompressed,
 * compressed, offset, present only for saturated fields — but real writers emit all three
 * unconditionally, so the word count decides the mapping. Same rule as lib/zip.ts.
 */
function zip64Fields(cen, at, extraLen, sizeSat, compressedSat, offsetSat) {
  const end = at + extraLen;
  while (at + 4 <= end) {
    const id = cen.readUInt16LE(at);
    const len = cen.readUInt16LE(at + 2);
    if (id === 0x0001) {
      const words = [];
      const wordsEnd = Math.min(at + 4 + len, end);
      for (let w = at + 4; w + 8 <= wordsEnd; w += 8) words.push(Number(cen.readBigUInt64LE(w)));
      const wanted = (sizeSat ? 1 : 0) + (compressedSat ? 1 : 0) + (offsetSat ? 1 : 0);
      if (words.length >= 3) return { size: words[0], offset: words[2] };
      if (words.length >= wanted) {
        let i = 0;
        const size = sizeSat ? words[i++] : null;
        if (compressedSat) i++;
        return { size, offset: offsetSat ? words[i] : null };
      }
      throw new Error('corrupt ZIP64 extra: truncated');
    }
    at += 4 + len;
  }
  throw new Error('saturated field with no ZIP64 extra');
}

async function readManifest(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const { size } = await fh.stat();
    // Worth naming rather than reporting as "not a zip": an interrupted save leaves a 0-byte
    // file behind, and that is a finding about the save path, not about this reader.
    if (size === 0) throw new Error('empty file (0 bytes) — the save never completed');
    const { count, centralSize, centralOffset } = await locateCentral(fh, size);
    const cen = await readAt(fh, centralOffset, centralSize);

    let pos = 0;
    for (let n = 0; n < count; n++) {
      if (cen.readUInt32LE(pos) !== CEN_SIG) throw new Error('corrupt central directory');
      const method = cen.readUInt16LE(pos + 10);
      const compressed = cen.readUInt32LE(pos + 20);
      let entrySize = cen.readUInt32LE(pos + 24);
      const nameLen = cen.readUInt16LE(pos + 28);
      const extraLen = cen.readUInt16LE(pos + 30);
      const commentLen = cen.readUInt16LE(pos + 32);
      let localOffset = cen.readUInt32LE(pos + 42);
      const name = cen.toString('utf8', pos + 46, pos + 46 + nameLen);

      if (name === 'manifest.json') {
        if (entrySize === U32_MAX || localOffset === U32_MAX) {
          const f = zip64Fields(
            cen, pos + 46 + nameLen, extraLen,
            entrySize === U32_MAX, compressed === U32_MAX, localOffset === U32_MAX,
          );
          if (f.size !== null) entrySize = f.size;
          if (f.offset !== null) localOffset = f.offset;
        }
        // The local header carries its OWN extra field, routinely a different length from the
        // central one — read both from the local record or the payload starts mid-stream.
        const lh = await readAt(fh, localOffset, 30);
        const dataAt = localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const raw = await readAt(fh, dataAt, entrySize);
        return JSON.parse((method === 0 ? raw : await inflateRaw(raw)).toString('utf8'));
      }
      pos += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('no manifest.json in archive');
  } finally {
    await fh.close();
  }
}

// ---- collection ----------------------------------------------------------------------

async function collect(target) {
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) return [target];
  const names = await fs.readdir(target);
  return names.filter((n) => n.toLowerCase().endsWith('.zesku')).map((n) => path.join(target, n));
}

const files = (await Promise.all(args.map(collect))).flat();
if (!files.length) {
  console.error('no .zesku files found');
  process.exit(1);
}

/**
 * Manifest rows into the shape needsVerify reads. The manifest is a SAVE format, not the live
 * item: cutout fields are flattened onto the row and two keys are renamed (components,
 * regions). Rebuilding the nesting here is what lets the real predicate run unmodified.
 * `verify` is deliberately dropped — including it would short-circuit the predicate to false
 * and every already-checked item would read as "would not be routed".
 */
const shimCache = new WeakMap();
function asBgItem(item) {
  const hit = shimCache.get(item);
  if (hit !== undefined) return hit;
  const built =
    item.bounds && item.originalInk
      ? {
          status: 'done',
          cutout: { bounds: item.bounds, width: item.width, height: item.height },
          originalInk: item.originalInk,
          originalComponents: item.components ?? [],
          regionReport: item.regions ?? [],
          removedRegions: item.removedRegions ?? 0,
          residueFraction: item.residueFraction ?? 0,
        }
      : null;
  shimCache.set(item, built);
  return built;
}

let total = 0;
let withCutout = 0;
let band = 0;
let agreed = 0;
let disagreed = 0;
// A save that predates the quality-evidence fields cannot answer this question at all: with no
// components/regions the sweep had nothing to route on, and an empty band would read as "the
// band is tiny" when it really means "this file does not know".
let withEvidence = 0;
let predicted = 0;
let routed = 0;
const perProject = [];
const ious = [];
const disputed = [];
const worst = [];

for (const file of files) {
  let manifest;
  try {
    manifest = await readManifest(file);
  } catch (e) {
    console.error(`skipped ${path.basename(file)}: ${e.message}`);
    continue;
  }
  const items = manifest.items ?? [];
  // Per-project rows, because the aggregate cannot distinguish "the sweep never ran" from
  // "these saves predate the evidence fields". A project WITH evidence and NO verdicts is the
  // only shape that convicts the sweep.
  const row = { name: path.basename(file), finished: 0, evidence: 0, verify: 0, predicted: 0 };
  perProject.push(row);
  for (const item of items) {
    total++;
    // The band rate is quoted against FINISHED items: an unprocessed row never had a cutout
    // to cross-check, and counting it would silently read as "did not need verifying".
    // project.ts writes path '' and 0x0 dimensions for rows saved before they were processed.
    const finished = Boolean(item.path) && item.width > 0 && item.height > 0;
    if (!finished) continue;
    withCutout++;
    row.finished++;
    const hasEvidence = Boolean(item.components?.length || item.regions?.length);
    if (hasEvidence) { withEvidence++; row.evidence++; }
    // Replay the router over the saved evidence. needsVerify short-circuits on an existing
    // verdict, so it is asked the question the sweep faced: verify absent, quality known.
    // BOTH of the sweep's gates, not just the router: page.tsx selects
    // needsVerify && canRetry && assessQuality(...).level === 'ok', and an already-flagged
    // item goes to AI-fix instead of a cross-check. Counting the router alone overstates the
    // band — and, more importantly, hides that the worst cutouts are never cross-checked.
    const shim = asBgItem(item);
    if (hasEvidence && shim && needsVerify(shim)) {
      routed++;
      if (assessQuality(shim).level === 'ok') { predicted++; row.predicted++; }
    }
    if (!item.verify) continue;
    band++;
    row.verify++;
    ious.push(item.verify.iou);
    disputed.push(item.verify.disputedFraction);
    if (item.verify.agree) agreed++;
    else {
      disagreed++;
      worst.push({ name: item.name ?? '?', iou: item.verify.iou, file: path.basename(file) });
    }
  }
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '—');
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

// Stated with the output, not just in a commit message: quality.ts has changed since these
// projects were saved (a704793 replaced the flag heuristic with a model), so "expected" is
// TODAY's predicate applied to OLD evidence. It forecasts the band going forward; it is not
// proof of what the build that wrote these files would have routed.
console.log('\nper project  (expected = today\'s needsVerify + quality gate, replayed)');
for (const r of perProject) {
  console.log(
    `  ${String(r.finished).padStart(6)} done  ${String(r.evidence).padStart(6)} evidence  ` +
      `${String(r.predicted).padStart(5)} expected  ${String(r.verify).padStart(5)} verdicts   ${r.name}`,
  );
}

console.log(`\nprojects        ${files.length}`);
console.log(`items           ${total}`);
console.log(`finished        ${withCutout}`);
console.log(`with evidence   ${withEvidence}  (${pct(withEvidence, withCutout)} — needsVerify can only fire on these)`);
console.log(`\nneedsVerify()   ${routed}  (${pct(routed, withEvidence)} of items with evidence)`);
console.log(`predicted band  ${predicted}  (${pct(predicted, withEvidence)} — also passing the sweep's quality==ok gate)`);
console.log(`  already flagged, so never cross-checked: ${routed - predicted}`);
console.log(`\nrecorded band   ${band}  (${pct(band, withCutout)} of finished)`);
console.log(`  agreed        ${agreed}  (${pct(agreed, band)} of band)`);
console.log(`  disagreed     ${disagreed}  (${pct(disagreed, band)} of band)`);

if (band) {
  console.log(`\nIoU  median ${median(ious).toFixed(3)}   min ${Math.min(...ious).toFixed(3)}`);
  console.log(`disputed fraction  median ${median(disputed).toFixed(3)}   max ${Math.max(...disputed).toFixed(3)}`);
  const bins = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.01];
  let lo = 0;
  console.log('\nIoU histogram');
  for (const hi of bins) {
    const n = ious.filter((v) => v >= lo && v < hi).length;
    if (n) {
      const bar = '#'.repeat(Math.max(1, Math.round((40 * n) / band)));
      console.log(`  ${lo.toFixed(2)}-${Math.min(hi, 1).toFixed(2)}  ${String(n).padStart(6)}  ${bar}`);
    }
    lo = hi;
  }
}

if (worst.length) {
  console.log('\nworst disagreements (BiRefNet cutout discarded on each of these)');
  for (const w of worst.sort((a, b) => a.iou - b.iou).slice(0, 15)) {
    console.log(`  iou ${w.iou.toFixed(3)}  ${w.name}  [${w.file}]`);
  }
  if (worst.length > 15) console.log(`  … and ${worst.length - 15} more`);
}

// The cost line, stated in the units the decision is actually made in.
console.log(
  `\nBiRefNet inferences already spent: ${band}` +
    (withCutout ? `  →  ${(band / withCutout).toFixed(3)} per finished image` : ''),
);
console.log(`Cutouts discarded despite disagreeing: ${disagreed}\n`);
