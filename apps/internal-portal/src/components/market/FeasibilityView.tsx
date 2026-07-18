"use client";

import { useState } from "react";
import type {
  ListRequisitionFeasibilityOutput,
  FeasibilityCard,
  FeasibilityDifficulty,
} from "@hireops/api-types";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { IntelPageHeader } from "./IntelPageHeader";

/**
 * Feasibility Reports — a card grid mirroring the prototype anatomy: two fit
 * bars (skills / experience-vs-comp), a difficulty chip, market-median-vs-
 * budget, a salary-adjustment callout, the recommendation paragraph, and a
 * supply note. Each card carries a "Generate/Refresh assessment" button that
 * fires exactly ONE real AI call. Cards with no assessment show an honest
 * empty state instead of fabricated numbers.
 */

const DIFFICULTY_TONE: Record<FeasibilityDifficulty, BadgeTone> = {
  low: "success",
  medium: "warning",
  high: "error",
};

/** paise (minor) → ₹X LPA label. */
function minorToLpaLabel(minor: number | null): string | null {
  if (minor == null) return null;
  const s = (minor / 10_000_000).toFixed(1).replace(/\.0$/, "");
  return `₹${s} LPA`;
}

/** major rupees (numeric string) → ₹X LPA label. */
function majorToLpaLabel(major: string | null): string | null {
  if (major == null) return null;
  const s = (Number(major) / 100_000).toFixed(1).replace(/\.0$/, "");
  return `₹${s} LPA`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusTone(status: string): BadgeTone {
  if (status === "posted" || status === "approved") return "success";
  if (status === "pending_approval") return "warning";
  return "neutral";
}

export function FeasibilityView({ initial }: { initial: ListRequisitionFeasibilityOutput }) {
  const query = trpc.listRequisitionFeasibility.useQuery(
    {},
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: true },
  );
  const cards = query.data?.cards ?? [];

  return (
    <>
      <IntelPageHeader
        title="Feasibility reports"
        subtitle={
          <>
            How fillable each requisition is, assessed against your curated market benchmarks.{" "}
            <span className="font-medium text-neutral-600">
              Each assessment is a real, cost-logged AI call — run on demand, never fabricated.
            </span>
          </>
        }
      />

      {cards.length === 0 ? (
        <EmptyState
          title="No open requisitions to assess"
          hint="Feasibility covers your live requisitions (draft through posted). When one exists, generate an assessment against your market benchmarks here."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {cards.map((card) => (
            <FeasibilityCardView
              key={card.requisitionId}
              card={card}
              onGenerated={() => void query.refetch()}
            />
          ))}
        </div>
      )}
    </>
  );
}

function FitBar({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 70
      ? "bg-status-positive-500"
      : value >= 45
        ? "bg-status-warning-500"
        : "bg-status-error-500";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-neutral-600">{label}</span>
        <span className="font-medium text-neutral-900">{value}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className={`h-full rounded-full ${tone}`}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  );
}

function FeasibilityCardView({
  card,
  onGenerated,
}: {
  card: FeasibilityCard;
  onGenerated: () => void;
}) {
  const generate = trpc.generateRequisitionFeasibility.useMutation();
  const [error, setError] = useState<string | null>(null);
  const [localCard, setLocalCard] = useState<FeasibilityCard>(card);

  async function run() {
    setError(null);
    try {
      const res = await generate.mutateAsync({ requisitionId: card.requisitionId });
      setLocalCard(res.card);
      onGenerated();
    } catch (err) {
      handleTRPCError(err, { onMessage: (m) => setError(m) });
      setError("Could not generate the assessment. Please try again.");
    }
  }

  const c = localCard;
  const a = c.assessment;
  const medianLabel = minorToLpaLabel(c.benchmark.medianSalaryMinor);
  const budgetLabel =
    majorToLpaLabel(c.compBandMin) && majorToLpaLabel(c.compBandMax)
      ? `${majorToLpaLabel(c.compBandMin)} – ${majorToLpaLabel(c.compBandMax)}`
      : null;

  return (
    <Card padded={false} className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">{c.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={statusTone(c.status)}>{cap(c.status.replace(/_/g, " "))}</Badge>
            {c.seniority ? <span className="text-xs text-neutral-500">{c.seniority}</span> : null}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={run} disabled={generate.isPending}>
          {generate.isPending ? "Assessing…" : a ? "Refresh" : "Generate assessment"}
        </Button>
      </div>

      {/* Median vs budget — shown whether or not an assessment exists. */}
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
        {c.benchmark.matchedRoleTitle ? (
          <>
            Market median <span className="font-medium text-neutral-900">{medianLabel}</span>
            {" · benchmark "}
            <span className="text-neutral-500">{c.benchmark.matchedRoleTitle}</span>
            {budgetLabel ? (
              <>
                {" · budget "}
                <span className="font-medium text-neutral-900">{budgetLabel}</span>
              </>
            ) : (
              " · no comp band set"
            )}
          </>
        ) : (
          <>
            No market benchmark matched this title — assessments run in honest benchmark-free mode.
            {budgetLabel ? (
              <>
                {" Budget "}
                <span className="font-medium text-neutral-900">{budgetLabel}</span>.
              </>
            ) : null}
          </>
        )}
      </div>

      {a ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FitBar label="Skills fit" value={a.skillsFit} />
            <FitBar label="Experience vs comp" value={a.expCompFit} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-600">Difficulty to fill</span>
            <Badge tone={DIFFICULTY_TONE[a.difficulty]}>{cap(a.difficulty)}</Badge>
            {a.recommendedSalaryAdjustmentPct != null && a.recommendedSalaryAdjustmentPct !== 0 ? (
              <span
                className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                  a.recommendedSalaryAdjustmentPct > 0
                    ? "bg-status-warning-50 text-status-warning-700"
                    : "bg-status-positive-50 text-status-positive-700"
                }`}
              >
                {a.recommendedSalaryAdjustmentPct > 0 ? "▲" : "▼"} Suggest{" "}
                {a.recommendedSalaryAdjustmentPct > 0 ? "+" : ""}
                {a.recommendedSalaryAdjustmentPct}% budget
              </span>
            ) : (
              <span className="text-xs text-neutral-400">No budget change suggested</span>
            )}
          </div>

          <p className="text-sm leading-relaxed text-neutral-700">{a.recommendation}</p>
          <p className="border-t border-neutral-100 pt-3 text-xs text-neutral-500">
            <span className="font-medium text-neutral-600">Talent supply:</span> {a.supplyNote}
          </p>

          {c.generatedAt ? (
            <p className="text-[11px] text-neutral-400">
              Assessed {new Date(c.generatedAt).toLocaleString("en-GB")}
              {c.model ? ` · ${c.model}` : ""}
              {c.promptVersion ? ` · ${c.promptVersion}` : ""}
            </p>
          ) : null}
        </>
      ) : (
        <div className="rounded-md border border-dashed border-neutral-200 px-4 py-6 text-center">
          <p className="text-sm font-medium text-neutral-700">No assessment yet</p>
          <p className="mt-1 text-xs text-neutral-500">
            Generate one to see skills fit, difficulty, and a salary recommendation for this role.
          </p>
        </div>
      )}

      {error ? <p className="text-xs text-status-error-700">{error}</p> : null}
    </Card>
  );
}
