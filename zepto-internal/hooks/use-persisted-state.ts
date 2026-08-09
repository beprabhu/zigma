'use client';

// The suite's ONE persisted-state hook (four products used to carry identical private copies).
// localStorage-backed with two sync channels the copies never had:
//   - a same-tab custom event, so every mounted component holding a key updates the moment any
//     other component writes it — the Settings modal writes skuc_azureEndpoint and product
//     pages already on screen must see it live, not on their next mount;
//   - the native storage event, so a second tab converges too.
// Reads happen after mount (not in the initializer) so server HTML matches the first client
// render and hydration stays clean.

import * as React from 'react';

const SYNC_EVENT = 'skuc-persisted';

export function readPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Legacy value from the pre-Next app, which stored strings raw (unquoted).
      return typeof fallback === 'string' ? (raw as unknown as T) : fallback;
    }
  } catch {
    return fallback; // private mode etc.
  }
}

/** Write + notify every subscriber in this tab. For non-React writers (lib/usage.ts). */
export function writePersisted<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { key } }));
}

export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = React.useState<T>(initial);
  // `initial` is often an inline literal whose identity changes per render; a ref keeps it out
  // of effect deps without re-running hydration.
  const initialRef = React.useRef(initial);

  React.useEffect(() => {
    setValue(readPersisted(key, initialRef.current));
    const onSync = (event: Event) => {
      if ((event as CustomEvent<{ key?: string }>).detail?.key !== key) return;
      setValue(readPersisted(key, initialRef.current));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) setValue(readPersisted(key, initialRef.current));
    };
    window.addEventListener(SYNC_EVENT, onSync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SYNC_EVENT, onSync);
      window.removeEventListener('storage', onStorage);
    };
  }, [key]);

  const set = React.useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* quota / private mode */
        }
        // Notify OTHER holders of this key. Deferred: dispatching synchronously inside a state
        // updater would set sibling components' state mid-render.
        queueMicrotask(() =>
          window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { key } })),
        );
        return next;
      });
    },
    [key],
  );

  return [value, set];
}
