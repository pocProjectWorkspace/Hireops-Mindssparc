"use client";

import { useState } from "react";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Card, Button } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import {
  REVISION_AREA_LABELS,
  type GetReqRevisionSuggestionsOutput,
  type RevisionArea,
} from "@hireops/api-types";

/**
 * RevisionSuggestionsCard (RO-01) — the AI revision-suggestions surface for a
 * REJECTED requisition. Real AI (feature req_revision, cost-logged, kill-switch
 * honoured). Grounded ONLY in the rejection reason, the req's own fields, and
 * curated benchmarks — nothing auto-applies. "Apply suggestions" opens the
 * requisition detail/edit surface where the human reviews and resubmits through
 * the normal path.
 *
 * Renders nothing when the req isn't rejected. Shows an honest disabled state
 * when the feature kill-switch is off.
 */

const AREA_CLS: Record<RevisionArea, string> = {
  budget: "bg-status-info-50 text-status-info-700",
  skills: "bg-brand-50 text-brand-700",
  seniority: "bg-status-warning-50 text-status-warning-800",
  location: "bg-status-positive-50 text-status-positive-700",
  scope: "bg-neutral-100 text-neutral-600",
  other: "bg-neutral-100 text-neutral-600",
};

export function RevisionSuggestionsCard({
  requisitionId,
  initialData,
  showApply = true,
}: {
  requisitionId: string;
  initialData?: GetReqRevisionSuggestionsOutput;
  /** Show the "Apply suggestions" link (hidden when already on the detail page). */
  showApply?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const query = trpc.getReqRevisionSuggestions.useQuery(
    { requisitionId },
    initialData ? { initialData } : undefined,
  );
  const generate = trpc.generateReqRevisionSuggestions.useMutation();

  const data = query.data;
  // Not rejected → this card has nothing to say. Stay out of the way.
  if (!data || !data.eligible) return null;

  const suggestions = data.suggestions?.suggestions ?? [];

  async function onGenerate() {
    setError(null);
    try {
      await generate.mutateAsync({ requisitionId });
      await query.refetch();
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    }
  }

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-100 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">AI revision suggestions</h3>
          <p className="mt-0.5 text-xs text-neutral-500">
            Grounded in the rejection reason, this requisition&apos;s fields, and curated
            benchmarks. Nothing is applied automatically — you review and resubmit.
          </p>
        </div>
        {data.featureEnabled ? (
          <Button variant="secondary" size="sm" onClick={onGenerate} disabled={generate.isPending}>
            {generate.isPending
              ? "Generating…"
              : suggestions.length > 0
                ? "Regenerate"
                : "Generate suggestions"}
          </Button>
        ) : null}
      </div>

      <div className="px-4 py-3">
        {!data.featureEnabled ? (
          <p className="text-sm text-neutral-500">
            Revision suggestions are turned off for your organisation. An administrator can
            re-enable them in Admin → AI settings.
          </p>
        ) : error ? (
          <p className="rounded-md bg-status-error-50 px-3 py-2 text-sm text-status-error-700">
            {error}
          </p>
        ) : suggestions.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {data.suggestions?.rejectionReason
              ? `Rejected: "${data.suggestions.rejectionReason}". `
              : ""}
            Generate suggestions to see concrete revisions that address the rejection.
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-3">
              {suggestions.map((s, i) => (
                <li key={`${s.area}-${i}`} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                        AREA_CLS[s.area],
                      )}
                    >
                      {REVISION_AREA_LABELS[s.area]}
                    </span>
                    <span className="text-sm font-medium text-neutral-900">{s.title}</span>
                  </div>
                  <p className="text-sm text-neutral-600">{s.detail}</p>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-3 border-t border-neutral-100 pt-3">
              {showApply ? (
                <a
                  href={`/requisitions/${requisitionId}`}
                  className="inline-flex h-9 items-center justify-center rounded-button bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700"
                >
                  Apply suggestions
                </a>
              ) : null}
              <span className="text-xs text-neutral-400">
                {data.suggestions?.model ? `via ${data.suggestions.model}` : null}
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong. Please try again.";
}
