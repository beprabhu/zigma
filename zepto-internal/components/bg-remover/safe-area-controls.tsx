'use client';

// Settings panel for SafeAreaConfig. Fully controlled and stateless with respect to the config:
// the only local state is UI affordance (custom-size revealed, margins linked, remembered
// custom colour, in-progress number text) that has nowhere to live in SafeAreaConfig.

import * as React from 'react';
import {
  LinkIcon, PanelBottomOpenIcon, PanelLeftOpenIcon, PanelRightOpenIcon, PanelTopOpenIcon,
  RotateCcwIcon, UnlinkIcon,
} from 'lucide-react';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
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
  /**
   * Whether to render the background picker inside this block. Default true, which is what
   * every caller that only ever shows these controls WITH tile fit on wants. Cleanup passes
   * false: there the background applies to untiled exports and previews too, so its control
   * has to stay on screen when tile fit is off — it renders <BackgroundField> itself, above
   * this block, and the two would otherwise be the same setting drawn twice.
   */
  showBackground?: boolean;
}

export interface BackgroundFieldProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Field title. "Background" inside the tile controls; callers outside may want more. */
  label?: string;
}

/**
 * The background picker, on its own so it can be mounted outside the tile-fit block.
 * Owns the remembered custom colour, so switching Transparent -> Custom returns to the shade
 * that was picked rather than to the default.
 */
export function BackgroundField({
  value, onChange, disabled, label = 'Background',
}: BackgroundFieldProps): React.JSX.Element {
  const [customBg, setCustomBg] = React.useState(() =>
    backgroundMode(value) === 'custom' && HEX6.test(value) ? value : FALLBACK_CUSTOM_BG,
  );
  const mode = backgroundMode(value);
  const colorValue = mode === 'custom' && HEX6.test(value) ? value : customBg;

  return (
    <Field className="gap-1.5">
      <FieldTitle className="text-xs font-normal">{label}</FieldTitle>
      <div className="flex items-center gap-2">
        <ToggleGroup
          size="sm"
          variant="outline"
          spacing={0}
          disabled={disabled}
          value={[mode]}
          onValueChange={(next) => {
            const picked = next[0];
            if (picked === 'transparent') onChange(TRANSPARENT);
            else if (picked === 'white') onChange(WHITE);
            else if (picked === 'custom') onChange(customBg);
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
            onChange(next);
          }}
          className="h-7 shrink-0"
        />
      </div>
    </Field>
  );
}

// Sentinel select value. No TilePreset uses this id, so it can never shadow a real preset.
const CUSTOM_TILE = 'custom';

// Base UI's <SelectValue> prints the raw value unless Select.Root is handed the label map, so
// the trigger would otherwise read "sku-tile" instead of "SKU tile · 600 × 768".
const TILE_ITEMS: readonly { label: string; value: string }[] = [
  ...TILE_PRESETS.map((preset) => ({ label: preset.label, value: preset.id })),
  { label: 'Custom…', value: CUSTOM_TILE },
];

// Column order, not clock order: the 2x2 reads left|top over right|bottom.
const MARGIN_SIDES: readonly (keyof SafeAreaMargins)[] = ['left', 'top', 'right', 'bottom'];
const SIDE_LABELS: Record<keyof SafeAreaMargins, string> = {
  top: 'Top',
  right: 'Right',
  bottom: 'Bottom',
  left: 'Left',
};

// One letter over each field — the row is too narrow for "Left". It carries no unit ("Left"
// not "Left (%)"): the %/px toggle sits directly above the four fields and would otherwise say
// the same thing four times. The full side name survives as the accessible name and the title.
const SIDE_ABBR: Record<keyof SafeAreaMargins, string> = {
  left: 'L',
  top: 'T',
  right: 'R',
  bottom: 'B',
};

/**
 * The side each field controls, drawn as the panel that edge pushes IN from — so the left
 * margin gets the right-opening panel, and so on across the pair. The icon reads as the gap
 * itself rather than as an arrow pointing somewhere, which is what a margin actually is; it
 * sits inside the box, under the L/T/R/B label that names the side.
 */
