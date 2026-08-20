// Background-removal engine. Port of the bg-remover prototype's inline script
// (bg-remover/static/index.html) into a reusable module.
//
// Inference runs in the BROWSER via transformers.js + onnxruntime-web, against ONNX weights
// served from /models and WASM binaries from /vendor (both populated by scripts/setup-bg-assets.mjs).
// Nothing here may run on the server: the library is imported dynamically so it never enters a
// server bundle, and every entry point touches canvas/DOM APIs.

import type { PreTrainedModel, Processor, RawImage, Tensor } from '@huggingface/transformers';

import { refineAlpha, type RefineMode } from './refine';
import { recoverTransparency, type GlassReport } from './glass';
import {
  analyzeRegions, keepProductRegions, labelInkComponents, measureComponentSurvival,
  measureInkFootprint, type InkFootprint, type OriginalComponentReport, type RegionReport,
} from './regions';
import { PAD_FRACTION } from './constants';
import { subjectBounds } from './safe-area';

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
    description: 'Balanced quality, no server needed',
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
  /** Drop flat graphic panels the matte kept (colour strips, badges). Opt-in. */
  productOnly?: boolean;
  /**
   * Rebuild see-through areas a binary matte cut — clear cases, glass, blister packs.
   * Opt-in, and only meaningful on a near-uniform studio background. See glass.ts.
   */
  glass?: boolean;
  onLoadProgress?: (p: LoadProgress) => void;
  onStage?: (stage: RemoveStage) => void;
  signal?: AbortSignal;
}

export type RemoveStage = 'loading' | 'inferring' | 'refining' | 'done';

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
  /** The original's content footprint, from before the matte — see regions.measureInkFootprint. */
  originalInk: InkFootprint;
  /** Per-element survival of the original's ink islands against the PRE-filter matte. */
  originalComponents: OriginalComponentReport[];
  /** Outcome of the transparency pass; null when it was off. */
  glass: GlassReport | null;
}

export type BgSource = Blob | HTMLImageElement | HTMLCanvasElement | ImageBitmap;

/**
 * Edge cap for the main-thread survival measurement. The worker measures at the pooled
 * MAX_EDGE cap off the main thread; the two engine paths run UNCAPPED on the main thread,
 * where a 4000px original would cost a ~64 MB label map and a visible jank. Survival and area
 * are fractions — scale-robust — so the measurement runs at a bounded edge and only the bounds
 * are mapped back to the full-resolution space everything else reports in.
 */
const COMPONENT_MEASURE_EDGE = 1024;

/** ImageData downscaled by `scale` (1 = the data itself, untouched). */
function scaleImageData(pixels: ImageData, scale: number): ImageData {
  if (scale >= 1) return pixels;
  const src = document.createElement('canvas');
  src.width = pixels.width;
  src.height = pixels.height;
  src.getContext('2d')!.putImageData(pixels, 0, 0);
  const w = Math.max(1, Math.round(pixels.width * scale));
  const h = Math.max(1, Math.round(pixels.height * scale));
  const dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  const c2d = dst.getContext('2d')!;
  c2d.imageSmoothingEnabled = true;
  c2d.drawImage(src, 0, 0, w, h);
  return c2d.getImageData(0, 0, w, h);
}

