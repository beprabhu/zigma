'use client';

// Lets a tool page start a fresh file without a page reload.
//
// "New file" has to reset everything the page holds — the queue, the sheet, the column mapping, the
// name. Enumerating those setters per tool would be a list to forget something from, and it would
// have to be maintained alongside every future piece of page state. Remounting is the version that
// cannot drift: React drops all of it, and `resolveOpen` on the way back in sees the pending
// request and mints a new id.
//
// It also solves a smaller problem that has no other clean answer: pressing "+" for the tool you
// are ALREADY in navigates to the route you are on, which the App Router correctly treats as
// nothing at all. The remount is what makes that press do something.

import * as React from 'react';

import { onNewRequested } from '@/lib/files/open';
import type { ToolSlug } from '@/lib/files/types';

/**
 * A counter to hang on a `key`. Every "new file" request for this tool bumps it.
 *
 * Use it on an INNER component holding the page's state, not on the page itself:
 *
 *   export default function Page() {
 *     const gen = useNewFileGeneration('png-compressor');
 *     return <PageBody key={gen} />;
 *   }
 */
export function useNewFileGeneration(tool: ToolSlug): number {
  const [generation, setGeneration] = React.useState(0);
  React.useEffect(
    () =>
      onNewRequested((requested) => {
        if (requested === tool) setGeneration((n) => n + 1);
      }),
    [tool],
  );
  return generation;
}
