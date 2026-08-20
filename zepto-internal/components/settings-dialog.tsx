'use client';

// Suite settings — one modal, opened from the rail's gear, with a Figma-style side nav.
//
// API keys: writes the SHARED persisted keys (skuc_azureEndpoint / skuc_azureKey). Every
// mounted product picks a change up live through use-persisted-state's sync event, which is
// what let the per-product key fields be deleted from the panels.
// Usage: the token ledger lib/usage.ts accumulates from Azure's per-response usage block;
// this pane is a live subscriber, so totals tick up while runs are in flight.

import * as React from 'react';
import {
  ChartColumnIcon, CodeIcon, CopyIcon, DownloadIcon, EyeIcon, KeyRoundIcon, LockIcon,
  PencilIcon, PlugZapIcon, PlusIcon,
  Settings2Icon, SlidersHorizontalIcon, SparklesIcon, Trash2Icon, UploadIcon,
} from 'lucide-react';

import { TAG_DOTS } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hint } from '@/components/hint';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Markdown } from '@/components/markdown';
import {
  Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle,
} from '@/components/ui/item';
import { MdFileIcon, SkillTagBadge } from '@/components/md-file-tile';
import { SkillTagPicker, tagsInUse } from '@/components/skill-tag-picker';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider,
} from '@/components/ui/sidebar';
import { pickSave, saveTo } from '@/lib/bg/batch';
import { buildZipStream } from '@/lib/zip';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { DEFAULT_SEAL_SIZE } from '@/lib/bg/ledger';
import {
  TAG_COLORS, diffStat, newSkillId, useSkills,
  type PromptSkill, type SkillTag, type TagColor,
} from '@/lib/skills';
import { azureImageUrl } from '@/lib/pipeline';
import { QUALITIES, QUALITY_BLURB, useImageQuality, type ImageQuality } from '@/lib/quality';
import { PARALLEL_MAX, RPM_MAX, clampParallel, clampRpm, useParallel, useRpm } from '@/lib/rate';
import {
  PRICE_USD_PER_MTOK, PRICING_ASOF, USAGE_KEY, USD_TO_INR, costUsd, dayKey,
  emptyLedger, formatInr, resetUsage, type UsageLedger, type UsageTotals,
} from '@/lib/usage';
import { cn } from '@/lib/utils';

type SettingsTab = 'api-keys' | 'image-model' | 'skills' | 'defaults' | 'usage';

const TABS: { id: SettingsTab; label: string; icon: typeof KeyRoundIcon }[] = [
  { id: 'api-keys', label: 'API keys', icon: KeyRoundIcon },
  { id: 'image-model', label: 'Image model', icon: SlidersHorizontalIcon },
  { id: 'skills', label: 'Skills', icon: SparklesIcon },
  { id: 'defaults', label: 'Defaults', icon: Settings2Icon },
  { id: 'usage', label: 'Usage', icon: ChartColumnIcon },
];

