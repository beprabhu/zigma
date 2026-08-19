'use client';

// Banner grid — the "row item" a band becomes in Compose's left panel.
//
// A banner grid is a wrapper around banner tiles, so a band owns no template of its own: it
// picks one banner-tile preset, one CSV, how many of that sheet's rows to draw and in how many
// columns. Everything that answers "what is this row of the grid" lives in this one card, so
// changing a band's ratio can only ever move that band's tiles — its drop area in the canvas is
// the other half of the same pair.

import * as React from 'react';
import { Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ColumnPicker } from '@/components/column-picker';
import { CsvFileTile } from '@/components/csv-dropzone';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { BAND_PRESETS, bandPreset } from '@/lib/tile-presets';
import type { GridBand } from '@/lib/types';
import { cn } from '@/lib/utils';

const NONE = '__none__';

/** Tiles-per-row a band can be set to. Beyond eight a tile is too small to judge on screen. */
export const MAX_BAND_COLUMNS = 8;

/** Clamps a typed number into range, keeping an empty/garbage field from writing NaN into state. */
function clamp(value: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * A row's size, edited where its effect is.
 *
 * Tiles and columns are the only two band settings whose result is entirely visible in the
 * canvas — everything else in the panel answers "which sheet, which columns". Sitting in the
 * left panel they made you look three panes away from the grid you were resizing, and the
 * panel's boxed Field pairs gave two one-digit numbers the same weight as the CSV mapping.
 * On the row header they are adjacent to their effect, and small enough to read as a caption
 * with an editable number in it rather than a form.
 *
 * The tile field appears only once a sheet is loaded: with no CSV there is no ceiling to clamp
 * against, so rather than park a dead disabled box in the header the row shows just its column
 * count — which still shapes the empty row's skeleton in the dropzone below.
 */
export function RowSizeControls({
  band,
  disabled,
  onChange,
  className,
}: {
  band: GridBand;
  disabled: boolean;
  onChange: (patch: Partial<GridBand>) => void;
  className?: string;
}) {
  const rows = band.records.length;

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {rows > 0 && (
        <RowNumberField
          id={`row-count-${band.id}`}
          label={`Tiles in row from ${band.fileName ?? 'this sheet'}`}
          unit={band.count === 1 ? 'tile' : 'tiles'}
          value={band.count}
          min={0}
          max={rows}
          disabled={disabled}
          onCommit={(count) => onChange({ count })}
        />
      )}
      <RowNumberField
        id={`row-cols-${band.id}`}
        label="Columns in this row"
        unit={band.columns === 1 ? 'col' : 'cols'}
        value={band.columns}
        min={1}
        max={MAX_BAND_COLUMNS}
        disabled={disabled}
        onCommit={(columns) => onChange({ columns })}
      />
    </div>
  );
}

/**
 * One header number: the value, then its unit as the label. Header-height (h-7) and only as
 * wide as two digits plus the word, so a row of them stays a caption. Native spinners are
 * suppressed — they only appear on hover, at a size that would dominate the field — while the
 * arrow keys they stand for keep working.
 */
function RowNumberField({
  id, label, unit, value, min, max, disabled, onCommit,
}: {
  id: string;
  /** Accessible name; the visible unit alone would read as "tiles" for both fields. */
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (next: number) => void;
}) {
  return (
    <InputGroup className="h-7 w-auto rounded-md">
      <InputGroupInput
        id={id}
        type="number"
        inputMode="numeric"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onCommit(clamp(e.target.value, min, max, value))}
        className="h-7 w-11 flex-none px-2 py-0 text-sm tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <InputGroupAddon align="inline-end" className="pr-2 pl-0 text-xs font-normal">
        {unit}
      </InputGroupAddon>
    </InputGroup>
  );
}

