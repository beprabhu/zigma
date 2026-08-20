"use client"

// shadcn's sonner wrapper. Everything except the close button is the registry default: the
// theme hookup, the lucide icon set and the --normal-* variables are exactly what
// `shadcn add sonner` writes.
//
// The close button is ours because the registry default does not ship one — `closeButton` is a
// sonner prop, so switching it on gets sonner's OWN button: a 20px bordered circle hanging off
// the top-LEFT corner, which is the one piece of chrome in the app that looks nothing like the
// rest of it. The classNames below rebuild it as the same ghost icon button the Dialog's X is
// (components/ui/button.tsx, variant="ghost" size="icon-sm"), so a toast closes the way every
// other dismissible surface in the suite does.

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// Sonner styles its close button through `[data-sonner-toast][data-styled='true']
// [data-close-button]` — three attribute selectors, which outranks any single utility class. So
// every property that fights one of those rules carries Tailwind's `!` modifier. Position is
// the exception: sonner reads it from the variables below, so it needs no override at all.
const CLOSE_BUTTON = [
  "size-7! rounded-[min(var(--radius-md),12px)]!",
  "border-transparent! bg-transparent! text-muted-foreground!",
  "transition-all",
  "hover:bg-muted! hover:text-foreground! dark:hover:bg-muted/50!",
  "focus-visible:border-ring! focus-visible:ring-3! focus-visible:ring-ring/50!",
  // Sonner hardcodes width/height on its own <svg>; the Dialog's XIcon is size-4.
  "[&_svg]:size-4!",
].join(" ")

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // Move the button inside the toast at top-right, where the Dialog puts its X. Sonner
          // applies these to `left`/`right`/`transform` itself, so nothing here needs `!`.
          "--toast-close-button-start": "auto",
          "--toast-close-button-end": "0.5rem",
          "--toast-close-button-transform": "translateY(0.5rem)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // Keeps the text clear of the button now that it sits inside the toast rather than
          // outside the corner. Sonner's own 16px padding is what this has to beat.
          toast: "pr-10!",
          closeButton: CLOSE_BUTTON,
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
