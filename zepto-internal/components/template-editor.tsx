'use client';

// Figma-style template editor: preview canvas with click-to-select, layers list (visibility and
// stacking order), and a properties inspector.
//
// Two shapes, chosen by the preset:
//  - `colorsOnly` — the settled presets, whose geometry is stated once in lib/tile-presets.ts and
//    read by every row. Editing it per-batch would only knock the preset into "Custom", so all
//    that is offered is the part which genuinely varies: four colours, under a collapsible.
//  - the full editor — everything else, including presets still being worked out. Layers,
//    stacking, visibility, and every numeric property of every layer.
//
// Custom component composed from shadcn primitives.

import * as React from 'react';
import {
  ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, EyeIcon, EyeOffIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ColorPicker } from '@/components/color-picker';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  TileTemplate, LayerName, ContentLayerName,
  renderTile, drawSelectionOutline, hitTestTile,
} from '@/lib/tile';
import { useTileFontsReady } from '@/hooks/use-tile-fonts';

const LAYER_LABELS: Record<LayerName, string> = {
  frame: 'Frame', title: 'Title', image: 'Image', offer: 'Offer bar',
};

type PropType = 'number' | 'color' | 'select';
interface PropDef {
  key: string;
  label: string;
  type: PropType;
  min?: number;
  max?: number;
  options?: [string, string][];
}

const WEIGHTS: [string, string][] = [
  ['400', 'Regular'], ['500', 'Medium'], ['600', 'DemiBold'], ['700', 'Bold'], ['800', 'ExtraBold'],
];

// Ranges are generous rather than tight. They were sized around the original 75x96 frame, where a
// 400 cap on width was five times the tile; a preset stated at a larger scale lives further out,
// and a cap that silently rewrites 480 to 400 the first time the field is touched is worse than
// no cap. Frame units are relative anyway - export is EXPORT_WIDTH-scaled whatever the numbers
// say - so these exist only to stop a typo becoming a blank canvas.
const LAYER_PROPS: Record<LayerName, PropDef[]> = {
  frame: [
    { key: 'width', label: 'Width', type: 'number', min: 20, max: 2000 },
    { key: 'height', label: 'Height', type: 'number', min: 20, max: 2000 },
    { key: 'radius', label: 'Corner radius', type: 'number', min: 0, max: 500 },
    { key: 'bg', label: 'Background', type: 'color' },
  ],
  title: [
    { key: 'size', label: 'Font size', type: 'number', min: 4, max: 300 },
    { key: 'lineHeight', label: 'Line height', type: 'number', min: 4, max: 400 },
    { key: 'weight', label: 'Weight', type: 'select', options: WEIGHTS },
    { key: 'color', label: 'Color', type: 'color' },
    { key: 'y', label: 'Y position', type: 'number', min: -500, max: 2000 },
    { key: 'xOffset', label: 'X offset', type: 'number', min: -1000, max: 1000 },
    { key: 'width', label: 'Text width', type: 'number', min: 10, max: 2000 },
    { key: 'maxLines', label: 'Max lines', type: 'number', min: 1, max: 6 },
    { key: 'align', label: 'Align', type: 'select', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] },
  ],
  image: [
    { key: 'width', label: 'Width', type: 'number', min: 10, max: 2000 },
    { key: 'height', label: 'Height', type: 'number', min: 10, max: 2000 },
    { key: 'xOffset', label: 'X offset', type: 'number', min: -1000, max: 1000 },
    { key: 'bottom', label: 'Bottom offset', type: 'number', min: -2000, max: 2000 },
    { key: 'fit', label: 'Fit', type: 'select', options: [['cover', 'Cover (fill)'], ['contain', 'Contain (fit)']] },
  ],
  offer: [
    { key: 'width', label: 'Width', type: 'number', min: 10, max: 2000 },
    { key: 'height', label: 'Height', type: 'number', min: 6, max: 1000 },
    { key: 'xOffset', label: 'X offset', type: 'number', min: -1000, max: 1000 },
    { key: 'bottom', label: 'Bottom offset', type: 'number', min: -2000, max: 2000 },
    { key: 'radius', label: 'Corner radius', type: 'number', min: 0, max: 500 },
    { key: 'pad', label: 'Padding', type: 'number', min: 0, max: 200 },
    { key: 'bg', label: 'Background', type: 'color' },
    { key: 'color', label: 'Text color', type: 'color' },
    { key: 'size', label: 'Font size', type: 'number', min: 4, max: 300 },
    { key: 'weight', label: 'Weight', type: 'select', options: WEIGHTS },
  ],
};

/**
 * A number field that lets you finish typing.
 *
 * The inspector used to parse and clamp on every keystroke against a controlled value, which
 * quietly rewrote what was being typed. With frame width's min of 20, clearing the field and
 * typing "40" clamped the intermediate "4" up to 20, so the next keystroke landed on "200" - one
 * value in, a different value out. Clearing the field at all was impossible too, since Number('')
 * is 0 and 0 clamped straight back up to the minimum.
 *
 * So: the draft holds exactly what was typed, the template only accepts values that are already
 * in range, and the clamp happens once - on blur. A half-typed number ("4", "-", "333.") is a
 * number on its way somewhere, not a choice, so it waits in the draft instead of being corrected.
 * type="number" is kept for its arrow-key stepping; while its text is not yet a valid number the
 * browser reports value as '', and React leaves the visible text alone because it already
 * matches, which is what lets "333.33" be typed through its middle dot.
 */
