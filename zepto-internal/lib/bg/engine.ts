// Background-removal engine. Port of the bg-remover prototype's inline script
// (bg-remover/static/index.html) into a reusable module.
//
// Inference runs in the BROWSER via transformers.js + onnxruntime-web, against ONNX weights
// served from /models and WASM binaries from /vendor (both populated by scripts/setup-bg-assets.mjs).
// Nothing here may run on the server: the library is imported dynamically so it never enters a
// server bundle, and every entry point touches canvas/DOM APIs.

import type { PreTrainedModel, Processor, RawImage, Tensor } from '@huggingface/transformers';

import { refineAlpha, type RefineMode } from './refine';
import { analyzeRegions, keepProductRegions, type RegionReport } from './regions';

export type BgModelId = 'rmbg2' | 'rmbg' | 'birefnet' | 'ben2' | 'modnet';

export interface BgModelSpec {
  id: BgModelId;
  label: string;
  description: string;
  /** Runs on the local Python sidecar rather than in the browser. */
  server?: boolean;
  /** HuggingFace-style repo path resolved under env.localModelPath. */
  path?: string;
  /** The ONNX graph's input tensor name — differs per export. */
  inputName?: string;
  /** Some exports emit logits rather than a 0..1 matte. */
  applySigmoid?: boolean;
  approxSizeMb?: number;
  options?: Record<string, unknown>;
  processorOptions?: Record<string, unknown>;
}

// Ordered best-first; this is the order the model picker renders.
export const BG_MODELS: Record<BgModelId, BgModelSpec> = {
  // Runs on the local Python sidecar (bg-remover/hq_server.py) — the strongest model
  // available, too heavy for the browser runtime.
  rmbg2: {
    id: 'rmbg2',
    label: 'RMBG-2.0',
    description: 'Best quality — needs the local server running',
    server: true,
  },
  rmbg: {
    id: 'rmbg',
    label: 'RMBG-1.4',
    description: 'Balanced quality, runs in your browser',
    path: 'briaai/RMBG-1.4',
    inputName: 'input',
    applySigmoid: false,
    // fp16 halves both the download and the GPU memory traffic versus the fp32 export, and
    // Apple silicon runs fp16 natively — roughly 40% off inference for a matte that is
    // indistinguishable at 8-bit alpha. dtype picks the filename: model_fp16.onnx.
    approxSizeMb: 84,
    options: { config: { model_type: 'custom' }, dtype: 'fp16' },
    // RMBG-1.4's published preprocessor_config is incomplete, so the full config is
    // supplied inline. Do not delete: without it the processor picks wrong normalisation
    // and the matte comes out inverted-ish.
    processorOptions: {
      config: {
        do_normalize: true,
        do_pad: false,
        do_rescale: true,
        do_resize: true,
        image_mean: [0.5, 0.5, 0.5],
        image_std: [1, 1, 1],
        feature_extractor_type: 'ImageFeatureExtractor',
        resample: 2,
        rescale_factor: 0.00392156862745098,
        size: { width: 1024, height: 1024 },
      },
    },
  },
  // Static 512x512 export — the dynamic-shape BiRefNet exports crash onnxruntime-web
  // (WebGPU shader-variable limit, std::bad_alloc on WASM), so this is the one that runs.
  birefnet: {
    id: 'birefnet',
    label: 'BiRefNet',
    description: 'Sharp edges, heaviest download',
    path: 'onnx-community/BiRefNet_512x512-ONNX',
    inputName: 'input_image',
    applySigmoid: true,
    approxSizeMb: 452,
    options: { dtype: 'fp16' },
    processorOptions: {},
  },
  // Processes at full 1024x1024 and outputs a ready alpha matte.
  ben2: {
    id: 'ben2',
    label: 'BEN2',
    description: 'Strong on complex subjects',
    path: 'onnx-community/BEN2-ONNX',
    inputName: 'pixel_values',
    applySigmoid: false,
    approxSizeMb: 209,
    options: { dtype: 'fp16' },
    processorOptions: {},
  },
  // Trained specifically for human/portrait matting — tiny and fast.
  modnet: {
    id: 'modnet',
    label: 'MODNet',
    description: 'Fastest — tuned for people',
    path: 'Xenova/modnet',
    inputName: 'input',
    applySigmoid: false,
    approxSizeMb: 12,
    options: { dtype: 'fp16' },
    processorOptions: {},
  },
};

