'use client';

// Grid multi-select, shared by Generate, Banners and Cleanup: the hook owns the checked-id
// set (shift-ranges, prune on item removal, Escape to clear), SelectionBar is the floating
// pill of bulk actions, and ClearAllButton is the toolbar's confirm-guarded whole-run reset.
// Products supply only their own verbs — what "regenerate" and "delete" mean is per-product.

import * as React from 'react';
import { CheckCheckIcon, Trash2Icon, XIcon, type LucideIcon } from 'lucide-react';

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function useGridSelection(
  /** Item ids in DISPLAY order — shift-ranges follow what the user sees, not insertion order. */
  order: readonly number[],
  /** Escape-to-clear is suppressed while true (an open dialog owns the key). */
  suspendEscape = false,
) {
  const [raw, setRaw] = React.useState<ReadonlySet<number>>(new Set());
  const anchorRef = React.useRef<number | null>(null);

  // Deleted items must not linger — derive the live set against the current order instead of
  // pruning in an effect (a set-state-in-effect cascade the lint rules rightly reject).
  const checked = React.useMemo(() => {
    if (raw.size === 0) return raw;
    const alive = new Set(order);
    const next = new Set([...raw].filter((id) => alive.has(id)));
    return next.size === raw.size ? raw : next;
  }, [raw, order]);

  const toggle = React.useCallback(
    (id: number, shiftKey: boolean) => {
      const anchor = anchorRef.current;
      anchorRef.current = id;
      setRaw((prev) => {
        const next = new Set([...prev].filter((i) => order.includes(i)));
        if (shiftKey && anchor !== null && anchor !== id) {
          // Range applies the anchor's current state, so shift extends selections AND
          // deselections symmetrically.
          const a = order.indexOf(anchor);
          const b = order.indexOf(id);
          if (a !== -1 && b !== -1) {
            const on = next.has(anchor);
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
              if (on) next.add(order[i]);
              else next.delete(order[i]);
            }
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [order],
  );

  const clear = React.useCallback(() => {
    setRaw(new Set());
    anchorRef.current = null;
  }, []);

  const selectAll = React.useCallback(() => {
    setRaw(new Set(order));
  }, [order]);

  const active = checked.size > 0;
  React.useEffect(() => {
    if (!active || suspendEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, suspendEscape, clear]);

  return {
    checked,
    active,
    allSelected: order.length > 0 && checked.size === order.length,
    toggle,
    clear,
    selectAll,
  };
}

/** One bulk verb on the bar. `accent` renders it Figma-blue — reserve it for the AI action. */
export interface SelectionAction {
  key: string;
  /** Tooltip text — buttons are icon-only, Figma-toolbar style. */
  label: string;
  icon: LucideIcon;
  onRun: () => void;
  accent?: boolean;
  disabled?: boolean;
}

// The bar is a fixed dark surface in BOTH themes, like Figma's toolbar — it floats over
// artwork, so it keeps its own palette instead of following the app theme.
const BAR_BUTTON =
  'grid size-9 shrink-0 place-items-center rounded-lg text-zinc-200 transition-colors ' +
  'hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-blue-400 disabled:pointer-events-none disabled:opacity-40 ' +
  '[&_svg]:size-4.5';

function BarTip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="top" className="max-w-56">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The floating bulk-action toolbar. Sticky, so it rides the bottom of the canvas scroll while
 * anything is selected. Icon-only buttons with tooltips; Delete always confirms, `actions`
 * (regenerate / AI edit / redo) run immediately.
 */
export function SelectionBar({
  count,
  total,
  allSelected,
  busy,
  actions = [],
  deleteTitle,
  deleteDescription,
  onDelete,
  onSelectAll,
  onClear,
}: {
  count: number;
  total: number;
  allSelected: boolean;
  busy: boolean;
  /** The product's non-destructive bulk verbs, left of Delete. */
  actions?: SelectionAction[];
  deleteTitle: string;
  deleteDescription: React.ReactNode;
  onDelete: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  return (
    <TooltipProvider delay={300}>
      <div className="pointer-events-none sticky bottom-4 z-10 mt-4 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-2xl bg-zinc-900 py-1.5 pr-1.5 pl-4 text-zinc-100 shadow-[0_6px_24px_rgba(0,0,0,0.45)] ring-1 ring-white/10">
          <span className="pr-2 text-xs font-medium whitespace-nowrap tabular-nums">
            {count} selected
          </span>
          {/* End-to-end separators, like Figma's toolbar: stretch to the row and push through
              the bar's vertical padding. */}
          <div className="mx-1.5 -my-1.5 w-px self-stretch bg-white/15" />
          <BarTip label={allSelected ? 'Deselect all' : `Select all ${total}`}>
            <button
              type="button"
              aria-label={allSelected ? 'Deselect all' : `Select all ${total}`}
              onClick={allSelected ? onClear : onSelectAll}
              className={cn(BAR_BUTTON, allSelected && 'bg-blue-500/25 text-blue-300 hover:bg-blue-500/35 hover:text-blue-200')}
            >
              <CheckCheckIcon />
            </button>
          </BarTip>
          {actions.map(({ key, label, icon: Icon, onRun, accent, disabled }) => {
            // aria-disabled, not the disabled attribute: a truly disabled button swallows
            // pointer events, so its tooltip — often the explanation of WHY it is off
            // (e.g. "needs the Azure key") — could never show.
            const off = busy || disabled;
            return (
              <BarTip key={key} label={label}>
                <button
                  type="button"
                  aria-label={label}
                  aria-disabled={off || undefined}
                  onClick={off ? undefined : onRun}
                  className={cn(
                    BAR_BUTTON,
                    accent && 'bg-blue-500 text-white hover:bg-blue-400 hover:text-white',
                    off && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-zinc-200',
                    off && accent && 'hover:bg-blue-500 hover:text-white',
                  )}
                >
                  <Icon />
                </button>
              </BarTip>
            );
          })}
          <AlertDialog>
            <BarTip label="Delete selected">
              <AlertDialogTrigger
                render={
                  <button
                    type="button"
                    aria-label="Delete selected"
                    disabled={busy}
                    className={cn(BAR_BUTTON, 'text-red-400 hover:bg-red-500/15 hover:text-red-300')}
                  >
                    <Trash2Icon />
                  </button>
                }
              />
            </BarTip>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{deleteTitle}</AlertDialogTitle>
                <AlertDialogDescription>{deleteDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <div className="mx-1.5 -my-1.5 w-px self-stretch bg-white/15" />
          <BarTip label="Clear selection (Esc)">
            <button type="button" aria-label="Clear selection" onClick={onClear} className={BAR_BUTTON}>
              <XIcon />
            </button>
          </BarTip>
        </div>
      </div>
    </TooltipProvider>
  );
}

/** The grid toolbar's whole-run reset, confirm-guarded. Quiet until hovered. */
export function ClearAllButton({
  title,
  description,
  disabled,
  onConfirm,
}: {
  title: string;
  description: React.ReactNode;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button variant="ghost" size="sm" disabled={disabled} className="text-muted-foreground hover:text-destructive">
            <Trash2Icon data-icon="inline-start" />
            Clear all
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            Clear all
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
