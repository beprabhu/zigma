'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';
import { MoonIcon, SunIcon } from 'lucide-react';

// Rail-only control, styled to the rail's grammar (ghost size-9 tile, size-5 icon) rather
// than as a generic outline Button — it sits in the same column as the product links and the
// settings gear and must read as one family. The D hotkey (theme-provider.tsx) also toggles.
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // Render a stable icon until mounted so SSR markup matches the first client render.
  const mounted = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    () => true,
    () => false,
  );

  const isDark = mounted && resolvedTheme === 'dark';
  return (
    <button
      type="button"
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-sidebar-foreground/70 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    >
      {isDark ? <SunIcon className="size-5" /> : <MoonIcon className="size-5" />}
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}
