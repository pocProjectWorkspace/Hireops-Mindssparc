"use client";

import { useState } from "react";
import { Badge } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { InterviewNotesView } from "@/components/interviews/InterviewNotesView";
import {
  useApplicationStageLabel,
  useRecommendationLabel,
} from "@/components/TenantLabelsProvider";
import type {
  AssessmentFeedbackEntry,
  AssessmentRound,
  InterviewRecommendation,
} from "@hireops/api-types";

/**
 * PC-11 — one interview round inside the Assessment summary: who sat on it,
 * each panellist's recommendation + ratings + written feedback (as far as the
 * server disclosed it), the human-rating averages, the outcome, the AI
 * interview EVIDENCE digest (coverage + quotes — never a score) and the
 * notetaker notes (opened through getInterviewNotes, which re-checks access).
 */

export const REC_TONE: Record<InterviewRecommendation, BadgeTone> = {
  strong_yes: "success",
  yes: "success",
  hold: "warning",
  no: "error",
};
const MODE_LABEL: Record<string, string> = {
  video: "Video",
  onsite: "On-site",
  phone: "Phone",
  ai_async: "AI interview",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "Date TBC";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Date TBC";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function outcomeBadge(
  round: AssessmentRound,
  stageLabel: (stage: string | null | undefined) => string,
): { label: string; tone: BadgeTone } {
  const o = round.outcome;
  switch (o.kind) {
    case "advanced":
      return {
        label: `Advanced to ${stageLabel(o.advancedToStage)}`,
        tone: "success",
      };
    case "completed":
      return { label: "Completed", tone: "info" };
    case "awaiting_feedback":
      return { label: "Awaiting feedback", tone: "warning" };
    case "no_show":
      return { label: "No-show", tone: "error" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    default:
      return { label: "Scheduled", tone: "neutral" };
  }
}

function FeedbackEntry({ f }: { f: AssessmentFeedbackEntry }) {
  // CFG-LITE — tenant recommendation wording.
  const recLabel = useRecommendationLabel();
  const who = `${f.name ?? "Panellist"}${f.isMe ? " (you)" : ""}`;
  return (
    <li className="rounded-md border border-neutral-100 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-neutral-800">
          {who}
          {f.isLead ? <span className="ml-1 text-xs text-brand-700">· lead</span> : null}
        </span>
        {f.disclosure === "hidden" ? (
          <span className="text-xs text-neutral-400">
            {f.feedbackState === "submitted"
              ? "Submitted — visible after you submit yours"
              : "Not submitted"}
          </span>
        ) : f.recommendation ? (
          <Badge tone={REC_TONE[f.recommendation]}>{recLabel(f.recommendation)}</Badge>
        ) : (
          <span className="text-xs text-neutral-400">
            {f.feedbackState === "draft" ? "Draft" : "Not submitted"}
          </span>
        )}
      </div>
      {f.ratings.some((r) => r.score != null) ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {f.ratings.map((r) => (
            <span
              key={r.key}
              className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-700"
            >
              {r.label}: <span className="font-semibold tabular-nums">{r.score ?? "—"}</span>
            </span>
          ))}
        </div>
      ) : null}
      {f.strengths ? (
        <p className="mt-2 text-xs text-neutral-700">
          <span className="font-semibold text-status-positive-700">Strengths: </span>
          {f.strengths}
        </p>
      ) : null}
      {f.concerns ? (
        <p className="mt-1 text-xs text-neutral-700">
          <span className="font-semibold text-status-warning-800">Concerns: </span>
          {f.concerns}
        </p>
      ) : null}
      {f.notes ? (
        <p className="mt-1 whitespace-pre-wrap text-xs text-neutral-600">{f.notes}</p>
      ) : null}
    </li>
  );
}

