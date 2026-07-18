"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { InterviewRow, InterviewRecommendation } from "@hireops/api-types";

/**
 * INT-04 — recruiter completion + advance controls for a single interview row,
 * embedded in the triage-drawer Interviews section. When every panelist has
 * submitted, offers "Complete interview"; a partial panel gets an explicit
 * force path (reason required). Completion never auto-advances — it surfaces
 * the suggested next stage and the recruiter advances explicitly, alongside the
 * decision summary (full scores, recommendations, lead highlighted).
 */

const REC_LABEL: Record<InterviewRecommendation, string> = {
  strong_yes: "Strong yes",
  yes: "Yes",
  hold: "Hold",
  no: "No",
};
const REC_TONE: Record<InterviewRecommendation, BadgeTone> = {
  strong_yes: "success",
  yes: "success",
  hold: "warning",
  no: "error",
};
const STAGE_LABEL: Record<string, string> = {
  hr_round: "HR round",
  offer_drafted: "Offer stage",
};

/** Client mirror of the server's interviewStageContext (router.ts). */
function suggestedNextStage(scorecardTemplate: string): string | null {
  return scorecardTemplate === "hr" ? "offer_drafted" : "hr_round";
}

export function InterviewDecisionControls({
  interview,
  onChanged,
}: {
  interview: InterviewRow;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [showForce, setShowForce] = useState(false);
  const [reason, setReason] = useState("");
  const [showSummary, setShowSummary] = useState(false);

  const isCompleted = interview.status === "completed";
  const summary = trpc.getInterviewDecisionSummary.useQuery(
    { interviewId: interview.id },
    { enabled: isCompleted || showSummary },
  );

  const invalidateStage = () => {
    void queryClient.invalidateQueries({ queryKey: [["listCandidates"]] });
    void queryClient.invalidateQueries({ queryKey: [["getInterviewDecisionSummary"]] });
  };

  const complete = trpc.completeInterview.useMutation({
    onSuccess: () => {
      setShowForce(false);
      setReason("");
      onChanged();
    },
  });
  const noShow = trpc.markInterviewNoShow.useMutation({ onSuccess: onChanged });
  const advance = trpc.advanceApplicationAfterInterview.useMutation({
    onSuccess: () => {
      invalidateStage();
      onChanged();
    },
  });

  const submitted = interview.panel.filter((p) => p.feedbackState === "submitted").length;
  const total = interview.panel.length;
  const allSubmitted = total > 0 && submitted === total;
  const busy = complete.isPending || noShow.isPending || advance.isPending;
  const err = complete.error?.message ?? noShow.error?.message ?? advance.error?.message ?? null;

  // ─── scheduled: complete / force / no-show ───
  if (interview.status === "scheduled") {
    return (
      <div className="mt-2 space-y-2 border-t border-neutral-100 pt-2">
        <p className="text-xs text-neutral-500">
          Scorecards submitted: {submitted}/{total || "—"}
        </p>
        {allSubmitted ? (
          <div className="flex items-center gap-2">
            <Badge tone="success">Ready to complete</Badge>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => complete.mutate({ interviewId: interview.id })}
            >
              {complete.isPending ? "Completing…" : "Complete interview"}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => setShowForce((v) => !v)}
              >
                Complete anyway…
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const r = window.prompt("No-show reason (optional)?", "") ?? undefined;
                  noShow.mutate({ interviewId: interview.id, reason: r || undefined });
                }}
              >
                Mark no-show
              </Button>
            </div>
            {showForce ? (
              <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-2">
                <p className="text-xs text-neutral-600">
                  Not every panelist has submitted. Give a reason to complete early.
                </p>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. one panelist was a no-show"
                  className="w-full rounded-md border border-neutral-300 p-2 text-sm"
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy || reason.trim().length === 0}
                  onClick={() =>
                    complete.mutate({
                      interviewId: interview.id,
                      force: true,
                      reason: reason.trim(),
                    })
                  }
                >
                  {complete.isPending ? "Completing…" : "Force complete"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowSummary((v) => !v)}
          className="text-xs text-brand-700 hover:underline"
        >
          {showSummary ? "Hide scorecards" : "View scorecards"}
        </button>
        {showSummary && summary.data ? (
          <DecisionSummary summary={summary.data} interviewId={interview.id} canReopen />
        ) : null}
        {err ? <p className="text-xs text-status-error-700">{err}</p> : null}
      </div>
    );
  }

  // ─── completed: advance + decision summary ───
  if (isCompleted) {
    const template = summary.data?.scorecardTemplate ?? "general";
    const nextStage = suggestedNextStage(template);
    return (
      <div className="mt-2 space-y-2 border-t border-neutral-100 pt-2">
        {summary.data ? (
          <DecisionSummary summary={summary.data} interviewId={interview.id} canReopen={false} />
        ) : null}
        {nextStage ? (
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => advance.mutate({ interviewId: interview.id })}
            >
              {advance.isPending
                ? "Advancing…"
                : `Advance to ${STAGE_LABEL[nextStage] ?? nextStage}`}
            </Button>
          </div>
        ) : null}
        {err ? <p className="text-xs text-status-error-700">{err}</p> : null}
      </div>
    );
  }

  return null;
}