export const BG_MODEL_ORDER: BgModelId[] = ['rmbg2', 'rmbg', 'birefnet', 'ben2', 'modnet'];

// The sidecar is opt-in infrastructure, so the default is a model that always works.
export const DEFAULT_MODEL_ID: BgModelId = 'rmbg';

export interface LoadProgress {
  /** 0..1, or null while the total size is still unknown. */
  ratio: number | null;
  loadedMb: number;
  totalMb: number;
  label: string;
}

export interface RemoveOptions {
  model?: BgModelId;
  /** Classical-CV edge cleanup after the matte. Slower, much better on hair/fur. */
  refine?: boolean;
  /** Forces the refinement strategy; 'auto' picks per subject. */
  refineMode?: RefineMode;
  /** Second inference pass on a tight crop, fused into uncertain regions. */
  zoomPass?: boolean;
  /** Drop flat graphic panels the matte kept (colour strips, badges). Opt-in. */
  productOnly?: boolean;
  onLoadProgress?: (p: LoadProgress) => void;
  onStage?: (stage: RemoveStage) => void;
  signal?: AbortSignal;
}

export type RemoveStage = 'loading' | 'inferring' | 'zooming' | 'refining' | 'done';

/** Where a model's inference actually runs: GPU (WebGPU), CPU (threaded WASM), or the sidecar. */
export type BgBackend = 'webgpu' | 'wasm' | 'server';

export interface RemoveResult {
  canvas: HTMLCanvasElement;
  pixels: ImageData;
  width: number;
  height: number;
  durationMs: number;
  model: BgModelId;
  backend: BgBackend;
  /** Graphic regions the product-only filter dropped; 0 when off or nothing matched. */
  removedRegions: number;
  /** Per-region measurements behind that decision. */
  regionReport: RegionReport[];
}

export type BgSource = Blob | HTMLImageElement | HTMLCanvasElement | ImageBitmap;

interface LoadedModel {
  spec: BgModelSpec;
  model?: PreTrainedModel;
  processor?: Processor;
  backend: BgBackend;
}

type TransformersModule = typeof import('@huggingface/transformers');

let libPromise: Promise<TransformersModule> | null = null;

/**
 * Loads transformers.js once and points it at the locally served assets. Dynamic so the
 * library never lands in a server bundle.
 */
function loadLib(): Promise<TransformersModule> {
  if (libPromise) return libPromise;
  libPromise = import('@huggingface/transformers').then((lib) => {
    // Everything is served from this origin — no CDN, no HuggingFace at runtime.
    lib.env.allowRemoteModels = false;
    lib.env.allowLocalModels = true;
    lib.env.localModelPath = '/models/';
    if (lib.env.backends?.onnx?.wasm) {
      lib.env.backends.onnx.wasm.wasmPaths = '/vendor/';
    }
    return lib;
  });
  libPromise.catch(() => {
    libPromise = null;
  });
  return libPromise;
}

const cache = new Map<BgModelId, Promise<LoadedModel>>();
const backends = new Map<BgModelId, BgBackend>();

/** True when the model is already resident, so callers can skip a "downloading…" state. */
export function isModelLoaded(id: BgModelId): boolean {
  return BG_MODELS[id]?.server === true || cache.has(id);
}

/** The backend a model actually loaded on — null until its first load resolves. */
export function getModelBackend(id: BgModelId): BgBackend | null {
  if (BG_MODELS[id]?.server) return 'server';
  return backends.get(id) ?? null;
}

