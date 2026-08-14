// Image Generator: the queue item a CSV row becomes, and the naming around it.
//
// The prompt rule itself lives in lib/row-prompt.ts — Cleanup sends row context with its
// AI-edit prompt the same way, and one assembly rule for both is what keeps the two previews
// honest about each other.

import type { CsvRecord } from './csv';

export type GenStatus = 'ready' | 'generating' | 'done' | 'error';

export interface GenItem {
  id: number;
  /** The CSV row, kept whole so re-mapping columns never needs the file re-read. */
  record: CsvRecord;
  /** Names the tile and the exported file; from the chosen name column. */
  name: string;
  status: GenStatus;
  errorMsg?: string;
  image: HTMLImageElement | null;
  /**
   * The prompt actually sent, captured at send time. The live preview is derived from the
   * current brief and column selection, so without this a row generated before an edit would
   * claim it used the edited brief.
   */
  sentPrompt?: string;
  durationMs?: number;
  /**
   * One-slot undo: the result the last regenerate replaced. Only set when there WAS a previous
   * image; overwritten by the next regenerate, cleared by undo.
   */
  prev?: { image: HTMLImageElement; sentPrompt?: string; durationMs?: number };
}

export function createGenItems(
  records: CsvRecord[],
  nameColumn: string,
  startId: number,
): GenItem[] {
  return records.map((record, i) => ({
    id: startId + i,
    record,
    name: (nameColumn ? record[nameColumn] : '')?.trim() || `Row ${startId + i + 1}`,
    status: 'ready',
    image: null,
  }));
}

export function nextGenId(items: GenItem[]): number {
  return items.reduce((max, item) => (item.id > max ? item.id : max), -1) + 1;
}

/** Filesystem-safe stem from a row name; mirrors the compositor's export naming. */
export function genFileStem(name: string, fallback: string): string {
  const base = name
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return base || fallback;
}
