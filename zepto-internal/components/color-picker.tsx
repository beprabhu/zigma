'use client';

// Figma's colour picker, rebuilt on this project's shadcn primitives.
//
// It replaces `<input type="color">`, which handed the job to the OS. That picker is fine in
// isolation and wrong here: it is a different visual language on every platform, it opens
// outside the app's own surface, and on a dark panel it arrives as a bright system window. This
// one is Popover + Slider + Input + Select + Button, so it looks like the rest of the suite and
// themes with it.
//
// Everything is a shadcn primitive except the saturation/value square, which cannot be — no
// primitive models a 2D drag surface. That one part is a plain div with pointer capture, and it
// carries its own keyboard handling so it is not mouse-only.
//
// Deliberately not Figma's: the alpha slider (a tile colour is opaque — the frame is what the
// PNG is flattened onto) and the contrast readout (it needs a second colour to contrast
// against, which this control cannot know from where it sits).

import * as React from 'react';
import { PipetteIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import {
  clamp, hexToRgb, hslToRgb, hsvToHex, hsvToRgb, rgbToHex, rgbToHsl, rgbToHsv,
  type Hsv,
} from '@/lib/color';
import { cn } from '@/lib/utils';

type Format = 'hex' | 'rgb' | 'hsl';

/** Chromium-only; the button is simply absent everywhere else rather than present and dead. */
interface EyeDropperCtor {
  new (): { open: () => Promise<{ sRGBHex: string }> };
}

/**
 * The hue strip, painted onto the Slider's own track slot. Written as one Tailwind arbitrary
 * value (underscores for spaces) so the scanner emits it — a style attribute would not reach
 * inside the primitive, and a global rule would repaint every other slider in a popover.
 */
const HUE_TRACK =
  '[&_[data-slot=slider-track]]:bg-[linear-gradient(to_right,#f00_0%,#ff0_17%,#0f0_33%,#0ff_50%,#00f_67%,#f0f_83%,#f00_100%)]';

export function ColorPicker({
  value,
  onChange,
  id,
  disabled,
  className,
  showValue = true,
  'aria-label': ariaLabel,
}: {
  /** Hex, with hash. Anything unparseable is treated as black rather than throwing. */
  value: string;
  onChange: (hex: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Whether the trigger spells the hex out beside its swatch. False leaves the swatch alone —
   * for the compact slots that sit inline beside a toggle group, where the label above already
   * says what the colour is for and there is no room to repeat the value.
   */
  showValue?: boolean;
  /** Needed when showValue is false: the swatch alone is not a name. */
  'aria-label'?: string;
}) {
  const [format, setFormat] = React.useState<Format>('hex');
  // HSV is held, not derived, because the square and the hue strip are its two axes: a colour
  // dragged to the black corner has no hue of its own to convert back from, and re-deriving
  // would snap the strip to red under the user's finger.
  const [hsv, setHsv] = React.useState<Hsv>(() => rgbToHsv(hexToRgb(value) ?? { r: 0, g: 0, b: 0 }));
  // Re-seed only when the value moves somewhere this picker did not put it (a preset applied,
  // a reset). Adjusting state during render is React's own answer to props-derived state; an
  // effect would be a second render and a visible lag on every drag frame.
  const [seenValue, setSeenValue] = React.useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    const rgb = hexToRgb(value);
    if (rgb) {
      const next = rgbToHsv(rgb);
      setHsv((prev) => ({
        // Greys and blacks carry no hue; keep the one the strip is standing on.
        h: next.s === 0 || next.v === 0 ? prev.h : next.h,
        s: next.s,
        v: next.v,
      }));
    }
  }

  const rgb = hsvToRgb(hsv);
  const hex = rgbToHex(rgb);
  const hsl = rgbToHsl(rgb);

  function commit(next: Hsv) {
    setHsv(next);
    const nextHex = hsvToHex(next);
    setSeenValue(nextHex);
    onChange(nextHex);
  }

  // ---- Saturation / value square ----
  function pointTo(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    commit({
      ...hsv,
      s: clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100),
      v: clamp((1 - (e.clientY - rect.top) / rect.height) * 100, 0, 100),
    });
  }

  function squareKeys(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 10 : 2;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    commit({ ...hsv, s: clamp(hsv.s + move[0], 0, 100), v: clamp(hsv.v + move[1], 0, 100) });
  }

  // ---- Typed values ----
  // Held as text while focused so a half-typed "1" in an RGB field is not clamped to 1 and
  // re-rendered under the caret — the same rule the template inspector's number fields use.
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown =
    draft ??
    (format === 'hex'
      ? hex
      : format === 'rgb'
        ? `${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}`
        : `${Math.round(hsl.h)}, ${Math.round(hsl.s)}%, ${Math.round(hsl.l)}%`);

  function commitText(text: string) {
    const nums = text.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    if (format === 'hex') {
      const parsed = hexToRgb(text);
      if (parsed) commit(rgbToHsv(parsed));
      return;
    }
    if (nums.length < 3) return;
    const [a, b, c] = nums;
    const parsed =
      format === 'rgb'
        ? { r: clamp(a, 0, 255), g: clamp(b, 0, 255), b: clamp(c, 0, 255) }
        : hslToRgb({ h: a, s: clamp(b, 0, 100), l: clamp(c, 0, 100) });
    commit(rgbToHsv(parsed));
  }

  const eyeDropper =
    typeof window !== 'undefined' && 'EyeDropper' in window
      ? (window as unknown as { EyeDropper: EyeDropperCtor }).EyeDropper
      : null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={ariaLabel}
            className={cn(
              'h-8 gap-2 px-2 font-normal',
              showValue ? 'w-full justify-start' : 'w-auto justify-center',
              className,
            )}
          />
        }
      >
        {/* The swatch is the control's value; the hex beside it is what gets copied around. */}
        <span
          className="size-4 shrink-0 rounded-sm border border-black/15 dark:border-white/20"
          style={{ background: hex }}
        />
        {showValue && <span className="truncate font-mono text-[11px] uppercase">{hex}</span>}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-3">
        <div className="space-y-3">
          {/* Saturation × value for the current hue. White→hue across, transparent→black down;
              stacking them is what makes every s/v pair land where the eye expects it. */}
          <div
            role="application"
            aria-label="Saturation and brightness"
            tabIndex={disabled ? -1 : 0}
            onKeyDown={squareKeys}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              pointTo(e);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) pointTo(e);
            }}
            className="relative h-32 w-full cursor-default rounded-md outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            style={{
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
            }}
          >
            {/* Figma's handle: a thick white ring with the colour it is standing on filling
                the middle, so the indicator states the value rather than just marking a spot.
                A soft drop shadow instead of a hard black hairline — the hairline read as a
                second ring and made the whole thing look hollow against a dark gradient. */}
            <span
              className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-white shadow-[0_1px_4px_rgba(0,0,0,0.45)]"
              style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, background: hex }}
            />
          </div>

          <div className="flex items-center gap-2">
            {eyeDropper && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title="Pick a colour from the screen"
                aria-label="Pick a colour from the screen"
                onClick={() => {
                  void new eyeDropper()
                    .open()
                    .then((r) => {
                      const picked = hexToRgb(r.sRGBHex);
                      if (picked) commit(rgbToHsv(picked));
                    })
                    // Dismissing the eyedropper rejects; that is a cancel, not a failure.
                    .catch(() => {});
                }}
              >
                <PipetteIcon />
              </Button>
            )}
            {/* Hue: the shadcn Slider, its track repainted and its fill made invisible — a
                range indicator means nothing when the track is the whole spectrum. Both reach
                the primitive's internals through its own data-slots, so the component is
                styled rather than forked. */}
            <Slider
              value={[hsv.h]}
              min={0}
              max={360}
              step={1}
              disabled={disabled}
              aria-label="Hue"
              onValueChange={(v) => commit({ ...hsv, h: Array.isArray(v) ? v[0] : v })}
              className={cn(
                'flex-1',
                '[&_[data-slot=slider-track]]:h-3',
                HUE_TRACK,
                '[&_[data-slot=slider-range]]:bg-transparent',
              )}
            />
          </div>

          <div className="flex items-center gap-2">
            <Select value={format} onValueChange={(v) => { setDraft(null); setFormat(v as Format); }}>
              <SelectTrigger size="sm" className="h-8 w-[4.75rem] text-xs">
                <SelectValue>{(v) => String(v ?? 'hex').toUpperCase()}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hex">HEX</SelectItem>
                <SelectItem value="rgb">RGB</SelectItem>
                <SelectItem value="hsl">HSL</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={shown}
              disabled={disabled}
              aria-label={`Colour value in ${format.toUpperCase()}`}
              className="h-8 flex-1 font-mono text-xs uppercase"
              onChange={(e) => {
                setDraft(e.target.value);
                commitText(e.target.value);
              }}
              onBlur={() => setDraft(null)}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
