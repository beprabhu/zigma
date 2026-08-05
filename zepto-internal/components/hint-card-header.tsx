'use client';

// Space-saving card header: the descriptive subtext that used to render as a
// CardDescription line lives in a tooltip shown when hovering the title.

import * as React from 'react';

import { CardHeader, CardTitle } from '@/components/ui/card';
import { Hint } from '@/components/hint';

interface HintCardHeaderProps {
  title: React.ReactNode;
  /** Shown on hover over the title; the old CardDescription text. */
  hint: React.ReactNode;
  className?: string;
  /** Extra header content (actions), rendered after the title. */
  children?: React.ReactNode;
}

export function HintCardHeader({ title, hint, className, children }: HintCardHeaderProps) {
  return (
    <CardHeader className={className}>
      <CardTitle className="text-sm">
        <Hint hint={hint}>{title}</Hint>
      </CardTitle>
      {children}
    </CardHeader>
  );
}
