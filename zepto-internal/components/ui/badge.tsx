import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import type { TagColor } from "@/lib/skills"

/**
 * Skill-tag recipes, one per colour name in lib/skills.ts — same rule as chip-warn below:
 * the classes live HERE once, and call sites pick a colour name, never a class. `TAG_TONES`
 * is the pill itself (tinted background, text readable in both themes); `TAG_DOTS` is the
 * solid swatch the colour picker paints. Written out in full so Tailwind's scanner sees them.
 */
export const TAG_TONES: Record<TagColor, string> = {
  slate: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  purple: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  pink: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
}

export const TAG_DOTS: Record<TagColor, string> = {
  slate: "bg-slate-500",
  blue: "bg-blue-500",
  teal: "bg-teal-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  purple: "bg-violet-500",
  pink: "bg-pink-500",
}

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        // The suite's status chip (session-header chips, md-file-tile badges, settings
        // "Built-in"): Micro rank, muted, tighter padding than a regular badge.
        chip: "bg-muted px-1.5 text-[11px] font-medium text-muted-foreground",
        // Warn tone of the chip. Amber recipe lives here ONCE — call sites must not
        // re-hardcode it. (Future token work: a --warning pair in globals.css.)
        "chip-warn":
          "bg-amber-500/15 px-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
