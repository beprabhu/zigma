import type { CsvRecord } from './csv';

export type ItemStatus = 'ready' | 'no-images' | 'fetching' | 'generating' | 'removing-bg' | 'done' | 'error';

export interface QueueItem {
  id: number;
  record: CsvRecord;
  urls: string[];
  title: string;
  offer: string;
  status: ItemStatus;
  errorMsg?: string;
  resultImage: HTMLImageElement | null;
  compressed: { data: Uint8Array; inputSize: number } | null;
  /**
   * One-slot undo: the tile the last regenerate replaced. Only set when there WAS a previous
   * result; overwritten by the next regenerate, cleared by undo.
   */
  prev?: { resultImage: HTMLImageElement };
}

export interface Keys {
  azureEndpoint: string;
  azureKey: string;
  tinyKey: string;
}

export const DEFAULT_ENDPOINT = 'https://kernel-krew-east-us-resource.services.ai.azure.com/openai/v1/images/edits';

export const DEFAULT_PROMPT = `Combine the two input product images into a single clean e-commerce image with a pure white background. Preserve the original proportions, aspect ratio, and appearance of both products. Do not stretch, squash, warp, or distort either product. Maximize the displayed size of both products while keeping them fully visible. Treat the bottom of the image as a flat shelf, with the lowest visible point of each product resting on the same horizontal line. This shared baseline is the highest-priority layout constraint and must not be broken for centering or spacing. Arrange the products to make the best use of the available space. When necessary, intelligently overlap the products in the most natural and visually balanced way, prioritizing larger product size while keeping the primary branding and product identity of both products clearly visible. Choose the amount and direction of overlap based on the shapes of the products rather than using a fixed amount. Center the overall composition horizontally. Maintain comfortable whitespace around the left, right, and top edges so the composition does not appear cramped. Do not crop either product and do not add any extra elements.`;
