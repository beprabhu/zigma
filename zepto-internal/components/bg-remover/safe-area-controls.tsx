'use client';

// Settings panel for SafeAreaConfig. Fully controlled and stateless with respect to the config:
// the only local state is UI affordance (custom-size revealed, margins linked, remembered
// custom colour, in-progress number text) that has nowhere to live in SafeAreaConfig.

import * as React from 'react';
import { LinkIcon, RotateCcwIcon, UnlinkIcon } from 'lucide-react';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ColorPicker } from '@/components/color-picker';
import { cn } from '@/lib/utils';
import {
  ANCHORS,
  ANCHOR_LABELS,
  TILE_PRESETS,
  TRANSPARENT,
  type MarginUnit,
  type SafeAreaAnchor,
  type SafeAreaConfig,
  type SafeAreaMargins,
} from '@/lib/bg/safe-area';

export interface SafeAreaControlsProps {
  config: SafeAreaConfig;
  onChange: (next: SafeAreaConfig) => void;
  onReset: () => void;
  disabled?: boolean;
}

// Sentinel select value. No TilePreset uses this id, so it can never shadow a real preset.
const CUSTOM_TILE = 'custom';

// Base UI's <SelectValue> prints the raw value unless Select.Root is handed the label map, so
// the trigger would otherwise read "sku-tile" instead of "SKU tile · 600 × 768".
const TILE_ITEMS: readonly { label: string; value: string }[] = [
  ...TILE_PRESETS.map((preset) => ({ label: preset.label, value: preset.id })),
  { label: 'Custom…', value: CUSTOM_TILE },
];

const MARGIN_SIDES: readonly (keyof SafeAreaMargins)[] = ['top', 'right', 'bottom', 'left'];
const SIDE_LABELS: Record<keyof SafeAreaMargins, string> = {
  top: 'Top',
  right: 'Right',
  bottom: 'Bottom',
  left: 'Left',
};

type BackgroundMode = 'transparent' | 'white' | 'custom';

const WHITE = '#ffffff';
const FALLBACK_CUSTOM_BG = '#f4f4f5';
const HEX6 = /^#[0-9a-f]{6}$/i;

function isAnchor(value: string): value is SafeAreaAnchor {
  return (ANCHORS as readonly string[]).includes(value);
}

function backgroundMode(background: string): BackgroundMode {
  if (background === TRANSPARENT) return 'transparent';
  const v = background.trim().toLowerCase();
  if (v === 'white' || v === '#fff' || v === WHITE) return 'white';
  return 'custom';
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  onValueChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

// Holds the raw text while the user is mid-edit so an empty or half-typed field ("-", "1.")
// never leaves the component as NaN. The committed value only moves on a parse that succeeds.
function NumberField({
  id,
  label,
  value,
  onValueChange,
  min,
  max,
  step,
  disabled,
}: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<string | null>(null);

  // The draft is displayed only while it is still consistent with the committed value (or is
  // an unparseable work-in-progress). That makes it self-invalidating: a config change from
  // outside — Reset, a linked-margin write, a clamp — takes over the field with no effect and
  // no state sync, while "1." and "-" survive long enough to finish typing.
  const parsed = draft === null ? NaN : Number(draft);
  const text =
    draft !== null && (draft.trim() === '' || !Number.isFinite(parsed) || parsed === value)
      ? draft
      : String(value);

  return (
    <Field className="gap-1">
      <FieldLabel htmlFor={id} className="text-[11px] font-normal text-muted-foreground">
        {label}
      </FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        className="h-8 text-xs"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          if (raw.trim() === '') return;
          const next = Number(raw);
          // An empty or half-typed field keeps the previous value rather than emitting NaN.
          if (!Number.isFinite(next)) return;
          onValueChange(clamp(next, min ?? -Infinity, max ?? Infinity));
        }}
        onBlur={() => setDraft(null)}
      />
    </Field>
  );
}

