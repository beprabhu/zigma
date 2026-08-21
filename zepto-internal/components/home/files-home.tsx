'use client';

// The home screen: every file the suite holds, newest first.
//
// This is also the only thing that runs the expiry sweep. That placement is deliberate — the sweep
// is the one irreversible mass-delete in the app, and running it here means it happens on a screen
// where its result is immediately visible, rather than silently behind whatever tool the user
// happened to open.

import * as React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ArrowRightIcon, FileIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { PRODUCTS, productHref } from '@/lib/products';
import { deleteFile, listFiles, setKept, subscribe } from '@/lib/files/store';
import { patchFile } from '@/lib/files/store';
import { sweepExpired } from '@/lib/files/sweep';
import { liveFileIds } from '@/lib/session-store';
import { FileCard } from './file-card';
import type { FileRecord } from '@/lib/files/types';

type View = 'files' | 'trash';

export function FilesHome() {
  const [files, setFiles] = React.useState<FileRecord[] | null>(null);
  const [view, setView] = React.useState<View>('files');
  /**
   * Thumbnail object URLs, minted per load and revoked when the next load replaces them.
   *
   * Kept here rather than in each card because a card revoking its own URL from an effect cleanup
   * breaks under StrictMode — see the note on FileCard's `thumbUrl` prop. Every listFiles() hands
   * back fresh Blob instances, so the URLs have to be re-minted per load anyway.
   */
  const urlsRef = React.useRef(new Map<string, string>());
  const [thumbUrls, setThumbUrls] = React.useState<Map<string, string>>(new Map());

  const refresh = React.useCallback(async () => {
    try {
      const list = await listFiles();
      const next = new Map<string, string>();
      for (const file of list) {
        if (file.thumb) next.set(file.id, URL.createObjectURL(file.thumb));
      }
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current = next;
      setThumbUrls(next);
      setFiles(list);
    } catch (e) {
      // No IndexedDB (private mode, storage denied): the suite still works, it just cannot
      // remember anything. An empty grid plus the launcher below is the honest rendering of that.
      console.error('files: could not list files', e);
      setFiles([]);
    }
  }, []);

  React.useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
      urlsRef.current = new Map();
    },
    [],
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      // Sweep BEFORE listing, so the grid never paints a card that is about to vanish under the
      // cursor. The exclusion set comes from the session store rather than from what is mounted:
      // a tool's file stays live across a navigation with its page gone, and no heartbeat covers
      // that window.
      const result = await sweepExpired({ exclude: liveFileIds() });
      if (cancelled) return;
      if (result.trashed.length) {
        toast.info(
          `${result.trashed.length} unkept file${result.trashed.length === 1 ? '' : 's'} moved to Trash.`,
          { description: 'Files are removed 7 days after their last change unless you keep them.' },
        );
      }
      await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Another tab deleting, keeping or editing a file has to show up here — this screen is the most
  // likely thing to be sitting open in a second tab while work happens in the first.
  React.useEffect(() => subscribe(() => void refresh()), [refresh]);

  const handleDelete = React.useCallback(
    async (file: FileRecord) => {
      const result = await deleteFile(file.id);
      if (!result.deleted) {
        toast.error('That file is open in another tab.', {
          description: 'Close it there first, or the work in progress would be deleted underneath it.',
        });
        return;
      }
      toast.success(`Deleted “${file.name.trim() || 'Untitled'}”.`);
      await refresh();
    },
    [refresh],
  );

  const handleKeep = React.useCallback(
    async (file: FileRecord, kept: boolean) => {
      await setKept(file.id, kept);
      await refresh();
    },
    [refresh],
  );

  /** Lifts a swept file back onto the grid, and gives it a fresh week rather than the hour it had left. */
  const handleRestore = React.useCallback(
    async (file: FileRecord) => {
      await patchFile(file.id, (current) =>
        current ? { ...current, deletedAt: null, updatedAt: Date.now() } : null,
      );
      toast.success(`Restored “${file.name.trim() || 'Untitled'}”.`);
      setView('files');
      await refresh();
    },
    [refresh],
  );

  const live = (files ?? []).filter((f) => f.deletedAt === null);
  const trashed = (files ?? []).filter((f) => f.deletedAt !== null);
  const shown = view === 'trash' ? trashed : live;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {view === 'trash' ? 'Trash' : 'Your files'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {view === 'trash'
              ? 'Swept files stay here for a week before they are deleted for good.'
              : 'Everything you have worked on, across all four tools. Pick a tool in the rail to start something new.'}
          </p>
        </div>
        {/* Only offered once there is something in it — a permanently visible empty Trash is a
            reminder of a rule nobody has hit yet. */}
        {(trashed.length > 0 || view === 'trash') && (
          <Button
            variant={view === 'trash' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setView(view === 'trash' ? 'files' : 'trash')}
          >
            <Trash2Icon data-icon="inline-start" />
            {view === 'trash' ? 'Back to files' : `Trash (${trashed.length})`}
          </Button>
        )}
      </div>

      {files === null ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-[4/3] w-full rounded-xl" />
          ))}
        </div>
      ) : shown.length ? (
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              thumbUrl={thumbUrls.get(file.id) ?? null}
              onDelete={handleDelete}
              onKeep={handleKeep}
              onRestore={view === 'trash' ? handleRestore : undefined}
            />
          ))}
        </div>
      ) : view === 'trash' ? (
        <Empty className="mt-8 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Trash2Icon />
            </EmptyMedia>
            <EmptyTitle>Trash is empty</EmptyTitle>
            <EmptyDescription>Nothing has been swept yet.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <NoFilesYet />
      )}
    </div>
  );
}

/**
 * The empty state, and the only place the four products are still listed.
 *
 * The launcher grid this screen replaced used to be the home page. Dropping it entirely would
 * leave a first-time user staring at an empty screen with no route into the app — the rail is
 * icons-only, and "start from the rail" is obvious exactly once you already know it.
 */
function NoFilesYet() {
  return (
    <Empty className="mt-8 border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileIcon />
        </EmptyMedia>
        <EmptyTitle>No files yet</EmptyTitle>
        <EmptyDescription>
          Open a tool and start working — it saves itself, and shows up here.
        </EmptyDescription>
      </EmptyHeader>
      <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {PRODUCTS.map((product) => (
          <Button
            key={product.slug}
            variant="outline"
            nativeButton={false}
            className="justify-start"
            render={<Link href={productHref(product)} />}
          >
            <product.icon data-icon="inline-start" />
            <span className="min-w-0 truncate">{product.name}</span>
            <ArrowRightIcon data-icon="inline-end" className="ml-auto opacity-60" />
          </Button>
        ))}
      </div>
    </Empty>
  );
}
