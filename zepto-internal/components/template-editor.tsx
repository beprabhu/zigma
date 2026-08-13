'use client';

// Figma-style template editor: preview canvas with click-to-select,
// layers list (visibility + stacking order), and a properties inspector.
// Custom component composed from shadcn primitives.

import * as React from 'react';
import { EyeIcon, EyeOffIcon, ChevronUpIcon, ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

const LAYER_PROPS: Record<LayerName, PropDef[]> = {
  frame: [
    { key: 'width', label: 'Width', type: 'number', min: 20, max: 400 },
    { key: 'height', label: 'Height', type: 'number', min: 20, max: 400 },
    { key: 'radius', label: 'Corner radius', type: 'number', min: 0, max: 100 },
    { key: 'bg', label: 'Background', type: 'color' },
  ],
  title: [
    { key: 'size', label: 'Font size', type: 'number', min: 4, max: 60 },
    { key: 'lineHeight', label: 'Line height', type: 'number', min: 4, max: 80 },
    { key: 'weight', label: 'Weight', type: 'select', options: WEIGHTS },
    { key: 'color', label: 'Color', type: 'color' },
    { key: 'y', label: 'Y position', type: 'number', min: -100, max: 400 },
    { key: 'xOffset', label: 'X offset', type: 'number', min: -200, max: 200 },
    { key: 'width', label: 'Text width', type: 'number', min: 10, max: 400 },
    { key: 'maxLines', label: 'Max lines', type: 'number', min: 1, max: 6 },
    { key: 'align', label: 'Align', type: 'select', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] },
  ],
  image: [
    { key: 'width', label: 'Width', type: 'number', min: 10, max: 400 },
    { key: 'height', label: 'Height', type: 'number', min: 10, max: 400 },
    { key: 'xOffset', label: 'X offset', type: 'number', min: -200, max: 200 },
    { key: 'bottom', label: 'Bottom offset', type: 'number', min: -400, max: 400 },
    { key: 'fit', label: 'Fit', type: 'select', options: [['cover', 'Cover (fill)'], ['contain', 'Contain (fit)']] },
  ],
  offer: [
    { key: 'width', label: 'Width', type: 'number', min: 10, max: 400 },
    { key: 'height', label: 'Height', type: 'number', min: 6, max: 200 },
    { key: 'xOffset', label: 'X offset', type: 'number', min: -200, max: 200 },
    { key: 'bottom', label: 'Bottom offset', type: 'number', min: -400, max: 400 },
    { key: 'radius', label: 'Corner radius', type: 'number', min: 0, max: 100 },
    { key: 'pad', label: 'Padding', type: 'number', min: 0, max: 40 },
    { key: 'bg', label: 'Background', type: 'color' },
    { key: 'color', label: 'Text color', type: 'color' },
    { key: 'size', label: 'Font size', type: 'number', min: 4, max: 60 },
    { key: 'weight', label: 'Weight', type: 'select', options: WEIGHTS },
  ],
};

interface TemplateEditorProps {
  template: TileTemplate;
  onChange: (tpl: TileTemplate) => void;
  previewTitle: string;
  previewOffer: string;
  previewOfferVisible: boolean;
  /**
   * Preview-only: no layers panel, no inspector, no layer picking. For the image-container
   * presets, where the whole template IS one full-bleed image and there is nothing to edit.
   */
  minimal?: boolean;
  /** Rendered between the preview and the layers panel (tile text fields). */
  children?: React.ReactNode;
}

export function TemplateEditor({
  template, onChange, previewTitle, previewOffer, previewOfferVisible, minimal = false, children,
}: TemplateEditorProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = React.useState<LayerName>('frame');
  const fontsReady = useTileFontsReady();

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderTile(canvas, {
      title: previewTitle, offerText: previewOffer,
      offerVisible: previewOfferVisible, image: null,
    }, template);
    if (!minimal) drawSelectionOutline(canvas, template, selected);
  }, [template, selected, previewTitle, previewOffer, previewOfferVisible, fontsReady, minimal]);

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

  return (
    <div className="space-y-3">
      {/* Live preview gets the full pane width — this pane's job is seeing the tile.
          No Reset control: the preset dropdown above supersedes it (pick "SKU tile"). */}
      <div className="relative flex justify-center rounded-lg bg-muted/50 p-4">
        {/* No CSS corner rounding — the frame's own radius must be the only rounding visible. */}
        <canvas
          ref={canvasRef}
          onClick={minimal ? undefined : handleCanvasClick}
          className={cn('w-[240px] max-w-full', !minimal && 'cursor-pointer')}
          style={{
            background: 'repeating-conic-gradient(oklch(0.96 0 0) 0% 25%, #fff 0% 50%) 0 0 / 16px 16px',
            height: Math.round((240 * template.frame.height) / template.frame.width),
          }}
        />
      </div>

      {/* Tile text fields (from the page) sit between preview and layers. */}
      {children}

      {/* Two columns like Figma: layers panel left, inspector right. */}
      {!minimal && (
      <div className="flex gap-4">
        {/* Layers panel — flat rows, controls surface on hover. */}
        <div className="h-fit w-[148px] shrink-0 overflow-hidden rounded-lg border">
          <div className="border-b bg-muted/50 px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">
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
                <Field key={prop.key} className="gap-1">
                  <FieldLabel htmlFor={inputId} className="text-[11px] text-muted-foreground">
                    {prop.label}
                  </FieldLabel>
                  {prop.type === 'number' && (
                    <Input
                      id={inputId}
                      type="number"
                      className="h-8 text-xs"
                      min={prop.min}
                      max={prop.max}
                      value={String(value)}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v)) return;
                        patchLayer(selected, prop.key,
                          Math.min(prop.max ?? Infinity, Math.max(prop.min ?? -Infinity, v)));
                      }}
                    />
                  )}
                  {prop.type === 'color' && (
                    <input
                      id={inputId}
                      type="color"
                      className="h-8 w-full cursor-pointer rounded-md border bg-transparent px-1"
                      value={String(value)}
                      onChange={(e) => patchLayer(selected, prop.key, e.target.value)}
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
