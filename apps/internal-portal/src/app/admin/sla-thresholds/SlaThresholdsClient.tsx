"use client";

import { useMemo, useState } from "react";
import {
  SLA_NON_TERMINAL_STAGES,
  type SlaNonTerminalStage,
  type GetSlaThresholdsOutput,
  type UpdateSlaThresholdsInput,
} from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin SLA thresholds editor (T4.1) — the per-stage SLA hours.
 *
 * One whole-hours input per NON-terminal application stage, prefilled from the
 * tenant's RESOLVED map (getSlaThresholds — the stored settings.slaThresholds
 * merged over the code defaults). Saving writes the full override map via
 * updateSlaThresholds and invalidates the query.
 *
 * HONESTY — these hours are not decorative. The saved thresholds GENUINELY
 * drive breach detection (the triage breach filter + sort), recruiter urgency,
 * the governance / executive-audit compliance numbers, AND the imminent-alert
 * emails the worker sends. An unconfigured tenant resolves to the code defaults,
 * so it behaves exactly as before until you change something here.
 */

// Display labels for the seven overridable stages (order = pipeline order).
const STAGE_LABELS: Record<SlaNonTerminalStage, string> = {
  application_received: "Application received",
  ai_screening: "AI screening",
  recruiter_review: "Recruiter review",
  shortlisted: "Shortlisted",
  tech_interview: "Technical interview",
  hr_round: "HR round",
  offer_drafted: "Offer drafted",
};

// The code defaults (mirrors SLA_THRESHOLDS_HOURS in @hireops/sla-thresholds).
// Used ONLY as a display hint — the server's resolveSlaThresholds is the
// authoritative source that drives behavior. Kept in sync with the package
// constant; the internal-portal does not depend on that package directly.
const DEFAULT_SLA_HOURS: Record<SlaNonTerminalStage, number> = {
  application_received: 24,
  ai_screening: 1,
  recruiter_review: 48,
  shortlisted: 24,
  tech_interview: 72,
  hr_round: 48,
  offer_drafted: 24,
};

const MIN_HOURS = 1;
const MAX_HOURS = 8760; // one year of hours — matches the write schema bound.

function toDraft(resolved: GetSlaThresholdsOutput): Record<SlaNonTerminalStage, string> {
  const draft = {} as Record<SlaNonTerminalStage, string>;
  for (const stage of SLA_NON_TERMINAL_STAGES) {
    const v = resolved[stage];
    draft[stage] = v == null ? String(DEFAULT_SLA_HOURS[stage]) : String(v);
  }
  return draft;
}

export function SlaThresholdsClient({ initial }: { initial: GetSlaThresholdsOutput }) {
  const utils = trpc.useUtils();
  const query = trpc.getSlaThresholds.useQuery({}, { initialData: initial });
  const resolved = query.data ?? initial;

  const [draft, setDraft] = useState<Record<SlaNonTerminalStage, string>>(() => toDraft(initial));
  const [notice, setNotice] = useState<string | null>(null);

  // Per-stage validation — a whole number in [1, 8760].
  const errors = useMemo(() => {
    const e = {} as Record<SlaNonTerminalStage, string | undefined>;
    for (const stage of SLA_NON_TERMINAL_STAGES) {
      const raw = draft[stage]?.trim() ?? "";
      if (raw === "") {
        e[stage] = "Required";
        continue;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < MIN_HOURS || n > MAX_HOURS) {
        e[stage] = `Enter a whole number of hours between ${MIN_HOURS} and ${MAX_HOURS}`;
      }
    }
    return e;
  }, [draft]);

  const hasErrors = SLA_NON_TERMINAL_STAGES.some((s) => errors[s]);
  const isDirty = SLA_NON_TERMINAL_STAGES.some(
    (s) => draft[s]?.trim() !== String(resolved[s] ?? DEFAULT_SLA_HOURS[s]),
  );

  const update = trpc.updateSlaThresholds.useMutation({
    onSuccess: async (res) => {
      await utils.getSlaThresholds.invalidate();
      setDraft(toDraft(res.slaThresholds));
      setNotice("SLA thresholds saved. Breach detection, urgency and alerts now use these hours.");
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  function save() {
    if (hasErrors) return;
    setNotice(null);
    const payload = {} as Record<SlaNonTerminalStage, number>;
    for (const stage of SLA_NON_TERMINAL_STAGES) {
      payload[stage] = Number(draft[stage].trim());
    }
    update.mutate(payload as UpdateSlaThresholdsInput);
  }

  function resetToDefaults() {
    setNotice(null);
    const next = {} as Record<SlaNonTerminalStage, string>;
    for (const stage of SLA_NON_TERMINAL_STAGES) next[stage] = String(DEFAULT_SLA_HOURS[stage]);
    setDraft(next);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <PageHeader
        title="SLA thresholds"
        subtitle="Set the per-stage SLA hours for this tenant. These hours drive breach detection, recruiter urgency, governance/compliance scoring, and the imminent-breach alert emails — not just display."
      />

      {notice ? (
        <div
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            notice.includes("failed")
              ? "border-status-error-200 bg-status-error-50 text-status-error-700"
              : "border-status-success-200 bg-status-success-50 text-status-success-700"
          }`}
        >
          {notice}
        </div>
      ) : null}

      {/* Honesty banner. */}
      <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        Each threshold is the number of hours an application may sit in a stage before it counts as{" "}
        <span className="font-medium">breaching</span>. Lowering a stage&apos;s hours makes it
        breach sooner everywhere — the triage breach filter/sort, recruiter urgency, the governance
        and executive-audit numbers, and the imminent-breach alert emails. Terminal stages
        (accepted, declined, withdrawn, rejected) have no SLA and are not shown.
      </div>

      <Card className="mt-6 p-6">
        <div className="grid gap-5">
          {SLA_NON_TERMINAL_STAGES.map((stage) => (
            <div
              key={stage}
              className="flex items-start justify-between gap-6 border-b border-neutral-100 pb-5 last:border-0 last:pb-0"
            >
              <div className="pt-1">
                <div className="font-medium text-neutral-900">{STAGE_LABELS[stage]}</div>
                <code className="text-xs text-neutral-500">{stage}</code>
              </div>
              <div className="w-56">
                <Input
                  type="number"
                  size="sm"
                  min={MIN_HOURS}
                  max={MAX_HOURS}
                  step={1}
                  suffix="hours"
                  value={draft[stage] ?? ""}
                  aria-label={`${STAGE_LABELS[stage]} SLA hours`}
                  onChange={(ev) => setDraft((d) => ({ ...d, [stage]: ev.currentTarget.value }))}
                  error={errors[stage]}
                  hint={errors[stage] ? undefined : `Default: ${DEFAULT_SLA_HOURS[stage]}h`}
                  disabled={update.isPending}
                />
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button
            variant="tertiary"
            onClick={resetToDefaults}
            disabled={update.isPending}
            type="button"
          >
            Reset to defaults
          </Button>
          <Button onClick={save} disabled={update.isPending || hasErrors || !isDirty} type="button">
            {update.isPending ? "Saving…" : "Save thresholds"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
