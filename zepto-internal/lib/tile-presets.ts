// Compose's template presets — the dropdown above the template editor. A preset is a complete
// TileTemplate snapshot; picking one REPLACES the working template (deep-cloned, so edits
// never write back into the preset). Any edit that diverges from every preset makes the
// dropdown read "Custom".
//
// Adding a preset is one entry here: give it a stable id (it is never persisted, only
// matched), a label for the dropdown, and the full template. The active preset is derived by
// structural comparison, so a template that happens to equal a preset selects it — including
// after a reload from localStorage.

import { DEFAULT_TEMPLATE, type TileTemplate } from '@/lib/tile';

export type PresetType = 'image' | 'banner';

/** The Type dropdown's options; the Ratio dropdown lists the presets of the chosen type. */
export const PRESET_TYPES: { id: PresetType; label: string }[] = [
  { id: 'image', label: 'Image' },
  { id: 'banner', label: 'Banner tile' },
];

export interface TilePreset {
  id: string;
  type: PresetType;
  /** Shown in the Ratio dropdown. */
  ratio: string;
  template: TileTemplate;
  /**
   * Azure size to request while this preset is active, so the returned image matches the
   * container's ratio exactly and full-bleed needs no crop. Absent = 'auto' (follow input).
   */
  azureSize?: '1024x1024' | '1536x1024' | '1024x1536';
}

export const CUSTOM_PRESET_ID = 'custom';

/**
 * A frame that is ONLY an image container: full-bleed cover image, title and offer hidden.
 * Frame units just set the ratio — the exported pixel size is EXPORT_WIDTH-scaled as usual.
 */
function imageOnly(width: number, height: number): TileTemplate {
  return {
    frame: { width, height, radius: 0, bg: '#ffffff' },
    layerOrder: ['image', 'title', 'offer'],
    title: { ...DEFAULT_TEMPLATE.title, visible: false },
    image: { visible: true, xOffset: 0, bottom: 0, width, height, fit: 'cover' },
    offer: { ...DEFAULT_TEMPLATE.offer, visible: false },
  };
}

export const TILE_PRESETS: TilePreset[] = [
  // Banner tiles — full template (image + title + offer). More ratios land here as they are
  // defined; each is one entry with its own template snapshot.
  { id: 'sku-tile', type: 'banner', ratio: 'Default · 75×96', template: DEFAULT_TEMPLATE },
  // Image — the three ratios gpt-image-2 generates natively, same set as Generate's Size
  // dropdown. Image container only; the matching azureSize keeps output and frame 1:1.
  { id: 'image-square', type: 'image', ratio: '1024×1024 (square)', template: imageOnly(100, 100), azureSize: '1024x1024' },
  { id: 'image-landscape', type: 'image', ratio: '1536×1024 (3:2)', template: imageOnly(150, 100), azureSize: '1536x1024' },
  { id: 'image-portrait', type: 'image', ratio: '1024×1536 (2:3)', template: imageOnly(100, 150), azureSize: '1024x1536' },
];

/** JSON with recursively sorted keys, so localStorage round-trips compare structurally. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The preset id the template currently equals, or CUSTOM_PRESET_ID when it matches none. */
export function matchPreset(template: TileTemplate): string {
  const key = stable(template);
  return TILE_PRESETS.find((p) => stable(p.template) === key)?.id ?? CUSTOM_PRESET_ID;
}
