// Main-thread client for a pool of background-removal workers.
//
// Each worker holds its own model instance, so while one is doing single-threaded CPU work
// (preprocess / matte application / refinement) another can be on the GPU. The pool owns a
// queue: callers submit every image up front and the pool keeps every worker fed, which is what
// closes the GPU idle gap that a strictly sequential loop leaves behind.
//
// Falls back to the main-thread engine when workers or WebGPU are unavailable — see
// isPoolSupported(). The compositor keeps using the engine directly; only batch runs pool.

import {
  BG_MODELS,
  type BgBackend,
  type BgModelId,
  type BgSource,
  type LoadProgress,
  type RemoveStage,
} from './engine';
import type { RefineMode } from './refine';
import type { SubjectBounds } from './safe-area';
import type { InkFootprint, OriginalComponentReport, RegionReport } from './regions';
import type { DetectedBand } from './bands';
import type { WorkerRequest, WorkerResponse } from './bg.worker';
import { MAX_EDGE } from './constants';

/**
 * What a pooled run produces. Deliberately not a canvas: a batch retains one of these per image,
 * and full-resolution RGBA per item is what ran the tab out of memory. The blob is the master
 * (lossless, so re-encoding on export loses nothing) and the preview is all the UI ever draws.
 */
export interface PoolCutout {
  blob: Blob;
  /** In full-resolution pixels; map onto a decoded preview with previewScale(). */
  bounds: SubjectBounds | null;
  /** Graphic regions the product-only filter dropped; 0 when off or nothing matched. */
  removedRegions: number;
  /** Per-region measurements behind that decision. */
  regionReport: RegionReport[];
  /** Share of canvas covered by faint sub-threshold pixels outside the subject bbox. */
  residueFraction: number;
  /** The original's content footprint, from before the matte — see regions.measureInkFootprint. */
  originalInk: InkFootprint;
  /** Per-element survival of the original's ink islands against the PRE-filter matte. */
  originalComponents: OriginalComponentReport[];
  /** Flat edge strips masked from the source. */
  bands: DetectedBand[];
  width: number;
  height: number;
  durationMs: number;
  backend: BgBackend;
  model: BgModelId;
}

export interface PoolRemoveOptions {
  model: BgModelId;
  refine?: boolean;
  refineMode?: RefineMode;
  zoomPass?: boolean;
  productOnly?: boolean;
  onLoadProgress?: (p: LoadProgress) => void;
  onStage?: (stage: RemoveStage) => void;
  signal?: AbortSignal;
}

interface Job {
  id: number;
  bitmap: ImageBitmap;
  opts: PoolRemoveOptions;
  resolve: (r: PoolCutout) => void;
  reject: (e: unknown) => void;
  /** Set when the caller aborts: the worker still finishes, but the result is dropped. */
  abandoned: boolean;
}

interface Slot {
  worker: Worker;
  busy: boolean;
}

// Two workers is the sweet spot: it is enough to overlap one image's CPU stages with another's
// GPU stage, without paying for a third resident copy of the model weights. Unified memory on
// Apple silicon makes extra instances real cost, not free.
const DEFAULT_POOL_SIZE = 2;

let slots: Slot[] | null = null;
let nextJobId = 1;
const pending = new Map<number, Job>();
const queue: Job[] = [];
let poolBackend: BgBackend | null = null;

/** Whether the worker path can run at all. Cheap and synchronous. */
export function isPoolSupported(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function'
  );
}

/** The backend the pooled workers actually loaded on, once one has reported in. */
export function getPoolBackend(): BgBackend | null {
  return poolBackend;
}

function spawn(size: number): Slot[] {
  const made: Slot[] = [];
  for (let i = 0; i < size; i++) {
    // new URL(..., import.meta.url) is what lets Turbopack discover and bundle the worker.
    const worker = new Worker(new URL('./bg.worker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, busy: false };
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) =>
      handleMessage(slot, event.data)
    );
    worker.addEventListener('error', (event) => {
      // A worker-level failure must not strand its job forever.
      for (const [id, job] of pending) {
        if (!job.abandoned) job.reject(new Error(event.message || 'Worker crashed'));
        pending.delete(id);
      }
      slot.busy = false;
      pump();
    });
    made.push(slot);
  }
  return made;
}

function ensurePool(size = DEFAULT_POOL_SIZE): Slot[] {
  if (!slots) slots = spawn(size);
  return slots;
}

