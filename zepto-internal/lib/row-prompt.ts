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
 * What a cell reads as once its URL is being sent as an actual image instead of as text.
 *
 * The URL itself is deliberately not in the prompt. A model cannot fetch it, so at best the
 * string is ignored and at worst it gets rendered as literal text somewhere in the picture —
 * while the thing the column actually means has already been attached to the request. Naming the
 * column and saying what happened to it keeps the preview honest about what was sent.
 */
export const REFERENCE_MARKER = '(attached as a reference image)';

/**
 * Whether a reference column's cell is something the request can actually attach.
 *
 * The single place that decides: both the marker and the URLs referenceUrls hands to the fetcher
 * come from here, so the prompt cannot claim an attachment the request never made. Reference
 * columns are detected across the sheet as a whole, which leaves any individual row free to hold
 * a code, a relative path or a typo where its neighbours hold links. Such a cell keeps its own
 * text, exactly as it would in a column that was never detected — a picture generated from text
 * alone, under a prompt saying a reference was used, is the wrong result nobody catches by eye.
 */
function isReferenceUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

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
  /**
   * Columns whose cells are image URLs being sent as reference images rather than as text. Their
   * values are replaced with REFERENCE_MARKER — see the note on that constant — for the cells
   * referenceUrls would actually attach, and only those.
   */
  references: ReadonlySet<string> = new Set(),
): string {
  const rowBlock = headers
    .filter((header) => !excluded.has(header))
    .map((header) => [header, (record[header] ?? '').trim()] as const)
    .filter(([, value]) => value.length > 0)
    .map(([header, value]) => {
      const attached = references.has(header) && isReferenceUrl(value);
      return `${header}: ${attached ? REFERENCE_MARKER : value}`;
    })
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

/**
 * The image URLs a row contributes, in column order, for the picked reference columns.
 *
 * Order matters and is the sheet's: a brief that says "use the first image for the pack and the
 * second for the flavour" is only meaningful if the request receives them the same way round for
 * every row.
 *
 * Cells this drops are the ones buildRowPrompt leaves as text, so prompt and request describe
 * the same call.
 */
export function referenceUrls(
  headers: string[],
  record: CsvRecord,
  references: ReadonlySet<string>,
): string[] {
  return headers
    .filter((header) => references.has(header))
    .map((header) => (record[header] ?? '').trim())
    .filter(isReferenceUrl);
}