export function loadModel(id: BgModelId, onProgress?: RemoveOptions['onLoadProgress']): Promise<LoadedModel> {
  const cached = cache.get(id);
  if (cached) return cached;

  const spec = BG_MODELS[id];
  if (!spec) return Promise.reject(new Error(`Unknown model "${id}"`));
  if (spec.server) return Promise.resolve({ spec, backend: 'server' as const });

  const promise = (async (): Promise<LoadedModel> => {
    const { AutoModel, AutoProcessor } = await loadLib();
    const progress_callback = (p: { status?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.total) {
        onProgress?.({
          ratio: p.loaded! / p.total,
          loadedMb: p.loaded! / 1048576,
          totalMb: p.total / 1048576,
          label: spec.label,
        });
      }
    };

    let model: PreTrainedModel;
    let backend: BgBackend;
    try {
      model = await AutoModel.from_pretrained(spec.path!, {
        ...spec.options,
        device: 'webgpu',
        progress_callback,
      });
      backend = 'webgpu';
    } catch (e) {
      // Not every browser/GPU combination supports the WebGPU backend; the threaded WASM
      // backend is the universal fallback (and why the app is cross-origin isolated).
      console.warn(`${spec.label}: WebGPU unavailable, falling back to WASM`, e);
      model = await AutoModel.from_pretrained(spec.path!, {
        ...spec.options,
        progress_callback,
      });
      backend = 'wasm';
    }
    backends.set(id, backend);
    const processor = await AutoProcessor.from_pretrained(spec.path!, spec.processorOptions ?? {});
    return { spec, model, processor, backend };
  })();

  // A failed load must not poison the cache — the user may just need to run setup.
  promise.catch(() => cache.delete(id));
  cache.set(id, promise);
  return promise;
}

/** Pre-loads a model so the first image is fast. Errors are the caller's to surface. */
export function warmModel(id: BgModelId, onProgress?: RemoveOptions['onLoadProgress']): Promise<unknown> {
  return loadModel(id, onProgress);
}

/** Whether the optional RMBG-2.0 Python sidecar is reachable. */
export async function probeServerModel(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch('/api/remove-hq', { method: 'GET', signal });
    return res.ok;
  } catch {
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/** Normalises any accepted source into a canvas we own and can read pixels from. */
async function toCanvas(source: BgSource): Promise<HTMLCanvasElement> {
  if (source instanceof HTMLCanvasElement) return source;

  let width: number;
  let height: number;
  let drawable: CanvasImageSource;

  if (source instanceof Blob) {
    const bitmap = await createImageBitmap(source);
    drawable = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } else if (source instanceof HTMLImageElement) {
    if (!source.complete) {
      await source.decode().catch(() => undefined);
    }
    drawable = source;
    width = source.naturalWidth || source.width;
    height = source.naturalHeight || source.height;
  } else {
    drawable = source;
    width = source.width;
    height = source.height;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(drawable, 0, 0);
  if (source instanceof ImageBitmap || source instanceof Blob) {
    (drawable as ImageBitmap).close?.();
  }
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), type);
  });
}

/**
 * Removes the background from a single image.
 *
 * Mirrors the prototype's two-pass strategy: a full-image matte, then an optional second
 * inference on a tight crop of the subject fused into the regions pass 1 was unsure about
 * (~2x effective edge resolution).
 */
