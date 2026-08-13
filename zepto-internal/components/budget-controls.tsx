'use client';

// The file-size budget group — Limit file size switch, Max KB ceiling, Shrink fallback —
// shared by Compose and Cleanup, which persist the SAME keys (skuc_bgBudget*). It drifted
// while duplicated (Switch vs Checkbox, a NaN-persisting input); one component ends that.

import * as React from 'react';

import { Hint } from '@/components/hint';
import {
  Field, FieldContent, FieldDescription, FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

export const BUDGET_KB_MIN = 50;
export const BUDGET_KB_STEP = 50;

export function BudgetControls({
  idPrefix,
  on,
  onOnChange,
  kb,
  onKbChange,
  kbSafe,
  shrink,
  onShrinkChange,
  disabled = false,
  available = true,
  limitHintSuffix,
}: {
  /** Namespaces the field ids so both products can mount without collisions. */
  idPrefix: string;
  on: boolean;
  onOnChange: (on: boolean) => void;
  kb: number;
  onKbChange: (kb: number) => void;
  /** The clamped value a blur snaps back to (NaN / below-minimum never persists). */
  kbSafe: number;
  shrink: boolean;
  onShrinkChange: (shrink: boolean) => void;
  disabled?: boolean;
  /** False when the browser lacks CompressionStream — the switch stays off and says why. */
  available?: boolean;
  /** Extra sentence for the Limit hint (e.g. "Shared setting with Cleanup."). */
  limitHintSuffix?: string;
}) {
  const active = on && available;
  return (
    <>
      <Field orientation="horizontal">
        {/* Field only nudges [role=checkbox]/[role=radio] into line with the label; a switch
            needs the offset spelled out. */}
        <Switch
          id={`${idPrefix}-budget-on`}
          className="mt-0.5"
          checked={on}
          disabled={disabled || !available}
          onCheckedChange={(checked) => onOnChange(checked === true)}
        />
        <FieldContent>
          <FieldLabel htmlFor={`${idPrefix}-budget-on`} className="font-normal">
            <Hint
              hint={`PNG is lossless, so the same tile can export anywhere from 60 KB to 300 KB. On, every file is held under a ceiling.${limitHintSuffix ? ` ${limitHintSuffix}` : ''}`}
            >
              Limit file size
            </Hint>
          </FieldLabel>
          {!available && (
            <FieldDescription>
              Needs CompressionStream, which this browser does not provide — exports stay
              uncapped.
            </FieldDescription>
          )}
        </FieldContent>
      </Field>

      {active && (
        <>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}-budget-kb`}>
              <Hint hint="Colours go first — full colour, then a 256 · 128 · 64 · 32 palette — and the export stops at the first step that fits.">
                Max KB per file
              </Hint>
            </FieldLabel>
            <Input
              id={`${idPrefix}-budget-kb`}
              type="number"
              inputMode="numeric"
              min={BUDGET_KB_MIN}
              step={BUDGET_KB_STEP}
              className="w-28"
              value={kb}
              disabled={disabled}
              onChange={(e) => {
                const next = Number(e.target.value);
                // A cleared or half-typed field must never be persisted as NaN.
                if (Number.isFinite(next) && next > 0) onKbChange(next);
              }}
              onBlur={() => onKbChange(kbSafe)}
            />
          </Field>
          <Field orientation="horizontal">
            <Switch
              id={`${idPrefix}-budget-shrink`}
              className="mt-0.5"
              checked={shrink}
              disabled={disabled}
              onCheckedChange={(checked) => onShrinkChange(checked === true)}
            />
            <FieldContent>
              <FieldLabel htmlFor={`${idPrefix}-budget-shrink`} className="font-normal">
                <Hint hint="Last resort, only when no palette fits. Off, an unfittable file is exported over budget instead — either way the export report names it.">
                  Shrink dimensions if needed
                </Hint>
              </FieldLabel>
            </FieldContent>
          </Field>
        </>
      )}
    </>
  );
}
