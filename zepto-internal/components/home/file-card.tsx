'use client';

// One file on the home grid.
//
// Two decisions here are load-bearing rather than cosmetic, and both go against the usual
// hover-to-reveal instinct:
//
// The DELETE control is visible at rest. It was asked for that way, and the reason holds anyway —
// a grid whose controls only exist on hover reads as a read-only gallery, and nobody hovers a wall
// of thumbnails looking for verbs.
//
// The KEEP control is visible at rest in BOTH states, distinguished by fill. It is the only thing
// standing between a file and the 7-day sweep, so a user who never discovers it loses work to a
// rule they were never shown. Hiding the unset state — the state that actually needs attention —
// would hide it from exactly the people it matters to.

import * as React from 'react';
import Link from 'next/link';
import { PinIcon, PinOffIcon, Trash2Icon } from 'lucide-react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { PRODUCTS } from '@/lib/products';
import { requestOpen } from '@/lib/files/open';
import { daysUntilExpiry } from '@/lib/files/sweep';
import { formatEdited, formatExact } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import type { FileRecord } from '@/lib/files/types';

/** Transparent cutouts are the common case, so the well behind one has to show its alpha. */
const CHECKERBOARD =
  '[background:repeating-conic-gradient(var(--muted)_0%_25%,transparent_0%_50%)_0_0/16px_16px]';

export function FileCard({
  file,
  thumbUrl,
  onDelete,
  onKeep,
  onRestore,
}: {
  file: FileRecord;
  /**
   * Owned by the grid, not by this card.
   *
   * A card that minted its own object URL and revoked it from an effect cleanup broke under React
   * StrictMode: the dev-only mount/unmount/remount cycle fires that cleanup once before the user
   * has done anything, so the URL was revoked immediately after mount and every thumbnail rendered
   * as a broken image. The grid mints and revokes in one place instead, where the lifetime is tied
   * to a data load rather than to a component's effect ordering.
   */
  thumbUrl: string | null;
  onDelete: (file: FileRecord) => void;
  onKeep: (file: FileRecord, kept: boolean) => void;
  /** Present only in Trash: lifts a soft-deleted file back onto the grid. */
  onRestore?: (file: FileRecord) => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const product = PRODUCTS.find((p) => p.slug === file.tool);
  const Icon = product?.icon;

  const days = daysUntilExpiry(file);
  const kept = file.keptAt !== null;
  const name = file.name.trim() || 'Untitled';

  return (
    <div className="group relative">
      <Link
        href={`/${file.tool}`}
        // The id is handed over in module scope rather than a query param — see lib/files/open.ts.
        // next/link fires this before it navigates, so the destination's first render sees it.
        onClick={() => requestOpen(file.tool, file.id)}
        className={cn(
          'flex flex-col overflow-hidden rounded-xl border bg-card outline-none transition-colors',
          'hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <div className={cn('relative aspect-[4/3] w-full border-b', CHECKERBOARD)}>
          {thumbUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={thumbUrl}
              alt=""
              className="absolute inset-0 size-full object-contain p-3"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40">
              {Icon && <Icon className="size-8" />}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 p-3">
          <span className="flex min-w-0 items-center gap-1.5">
            {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className="truncate text-sm font-medium">{name}</span>
          </span>
          <span className="truncate text-xs text-muted-foreground" title={formatExact(file.updatedAt)}>
            {product?.name ?? file.tool} · {file.itemCount.toLocaleString()} item
            {file.itemCount === 1 ? '' : 's'} · Edited {formatEdited(file.updatedAt)}
          </span>
          {/* The countdown is the whole reason the Keep control exists, so it is stated on the card
              rather than left for the user to infer from a pin they did not press. */}
          {file.deletedAt !== null ? (
            <span className="truncate text-xs text-destructive">
              In Trash · deleted for good in {days ?? 0} day{days === 1 ? '' : 's'}
            </span>
          ) : kept ? (
            <span className="truncate text-xs text-muted-foreground/80">Kept</span>
          ) : (
            <span
              className={cn(
                'truncate text-xs',
                days !== null && days <= 2 ? 'text-amber-600 dark:text-amber-500' : 'text-muted-foreground/80',
              )}
            >
              Deletes in {days ?? 7} day{days === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </Link>

      {/* Outside the Link, above it: a control nested inside an anchor would navigate on click. */}
      <div className="absolute top-2 right-2 flex gap-1">
        <Button
          variant={kept ? 'default' : 'secondary'}
          size="icon"
          className="size-7 shadow-sm"
          title={kept ? 'Kept — click to let this expire' : 'Keep this file (never auto-delete)'}
          onClick={() => onKeep(file, !kept)}
        >
          {kept ? <PinIcon className="size-3.5" /> : <PinOffIcon className="size-3.5" />}
          <span className="sr-only">{kept ? 'Stop keeping' : 'Keep'}</span>
        </Button>
        {onRestore && (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 shadow-sm"
            onClick={() => onRestore(file)}
          >
            Restore
          </Button>
        )}
        <Button
          variant="secondary"
          size="icon"
          className="size-7 shadow-sm hover:bg-destructive hover:text-white"
          title="Delete this file"
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon className="size-3.5" />
          <span className="sr-only">Delete</span>
        </Button>
      </div>

      {/* Confirmed, not instant. A card can hold hundreds of cutouts and generated images that
          cost real Azure calls, and this delete is the permanent one — Trash is where the SWEEP
          puts things, not where this sends them. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {file.itemCount.toLocaleString()} item{file.itemCount === 1 ? '' : 's'} in this{' '}
              {product?.name ?? file.tool} file will be removed for good, including results that
              have not been exported. Files you already downloaded are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                onDelete(file);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
