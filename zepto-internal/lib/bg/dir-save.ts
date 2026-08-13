// Where a live-sealing run puts its ZIPs, without a click per batch.
//
// pickSave (lib/bg/batch.ts) is the one-file version of this, and its comment states the rule
// both obey: a save dialog only opens while the triggering click still counts as user
// activation, so an export that spends minutes encoding has to ask FIRST and write when the
// bytes are ready. A live-sealing run cannot ask at all — it seals a cohort of clean cutouts
// every few hundred images while inference carries on, and there is no click at that moment to
// hang a dialog on. A DIRECTORY handle is the way out: granted once during a real gesture, it
// stays writable afterwards, so every batch the run seals lands on disk on its own.
//
// Chromium-only, and everything here degrades to a value rather than throwing — "no folder" is
// a supported way to run, with the caller falling back to a Download button per sealed chip
// that the user presses whenever they get to it. The refusals are kept apart because they are
// three different products: an unsupported browser must never be offered the folder again, a
// cancelled picker leaves the button armed for a second try, and a lapsed permission has to be
// re-granted from a gesture. A module that threw instead would take down the run that produced
// the batches, which is the one thing that cannot be redone cheaply.

import { errorMessage, isAbortError } from './batch';

/**
 * queryPermission/requestPermission are File System Access extensions to FileSystemHandle and
 * are not in lib.dom, so the two methods this module needs are declared structurally — the same
 * approach pickSave takes for showSaveFilePicker, and for the same reason: the alternative is a
 * global augmentation that would claim these exist on every handle in the app.
 */
