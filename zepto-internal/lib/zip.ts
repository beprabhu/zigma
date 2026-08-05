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

/** Also used by the PNG-8 encoder in lib/bg/png8.ts — PNG chunks carry the same CRC32. */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export interface ZipFileEntry {
  name: string;
  data: Uint8Array;
}

export function buildZip(files: ZipFileEntry[]): Blob {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const data = f.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // UTF-8 flag
    local.setUint16(8, 0, true);           // method: store
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/zip' });
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

  const count = tailView.getUint16(eocd + 10, true);
  const centralSize = tailView.getUint32(eocd + 12, true);
  const centralOffset = tailView.getUint32(eocd + 16, true);
  if (count === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
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
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(central.subarray(pos + 46, pos + 46 + nameLen));
    if (method !== 0) {
      throw new Error(`Unsupported ZIP entry "${name}" (compressed; expected STORE)`);
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
      const start = localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
      if (start + size > file.size) throw new Error(`Corrupt ZIP: entry "${name}" is truncated`);
      entries[i] = { name, size, blob: file.slice(start, start + size) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, lane));
  return entries;
}

/**
 * Reads a STORE-method ZIP produced by buildZip back into entries, verifying each CRC so a
 * truncated or corrupted file fails loudly instead of yielding broken images. Throws on
 * anything compressed — project files are the only intended input.
 *
 * Requires the whole archive in memory; use readZipIndex for anything that might be large.
 */
export function readZip(bytes: Uint8Array): ZipFileEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // End-of-central-directory: scan backwards; the record is 22 bytes plus an optional comment
  // of up to 64 KB, so the signature sits within the last 64 KB + 22 bytes.
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record)');

  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const entries: ZipFileEntry[] = [];

  for (let n = 0; n < count; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error('Corrupt ZIP: central directory entry missing');
    }
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (method !== 0) {
      throw new Error(`Unsupported ZIP entry "${name}" (compressed; expected STORE)`);
    }

    // The local header repeats name/extra with possibly different extra length.
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    if (start + size > bytes.length) throw new Error(`Corrupt ZIP: entry "${name}" is truncated`);
    const data = bytes.subarray(start, start + size);
    if (crc32(data) !== crc) throw new Error(`Corrupt ZIP: entry "${name}" failed its checksum`);

    entries.push({ name, data });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
