'use client';

import * as React from 'react';

import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';

interface ProductHeaderProps {
  title: string;
  /** Short right-aligned hint about the product; hidden on narrow viewports. */
  description?: string;
  /** Per-product actions, rendered after the hint. */
  children?: React.ReactNode;
}

// h-12 + border-b is load-bearing: product pages subtract this exact height
// from 100dvh to size their full-height panes. Changing it means changing
// the --pane-h arithmetic in app/compositor/page.tsx.
export function ProductHeader({ title, description, children }: ProductHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="h-4" />
      <h1 className="truncate text-sm font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-3">
        {description && (
          <span className="hidden text-xs text-muted-foreground sm:inline">{description}</span>
        )}
        {children}
      </div>
    </header>
  );
}
