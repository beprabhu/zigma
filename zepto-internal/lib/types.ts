import type { CsvRecord } from './csv';

export type ItemStatus = 'ready' | 'no-images' | 'fetching' | 'generating' | 'removing-bg' | 'done' | 'error';

export interface QueueItem {
  /**
   * Unique across the whole run, not a sheet index: in Banner grid mode several CSVs share one
   * queue, so ids come from a counter. `row` is what a person is shown.
   */
  id: number;
  /** 1-based position in the CSV this item came from — the "Row 3" every message names. */
  row: number;
  /** Which banner-grid band owns this row; absent outside Banner grid mode. */
  bandId?: string;
  record: CsvRecord;
  urls: string[];
  /**
   * Locally dropped images, for a run started from files or a folder instead of a sheet — the
   * alternative to `urls`, never a supplement to it: a row comes from a sheet or from disk.
   *
   * The blob URL is minted ONCE, when the row is built, and is what both the preview and the
   * generate pass load — so a cell re-rendering never churns object URLs. It is released by
   * releaseLocalSources() when the row goes away; dropping the row without that call leaks the
   * image for the life of the tab.
   *
   * The bytes are NOT persisted, and deliberately so: a folder drop can be gigabytes of product
   * shots the user still has on disk, and the store is shared with three other tools. What is
   * persisted is the composed TILE, which cost the work — so a restored image-mode row can be
   * exported but not re-composed until the folder is dropped again. `url` is empty on such a
   * restored row, since there is nothing behind it to point at.
   */
  localSources?: { name: string; url: string }[];
  title: string;
  offer: string;
  status: ItemStatus;
  errorMsg?: string;
  resultImage: HTMLImageElement | null;
  /**
   * The tile's compressed export bytes, with a fingerprint of the settings they were made under.
   *
   * The fingerprint is what makes the cache safe to reuse. These bytes are a rendered picture, not
   * just a smaller copy of one — export scale, the template, the fallback title and offer text and
   * the offer toggle all change what is drawn — and the invalidation sites only ever covered a
   * template or row-text edit. Everything else silently shipped stale pixels: a 1x cache going out
   * as a 3x export, an offer bar that had since been switched off, or bytes a previous budgeted run
   * had already shrunk. A hit now has to match the settings as well as the row.
   */
  compressed: { data: Uint8Array; inputSize: number; fingerprint: string } | null;
  /**
   * One-slot undo: the tile the last regenerate replaced. Only set when there WAS a previous
   * result; overwritten by the next regenerate, cleared by undo.
   */
  prev?: { resultImage: HTMLImageElement };
}

/**
 * One row of a Banner grid — the "row item" in Compose's left panel and the drop area it owns
 * in the canvas. A band is a wrapper around banner tiles: it picks ONE banner-tile preset, one
 * CSV, and how many of that sheet's rows to draw, in how many columns.
 *
 * The tiles themselves live in the flat queue (QueueItem.bandId), not here, so every existing
 * batch mechanism — patching, selection, the compare dialog, stop, export — keeps working
 * unchanged whether there is one band or six.
 */
export interface GridBand {
  id: string;
  /** A banner-tile preset id; see BAND_PRESETS in lib/tile-presets.ts. */
  presetId: string;
  /** How many of the sheet's rows to draw, capped at records.length. */
  count: number;
  /** Tiles per row in this band's grid. */
  columns: number;
  fileName: string | null;
  headers: string[];
  records: CsvRecord[];
  imageCols: string[];
  /** Columns joined into the tile's title, in CSV order. Empty = no title drawn. */
  titleCols: string[];
  offerCol: string;
}

export interface Keys {
  azureEndpoint: string;
  azureKey: string;
  tinyKey: string;
}

export const DEFAULT_ENDPOINT = 'https://kernel-krew-east-us-resource.services.ai.azure.com/openai/v1/images/edits';

export const DEFAULT_PROMPT = `Combine the two input product images into a single clean e-commerce image with a pure white background. Preserve the original proportions, aspect ratio, and appearance of both products. Do not stretch, squash, warp, or distort either product. Maximize the displayed size of both products while keeping them fully visible. Treat the bottom of the image as a flat shelf, with the lowest visible point of each product resting on the same horizontal line. This shared baseline is the highest-priority layout constraint and must not be broken for centering or spacing. Arrange the products to make the best use of the available space. When necessary, intelligently overlap the products in the most natural and visually balanced way, prioritizing larger product size while keeping the primary branding and product identity of both products clearly visible. Choose the amount and direction of overlap based on the shapes of the products rather than using a fixed amount. Center the overall composition horizontally. Maintain comfortable whitespace around the left, right, and top edges so the composition does not appear cramped. Do not crop either product and do not add any extra elements.`;