function NumberField({
  id, value, min, max, onCommit,
}: {
  id: string;
  value: number;
  min?: number;
  max?: number;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  return (
    <Input
      id={id}
      type="number"
      // Decimals are real geometry - the 5:6 preset's width is not a whole number.
      step="any"
      inputMode="decimal"
      className="h-8 text-xs"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (!text.trim()) return;
        const n = Number(text);
        if (Number.isFinite(n) && n >= lo && n <= hi) onCommit(n);
      }}
      onBlur={() => {
        if (draft === null) return;
        const n = Number(draft);
        setDraft(null);
        // An empty or unparseable field on blur means "leave it alone", not "make it zero".
        if (draft.trim() && Number.isFinite(n)) onCommit(Math.min(hi, Math.max(lo, n)));
      }}
    />
  );
}

/** One swatch. The picker it opens is the suite's own, not the operating system's. */
function ColorField({
  id, label, value, onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <Field className="gap-1">
      <FieldLabel htmlFor={id} className="text-[11px] text-muted-foreground">
        {label}
      </FieldLabel>
      <ColorPicker id={id} value={value} onChange={onChange} />
    </Field>
  );
}

interface TemplateEditorProps {
  template: TileTemplate;
  onChange: (tpl: TileTemplate) => void;
  previewTitle: string;
  previewOffer: string;
  previewOfferVisible: boolean;
  /**
   * Preview only: no layers panel, no inspector, no colours, no layer picking. For the
   * image-container presets, where the whole template IS one full-bleed image.
   */
  minimal?: boolean;
  /**
   * Colours instead of the full editor. For presets whose geometry is settled: the layout comes
   * from the preset, and the only thing left to decide per batch is colour.
   */
  colorsOnly?: boolean;
  /** Rendered between the preview and the layers panel (tile text fields). */
  children?: React.ReactNode;
}

