"use client";

import { useState } from "react";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Button, Card, EmptyState } from "@/components/ui";
import { BENEFIT_META, type BenefitKey, type CompAnalysis } from "@hireops/api-types";
import { VerdictChip, ApprovalStatusChip } from "./chips";
import { paiseToLpa, paiseToInr, minorToLpa } from "./format";

/**
 * CompAnalysisPanel (HROPS-02) — the per-application comp analysis, exported as
 * a standalone panel so the desk drawer AND (at reconciliation) the case-detail
 * Comp tab can both mount it. Renders: the salary analysis card (current /
 * expected / band min-mid-max), the DETERMINISTIC verdict + reasons, curated
 * market benchmarks (labelled "Curated benchmarks"), the AI rationale section
 * (generate / regenerate, honest empty state when AI is off), a benefits
 * summary, and a "Draft offer" CTA that hands off to the composer.
 *
 * The AI writes only the rationale prose; the verdict is always rule-computed.
 */

export interface CompAnalysisPanelProps {
  applicationId: string;
  /** Switch the parent to composer mode, pre-seeded with the suggestion. */
  onDraftOffer?: (suggestedPaise: number | null) => void;
  onRequestApproval?: (offerId: string) => void;
}

export function CompAnalysisPanel({
  applicationId,
  onDraftOffer,
  onRequestApproval,
}: CompAnalysisPanelProps) {
  const query = trpc.getCompAnalysis.useQuery({ applicationId }, { staleTime: 5_000 });
  const analysis = query.data?.analysis ?? null;

  if (query.isLoading) {
    return <p className="p-4 text-sm text-neutral-500">Loading analysis…</p>;
  }
  if (!analysis) {
    return (
      <EmptyState
        title="No comp analysis"
        hint="This application isn't on the comp desk (it must be in the HR round, offer-drafted, or offer-accepted stage)."
      />
    );
  }

  return (
    <AnalysisBody
      analysis={analysis}
      onDraftOffer={onDraftOffer}
      onRequestApproval={onRequestApproval}
      onRegenerated={() => void query.refetch()}
    />
  );
}

