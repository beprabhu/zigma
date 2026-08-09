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

  return (
    <aside
      aria-label="Products"
      className="sticky top-0 flex h-dvh w-[4.75rem] shrink-0 flex-col items-center gap-3 border-r bg-sidebar py-3"
    >
      {/* The mark stands on its own, Figma-rail style — no tile behind it. */}
      <Link
        href="/"
        title="Zigma — all products"
        className="mb-2 flex size-9 items-center justify-center rounded-lg outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <ZigmaMark className="size-6" />
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