export function TemplateEditor({
  template, onChange, previewTitle, previewOffer, previewOfferVisible,
  minimal = false, colorsOnly = false, children,
}: TemplateEditorProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = React.useState<LayerName>('frame');
  const fontsReady = useTileFontsReady();
  const pickable = !minimal && !colorsOnly;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderTile(canvas, {
      title: previewTitle, offerText: previewOffer,
      offerVisible: previewOfferVisible, image: null,
    }, template);
    if (pickable) drawSelectionOutline(canvas, template, selected);
  }, [template, selected, previewTitle, previewOffer, previewOfferVisible, fontsReady, pickable]);

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * template.frame.width;
    const y = ((e.clientY - rect.top) / rect.height) * template.frame.height;
    setSelected(hitTestTile(template, x, y));
  }

  function patchLayer(name: LayerName, key: string, value: unknown) {
    onChange({ ...template, [name]: { ...template[name], [key]: value } });
  }

  function toggleVisible(name: ContentLayerName) {
    patchLayer(name, 'visible', !template[name].visible);
  }

  function moveLayer(name: ContentLayerName, dir: 1 | -1) {
    const order = [...template.layerOrder];
    const idx = order.indexOf(name);
    const to = idx + dir;
    if (to < 0 || to >= order.length) return;
    order.splice(idx, 1);
    order.splice(to, 0, name);
    onChange({ ...template, layerOrder: order });
  }

  // Topmost first, like Figma; frame pinned to the bottom of the list.
  const listRows: LayerName[] = [...([...template.layerOrder].reverse() as LayerName[]), 'frame'];

  // The preview fits a 240x300 box, whichever side runs out first, so every ratio is previewed at
  // a comparable size and none of them can push the panel around. Height used to be derived from
  // the width alone, so a tall ratio grew without limit - mid-edit, a frame 40 wide by 400 made a
  // 2400px preview that shoved the inspector clean off the panel, exactly when the inspector was
  // what you were reaching for.
  const previewScale = Math.min(240 / template.frame.width, 300 / template.frame.height);

  return (
    <div className="space-y-3">
      {/* Live preview gets the full pane width — this pane's job is seeing the tile.
          No Reset control: the preset dropdown above supersedes it. */}
      <div className="relative flex justify-center rounded-lg bg-muted/50 p-4">
        {/* No CSS corner rounding — the frame's own radius must be the only rounding visible. */}
        <canvas
          ref={canvasRef}
          onClick={pickable ? handleCanvasClick : undefined}
          className={cn('max-w-full', pickable && 'cursor-pointer')}
          style={{
            background: 'repeating-conic-gradient(oklch(0.96 0 0) 0% 25%, #fff 0% 50%) 0 0 / 16px 16px',
            width: Math.round(template.frame.width * previewScale),
            height: Math.round(template.frame.height * previewScale),
          }}
        />
      </div>

      {/* Tile text fields (from the page) sit between preview and layers. */}
      {children}

      {colorsOnly && !minimal && (
        // No container. The other presets render their property grid as heading + separator +
        // grid with no box around it, and this IS that block with the geometry taken out — a
        // bordered card made the same content read as a different kind of control.
        //
        // Open by default: on this preset it is the only thing in the pane, so folded shut the
        // panel would just look empty.
        <Collapsible defaultOpen>
          {/* Chevron rotation: a static rule in base.css keys off Base UI's data-panel-open. */}
          <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 rounded-md text-xs font-semibold outline-none transition-colors hover:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <ChevronRightIcon className="size-3.5 transition-transform" />
            Colours
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Separator className="mt-2 mb-3" />
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <ColorField
                id="tpl-frame-bg"
                label="Background"
                value={template.frame.bg}
                onChange={(v) => patchLayer('frame', 'bg', v)}
              />
              <ColorField
                id="tpl-title-color"
                label="Title text"
                value={template.title.color}
                onChange={(v) => patchLayer('title', 'color', v)}
              />
              <ColorField
                id="tpl-offer-bg"
                label="Offer bar"
                value={template.offer.bg}
                onChange={(v) => patchLayer('offer', 'bg', v)}
              />
              <ColorField
                id="tpl-offer-color"
                label="Offer text"
                value={template.offer.color}
                onChange={(v) => patchLayer('offer', 'color', v)}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Two columns like Figma: layers panel left, inspector right. */}
      {pickable && (
      <div className="flex gap-4">
        {/* Layers panel — flat rows, controls surface on hover. */}
        <div className="h-fit w-[148px] shrink-0 overflow-hidden rounded-lg border">
          <div className="border-b bg-muted/50 px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Layers
          </div>
          {listRows.map((name) => {
            const isFrame = name === 'frame';
            const layer = template[name];
            const idx = isFrame ? -1 : template.layerOrder.indexOf(name as ContentLayerName);
            const visible = isFrame || (layer as { visible: boolean }).visible;
            return (
              <div
                key={name}
                onClick={() => setSelected(name)}
                className={cn(
                  'group/layer flex h-8 cursor-pointer items-center gap-1 px-2 text-xs whitespace-nowrap transition-colors',
                  selected === name ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
              >
                <span className={cn('min-w-0 flex-1 truncate', !visible && 'opacity-45')}>
                  {LAYER_LABELS[name]}
                </span>
                {!isFrame && (
                  <span
                    className={cn(
                      'flex items-center opacity-0 transition-opacity group-hover/layer:opacity-100',
                      (selected === name || !visible) && 'opacity-100',
                    )}
                  >
                    <Button
                      variant="ghost" size="icon-sm" className="size-5"
                      title="Bring forward"
                      disabled={idx === template.layerOrder.length - 1}
                      onClick={(e) => { e.stopPropagation(); moveLayer(name as ContentLayerName, 1); }}
                    >
                      <ChevronUpIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="icon-sm" className="size-5"
                      title="Send backward"
                      disabled={idx === 0}
                      onClick={(e) => { e.stopPropagation(); moveLayer(name as ContentLayerName, -1); }}
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost" size="icon-sm" className="size-5"
                      title={visible ? 'Hide layer' : 'Show layer'}
                      onClick={(e) => { e.stopPropagation(); toggleVisible(name as ContentLayerName); }}
                    >
                      {visible ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
                    </Button>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Inspector — right column. */}
        <div className="min-w-0 flex-1">
          <div className="mb-2 text-xs font-semibold">{LAYER_LABELS[selected]}</div>
          <Separator className="mb-3" />
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {LAYER_PROPS[selected].map((prop) => {
              const layer = template[selected] as unknown as Record<string, unknown>;
              const value = layer[prop.key];
              const inputId = `prop-${selected}-${prop.key}`;
              return (
                // Keyed by layer as well as prop: "width" exists on four layers, so keying by
                // prop alone let a half-typed draft survive a layer switch into a field it was
                // never typed into.
                <Field key={`${selected}-${prop.key}`} className="gap-1">
                  <FieldLabel htmlFor={inputId} className="text-[11px] text-muted-foreground">
                    {prop.label}
                  </FieldLabel>
                  {prop.type === 'number' && (
                    <NumberField
                      id={inputId}
                      value={Number(value)}
                      min={prop.min}
                      max={prop.max}
                      onCommit={(n) => patchLayer(selected, prop.key, n)}
                    />
                  )}
                  {prop.type === 'color' && (
                    <ColorPicker
                      id={inputId}
                      value={String(value)}
                      onChange={(v) => patchLayer(selected, prop.key, v)}
                    />
                  )}
                  {prop.type === 'select' && (
                    <Select
                      value={String(value)}
                      onValueChange={(v) => {
                        if (v == null) return;
                        patchLayer(selected, prop.key, /^\d+$/.test(String(v)) ? Number(v) : v);
                      }}
                    >
                      <SelectTrigger id={inputId} size="sm" className="h-8 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {prop.options!.map(([v, label]) => (
                          <SelectItem key={v} value={v}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              );
            })}
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