export async function removeBackground(source: BgSource, opts: RemoveOptions = {}): Promise<RemoveResult> {
  const id = opts.model ?? DEFAULT_MODEL_ID;
  const { refine = false, refineMode = 'auto', zoomPass = true, productOnly = false, signal } = opts;
  const started = performance.now();

  throwIfAborted(signal);
  opts.onStage?.('loading');
  const { spec, model, processor, backend } = await loadModel(id, opts.onLoadProgress);
  throwIfAborted(signal);

  const sourceCanvas = await toCanvas(source);
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  if (!width || !height) throw new Error('Image has no dimensions');

  opts.onStage?.('inferring');

  // ---- Server model: post the encoded image, get a finished RGBA PNG back. ----
  if (spec.server) {
    const blob = await canvasToBlob(sourceCanvas);
    const res = await fetch('/api/remove-hq', { method: 'POST', body: blob, signal });
    if (!res.ok) {
      throw new Error((await res.text()) || `Background server error ${res.status}`);
    }
    const outBlob = await res.blob();
    const outCanvas = await toCanvas(outBlob);
    const ctx = outCanvas.getContext('2d')!;
    const pixels = ctx.getImageData(0, 0, outCanvas.width, outCanvas.height);
    if (refine) {
      throwIfAborted(signal);
      opts.onStage?.('refining');
      refineAlpha(pixels, outCanvas.width, outCanvas.height, { modelId: id, mode: refineMode });
    }
    // After refinement, before anything reads the matte: dropping a panel must shrink the
    // bounds too, or tile fit keeps reserving room for something that is no longer there.
    const filtered = productOnly ? keepProductRegions(pixels) : null;
    const removedRegions = filtered?.removed ?? 0;
    const regionReport = filtered ? filtered.regions : analyzeRegions(pixels);
    if (refine || removedRegions) ctx.putImageData(pixels, 0, 0);
    opts.onStage?.('done');
    return {
      canvas: outCanvas,
      pixels,
      width: outCanvas.width,
      height: outCanvas.height,
      durationMs: performance.now() - started,
      model: id,
      backend,
      removedRegions,
      regionReport,
    };
  }

  // ---- In-browser inference. ----
  const { RawImage } = await loadLib();
  // fromCanvas reads the pixels directly — encoding to a PNG blob and decoding it again
  // costs hundreds of milliseconds of pure CPU on a large image and produces identical data.
  const image = RawImage.fromCanvas(sourceCanvas);

  const infer = async (img: RawImage, w: number, h: number): Promise<RawImage> => {
    const { pixel_values } = await processor!(img);
    const result = await model!({ [spec.inputName!]: pixel_values });
    // Tensors expose numeric indexing through a Proxy the published types do not model;
    // _getitem is the same operation with a declared signature.
    let matte = (Object.values(result) as Tensor[])[0]._getitem(0);
    if (spec.applySigmoid) matte = matte.sigmoid();
    return await RawImage.fromTensor(matte.mul(255).to('uint8')).resize(w, h);
  };

  const mask = await infer(image, width, height);
  throwIfAborted(signal);

  if (zoomPass) {
    opts.onStage?.('zooming');
    try {
      let x0 = width;
      let x1 = 0;
      let y0 = height;
      let y1 = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (mask.data[y * width + x] > 128) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      const bw = x1 - x0;
      const bh = y1 - y0;
      // Only zoom when it meaningfully increases resolution.
      if (bw > 40 && bh > 40 && (bw < width * 0.9 || bh < height * 0.9)) {
        const pad = Math.round(Math.max(bw, bh) * 0.08);
        x0 = Math.max(0, x0 - pad);
        y0 = Math.max(0, y0 - pad);
        x1 = Math.min(width - 1, x1 + pad);
        y1 = Math.min(height - 1, y1 + pad);
        const cw = x1 - x0 + 1;
        const ch = y1 - y0 + 1;
        const crop = document.createElement('canvas');
        crop.width = cw;
        crop.height = ch;
        crop.getContext('2d')!.drawImage(sourceCanvas, x0, y0, cw, ch, 0, 0, cw, ch);
        const cropImg = RawImage.fromCanvas(crop);
        const mask2 = await infer(cropImg, cw, ch);
        // Fuse: the zoom pass only refines where pass 1 was uncertain. Where pass 1 is
        // confident (near 0 or 255) its decision stands — the cropped view can misjudge
        // large context (e.g. thin frames).
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            const i = (y0 + y) * width + (x0 + x);
            const a1 = mask.data[i];
            if (a1 > 30 && a1 < 225) {
              mask.data[i] = (a1 + mask2.data[y * cw + x]) >> 1;
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      console.warn('zoom pass skipped:', e);
    }
  }
  throwIfAborted(signal);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(sourceCanvas, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < mask.data.length; i++) {
    pixels.data[4 * i + 3] = mask.data[i];
  }

  if (refine) {
    opts.onStage?.('refining');
    // Yield once so a pending status paint lands before this blocks the main thread.
    await new Promise((r) => setTimeout(r, 0));
    throwIfAborted(signal);
    refineAlpha(pixels, width, height, { modelId: id, mode: refineMode });
  }
  const browserFiltered = productOnly ? keepProductRegions(pixels) : null;
  const removedRegions = browserFiltered?.removed ?? 0;
  const regionReport = browserFiltered ? browserFiltered.regions : analyzeRegions(pixels);
  ctx.putImageData(pixels, 0, 0);

  opts.onStage?.('done');
  return {
    canvas,
    pixels,
    width,
    height,
    durationMs: performance.now() - started,
    model: id,
    backend,
    removedRegions,
    regionReport,
  };
}
