'use client';

// Suite settings — one modal, opened from the rail's gear, with a Figma-style side nav.
//
// API keys: writes the SHARED persisted keys (skuc_azureEndpoint / skuc_azureKey). Every
// mounted product picks a change up live through use-persisted-state's sync event, which is
// what let the per-product key fields be deleted from the panels.
// Usage: the token ledger lib/usage.ts accumulates from Azure's per-response usage block;
// this pane is a live subscriber, so totals tick up while runs are in flight.

import * as React from 'react';
import { ChartColumnIcon, KeyRoundIcon, PlugZapIcon, SlidersHorizontalIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Hint } from '@/components/hint';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { usePersistedState } from '@/hooks/use-persisted-state';
import { azureImageUrl } from '@/lib/pipeline';
import { QUALITIES, QUALITY_BLURB, useImageQuality, type ImageQuality } from '@/lib/quality';
import { clampParallel, clampRpm, useParallel, useRpm } from '@/lib/rate';
import {
  PRICE_USD_PER_MTOK, PRICING_ASOF, USAGE_KEY, USD_TO_INR, costUsd, emptyLedger, formatInr,
  resetUsage, type UsageLedger,
} from '@/lib/usage';
import { cn } from '@/lib/utils';

type SettingsTab = 'api-keys' | 'image-model' | 'usage';

const TABS: { id: SettingsTab; label: string; icon: typeof KeyRoundIcon }[] = [
  { id: 'api-keys', label: 'API keys', icon: KeyRoundIcon },
  { id: 'image-model', label: 'Image model', icon: SlidersHorizontalIcon },
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
      <DialogContent className="gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-3.5">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Suite-wide settings: API keys and token usage.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[380px]">
          <nav className="flex w-44 shrink-0 flex-col gap-1 border-r p-2" aria-label="Settings sections">
            {TABS.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant="ghost"
                size="sm"
                onClick={() => setTab(id)}
                aria-current={tab === id ? 'page' : undefined}
                className={cn(
                  'w-full justify-start gap-2 px-2.5',
                  tab === id ? 'bg-accent font-medium' : 'font-normal text-muted-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </Button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {tab === 'api-keys' && <ApiKeysPane />}
            {tab === 'image-model' && <ImageModelPane />}
            {tab === 'usage' && <UsagePane />}
          </div>
        </div>
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
          <Hint hint="Shared by every product — AI edit, AI-fix flagged and Generate. Stored in this browser only; nothing leaves this machine except the calls themselves.">
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
          <Hint hint="One knob for the whole suite — Compositor tiles, BG Remover AI fixes and Generate all send this on every Azure call.">
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
          <Hint hint="How many Azure calls run at once — Banners tiles, Generate rows and BG Remover AI fixes all fan out this wide. Applies from the next run.">
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
          <Hint hint="One budget shared by every product in this tab — a run in Banners and a run in Generate draw from the same window. Counted per tab, like the usage ledger.">
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

const MODE_LABELS: Record<'edits' | 'generations', string> = {
  edits: 'AI edits (Banners · Cleanup)',
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
        {ledger.since ? <> since {new Date(ledger.since).toLocaleString()}</> : null}. Counted in
        this browser only — teammates have their own tallies.
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