export function BandCard({
  band,
  index,
  total,
  tiles,
  disabled,
  onChange,
  onReplaceCsv,
  onRemove,
}: {
  band: GridBand;
  /** 0-based position, for the "Row 1" heading. */
  index: number;
  total: number;
  /** How many tiles this band currently has in the queue, for the heading's chip. */
  tiles: number;
  disabled: boolean;
  onChange: (patch: Partial<GridBand>) => void;
  onReplaceCsv: (file: File) => void;
  onRemove: () => void;
}) {
  const preset = bandPreset(band.presetId);
  const rows = band.records.length;

  return (
    <div className="rounded-lg border bg-card/40 p-3">
      <FieldGroup className="gap-3">
        {/* "Row 1" IS the preset field's label. Once tiles and columns moved to the canvas
            header this card held one control, and a semibold heading, a "Tile preset" label
            and a select made three stacked lines out of a single question: what shape is this
            row? The row number labels the select, and the delete sits on the control's line
            rather than owning a header of its own.

            Dropped with the heading: the "no CSV yet" / "N tiles" chip. It restated the card
            below it — no CSV means no file tile and no row count here, and the canvas row
            header prints the filename and tile count in full either way. */}
        <Field>
          <FieldLabel htmlFor={`band-ratio-${band.id}`}>Row {index + 1}</FieldLabel>
          <div className="flex items-center gap-1.5">
            <Select
              value={preset.id}
              disabled={disabled}
              onValueChange={(v) => onChange({ presetId: String(v ?? '') })}
            >
              <SelectTrigger id={`band-ratio-${band.id}`} className="w-full flex-1">
                <SelectValue>
                  {(v) => BAND_PRESETS.find((p) => p.id === v)?.ratio ?? 'Ratio'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false} sideOffset={4}>
                {BAND_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.ratio}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* The last band has nothing to fall back to, so it loses the control rather than
                offering one that empties the grid. */}
            {total > 1 && (
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      disabled={disabled}
                      aria-label={`Remove row ${index + 1}`}
                    />
                  }
                >
                  <Trash2Icon className="text-muted-foreground" />
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove row {index + 1}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Drops this row&rsquo;s {tiles} tile{tiles === 1 ? '' : 's'} and its CSV
                      mapping. The other rows keep theirs, and your CSV file on disk is untouched.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={onRemove}
                      className="bg-destructive text-white hover:bg-destructive/90"
                    >
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </Field>

        {/* Tiles and columns used to sit here as two boxed number fields, three panes away
            from the grid they resize. They now ride the canvas row header instead — see
            RowSizeControls — so the panel is only ever about shape and source. */}
        {rows ? (
          <FieldDescription>
            {`${rows.toLocaleString()} row${rows === 1 ? '' : 's'} available.`}
          </FieldDescription>
        ) : null}

        {band.fileName && (
          <>
            <CsvFileTile
              name={band.fileName}
              description={band.headers.join(', ')}
              badge={`${rows.toLocaleString()} row${rows === 1 ? '' : 's'}`}
              onReplace={onReplaceCsv}
              onRemove={() => onChange({ fileName: null })}
              disabled={disabled}
              removeConfirm={{
                title: `Remove row ${index + 1}’s CSV?`,
                description: (
                  <>
                    Clears this row&rsquo;s {tiles} tile{tiles === 1 ? '' : 's'}, including any
                    generated but not yet exported. The row itself stays — drop another CSV in
                    its area to fill it again.
                  </>
                ),
              }}
            />

            <Field>
              <FieldLabel htmlFor={`band-img-${band.id}`}>Image URL columns</FieldLabel>
              <ColumnPicker
                id={`band-img-${band.id}`}
                columns={band.headers}
                selected={band.imageCols}
                onChange={(next) => onChange({ imageCols: next })}
                disabled={disabled}
                placeholder="None — no tile can generate"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor={`band-title-${band.id}`}>Title</FieldLabel>
                <Select
                  value={band.titleCol || NONE}
                  disabled={disabled}
                  onValueChange={(v) => onChange({ titleCol: v === NONE ? '' : String(v ?? '') })}
                >
                  <SelectTrigger id={`band-title-${band.id}`} className="w-full">
                    <SelectValue>{(v) => (v && v !== NONE ? String(v) : '(none)')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>(none)</SelectItem>
                    {band.headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              {/* Only where the chosen preset actually draws an offer bar — the same rule the
                  single-template panel uses, asked of this band's preset. */}
              {preset.template.offer.visible && (
                <Field>
                  <FieldLabel htmlFor={`band-offer-${band.id}`}>Offer</FieldLabel>
                  <Select
                    value={band.offerCol || NONE}
                    disabled={disabled}
                    onValueChange={(v) => onChange({ offerCol: v === NONE ? '' : String(v ?? '') })}
                  >
                    <SelectTrigger id={`band-offer-${band.id}`} className="w-full">
                      <SelectValue>{(v) => (v && v !== NONE ? String(v) : '(none)')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>(none)</SelectItem>
                      {band.headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
          </>
        )}
      </FieldGroup>
    </div>
  );
}