/** A pane's own title. One definition so the five panes cannot drift apart. */
function PaneHeading({ children, className }: { children: React.ReactNode; className?: string }) {
  return <h2 className={cn('text-sm font-semibold', className)}>{children}</h2>;
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = React.useState<SettingsTab>('api-keys');
  const paneTitle = TABS.find((t) => t.id === tab)?.label;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No title bar. "Settings" is the rail's group label — the word belongs with the list it
          heads, and a full-width bar spent a row restating what the open modal already is. The
          pane's own heading is then the first thing in the content, which is what the eye is
          actually looking for. DialogContent keeps its own close button, floating top-right. */}
      <DialogContent className="max-h-[calc(100dvh-3rem)] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Suite-wide settings: API keys, image model, skills, defaults and token usage.
        </DialogDescription>
        {/* min-w-0: DialogContent lays children on a grid whose track sizes to max-content;
            without this, one long unwrappable line (a skill's preview) widens the whole pane.
            The nav is the real shadcn Sidebar embedded non-collapsible, per its settings-dialog
            pattern — same component as an app shell, so hover/active states match the suite. */}
        <SidebarProvider className="h-[500px] max-h-full min-h-0 min-w-0 items-start" style={{ '--sidebar-width': '13rem' } as React.CSSProperties}>
          <Sidebar collapsible="none" className="h-auto self-stretch border-r">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>Settings</SidebarGroupLabel>
                <SidebarGroupContent>
                  {/* gap-1 over the primitive's gap-0: the rail's five items are the modal's
                      only navigation, and packed flush they read as one block rather than five
                      targets. */}
                  <SidebarMenu className="gap-1">
                    {TABS.map(({ id, label, icon: Icon }) => (
                      <SidebarMenuItem key={id}>
                        <SidebarMenuButton isActive={tab === id} onClick={() => setTab(id)}>
                          <Icon />
                          {label}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <div className="flex min-w-0 flex-1 flex-col self-stretch">
            {/* Skills scrolls internally so its footer can sit OUTSIDE the scrollport — a
                footer inside it is overrun by the scrollbar, which has to span the full
                scrollable height. Every other pane scrolls here and keeps the shared inset. */}
            <div
              className={cn(
                'min-h-0 flex-1',
                tab === 'skills' ? 'overflow-hidden' : 'overflow-y-auto p-6',
              )}
            >
              {/* The heading scrolls with its pane rather than being pinned: it names the
                  content, and content is what moves. */}
              {tab !== 'skills' && <PaneHeading className="mb-4 pr-8">{paneTitle}</PaneHeading>}
              {tab === 'api-keys' && <ApiKeysPane />}
              {tab === 'image-model' && <ImageModelPane />}
              {tab === 'skills' && <SkillsPane heading={<PaneHeading className="pr-8">{paneTitle}</PaneHeading>} />}
              {tab === 'defaults' && <DefaultsPane />}
              {tab === 'usage' && <UsagePane />}
            </div>
          </div>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok' }
  | { phase: 'failed'; message: string };

function ApiKeysPane() {
  const [endpoint, setEndpoint] = usePersistedState('skuc_azureEndpoint', '');
  const [azureKey, setAzureKey] = usePersistedState('skuc_azureKey', '');
  const resolved = azureImageUrl(endpoint, 'edits');
  const [test, setTest] = React.useState<TestState>({ phase: 'idle' });

  async function testConnection() {
    setTest({ phase: 'testing' });
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'ping', endpoint, apiKey: azureKey }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) setTest({ phase: 'ok' });
      else setTest({ phase: 'failed', message: json.error || `Failed (${res.status})` });
    } catch (e) {
      setTest({ phase: 'failed', message: (e as Error).message });
    }
  }

  // The host actually called, compressed to one line — the full URL is already sitting in the
  // input above it, so repeating it as a monospace paragraph only added noise.
  const resolvedHost = React.useMemo(() => {
    if (!resolved) return null;
    try {
      return new URL(resolved).host;
    } catch {
      return null;
    }
  }, [resolved]);

  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor="settings-endpoint">
          <Hint hint="Only the resource host is used — each product appends its own path (/openai/v1/images/edits or /generations), so any image URL pasted from the Azure portal works.">
            Azure resource
          </Hint>
        </FieldLabel>
        <Input
          id="settings-endpoint"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://<resource>.services.ai.azure.com"
        />
        {resolvedHost && (
          <FieldDescription className="truncate font-mono text-[11px]">
            → {resolvedHost}
          </FieldDescription>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-key">
          <Hint hint="Shared by every product — AI edit, AI-fix flagged and Generate.">
            Azure API key
          </Hint>
        </FieldLabel>
        <Input
          id="settings-key"
          type="password"
          value={azureKey}
          onChange={(e) => setAzureKey(e.target.value)}
          placeholder="Azure OpenAI key"
        />
      </Field>
      <div className="flex items-center gap-3 border-t pt-3">
        {/* Write-through fields need no Save — but the check that used to cost a failed paid
            run (bad key discovered mid-batch) is worth a button. */}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={test.phase === 'testing' || !endpoint.trim() || !azureKey.trim()}
          onClick={() => void testConnection()}
        >
          {test.phase === 'testing' ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PlugZapIcon data-icon="inline-start" />
          )}
          Test connection
        </Button>
        {/* One line, always — long failure details go in the native tooltip via title. */}
        <span
          title={
            test.phase === 'ok'
              ? 'Verifies the host and key. Whether gpt-image-2 is deployed on the resource is only proven by a real run.'
              : test.phase === 'failed'
                ? test.message
                : undefined
          }
          className={cn(
            'min-w-0 flex-1 truncate text-xs',
            test.phase === 'ok' && 'text-green-600 dark:text-green-500',
            test.phase === 'failed' && 'text-destructive',
            (test.phase === 'idle' || test.phase === 'testing') && 'text-muted-foreground',
          )}
        >
          {test.phase === 'idle' && 'Changes save as you type.'}
          {test.phase === 'testing' && 'Checking host and key…'}
          {test.phase === 'ok' && 'Credentials accepted.'}
          {test.phase === 'failed' && test.message}
        </span>
      </div>
    </FieldGroup>
  );
}