function handleMessage(slot: Slot, msg: WorkerResponse) {
  const job = pending.get(msg.jobId);

  if (msg.type === 'progress') {
    job?.opts.onLoadProgress?.({
      ratio: msg.total ? msg.loaded / msg.total : null,
      loadedMb: msg.loaded / 1048576,
      totalMb: msg.total / 1048576,
      label: msg.label,
    });
    return;
  }
  if (msg.type === 'stage') {
    job?.opts.onStage?.(msg.stage);
    return;
  }
  if (msg.type === 'ready') {
    poolBackend = msg.backend;
    return;
  }

  // Terminal outcomes free the slot.
  pending.delete(msg.jobId);
  slot.busy = false;

  if (msg.type === 'error') {
    const err = new Error(msg.message);
    err.name = msg.name;
    if (job && !job.abandoned) job.reject(err);
  } else if (msg.type === 'done') {
    poolBackend = msg.backend;
    if (job && !job.abandoned) {
      job.opts.onStage?.('done');
      job.resolve({
        blob: msg.blob,
        bounds: msg.bounds,
        removedRegions: msg.removedRegions,
        regionReport: msg.regionReport,
        residueFraction: msg.residueFraction,
        originalInk: msg.originalInk,
        originalComponents: msg.originalComponents,
        bands: msg.bands,
        width: msg.width,
        height: msg.height,
        durationMs: msg.durationMs,
        model: job.opts.model,
        backend: msg.backend,
      });
    }
  }
  pump();
}

/** Hands queued jobs to idle workers. */
function pump() {
  if (!slots) return;
  for (const slot of slots) {
    if (slot.busy) continue;
    const job = queue.shift();
    if (!job) return;
    if (job.abandoned) {
      job.bitmap.close();
      continue;
    }
    slot.busy = true;
    pending.set(job.id, job);
    const req: WorkerRequest = {
      type: 'remove',
      jobId: job.id,
      modelId: job.opts.model,
      bitmap: job.bitmap,
      refine: job.opts.refine ?? false,
      refineMode: job.opts.refineMode ?? 'auto',
      zoomPass: job.opts.zoomPass ?? false,
      productOnly: job.opts.productOnly ?? false,
    };
    slot.worker.postMessage(req, [job.bitmap]);
  }
}

function sourceSize(source: BgSource): { width: number; height: number } | null {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  }
  if (source instanceof HTMLCanvasElement) return { width: source.width, height: source.height };
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return { width: source.width, height: source.height };
  }
  return null; // a Blob's dimensions are unknown until it is decoded
}

async function toBitmap(source: BgSource): Promise<ImageBitmap> {
  // Downscale during decode rather than after: createImageBitmap never materialises the
  // full-size bitmap, so a 4000px photo costs the capped 2048px allocation and nothing more.
  const size = sourceSize(source);
  const scale = size ? Math.min(1, MAX_EDGE / Math.max(size.width, size.height)) : 1;
  if (size && scale < 1) {
    return createImageBitmap(source as ImageBitmapSource, {
      resizeWidth: Math.max(1, Math.round(size.width * scale)),
      resizeHeight: Math.max(1, Math.round(size.height * scale)),
      resizeQuality: 'high',
    });
  }
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return source;
  // createImageBitmap decodes off the main thread, so this does not block the UI.
  return createImageBitmap(source as ImageBitmapSource);
}

/**
 * Queues one image. Resolve order follows completion, not submission — submit the whole batch
 * and await them individually (or with allSettled) to keep every worker busy.
 */
export function poolRemoveBackground(
  source: BgSource,
  opts: PoolRemoveOptions
): Promise<PoolCutout> {
  const spec = BG_MODELS[opts.model];
  if (!spec || spec.server) {
    return Promise.reject(new Error(`Model "${opts.model}" is not poolable`));
  }
  ensurePool();

  return new Promise<PoolCutout>((resolve, reject) => {
    void (async () => {
      let bitmap: ImageBitmap;
      try {
        bitmap = await toBitmap(source);
      } catch (e) {
        reject(e);
        return;
      }
      const job: Job = { id: nextJobId++, bitmap, opts, resolve, reject, abandoned: false };

      if (opts.signal?.aborted) {
        bitmap.close();
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      opts.signal?.addEventListener(
        'abort',
        () => {
          // In-flight work cannot be interrupted mid-inference; abandon the result instead so
          // the slot frees normally and the caller stops waiting immediately.
          job.abandoned = true;
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );

      queue.push(job);
      pump();
    })();
  });
}

/** Loads the model in every worker up front so a batch does not stall on the first image. */
export function warmPool(model: BgModelId): Promise<void> {
  if (!isPoolSupported()) return Promise.resolve();
  const spec = BG_MODELS[model];
  if (!spec || spec.server) return Promise.resolve();
  for (const slot of ensurePool()) {
    slot.worker.postMessage({ type: 'init', jobId: nextJobId++, modelId: model } satisfies WorkerRequest);
  }
  return Promise.resolve();
}

/** Tears the pool down (model instances included). Used on unmount. */
export function disposePool(): void {
  slots?.forEach((s) => s.worker.terminate());
  slots = null;
  // Anything still outstanding must be rejected, not silently dropped — a queued job whose
  // promise never settles hangs its caller (and any batch awaiting it) forever.
  const orphans = [...queue, ...pending.values()];
  queue.length = 0;
  pending.clear();
  for (const job of orphans) {
    if (!job.abandoned) job.reject(new DOMException('Aborted', 'AbortError'));
  }
  poolBackend = null;
}