const SIDE_ICONS: Record<keyof SafeAreaMargins, typeof PanelRightOpenIcon> = {
  left: PanelRightOpenIcon,
  right: PanelLeftOpenIcon,
  top: PanelBottomOpenIcon,
  bottom: PanelTopOpenIcon,
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
  /** The written name — the tooltip and the screen-reader name for the icon fields. */
  label: string;
  /** The short visible label shown above an icon field: L/T/R/B, where "Left" would not fit. */
  abbr?: string;
  /** Figma-style: the side glyph sits INSIDE the field, under its own short label. */
  icon?: typeof PanelRightOpenIcon;
  /** A unit shown INSIDE the box at the trailing edge (e.g. "px"), for the plain fields. */
  suffix?: string;
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
  abbr,
  icon: Icon,
  suffix,
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

  const controlProps = {
    id,
    type: 'number',
    inputMode: 'numeric' as const,
    min,
    max,
    step,
    disabled,
    value: text,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      setDraft(raw);
      if (raw.trim() === '') return;
      const next = Number(raw);
      // An empty or half-typed field keeps the previous value rather than emitting NaN.
      if (!Number.isFinite(next)) return;
      onValueChange(clamp(next, min ?? -Infinity, max ?? Infinity));
    },
    onBlur: () => setDraft(null),
  };

  // Icon field: the short label (L/T/R/B) names the side above the box, and the glyph inside
  // it — Figma-style, where a label would sit — reinforces which edge without spending a
  // second row. The full "Left" reaches a screen reader through aria-label and the hover title.
  if (Icon) {
    return (
      <Field className="gap-1">
        <FieldLabel htmlFor={id} title={label} className="text-xs font-normal">
          {abbr ?? label}
        </FieldLabel>
        <InputGroup title={label}>
          <InputGroupAddon>
            <Icon className="size-3.5" aria-hidden />
          </InputGroupAddon>
          {/* px-0: the addon already supplies the gap, and the control's own left padding
              pushed the number away from its icon. No text size: Input's own
              `text-base md:text-sm` is the suite's control text, and a `text-xs` here only
              ever bit below 768px — shrinking these four while the Select beside them stayed
              put. */}
          <InputGroupInput {...controlProps} aria-label={label} className="px-0" />
        </InputGroup>
      </Field>
    );
  }

  // Plain field: a foreground label (the panel's one label style) over the box. A unit, when
  // there is one, rides INSIDE the box at the trailing edge as subtext — "Width" reads cleaner
  // than "Width (px)", and the px sits where the value it qualifies actually is.
  return (
    <Field className="gap-1">
      <FieldLabel htmlFor={id} className="text-xs font-normal">
        {label}
      </FieldLabel>
      {suffix ? (
        <InputGroup>
          <InputGroupInput {...controlProps} />
          <InputGroupAddon align="inline-end" className="text-muted-foreground">
            {suffix}
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <Input {...controlProps} />
      )}
    </Field>
  );
}

