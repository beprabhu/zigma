"use client"

// shadcn's button-group, written by hand rather than pulled by the CLI: this project is on the
// Base UI style (`base-nova`), which the current CLI rejects outright, and the registry copy it
// would fetch is the Radix-flavoured one. Nothing here needs a primitive — a button group is
// layout — so the component is the registry's own composition adapted to this repo's idiom.
//
// button.tsx already carries `in-data-[slot=button-group]:rounded-lg` on its xs/sm/icon sizes,
// which is the half of this component that was already installed.

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Separator } from "@/components/ui/separator"

const buttonGroupVariants = cva(
  "flex w-fit items-stretch [&>*]:focus-visible:z-10 [&>input]:flex-1 has-[>[data-slot=button-group]]:gap-2",
  {
    variants: {
      orientation: {
        // Children fuse into one control: inner corners square off and the shared edge is drawn
        // once, so a group reads as a single object rather than three buttons that happen to touch.
        horizontal:
          "[&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none",
        vertical:
          "flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:first-child)]:border-t-0 [&>*:not(:last-child)]:rounded-b-none",
      },
    },
    defaultVariants: {
      orientation: "horizontal",
    },
  }
)

function ButtonGroup({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  )
}

/**
 * A non-interactive segment — a label, a unit, a truncated URL. Matches the buttons' height and
 * border so the group stays one object; `min-w-0` on purpose, so a long value truncates inside
 * the group instead of widening its container.
 */
function ButtonGroupText({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="button-group-text"
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg border border-input bg-muted/40 px-2.5 text-sm font-medium text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

/** The hairline between two segments — the border the fused edge above deliberately removed. */
function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn(
        "relative !m-0 self-stretch bg-input data-horizontal:h-px data-vertical:h-auto data-vertical:w-px",
        className
      )}
      {...props}
    />
  )
}

export { ButtonGroup, ButtonGroupText, ButtonGroupSeparator, buttonGroupVariants }
