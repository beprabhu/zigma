import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * Whether the viewport is phone-width.
 *
 * Read through useSyncExternalStore rather than mirrored into state from an effect. matchMedia is
 * an external store, and the effect version had to write state on mount to get its first real
 * answer — a synchronous setState in an effect, which renders once with the wrong value and again
 * with the right one, and which the layout rules here reject outright. This subscribes instead, so
 * the first render already has the answer and a breakpoint crossing needs no extra pass.
 *
 * The server snapshot is `false`: there is no viewport to measure during prerender, and desktop is
 * the layout that degrades gracefully if the first client render corrects it.
 */
export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
}

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches
}
