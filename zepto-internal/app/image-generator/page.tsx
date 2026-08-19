'use client';

// Image Generator — one generated image per CSV row, from a Markdown brief plus the row's own
// fields. Text-to-image, so it uses Azure's generations endpoint (via /api/generate's
// `mode: 'generations'`) rather than the edits endpoint the other two products drive.
//
// The prompt rule lives in lib/row-prompt.ts (Cleanup sends row context the same way) and is
// surfaced verbatim in every cell and dialog: the
// product's whole value is "these columns, under this brief", so hiding the assembled string
// would make a bad result impossible to diagnose.

import * as React from 'react';
import { toast } from 'sonner';
import {
  CircleStopIcon, DownloadIcon, FileSpreadsheetIcon, RefreshCwIcon, SparklesIcon, UploadCloudIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ClearAllButton, SelectionBar, useGridSelection } from '@/components/selection';
import { ColumnPicker } from '@/components/column-picker';
import { BatchPromptDialog, resolvePromptSource, type PromptSource } from '@/components/regen-prompt';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { CsvFileTile } from '@/components/csv-dropzone';
import { MdFileIcon, MdFileTile } from '@/components/md-file-tile';
import { createEta } from '@/lib/eta';
import { matchSkill, useSkills } from '@/lib/skills';
import { SessionHeader, type SessionChip } from '@/components/session-header';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';

import { Canvas, CanvasToolbar, LeftPanel, PanelSection, RightPanel, StudioShell } from '@/components/pane-layout';
import { GenDialog, GenGrid } from '@/components/image-generator/gen-grid';
import { PromptListInput } from '@/components/image-generator/prompt-list';
import { formatPromptList, parsePromptList } from '@/lib/prompt-list';

import { detectTitleColumn, parseCSV, type CsvRecord } from '@/lib/csv';
import { GEN_SIZES, createGenItems, genFileStem, reconcileSubjectItems, type GenItem, type GenSize } from '@/lib/gen';
import { PROMPT_WARN_CHARS, buildRowPrompt, buildSubjectPrompt, isPromptEmpty } from '@/lib/row-prompt';
import { callAzure, callAzureGenerate, mockGenerate } from '@/lib/pipeline';
import { readParallel } from '@/lib/rate';
import { canvasToPngBlob, mapWithLimit, pickSave, releaseCanvas, saveTo } from '@/lib/bg/batch';
import { readSession, restingStatus, saveSession, sessionKey } from '@/lib/bg/session-store';
import { processImage } from '@/lib/process';
import { useProcessing } from '@/components/process-panel';
import { buildZipStream, type ZipStreamEntry } from '@/lib/zip';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { CanvasDropzone, DropzoneShell } from '@/components/dropzone';

const NONE = '__none__';

/**
 * Everything a product switch would otherwise destroy. The rail's <Link>s unmount this page, so
 * without a hand-off the brief, the parsed CSV and every generated image — none of which exist
 * anywhere but in this component's state — are gone the moment someone clicks Compose.
 *
 * Only settled state belongs here: `running` and `exporting` are false again by definition on
 * the next mount, because leaving aborted the run. Persisted settings (endpoint, key, size,
 * numbering, the process panel) are localStorage-backed and never needed a snapshot. See
 * lib/bg/session-store.ts for what this does NOT survive — it is a tab-lifetime hand-off, not
 * storage.
 */
interface GenSession {
  brief: string;
  briefName: string | null;
  subjects: string;
  csvName: string | null;
  sessionName: string;
  headers: string[];
  records: CsvRecord[];
  nameCol: string;
  excluded: string[];
  items: GenItem[];
  progress: { pct: number; text: string } | null;
}

const GEN_SESSION = sessionKey<GenSession>('image-generator');

