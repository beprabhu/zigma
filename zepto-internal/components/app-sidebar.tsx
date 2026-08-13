'use client';

import * as React from 'react';
// Figma-style rail: a fixed, non-collapsible strip of icon-over-label entries. No expand
// state, no tooltips, no provider — the label is always visible, so nothing needs revealing.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SettingsIcon } from 'lucide-react';

import { SettingsDialog } from '@/components/settings-dialog';
import { ZigmaMark } from '@/components/zigma-mark';

import { ThemeToggle } from '@/components/theme-toggle';
import { PRODUCTS, productForPathname, productHref } from '@/lib/products';
import { cn } from '@/lib/utils';

export function AppSidebar() {
  const pathname = usePathname();
  const current = productForPathname(pathname);
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  // The desktop shell hides the native title bar and floats only the traffic lights over the
  // window (desktop/main.js, titleBarStyle: 'hiddenInset'). They land inside this rail's
  // column, so the rail alone clears them — the rest of the app keeps running to the top edge.
  // Served in a browser there are no lights, so it keeps its normal size. The shell stamps
  // ZigmaShell into its UA for this; a bare 'Electron' check would also match Electron-based
  // browsers, which have an ordinary title bar and must not get the desktop treatment.
  // useSyncExternalStore, not state-in-effect: the UA never changes after load, and the
  // server snapshot (false) keeps hydration clean — browser markup matches server markup
  // until React takes over.
  const desktopShell = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    () => navigator.userAgent.includes('ZigmaShell'),
    () => false,
  );

  return (
    <aside
      aria-label="Products"
      className={cn(
        'sticky top-0 flex h-dvh shrink-0 flex-col items-center gap-3 border-r bg-sidebar pb-3',
        // Desktop: the lights run from the 16px inset in main.js out to x≈72, past the 68px
        // the rail is wide in the browser — that's why they sat across its edge. 88px = 72 + a
        // right margin equal to their 16px left inset, so they sit centred in the rail. In px,
        // not rem: the root font-size is 14.4px, so rem widths land ~10% short.
        desktopShell ? 'w-[88px] pt-10' : 'w-[4.75rem] pt-3',
      )}
    >
      {/* The strip the lights sit in is the window's drag handle — without it a frameless
          window can't be moved. Electron-only CSS; inert in a browser. */}
      {desktopShell && (
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-9"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
      )}
      {/* The mark stands on its own, Figma-rail style — no tile behind it. Sized up from the
          product icons (size-8 vs size-5) so it reads as the app's identity, not another tool;
          the extra top/bottom margin separates "logo" from "navigation". */}
      <Link
        href="/"
        title="Zigma — all products"
        className="mt-2 mb-4 flex size-11 items-center justify-center rounded-xl outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <ZigmaMark className="size-8" />
      </Link>

      {PRODUCTS.map((product) => {
        const active = current?.slug === product.slug;
        return (
          <Link
            key={product.slug}
            href={productHref(product)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex w-16 flex-col items-center gap-1 rounded-lg px-1 py-2 text-sidebar-foreground/70 outline-none transition-colors',
              'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring',
              active && 'bg-sidebar-accent text-sidebar-accent-foreground',
            )}
          >
            <product.icon className="size-5" />
            {/* Two centred lines max; 10px is the Figma-rail size and stays legible at w-16. */}
            <span className="line-clamp-2 text-center text-[10px] leading-tight">{product.name}</span>
          </Link>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-1">
        {/* Suite-wide settings (API keys, usage) — rail-level like Figma's account/settings
            cluster, because they belong to no single product. */}
        <button
          type="button"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
          className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <SettingsIcon className="size-5" />
          <span className="sr-only">Settings</span>
        </button>
        <ThemeToggle />
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </aside>
  );
}