/** Component bounds mapped from the measurement space back to full resolution. */
function unscaleComponents(
  reports: OriginalComponentReport[],
  scale: number,
): OriginalComponentReport[] {
  if (scale >= 1) return reports;
  const f = 1 / scale;
  return reports.map((r) => ({
    ...r,
    bounds: {
      x: Math.round(r.bounds.x * f),
      y: Math.round(r.bounds.y * f),
      w: Math.round(r.bounds.w * f),
      h: Math.round(r.bounds.h * f),
    },
  }));
}

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
  const c2d = canvas.getContext('2d')!;
  // Same reason as the worker's drawToCanvas: a fresh canvas is transparent BLACK and the
  // model is handed RGB with alpha dropped, so a transparent PNG would be inferred as a
  // product on a black field and any baked semi-transparent shadow as solid black.
  c2d.fillStyle = '#fff';
  c2d.fillRect(0, 0, width, height);
  c2d.drawImage(drawable, 0, 0);
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
  const {
    refine = false, refineMode = 'auto', productOnly = false,
    glass = false, signal,
  } = opts;
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
    // Measured from the SOURCE: the server hands back an already-matted RGBA, and by then the
    // question "what did the original cover?" is unanswerable from anything it returns.
    const sourcePixels = sourceCanvas.getContext('2d')!.getImageData(0, 0, width, height);
    const originalInk = measureInkFootprint(sourcePixels);
    const measureScale = Math.min(1, COMPONENT_MEASURE_EDGE / Math.max(width, height));
    const inkMap = labelInkComponents(scaleImageData(sourcePixels, measureScale));
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
    // After refine (its decontaminate would repaint recovered glass with its solid
    // neighbours' colour), before the region pass reads the matte.
    const glassReport = glass ? recoverTransparency(pixels) : null;
    // Pre-filter, like the worker: what the SERVER MODEL erased, before deliberate panel
    // drops muddy the question. Guarded on dimensions — the sidecar may return a resized
    // frame, and survival against a mismatched label map would be garbage, not evidence.
    const originalComponents =
      outCanvas.width === width && outCanvas.height === height
        ? unscaleComponents(
            measureComponentSurvival(inkMap, scaleImageData(pixels, measureScale)),
            measureScale,
          )
        : [];
    // After refinement, before anything reads the matte: dropping a panel must shrink the
    // bounds too, or tile fit keeps reserving room for something that is no longer there.
    const filtered = productOnly ? keepProductRegions(pixels) : null;
    const removedRegions = filtered?.removed ?? 0;
    const regionReport = filtered ? filtered.regions : analyzeRegions(pixels);
    if (refine || removedRegions || glassReport?.applied) ctx.putImageData(pixels, 0, 0);
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
      originalInk,
      originalComponents,
      glass: glassReport,
    };
  }

  // ---- In-browser inference. ----
  const { RawImage } = await loadLib();
  const baseCanvas = sourceCanvas;
  const outW = width;
  const outH = height;
  // Read once, before anything touches the buffer — the footprint the quality checks remember
  // the original by, and the pristine RGB every attempt below starts from.
  const basePixels = baseCanvas.getContext('2d')!.getImageData(0, 0, outW, outH);
  const originalInk = measureInkFootprint(basePixels);
  // Labelled once from the pristine original; every attempt below measures against this map.
  // Downscaled: this path runs uncapped on the main thread (see COMPONENT_MEASURE_EDGE).
  const measureScale = Math.min(1, COMPONENT_MEASURE_EDGE / Math.max(outW, outH));
  const inkMap = labelInkComponents(scaleImageData(basePixels, measureScale));

  const infer = async (img: RawImage, w: number, h: number): Promise<RawImage> => {
    const { pixel_values } = await processor!(img);
    const result = await model!({ [spec.inputName!]: pixel_values });
    // Tensors expose numeric indexing through a Proxy the published types do not model;
    // _getitem is the same operation with a declared signature.
    let matte = (Object.values(result) as Tensor[])[0]._getitem(0);
    if (spec.applySigmoid) matte = matte.sigmoid();
    return await RawImage.fromTensor(matte.mul(255).to('uint8')).resize(w, h);
  };

  interface MatteAttempt {
    pixels: ImageData;
    removedRegions: number;
    regionReport: RegionReport[];
    originalComponents: OriginalComponentReport[];
    glass: GlassReport | null;
  }

  /**
   * One full matte at a given pad — same contract as the worker's: the padded canvas never
   * leaves this closure, and everything returned lives in the original's coordinates.
   */
  const attempt = async (pad: number): Promise<MatteAttempt> => {
    let inferCanvas = baseCanvas;
    if (pad) {
      const padded = document.createElement('canvas');
      padded.width = outW + pad * 2;
      padded.height = outH + pad * 2;
      const p2d = padded.getContext('2d')!;
      p2d.fillStyle = '#fff';
      p2d.fillRect(0, 0, padded.width, padded.height);
      p2d.drawImage(baseCanvas, pad, pad);
      inferCanvas = padded;
    }
    const iw = inferCanvas.width;
    const ih = inferCanvas.height;
    // fromCanvas reads the pixels directly — encoding to a PNG blob and decoding it again
    // costs hundreds of milliseconds of pure CPU on a large image and produces identical data.
    const image = RawImage.fromCanvas(inferCanvas);

    const mask = await infer(image, iw, ih);
    throwIfAborted(signal);

    throwIfAborted(signal);

    // A fresh pristine copy per attempt: the alpha write mutates it, and a retry must start
    // from the original RGB, not the previous attempt's leavings.
    const pixels = new ImageData(new Uint8ClampedArray(basePixels.data), outW, outH);
    for (let y = 0; y < outH; y++) {
      const maskRow = (y + pad) * iw + pad;
      const pixelRow = y * outW;
      for (let x = 0; x < outW; x++) {
        pixels.data[4 * (pixelRow + x) + 3] = mask.data[maskRow + x];
      }
    }

    if (refine) {
      opts.onStage?.('refining');
      // Yield once so a pending status paint lands before this blocks the main thread.
      await new Promise((r) => setTimeout(r, 0));
      throwIfAborted(signal);
      refineAlpha(pixels, outW, outH, { modelId: id, mode: refineMode });
    }
    // After refine, before the region pass — same ordering constraint as the worker's.
    const glassReport = glass ? recoverTransparency(pixels) : null;
    // Post-refine, pre-filter — same contract as the worker: only model-erased content may
    // read as a lost element, never a deliberate panel drop.
    const originalComponents = unscaleComponents(
      measureComponentSurvival(inkMap, scaleImageData(pixels, measureScale)),
      measureScale,
    );
    const browserFiltered = productOnly ? keepProductRegions(pixels) : null;
    return {
      pixels,
      removedRegions: browserFiltered?.removed ?? 0,
      regionReport: browserFiltered ? browserFiltered.regions : analyzeRegions(pixels),
      originalComponents,
      glass: glassReport,
    };
  };

  /**
   * The two failure shapes a padded retry can rescue, judged SEPARATELY because a rescue can
   * legitimately resemble the other failure: a shredded full-bleed packet, correctly re-matted,
   * comes back as one region covering nearly the whole frame — exactly the shape of a
   * whole-frame keep. A retry therefore only has to stop exhibiting the failure that sent it
   * back, not look pristine by every measure. (And padding is a RETRY, never a first move: an
   * upfront ink-based trigger made the model outline entire colored-background shots as one
   * object — a user caught that regression within the hour.)
   */
  const looksWholeFrame = (a: MatteAttempt): boolean => {
    const b = subjectBounds(a.pixels);
    if (!b) return true;
    const bboxFraction = (b.w * b.h) / (outW * outH);
    const kept = a.regionReport.filter((r) => !r.removed);
    return bboxFraction > 0.97 && a.removedRegions === 0 && kept.length <= 1;
  };
  const looksShredded = (a: MatteAttempt): boolean => {
    const canvasArea = outW * outH;
    if (!subjectBounds(a.pixels)) return true;
    const kept = a.regionReport.filter((r) => !r.removed);
    const substantial = kept.filter((r) => r.area / canvasArea >= 0.01);
    const anchor = kept.reduce<RegionReport | null>(
      (max, r) => (!max || r.area > max.area ? r : max),
      null,
    );
    const total = kept.reduce((sum, r) => sum + r.area, 0);
    const dominance = anchor && total ? anchor.area / total : 1;
    return substantial.length >= 3 && dominance < 0.6;
  };

  let result = await attempt(0);
  const shredded = looksShredded(result);
  if (shredded || looksWholeFrame(result)) {
    throwIfAborted(signal);
    opts.onStage?.('inferring');
    const retry = await attempt(Math.round(Math.max(outW, outH) * PAD_FRACTION));
    const cured = shredded
      ? !looksShredded(retry)
      : !looksWholeFrame(retry) && !looksShredded(retry);
    if (cured) result = retry;
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(result.pixels, 0, 0);

  opts.onStage?.('done');
  return {
    canvas,
    pixels: result.pixels,
    originalInk,
    width: outW,
    height: outH,
    durationMs: performance.now() - started,
    model: id,
    backend,
    removedRegions: result.removedRegions,
    regionReport: result.regionReport,
    originalComponents: result.originalComponents,
    glass: result.glass,
  };
}