export function SafeAreaControls({
  config,
  onChange,
  onReset,
  disabled = false,
  showBackground = true,
}: SafeAreaControlsProps): React.JSX.Element {
  const [customTile, setCustomTile] = React.useState(false);
  const [linkMargins, setLinkMargins] = React.useState(false);

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

  const fillPct = Math.round(clamp(Number.isFinite(config.fill) ? config.fill : 1, 0, 1) * 100);
  const unitSuffix = config.marginUnit === 'percent' ? '%' : 'px';

  return (
    <FieldGroup className="gap-4">
      {/* Tile size — and the section's Reset. There is no "Safe area" sub-heading: the
          PanelSection this lives in is already titled "Tile fit", and a second line under it
          named the same thing at a second weight. Reset keeps its top-right corner as an icon
          and still clears the whole safe area, panel affordances included. */}
      <Field className="gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor="safe-area-tile" className="text-xs">
            Tile size
          </FieldLabel>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={handleReset}
            aria-label="Reset safe area"
            title="Reset safe area"
            className="-my-1 text-muted-foreground"
          >
            <RotateCcwIcon />
          </Button>
        </div>
        <Select
          items={TILE_ITEMS}
          value={tileValue}
          disabled={disabled}
          onValueChange={(v) => {
            if (v == null) return;
            handleTilePreset(String(v));
          }}
        >
          {/* Default size and no text override, so this reads as the same control as every
              other Select in the suite (12.6px on a 28.8px box) and lines up with the Width /
              Height fields directly below it.

              What it used to say — `size="sm" className="h-8 text-xs"` — asked for two
              contradictory heights and lost: `data-[size=sm]:h-7` is an attribute selector, so
              it outranks a plain `h-8` and the field rendered 25.2px, not the 28.8px the class
              was there to get. The `text-xs` DID land, and that is the whole reason this select
              was the only shrunken one on the panel: Input carries `text-base md:text-sm`, so a
              `text-xs` beside it dies against the md: variant at this width, while
              SelectTrigger's plain `text-sm` loses to it outright. Same class, two components,
              opposite outcomes. */}
          <SelectTrigger id="safe-area-tile" className="w-full">
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
              label="Width"
              suffix="px"
              value={config.tile.width}
              min={1}
              max={8192}
              disabled={disabled}
              onValueChange={(width) => patch({ tile: { ...config.tile, width } })}
            />
            <NumberField
              id="safe-area-tile-h"
              label="Height"
              suffix="px"
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
          <FieldTitle className="text-xs font-normal">
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
        {/* Anchor pad and the four margin fields sit side by side — "where does the subject
            sit" next to "how much room does it get". Each column leads with a label row —
            "Anchor" over the pad, L/T/R/B over the fields — and that shared label row is what
            keeps the pad level with the first row of fields rather than riding up a line. */}
        <div className="flex gap-3">
          <div className="shrink-0 space-y-1">
            {/* A field label, not a heading: Anchor is a sibling of L/T/R/B, one of the five
                things being set, so it takes the label style rather than the "Margins" rank. */}
            <FieldLabel className="text-xs font-normal">
              <Hint hint="Where the subject sits inside the safe area once it has been scaled.">
                Anchor
              </Hint>
            </FieldLabel>
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
                      className="h-6 w-6 min-w-0 rounded-[6px] p-0 text-muted-foreground hover:bg-primary/10 aria-pressed:bg-primary/15 aria-pressed:text-primary"
                    >
                      <span
                        className={cn(
                          'block rounded-[2px] bg-current transition-all',
                          active ? 'size-2' : 'size-1.5 opacity-40',
                        )}
                      />
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
            </div>
          </div>
          {/* self-start: without it the grid stretches to the anchor box's height and pushes
              the two rows of fields apart to fill it. */}
          <div className="grid min-w-0 grid-cols-2 gap-2 self-start">
            {MARGIN_SIDES.map((side) => {
              return (
                <NumberField
                  key={side}
                  id={`safe-area-margin-${side}`}
                  label={`${SIDE_LABELS[side]} (${unitSuffix})`}
                  abbr={SIDE_ABBR[side]}
                  icon={SIDE_ICONS[side]}
                  value={config.margins[side]}
                  step={config.marginUnit === 'percent' ? 0.5 : 1}
                  disabled={disabled}
                  onValueChange={(v) => handleMargin(side, v)}
                />
              );
            })}
          </div>
        </div>
      </Field>

      {/* Fill sits in the same group as Margins — no divider between them. Both answer "how
          much room does the subject get": the margins set the box, the slider sets how much of
          it the subject fills. */}
      <Field className="gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <FieldTitle className="text-xs font-normal">
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

      {/* Background shares the render group with Allow upscale — no divider between them; both
          are about how the cutout comes out, not where it sits. */}
      {showBackground && (
        <BackgroundField
          value={config.background}
          onChange={(next) => patch({ background: next })}
          disabled={disabled}
        />
      )}
    </FieldGroup>
  );
}
