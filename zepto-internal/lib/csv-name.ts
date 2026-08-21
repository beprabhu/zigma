// Naming a row from its CSV columns.
//
// Every page that imports a sheet — Generate, Compose, Cleanup — lets you say which column
// names the row. One column was rarely enough: catalogue sheets split what a human reads as
// one name across title, variant and pack-size columns, and picking a single one gave 40 rows
// all called "Bindi Set". So the choice is a LIST, joined in the order the sheet declares its
// columns rather than the order they were clicked — two rows of one sheet must produce
// comparably-built names, and click order is not a property of the data.
//
// Kept in its own module because the three pages store the choice in three different shapes
// (a queue's csvInfo, a generator session, a compositor band) and all three have to agree on
// what a name IS, including for files already exported under the old single-column rule.

/**
 * Between joined values. Visible in previews and, after export sanitising, in filenames — so
 * it is a boundary a person can still see once the parts are concatenated.
 */
export const NAME_SEPARATOR = ' - ';

/**
 * Row's name from the chosen columns. Blank cells are skipped rather than contributing an
 * empty slot: a sheet where only some rows carry a variant would otherwise export half its
 * files with a dangling separator.
 *
 * Returns '' when nothing is chosen or every chosen cell is empty — callers own the fallback
 * (URL filename, row number), which differs per page.
 */
export function joinNameColumns(
  record: Record<string, string> | undefined,
  columns: readonly string[],
): string {
  if (!record || !columns.length) return '';
  const parts: string[] = [];
  for (const column of columns) {
    const value = record[column]?.trim();
    if (value) parts.push(value);
  }
  return parts.join(NAME_SEPARATOR);
}

/**
 * Reads a persisted choice back as a list, whatever shape it was saved in.
 *
 * Saved projects, autosave records and generator sessions all predate the multi-column rule
 * and hold a single string. They must keep opening, and must keep producing the same names
 * they did before — so a lone string becomes a one-element list, and an empty one an empty
 * list (which is the "no column chosen" state, not a column named '').
 */
export function normalizeNameColumns(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v);
  if (typeof value === 'string' && value) return [value];
  return [];
}
