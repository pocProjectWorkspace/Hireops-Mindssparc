"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ALL_APPLICATION_STAGES,
  ALL_INTERVIEW_RECOMMENDATIONS,
  PLATFORM_RECOMMENDATION_LABELS,
  PLATFORM_STAGE_LABELS,
  STAGE_LABEL_AUDIENCES,
  TENANT_LABEL_MAX_LENGTH,
  resolveRecommendationLabel,
  resolveStageLabel,
  resolveTenantLabels,
  type ApplicationStage,
  type GetTenantLabelsOutput,
  type InterviewRecommendation,
  type StageLabelAudience,
  type TenantLabels,
} from "@hireops/api-types";
import { Button, Input } from "@hireops/ui";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { PageContainer } from "@/components/nav/PageContainer";

/**
 * Admin display-labels editor (CFG-LITE).
 *
 * One row per pipeline stage with three wording inputs — what STAFF see in this
 * portal, what the CANDIDATE reads in stage emails, what a recruitment PARTNER
 * sees in the partner portal — plus the four interview recommendation values.
 * A blank input means "platform default" (shown as the placeholder), so the
 * stored block only ever holds real overrides. The preview column shows the
 * label each audience will actually see. Save writes the whole block via
 * updateTenantLabels (admin-only, audited); "Reset all" blanks every field.
 */

type StageDraft = Record<ApplicationStage, Record<StageLabelAudience, string>>;
type RecDraft = Record<InterviewRecommendation, string>;

const AUDIENCE_TITLE: Record<StageLabelAudience, string> = {
  staff: "Staff portal",
  candidate: "Candidate emails",
  partner: "Partner portal",
};

function toStageDraft(labels: TenantLabels): StageDraft {
  const out = {} as StageDraft;
  for (const stage of ALL_APPLICATION_STAGES) {
    const entry = labels.stages[stage] ?? {};
    out[stage] = {
      staff: entry.staff ?? "",
      candidate: entry.candidate ?? "",
      partner: entry.partner ?? "",
    };
  }
  return out;
}

function toRecDraft(labels: TenantLabels): RecDraft {
  const out = {} as RecDraft;
  for (const rec of ALL_INTERVIEW_RECOMMENDATIONS) out[rec] = labels.recommendations[rec] ?? "";
  return out;
}

/** The draft as an overrides block (blanks dropped by the shared resolver). */
function draftToLabels(stages: StageDraft, recs: RecDraft): TenantLabels {
  return resolveTenantLabels({ stages, recommendations: recs });
}

