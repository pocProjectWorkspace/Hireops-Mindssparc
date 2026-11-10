"use client";

import { useMemo, useState } from "react";
import {
  URGENCY_NOTICE_BANDS_DEFAULT,
  URGENCY_NOTICE_BAND_SHARES,
  URGENCY_NOTICE_MAX_DAYS,
  URGENCY_WEIGHTS_DEFAULT,
  type GetUrgencySettingsOutput,
} from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Card } from "@/components/ui";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { PageContainer } from "@/components/nav/PageContainer";

/**
 * Admin recruiter-urgency policy (CFG-LITE / Plan A PP1). Lives beside the SLA
 * thresholds because the SLA state is one of the urgency index's three inputs.
 *
 * - Weights: the most points each component can contribute (must total 100).
 * - Notice bands: five ascending day ceilings. A notice period at or under band
 *   1 earns the full notice weight, then 80 % / 60 % / 32 % / 16 %, longer
 *   earns nothing. A market where 90-day notice is normal moves the bands out
 *   so those candidates don't all read as "low urgency".
 *
 * Saved via updateUrgencySettings (admin-only, audited); unset = the platform
 * default (40 / 35 / 25, notice 0 / 15 / 30 / 60 / 90 days).
 */

type WeightKey = keyof typeof URGENCY_WEIGHTS_DEFAULT;
const WEIGHT_FIELDS: { key: WeightKey; label: string }[] = [
  { key: "sla", label: "SLA state" },
  { key: "daysInStage", label: "Time in stage" },
  { key: "notice", label: "Notice period" },
];

interface Draft {
  weights: Record<WeightKey, string>;
  noticeBands: string[];
}

function toDraft(s: GetUrgencySettingsOutput): Draft {
  return {
    weights: {
      sla: String(s.weights.sla),
      daysInStage: String(s.weights.daysInStage),
      notice: String(s.weights.notice),
    },
    noticeBands: s.noticeBands.map(String),
  };
}

const DEFAULT_DRAFT: Draft = {
  weights: {
    sla: String(URGENCY_WEIGHTS_DEFAULT.sla),
    daysInStage: String(URGENCY_WEIGHTS_DEFAULT.daysInStage),
    notice: String(URGENCY_WEIGHTS_DEFAULT.notice),
  },
  noticeBands: URGENCY_NOTICE_BANDS_DEFAULT.map(String),
};

export function UrgencySettingsClient({ initial }: { initial: GetUrgencySettingsOutput }) {
  const utils = trpc.useUtils();
  const query = trpc.getUrgencySettings.useQuery({}, { initialData: initial });
  const resolved = query.data ?? initial;

  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [notice, setNotice] = useState<string | null>(null);

  const error = useMemo(() => {
    const w = WEIGHT_FIELDS.map((f) => Number(draft.weights[f.key]));
    if (w.some((n) => !Number.isInteger(n) || n < 0 || n > 100)) {
      return "Each weight must be a whole number between 0 and 100.";
    }
    if (w.reduce((a, b) => a + b, 0) !== 100) return "Weights must add up to 100.";
    const b = draft.noticeBands.map(Number);
    if (b.some((n) => !Number.isInteger(n) || n < 0 || n > URGENCY_NOTICE_MAX_DAYS)) {
      return `Each notice band must be a whole number of days between 0 and ${URGENCY_NOTICE_MAX_DAYS}.`;
    }
    if (b.some((n, i) => i > 0 && n <= (b[i - 1] as number))) {
      return "Notice bands must be strictly ascending.";
    }
    return null;
  }, [draft]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(toDraft(resolved));

  const update = trpc.updateUrgencySettings.useMutation({
    onSuccess: async (res) => {
      await utils.getUrgencySettings.invalidate();
      setDraft(toDraft(res.urgency));
      setNotice("Urgency settings saved. The shortlist urgency index now uses them.");
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  function save() {
    if (error) return;
    setNotice(null);
    update.mutate({
      version: 1,
      weights: {
        sla: Number(draft.weights.sla),
        daysInStage: Number(draft.weights.daysInStage),
        notice: Number(draft.weights.notice),
      },
      noticeBands: draft.noticeBands.map(Number),
    });
  }

  return (
    <PageContainer variant="measure" className="pb-8">
      <Card className="p-6">
        <h2 className="text-base font-semibold text-neutral-900">Recruiter urgency</h2>
        <p className="mt-1 text-sm text-neutral-600">
          How the shortlist&apos;s urgency index is built. Weights are the most points each signal
          can add (they must total 100). Notice bands decide how much a candidate&apos;s notice
          period adds: at or under band 1 earns the full notice weight, then 80%, 60%, 32% and 16%;
          longer earns nothing.
        </p>

        {notice ? (
          <div
            className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
              notice.includes("failed")
                ? "border-status-error-200 bg-status-error-50 text-status-error-700"
                : "border-status-success-200 bg-status-success-50 text-status-success-700"
            }`}
          >
            {notice}
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {WEIGHT_FIELDS.map((f) => (
            <Input
              key={f.key}
              type="number"
              size="sm"
              min={0}
              max={100}
              step={1}
              label={`${f.label} weight`}
              suffix="pts"
              value={draft.weights[f.key]}
              onChange={(ev) => {
                const v = ev.currentTarget.value;
                setDraft((d) => ({ ...d, weights: { ...d.weights, [f.key]: v } }));
              }}
              hint={`Default: ${URGENCY_WEIGHTS_DEFAULT[f.key]}`}
              disabled={update.isPending}
            />
          ))}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-5">
          {draft.noticeBands.map((v, i) => (
            <Input
              key={i}
              type="number"
              size="sm"
              min={0}
              max={URGENCY_NOTICE_MAX_DAYS}
              step={1}
              label={`Band ${i + 1} (${Math.round((URGENCY_NOTICE_BAND_SHARES[i] ?? 0) * 100)}%)`}
              suffix="days"
              value={v}
              onChange={(ev) => {
                const next = ev.currentTarget.value;
                setDraft((d) => ({
                  ...d,
                  noticeBands: d.noticeBands.map((x, j) => (j === i ? next : x)),
                }));
              }}
              hint={`Default: ${URGENCY_NOTICE_BANDS_DEFAULT[i]}`}
              disabled={update.isPending}
            />
          ))}
        </div>

        {error ? <p className="mt-3 text-sm text-status-error-700">{error}</p> : null}

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button
            variant="tertiary"
            onClick={() => {
              setNotice(null);
              setDraft(DEFAULT_DRAFT);
            }}
            disabled={update.isPending}
            type="button"
          >
            Reset to defaults
          </Button>
          <Button onClick={save} disabled={update.isPending || !!error || !isDirty} type="button">
            {update.isPending ? "Saving…" : "Save urgency settings"}
          </Button>
        </div>
      </Card>
    </PageContainer>
  );
}
