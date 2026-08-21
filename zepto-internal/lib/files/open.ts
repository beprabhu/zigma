'use client';

// Which file a tool page should open, handed across a client-side navigation.
//
// Module scope rather than a URL query param, for the same reason lib/session-store.ts is module
// scope: the rail navigates with next/link and the tab keeps one instance of this module for its
// lifetime, so a value set immediately before router.push is there when the destination's first
// render reads it. A `?file=` param would be addressable, which is worth nothing for a store that
// exists only inside one browser profile, and it costs a genuine class of bugs — a stale id in a
// bookmark, a back-button landing on a deleted file, and above all a "make a new file" param that
// survives in the address bar and mints a second file on every reload.

import type { ToolSlug } from './types';

let pending: { tool: ToolSlug; fileId: string } | null = null;
let pendingNew: ToolSlug | null = null;

/** Set by a homepage card immediately before it navigates to the tool. */
export function requestOpen(tool: ToolSlug, fileId: string): void {
  pending = { tool, fileId };
  pendingNew = null;
}

/**
 * Start a fresh file in this tool, ignoring both the live session and the resume pointer.
 *
 * Without this there is no way to have a second file in a tool at all: a plain rail click resumes
 * whatever was open, which is the right default and a dead end on its own. The rail carries the
 * control (see components/app-sidebar.tsx) because that is where new work starts — home is the
 * grid of work that already exists.
 */
export function requestNew(tool: ToolSlug): void {
  pending = null;
  pendingNew = tool;
  // Announced, because navigating to the route you are already on is a no-op in the App Router:
  // without this, pressing "+" inside the tool would set the flag and nothing would ever re-read
  // it. Listeners remount the page, which is also the only way to reset a page's whole state
  // without enumerating it.
  for (const listener of newListeners) listener(tool);
}

type NewFileListener = (tool: ToolSlug) => void;
const newListeners = new Set<NewFileListener>();

export function onNewRequested(listener: NewFileListener): () => void {
  newListeners.add(listener);
  return () => {
    newListeners.delete(listener);
  };
}

/** Pure read, for the same StrictMode reason as peekOpen. Cleared by clearOpen. */
export function peekNew(tool: ToolSlug): boolean {
  return pendingNew === tool;
}

/**
 * The file this tool was asked to open, or null.
 *
 * A pure read, like readSession and for the same reason: React StrictMode double-invokes a useState
 * initializer, and a read that consumed would hand the second pass a null and silently mint a new
 * file instead of opening the one the user clicked.
 */
export function peekOpen(tool: ToolSlug): string | null {
  return pending && pending.tool === tool ? pending.fileId : null;
}

/** Forgets the request. Called once the page has committed to a file id. */
export function clearOpen(): void {
  pending = null;
  pendingNew = null;
}

/** Drops a request naming a file that no longer exists, so the rail does not reopen a ghost. */
export function forgetOpen(fileId: string): void {
  if (pending?.fileId === fileId) pending = null;
  if (typeof localStorage !== 'undefined') {
    for (const tool of ['compositor', 'bg-remover', 'image-generator', 'png-compressor'] as const) {
      if (localStorage.getItem(lastKey(tool)) === fileId) localStorage.removeItem(lastKey(tool));
    }
  }
}

// ---- Last opened ----------------------------------------------------------
//
// Module scope dies with the tab, which is exactly what a crash is. Without something that
// outlives it, reloading /bg-remover after a crash resolves to a brand-new empty file and the
// batch that was on screen a second ago is reachable only by knowing to visit the homepage — the
// old crash net at least ASKED. So the last file each tool had open is remembered here, and a bare
// visit resumes it silently. That is the whole promise of dropping the prompt: the work is simply
// there, the way reopening Figma returns you to the file you were in.

function lastKey(tool: ToolSlug): string {
  return `zigma:last:${tool}`;
}

export function rememberOpen(tool: ToolSlug, fileId: string): void {
  try {
    localStorage.setItem(lastKey(tool), fileId);
  } catch {
    // Private mode, or storage denied. Resuming is a convenience; nothing downstream depends on it.
  }
}

export function lastOpened(tool: ToolSlug): string | null {
  try {
    return localStorage.getItem(lastKey(tool));
  } catch {
    return null;
  }
}

/** Forgets the resume pointer, so the tool's next visit starts a new file. */
export function forgetLastOpened(tool: ToolSlug): void {
  try {
    localStorage.removeItem(lastKey(tool));
  } catch {
    // Nothing to do — the pointer is best-effort in both directions.
  }
}

/**
 * Decides which file a mount is editing, and whether the tab's live snapshot belongs to it.
 *
 * The precedence is the part worth stating: an explicit request from the homepage BEATS the live
 * snapshot. Getting that backwards is subtle and bad — with file A open in the tab, clicking card B
 * on the homepage would read the snapshot, find A, and reopen A, so the card the user clicked
 * simply never opens. When the request and the snapshot disagree, the snapshot is dropped rather
 * than adopted: its rows belong to a different file and merging them would move work between files.
 */
export function resolveOpen<T extends { fileId?: string }>(
  tool: ToolSlug,
  snapshot: T | undefined,
): { fileId: string | null; snapshot: T | undefined } {
  // An explicit "new file" beats everything, including a live snapshot: the user asked for an
  // empty document, and adopting the rows they were just looking at would be the opposite.
  if (peekNew(tool)) return { fileId: null, snapshot: undefined };
  const requested = peekOpen(tool);
  if (requested) {
    return snapshot?.fileId === requested
      ? { fileId: requested, snapshot }
      : { fileId: requested, snapshot: undefined };
  }
  if (snapshot?.fileId) return { fileId: snapshot.fileId, snapshot };
  return { fileId: lastOpened(tool), snapshot: undefined };
}