function ImageModelPane() {
  const [quality, setQuality] = useImageQuality();
  const [parallel, setParallel] = useParallel();
  const [rpm, setRpm] = useRpm();
  return (
    <FieldGroup className="gap-4">
      <Field>
        <FieldLabel htmlFor="settings-quality">
          <Hint hint="One knob for the whole suite — Compose tiles, Cleanup AI fixes and Generate all send this on every Azure call.">
            Image quality
          </Hint>
        </FieldLabel>
        <Select
          value={quality}
          onValueChange={(v) => setQuality(String(v ?? quality) as ImageQuality)}
        >
          <SelectTrigger id="settings-quality" className="w-40 capitalize">
            <SelectValue>{(v) => String(v ?? quality)}</SelectValue>
          </SelectTrigger>
          {/* Drop below the trigger like a menu — the default item-aligned mode opens the
              list OVER the field, hiding the label whenever medium/high is selected. */}
          <SelectContent alignItemWithTrigger={false} sideOffset={4}>
            {QUALITIES.map((q) => (
              <SelectItem key={q} value={q} className="capitalize">{q}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{QUALITY_BLURB[quality]}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-parallel">
          <Hint hint="How many Azure calls run at once — Compose tiles, Generate rows and Cleanup AI fixes all fan out this wide. Applies from the next run.">
            Parallel requests
          </Hint>
        </FieldLabel>
        <Input
          id="settings-parallel"
          type="number"
          min={1}
          max={PARALLEL_MAX}
          className="w-40"
          value={parallel}
          onChange={(e) => setParallel(clampParallel(Number(e.target.value)))}
        />
        <FieldDescription>
          Raise it until the deployment&rsquo;s rate limit pushes back (429s), then step down
          one — or set a request budget below instead.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="settings-rpm">
          <Hint hint="One budget shared by every product in this tab — a run in Compose and a run in Generate draw from the same window. Counted per tab, like the usage ledger.">
            Requests per minute
          </Hint>
        </FieldLabel>
        <Input
          id="settings-rpm"
          type="number"
          min={0}
          max={RPM_MAX}
          className="w-40"
          value={rpm === 0 ? '' : rpm}
          placeholder="Unlimited"
          onChange={(e) => setRpm(clampRpm(e.target.value === '' ? 0 : Number(e.target.value)))}
        />
        <FieldDescription>
          {rpm === 0
            ? 'No throttle — products only cap how many requests run at once.'
            : `Calls beyond ${rpm}/min wait their turn instead of erroring. Match your Azure deployment's rate limit to avoid 429s.`}
        </FieldDescription>
      </Field>
      <p className="border-t pt-3 text-[11px] text-muted-foreground">
        Applies from the next request — runs already in flight keep the value they started with.
        Higher quality costs more output tokens per image (see Usage).
      </p>
    </FieldGroup>
  );
}

function DefaultsPane() {
  // Same persisted keys Cleanup's save and seal flows read — both settings moved here from the
  // page. DEFAULT_SEAL_SIZE is imported rather than retyped as 500: the page seeds its own state
  // from that constant, so a literal here would drift the moment the constant moves and the
  // dialog would show a number the run is not using.
  const [saveOriginals, setSaveOriginals] = usePersistedState('skuc_bgSaveOriginals', true);
  const [sealSize, setSealSize] = usePersistedState('skuc_bgSealSize', DEFAULT_SEAL_SIZE);
  return (
    // Groups run in the order their settings bite. Batch size shapes what arrives DURING a run —
    // it is set before starting 14,000 images and changes delivery for the next several hours —
    // while project contents only matter once someone chooses to save afterwards.
    <div className="space-y-5">
      <div className="space-y-3">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Batches (.zip)</h3>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="settings-seal-size" className="font-normal">
              <Hint hint="Cleanup groups clean results into a downloadable ZIP each time this many have landed, so a long run delivers throughout instead of one file at the end. Flagged images are never sealed — they wait for the AI fix and ship with the rest.">
                Clean images per batch
              </Hint>
            </FieldLabel>
          </FieldContent>
          <Input
            id="settings-seal-size"
            type="number"
            min={1}
            step={50}
            className="w-24"
            value={sealSize}
            onChange={(e) => {
              // An emptied field parses to NaN, which passes every threshold comparison and
              // switches sealing off for the rest of a run — nothing throws, and the only symptom
              // is ZIPs that stop arriving. NaN cannot survive JSON either, so it would persist
              // as null and come back as null on every later mount.
              const next = Number.parseInt(e.target.value, 10);
              setSealSize(Number.isFinite(next) && next > 0 ? next : DEFAULT_SEAL_SIZE);
            }}
          />
        </Field>
      </div>
      <div className="space-y-3">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Projects (.zesku)</h3>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="settings-save-originals" className="font-normal">
              <Hint hint="Embeds the dropped input files in saved projects so reopening restores them — original view, Redo and AI edit keep working. Off keeps only cutouts and URLs for a smaller file.">
                Include original images
              </Hint>
            </FieldLabel>
          </FieldContent>
          <Switch
            id="settings-save-originals"
            checked={saveOriginals}
            onCheckedChange={(checked) => setSaveOriginals(checked === true)}
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * A skill's file name on disk. The stored name is already file-shaped ("shelf-composite.md"),
 * so this only has to survive a save dialog: strip what a filesystem will not take, and put the
 * extension back if stripping or a rename removed it.
 */
function skillFileName(name: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '') || 'skill';
  return /\.(md|markdown|txt)$/i.test(safe) ? safe : `${safe}.md`;
}

/** The .md itself — what Upload takes back in, so a download round-trips. */
function skillBlob(skill: PromptSkill): Blob {
  return new Blob([skill.content], { type: 'text/markdown;charset=utf-8' });
}

function SkillsPane({ heading }: { heading?: React.ReactNode }) {
  const { skills, setCustom } = useSkills();
  const fileRef = React.useRef<HTMLInputElement>(null);
  // The editor dialog's draft. `fresh` = not yet in the list, so Cancel leaves no trace.
  // `original` snapshots name+content as the editor opened: the diff chip renders against it,
  // and an unchanged save keeps the stored updatedAt instead of restamping.
  const [draft, setDraft] = React.useState<{
    skill: PromptSkill;
    fresh: boolean;
    original: { name: string; content: string; tag?: SkillTag };
  } | null>(null);
  const stat = draft ? diffStat(draft.original.content, draft.skill.content) : null;
  // Built-ins carry no tag, but they are in the list on purpose: the day they can be tagged,
  // their tags are suggestions too, and nothing here has to change.
  const tagOptions = React.useMemo(() => tagsInUse(skills), [skills]);
  const [docView, setDocView] = React.useState<'preview' | 'source'>('preview');
  const gutterRef = React.useRef<HTMLDivElement>(null);
  const lineCount = React.useMemo(
    () => (draft?.skill.content ?? '').split('\n').length,
    [draft?.skill.content],
  );

  function saveDraft() {
    if (!draft) return;
    const name = draft.skill.name.trim() || 'untitled.md';
    // A tag IS its label: blank means no tag, so picking a colour and then clearing the name
    // leaves nothing behind rather than an empty pill nobody can see or get rid of.
    const label = draft.skill.tag?.label.trim() ?? '';
    const tag: SkillTag | undefined =
      label && draft.skill.tag ? { label, color: draft.skill.tag.color } : undefined;
    const changed =
      draft.fresh ||
      draft.skill.content !== draft.original.content ||
      name !== draft.original.name ||
      tag?.label !== draft.original.tag?.label ||
      tag?.color !== draft.original.tag?.color;
    const skill: PromptSkill = {
      ...draft.skill,
      name,
      tag,
      ...(changed ? { updatedAt: new Date().toISOString() } : null),
    };
    setCustom((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      const at = list.findIndex((s) => s.id === skill.id);
      if (at === -1) return [...list, skill];
      const next = [...list];
      next[at] = skill;
      return next;
    });
    setDraft(null);
  }

  async function downloadSkill(skill: PromptSkill) {
    const fileName = skillFileName(skill.name);
    const dest = await pickSave(fileName);
    if (dest === 'cancelled') return;
    await saveTo(dest, skillBlob(skill), fileName);
  }

  /**
   * Every skill as one .md apiece inside a ZIP. Repeated names get -2, -3 rather than
   * overwriting each other — nothing in the list forbids two skills sharing a name.
   */
  async function downloadAll() {
    const zipName = 'zesku-skills.zip';
    const dest = await pickSave(zipName);
    if (dest === 'cancelled') return;
    const used = new Map<string, number>();
    const files = skills.map((skill) => {
      const base = skillFileName(skill.name);
      const seen = (used.get(base) ?? 0) + 1;
      used.set(base, seen);
      const name = seen === 1 ? base : base.replace(/(\.[^.]+)$/, `-${seen}$1`);
      return { name, data: skillBlob(skill) };
    });
    await saveTo(dest, await buildZipStream(files), zipName);
  }

  function removeSkill(id: string) {
    setCustom((prev) => (Array.isArray(prev) ? prev.filter((s) => s.id !== id) : []));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-6">
        {heading}
      <ItemGroup className="gap-2.5">
        {skills.map((skill) => (
          // shadcn's Item, not a bespoke div — same primitive MdFileTile uses, so a skill row
          // in Settings and a prompt tile in a panel are the same object.
          <Item key={skill.id} variant="outline" size="sm">
            <ItemMedia variant="icon">
              <MdFileIcon className="text-muted-foreground" />
            </ItemMedia>
            <ItemContent className="min-w-0 gap-0">
              <ItemTitle className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{skill.name}</span>
                {skill.tag?.label.trim() && <SkillTagBadge tag={skill.tag} />}
              </ItemTitle>
              <ItemDescription className="truncate">
                {/* Custom skills show when they last changed; built-ins (and skills saved
                    before updatedAt existed) keep the first-line preview. */}
                {skill.updatedAt
                  ? `Updated ${new Date(skill.updatedAt).toLocaleString(undefined, {
                      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}`
                  : skill.content.split('\n').find((l) => l.trim()) || 'Empty'}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
            {/* Download sits on every row, built-in included: a built-in is exactly what you
                want a copy of to hand to someone or keep alongside a batch. */}
            <Button
              variant="ghost"
              size="icon-sm"
              title="Download as .md"
              onClick={() => void downloadSkill(skill)}
            >
              <DownloadIcon />
            </Button>
            {skill.builtin ? (
              <>
                {/* A lock, not the word "Built-in". The word restated a label the pane's own
                    description already gives, and it sat in the row's action column where
                    everything else is a 32px icon — so the built-in rows' controls lined up
                    against nothing. What it has to convey is "read-only", which is what a lock
                    says without spending a column on it. */}
                <span
                  role="img"
                  aria-label="Built-in, read-only"
                  title="Built-in — read-only. Duplicate it to make an editable copy."
                  className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
                >
                  <LockIcon className="size-3.5" />
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Duplicate into an editable copy"
                  onClick={() => {
                    const name = skill.name.replace(/\.md$/, '') + '-copy.md';
                    setDraft({
                      fresh: true,
                      skill: { id: newSkillId(), name, content: skill.content },
                      original: { name, content: skill.content },
                    });
                  }}
                >
                  <CopyIcon />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Edit"
                  onClick={() =>
                    {
                      setDocView('preview');
                      setDraft({
                        fresh: false,
                        skill,
                        original: { name: skill.name, content: skill.content, tag: skill.tag },
                      });
                    }
                  }
                >
                  <PencilIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Delete"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => removeSkill(skill.id)}
                >
                  <Trash2Icon />
                </Button>
              </>
            )}
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      {/* Footer. The scroll container is the settings pane itself (p-6, overflow-y-auto),
          so `bottom-0` pins to the scrollport while the skill list runs under it. The negative
          margins let it span the pane's full width and sit flush in its bottom padding rather
          than floating inset, and bg-popover matches DialogContent so rows genuinely disappear
          beneath it instead of showing through. */}
      </div>
      {/* Outside the scroller: the list's scrollbar now ends at this bar instead of running
          down behind it. */}
      <div className="flex shrink-0 items-center gap-2 border-t px-6 py-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            {
              setDocView('source');
              setDraft({
                fresh: true,
                skill: { id: newSkillId(), name: 'new-skill.md', content: '' },
                original: { name: 'new-skill.md', content: '' },
              });
            }
          }
        >
          <PlusIcon data-icon="inline-start" />
          New skill
        </Button>
        {/* Upload lands in the editor for review, not straight into the list — a wrong file
            should be caught before it becomes a selectable skill. */}
        <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          <UploadIcon data-icon="inline-start" />
          Upload .md
        </Button>
        {/* The mirror of Upload, so the pair reads as one round trip. */}
        <Button
          variant="outline"
          size="sm"
          disabled={skills.length === 0}
          title="Every skill as a .md inside one ZIP"
          onClick={() => void downloadAll()}
        >
          <DownloadIcon data-icon="inline-start" />
          Download all
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            void file.text().then((content) => {
              const name = /\.(md|markdown|txt)$/i.test(file.name)
                ? file.name.replace(/\.(markdown|txt)$/i, '.md')
                : `${file.name}.md`;
              setDraft({
                fresh: true,
                skill: { id: newSkillId(), name, content },
                original: { name, content },
              });
            });
          }}
        />
      </div>


      {/* Stacked intentionally, like Claude's Upload-skill over Settings: the editor is a
          focused layer with its own backdrop dim; narrower than Settings so the elevation
          reads. Base UI nests dialogs cleanly — Escape and the X close only this layer. */}
      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="sm:max-w-3xl" forceOverlay>
          {draft && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MdFileIcon className="size-4 text-muted-foreground" />
                  {draft.fresh ? 'New skill' : 'Edit skill'}
                </DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="skill-name">Name</FieldLabel>
                  <Input
                    id="skill-name"
                    value={draft.skill.name}
                    onChange={(e) => setDraft({ ...draft, skill: { ...draft.skill, name: e.target.value } })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="skill-tag">Tag</FieldLabel>
                  {/* One control, not two fields: the colour belongs to the tag, so it rides in
                      the same bordered group as an end addon instead of taking a row of eight
                      swatches below. The addon appears only once there is a tag to colour —
                      before that it is a control that cannot change anything. */}
                  <InputGroup>
                    <SkillTagPicker
                      id="skill-tag"
                      value={draft.skill.tag}
                      options={tagOptions}
                      onChange={(tag) => setDraft({ ...draft, skill: { ...draft.skill, tag } })}
                      className="h-full w-auto min-w-0 flex-1 border-0 bg-transparent pr-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
                    />
                    {draft.skill.tag?.label.trim() && (
                      <InputGroupAddon align="inline-end" className="shrink-0 pr-1.5 has-[>button]:mr-0">
                        <Select
                          value={draft.skill.tag.color}
                          onValueChange={(next) => {
                            const color = String(next ?? '') as TagColor;
                            if (!TAG_COLORS.includes(color) || !draft.skill.tag) return;
                            setDraft({
                              ...draft,
                              skill: { ...draft.skill, tag: { ...draft.skill.tag, color } },
                            });
                          }}
                        >
                          <SelectTrigger
                            aria-label="Tag colour"
                            className="h-6 w-auto gap-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
                          >
                            <SelectValue>
                              {(value) => (
                                <span className="flex items-center gap-1.5">
                                  <span
                                    className={cn(
                                      'size-3 shrink-0 rounded-full',
                                      TAG_DOTS[value as TagColor] ?? TAG_DOTS.slate,
                                    )}
                                  />
                                  <span className="truncate capitalize">{String(value)}</span>
                                </span>
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent align="end">
                            {TAG_COLORS.map((color) => (
                              <SelectItem key={color} value={color}>
                                <span className="flex items-center gap-2">
                                  <span className={cn('size-3 rounded-full', TAG_DOTS[color])} />
                                  <span className="capitalize">{color}</span>
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </InputGroupAddon>
                    )}
                  </InputGroup>
                </Field>
              </div>
              {/* The document, framed, with its own view control in the corner — the shape a
                  skill is actually read in. Preview is the default because a skill is read far
                  more often than it is written; the source view is one click away and is the
                  only editable one, so there is never a question about which mode is which. */}
              <div className="relative overflow-hidden rounded-lg border">
                <div className="absolute top-2 right-2 z-10">
                  <ToggleGroup
                    value={[docView]}
                    onValueChange={(next) => {
                      const v = next[0];
                      if (v === 'preview' || v === 'source') setDocView(v);
                    }}
                    variant="outline"
                    size="sm"
                    spacing={0}
                  >
                    <ToggleGroupItem value="preview" aria-label="Preview" title="Preview">
                      <EyeIcon />
                    </ToggleGroupItem>
                    <ToggleGroupItem value="source" aria-label="Edit source" title="Edit source">
                      <CodeIcon />
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                {docView === 'preview' ? (
                  <div className="max-h-[52dvh] min-h-64 overflow-y-auto p-4 pr-24">
                    {draft.skill.content.trim() ? (
                      <Markdown source={draft.skill.content} className="space-y-3 text-sm" />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Nothing written yet — switch to the source view to start.
                      </p>
                    )}
                  </div>
                ) : (
                  // Gutter + source, scrolled as one. The numbers are a plain column beside the
                  // textarea because a textarea cannot have one of its own.
                  //
                  // wrap="off" is what makes them TRUE: with soft wrapping, one logical line can
                  // occupy three visual rows and every number below it points at the wrong text.
                  // The cost is horizontal scrolling on long prose lines; a gutter that lies is
                  // the worse trade.
                  <div className="flex max-h-[52dvh] min-h-64">
                    <div
                      ref={gutterRef}
                      aria-hidden
                      className="shrink-0 overflow-hidden border-r bg-muted/30 py-3 text-right font-mono text-xs leading-5 text-muted-foreground/60 select-none"
                    >
                      {Array.from({ length: lineCount }, (_, i) => (
                        <div key={i} className="px-2">{i + 1}</div>
                      ))}
                    </div>
                    <Textarea
                      value={draft.skill.content}
                      onChange={(e) => setDraft({ ...draft, skill: { ...draft.skill, content: e.target.value } })}
                      onScroll={(e) => {
                        // The gutter has no scrollbar of its own; it follows the source's.
                        if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                      }}
                      wrap="off"
                      placeholder="The prompt this skill carries…"
                      aria-label="Skill prompt"
                      // Borderless, and leading-5/py-3 matched to the gutter — the two columns
                      // only line up if their line box and top inset are identical.
                      className="min-h-0 flex-1 resize-none rounded-none border-0 py-3 pr-24 font-mono text-xs leading-5 shadow-none focus-visible:ring-0"
                    />
                  </div>
                )}
              </div>
              <DialogFooter>
                {/* Git-style stat against the content the editor opened with — appears only
                    once something actually changed. */}
                {stat && (stat.added > 0 || stat.removed > 0) && (
                  <span
                    className="mr-auto self-center font-mono text-xs"
                    aria-label={`${stat.added} lines added, ${stat.removed} lines removed`}
                  >
                    <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>{' '}
                    <span className="text-red-600 dark:text-red-400">−{stat.removed}</span>
                  </span>
                )}
                <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
                <Button onClick={saveDraft} disabled={!draft.skill.content.trim()}>Save</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

const MODE_LABELS: Record<'edits' | 'generations', string> = {
  edits: 'AI edits (Compose · Cleanup)',
  generations: 'Generations (Generate)',
};

/** Days in the selected window, newest last. 'all' is the whole calendar the ledger retains. */
type UsageRange = 'all' | '30d' | '7d';
const RANGE_DAYS: Record<UsageRange, number> = { all: 182, '30d': 35, '7d': 7 };

/**
 * Activity as a week grid — GitHub's shape, sized to the selected window so it never needs to
 * scroll. Columns are calendar weeks, rows are days of the week.
 *
 * Colour is SEQUENTIAL: one hue, four rising steps plus an empty step, keyed to the busiest day
 * in the WHOLE ledger rather than in the window — otherwise every window would renormalise to
 * its own maximum and switching range would silently redefine what "dark" means.
 */
function UsageHeatmap({
  byDay,
  days,
  busiest,
}: {
  byDay: Record<string, UsageTotals>;
  days: number;
  busiest: number;
}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1) - today.getDay());

  const weeks: { key: string; date: Date; totals: UsageTotals | null }[][] = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const week: { key: string; date: Date; totals: UsageTotals | null }[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(cursor);
      week.push({ key: dayKey(date), date, totals: byDay[dayKey(date)] ?? null });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  const step = (t: UsageTotals | null) => {
    if (!t || t.requests === 0) return 'bg-foreground/10';
    const q = busiest > 0 ? Math.ceil((t.requests / busiest) * 4) : 1;
    return ['bg-primary/30', 'bg-primary/50', 'bg-primary/75', 'bg-primary'][Math.min(q, 4) - 1];
  };
  const label = (d: Date) =>
    d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="flex flex-wrap gap-[3px]">
      {weeks.map((week, w) => (
        <div key={w} className="flex w-3 shrink-0 flex-col gap-[3px]">
          {week.map((day) => (
            <div
              key={day.key}
              // Data, not a control: the title reads it out, and the Products table is the same
              // numbers for anyone not using a pointer.
              title={
                day.date > today
                  ? undefined
                  : day.totals
                    ? `${label(day.date)} — ${day.totals.requests.toLocaleString()} requests · ${formatInr(costUsd(day.totals))}`
                    : `${label(day.date)} — no calls`
              }
              className={cn(
                'size-3 rounded-[3px]',
                day.date > today ? 'bg-transparent' : step(day.totals),
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function UsagePane() {
  const [ledger] = usePersistedState<UsageLedger>(USAGE_KEY, emptyLedger());
  const [view, setView] = React.useState<'overview' | 'products'>('overview');
  const [range, setRange] = React.useState<UsageRange>('all');
  const modes = ['edits', 'generations'] as const;
  const byDay = React.useMemo(() => ledger.byDay ?? {}, [ledger.byDay]);

  const allTime = modes.reduce(
    (acc, m) => {
      const t = ledger.byMode[m] ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
      return {
        requests: acc.requests + t.requests,
        inputTokens: acc.inputTokens + t.inputTokens,
        outputTokens: acc.outputTokens + t.outputTokens,
      };
    },
    { requests: 0, inputTokens: 0, outputTokens: 0 },
  );

  const stats = React.useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowDays = range === 'all' ? Number.POSITIVE_INFINITY : range === '30d' ? 30 : 7;

    const inWindow: UsageTotals[] = [];
    const activeKeys = new Set<string>();
    for (const [key, totals] of Object.entries(byDay)) {
      if (totals.requests === 0) continue;
      const [y, m, d] = key.split('-').map(Number);
      const age = Math.round((today.getTime() - new Date(y, m - 1, d).getTime()) / 86400000);
      if (age < windowDays) {
        inWindow.push(totals);
        activeKeys.add(key);
      }
    }

    // Streaks walk backwards a day at a time — the only way to count consecutive days without
    // assuming the map is dense.
    let current = 0;
    for (let i = 0; ; i++) {
      const probe = new Date(today);
      probe.setDate(probe.getDate() - i);
      if (!(byDay[dayKey(probe)]?.requests ?? 0)) {
        // Today not yet used is a pause, not a broken streak; anything earlier ends it.
        if (i === 0) continue;
        break;
      }
      current++;
    }
    let longest = 0;
    let run = 0;
    const sorted = Object.keys(byDay)
      .filter((k) => byDay[k].requests > 0)
      .sort();
    let prev: number | null = null;
    for (const key of sorted) {
      const [y, m, d] = key.split('-').map(Number);
      const t = new Date(y, m - 1, d).getTime();
      run = prev !== null && t - prev === 86400000 ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = t;
    }

    const windowed = inWindow.reduce(
      (acc, t) => ({
        requests: acc.requests + t.requests,
        inputTokens: acc.inputTokens + t.inputTokens,
        outputTokens: acc.outputTokens + t.outputTokens,
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0 },
    );

    return {
      // 'all' reports the true lifetime figure from byMode; the day map only goes back to when
      // daily recording started, so using it for "all" would quietly under-report.
      totals: range === 'all' ? allTime : windowed,
      activeDays: activeKeys.size,
      currentStreak: current,
      longestStreak: longest,
      busiestDay: Math.max(0, ...Object.values(byDay).map((t) => t.requests)),
    };
  }, [byDay, range, allTime]);

  const n = (v: number) => v.toLocaleString();
  const compact = (v: number) =>
    v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${v}`;
  const busierMode =
    (ledger.byMode.edits?.requests ?? 0) >= (ledger.byMode.generations?.requests ?? 0)
      ? 'AI edits'
      : 'Generations';

  const tiles = [
    { label: 'Requests', value: n(stats.totals.requests) },
    { label: 'Tokens', value: compact(stats.totals.inputTokens + stats.totals.outputTokens) },
    { label: 'Est. cost', value: formatInr(costUsd(stats.totals)) },
    { label: 'Active days', value: n(stats.activeDays) },
    { label: 'Current streak', value: `${stats.currentStreak}d` },
    { label: 'Longest streak', value: `${stats.longestStreak}d` },
    { label: 'Busiest day', value: `${n(stats.busiestDay)} reqs` },
    { label: 'Most used', value: busierMode },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          value={[view]}
          onValueChange={(next) => {
            const v = next[0];
            if (v === 'overview' || v === 'products') setView(v);
          }}
          variant="outline"
          size="sm"
          spacing={0}
        >
          <ToggleGroupItem value="overview">Overview</ToggleGroupItem>
          <ToggleGroupItem value="products">Products</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          className="ml-auto"
          value={[range]}
          onValueChange={(next) => {
            const v = next[0];
            if (v === 'all' || v === '30d' || v === '7d') setRange(v);
          }}
          variant="outline"
          size="sm"
          spacing={0}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="30d">30d</ToggleGroupItem>
          <ToggleGroupItem value="7d">7d</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {view === 'overview' ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tiles.map((tile) => (
              <Card key={tile.label} size="sm" className="gap-0.5 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{tile.label}</div>
                <div className="truncate text-base tabular-nums">{tile.value}</div>
              </Card>
            ))}
          </div>

          <UsageHeatmap byDay={byDay} days={RANGE_DAYS[range]} busiest={stats.busiestDay} />

          {stats.busiestDay > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Requests and cost are lifetime totals; active days and streaks count only days
              recorded since daily history began
              {ledger.since ? ` on ${new Date(ledger.since).toLocaleDateString()}` : ''}.
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3 font-normal">Mode</th>
                <th className="py-2 pr-3 text-right font-normal">Requests</th>
                <th className="py-2 pr-3 text-right font-normal">Tokens in</th>
                <th className="py-2 pr-3 text-right font-normal">Tokens out</th>
                <th className="py-2 text-right font-normal">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {modes.map((m) => {
                const t = ledger.byMode[m] ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
                return (
                  <tr key={m} className="border-b border-border/50">
                    <td className="py-2.5 pr-3">{MODE_LABELS[m]}</td>
                    <td className="py-2.5 pr-3 text-right">{n(t.requests)}</td>
                    <td className="py-2.5 pr-3 text-right">{n(t.inputTokens)}</td>
                    <td className="py-2.5 pr-3 text-right">{n(t.outputTokens)}</td>
                    <td className="py-2.5 text-right">{formatInr(costUsd(t))}</td>
                  </tr>
                );
              })}
              <tr className="font-medium">
                <td className="py-2.5 pr-3">Total</td>
                <td className="py-2.5 pr-3 text-right">{n(allTime.requests)}</td>
                <td className="py-2.5 pr-3 text-right">{n(allTime.inputTokens)}</td>
                <td className="py-2.5 pr-3 text-right">{n(allTime.outputTokens)}</td>
                <td className="py-2.5 text-right">{formatInr(costUsd(allTime))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-[11px] text-muted-foreground">
          gpt-image-2 on Azure: ${PRICE_USD_PER_MTOK.input}/M in · ${PRICE_USD_PER_MTOK.output}/M
          out, at ₹{USD_TO_INR}/$ (as of {PRICING_ASOF}). Estimates — region, deployment type and
          agreement all move the real bill.
        </p>
        <Button variant="outline" size="sm" disabled={allTime.requests === 0} onClick={resetUsage}>
          Reset counters
        </Button>
      </div>
    </div>
  );
}