function AiEvidence({ round }: { round: AssessmentRound }) {
  const ev = round.aiEvidence;
  if (!ev) return null;
  return (
    <div className="rounded-md border border-brand-100 bg-brand-50/40 p-3">
      <p className="text-xs font-semibold text-neutral-700">
        AI interview evidence{" "}
        <span className="font-normal text-neutral-500">· evidence, not a score</span>
      </p>
      {ev.restricted ? (
        <p className="mt-1 text-xs text-neutral-500">
          AI interview evidence is visible to recruiters and hiring managers.
        </p>
      ) : ev.status !== "done" ? (
        <p className="mt-1 text-xs text-neutral-500">
          {ev.status === "none"
            ? "No evidence report for this round yet."
            : `Evidence report: ${ev.status}.`}
        </p>
      ) : (
        <div className="mt-2 space-y-2 text-xs text-neutral-700">
          {ev.answeredCount != null && ev.questionCount != null ? (
            <p>
              {ev.answeredCount} of {ev.questionCount} questions answered
            </p>
          ) : null}
          {ev.summary ? <p>{ev.summary}</p> : null}
          {ev.coverage.length > 0 ? (
            <ul className="space-y-0.5">
              {ev.coverage.map((c) => (
                <li key={c.rubricKey}>
                  <span className="font-medium">{c.label}</span>: covered in {c.covered}, partly in{" "}
                  {c.partial}, not covered in {c.notCovered} answer
                  {c.covered + c.partial + c.notCovered === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          ) : null}
          {ev.quotes.length > 0 ? (
            <ul className="space-y-1">
              {ev.quotes.map((q, i) => (
                <li key={i} className="border-l-2 border-brand-200 pl-2 italic text-neutral-600">
                  “{q.quote}” <span className="not-italic text-neutral-400">— {q.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function AssessmentRoundCard({ round }: { round: AssessmentRound }) {
  const [showNotes, setShowNotes] = useState(false);
  // CFG-LITE — tenant stage + recommendation wording.
  const stageLabel = useApplicationStageLabel();
  const recLabel = useRecommendationLabel();
  const badge = outcomeBadge(round, stageLabel);
  const { rollup } = round;
  const nt = round.notetaker;
  return (
    <details className="group rounded-lg border border-neutral-200 bg-neutral-50/60" open>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3">
        <span className="text-sm font-semibold text-neutral-900">
          Round {round.roundNumber}: {round.roundName}
        </span>
        <span className="text-xs text-neutral-500">
          {fmtDate(round.completedAt ?? round.scheduledStart)} ·{" "}
          {MODE_LABEL[round.mode] ?? round.mode}
        </span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </summary>

      <div className="space-y-3 px-4 pb-4">
        {rollup.panelistCount > 0 ? (
          <p className="text-xs text-neutral-600">
            {rollup.positiveCount != null ? (
              <>
                <span className="font-semibold text-neutral-800">
                  {rollup.positiveCount} of {rollup.panelistCount} panellists: {recLabel("yes")} or{" "}
                  {recLabel("strong_yes")}
                </span>
                {" · "}
                {rollup.submittedCount} submitted
                {rollup.counts && rollup.counts.hold + rollup.counts.no > 0
                  ? ` · ${rollup.counts.hold} ${recLabel("hold").toLowerCase()} · ${rollup.counts.no} ${recLabel("no").toLowerCase()}`
                  : ""}
                {rollup.leadRecommendation ? ` · lead: ${recLabel(rollup.leadRecommendation)}` : ""}
              </>
            ) : (
              <>
                {rollup.submittedCount} of {rollup.panelistCount} scorecards submitted — the
                panel&apos;s feedback is shown once you submit yours.
              </>
            )}
          </p>
        ) : null}

        {round.criterionAverages.some((c) => c.average != null) ? (
          <div>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
              Average panel rating (human scorecards, 1–5)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {round.criterionAverages.map((c) => (
                <span
                  key={c.key}
                  className="rounded bg-white px-1.5 py-0.5 text-[11px] text-neutral-700 ring-1 ring-inset ring-neutral-200"
                >
                  {c.label}:{" "}
                  <span className="font-semibold tabular-nums">
                    {c.average != null ? c.average.toFixed(1) : "—"}
                  </span>
                  <span className="text-neutral-400"> ({c.ratingCount})</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {round.feedback.length > 0 ? (
          <ul className="space-y-2">
            {round.feedback.map((f) => (
              <FeedbackEntry key={f.membershipId} f={f} />
            ))}
          </ul>
        ) : round.mode !== "ai_async" ? (
          <p className="text-xs text-neutral-500">No panel assigned.</p>
        ) : null}

        <AiEvidence round={round} />

        {nt && (nt.hasNotes || nt.hasTranscript) ? (
          <div>
            <button
              type="button"
              onClick={() => setShowNotes((v) => !v)}
              className="text-xs font-medium text-brand-700 hover:underline"
            >
              {showNotes ? "Hide notetaker summary" : "Notetaker summary & transcript"}
            </button>
            {showNotes ? (
              <div className="mt-2">
                <InterviewNotesView interviewId={round.interviewId} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}
