"use client";

import { useState } from "react";
import { Badge } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { GetCandidateAssessmentSummaryOutput } from "@hireops/api-types";
import { AssessmentRoundCard } from "./AssessmentRoundCard";
import { SelectionDecisionControls } from "./SelectionDecisionControls";

/**
 * PC-11 — the consolidated Assessment summary for one application: every round
 * the viewer may see, in order, plus a screening snapshot and (for deciders)
 * the PC-12 selection decision. Every number is a COUNT of human
 * recommendations or an AVERAGE of human ratings; the AI interview and the
 * notetaker contribute evidence only. The panel never proposes a decision.
 *
 * Collapsed by default (one query per open panel), the same posture as the
 * interview list's decision / recording panels. A 403 (the viewer is neither on
 * the hiring team nor on any of the candidate's panels) renders nothing.
 */

function Screening({ s }: { s: NonNullable<GetCandidateAssessmentSummaryOutput["screening"]> }) {
  const ko = s.knockout;
  const koLabel: Record<typeof ko.status, string> = {
    passed: "Knockout questions: passed",
    failed: "Knockout questions: failed",
    unverified: "Knockout questions: not verifiable from the CV",
    not_evaluated: "Knockout questions: not evaluated",
  };
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 text-xs text-neutral-700">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        Screening snapshot
      </p>
      <p>
        {koLabel[ko.status]}
        {ko.configuredCount > 0 ? ` (${ko.configuredCount} configured)` : ""}
      </p>
      {ko.failures.length > 0 ? (
        <ul className="mt-1 list-disc pl-4">
          {ko.failures.map((f, i) => (
            <li key={i}>
              {f.question} — {f.result === "failed" ? "not met" : "could not be verified"}
            </li>
          ))}
        </ul>
      ) : null}
      {s.mustHaves ? (
        <p className="mt-1">
          Required skills on the CV: {s.mustHaves.matched.length} of{" "}
          {s.mustHaves.matched.length + s.mustHaves.missing.length}
          {s.mustHaves.missing.length > 0 ? ` · missing: ${s.mustHaves.missing.join(", ")}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function SummaryBody({ applicationId }: { applicationId: string }) {
  const q = trpc.getCandidateAssessmentSummary.useQuery({ applicationId }, { retry: false });
  if (q.isLoading) return <p className="text-xs text-neutral-500">Loading assessment…</p>;
  if (q.error) {
    return q.error.data?.code === "FORBIDDEN" ? (
      <p className="text-xs text-neutral-500">{q.error.message}</p>
    ) : (
      <p className="text-xs text-status-error-700">Couldn&apos;t load the assessment summary.</p>
    );
  }
  if (!q.data) return null;
  const d = q.data;
  const o = d.overall;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
        {d.viewer.mode === "panellist" ? (
          <Badge tone="info">Showing the rounds you sat on</Badge>
        ) : null}
        <span>
          {o.roundCount} round{o.roundCount === 1 ? "" : "s"} · {o.completedRoundCount} completed
        </span>
        {o.submittedScorecards > 0 ? (
          <span className="font-semibold text-neutral-800">
            {o.positiveScorecards} of {o.submittedScorecards} scorecards: Yes or Strong yes
          </span>
        ) : (
          <span>No scorecards submitted yet</span>
        )}
      </div>

      {d.screening ? <Screening s={d.screening} /> : null}

      {d.rounds.length === 0 ? (
        <p className="text-xs text-neutral-500">No interview rounds yet.</p>
      ) : (
        d.rounds.map((r) => <AssessmentRoundCard key={r.interviewId} round={r} />)
      )}

      {d.viewer.canDecide ? (
        <SelectionDecisionControls
          applicationId={applicationId}
          currentStage={d.application.currentStage}
          reasons={d.decisionReasons}
        />
      ) : null}

      <p className="text-[11px] text-neutral-400">
        Counts and averages come from the panel&apos;s own scorecards. AI interview and notetaker
        output is evidence for the panel, never a score.
      </p>
    </div>
  );
}

export function AssessmentSummaryPanel({
  applicationId,
  defaultOpen = false,
}: {
  applicationId: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Assessment summary
        </span>
        <span className="text-xs font-medium text-brand-700">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="mt-3">
          <SummaryBody applicationId={applicationId} />
        </div>
      ) : null}
    </section>
  );
}
