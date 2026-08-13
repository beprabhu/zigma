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
  ChartColumnIcon, CopyIcon, KeyRoundIcon, PencilIcon, PlugZapIcon, PlusIcon, Settings2Icon,
  SlidersHorizontalIcon, SparklesIcon, Trash2Icon, UploadIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/hint';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { MdFileIcon } from '@/components/md-file-tile';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarProvider,
} from '@/components/ui/sidebar';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { DEFAULT_SEAL_SIZE } from '@/lib/bg/ledger';
import { diffStat, newSkillId, useSkills, type PromptSkill } from '@/lib/skills';
import { azureImageUrl } from '@/lib/pipeline';
import { QUALITIES, QUALITY_BLURB, useImageQuality, type ImageQuality } from '@/lib/quality';
import { clampParallel, clampRpm, useParallel, useRpm } from '@/lib/rate';
import {
  PRICE_USD_PER_MTOK, PRICING_ASOF, USAGE_KEY, USD_TO_INR, costUsd, emptyLedger, formatInr,
  resetUsage, type UsageLedger,
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

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = React.useState<SettingsTab>('api-keys');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-3rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 py-3.5">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Suite-wide settings: API keys and token usage.
          </DialogDescription>
        </DialogHeader>
        {/* min-w-0: DialogContent lays children on a grid whose track sizes to max-content;
            without this, one long unwrappable line (a skill's preview) widens the whole pane.
            The nav is the real shadcn Sidebar embedded non-collapsible, per its settings-dialog
            pattern — same component as an app shell, so hover/active states match the suite. */}
        <SidebarProvider className="h-[500px] max-h-full min-h-0 min-w-0 items-start" style={{ '--sidebar-width': '13rem' } as React.CSSProperties}>
          <Sidebar collapsible="none" className="h-auto self-stretch border-r">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
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
          <div className="min-w-0 flex-1 self-stretch overflow-y-auto p-6">
            {tab === 'api-keys' && <ApiKeysPane />}
            {tab === 'image-model' && <ImageModelPane />}
            {tab === 'skills' && <SkillsPane />}
            {tab === 'defaults' && <DefaultsPane />}
            {tab === 'usage' && <UsagePane />}
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
          max={8}
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
          max={600}
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

function SkillsPane() {
  const { skills, setCustom } = useSkills();
  const fileRef = React.useRef<HTMLInputElement>(null);
  // The editor dialog's draft. `fresh` = not yet in the list, so Cancel leaves no trace.
  // `original` snapshots name+content as the editor opened: the diff chip renders against it,
  // and an unchanged save keeps the stored updatedAt instead of restamping.
  const [draft, setDraft] = React.useState<{
    skill: PromptSkill;
    fresh: boolean;
    original: { name: string; content: string };
  } | null>(null);
  const stat = draft ? diffStat(draft.original.content, draft.skill.content) : null;

  function saveDraft() {
    if (!draft) return;
    const name = draft.skill.name.trim() || 'untitled.md';
    const changed =
      draft.fresh || draft.skill.content !== draft.original.content || name !== draft.original.name;
    const skill = {
      ...draft.skill,
      name,
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

  function removeSkill(id: string) {
    setCustom((prev) => (Array.isArray(prev) ? prev.filter((s) => s.id !== id) : []));
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Reusable prompts for the whole suite — pick them from any product&rsquo;s prompt
        dropdown. Built-ins are read-only; duplicate one to make your own version.
      </p>
      <div className="space-y-1.5">
        {skills.map((skill) => (
          <div key={skill.id} className="flex items-center gap-2.5 rounded-lg border px-3 py-2">
            <MdFileIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{skill.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {/* Custom skills show when they last changed; built-ins (and skills saved
                    before updatedAt existed) keep the first-line preview. */}
                {skill.updatedAt
                  ? `Updated ${new Date(skill.updatedAt).toLocaleString(undefined, {
                      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}`
                  : skill.content.split('\n').find((l) => l.trim()) || 'Empty'}
              </div>
            </div>
            {skill.builtin ? (
              <>
                <Badge variant="chip" className="shrink-0">Built-in</Badge>
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
                    setDraft({ fresh: false, skill, original: { name: skill.name, content: skill.content } })
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
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft({
              fresh: true,
              skill: { id: newSkillId(), name: 'new-skill.md', content: '' },
              original: { name: 'new-skill.md', content: '' },
            })
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
        <DialogContent className="sm:max-w-xl" forceOverlay>
          {draft && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MdFileIcon className="size-4 text-muted-foreground" />
                  {draft.fresh ? 'New skill' : 'Edit skill'}
                </DialogTitle>
                <DialogDescription>
                  A reusable prompt, selectable from any product&rsquo;s prompt dropdown.
                </DialogDescription>
              </DialogHeader>
              <Field>
                <FieldLabel htmlFor="skill-name">Name</FieldLabel>
                <Input
                  id="skill-name"
                  value={draft.skill.name}
                  onChange={(e) => setDraft({ ...draft, skill: { ...draft.skill, name: e.target.value } })}
                />
              </Field>
              <Textarea
                value={draft.skill.content}
                onChange={(e) => setDraft({ ...draft, skill: { ...draft.skill, content: e.target.value } })}
                rows={12}
                placeholder="The prompt this skill carries…"
                aria-label="Skill prompt"
                className="max-h-[50dvh] min-h-40 overflow-y-auto text-xs"
              />
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

function UsagePane() {
  const [ledger] = usePersistedState<UsageLedger>(USAGE_KEY, emptyLedger());
  const modes = ['edits', 'generations'] as const;
  const total = modes.reduce(
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
  const n = (v: number) => v.toLocaleString();
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Tokens reported by Azure per call
        {ledger.since ? <> since {new Date(ledger.since).toLocaleString()}</> : null}. Counted per
        person — teammates have their own tallies.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1.5 pr-2 font-normal">Mode</th>
              <th className="py-1.5 pr-2 text-right font-normal">Requests</th>
              <th className="py-1.5 pr-2 text-right font-normal">Tokens in</th>
              <th className="py-1.5 pr-2 text-right font-normal">Tokens out</th>
              <th className="py-1.5 text-right font-normal">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {modes.map((m) => {
              const t = ledger.byMode[m] ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
              return (
                <tr key={m} className="border-b border-border/50">
                  <td className="py-1.5 pr-2">{MODE_LABELS[m]}</td>
                  <td className="py-1.5 pr-2 text-right">{n(t.requests)}</td>
                  <td className="py-1.5 pr-2 text-right">{n(t.inputTokens)}</td>
                  <td className="py-1.5 pr-2 text-right">{n(t.outputTokens)}</td>
                  <td className="py-1.5 text-right">{formatInr(costUsd(t))}</td>
                </tr>
              );
            })}
            <tr className="font-medium">
              <td className="py-1.5 pr-2">Total</td>
              <td className="py-1.5 pr-2 text-right">{n(total.requests)}</td>
              <td className="py-1.5 pr-2 text-right">{n(total.inputTokens)}</td>
              <td className="py-1.5 pr-2 text-right">{n(total.outputTokens)}</td>
              <td className="py-1.5 text-right">{formatInr(costUsd(total))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-[11px] text-muted-foreground">
          gpt-image-2 on Azure: ${PRICE_USD_PER_MTOK.input}/M in · ${PRICE_USD_PER_MTOK.output}/M
          out, at ₹{USD_TO_INR}/$ (as of {PRICING_ASOF}). Estimates — region, deployment type and
          agreement all move the real bill.
        </p>
        <Button variant="outline" size="sm" disabled={total.requests === 0} onClick={resetUsage}>
          Reset counters
        </Button>
      </div>
    </div>
  );
}
