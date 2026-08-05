'use client';

// The suite-wide space-saver: explanatory subtext lives in a tooltip hanging off the text
// it explains (dotted underline + help cursor), instead of a visible description line.
// Used by card titles (HintCardHeader) and field labels alike.

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';

interface HintProps {
  /** Tooltip body — the text that used to render inline as a description. */
  hint: React.ReactNode;
  /** Visible text the tooltip hangs off. */
  children: React.ReactNode;
  className?: string;
}

export function Hint({ hint, children, className }: HintProps) {
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger render={<span className={cn('w-fit', className)} />}>
          {children}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-64">
          {hint}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
