'use client';

// Folder-aware drop reading, for every product's dropzone.
//
// `DataTransfer.files` flattens to nothing useful when a FOLDER is dropped — the folder itself
// arrives as a zero-byte entry, and the images inside it never appear. The webkitGetAsEntry
// tree is the only way to reach them, so this walks it and hands back the real files.
//
// The one rule that makes this fragile: `DataTransfer.items` is only valid DURING the drop
// event. Reading it after an await gives an empty list, which is why entriesOf() below is
// synchronous and runs before anything is awaited.

/** Depth guard. Deep trees are legitimate; unbounded recursion on a symlink loop is not. */
const MAX_DEPTH = 8;

/** The entry tree roots, read SYNCHRONOUSLY — see the note above about item lifetime. */
function entriesOf(dt: DataTransfer): FileSystemEntry[] {
  const items = dt.items ? [...dt.items] : [];
  return items
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
}

function fileOf(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file((file) => resolve(file), () => resolve(null));
  });
}

/**
 * One directory's children. readEntries hands back AT MOST 100 per call and signals the end
 * with an empty batch, so a folder of 500 images needs five calls — a single call is the bug
 * that makes big folders look like they imported fine and came up short.
 */
async function childrenOf(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries((entries) => resolve(entries), () => resolve([]));
    });
    if (!batch.length) return all;
    all.push(...batch);
  }
}

async function walk(entry: FileSystemEntry, out: File[], depth: number): Promise<void> {
  // Dotfiles are never what someone meant to drop, and every macOS folder carries a .DS_Store.
  if (entry.fullPath.split('/').some((seg) => seg.startsWith('.'))) return;
  if (entry.isFile) {
    const file = await fileOf(entry as FileSystemFileEntry);
    if (file) out.push(file);
    return;
  }
  if (!entry.isDirectory || depth >= MAX_DEPTH) return;
  for (const child of await childrenOf(entry as FileSystemDirectoryEntry)) {
    await walk(child, out, depth + 1);
  }
}

/**
 * Every file in a drop, descending into folders. Falls back to `dataTransfer.files` where the
 * entry API is missing, so a plain multi-file drop works either way.
 *
 * Sorted by path, numerically: a folder walk arrives in filesystem order, which is arbitrary,
 * and Compose numbers tiles by queue position — so without this "row 1" is whichever file the
 * OS happened to hand over first, and `img10` lands before `img2`.
 */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  const roots = entriesOf(dt);
  // Sorted on BOTH paths, so a browser without the entry API orders a drop the same way one
  // with it does — otherwise row numbers would depend on which branch ran.
  if (!roots.length) return sortByPath([...(dt.files ?? [])]);
  const out: File[] = [];
  for (const root of roots) await walk(root, out, 0);
  return sortByPath(out);
}

/** webkitRelativePath is set by a directory <input>; a walked entry only has its name. */
function pathOf(file: File): string {
  return file.webkitRelativePath || file.name;
}

/** Same ordering rule for the folder <input> path, whose files also arrive unsorted. */
export function sortByPath(files: File[]): File[] {
  return [...files].sort((a, b) =>
    pathOf(a).localeCompare(pathOf(b), undefined, { numeric: true, sensitivity: 'base' }),
  );
}