export function LabelsClient({ initial }: { initial: GetTenantLabelsOutput }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const query = trpc.getTenantLabels.useQuery({}, { initialData: initial });
  const saved = resolveTenantLabels((query.data ?? initial).labels);

  const [stages, setStages] = useState<StageDraft>(() => toStageDraft(saved));
  const [recs, setRecs] = useState<RecDraft>(() => toRecDraft(saved));
  const [notice, setNotice] = useState<string | null>(null);

  const preview = useMemo(() => draftToLabels(stages, recs), [stages, recs]);
  const isDirty = JSON.stringify(preview) !== JSON.stringify(saved);
  const tooLong =
    ALL_APPLICATION_STAGES.some((s) =>
      STAGE_LABEL_AUDIENCES.some((a) => stages[s][a].trim().length > TENANT_LABEL_MAX_LENGTH),
    ) || ALL_INTERVIEW_RECOMMENDATIONS.some((r) => recs[r].trim().length > TENANT_LABEL_MAX_LENGTH);

  const update = trpc.updateTenantLabels.useMutation({
    onSuccess: async (res) => {
      await utils.getTenantLabels.invalidate();
      const next = resolveTenantLabels(res.labels);
      setStages(toStageDraft(next));
      setRecs(toRecDraft(next));
      setNotice("Labels saved. Every surface now uses this wording.");
      // The portal-wide labels come from the root layout — refresh to pick them up.
      router.refresh();
    },
    onError: (err) => {
      setNotice(`Save failed: ${err.message}`);
      handleTRPCError(err);
    },
  });

  function save() {
    if (tooLong) return;
    setNotice(null);
    update.mutate({ version: 1, stages: preview.stages, recommendations: preview.recommendations });
  }

  function resetAll() {
    setNotice(null);
    setStages(toStageDraft(resolveTenantLabels(undefined)));
    setRecs(toRecDraft(resolveTenantLabels(undefined)));
  }

  function resetStage(stage: ApplicationStage) {
    setStages((d) => ({ ...d, [stage]: { staff: "", candidate: "", partner: "" } }));
  }

  return (
    <PageContainer variant="measure" className="py-8">
      <PageHeader
        title="Labels"
        subtitle="Choose the wording your organisation uses for pipeline stages and interview recommendations. Only the words change; stage rules, reports and audit history are unaffected."
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

      <div className="mt-6 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
        Leave a field blank to use the platform default (shown greyed in the field). Staff wording
        appears across this portal; candidate wording is used in stage-update emails; partner
        wording appears in the partner portal and partner emails. Up to {TENANT_LABEL_MAX_LENGTH}{" "}
        characters.
      </div>

      <Card className="mt-6 p-6">
        <h2 className="text-base font-semibold text-neutral-900">Pipeline stages</h2>
        <div className="mt-4 grid gap-5">
          {ALL_APPLICATION_STAGES.map((stage) => (
            <div key={stage} className="border-b border-neutral-100 pb-5 last:border-0 last:pb-0">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <code className="text-xs text-neutral-500">{stage}</code>
                <button
                  type="button"
                  className="text-xs text-brand-700 hover:underline disabled:opacity-50"
                  onClick={() => resetStage(stage)}
                  disabled={update.isPending}
                >
                  Reset
                </button>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {STAGE_LABEL_AUDIENCES.map((audience) => {
                  const value = stages[stage][audience];
                  const tooLongHere = value.trim().length > TENANT_LABEL_MAX_LENGTH;
                  return (
                    <Input
                      key={audience}
                      size="sm"
                      label={AUDIENCE_TITLE[audience]}
                      placeholder={PLATFORM_STAGE_LABELS[stage][audience]}
                      value={value}
                      maxLength={TENANT_LABEL_MAX_LENGTH + 10}
                      onChange={(ev) => {
                        const v = ev.currentTarget.value;
                        setStages((d) => ({ ...d, [stage]: { ...d[stage], [audience]: v } }));
                      }}
                      error={
                        tooLongHere ? `At most ${TENANT_LABEL_MAX_LENGTH} characters` : undefined
                      }
                      hint={
                        tooLongHere
                          ? undefined
                          : `Shows as: ${resolveStageLabel(preview, stage, audience)}`
                      }
                      disabled={update.isPending}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="mt-6 p-6">
        <h2 className="text-base font-semibold text-neutral-900">Interview recommendations</h2>
        <p className="mt-1 text-sm text-neutral-600">
          The four values a panellist picks on the scorecard. The scale itself is fixed; only its
          wording changes.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {ALL_INTERVIEW_RECOMMENDATIONS.map((rec) => {
            const value = recs[rec];
            const tooLongHere = value.trim().length > TENANT_LABEL_MAX_LENGTH;
            return (
              <Input
                key={rec}
                size="sm"
                label={rec}
                placeholder={PLATFORM_RECOMMENDATION_LABELS[rec]}
                value={value}
                maxLength={TENANT_LABEL_MAX_LENGTH + 10}
                onChange={(ev) => {
                  const v = ev.currentTarget.value;
                  setRecs((d) => ({ ...d, [rec]: v }));
                }}
                error={tooLongHere ? `At most ${TENANT_LABEL_MAX_LENGTH} characters` : undefined}
                hint={
                  tooLongHere ? undefined : `Shows as: ${resolveRecommendationLabel(preview, rec)}`
                }
                disabled={update.isPending}
              />
            );
          })}
        </div>
      </Card>

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button variant="tertiary" onClick={resetAll} disabled={update.isPending} type="button">
          Reset all to defaults
        </Button>
        <Button onClick={save} disabled={update.isPending || tooLong || !isDirty} type="button">
          {update.isPending ? "Saving…" : "Save labels"}
        </Button>
      </div>
    </PageContainer>
  );
}
