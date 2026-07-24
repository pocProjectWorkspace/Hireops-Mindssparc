"use client";

import { useMemo, useState } from "react";
import type { GetGovernancePolicyOutput, UpdateGovernancePolicyInput } from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";

/**
 * Admin governance-policy editor (T4.2) — the compliance-score weights + the
 * governance SLA knobs.
 *
 * The four compliance weights (which must sum to 100) plus three SLA thresholds
 * (approval-SLA days, feedback-SLA hours, unrealistic-must-have threshold),
 * prefilled from the tenant's RESOLVED policy (getGovernancePolicy — the stored
 * settings.governancePolicy merged over the code defaults). Saving writes the
 * full policy via updateGovernancePolicy and invalidates the query.
 *
 * HONESTY — none of this is decorative. The saved weights GENUINELY drive the
 * executive-audit compliance score (change a weight → the score moves); the
 * approval-SLA days drive the overdue-approval risk flag (lower it → more
 * approvals flag as breaching); feedback-SLA hours drive the overdue-feedback
 * flag + the feedback compliance ratio; the must-have threshold drives the
 * unrealistic-must-haves flag. The weights are a stated JUDGEMENT CALL, not a
 * regulated formula. An unconfigured tenant resolves to the code defaults, so it
 * behaves exactly as before until you change something here.
 */

type WeightKey =
  | "approvals_within_sla"
  | "feedback_within_48h"
  | "onboarding_docs_verified"
  | "offers_within_band";

const WEIGHT_KEYS: WeightKey[] = [
  "approvals_within_sla",
  "feedback_within_48h",
  "onboarding_docs_verified",
  "offers_within_band",
];

const WEIGHT_LABELS: Record<WeightKey, string> = {
  approvals_within_sla: "Approvals decided within SLA",
  feedback_within_48h: "Interview feedback within SLA",
  onboarding_docs_verified: "Onboarding documents verified",
  offers_within_band: "Offers within approved band",
};

// The code defaults (mirror of COMPLIANCE_WEIGHTS + the governance SLA constants).
// Used ONLY as a display hint — the server's resolveGovernancePolicy is the
// authoritative source that drives behaviour. Kept in sync with the api-types
// constants; the internal-portal does not depend on that package's runtime.
const DEFAULT_WEIGHTS: Record<WeightKey, number> = {
  approvals_within_sla: 30,
  feedback_within_48h: 25,
  onboarding_docs_verified: 25,
  offers_within_band: 20,
};
const DEFAULT_APPROVAL_SLA_DAYS = 2;
const DEFAULT_FEEDBACK_SLA_HOURS = 48;
const DEFAULT_MUST_HAVE_THRESHOLD = 5;

interface Draft {
  weights: Record<WeightKey, string>;
  approvalSlaDays: string;
  feedbackSlaHours: string;
  unrealisticMustHaveThreshold: string;
}

function toDraft(p: GetGovernancePolicyOutput): Draft {
  return {
    weights: {
      approvals_within_sla: String(p.weights.approvals_within_sla),
      feedback_within_48h: String(p.weights.feedback_within_48h),
      onboarding_docs_verified: String(p.weights.onboarding_docs_verified),
      offers_within_band: String(p.weights.offers_within_band),
    },
    approvalSlaDays: String(p.approvalSlaDays),
    feedbackSlaHours: String(p.feedbackSlaHours),
    unrealisticMustHaveThreshold: String(p.unrealisticMustHaveThreshold),
  };
}

