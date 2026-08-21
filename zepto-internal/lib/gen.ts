// Image Generator: the queue item a CSV row becomes, and the naming around it.
//
// The prompt rule itself lives in lib/row-prompt.ts — Cleanup sends row context with its
// AI-edit prompt the same way, and one assembly rule for both is what keeps the two previews
// honest about each other.

import type { CsvRecord } from './csv';
import { joinNameColumns } from './csv-name';

/**
 * The shapes the image endpoints return. Lives here rather than in the page because the results
 * grid has to reserve the SAME shape the panel is asking for — a square frame around a run of
 * landscape images letterboxes every one of them.
 */
export const GEN_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const;
export type GenSize = (typeof GEN_SIZES)[number];

/**
 * The frame a cell reserves for a given output size. Written as literal class names so
 * Tailwind's scanner still sees them — a class assembled at runtime is never generated.
 *
 * 'auto' has no answer to reserve: the model picks per image, and it can pick differently for
 * two rows of the same run. It keeps the square frame, and object-contain letterboxes whatever
 * actually lands — which is the honest shape for "unknown until it arrives".
 */
export const GEN_ASPECT: Record<GenSize, string> = {
  '1024x1024': 'aspect-square',
  '1536x1024': 'aspect-3/2',
  '1024x1536': 'aspect-2/3',
  auto: 'aspect-square',
};

export type GenStatus = 'ready' | 'generating' | 'done' | 'error';

export interface GenItem {
  id: number;
  /** The CSV row, kept whole so re-mapping columns never needs the file re-read. Empty for a
   *  typed subject, which has no sheet behind it. */
  record: CsvRecord;
  /**
   * One line of the typed prompt list, when that is what made this item. Its presence is what
   * tells the prompt builder which of the two assembly rules this item follows — a run is
   * driven by a CSV or by the list, never a mix, so the flag never has to be reconciled.
   */
  subject?: string;
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
  nameColumns: readonly string[],
  startId: number,
): GenItem[] {
  return records.map((record, i) => ({
    id: startId + i,
    record,
    name: joinNameColumns(record, nameColumns) || `Row ${startId + i + 1}`,
    status: 'ready',
    image: null,
  }));
}

/**
 * The typed list as queue items, reusing the item that already held each subject.
 *
 * Matched on the subject TEXT, not position: editing line 3 or inserting a line above it must
 * not throw away the images lines 1 and 2 already generated. An unmatched line is new and
 * starts empty, and an item whose line is gone leaves with it.
 */
export function reconcileSubjectItems(subjects: string[], existing: GenItem[]): GenItem[] {
  const spare = new Map<string, GenItem[]>();
  for (const item of existing) {
    if (item.subject === undefined) continue;
    const bucket = spare.get(item.subject);
    if (bucket) bucket.push(item);
    else spare.set(item.subject, [item]);
  }
  let nextId = nextGenId(existing);
  return subjects.map((subject, i) => {
    const reused = spare.get(subject)?.shift();
    if (reused) return { ...reused, name: subjectName(subject, i) };
    return {
      id: nextId++,
      record: {},
      subject,
      name: subjectName(subject, i),
      status: 'ready' as const,
      image: null,
    };
  });
}

/** A subject line as a cell title and file stem: its first few words, never the whole prompt. */
function subjectName(subject: string, index: number): string {
  const firstLine = subject.split('\n')[0]!.trim();
  const short = firstLine.length > 48 ? `${firstLine.slice(0, 48).trimEnd()}…` : firstLine;
  return short || `Prompt ${index + 1}`;
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