function AnalysisBody({
  analysis,
  onDraftOffer,
  onRequestApproval,
  onRegenerated,
}: {
  analysis: CompAnalysis;
  onDraftOffer?: (suggestedPaise: number | null) => void;
  onRequestApproval?: (offerId: string) => void;
  onRegenerated: () => void;
}) {
  const { row } = analysis;
  const generate = trpc.generateCompRationale.useMutation();
  const [error, setError] = useState<string | null>(null);
  const [localRationale, setLocalRationale] = useState(analysis.rationale);

  async function runGenerate() {
    setError(null);
    try {
      const res = await generate.mutateAsync({ applicationId: row.applicationId });
      setLocalRationale(res.rationale);
      onRegenerated();
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setError(m) });
    }
  }

  const rationale = localRationale;
  const bandLabel =
    row.bandMinPaise != null && row.bandMaxPaise != null
      ? `${paiseToLpa(row.bandMinPaise)} · ${paiseToLpa(row.bandMidPaise)} · ${paiseToLpa(row.bandMaxPaise)}`
      : "No comp band set on the role";

  return (
    <div className="space-y-4">
      {/* Salary analysis card */}
      <Card className="space-y-3">
        <h3 className="text-sm font-semibold text-neutral-900">Salary analysis</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Row label="Current offer" value={paiseToInr(analysis.currentSalaryInrPaise) ?? "—"} />
          <Row
            label="Expected"
            value={paiseToInr(row.expectedSalaryInrPaise) ?? "Not captured"}
            muted={row.expectedSalaryInrPaise == null}
          />
          <Row label="Band min" value={paiseToInr(row.bandMinPaise) ?? "—"} />
          <Row label="Band mid" value={paiseToInr(row.bandMidPaise) ?? "—"} />
          <Row label="Band max" value={paiseToInr(row.bandMaxPaise) ?? "—"} />
          <Row
            label="Suggested"
            value={paiseToInr(row.suggestedPaise) ?? "—"}
            emphasis={row.suggestedPaise != null}
          />
        </dl>
        <p className="border-t border-neutral-100 pt-2 text-[11px] text-neutral-500">
          Band (min · mid · max): {bandLabel}
        </p>
      </Card>

      {/* Deterministic verdict + reasons */}
      <Card className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-900">Recommendation</h3>
          <div className="flex items-center gap-1.5">
            <VerdictChip verdict={row.verdict} />
            <ApprovalStatusChip status={row.approvalStatus} />
          </div>
        </div>
        {row.reasons.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-700">
            {row.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">
            Capture an expected salary and a comp band to compute a verdict.
          </p>
        )}
        <p className="text-[11px] text-neutral-400">
          Verdict is computed by a deterministic rule engine — the AI never changes it.
        </p>
      </Card>

      {/* Curated benchmarks (labelled) */}
      <Card className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-900">Curated benchmarks</h3>
          {analysis.matchedBenchmarkRoleTitle ? (
            <span className="text-[11px] text-neutral-500">
              Matched: {analysis.matchedBenchmarkRoleTitle}
            </span>
          ) : null}
        </div>
        {analysis.benchmarks.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No curated benchmarks configured for this tenant.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {analysis.benchmarks.slice(0, 5).map((b) => {
              const matched = b.roleTitle === analysis.matchedBenchmarkRoleTitle;
              return (
                <li
                  key={b.id}
                  className={`flex items-center justify-between rounded-md px-2 py-1 ${matched ? "bg-brand-50" : ""}`}
                >
                  <span className={matched ? "font-medium text-neutral-900" : "text-neutral-700"}>
                    {b.roleTitle}
                  </span>
                  <span className="tabular-nums text-neutral-600">
                    {minorToLpa(b.medianSalaryMinor)} · avail {b.availability} · demand{" "}
                    {b.competitorDemand}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="border-t border-neutral-100 pt-2 text-[11px] text-neutral-500">
          Curated reference data — not a live market feed. Source notes on each row in Market intel.
        </p>
      </Card>

      {/* AI rationale */}
      <Card className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-900">AI rationale</h3>
          <Button
            variant="secondary"
            size="sm"
            onClick={runGenerate}
            disabled={generate.isPending || row.verdict == null}
          >
            {generate.isPending ? "Writing…" : rationale ? "Regenerate" : "Generate rationale"}
          </Button>
        </div>
        {rationale ? (
          <>
            <p className="text-sm leading-relaxed text-neutral-700">{rationale.rationale}</p>
            {rationale.generatedAt ? (
              <p className="text-[11px] text-neutral-400">
                Written {new Date(rationale.generatedAt).toLocaleString("en-GB")}
                {rationale.model ? ` · ${rationale.model}` : ""}
                {rationale.promptVersion ? ` · ${rationale.promptVersion}` : ""}
                {rationale.verdictSnapshot !== row.verdict
                  ? " · verdict changed since — regenerate"
                  : ""}
              </p>
            ) : null}
          </>
        ) : (
          <div className="rounded-md border border-dashed border-neutral-200 px-4 py-5 text-center">
            <p className="text-sm font-medium text-neutral-700">No rationale yet</p>
            <p className="mt-1 text-xs text-neutral-500">
              {row.verdict == null
                ? "Add an expected salary + comp band first — there's no verdict to explain."
                : "Generate a short, cost-logged rationale grounded only in these numbers. If AI is switched off for this tenant, this button reports that honestly."}
            </p>
          </div>
        )}
      </Card>

      {/* Benefits summary */}
      <Card className="space-y-2">
        <h3 className="text-sm font-semibold text-neutral-900">Suggested benefits</h3>
        <div className="flex flex-wrap gap-1.5">
          {analysis.benefitsSuggested.map((k: BenefitKey) => (
            <span
              key={k}
              className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600"
            >
              {BENEFIT_META[k].label}
            </span>
          ))}
        </div>
      </Card>

      {/* CTAs */}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" onClick={() => onDraftOffer?.(row.suggestedPaise)}>
          {row.offerId ? "Draft another offer" : "Draft offer"}
        </Button>
        {row.approvalStatus === "required" && row.offerId ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onRequestApproval?.(row.offerId as string)}
          >
            Request HR-head approval
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-xs text-status-error-700">{error}</p> : null}
    </div>
  );
}

function Row({
  label,
  value,
  muted,
  emphasis,
}: {
  label: string;
  value: string;
  muted?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-neutral-100 pb-1">
      <dt className="text-neutral-500">{label}</dt>
      <dd
        className={
          emphasis
            ? "font-semibold text-brand-700"
            : muted
              ? "text-neutral-400"
              : "font-medium text-neutral-900"
        }
      >
        {value}
      </dd>
    </div>
  );
}