function intInRange(raw: string, min: number, max: number): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export function GovernancePolicyClient({ initial }: { initial: GetGovernancePolicyOutput }) {
  const utils = trpc.useUtils();
  const query = trpc.getGovernancePolicy.useQuery({}, { initialData: initial });
  const resolved = query.data ?? initial;

  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [notice, setNotice] = useState<string | null>(null);

  // Running weight sum — the compliance score is a weighted composite, so the
  // four weights MUST total 100 (the server refuses anything else).
  const weightSum = useMemo(
    () => WEIGHT_KEYS.reduce((acc, k) => acc + (intInRange(draft.weights[k], 0, 100) ?? NaN), 0),
    [draft.weights],
  );

  const weightErrors = useMemo(() => {
    const e = {} as Record<WeightKey, string | undefined>;
    for (const k of WEIGHT_KEYS) {
      if (intInRange(draft.weights[k], 0, 100) === null) {
        e[k] = "Whole number 0–100";
      }
    }
    return e;
  }, [draft.weights]);

  const approvalErr = intInRange(draft.approvalSlaDays, 1, 60) === null;
  const feedbackErr = intInRange(draft.feedbackSlaHours, 1, 720) === null;
  const mustHaveErr = intInRange(draft.unrealisticMustHaveThreshold, 1, 50) === null;

  const hasWeightError = WEIGHT_KEYS.some((k) => weightErrors[k]);
  const sumOk = weightSum === 100;
  const canSave = !hasWeightError && sumOk && !approvalErr && !feedbackErr && !mustHaveErr;

  const update = trpc.updateGovernancePolicy.useMutation({
    onSuccess: async (res) => {
      await utils.getGovernancePolicy.invalidate();
      setDraft(toDraft(res.governancePolicy));
      setNotice(
        "Governance policy saved. The compliance score and governance risk flags now use these values.",
      );
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  function save() {
    if (!canSave) return;
    // Re-parse each field; canSave already guarantees these are non-null, but we
    // bail defensively rather than assert (keeps the lint happy + is honest).
    const approvals = intInRange(draft.weights.approvals_within_sla, 0, 100);
    const feedbackW = intInRange(draft.weights.feedback_within_48h, 0, 100);
    const docsW = intInRange(draft.weights.onboarding_docs_verified, 0, 100);
    const offersW = intInRange(draft.weights.offers_within_band, 0, 100);
    const approvalSlaDays = intInRange(draft.approvalSlaDays, 1, 60);
    const feedbackSlaHours = intInRange(draft.feedbackSlaHours, 1, 720);
    const mustHave = intInRange(draft.unrealisticMustHaveThreshold, 1, 50);
    if (
      approvals === null ||
      feedbackW === null ||
      docsW === null ||
      offersW === null ||
      approvalSlaDays === null ||
      feedbackSlaHours === null ||
      mustHave === null
    ) {
      return;
    }
    setNotice(null);
    const payload: UpdateGovernancePolicyInput = {
      weights: {
        approvals_within_sla: approvals,
        feedback_within_48h: feedbackW,
        onboarding_docs_verified: docsW,
        offers_within_band: offersW,
      },
      approvalSlaDays,
      feedbackSlaHours,
      unrealisticMustHaveThreshold: mustHave,
    };
    update.mutate(payload);
  }

  function resetToDefaults() {
    setNotice(null);
    setDraft({
      weights: {
        approvals_within_sla: String(DEFAULT_WEIGHTS.approvals_within_sla),
        feedback_within_48h: String(DEFAULT_WEIGHTS.feedback_within_48h),
        onboarding_docs_verified: String(DEFAULT_WEIGHTS.onboarding_docs_verified),
        offers_within_band: String(DEFAULT_WEIGHTS.offers_within_band),
      },
      approvalSlaDays: String(DEFAULT_APPROVAL_SLA_DAYS),
      feedbackSlaHours: String(DEFAULT_FEEDBACK_SLA_HOURS),
      unrealisticMustHaveThreshold: String(DEFAULT_MUST_HAVE_THRESHOLD),
    });
  }

  const isDirty = useMemo(() => {
    const cur = toDraft(resolved);
    return (
      JSON.stringify(cur) !== JSON.stringify(draft) // structural compare of the flat draft
    );
  }, [draft, resolved]);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <PageHeader
        title="Governance policy"
        subtitle="Configure the compliance-score weights and the governance SLA policy that drive the HR-head governance surface. These values are real config — not just display."
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
        The four compliance weights are a stated <span className="font-medium">judgement call</span>{" "}
        (not a regulated formula) and must total 100 — they weight the executive-audit compliance
        score, so changing one moves the score. The governance SLA thresholds drive the
        deterministic risk flags: lowering the approval-SLA days flags more overdue approvals,
        lowering the feedback-SLA hours flags more overdue feedback, and the must-have threshold
        sets when a requisition&apos;s required-skill list reads as unrealistic.
      </div>

      {/* Compliance weights. */}
      <Card className="mt-6 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Compliance-score weights</h2>
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              sumOk
                ? "bg-status-success-50 text-status-success-700"
                : "bg-status-error-50 text-status-error-700"
            }`}
          >
            Total: {Number.isNaN(weightSum) ? "—" : weightSum} / 100
          </span>
        </div>
        <div className="grid gap-5">
          {WEIGHT_KEYS.map((k) => (
            <div
              key={k}
              className="flex items-start justify-between gap-6 border-b border-neutral-100 pb-5 last:border-0 last:pb-0"
            >
              <div className="pt-1">
                <div className="font-medium text-neutral-900">{WEIGHT_LABELS[k]}</div>
                <code className="text-xs text-neutral-500">{k}</code>
              </div>
              <div className="w-56">
                <Input
                  type="number"
                  size="sm"
                  min={0}
                  max={100}
                  step={1}
                  suffix="%"
                  value={draft.weights[k] ?? ""}
                  aria-label={`${WEIGHT_LABELS[k]} weight`}
                  onChange={(ev) =>
                    setDraft((d) => ({
                      ...d,
                      weights: { ...d.weights, [k]: ev.currentTarget.value },
                    }))
                  }
                  error={weightErrors[k]}
                  hint={weightErrors[k] ? undefined : `Default: ${DEFAULT_WEIGHTS[k]}%`}
                  disabled={update.isPending}
                />
              </div>
            </div>
          ))}
        </div>
        {!sumOk && !hasWeightError ? (
          <p className="mt-4 text-sm text-status-error-700">
            Weights must total exactly 100 to save (currently {weightSum}).
          </p>
        ) : null}
      </Card>

      {/* Governance SLA thresholds. */}
      <Card className="mt-6 p-6">
        <h2 className="mb-4 text-sm font-semibold text-neutral-900">Governance SLA thresholds</h2>
        <div className="grid gap-5">
          <div className="flex items-start justify-between gap-6 border-b border-neutral-100 pb-5">
            <div className="pt-1">
              <div className="font-medium text-neutral-900">Requisition approval SLA</div>
              <div className="text-xs text-neutral-500">
                A pending requisition approval older than this flags as overdue.
              </div>
            </div>
            <div className="w-56">
              <Input
                type="number"
                size="sm"
                min={1}
                max={60}
                step={1}
                suffix="days"
                value={draft.approvalSlaDays}
                aria-label="Requisition approval SLA days"
                onChange={(ev) =>
                  setDraft((d) => ({ ...d, approvalSlaDays: ev.currentTarget.value }))
                }
                error={approvalErr ? "Whole number 1–60" : undefined}
                hint={approvalErr ? undefined : `Default: ${DEFAULT_APPROVAL_SLA_DAYS} days`}
                disabled={update.isPending}
              />
            </div>
          </div>

          <div className="flex items-start justify-between gap-6 border-b border-neutral-100 pb-5">
            <div className="pt-1">
              <div className="font-medium text-neutral-900">Interview feedback SLA</div>
              <div className="text-xs text-neutral-500">
                Feedback not submitted this long after an interview flags as overdue.
              </div>
            </div>
            <div className="w-56">
              <Input
                type="number"
                size="sm"
                min={1}
                max={720}
                step={1}
                suffix="hours"
                value={draft.feedbackSlaHours}
                aria-label="Interview feedback SLA hours"
                onChange={(ev) =>
                  setDraft((d) => ({ ...d, feedbackSlaHours: ev.currentTarget.value }))
                }
                error={feedbackErr ? "Whole number 1–720" : undefined}
                hint={feedbackErr ? undefined : `Default: ${DEFAULT_FEEDBACK_SLA_HOURS} hours`}
                disabled={update.isPending}
              />
            </div>
          </div>

          <div className="flex items-start justify-between gap-6">
            <div className="pt-1">
              <div className="font-medium text-neutral-900">Unrealistic must-have threshold</div>
              <div className="text-xs text-neutral-500">
                An open requisition with more required skills than this reads as unrealistic.
              </div>
            </div>
            <div className="w-56">
              <Input
                type="number"
                size="sm"
                min={1}
                max={50}
                step={1}
                suffix="skills"
                value={draft.unrealisticMustHaveThreshold}
                aria-label="Unrealistic must-have threshold"
                onChange={(ev) =>
                  setDraft((d) => ({
                    ...d,
                    unrealisticMustHaveThreshold: ev.currentTarget.value,
                  }))
                }
                error={mustHaveErr ? "Whole number 1–50" : undefined}
                hint={mustHaveErr ? undefined : `Default: ${DEFAULT_MUST_HAVE_THRESHOLD} skills`}
                disabled={update.isPending}
              />
            </div>
          </div>
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
          <Button onClick={save} disabled={update.isPending || !canSave || !isDirty} type="button">
            {update.isPending ? "Saving…" : "Save policy"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
