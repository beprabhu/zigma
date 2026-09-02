// Image Generator: the queue item a CSV row becomes, and the naming around it.
//
// The prompt rule itself lives in lib/row-prompt.ts — Cleanup sends row context with its
// AI-edit prompt the same way, and one assembly rule for both is what keeps the two previews
// honest about each other.

import type { RetryInfo } from '@/lib/pipeline';
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
  /**
   * Set while a rate-limited row waits for its next attempt, so the cell can say "retrying"
   * instead of looking stuck. Transient by construction — outside the codec's signature, never
   * written to disk, dropped from the session snapshot — and cleared by whichever patch ends
   * the run. Deliberately NOT a status: a status this suite does not know how to rest comes
   * back from a product switch as a spinner that never finishes (see lib/session-store.ts).
   */
  retry?: RetryInfo;
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

/**
 * A row's identity as a string, independent of column ORDER.
 *
 * `JSON.stringify` of a record serialises keys in insertion order, which for a parsed sheet is the
 * header order — so the same products re-exported with two columns swapped would match nothing,
 * rebuild every row imageless, and let the pump delete the images off disk. Sorting the entries
 * costs nothing at these sizes and makes the key describe the DATA rather than the spreadsheet's
 * column layout.
 */
function recordKey(record: CsvRecord): string {
  return JSON.stringify(Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * A dropped sheet as queue items, reusing the item that already holds each row.
 *
 * The sheet-mode twin of reconcileSubjectItems above, matched on the row's RECORD — in a CSV run
 * the record is the row's identity the way the typed text is in a list run. So re-dropping the
 * same or an edited CSV keeps every generated image whose row is still in the sheet, which is
 * exactly what the delete dialog promises ("rows still in the CSV file come back if you drop it
 * again"). Before this, a re-drop rebuilt the queue from scratch: every id renumbered by sheet
 * position, every image dropped on the floor — and the autosave then faithfully saved the loss.
 *
 * Matching is by the record's full content. A row edited in the sheet therefore comes back as a
 * NEW row without its old image — deliberate: the image was generated from the old values, and
 * quietly keeping it would pin a stale picture on a row that no longer says what it said.
 */
export function reconcileCsvItems(
  records: CsvRecord[],
  nameColumns: readonly string[],
  existing: GenItem[],
): GenItem[] {
  const spare = new Map<string, GenItem[]>();
  for (const item of existing) {
    if (item.subject !== undefined) continue; // typed rows are the other reconcile's business
    const key = recordKey(item.record);
    const bucket = spare.get(key);
    if (bucket) bucket.push(item);
    else spare.set(key, [item]);
  }
  let nextId = nextGenId(existing);
  return records.map((record, i) => {
    const reused = spare.get(recordKey(record))?.shift();
    const name = joinNameColumns(record, nameColumns) || `Row ${i + 1}`;
    if (reused) return { ...reused, name };
    return { id: nextId++, record, name, status: 'ready' as const, image: null };
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
