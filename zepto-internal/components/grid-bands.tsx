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
import { Input } from '@/components/ui/input';
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

const NONE = '__none__';

/** Tiles-per-row a band can be set to. Beyond eight a tile is too small to judge on screen. */
export const MAX_BAND_COLUMNS = 8;

/** Clamps a typed number into range, keeping an empty/garbage field from writing NaN into state. */
function clamp(value: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-medium">Row {index + 1}</span>
        <span className="text-xs text-muted-foreground">
          {band.fileName ? `${tiles} tile${tiles === 1 ? '' : 's'}` : 'no CSV yet'}
        </span>
        {/* The last band has nothing to fall back to, so it loses the control rather than
            offering one that empties the grid. */}
        {total > 1 && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
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
                  Drops this row&rsquo;s {tiles} tile{tiles === 1 ? '' : 's'} and its CSV mapping.
                  The other rows keep theirs, and your CSV file on disk is untouched.
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

      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor={`band-ratio-${band.id}`}>Tile preset</FieldLabel>
          <Select
            value={preset.id}
            disabled={disabled}
            onValueChange={(v) => onChange({ presetId: String(v ?? '') })}
          >
            <SelectTrigger id={`band-ratio-${band.id}`} className="w-full">
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
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor={`band-count-${band.id}`}>Tiles</FieldLabel>
            <Input
              id={`band-count-${band.id}`}
              type="number"
              min={0}
              max={Math.max(rows, 0)}
              value={band.count}
              // No CSV means no ceiling to clamp against, so the field waits for one.
              disabled={disabled || !rows}
              onChange={(e) => onChange({ count: clamp(e.target.value, 0, rows, band.count) })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`band-cols-${band.id}`}>Columns</FieldLabel>
            <Input
              id={`band-cols-${band.id}`}
              type="number"
              min={1}
              max={MAX_BAND_COLUMNS}
              value={band.columns}
              disabled={disabled}
              onChange={(e) =>
                onChange({ columns: clamp(e.target.value, 1, MAX_BAND_COLUMNS, band.columns) })
              }
            />
          </Field>
        </div>
        <FieldDescription>
          {rows
            ? `${rows.toLocaleString()} row${rows === 1 ? '' : 's'} available — drawing ${band.count} in rows of ${band.columns}.`
            : 'Drop this row’s CSV in its area on the canvas; the tile count is capped at that sheet’s rows.'}
        </FieldDescription>

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
