"use client";

import { useMemo, useState } from "react";
import {
  AI_FEATURE_KEYS,
  AI_FEATURE_META,
  AI_MODEL_ALLOWLIST,
  AI_MAX_TOKENS_MAX,
  AI_MAX_TOKENS_MIN,
  type AiFeatureKey,
  type AiSettings,
  type GetAiUsageSummaryOutput,
} from "@hireops/api-types";
import { Select, Switch, Input, Button } from "@hireops/ui";
import { Card, Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";

/**
 * Admin AI settings editor (CONF-01). One card per real AI feature
 * (enabled / model / temperature / max tokens) + the global PII-masking
 * switch, saved as one updateTenantAiSettings mutation (admin-only,
 * audited, merged into tenants.settings without touching other keys).
 *
 * Each card shows its live last-30-day usage (calls + cost) from the
 * ai_usage_logs rollup so the admin sees what the setting actually governs.
 * Copy is honest: each description states the real behavioural effect,
 * including what "off" does.
 */
export function AiSettingsClient({
  initialSettings,
  usage,
}: {
  initialSettings: AiSettings;
  usage: GetAiUsageSummaryOutput;
}) {
  const [settings, setSettings] = useState<AiSettings>(initialSettings);
  const [saved, setSaved] = useState<AiSettings>(initialSettings);
  const [notice, setNotice] = useState<string | null>(null);

  const update = trpc.updateTenantAiSettings.useMutation({
    onSuccess: (res) => {
      setSettings(res.settings);
      setSaved(res.settings);
      setNotice("Settings saved. New AI calls use them immediately.");
    },
    onError: (err) => setNotice(`Save failed: ${err.message}`),
  });

  const dirty = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(saved),
    [settings, saved],
  );

  const usageByFeature = useMemo(() => {
    const map = new Map<string, { calls: number; cost_micros: string }>();
    for (const f of usage.byFeature) {
      map.set(f.feature, { calls: f.calls, cost_micros: f.cost_micros });
    }
    return map;
  }, [usage]);

  function patchFeature(key: AiFeatureKey, patch: Partial<AiSettings[AiFeatureKey]>) {
    setSettings((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <h2 className="mb-1 text-base font-semibold text-neutral-900">Per-feature controls</h2>
      <p className="mb-6 text-sm text-neutral-600">
        Per-tenant kill-switches consumed directly by the AI call path. Model, temperature and token
        ceiling apply to the next call each feature makes; disabling a feature stops its AI calls
        entirely. Usage figures are the last 30 days.
      </p>

      {notice ? (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
            notice.startsWith("Save failed")
              ? "border-status-error-200 bg-status-error-50 text-status-error-700"
              : "border-status-success-200 bg-status-success-50 text-status-success-700"
          }`}
        >
          {notice}
        </div>
      ) : null}

      <div className="space-y-4">
        {AI_FEATURE_KEYS.map((key) => {
          const meta = AI_FEATURE_META[key];
          const cfg = settings[key];
          const featureUsage = meta.usageFeatures.reduce(
            (acc, f) => {
              const u = usageByFeature.get(f);
              if (u) {
                acc.calls += u.calls;
                acc.costMicros += Number(u.cost_micros);
              }
              return acc;
            },
            { calls: 0, costMicros: 0 },
          );
          return (
            <Card key={key} className="p-5">
              <div className="mb-1 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-neutral-900">{meta.label}</h2>
                  {!cfg.enabled ? <Badge tone="warning">Off</Badge> : null}
                </div>
                <Switch
                  checked={cfg.enabled}
                  onCheckedChange={(checked) => patchFeature(key, { enabled: checked })}
                  label={cfg.enabled ? "Enabled" : "Disabled"}
                />
              </div>
              <p className="mb-1 text-xs text-neutral-600">{meta.description}</p>
              <p className="mb-4 text-xs text-neutral-500">
                Last 30 days: {featureUsage.calls.toLocaleString()}{" "}
                {featureUsage.calls === 1 ? "call" : "calls"} ·{" "}
                {formatMicrosUsd(featureUsage.costMicros)}
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Select
                  label="Model"
                  options={AI_MODEL_ALLOWLIST.map((m) => ({ value: m, label: m }))}
                  value={cfg.model}
                  onValueChange={(v) =>
                    patchFeature(key, { model: v as (typeof AI_MODEL_ALLOWLIST)[number] })
                  }
                  disabled={!cfg.enabled}
                />
                <Input
                  label="Temperature (0–1)"
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={String(cfg.temperature)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isNaN(n)) {
                      patchFeature(key, { temperature: clamp(n, 0, 1) });
                    }
                  }}
                  disabled={!cfg.enabled}
                />
                <Input
                  label={`Max tokens (${AI_MAX_TOKENS_MIN}–${AI_MAX_TOKENS_MAX})`}
                  type="number"
                  min={AI_MAX_TOKENS_MIN}
                  max={AI_MAX_TOKENS_MAX}
                  step={256}
                  value={String(cfg.maxTokens)}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isNaN(n)) {
                      patchFeature(key, {
                        maxTokens: clamp(Math.round(n), AI_MAX_TOKENS_MIN, AI_MAX_TOKENS_MAX),
                      });
                    }
                  }}
                  disabled={!cfg.enabled}
                />
              </div>
            </Card>
          );
        })}

        <Card className="p-5">
          <div className="mb-1 flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-neutral-900">PII masking</h2>
            <Switch
              checked={settings.piiMasking}
              onCheckedChange={(checked) => setSettings((s) => ({ ...s, piiMasking: checked }))}
              label={settings.piiMasking ? "On" : "Off"}
            />
          </div>
          <p className="text-xs text-neutral-600">
            When on, candidate emails, phone numbers and URLs are replaced with [redacted-&hellip;]
            tokens in scoring and agent-draft prompts before the text is sent to the model. JD
            generation is unaffected — its prompts contain no candidate data.
          </p>
        </Card>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <Button onClick={() => update.mutate(settings)} disabled={!dirty || update.isPending}>
          {update.isPending ? "Saving…" : "Save settings"}
        </Button>
        {dirty ? (
          <button
            type="button"
            className="text-sm text-neutral-600 hover:underline"
            onClick={() => {
              setSettings(saved);
              setNotice(null);
            }}
          >
            Discard changes
          </button>
        ) : null}
      </div>
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** micros → "$0.0135" — same formatting rule as /admin/costs. */
function formatMicrosUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}
