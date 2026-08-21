'use client';

// Compress's adapter into the file store.
//
// The simplest of the four, and the one where the drafts rule bites hardest. Both halves of a row
// are structured-cloneable here — the dropped File and the compressed Blob — so persisting
// everything would have been the path of least resistance and exactly the wrong call: the inputs
// are still on the user's disk, and writing them would double what a batch occupies in a store
// four tools now share, spending quota on bytes a drag-and-drop reproduces for free.
//
// So only the OUTPUT is kept. A restored row can be downloaded, exported and measured; re-running
// it at different settings needs the file re-dropped, which is a seconds-long local round trip.

import type { PngItem } from '../../png-queue';
import type { ItemPayload, ItemRecord, ToolCodec } from '../types';

export const OUTPUT_BLOB = 'output';

/** The plain half of one row. */
export interface PngItemData {
  name: string;
  /** The source's size, so a restored row can still show what it saved. */
  inputSize: number;
}

/** Compress's document identity. */
export interface PngDoc {
  sessionName: string;
  /**
   * The palette size and lossless switch that produced these results.
   *
   * Per file rather than global, and this is not the settings migration the plan deferred: these
   * two live in plain useState today and persist nowhere at all. Reopening a batch and finding the
   * controls showing something other than what made its outputs would be a quiet lie about what is
   * on screen.
   */
  colors: number;
  lossless: boolean;
}

export const EMPTY_PNG_DOC: PngDoc = { sessionName: '', colors: 256, lossless: false };

export const pngCodec: ToolCodec<PngItem, PngDoc> = {
  tool: 'png-compressor',
  schema: 1,

  idOf: (item) => item.id,

  // The output blob is swapped wholesale when a row finishes, so identity is enough. `status` is
  // deliberately absent: it is derivable — a record exists only when there is an output, and an
  // output means done — and including it would call recordOf on every 'queued' -> 'working'
  // transition just to be told there is nothing to write.
  signatureOf: (item) => [item.output ?? null, item.name],

  async recordOf(item: PngItem): Promise<ItemPayload | null> {
    if (!item.output) return null;
    return {
      data: { name: item.name, inputSize: item.inputSize } satisfies PngItemData,
      blobs: { [OUTPUT_BLOB]: item.output },
    };
  },

  itemFrom: (record, id) => itemFromRecord(record, String(id)),

  docOf: (doc) => ({ sessionName: doc.sessionName, colors: doc.colors, lossless: doc.lossless }),
  docFrom: (raw) => parseDoc(raw),

  hasContent: (doc, items) => items.length > 0 || doc.sessionName.trim().length > 0,
  countOf: (_doc, items) => items.length,

  // Returned by reference so an unchanged first result never re-encodes the card's thumbnail.
  thumbSourceOf: (items) => items.find((item) => item.output)?.output ?? null,
};

/**
 * Rebuilds a queue row from disk.
 *
 * Mints both object URLs from the output, which is a perfectly good PNG to preview — the original
 * it was made from is not here to draw. The page owns revoking them, through the same unmount
 * cleanup that already handles the rows a user dropped.
 */
export function itemFromRecord(record: ItemRecord, id: string): PngItem {
  const d = (record.data ?? {}) as PngItemData;
  const output = record.blobs?.[OUTPUT_BLOB];
  const url = output ? URL.createObjectURL(output) : '';
  return {
    id,
    name: d.name ?? '',
    inputSize: typeof d.inputSize === 'number' && Number.isFinite(d.inputSize) ? d.inputSize : 0,
    file: null,
    previewUrl: url,
    status: 'done',
    output,
    outputUrl: url,
  };
}

/** Field by field, like every other read off disk here: a stored record is still input. */
function parseDoc(raw: unknown): PngDoc {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PNG_DOC };
  const r = raw as Record<string, unknown>;
  return {
    sessionName: typeof r.sessionName === 'string' ? r.sessionName : '',
    // A palette outside the offered choices would leave the Select showing nothing, so anything
    // unrecognised falls back to the default rather than being trusted.
    colors:
      typeof r.colors === 'number' && Number.isFinite(r.colors) && r.colors > 0
        ? Math.round(r.colors)
        : EMPTY_PNG_DOC.colors,
    lossless: r.lossless === true,
  };
}
