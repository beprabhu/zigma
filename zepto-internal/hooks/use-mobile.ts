import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

// A media query is external state, so it is read through useSyncExternalStore rather than
// mirrored into useState from an effect — the latter re-renders every consumer twice on mount.
// shadcn generates the useState version, so re-adding the sidebar component overwrites this.
export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    // The server has no viewport; desktop is the safer first paint and the client corrects it.
    () => false
  )
}
