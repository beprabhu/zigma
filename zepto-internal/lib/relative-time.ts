// "Edited 3 minutes ago" — the one line every file card needs and nothing in the app had.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago something happened, in the shape a file browser says it.
 *
 * Coarse on purpose past the first hour: a card is scanned, not read, and "2 days ago" answers the
 * only question being asked — is this the one I was in? Exact timestamps belong in a tooltip.
 */
export function formatEdited(at: number, now: number = Date.now()): string {
  const ago = Math.max(0, now - at);
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) {
    const mins = Math.floor(ago / MINUTE);
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }
  if (ago < DAY) {
    const hours = Math.floor(ago / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(ago / DAY);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/** The full timestamp, for the title attribute behind the coarse label above. */
export function formatExact(at: number): string {
  return new Date(at).toLocaleString();
}