export default function ImageGenerator() {
  // Azure credentials are the suite's shared pair — set them once in any product.
  const [endpoint] = usePersistedState('skuc_azureEndpoint', '');
  const [azureKey] = usePersistedState('skuc_azureKey', '');
  const [size, setSize] = usePersistedState<GenSize>('skuc_genSize', '1024x1024');
  const [numberFiles, setNumberFiles] = usePersistedState('skuc_genNumberFiles', true);

  // Whatever the last unmount left behind, read once for the initializers below and nowhere
  // else. readSession never consumes, so StrictMode's double-invoked render and its dev-only
  // remount both see the same snapshot rather than racing each other for it.
  const revived = React.useMemo(() => readSession(GEN_SESSION), []);

  // Brief: never written to storage, on purpose. It is document-sized and specific to one batch,
  // so persisting it would silently apply an old brief to a new CSV. Surviving a product switch
  // is a different matter — the CSV it was written for is still sitting in the panel — so it
  // rides along in the session snapshot with the rest of the run.
  const [brief, setBrief] = React.useState(() => revived?.brief ?? '');
  const [briefName, setBriefName] = React.useState<string | null>(() => revived?.briefName ?? null);
  // The brief renders as an .md tile in the panel; this opens its editor modal.
  const [briefEditorOpen, setBriefEditorOpen] = React.useState(false);
  // The bulk action asks before it spends: the toolbar opens the batch prompt rather than firing.
  const [batchPromptOpen, setBatchPromptOpen] = React.useState(false);
  // The tile's caret menu can seed the brief from a saved skill — same switcher as
  // Compose's prompt and Cleanup's AI-edit prompt. Selection is content-derived.
  const { skills } = useSkills();
  const briefSkillId = matchSkill(brief, skills);
  const activeBriefSkill = skills.find((sk) => sk.id === briefSkillId);
  // Display identity, derived live so it can never go stale: a matched skill's name wins
  // (and survives renames in Settings), then the dropped file's name, then the placeholder
  // once something has been typed. null means "no brief at all" for the chips below.
  const briefLabel = activeBriefSkill?.name ?? briefName ?? (brief.trim() ? 'brief.md' : null);

  // The typed row source, beside the CSV: one request per numbered line. Not persisted for the
  // same reason the brief is not — it belongs to one batch — but it rides the session snapshot
  // so a product switch does not eat what was typed.
  const [subjects, setSubjects] = React.useState(() => revived?.subjects ?? '');

  const [csvName, setCsvName] = React.useState<string | null>(() => revived?.csvName ?? null);
  // Figma-style session name in the panel header; seeds the export ZIP filename. Auto-seeded
  // from the dropped CSV, but never over a name the user already typed.
  const [sessionName, setSessionName] = React.useState(() => revived?.sessionName ?? '');
  const sessionSlug = sessionName.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  const seedSessionName = React.useCallback((fileName: string) => {
    setSessionName((prev) => (prev.trim() ? prev : fileName.replace(/\.[^.]+$/, '')));
  }, []);
  const [headers, setHeaders] = React.useState<string[]>(() => revived?.headers ?? []);
  const [records, setRecords] = React.useState<CsvRecord[]>(() => revived?.records ?? []);
  const [nameCol, setNameCol] = React.useState(() => revived?.nameCol ?? '');
  const [excluded, setExcluded] = React.useState<string[]>(() => revived?.excluded ?? []);

  const [items, setItems] = React.useState<GenItem[]>(() => revived?.items ?? []);
  const [running, setRunning] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [progress, setProgress] = React.useState<{ pct: number; text: string } | null>(
    () => revived?.progress ?? null,
  );
  const [openId, setOpenId] = React.useState<number | null>(null);
  const resultScrollRef = React.useRef<HTMLDivElement>(null);

  // Stop button: one controller per run (batch or single regenerate); aborting skips every
  // row not yet started and cancels the in-flight request (the proxy forwards it to Azure).
  const genAbortRef = React.useRef<AbortController | null>(null);
  const itemsRef = React.useRef<GenItem[]>(items);
  React.useEffect(() => { itemsRef.current = items; }, [items]);

  // The snapshot the unmount below hands to the next mount, restated after every commit. The
  // cleanup that reads it has to be mount-once — anything else would tear down and re-arm the
  // abort on every keystroke — so its closure is stuck with the empty state it was created
  // with, and a ref is the only thing it can reach that is still current.
  const sessionRef = React.useRef<GenSession | null>(null);
  React.useEffect(() => {
    sessionRef.current = {
      brief,
      briefName,
      subjects,
      csvName,
      sessionName,
      headers,
      records,
      nameCol,
      excluded,
      items,
      // A run still in flight is a run the unmount is about to cancel, so it comes back
      // reported as stopped. Reviving the live line instead would leave a progress bar parked
      // at 40% with nothing behind it, reading as a batch that is still going. An export is the
      // opposite case — nothing aborts it, and it writes into a handle the user already picked,
      // so it really does finish; only its per-file counter dies with the component.
      progress: running
        ? { pct: 100, text: 'Stopped — leaving Generate cancelled the run; nothing further was sent.' }
        : exporting
          ? { pct: 100, text: 'Export is still packing in the background; it writes to the file you chose.' }
          : progress,
    };
  });

  // Leaving the product must stop the run. The rail navigates client-side, so this component is
  // unmounted while the document lives on: without the abort, the batch keeps working down the
  // CSV and billing Azure for images nobody is on screen to see, then patches state on a page
  // that no longer exists. Same unmount abort the BG Remover does for its removal and AI phases.
  React.useEffect(
    () => () => {
      genAbortRef.current?.abort();
      const session = sessionRef.current;
      if (!session) return;
      // Those aborts reject after this cleanup has run, so their "put the row back" patches
      // never commit and rows caught mid-flight are still 'generating' in what we hold here.
      // restingStatus is what stops them reviving as spinners that can never finish; a row that
      // had an earlier image keeps it and comes back 'done'.
      saveSession(GEN_SESSION, {
        ...session,
        items: session.items.map((item) => ({
          ...item,
          status: restingStatus(item.status, item.image !== null),
        })),
      });
    },
    [],
  );

  const itemIds = React.useMemo(() => items.map((it) => it.id), [items]);
  const sel = useGridSelection(itemIds, openId !== null);

  const mock = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('mock');
  const busy = running || exporting;
  const excludedSet = React.useMemo(() => new Set(excluded), [excluded]);
  // The picker speaks inclusion, the state speaks exclusion. Storing what is NOT sent is what
  // makes a freshly dropped CSV send everything by default, and a re-dropped sheet with a new
  // column send that column too rather than silently dropping it for being unheard-of.
  const includedColumns = React.useMemo(
    () => headers.filter((header) => !excludedSet.has(header)),
    [headers, excludedSet],
  );
  const setIncludedColumns = React.useCallback(
    (next: string[]) => {
      const keep = new Set(next);
      setExcluded(headers.filter((header) => !keep.has(header)));
    },
    [headers],
  );

  // The two row sources assemble differently, and every screen that shows a prompt — the cell,
  // the dialog, the length warning, the request itself — goes through here, so neither source
  // can end up displaying one thing and sending another.
  const promptFor = React.useCallback(
    (item: GenItem) => (item.subject !== undefined
      ? buildSubjectPrompt(brief, item.subject)
      : buildRowPrompt(brief, headers, item.record, excludedSet)),
    [brief, headers, excludedSet],
  );
  const promptForRef = React.useRef(promptFor);
  React.useEffect(() => { promptForRef.current = promptFor; }, [promptFor]);

  /**
   * The typed list, applied to the queue. A CSV outranks it — a run is driven by one source or
   * the other — so while a sheet is loaded the box keeps what was typed without touching rows.
   */
  const applySubjects = React.useCallback((next: string) => {
    setSubjects(next);
    if (csvName) return;
    setItems((prev) => reconcileSubjectItems(parsePromptList(next), prev));
  }, [csvName]);

  const proc = useProcessing({ prefix: 'skuc_gen', removeBg: true, tileFit: true, busy });

  const subjectCount = React.useMemo(() => parsePromptList(subjects).length, [subjects]);
  // How many of the selection could be EDITED rather than re-rolled — the batch dialog's
  // source choice only means something where an image already exists.
  const regenEditableCount = items.filter((it) => sel.checked.has(it.id) && it.image).length;

  const openItem = items.find((it) => it.id === openId) ?? null;
  const doneCount = items.filter((it) => it.status === 'done' && it.image).length;

  // Sampled from the first row: the brief dominates the length, so one row is representative
  // and this stays cheap no matter how long the CSV is.
  const sampleLength = items.length ? promptFor(items[0]).length : brief.trim().length;

  function patchItem(id: number, patch: Partial<GenItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  // ---- Input -------------------------------------------------------------

  function handleFiles(files: File[]) {
    for (const file of files) {
      const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
      const isDoc = /\.(md|markdown|txt)$/i.test(file.name);
      if (!isCsv && !isDoc) {
        toast.error(`${file.name}: drop a .md brief or a .csv of rows.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        if (isCsv) {
          const parsed = parseCSV(text);
          if (!parsed.headers.length || !parsed.records.length) {
            toast.error(`${file.name} appears empty.`);
            return;
          }
          // detectTitleColumn only matches title/name/product headers; a brief-driven CSV is
          // as likely to key on `sku` or `id`, so fall back to the first column rather than
          // leaving every row named "Row 1" and every export file numbered but anonymous.
          const detected = detectTitleColumn(parsed.headers, []) || parsed.headers[0] || '';
          setCsvName(file.name);
          seedSessionName(file.name);
          setHeaders(parsed.headers);
          setRecords(parsed.records);
          setNameCol(detected);
          setExcluded([]);
          setItems(createGenItems(parsed.records, detected, 0));
          setOpenId(null);
        } else {
          setBrief(text);
          setBriefName(file.name);
        }
      };
      reader.onerror = () => toast.error(`Could not read ${file.name}.`);
      reader.readAsText(file);
    }
  }

  /** Re-mapping the name column renames rows in place — generated images are never thrown away. */
  function remapNames(next: string) {
    setNameCol(next);
    setItems((prev) =>
      prev.map((it, i) => ({
        ...it,
        name: (next ? it.record[next] : '')?.trim() || `Row ${i + 1}`,
      })),
    );
  }

  // ---- Generation --------------------------------------------------------

  function guards(): boolean {
    if (!items.length) return false;
    if (!mock && (!endpoint.trim() || !azureKey.trim())) {
      toast.error('Set the Azure endpoint and API key in Settings (gear at the bottom of the rail), or use ?mock=1.');
      return false;
    }
    return true;
  }

  /**
   * `promptOverride` is one row's edit from its dialog — it never touches the brief.
   *
   * `from` picks which Azure API this call is: 'latest' sends the row's current image WITH the
   * prompt (the edits endpoint — a refinement of what is on screen), 'original' sends the
   * prompt alone (generations — a fresh sample). A row with no image has only the second, and
   * resolvePromptSource settles that per row, so a batch mixing generated and never-run rows
   * does the right thing for each instead of skipping half of them.
   */
  async function generateOne(
    item: GenItem,
    signal?: AbortSignal,
    promptOverride?: string,
    from: PromptSource = 'original',
  ): Promise<boolean> {
    const prompt = promptOverride?.trim() || promptForRef.current(item);
    if (isPromptEmpty(prompt)) {
      patchItem(item.id, { status: 'error', errorMsg: 'Nothing to send — no brief and no included columns' });
      return false;
    }
    const editing = resolvePromptSource(from, { hasLatest: !!item.image, hasOriginal: true }) === 'latest';
    patchItem(item.id, { status: 'generating', errorMsg: undefined });
    const started = performance.now();
    try {
      const image = mock
        ? await mockGenerate(prompt, 1024, signal)
        : editing
          // The size the set is being generated at, not 'auto': the input is already that
          // shape, and letting the model re-pick would break a row out of the set.
          ? await callAzure([item.image!], { endpoint, apiKey: azureKey, prompt, size, signal })
          : await callAzureGenerate(prompt, { endpoint, apiKey: azureKey, size, signal });
      patchItem(item.id, {
        status: 'done',
        image,
        sentPrompt: prompt,
        durationMs: performance.now() - started,
        errorMsg: undefined,
        // `item` is the pre-run snapshot: if it had a result, that result becomes the undo slot.
        ...(item.image
          ? { prev: { image: item.image, sentPrompt: item.sentPrompt, durationMs: item.durationMs } }
          : null),
      });
      return true;
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // Stopped, not failed: the row goes back exactly where it was before this run.
        patchItem(item.id, { status: item.status, errorMsg: undefined });
        return false;
      }
      patchItem(item.id, { status: 'error', errorMsg: (e as Error).message });
      return false;
    }
  }

  async function handleGenerateAll() {
    if (busy || !guards()) return;
    await runBatch(itemsRef.current, 'generated');
  }

  /** One run over `todo` — Generate-all and Regenerate-selected share everything but the verb. */
  /** `promptOverride` is the selection's one-off wording from the batch dialog. */
  async function runBatch(todo: GenItem[], verb: string, promptOverride?: string, from?: PromptSource) {
    const controller = new AbortController();
    genAbortRef.current = controller;
    setRunning(true);
    // Rows in flight at once: the Azure round trip dominates each row's wall-clock, so
    // overlapping the waits is where a batch gets its speed. Suite-wide, from Settings →
    // Image model (lib/rate.ts); read at run start, so it holds for the whole batch.
    const limit = readParallel();
    let finished = 0;
    let ok = 0;
    const eta = createEta();
    setProgress({ pct: 0, text: `0 of ${todo.length} — ${limit} at a time with ${mock ? 'mock' : 'azure'}…` });
    try {
      await mapWithLimit(todo, limit, async (item) => {
        // Stop skips everything not yet started; rows already in flight abort via the signal.
        if (controller.signal.aborted) {
          finished++;
          return;
        }
        if (await generateOne(item, controller.signal, promptOverride, from)) ok++;
        finished++;
        const left = eta.remaining(finished, todo.length);
        setProgress({
          pct: (finished / todo.length) * 100,
          text: `${finished} of ${todo.length} — ${limit} at a time with ${mock ? 'mock' : 'azure'}…${left ? ` · ${left}` : ''}`,
        });
      });
    } finally {
      setProgress(
        controller.signal.aborted
          ? { pct: 100, text: `Stopped — ${ok} of ${todo.length} ${verb}; the rest are untouched.` }
          : { pct: 100, text: `Done — ${ok} of ${todo.length} images ${verb}.` },
      );
      genAbortRef.current = null;
      setRunning(false);
    }
  }

  async function handleRegenerate(id: number, promptOverride?: string, from?: PromptSource) {
    if (busy || !guards()) return;
    const item = itemsRef.current.find((it) => it.id === id);
    if (!item) return;
    const hadImage = !!item.image;
    const controller = new AbortController();
    genAbortRef.current = controller;
    setRunning(true);
    setProgress({ pct: 50, text: `Regenerating ${item.name}…` });
    try {
      const ok = await generateOne(item, controller.signal, promptOverride, from);
      setProgress({
        pct: 100,
        text: controller.signal.aborted
          ? `${item.name} — stopped.`
          : ok
            ? `${item.name} regenerated.`
            : `${item.name} failed.`,
      });
      // The dialog's own Undo button covers this row while the dialog is open; the toast is
      // what makes the undo reachable after it closes — which is when a replaced image is
      // most likely to be missed, with the grid showing the new one and no way back to the
      // old but reopening the cell. Same offer the batch path makes, one row wide.
      //
      // Keyed off the PRE-RUN snapshot, not itemsRef: generateOne's patch lands a render
      // later than this await resolves, so reading the item back here finds the row without
      // its undo slot and the toast never shows. An image before the run is exactly the
      // condition under which generateOne fills `prev`, so the snapshot answers it directly.
      if (ok && hadImage) {
        toast.success(`${item.name} regenerated`, {
          action: { label: 'Undo', onClick: () => undoItem(id) },
        });
      }
    } finally {
      genAbortRef.current = null;
      setRunning(false);
    }
  }

  /**
   * Deleting cells. On a list-driven run the box is the queue, so the lines go with the rows —
   * leaving them behind would type the deleted row straight back on the next keystroke. The
   * text is rewritten canonically numbered, which is the same shape the editor maintains.
   */
  function dropItems(gone: ReadonlySet<number>) {
    const kept = itemsRef.current.filter((it) => !gone.has(it.id));
    setItems(kept);
    if (!csvName) {
      setSubjects(formatPromptList(kept.map((it) => it.subject ?? '').filter(Boolean)));
    }
  }

  function handleRemove(id: number) {
    dropItems(new Set([id]));
    setOpenId((prev) => (prev === id ? null : prev));
  }

  // ---- Selection ---------------------------------------------------------

  function deleteSelected() {
    dropItems(sel.checked);
    setOpenId((prev) => (prev !== null && sel.checked.has(prev) ? null : prev));
    sel.clear();
  }

  /** Restores the result the last regenerate replaced. */
  function undoItem(id: number) {
    const item = itemsRef.current.find((it) => it.id === id);
    if (!item?.prev) return;
    patchItem(id, {
      status: 'done',
      image: item.prev.image,
      sentPrompt: item.prev.sentPrompt,
      durationMs: item.prev.durationMs,
      errorMsg: undefined,
      prev: undefined,
    });
  }

  async function handleRegenerateSelected(promptOverride: string, from: PromptSource) {
    if (busy || !guards()) return;
    const todo = itemsRef.current.filter((it) => sel.checked.has(it.id));
    if (!todo.length) return;
    await runBatch(todo, 'regenerated', promptOverride, from);
    const undoable = todo.filter((it) => itemsRef.current.find((n) => n.id === it.id)?.prev);
    if (undoable.length) {
      toast.success(`${undoable.length} regenerated`, {
        action: { label: 'Undo', onClick: () => undoable.forEach((it) => undoItem(it.id)) },
      });
    }
  }

  /** Full reset back to the drop zone. The brief survives — it is its own input document. */
  function clearAll() {
    genAbortRef.current?.abort();
    setItems([]);
    setSubjects('');
    sel.clear();
    setOpenId(null);
    setCsvName(null);
    setHeaders([]);
    setRecords([]);
    setNameCol('');
    setExcluded([]);
    setProgress(null);
  }

  /**
   * Just the sheet. The typed list was never destroyed when the CSV took over the queue, so
   * dropping the sheet hands the rows back to it rather than emptying the canvas.
   */
  function clearCsv() {
    genAbortRef.current?.abort();
    sel.clear();
    setOpenId(null);
    setCsvName(null);
    setHeaders([]);
    setRecords([]);
    setNameCol('');
    setExcluded([]);
    setProgress(null);
    setItems(reconcileSubjectItems(parsePromptList(subjects), []));
  }

  // ---- Export ------------------------------------------------------------

  async function handleExport() {
    const ready = itemsRef.current.filter((it) => it.status === 'done' && it.image);
    if (!ready.length || busy) return;
    const zipName = sessionSlug ? `${sessionSlug}-generated.zip` : 'generated-images.zip';
    const dest = await pickSave(zipName);
    if (dest === 'cancelled') return;

    setExporting(true);
    try {
      const files: ZipStreamEntry[] = [];
      const used = new Map<string, number>();
      let n = 0;
      const eta = createEta();
      for (const item of ready) {
        const stem = genFileStem(item.name, `row-${item.id + 1}`);
        let fileName: string;
        if (numberFiles) {
          fileName = `${String(n + 1).padStart(2, '0')}-${stem}.png`;
        } else {
          const seen = (used.get(stem) ?? 0) + 1;
          used.set(stem, seen);
          fileName = seen === 1 ? `${stem}.png` : `${stem}-${seen}.png`;
        }
        const canvas = await processImage(item.image!, proc.steps);
        const blob = await canvasToPngBlob(canvas);
        releaseCanvas(canvas);
        const data = await proc.compressBytes(new Uint8Array(await blob.arrayBuffer()));
        // Blob, not bytes: pages out to blob storage, so a full-CSV export never holds every
        // PNG in memory at once.
        files.push({ name: fileName, data: new Blob([data as BlobPart], { type: 'image/png' }) });
        n++;
        const left = eta.remaining(n, ready.length);
        setProgress({
          pct: (n / ready.length) * 100,
          text: `Packing ${n} of ${ready.length}…${left ? ` · ${left}` : ''}`,
        });
      }
      await saveTo(dest, await buildZipStream(files), zipName);
      setProgress({ pct: 100, text: `Exported ${files.length} image${files.length > 1 ? 's' : ''}.` });
    } catch (e) {
      toast.error(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  }

  // ---- Render ------------------------------------------------------------

  const runFooter = (
    <div className="flex gap-2">
      <Button className="flex-1" disabled={busy || !items.length} onClick={handleGenerateAll}>
        {running ? <Spinner data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
        {items.length ? `Generate ${items.length} image${items.length > 1 ? 's' : ''}` : 'Generate'}
      </Button>
      {running && (
        <Button variant="outline" onClick={() => genAbortRef.current?.abort()}>
          <CircleStopIcon data-icon="inline-start" />
          Stop
        </Button>
      )}
    </div>
  );

  const exportFooter = (
    <div className="space-y-2">
      {progress && <Progress value={progress.pct} />}
      <p className="text-xs text-muted-foreground">
        {progress?.text || 'Generated images export as PNGs in a ZIP.'}
      </p>
      <Button className="w-full" disabled={busy || !doneCount} onClick={handleExport}>
        {exporting ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
        Export ZIP
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <StudioShell>
        <LeftPanel
          title="Setup"
          footer={runFooter}
          header={
            <SessionHeader
              name={sessionName}
              onNameChange={setSessionName}
              placeholder="Untitled run"
              product="Generate"
              chips={
                [
                  items.length > 0 && {
                    label: csvName
                      ? `${items.length} row${items.length === 1 ? '' : 's'}`
                      : `${items.length} prompt${items.length === 1 ? '' : 's'}`,
                  },
                  doneCount > 0 && { label: `${doneCount} generated` },
                  briefLabel !== null && {
                    label: brief.trim() ? 'brief loaded' : 'brief empty',
                    tone: (brief.trim() ? 'default' : 'warn') as SessionChip['tone'],
                  },
                ].filter(Boolean) as SessionChip[]
              }
            />
          }
        >
          <PanelSection
            title="Input"
            hint={csvName
              ? <>One image per CSV row. Each prompt is the brief followed by that row&rsquo;s
                fields, labelled with their column names.</>
              : <>One image per prompt. Each is sent with the brief above it — so a run is one
                skill applied to many subjects.</>}
          >
            <div className="space-y-3">
              {/* Loaded CSV as the suite's file card, matching the brief tile below: click to
                  replace, ✕ to remove. The sheet outranks the typed list while it is here, so
                  removing it hands the rows back to whatever is still in the box rather than
                  emptying the run — which is why this no longer goes through Clear all. */}
              {csvName ? (
                <CsvFileTile
                  name={csvName}
                  description={headers.join(', ')}
                  badge={`${records.length.toLocaleString()} row${records.length === 1 ? '' : 's'}`}
                  onReplace={(file) => handleFiles([file])}
                  onRemove={clearCsv}
                  disabled={busy}
                  removeConfirm={{
                    title: 'Remove the CSV?',
                    description: (
                      <>
                        Clears all {items.length} row{items.length === 1 ? '' : 's'}
                        {doneCount > 0 && <> and the {doneCount} generated image{doneCount === 1 ? '' : 's'} (not exported anywhere yet)</>}
                        {subjectCount > 0
                          ? <>, and the run goes back to the {subjectCount} typed prompt{subjectCount === 1 ? '' : 's'} still in the box</>
                          : null}
                        . The brief stays loaded; your CSV file on disk is untouched — drop it
                        again to rebuild the rows.
                      </>
                    ),
                  }}
                />
              ) : (
                <Field>
                  <FieldLabel htmlFor="gen-subjects">Prompts</FieldLabel>
                  <PromptListInput
                    id="gen-subjects"
                    value={subjects}
                    onChange={applySubjects}
                    disabled={busy}
                  />
                </Field>
              )}
              {/* The canvas drop target only exists while the run is empty, and the typed list
                  fills it on the first keystroke — so without this, typing a prompt would take
                  the CSV route off the screen with no way back to it. */}
              {!csvName && (
                <DropzoneShell
                  accept=".csv,text/csv"
                  disabled={busy}
                  onFiles={handleFiles}
                  className="gap-1 border py-3 text-xs"
                >
                  <span className="flex items-center gap-1.5">
                    <FileSpreadsheetIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span>
                      Or drop a CSV, or{' '}
                      <span className="text-primary underline underline-offset-2">browse</span>
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    Every row becomes one image and takes over from the list.
                  </span>
                </DropzoneShell>
              )}
              {/* Typed prompts are not thrown away by a CSV, so say where they went. */}
              {csvName && subjectCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {subjectCount} typed prompt{subjectCount === 1 ? ' is' : 's are'} held aside
                  while the CSV drives this run.
                </p>
              )}
            </div>
          </PanelSection>

          <PanelSection title="Brief" hint="Leads every row's prompt. Drop a .md file or pick a saved skill; skills are managed in Settings.">
            <div className="space-y-3">
              {/* Same .md tile as the BG Remover's prompt: the brief is configuration, so the
                  panel shows the file card and editing happens in the modal below. Always
                  visible so a brief can start from a skill without dropping a file.

                  No `badge`: a character count is not a thing anyone acts on, and it crowded out
                  the skill's tag, which is. The tile falls back to "Edited" when the brief
                  matches no saved skill — the one state it cannot show any other way. The length
                  that DOES matter is the prompt-too-long warning under the columns picker. */}
              <MdFileTile
                name={briefLabel ?? 'brief.md'}
                text={brief}
                onClick={() => setBriefEditorOpen(true)}
                disabled={busy}
                skills={{
                  list: skills,
                  activeId: briefSkillId,
                  onSelect: (sk) => {
                    setBrief(sk.content);
                    // A skill is not a dropped file: the tile derives its name from the live
                    // match instead, so a rename in Settings can never leave a stale title.
                    setBriefName(null);
                  },
                }}
              />
              {/* Output size rides with the brief instead of a "Model" section of its own: one
                  dropdown never justified a heading, and the shape asked for is part of the same
                  instruction the brief is. The suite-wide knobs it used to sit beside — quality,
                  parallel requests, the request budget — are in Settings → Image model. */}
              <Field>
                <FieldLabel htmlFor="gen-size">Output size</FieldLabel>
                <Select value={size} onValueChange={(v) => setSize(String(v ?? '1024x1024') as GenSize)} disabled={busy}>
                  <SelectTrigger id="gen-size">
                    <SelectValue>{(v) => String(v ?? '1024x1024')}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {GEN_SIZES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  With no input image to follow, &ldquo;auto&rdquo; lets the model choose the
                  shape — pick a size for a consistent set.
                </FieldDescription>
              </Field>
            </div>
          </PanelSection>

          {headers.length > 0 && (
            <PanelSection title="Columns" hint="Ticked columns are sent, each labelled with its header.">
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="gen-name-col">Name column</FieldLabel>
                    <Select
                      value={nameCol || NONE}
                      onValueChange={(v) => remapNames(String(v ?? '') === NONE ? '' : String(v ?? ''))}
                      disabled={busy}
                    >
                      <SelectTrigger id="gen-name-col">
                        <SelectValue>
                          {(value) => (value === NONE || !value ? '(Row number)' : String(value))}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>(Row number)</SelectItem>
                        {headers.map((h) => (
                          <SelectItem key={h} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      Names the cells and the exported files. Safe to change any time — rows are
                      renamed in place and generated images are kept.
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="gen-prompt-cols">Send in the prompt</FieldLabel>
                    <ColumnPicker
                      id="gen-prompt-cols"
                      columns={headers}
                      selected={includedColumns}
                      onChange={setIncludedColumns}
                      disabled={busy}
                      placeholder="No columns — the brief goes out alone"
                    />
                    <FieldDescription>
                      Unpick anything the model should not see — internal IDs, statuses, links.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              </PanelSection>
          )}
        </LeftPanel>

        <Canvas scrollRef={resultScrollRef}>
          {sampleLength > PROMPT_WARN_CHARS && (
            <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              A row&rsquo;s prompt is about {sampleLength.toLocaleString()} characters — Azure
              rejects very long prompts. Shorten the brief or untick a column.
            </p>
          )}
          {items.length === 0 ? (
            <CanvasDropzone
              icon={<UploadCloudIcon />}
              title="Type your prompts, or drop a CSV"
              description="Write what to generate in the panel — number the lines for one image each — or drop a CSV and let every row become an image. Either way the brief leads the prompt."
              accept=".md,.markdown,.txt,.csv,text/csv,text/markdown"
              multiple
              onFiles={handleFiles}
            />
          ) : (
            <>
              {/* Grid toolbar: count on the left, whole-run reset on the right. */}
              <CanvasToolbar className="justify-between">
                <span className="text-xs text-muted-foreground">
                  {sel.active
                    ? `${sel.checked.size} of ${items.length} selected`
                    : `${items.length} ${csvName ? 'row' : 'prompt'}${items.length === 1 ? '' : 's'}${doneCount ? ` · ${doneCount} generated` : ''}`}
                </span>
                <ClearAllButton
                  title="Clear this run?"
                  disabled={busy}
                  onConfirm={clearAll}
                  description={
                    <>
                      Removes all {items.length} row{items.length === 1 ? '' : 's'}
                      {doneCount > 0 && <> and the {doneCount} generated image{doneCount === 1 ? '' : 's'} (not exported anywhere yet)</>}
                      . The brief stays loaded; your CSV file on disk is untouched — drop it
                      again to rebuild the rows.
                    </>
                  }
                />
              </CanvasToolbar>
              <GenGrid
                items={items}
                promptFor={promptFor}
                size={size}
                running={busy}
                selected={sel.checked}
                onOpen={setOpenId}
                onRemove={handleRemove}
                onToggleSelect={sel.toggle}
              />
              {sel.active && (
                <SelectionBar
                  count={sel.checked.size}
                  total={items.length}
                  allSelected={sel.allSelected}
                  busy={busy}
                  actions={[
                    {
                      key: 'regenerate',
                      label: 'Regenerate selected — edit the prompt, then send each row to Azure again',
                      icon: RefreshCwIcon,
                      accent: true,
                      onRun: () => setBatchPromptOpen(true),
                    },
                  ]}
                  deleteTitle={`Delete ${sel.checked.size} row${sel.checked.size === 1 ? '' : 's'}?`}
                  deleteDescription="Removes them from this run, along with any images they generated. Rows still in the CSV file come back if you drop it again."
                  onDelete={deleteSelected}
                  onSelectAll={sel.selectAll}
                  onClear={sel.clear}
                />
              )}
            </>
          )}
        </Canvas>

        <RightPanel
          title="Process & export"
          footer={exportFooter}
        >
          {proc.panel}
          <PanelSection>
          <FieldGroup className="gap-4">
                <Field orientation="horizontal">
                  <Checkbox
                    id="gen-number-files"
                    checked={numberFiles}
                    disabled={busy}
                    onCheckedChange={(checked) => setNumberFiles(checked === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="gen-number-files" className="font-normal">
                      Number exported files
                    </FieldLabel>
                    <FieldDescription>
                      {numberFiles
                        ? 'Files are named 01-name.png.'
                        : 'Files use the name alone; repeats get -2, -3 so nothing is overwritten.'}
                    </FieldDescription>
                  </FieldContent>
                </Field>
          </FieldGroup>
          </PanelSection>
        </RightPanel>
      </StudioShell>

      {/* A row's prompt is brief + its own cells, so a selection has no single "current" text.
          The brief is what they share, and what an override replaces for this run. */}
      <BatchPromptDialog
        open={batchPromptOpen}
        onOpenChange={setBatchPromptOpen}
        defaultPrompt={brief}
        count={sel.checked.size}
        noun="row"
        actionLabel="Regenerate"
        busy={busy}
        excludedNote="An edit here replaces the whole prompt for this run — the row's CSV cells are not appended to it."
        source={{
          // Named for what the cell above calls it, not a synonym invented for this control.
          latestLabel: 'Generated image',
          originalLabel: 'Text only',
          // Offered as soon as ANY selected row has an image to build on; rows without one
          // resolve to text-only at send time rather than being skipped.
          hasLatest: regenEditableCount > 0,
          hasOriginal: true,
          note: regenEditableCount === sel.checked.size
            ? 'Sending the image edits what is already there; text only re-runs the prompt from scratch.'
            : `${regenEditableCount} of ${sel.checked.size} have an image to build on; the rest re-run the prompt from scratch either way.`,
        }}
        onRun={(p, from) => void handleRegenerateSelected(p, from)}
      />

      <GenDialog
        item={openItem}
        previewPrompt={openItem ? promptFor(openItem) : ''}
        size={size}
        running={busy}
        onClose={() => setOpenId(null)}
        onRegenerate={handleRegenerate}
        onUndo={undoItem}
      />

      {/* Brief editor — the .md tile in the Input card opens this. */}
      <Dialog open={briefEditorOpen} onOpenChange={setBriefEditorOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MdFileIcon className="size-4 text-muted-foreground" />
              {briefLabel ?? 'brief.md'}
            </DialogTitle>
            <DialogDescription>
              The brief leads every row&rsquo;s prompt. Edits apply to the next run — rows
              already generated keep the prompt they were built from.
            </DialogDescription>
          </DialogHeader>
          {/* Capped: the textarea auto-grows with content (field-sizing-content), so a long
              brief would otherwise push the dialog past the viewport. */}
          <Textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={16}
            disabled={busy}
            aria-label="Markdown brief"
            className="max-h-[55dvh] min-h-40 overflow-y-auto text-xs"
          />
          <DialogFooter>
            <Button onClick={() => setBriefEditorOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
