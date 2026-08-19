// One CSV row + one base prompt → one Azure prompt. Shared by Generate (a Markdown brief per
// row, text-to-image) and Cleanup (the AI-edit prompt plus the row the picture came from).
//
// Pure, with no DOM or network in it, so the assembly rule can be reasoned about — and shown to
// the user verbatim — without running a batch. A prompt you cannot inspect is a prompt you
// cannot debug, which is why both products render the assembled string rather than the recipe.

import type { CsvRecord } from './csv';

/** Generate's separator line. Visible in its preview, so it is part of that product's API. */
export const ROW_HEADING = 'Generate an image for this row:';

/** The same line for a typed subject rather than a CSV row. */
export const SUBJECT_HEADING = 'Generate an image of:';

/**
 * base prompt + the row's cells, each labelled with its column header.
 *
 * Column names are sent, not just values: "subject: a diya lamp" carries intent that a bare
 * "a diya lamp" loses, and the header is the only place that intent is written down. Blank
 * cells are dropped rather than sent as `use:` with nothing after it, which reads to the model
 * as an instruction to leave that aspect empty.
 *
 * `headers` fixes the order — CSV order, not object-key order — and `excluded` removes columns
 * from it. Callers that track an INCLUSION list (Cleanup: nothing is sent until it is picked)
 * pass the picked columns as `headers` and leave `excluded` empty; the two forms assemble the
 * same way.
 */
export function buildRowPrompt(
  base: string,
  headers: string[],
  record: CsvRecord,
  excluded: ReadonlySet<string> = new Set(),
  heading: string = ROW_HEADING,
): string {
  const rowBlock = headers
    .filter((header) => !excluded.has(header))
    .map((header) => [header, (record[header] ?? '').trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([header, value]) => `${header}: ${value}`)
    .join('\n');

  const parts: string[] = [];
  const trimmedBase = base.trim();
  if (trimmedBase) parts.push(trimmedBase);
  if (rowBlock) parts.push(`---\n${heading}\n${rowBlock}`);
  return parts.join('\n\n');
}

/**
 * base prompt + one typed subject — the list box's equivalent of buildRowPrompt.
 *
 * Same shape as a row's prompt (base, rule, then the specific thing) so a subject and a CSV row
 * reach the model through the same structure, and the assembled string a cell shows reads the
 * same whichever source it came from. With no base, the subject IS the prompt: the separator
 * would otherwise open a section with nothing above it.
 */
export function buildSubjectPrompt(base: string, subject: string): string {
  const trimmedBase = base.trim();
  const trimmedSubject = subject.trim();
  if (!trimmedBase) return trimmedSubject;
  if (!trimmedSubject) return trimmedBase;
  return `${trimmedBase}\n\n---\n${SUBJECT_HEADING}\n${trimmedSubject}`;
}

/** Rows with nothing to say produce nothing to send — caught before a request is spent. */
export function isPromptEmpty(prompt: string): boolean {
  return prompt.trim().length === 0;
}

// Azure rejects oversized prompts outright; warn well before that so a long brief is caught
// while it is still editable rather than N failed requests later.
export const PROMPT_WARN_CHARS = 30_000;
