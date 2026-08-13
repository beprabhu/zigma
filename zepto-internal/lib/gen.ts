// Image Generator: turning one CSV row + one Markdown brief into one Azure prompt.
//
// The whole product hangs off buildRowPrompt. It is pure and has no DOM or network in it, so
// the assembly rule can be reasoned about (and shown to the user verbatim) without running a
// batch — a prompt you cannot inspect is a prompt you cannot debug.

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

/** Separates the brief from the row block. Visible in the preview, so it is part of the API. */
const ROW_HEADING = 'Generate an image for this row:';

/**
 * brief + the row's cells, each labelled with its column header.
 *
 * Column names are sent, not just values: "subject: a diya lamp" carries intent that a bare
 * "a diya lamp" loses, and the header is the only place that intent is written down. Blank
 * cells are dropped rather than sent as `use:` with nothing after it, which reads to the model
 * as an instruction to leave that aspect empty.
 */
export function buildRowPrompt(
  brief: string,
  headers: string[],
  record: CsvRecord,
  excluded: ReadonlySet<string> = new Set(),
): string {
  const rowBlock = headers
    .filter((header) => !excluded.has(header))
    .map((header) => [header, (record[header] ?? '').trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([header, value]) => `${header}: ${value}`)
    .join('\n');

  const parts: string[] = [];
  const trimmedBrief = brief.trim();
  if (trimmedBrief) parts.push(trimmedBrief);
  if (rowBlock) parts.push(`---\n${ROW_HEADING}\n${rowBlock}`);
  return parts.join('\n\n');
}

/** Rows with nothing to say produce nothing to send — caught before a request is spent. */
export function isPromptEmpty(prompt: string): boolean {
  return prompt.trim().length === 0;
}

// Azure rejects oversized prompts outright; warn well before that so a long brief is caught
// while it is still editable rather than N failed requests later.
export const PROMPT_WARN_CHARS = 30_000;

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
