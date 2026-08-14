/// <reference lib="webworker" />
// Background-removal worker. Owns its own model instance and runs the whole per-image pipeline
// — preprocess, inference, matte application, optional edge refinement — off the main thread.
//
// Why a pool of these rather than one: inference is ~30% of an image's cost and the rest is
// single-threaded CPU work. With two workers the CPU stages of one image overlap the GPU stage
// of another, which is what lifts GPU utilisation instead of leaving it idle between images.

import type { PreTrainedModel, Processor, RawImage, Tensor } from '@huggingface/transformers';

import { BG_MODELS, type BgBackend, type BgModelId } from './engine';
import { refineAlpha, type RefineMode } from './refine';
import { detectBands, maskBands, type DetectedBand } from './bands';
import {
  analyzeRegions, keepProductRegions, labelInkComponents, measureComponentSurvival,
  measureFaintResidue, measureInkFootprint,
  type InkFootprint, type OriginalComponentReport, type RegionReport,
} from './regions';
import { subjectBounds, type SubjectBounds } from './safe-area';
import { MAX_EDGE, PAD_FRACTION, STORE_TYPE } from './constants';

export interface WorkerInitRequest {
  type: 'init';
  jobId: number;
  modelId: BgModelId;
}

export interface WorkerRemoveRequest {
  type: 'remove';
  jobId: number;
  modelId: BgModelId;
  bitmap: ImageBitmap;
  refine: boolean;
  refineMode: RefineMode;
  zoomPass: boolean;
  /** Drop flat graphic panels the matte kept (colour strips, badges). Opt-in. */
  productOnly?: boolean;
  /** Overrides MAX_EDGE; 0 or undefined means "no cap". */
  maxEdge?: number;
}

export type WorkerRequest = WorkerInitRequest | WorkerRemoveRequest;

export type WorkerResponse =
  | { type: 'ready'; jobId: number; backend: BgBackend }
  | { type: 'progress'; jobId: number; loaded: number; total: number; label: string }
  | { type: 'stage'; jobId: number; stage: 'loading' | 'inferring' | 'zooming' | 'refining' }
  | {
      type: 'done';
      jobId: number;
      /** Full-resolution (post-cap) lossless WebP — the master everything else derives from. */
      blob: Blob;
      /** Subject bbox in full-resolution pixels, scanned here to spare the main thread. */
      bounds: SubjectBounds | null;
      /** Graphic regions dropped by the product-only filter; 0 when it was off or found none. */
      removedRegions: number;
      /** Per-region measurements behind that decision — shown in the compare dialog. */
      regionReport: RegionReport[];
      /** Share of canvas covered by faint (sub-threshold) pixels outside the subject bbox. */
      residueFraction: number;
      /** What the ORIGINAL covered, measured before the matte was applied — the only side that
       *  still remembers objects the model deleted outright. */
      originalInk: InkFootprint;
      /** Per-element survival of the original's ink islands against the PRE-filter matte. */
      originalComponents: OriginalComponentReport[];
      /** Flat edge strips masked from the source before region analysis. */
      bands: DetectedBand[];
      width: number;
      height: number;
      durationMs: number;
      backend: BgBackend;
    }
  | { type: 'error'; jobId: number; message: string; name: string };

type TransformersModule = typeof import('@huggingface/transformers');

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let libPromise: Promise<TransformersModule> | null = null;