export function SafeAreaControls({
  config,
  onChange,
  onReset,
  disabled = false,
}: SafeAreaControlsProps): React.JSX.Element {
  const [customTile, setCustomTile] = React.useState(false);
  const [linkMargins, setLinkMargins] = React.useState(false);
  const [customBg, setCustomBg] = React.useState(() =>
    backgroundMode(config.background) === 'custom' && HEX6.test(config.background)
      ? config.background
      : FALLBACK_CUSTOM_BG,
  );

  function patch(next: Partial<SafeAreaConfig>) {
    onChange({ ...config, ...next });
  }

  // "Custom" is not stored in the config — it is simply "no preset has these dimensions",
  // plus a sticky flag for the case where the user picks Custom while a preset still matches.
  const matchedPreset = TILE_PRESETS.find(
    (preset) => preset.width === config.tile.width && preset.height === config.tile.height,
  );
  const showCustomTile = customTile || !matchedPreset;
  const tileValue = matchedPreset && !customTile ? matchedPreset.id : CUSTOM_TILE;

  function handleTilePreset(id: string) {
    if (id === CUSTOM_TILE) {
      setCustomTile(true);
      return;
    }
    const preset = TILE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setCustomTile(false);
    patch({ tile: { width: preset.width, height: preset.height } });
  }

  function handleMargin(side: keyof SafeAreaMargins, value: number) {
    if (linkMargins) {
      patch({ margins: { top: value, right: value, bottom: value, left: value } });
      return;
    }
    const margins: SafeAreaMargins = { ...config.margins };
    margins[side] = value;
    patch({ margins });
  }

  function handleLink(on: boolean) {
    setLinkMargins(on);
    if (!on) return;
    const v = config.margins.top;
    patch({ margins: { top: v, right: v, bottom: v, left: v } });
  }

  // Switching units converts the numbers so the safe area stays exactly where it is —
  // the label changes, the tile does not.
  function handleUnit(unit: MarginUnit) {
    if (unit === config.marginUnit) return;
    const w = Math.max(1, config.tile.width);
    const h = Math.max(1, config.tile.height);
    const convert = (v: number, basis: number) => {
      if (!Number.isFinite(v)) return 0;
      return unit === 'px'
        ? Math.round((v / 100) * basis)
        : Math.round((v / basis) * 1000) / 10;
    };
    patch({
      marginUnit: unit,
      margins: {
        top: convert(config.margins.top, h),
        right: convert(config.margins.right, w),
        bottom: convert(config.margins.bottom, h),
        left: convert(config.margins.left, w),
      },
    });
  }

  // Reset clears the panel's own affordances too, so the UI does not keep claiming a custom
  // tile size or linked margins that the restored config no longer has.
  function handleReset() {
    setCustomTile(false);
    setLinkMargins(false);
    onReset();
  }

  function handleBackgroundMode(mode: BackgroundMode) {
    if (mode === 'transparent') patch({ background: TRANSPARENT });
    else if (mode === 'white') patch({ background: WHITE });
    else patch({ background: customBg });
  }

  const bgMode = backgroundMode(config.background);
  const colorValue = bgMode === 'custom' && HEX6.test(config.background) ? config.background : customBg;
  const fillPct = Math.round(clamp(Number.isFinite(config.fill) ? config.fill : 1, 0, 1) * 100);
  const unitSuffix = config.marginUnit === 'percent' ? '%' : 'px';

  return (
    <FieldGroup className="gap-4">
      <div className="flex items-center justify-between gap-2">
        <FieldTitle className="text-sm">Safe area</FieldTitle>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={handleReset}
          className="text-muted-foreground"
        >
          <RotateCcwIcon />
          Reset
        </Button>
      </div>

      <Separator />

      {/* Tile size ------------------------------------------------------------------ */}
      <Field className="gap-1.5">
        <FieldLabel htmlFor="safe-area-tile" className="text-xs">
          Tile size
        </FieldLabel>
        <Select
          items={TILE_ITEMS}
          value={tileValue}
          disabled={disabled}
          onValueChange={(v) => {
            if (v == null) return;
            handleTilePreset(String(v));
          }}
        >
          <SelectTrigger id="safe-area-tile" size="sm" className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TILE_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_TILE}>Custom…</SelectItem>
          </SelectContent>
        </Select>
        {showCustomTile && (
          <div className="grid grid-cols-2 gap-2 pt-1">
            <NumberField
              id="safe-area-tile-w"
              label="Width (px)"
              value={config.tile.width}
              min={1}
              max={8192}
              disabled={disabled}
              onValueChange={(width) => patch({ tile: { ...config.tile, width } })}
            />
            <NumberField
              id="safe-area-tile-h"
              label="Height (px)"
              value={config.tile.height}
              min={1}
              max={8192}
              disabled={disabled}
              onValueChange={(height) => patch({ tile: { ...config.tile, height } })}
            />
          </div>
        )}
      </Field>

      <Separator />

      {/* Margins -------------------------------------------------------------------- */}
      <Field className="gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <FieldTitle className="text-xs">
            <Hint hint="Negative values bleed the safe area past the tile edge.">Margins</Hint>
          </FieldTitle>
          <div className="flex items-center gap-1.5">
            <Toggle
              size="sm"
              variant="outline"
              pressed={linkMargins}
              disabled={disabled}
              onPressedChange={handleLink}
              aria-label="Link all four margins"
              title="Link all four margins"
              className="px-2"
            >
              {linkMargins ? <LinkIcon /> : <UnlinkIcon />}
            </Toggle>
            <ToggleGroup
              size="sm"
              variant="outline"
              spacing={0}
              disabled={disabled}
              value={[config.marginUnit]}
              onValueChange={(next) => {
                const unit = next[0];
                if (unit === 'px' || unit === 'percent') handleUnit(unit);
              }}
            >
              <ToggleGroupItem value="percent" aria-label="Margins as a percentage of the tile">
                %
              </ToggleGroupItem>
              <ToggleGroupItem value="px" aria-label="Margins in pixels">
                px
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {MARGIN_SIDES.map((side) => (
            <NumberField
              key={side}
              id={`safe-area-margin-${side}`}
              label={`${SIDE_LABELS[side]} (${unitSuffix})`}
              value={config.margins[side]}
              step={config.marginUnit === 'percent' ? 0.5 : 1}
              disabled={disabled}
              onValueChange={(v) => handleMargin(side, v)}
            />
          ))}
        </div>
      </Field>

      <Separator />

      {/* Anchor --------------------------------------------------------------------- */}
      <Field className="gap-1.5">
        <FieldTitle className="text-xs">
          <Hint hint="Where the subject sits inside the safe area once it has been scaled.">
            Anchor
          </Hint>
        </FieldTitle>
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'w-fit rounded-lg border border-input bg-muted/40 p-1.5',
              disabled && 'opacity-50',
            )}
          >
            <ToggleGroup
              size="sm"
              spacing={1}
              disabled={disabled}
              value={[config.anchor]}
              onValueChange={(next) => {
                const picked = next[0];
                // Deselecting the pressed item yields an empty array — the tile always needs
                // an anchor, so ignore it and keep the current one.
                if (picked && isAnchor(picked)) patch({ anchor: picked });
              }}
              className="grid w-fit grid-cols-3"
              aria-label="Subject anchor"
            >
              {ANCHORS.map((anchor) => {
                const active = config.anchor === anchor;
                return (
                  <ToggleGroupItem
                    key={anchor}
                    value={anchor}
                    aria-label={ANCHOR_LABELS[anchor]}
                    title={ANCHOR_LABELS[anchor]}
                    className="h-7 w-7 min-w-0 rounded-[6px] p-0 text-muted-foreground hover:bg-primary/10 aria-pressed:bg-primary/15 aria-pressed:text-primary"
                  >
                    <span
                      className={cn(
                        'block rounded-[2px] bg-current transition-all',
                        active ? 'size-2.5' : 'size-1.5 opacity-40',
                      )}
                    />
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">{ANCHOR_LABELS[config.anchor]}</div>
          </div>
        </div>
      </Field>

      <Separator />

      {/* Fill ----------------------------------------------------------------------- */}
      <Field className="gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <FieldTitle className="text-xs">
            <Hint hint="How much of the safe area the subject may occupy.">Fill safe area</Hint>
          </FieldTitle>
          <span className="text-xs text-muted-foreground tabular-nums">{fillPct}%</span>
        </div>
        {/* Config stores 0..1; the slider works in whole percent and converts on the way out. */}
        <Slider
          aria-label="Fill safe area"
          min={0}
          max={100}
          step={1}
          disabled={disabled}
          value={[fillPct]}
          onValueChange={(value) => {
            const next = typeof value === 'number' ? value : value[0];
            if (!Number.isFinite(next)) return;
            patch({ fill: clamp(next, 0, 100) / 100 });
          }}
        />
      </Field>

      <Separator />

      {/* Upscale -------------------------------------------------------------------- */}
      <Field orientation="horizontal" className="items-start">
        <div className="min-w-0 flex-1">
          <FieldLabel htmlFor="safe-area-upscale" className="text-xs">
            <Hint hint="Off never enlarges the cutout past its own source resolution.">
              Allow upscale
            </Hint>
          </FieldLabel>
        </div>
        <Switch
          id="safe-area-upscale"
          className="mt-0.5"
          disabled={disabled}
          checked={config.allowUpscale}
          onCheckedChange={(checked) => patch({ allowUpscale: checked })}
        />
      </Field>

      <Separator />

      {/* Background ----------------------------------------------------------------- */}
      <Field className="gap-1.5">
        <FieldTitle className="text-xs">Background</FieldTitle>
        <div className="flex items-center gap-2">
          <ToggleGroup
            size="sm"
            variant="outline"
            spacing={0}
            disabled={disabled}
            value={[bgMode]}
            onValueChange={(next) => {
              const mode = next[0];
              if (mode === 'transparent' || mode === 'white' || mode === 'custom') {
                handleBackgroundMode(mode);
              }
            }}
          >
            <ToggleGroupItem value="transparent">Transparent</ToggleGroupItem>
            <ToggleGroupItem value="white">White</ToggleGroupItem>
            <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
          </ToggleGroup>
          <ColorPicker
            aria-label="Custom background colour"
            showValue={false}
            disabled={disabled}
            value={colorValue}
            onChange={(next) => {
              setCustomBg(next);
              patch({ background: next });
            }}
            className="h-7 shrink-0"
          />
        </div>
      </Field>
    </FieldGroup>
  );
}