interface HandlePermissions {
  queryPermission?(descriptor: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  /** Chrome remembers the last directory chosen under an id, so a second run opens where the
   *  first one saved instead of at the default location every time. */
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: string;
}

type DirectoryPicker = (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;

/** Namespaces the remembered directory so batch exports and any later picker cannot fight. */
const PICKER_ID = 'zesku-batch-exports';

/** Suffix ceiling for collision renaming, purely so a broken folder cannot spin forever. */
const MAX_NAME_ATTEMPTS = 999;

/**
 * A folder the user handed over, plus the names it has already given out.
 *
 * Constructed only by pickSaveFolder — the claimed set has to start empty alongside a fresh
 * grant, and a caller assembling one by hand would silently lose the collision guard below.
 */
export interface SaveFolder {
  readonly handle: FileSystemDirectoryHandle;
  /**
   * Names reserved by a save in this session, held because the disk probe only sees files that
   * ALREADY exist and the target file is not created until the write begins. Two saves
   * overlapping — a seal landing while the tail export is still writing — would both probe
   * `clean-1.zip`, both be told it is free, and the second would overwrite the first. A name is
   * released again if its write fails, so retrying a batch reuses the clean name rather than
   * stepping to `-2` for a file that was never left on disk.
   */
  readonly claimed: Set<string>;
}

/** Why no folder was obtained. Each demands a different response — see the header. */
export type FolderPickFailure = 'unsupported' | 'cancelled' | 'failed';

export type FolderPick =
  | { ok: true; folder: SaveFolder }
  | { ok: false; reason: FolderPickFailure; message?: string };

/**
 * Why a write did not land.
 *
 * 'denied' and 'missing' are terminal for the handle — the grant is gone, or the folder was
 * renamed, deleted or unmounted — so the caller must drop it and finish the run on
 * click-to-download. 'failed' (a full disk is the realistic one) leaves the folder usable, so
 * retrying that batch is meaningful.
 */
export type FolderWriteFailure = 'denied' | 'missing' | 'failed';

export type FolderWrite =
  | {
      ok: true;
      /** What actually landed on disk — not necessarily what was asked for; see renamed. */
      fileName: string;
      /** A file of the requested name was already there, so this one was suffixed aside. */
      renamed: boolean;
    }
  | { ok: false; reason: FolderWriteFailure; message: string };

/**
 * Whether this browser can save into a folder at all.
 *
 * Guarded against a missing window rather than reading it straight: Next prerenders client
 * components on the server, so anything calling this during render — a button deciding whether
 * to offer the folder at all — would otherwise throw at build time. It is also a runtime
 * function check on purpose: the picker is absent in an insecure context and in a cross-origin
 * iframe even on Chrome, which no user-agent test would catch.
 */
export function supportsFolderSave(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker === 'function';
}

/** The folder's display name, so callers never have to reach through to the raw handle. */
export function folderName(folder: SaveFolder): string {
  return folder.handle.name;
}

/**
 * Asks for the destination folder. Must be called from a user gesture — a click handler, not an
 * effect and not the seal.
 *
 * `mode: 'readwrite'` is what makes the whole scheme work. Picked read-only, the handle comes
 * back usable but the FIRST write raises a permission prompt, and by then the gesture is spent
 * and the run is minutes deep — exactly the failure the directory handle exists to avoid. Write
 * access is therefore part of the one question the user is asked.
 */
export async function pickSaveFolder(): Promise<FolderPick> {
  if (typeof window === 'undefined') return { ok: false, reason: 'unsupported' };
  const picker = (window as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (typeof picker !== 'function') return { ok: false, reason: 'unsupported' };
  try {
    const handle = await picker.call(window, {
      id: PICKER_ID,
      mode: 'readwrite',
      startIn: 'downloads',
    });
    return { ok: true, folder: { handle, claimed: new Set<string>() } };
  } catch (e) {
    // Dismissing the picker means "not into a folder", not "pick one for me" — the same reading
    // pickSave gives its own AbortError.
    if (isAbortError(e)) return { ok: false, reason: 'cancelled' };
    return { ok: false, reason: 'failed', message: errorMessage(e) };
  }
}

/**
 * Confirms the folder is still writable, re-asking the user if the grant has lapsed.
 *
 * Call it from the click that STARTS a run, never from a seal. Chrome drops a directory grant on
 * reload and the user can revoke it from the omnibox at any point, including between two batches
 * of one run — but requestPermission() needs transient user activation to show its prompt, so
 * called mid-run it resolves 'denied' without the user ever being shown anything, and the run
 * would report a revoked folder that was merely never re-asked for.
 *
 * Returns true when writes may proceed.
 */
export async function ensureFolderAccess(folder: SaveFolder): Promise<boolean> {
  const handle = folder.handle as FileSystemDirectoryHandle & HandlePermissions;
  try {
    // Absent methods mean an implementation that grants for the handle's lifetime; assume yes
    // and let the write itself be the arbiter rather than refusing a folder that would work.
    if (typeof handle.queryPermission !== 'function') return true;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    if (typeof handle.requestPermission !== 'function') return false;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Writes one finished ZIP into the folder.
 *
 * The Blob goes to the stream whole and is never read into an ArrayBuffer: buildZipStream
 * returns a parts list over the cutout blobs rather than their bytes, and materialising it here
 * would undo that at the last step and reintroduce the "failed to allocate buffer" death on
 * multi-GB exports. saveTo writes the same way for the same reason.
 *
 * Permission is checked but NOT re-requested — see ensureFolderAccess. A prompt appearing
 * unbidden partway through a long run is dismissed as noise more often than it is read, and a
 * dismissal is a permanent denial for the origin.
 */
export async function saveInFolder(
  folder: SaveFolder,
  blob: Blob,
  fileName: string,
): Promise<FolderWrite> {
  const handle = folder.handle as FileSystemDirectoryHandle & HandlePermissions;
  try {
    if (typeof handle.queryPermission === 'function') {
      if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        return {
          ok: false,
          reason: 'denied',
          message: `Write access to “${folder.handle.name}” is no longer granted.`,
        };
      }
    }
  } catch (e) {
    return writeFailure(e);
  }

  let name: string;
  try {
    const free = await reserveName(folder, fileName);
    if (!free) {
      return {
        ok: false,
        reason: 'failed',
        message: `“${folder.handle.name}” already holds ${MAX_NAME_ATTEMPTS} files named like ${fileName}.`,
      };
    }
    name = free;
  } catch (e) {
    return writeFailure(e);
  }

  let file: FileSystemFileHandle;
  try {
    file = await folder.handle.getFileHandle(name, { create: true });
  } catch (e) {
    folder.claimed.delete(name);
    return writeFailure(e);
  }

  let writable: FileSystemWritableFileStream;
  try {
    writable = await file.createWritable();
  } catch (e) {
    // getFileHandle has already left a zero-byte file behind. Clearing it matters more than the
    // error does: a 0 KB clean-2.zip sitting beside real exports reads as a finished batch.
    await discard(folder, name);
    return writeFailure(e);
  }

  try {
    await writable.write(blob);
    await writable.close();
  } catch (e) {
    // abort() releases the swap file Chrome writes through; without it a .crswap is left in the
    // user's export folder. Both cleanups are best-effort — the write already failed, and the
    // caller needs the reason for THAT, not for the tidying up.
    await writable.abort().catch(() => {});
    await discard(folder, name);
    return writeFailure(e);
  }

  return { ok: true, fileName: name, renamed: name !== fileName };
}

/**
 * The first free name at or after `fileName`, reserved on the folder before it is returned.
 * null means the ceiling was hit.
 *
 * Repeats take the `-2`, `-3` … suffix exportFileNames uses inside a ZIP, so a folder holding
 * two runs' worth of exports is numbered the way the files inside them already are.
 */
async function reserveName(folder: SaveFolder, fileName: string): Promise<string | null> {
  const dot = fileName.lastIndexOf('.');
  // dot > 0 rather than >= 0: a leading dot is a hidden file's name, not an extension, and
  // splitting there would suffix the stem into nothing.
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const candidate = n === 1 ? fileName : `${stem}-${n}${ext}`;
    if (folder.claimed.has(candidate)) continue;
    if (await isTaken(folder.handle, candidate)) continue;
    folder.claimed.add(candidate);
    return candidate;
  }
  return null;
}

async function isTaken(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (e) {
    const kind = (e as { name?: string } | null)?.name;
    if (kind === 'NotFoundError') return false;
    // A DIRECTORY of that name raises TypeMismatchError. The name is still spoken for, and
    // creating a file over it would fail anyway.
    if (kind === 'TypeMismatchError') return true;
    throw e;
  }
}

/** Removes a file this module created and frees its reservation. Never throws. */
async function discard(folder: SaveFolder, name: string): Promise<void> {
  try {
    await folder.handle.removeEntry(name);
  } catch {
    // Nothing to do about it: the name only ever refers to a file reserveName found free, so at
    // worst an empty file stays where a failing disk already left one.
  }
  folder.claimed.delete(name);
}

function writeFailure(e: unknown): { ok: false; reason: FolderWriteFailure; message: string } {
  const kind = (e as { name?: string } | null)?.name;
  const reason: FolderWriteFailure =
    kind === 'NotAllowedError' || kind === 'SecurityError'
      ? 'denied'
      : kind === 'NotFoundError'
        ? 'missing'
        : 'failed';
  return { ok: false, reason, message: errorMessage(e) };
}