interface Summary {
  roundName: string;
  status: string;
  rollup: {
    panelistCount: number;
    submittedCount: number;
    counts: { strong_yes: number; yes: number; hold: number; no: number };
    leadRecommendation: InterviewRecommendation | null;
  };
  panelists: {
    membershipId: string;
    name: string | null;
    isLead: boolean;
    feedbackState: "none" | "draft" | "submitted";
    recommendation: InterviewRecommendation | null;
    scorecard: { key: string; label: string; score: number | null }[];
  }[];
}

function DecisionSummary({
  summary,
  interviewId,
  canReopen,
}: {
  summary: Summary;
  interviewId: string;
  /** Reopen is offered only on non-completed interviews — reopening after
   * completion is a server-side CONFLICT (it would corrupt the decision). */
  canReopen: boolean;
}) {
  const { rollup } = summary;
  const queryClient = useQueryClient();
  const reopen = trpc.reopenInterviewFeedback.useMutation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [["getInterviewDecisionSummary"]] });
      void queryClient.invalidateQueries({ queryKey: [["listCandidates"]] });
    },
  });
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-neutral-700">Decision summary</span>
        {rollup.leadRecommendation ? (
          <Badge tone={REC_TONE[rollup.leadRecommendation]}>
            Lead: {REC_LABEL[rollup.leadRecommendation]}
          </Badge>
        ) : (
          <span className="text-neutral-400">Lead recommendation pending</span>
        )}
        <span className="text-neutral-500">
          {rollup.submittedCount}/{rollup.panelistCount} submitted · SY {rollup.counts.strong_yes} ·
          Y {rollup.counts.yes} · H {rollup.counts.hold} · N {rollup.counts.no}
        </span>
      </div>
      <div className="space-y-2">
        {summary.panelists.map((p) => (
          <div
            key={p.membershipId}
            className={
              p.isLead
                ? "rounded border border-brand-200 bg-brand-50/40 p-2"
                : "rounded border border-neutral-100 p-2"
            }
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-medium text-neutral-800">
                {p.name ?? "Panellist"}
                {p.isLead ? <span className="ml-1 text-brand-700">· lead</span> : null}
              </span>
              <div className="flex items-center gap-2">
                {p.recommendation ? (
                  <Badge tone={REC_TONE[p.recommendation]}>{REC_LABEL[p.recommendation]}</Badge>
                ) : (
                  <span className="text-neutral-400">No recommendation</span>
                )}
                {canReopen && p.feedbackState === "submitted" ? (
                  <button
                    type="button"
                    disabled={reopen.isPending}
                    onClick={() => {
                      const reason = window.prompt(
                        `Reopen ${p.name ?? "this panellist"}'s scorecard? Give a reason (audited):`,
                        "",
                      );
                      if (!reason || reason.trim().length === 0) return;
                      reopen.mutate({
                        interviewId,
                        membershipId: p.membershipId,
                        reason: reason.trim(),
                      });
                    }}
                    className="text-xs text-brand-700 hover:underline disabled:opacity-50"
                  >
                    {reopen.isPending ? "Reopening…" : "Reopen"}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-neutral-600">
              {p.scorecard.map((c) => (
                <span key={c.key}>
                  {c.label}: <span className="font-medium">{c.score ?? "—"}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      {reopen.error ? (
        <p className="mt-2 text-xs text-status-error-700">{reopen.error.message}</p>
      ) : null}
    </div>
  );
}
