// Minimal ZIP writer + reader (STORE method only, no compression — inputs are
// already-compressed PNGs/WebPs). The reader exists for project files this writer produced;
// it is not a general unzipper and rejects compressed entries.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(c: number, buf: Uint8Array): number {
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}

/** Also used by the PNG-8 encoder in lib/bg/png8.ts — PNG chunks carry the same CRC32. */
export function crc32(buf: Uint8Array): number {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export interface ZipStreamEntry {
  name: string;
  /** Blob data is NEVER materialized: it rides into the output Blob as a reference. */
  data: Blob | Uint8Array;
}

/** CRC reads happen in slices this large, so peak memory is one chunk, not one entry. */
const CRC_CHUNK = 16 * 1024 * 1024;
const U32_MAX = 0xffffffff;

/**
 * buildZip for archives that do not fit in memory. Two differences:
 *
 *   memory   Blob entries are referenced, not read — the returned Blob is a parts list over
 *            the original blobs, which Chrome backs with its paged blob storage. The only
 *            whole-entry reads are the chunked CRC passes. buildZip's approach (every entry
 *            as a live Uint8Array) dies with "failed to allocate buffer" on multi-GB saves.
 *   ZIP64    A queue-scale project archive passes 4 GiB, where standard ZIP's 32-bit offsets
 *            end. Entries whose local header sits past 4 GiB get a ZIP64 extra field, and the
 *            archive gets a ZIP64 end-of-central-directory record when any limit saturates.
 *            Single entries larger than 4 GiB stay unsupported (a cutout is a few MB).
 *
 * readZipIndex reads both formats; the eager readZip does not and is kept for small archives.
 */
export async function buildZipStream(files: ZipStreamEntry[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime();
  const parts: BlobPart[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const size = f.data instanceof Uint8Array ? f.data.length : f.data.size;
    if (size >= U32_MAX) throw new Error(`ZIP entry "${f.name}" exceeds 4 GiB`);

    let c = 0xffffffff;
    if (f.data instanceof Uint8Array) {
      c = crc32Update(c, f.data);
    } else {
      for (let at = 0; at < size; at += CRC_CHUNK) {
        const chunk = await f.data.slice(at, Math.min(size, at + CRC_CHUNK)).arrayBuffer();
        c = crc32Update(c, new Uint8Array(chunk));
      }
    }
    const crc = (c ^ 0xffffffff) >>> 0;

    const zip64 = offset >= U32_MAX;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, zip64 ? 45 : 20, true); // version needed
    local.setUint16(6, 0x0800, true);          // UTF-8 flag
    local.setUint16(8, 0, true);               // method: store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, f.data as BlobPart);

    // Only the local-header offset can overflow here (entry sizes are capped above), so the
    // ZIP64 extra carries exactly that one field.
    const extra = zip64 ? new DataView(new ArrayBuffer(12)) : null;
    if (extra) {
      extra.setUint16(0, 0x0001, true); // ZIP64 extra id
      extra.setUint16(2, 8, true);      // payload: one u64
      extra.setBigUint64(4, BigInt(offset), true);
    }
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 45, true);
    central.setUint16(6, zip64 ? 45 : 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, extra ? 12 : 0, true);
    central.setUint32(42, zip64 ? U32_MAX : offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);
    if (extra) centralParts.push(new Uint8Array(extra.buffer));

    offset += 30 + nameBytes.length + size;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const needs64 = centralOffset >= U32_MAX || centralSize >= U32_MAX || files.length >= 0xffff;
  const tail: Uint8Array[] = [];

  if (needs64) {
    const eocd64 = new DataView(new ArrayBuffer(56));
    eocd64.setUint32(0, 0x06064b50, true);
    eocd64.setBigUint64(4, BigInt(44), true); // record size minus signature+this field
    eocd64.setUint16(12, 45, true);
    eocd64.setUint16(14, 45, true);
    eocd64.setUint32(16, 0, true); // this disk
    eocd64.setUint32(20, 0, true); // central-directory disk
    eocd64.setBigUint64(24, BigInt(files.length), true);
    eocd64.setBigUint64(32, BigInt(files.length), true);
    eocd64.setBigUint64(40, BigInt(centralSize), true);
    eocd64.setBigUint64(48, BigInt(centralOffset), true);
    const locator = new DataView(new ArrayBuffer(20));
    locator.setUint32(0, 0x07064b50, true);
    locator.setUint32(4, 0, true); // disk holding the ZIP64 EOCD
    locator.setBigUint64(8, BigInt(centralOffset + centralSize), true);
    locator.setUint32(16, 1, true); // total disks
    tail.push(new Uint8Array(eocd64.buffer), new Uint8Array(locator.buffer));
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Math.min(files.length, 0xffff), true);
  end.setUint16(10, Math.min(files.length, 0xffff), true);
  end.setUint32(12, needs64 ? U32_MAX : centralSize, true);
  end.setUint32(16, needs64 ? U32_MAX : centralOffset, true);
  tail.push(new Uint8Array(end.buffer));

  return new Blob([...parts, ...centralParts, ...tail] as BlobPart[], { type: 'application/zip' });
}

export interface ZipEntryRef {
  name: string;
  size: number;
  /**
   * A lazy slice of the source file. Blob.slice() does not read anything, so holding one of
   * these per entry costs nothing — the bytes are only touched when something decodes it.
   */
  blob: Blob;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
// End-of-central-directory record: 22 bytes plus a comment of at most 64 KB.
const EOCD_MAX = 22 + 0xffff;

async function sliceBytes(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/**
 * Indexes a STORE-method ZIP without reading it into memory.
 *
 * The eager reader below needs one contiguous ArrayBuffer, and browsers cap those around 1-2 GB
 * — a 2.9 GB project file simply cannot be opened that way. This reads only the central
 * directory and returns lazy Blob slices, so peak memory is independent of archive size.
 */
export async function readZipIndex(file: Blob): Promise<ZipEntryRef[]> {
  const tailStart = Math.max(0, file.size - EOCD_MAX);
  const tail = await sliceBytes(file, tailStart, file.size);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record)');

  let count = tailView.getUint16(eocd + 10, true);
  let centralSize = tailView.getUint32(eocd + 12, true);
  let centralOffset = tailView.getUint32(eocd + 16, true);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    // ZIP64 (what buildZipStream writes past 4 GiB): the locator sits directly before the
    // EOCD and points at the ZIP64 EOCD record, which carries the real 64-bit figures.
    const loc = eocd - 20;
    if (loc < 0 || tailView.getUint32(loc, true) !== 0x07064b50) {
      throw new Error('Corrupt ZIP64: end-of-central-directory locator missing');
    }
    const eocd64At = Number(tailView.getBigUint64(loc + 8, true));
    const eocd64 = await sliceBytes(file, eocd64At, eocd64At + 56);
    const v64 = new DataView(eocd64.buffer, eocd64.byteOffset, eocd64.byteLength);
    if (v64.getUint32(0, true) !== 0x06064b50) {
      throw new Error('Corrupt ZIP64: end-of-central-directory record missing');
    }
    count = Number(v64.getBigUint64(32, true));
    centralSize = Number(v64.getBigUint64(40, true));
    centralOffset = Number(v64.getBigUint64(48, true));
  }

  const central = await sliceBytes(file, centralOffset, centralOffset + centralSize);
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const decoder = new TextDecoder();

  // Local headers must be read to find where each entry's data begins, because their extra
  // field can differ in length from the central one. They are scattered across the archive, so
  // the reads are collected first and issued together rather than one blocking round-trip each.
  interface Pending {
    name: string;
    size: number;
    localOffset: number;
  }
  const pending: Pending[] = [];
  let pos = 0;
  for (let n = 0; n < count; n++) {
    if (view.getUint32(pos, true) !== CENTRAL_SIGNATURE) {
      throw new Error('Corrupt ZIP: central directory entry missing');
    }
    const method = view.getUint16(pos + 10, true);
    let size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    let localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(central.subarray(pos + 46, pos + 46 + nameLen));
    if (method !== 0) {
      throw new Error(`Unsupported ZIP entry "${name}" (compressed; expected STORE)`);
    }
    if (size === 0xffffffff || localOffset === 0xffffffff) {
      // Saturated fields live in the ZIP64 extra (id 0x0001) as consecutive u64s. Spec order
      // is uncompressed, compressed, offset — present only for saturated fields — but real
      // writers also emit all three unconditionally, so the u64 count decides the mapping.
      // Every read is bounded by the subfield's declared length AND the extra area: a
      // truncated extra must fail loudly, not read a neighbouring subfield as an offset.
      const compressed = view.getUint32(pos + 20, true);
      let at = pos + 46 + nameLen;
      const extraEnd = at + extraLen;
      while (at + 4 <= extraEnd) {
        const id = view.getUint16(at, true);
        const len = view.getUint16(at + 2, true);
        if (id === 0x0001) {
          const words: number[] = [];
          const wordsEnd = Math.min(at + 4 + len, extraEnd);
          for (let w = at + 4; w + 8 <= wordsEnd; w += 8) {
            words.push(Number(view.getBigUint64(w, true)));
          }
          const wanted =
            (size === 0xffffffff ? 1 : 0) +
            (compressed === 0xffffffff ? 1 : 0) +
            (localOffset === 0xffffffff ? 1 : 0);
          if (words.length >= 3) {
            // All fields written regardless of saturation: fixed positions.
            if (size === 0xffffffff) size = words[0];
            if (localOffset === 0xffffffff) localOffset = words[2];
          } else if (words.length >= wanted) {
            // Spec-minimal: one u64 per saturated field, in order.
            let field = 0;
            if (size === 0xffffffff) size = words[field++];
            if (compressed === 0xffffffff) field++;
            if (localOffset === 0xffffffff) localOffset = words[field];
          }
          break;
        }
        at += 4 + len;
      }
      if (size === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error(`Corrupt ZIP64: entry "${name}" is missing its extra field`);
      }
    }
    pending.push({ name, size, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }

  const entries: ZipEntryRef[] = new Array(pending.length);
  const CONCURRENCY = 16;
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= pending.length) return;
      const { name, size, localOffset } = pending[i];
      const header = await sliceBytes(file, localOffset, localOffset + 30);
      const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
      // The signature check is what turns a bogus offset (hand-edited archive, buggy ZIP64
      // extra) into a loud error instead of silently slicing garbage bytes as an image.
      if (hv.byteLength < 30 || hv.getUint32(0, true) !== 0x04034b50) {
        throw new Error(`Corrupt ZIP: entry "${name}" has no local header at its recorded offset`);
      }
      const start = localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
      if (start + size > file.size) throw new Error(`Corrupt ZIP: entry "${name}" is truncated`);
      entries[i] = { name, size, blob: file.slice(start, start + size) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, lane));
  return entries;
}

