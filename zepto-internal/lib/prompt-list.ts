// A typed list of subjects → one request each. Generate's second row source, beside a CSV.
//
// The whole module is pure string work: no DOM, no React. The textarea behaviour (Enter
// continues the list, Backspace leaves it) is expressed as "given this text and this caret,
// what is the next text and caret" so the rule can be reasoned about — and changed — without a
// browser, exactly like lib/row-prompt.ts is for the prompt itself.

/** `1. cat` — the marker, its spacing, and the content after it. */
const ITEM = /^(\d+)\.([ \t]*)(.*)$/;

export interface ListEdit {
  text: string;
  /** Where the caret lands afterwards, so the component can restore it. */
  caret: number;
}

/** Line bounds containing `pos`, as [start, end) excluding the newline. */
function lineAt(text: string, pos: number): [number, number] {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  return [start, nl === -1 ? text.length : nl];
}

/**
 * Renumbers the numbered lines AFTER `afterLine` so the list counts 1, 2, 3 again.
 *
 * Only later lines are touched, which is what lets every caller leave the caret alone: an edit
 * that renumbers can never change the length of anything the caret sits behind.
 */
function renumberAfter(text: string, afterLine: number): string {
  const lines = text.split('\n');
  let n = 0;
  return lines
    .map((line, i) => {
      const m = line.match(ITEM);
      if (!m) return line;
      n += 1;
      return i <= afterLine ? line : `${n}.${m[2] || ' '}${m[3]}`;
    })
    .join('\n');
}

function lineIndexOf(text: string, pos: number): number {
  let index = 0;
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') index += 1;
  return index;
}

/**
 * Enter inside a numbered list.
 *
 * On an item with content, the next marker is written for you — this is the whole of "typing
 * `1. ` turns on numbering": the first marker is typed, every one after it is not. On an item
 * left empty, Enter takes the marker away instead and drops out of the list, which is the only
 * exit that does not require selecting the digits and deleting them by hand.
 *
 * Returns null when the key should do its normal thing (not in a list, or a range is selected
 * and Enter is a replace).
 */
export function listEnter(text: string, start: number, end: number): ListEdit | null {
  if (start !== end) return null;
  const [lineStart, lineEnd] = lineAt(text, start);
  const m = text.slice(lineStart, lineEnd).match(ITEM);
  if (!m) return null;

  // An empty item: leave the list rather than writing a marker nobody asked for.
  if (!m[3].trim()) {
    const next = `${text.slice(0, lineStart)}${text.slice(lineEnd)}`;
    return { text: renumberAfter(next, lineIndexOf(next, lineStart) - 1), caret: lineStart };
  }

  const marker = `\n${Number(m[1]) + 1}. `;
  const next = `${text.slice(0, start)}${marker}${text.slice(start)}`;
  const caret = start + marker.length;
  return { text: renumberAfter(next, lineIndexOf(next, caret)), caret };
}

/**
 * Backspace with the caret directly after a marker: takes the marker off instead of eating one
 * character of it, so a line reverts to plain text in one press rather than three.
 */
export function listBackspace(text: string, start: number, end: number): ListEdit | null {
  if (start !== end) return null;
  const [lineStart, lineEnd] = lineAt(text, start);
  const m = text.slice(lineStart, lineEnd).match(ITEM);
  if (!m) return null;
  const markerLength = m[1].length + 1 + m[2].length;
  if (start !== lineStart + markerLength) return null;
  const next = `${text.slice(0, lineStart)}${text.slice(lineStart + markerLength)}`;
  return { text: renumberAfter(next, lineIndexOf(next, lineStart)), caret: lineStart };
}

/**
 * The list as the requests it will be sent as.
 *
 * A numbered line opens a request; unnumbered lines under it are part of it, so an item can
 * run to several lines. Text ABOVE the first marker is a request of its own rather than being
 * dropped — silently ignoring typed input is the one behaviour a prompt box must never have.
 * With no markers at all the whole box is a single request, which is what makes the plain
 * "brief + one prompt" case work without any list syntax.
 */
export function parsePromptList(text: string): string[] {
  const lines = text.split('\n');
  const groups: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    const m = line.match(ITEM);
    if (m) {
      current = [m[3]];
      groups.push(current);
    } else if (current) {
      current.push(line);
    } else {
      if (!groups.length) groups.push((current = []));
      current!.push(line);
    }
  }

  return groups.map((g) => g.join('\n').trim()).filter((s) => s.length > 0);
}

/**
 * Requests back to list text, canonically numbered.
 *
 * Used when the grid is what changed — deleting a cell has to take its line with it, or the
 * next keystroke in the box would type the row straight back. Multi-line items keep their extra
 * lines; only the markers are rewritten.
 */
export function formatPromptList(items: string[]): string {
  return items
    .map((item, i) => {
      const [first, ...rest] = item.split('\n');
      return [`${i + 1}. ${first}`, ...rest].join('\n');
    })
    .join('\n');
}