function loadLib(): Promise<TransformersModule> {
  if (libPromise) return libPromise;
  libPromise = import('@huggingface/transformers').then((lib) => {
    lib.env.allowRemoteModels = false;
    lib.env.allowLocalModels = true;
    // Absolute so it resolves against the origin, not this worker's chunk URL.
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

interface Loaded {
  model: PreTrainedModel;
  processor: Processor;
  backend: BgBackend;
}

const loaded = new Map<BgModelId, Promise<Loaded>>();

function load(modelId: BgModelId, jobId: number): Promise<Loaded> {
  const cached = loaded.get(modelId);
  if (cached) return cached;

  const spec = BG_MODELS[modelId];
  if (!spec || spec.server || !spec.path) {
    return Promise.reject(new Error(`Model "${modelId}" cannot run in a worker`));
  }

  const promise = (async (): Promise<Loaded> => {
    const { AutoModel, AutoProcessor } = await loadLib();
    const progress_callback = (p: { status?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.total) {
        ctx.postMessage({
          type: 'progress',
          jobId,
          loaded: p.loaded ?? 0,
          total: p.total,
          label: spec.label,
        } satisfies WorkerResponse);
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
      console.warn(`${spec.label}: WebGPU unavailable in worker, falling back to WASM`, e);
      model = await AutoModel.from_pretrained(spec.path!, { ...spec.options, progress_callback });
      backend = 'wasm';
    }
    const processor = await AutoProcessor.from_pretrained(spec.path!, spec.processorOptions ?? {});
    return { model, processor, backend };
  })();

  promise.catch(() => loaded.delete(modelId));
  loaded.set(modelId, promise);
  return promise;
}

/** Draws the source at up to maxEdge on its longest side. */
function drawToCanvas(bitmap: ImageBitmap, maxEdge: number): OffscreenCanvas {
  const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)) : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const c2d = canvas.getContext('2d');
  if (!c2d) throw new Error('OffscreenCanvas 2D context unavailable');
  c2d.imageSmoothingEnabled = true;
  c2d.imageSmoothingQuality = 'high';
  // Flatten onto WHITE before anything reads these pixels. A fresh canvas is transparent
  // BLACK, and the processor hands the model three channels with alpha dropped — so every
  // already-transparent PNG arrived at the model as a product floating on a black field, and
  // a soft drop shadow baked into the source as semi-transparent black (measured: RGB 0,0,0
  // at alpha 140) arrived as solid black. The model then keeps it, which is where the black
  // smear under a cutout came from. White is also what the rest of the pipeline assumes: the
  // padded-retry canvas below already fills white, and both ink measures treat near-white as
  // background, so a flattened shadow reads as the light grey it actually is.
  c2d.fillStyle = '#fff';
  c2d.fillRect(0, 0, width, height);
  c2d.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

async function remove(req: WorkerRemoveRequest): Promise<void> {
  const started = performance.now();
  const spec = BG_MODELS[req.modelId];

  ctx.postMessage({ type: 'stage', jobId: req.jobId, stage: 'loading' } satisfies WorkerResponse);
  const { model, processor, backend } = await load(req.modelId, req.jobId);

  ctx.postMessage({ type: 'stage', jobId: req.jobId, stage: 'inferring' } satisfies WorkerResponse);
  const { RawImage } = await loadLib();

  const baseCanvas = drawToCanvas(req.bitmap, req.maxEdge ?? MAX_EDGE);
  req.bitmap.close();
  const outW = baseCanvas.width;
  const outH = baseCanvas.height;
  const base2d = baseCanvas.getContext('2d')!;
  // Read once, before anything touches the buffer — the footprint the quality checks remember
  // the original by, and the pristine RGB every attempt below starts from.
  const basePixels = base2d.getImageData(0, 0, outW, outH);
  const originalInk = measureInkFootprint(basePixels);
  // Labelled once from the pristine original; every attempt below measures against this map.
  const inkMap = labelInkComponents(basePixels);

  const infer = async (img: RawImage, w: number, h: number): Promise<RawImage> => {
    const { pixel_values } = await processor(img);
    const result = await model({ [spec.inputName!]: pixel_values });
    let matte = (Object.values(result) as Tensor[])[0]._getitem(0);
    if (spec.applySigmoid) matte = matte.sigmoid();
    return await RawImage.fromTensor(matte.mul(255).to('uint8')).resize(w, h);
  };

  interface MatteAttempt {
    pixels: ImageData;
    bounds: SubjectBounds | null;
    removedRegions: number;
    regionReport: RegionReport[];
    bands: DetectedBand[];
    residueFraction: number;
    originalComponents: OriginalComponentReport[];
  }

  /**
   * One full matte at a given pad. `pad` widens the canvas with a synthetic white margin before
   * inference and reads the matte back through the offset, so the result — and every
   * measurement in it — stays in the original's coordinate space whatever the model saw. The
   * padded canvas never leaves this closure.
   */
  const attempt = async (pad: number): Promise<MatteAttempt> => {
    let sourceCanvas = baseCanvas;
    if (pad) {
      sourceCanvas = new OffscreenCanvas(outW + pad * 2, outH + pad * 2);
      const p2d = sourceCanvas.getContext('2d')!;
      p2d.fillStyle = '#fff';
      p2d.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      p2d.drawImage(baseCanvas, pad, pad);
    }
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const image = RawImage.fromCanvas(sourceCanvas);

    const mask = await infer(image, width, height);

    if (req.zoomPass) {
      ctx.postMessage({ type: 'stage', jobId: req.jobId, stage: 'zooming' } satisfies WorkerResponse);
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
        if (bw > 40 && bh > 40 && (bw < width * 0.9 || bh < height * 0.9)) {
          const zpad = Math.round(Math.max(bw, bh) * 0.08);
          x0 = Math.max(0, x0 - zpad);
          y0 = Math.max(0, y0 - zpad);
          x1 = Math.min(width - 1, x1 + zpad);
          y1 = Math.min(height - 1, y1 + zpad);
          const cw = x1 - x0 + 1;
          const ch = y1 - y0 + 1;
          const crop = new OffscreenCanvas(cw, ch);
          crop.getContext('2d')!.drawImage(sourceCanvas, x0, y0, cw, ch, 0, 0, cw, ch);
          const mask2 = await infer(RawImage.fromCanvas(crop), cw, ch);
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
        console.warn('zoom pass skipped:', e);
      }
    }

    // A fresh pristine copy per attempt: the alpha write below mutates it, and a retry has to
    // start from the original RGB, not the previous attempt's leavings.
    const pixels = new ImageData(new Uint8ClampedArray(basePixels.data), outW, outH);
    for (let y = 0; y < outH; y++) {
      const maskRow = (y + pad) * width + pad;
      const pixelRow = y * outW;
      for (let x = 0; x < outW; x++) {
        pixels.data[4 * (pixelRow + x) + 3] = mask.data[maskRow + x];
      }
    }

    if (req.refine) {
      ctx.postMessage({ type: 'stage', jobId: req.jobId, stage: 'refining' } satisfies WorkerResponse);
      refineAlpha(pixels, outW, outH, { modelId: req.modelId, mode: req.refineMode });
    }

    // Survival is measured HERE — post-refine, pre-filter — and nowhere later: the product-only
    // filter is about to delete panels on purpose, and those deletions are already evidenced in
    // the region report. Only what the MODEL erased should read as a lost element.
    const originalComponents = measureComponentSurvival(inkMap, pixels);

    // Runs after refinement, before the bbox: dropping a panel has to shrink the bounds too, or
    // tile fit keeps scaling the product down to leave room for something that is no longer there.
    let removedRegions = 0;
    let regionReport: RegionReport[] = [];
    let bands: DetectedBand[] = [];
    if (req.productOnly) {
      // Bands first: they work on source colours and take the whole strip — text, badges and all —
      // including the case the region pass structurally cannot reach, where the strip touches the
      // product and the two are a single connected region.
      bands = detectBands(pixels);
      if (bands.length) {
        // A band mask is irreversible and runs before the region pass's never-drop-the-anchor
        // guard, so it needs its own: if the boxes cover nearly everything the matte kept, the
        // "panel" is the product (a flat full-bleed pack shot is shaped exactly like a strip) and
        // masking would return an empty cutout. Skip the pass entirely; a leftover strip is
        // recoverable, a deleted product is not.
        let kept = 0;
        for (let i = 3; i < pixels.data.length; i += 4) {
          if (pixels.data[i] > 128) kept++;
        }
        const coveredTotal = bands.reduce((sum, b) => sum + b.covered, 0);
        if (coveredTotal > kept * 0.85) bands = [];
      }
      maskBands(pixels, bands);
      const result = keepProductRegions(pixels);
      removedRegions = result.removed;
      // Kept for the UI: a heuristic that cannot be inspected cannot be tuned.
      regionReport = result.regions;
    } else {
      // Filter off: analyse anyway (report-only) so quality triage can still see badge collages,
      // duplicate products and floating text. One extra classical-CV pass per image, off the
      // main thread — cheap next to the inference that just ran.
      regionReport = analyzeRegions(pixels);
    }

    // The bbox is scanned here, off the main thread, while we still hold the pixels.
    const bounds = subjectBounds(pixels);
    // Ghosted overlay graphics live below the alpha threshold where nothing else can see them.
    const residueFraction = measureFaintResidue(pixels, bounds);

    return { pixels, bounds, removedRegions, regionReport, bands, residueFraction, originalComponents };
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
    if (!a.bounds) return true;
    const bboxFraction = (a.bounds.w * a.bounds.h) / (outW * outH);
    const kept = a.regionReport.filter((r) => !r.removed);
    return bboxFraction > 0.97 && a.removedRegions === 0 && kept.length <= 1;
  };
  const looksShredded = (a: MatteAttempt): boolean => {
    if (!a.bounds) return true;
    const canvasArea = outW * outH;
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
    ctx.postMessage({ type: 'stage', jobId: req.jobId, stage: 'inferring' } satisfies WorkerResponse);
    const retry = await attempt(Math.round(Math.max(outW, outH) * PAD_FRACTION));
    // The retry must cure the failure that sent it back; a shredded matte's rescue may
    // legitimately fill the whole frame, so it is not held to the whole-frame test.
    const cured = shredded
      ? !looksShredded(retry)
      : !looksWholeFrame(retry) && !looksShredded(retry);
    if (cured) result = retry;
  }

  base2d.putImageData(result.pixels, 0, 0);

  // Hand back only the compressed master. No preview is produced here: a batch of thousands
  // would hold one decoded bitmap each (~1 MB at 512px, so gigabytes at scale), which is what
  // exhausted memory. The main thread decodes previews on demand for what is on screen.
  const blob = await baseCanvas.convertToBlob({ type: STORE_TYPE, quality: 1 });

  ctx.postMessage({
    type: 'done',
    jobId: req.jobId,
    blob,
    bounds: result.bounds,
    removedRegions: result.removedRegions,
    regionReport: result.regionReport,
    residueFraction: result.residueFraction,
    originalInk,
    originalComponents: result.originalComponents,
    bands: result.bands,
    width: outW,
    height: outH,
    durationMs: performance.now() - started,
    backend,
  } satisfies WorkerResponse);
}

ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const fail = (e: unknown) =>
    ctx.postMessage({
      type: 'error',
      jobId: req.jobId,
      message: e instanceof Error ? e.message : String(e),
      name: e instanceof Error ? e.name : 'Error',
    } satisfies WorkerResponse);

  if (req.type === 'init') {
    load(req.modelId, req.jobId).then(
      ({ backend }) =>
        ctx.postMessage({ type: 'ready', jobId: req.jobId, backend } satisfies WorkerResponse),
      fail
    );
    return;
  }
  remove(req).catch(fail);
});
