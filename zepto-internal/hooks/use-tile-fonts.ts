'use client';

import * as React from 'react';
import { tileFontsReady } from '@/lib/tile';

// True once the Zepto Norms canvas font is loaded. Including this in a render
// effect's deps re-renders tiles that were first drawn with the fallback face.
export function useTileFontsReady(): boolean {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    tileFontsReady().then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  return ready;
}
