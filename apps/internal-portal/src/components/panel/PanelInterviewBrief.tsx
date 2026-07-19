"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { Badge, Card } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import type { GetPanelInterviewBriefOutput, InterviewRecommendation } from "@hireops/api-types";
import { BriefContent } from "./BriefContent";

/**
 * INT-03 / PANEL-02 — the candidate brief + the scorecard form for one
 * interview.
 *
 * The brief (read-only context — interview header, experience summary,
 * Resume-vs-JD skills match, previous-round feedback, and real-AI interview
 * prep) is rendered by the PANEL-02 `BriefContent` component. This file owns
 * only the scorecard form below it: MY single feedback row (1–5 per criterion,
 * strengths / concerns / notes, and a recommendation). Save draft keeps it
 * editable; Submit (recommendation required, confirm-gated) freezes it — after
 * which the whole form renders read-only.
 *
 * SEAM (PANEL-02): the scorecard block is deliberately preserved as-is for
 * PANEL-01's parallel scorecard upgrade in the main tree — only the brief
 * content above it was extracted into BriefContent.tsx.
 */

const RECOMMENDATIONS: { value: InterviewRecommendation; label: string; tone: BadgeTone }[] = [
  { value: "strong_yes", label: "Strong yes", tone: "success" },
  { value: "yes", label: "Yes", tone: "success" },
  { value: "hold", label: "Hold", tone: "warning" },
  { value: "no", label: "No", tone: "error" },
];

const SCORES = [1, 2, 3, 4, 5] as const;

/**
 * PANEL-01 — one-line criterion descriptions (UI copy). The scorecard templates
 * (SCORECARD_CRITERIA) carry keys + labels but no descriptions, so these live
 * in the portal keyed by criterion key. Purely explanatory guidance for the
 * interviewer — not scored, not persisted.
 */
const CRITERION_DESCRIPTIONS: Record<string, string> = {
  problem_solving: "Structures ambiguous problems and reasons to a sound approach.",
  technical_depth: "Depth and accuracy in the core technical domain of the role.",
  code_quality: "Clarity, correctness, and craft in how solutions are built.",
  system_design: "Designs for scale, failure, and trade-offs at the system level.",
  communication: "Explains thinking clearly and listens well.",
  ownership: "Takes end-to-end responsibility and drives outcomes.",
  stakeholder_management: "Aligns and influences across teams and levels.",
  delivery_track_record: "Evidence of shipping meaningful work reliably.",
  strategic_thinking: "Connects decisions to broader goals and second-order effects.",
  culture_alignment: "Ways of working fit how the team operates.",
  motivation: "Genuine interest in the role and the mission.",
  integrity: "Honest, professional, and consistent under pressure.",
  growth_mindset: "Seeks feedback and learns from setbacks.",
  role_competence: "Core competence for the responsibilities of this role.",
  collaboration: "Works effectively with others toward a shared result.",
};

/** The 1–5 anchor label shown under the selected score. */
const SCORE_ANCHORS: Record<number, string> = {
  1: "Well below bar",
  2: "Below bar",
  3: "At bar",
  4: "Above bar",
  5: "Well above bar",
};

export function PanelInterviewBrief({
  interviewId,
  initial,
}: {
  interviewId: string;
  initial: GetPanelInterviewBriefOutput;
}) {
  const queryClient = useQueryClient();
  const query = trpc.getPanelInterviewBrief.useQuery(
    { interviewId },
    { initialData: initial, refetchOnWindowFocus: true },
  );
  const brief = query.data;

  const submitted = brief.myFeedback.state === "submitted";

  // Form state, seeded from the persisted feedback. Scores keyed by criterion.
  const [scores, setScores] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(brief.myFeedback.criteria.map((c) => [c.key, c.score])),
  );
  const [strengths, setStrengths] = useState(brief.myFeedback.strengths ?? "");
  const [concerns, setConcerns] = useState(brief.myFeedback.concerns ?? "");
  const [notes, setNotes] = useState(brief.myFeedback.notes ?? "");
  const [recommendation, setRecommendation] = useState<InterviewRecommendation | null>(
    brief.myFeedback.recommendation,
  );
  const [error, setError] = useState<string | null>(null);
  const [triedSubmit, setTriedSubmit] = useState(false);
  // PANEL-01 — "Summarise my notes" AI assist state.
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiUnavailable, setAiUnavailable] = useState(false);

  const scorecardPayload = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(scores)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  }, [scores]);

  const save = trpc.saveInterviewFeedback.useMutation({
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: [["getPanelInterviewBrief"]] });
      void queryClient.invalidateQueries({ queryKey: [["listMyPanelInterviews"]] });
      void queryClient.invalidateQueries({ queryKey: [["getPanelDashboard"]] });
    },
    onError: (err) => handleTRPCError(err, { onMessage: setError }),
  });

  const summarize = trpc.summarizeMyFeedbackNotes.useMutation({
    onSuccess: (res) => {
      setAiError(null);
      // Write the tidied prose back INTO the editable fields — the panellist
      // reviews and edits; nothing is submitted here. Only overwrite a field
      // the model actually returned text for.
      if (res.summary.strengths) setStrengths(res.summary.strengths);
      if (res.summary.concerns) setConcerns(res.summary.concerns);
      if (res.summary.notes) setNotes(res.summary.notes);
    },
    onError: (err) => {
      const msg = err.message ?? "Couldn't summarise your notes. Try again.";
      // Honest disabled state: an admin has turned the assist off for the tenant.
      if (msg.toLowerCase().includes("disabled")) setAiUnavailable(true);
      setAiError(msg);
    },
  });

  const iv = brief.interview;
  const notesMissing = !notes.trim();
  const canSubmit = Boolean(recommendation) && !notesMissing;
  const hasDraftText = Boolean(strengths.trim() || concerns.trim() || notes.trim());

  function saveDraft() {
    save.mutate({
      interviewId,
      scorecard: scorecardPayload,
      strengths: strengths || null,
      concerns: concerns || null,
      notes: notes || null,
      recommendation,
      action: "draft",
    });
  }

  function submit() {
    setTriedSubmit(true);
    if (!recommendation) {
      setError("Pick a recommendation before submitting.");
      return;
    }
    if (notesMissing) {
      setError("Add detailed notes before submitting your scorecard.");
      return;
    }
    if (!window.confirm("Submit your scorecard? You won't be able to edit it after this.")) return;
    save.mutate({
      interviewId,
      scorecard: scorecardPayload,
      strengths: strengths || null,
      concerns: concerns || null,
      notes: notes || null,
      recommendation,
      action: "submit",
    });
  }

  function runSummarize() {
    setAiError(null);
    summarize.mutate({
      interviewId,
      strengths: strengths || null,
      concerns: concerns || null,
      notes: notes || null,
    });
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-6">
      <a href="/panel" className="mb-4 inline-block text-sm text-brand-700 hover:underline">
        ← My interviews
      </a>

      {/* PANEL-02 — the candidate brief content (context, experience, skills
          match, prior-round feedback, real-AI prep). */}
      <div className="mb-5">
        <BriefContent interviewId={interviewId} brief={brief} />
      </div>

      {/* Scorecard — PRESERVED for PANEL-01's parallel upgrade; do not restructure. */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <SectionTitle>Your scorecard</SectionTitle>
          {submitted ? (
            <Badge tone="success">Submitted {formatWhen(brief.myFeedback.submittedAt)}</Badge>
          ) : brief.myFeedback.state === "draft" ? (
            <Badge tone="warning">Draft</Badge>
          ) : null}
        </div>

        {submitted ? (
          <p className="mb-4 rounded-md bg-neutral-50 p-3 text-sm text-neutral-600">
            This scorecard has been submitted and is read-only.
          </p>
        ) : null}

        {/* Per-criterion 1–5 button rows with title + one-line guidance. */}
        <div className="space-y-4">
          {brief.myFeedback.criteria.map((c) => {
            const value = scores[c.key] ?? null;
            return (
              <div key={c.key} className="rounded-lg border border-neutral-200 bg-white px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-neutral-900">{c.label}</p>
                    {CRITERION_DESCRIPTIONS[c.key] ? (
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {CRITERION_DESCRIPTIONS[c.key]}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {SCORES.map((n) => {
                      const active = value === n;
                      return (
                        <button
                          key={n}
                          type="button"
                          disabled={submitted}
                          onClick={() => setScores((prev) => ({ ...prev, [c.key]: n }))}
                          className={scoreButtonClass(active, submitted)}
                          aria-pressed={active}
                          aria-label={`${c.label}: ${n} — ${SCORE_ANCHORS[n]}`}
                        >
                          {n}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {value !== null ? (
                  <p className="mt-2 text-right text-[11px] font-medium uppercase tracking-wide text-brand-700">
                    {SCORE_ANCHORS[value]}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Strengths / Concerns paired panels (green / red headers). */}
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-status-positive-200 bg-status-positive-50/40 p-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-status-positive-700">
              Strengths
            </p>
            <PlainTextArea value={strengths} onChange={setStrengths} disabled={submitted} />
          </div>
          <div className="rounded-lg border border-status-error-200 bg-status-error-50/40 p-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-status-error-700">
              Concerns
            </p>
            <PlainTextArea value={concerns} onChange={setConcerns} disabled={submitted} />
          </div>
        </div>

        {/* Detailed notes — mandatory before submit. */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Detailed notes <span className="text-status-error-600">*</span>
            </span>
            <span className="text-[11px] text-neutral-400">Private to the hiring team</span>
          </div>
          <PlainTextArea
            value={notes}
            onChange={setNotes}
            disabled={submitted}
            rows={4}
            invalid={triedSubmit && notesMissing}
          />
          {triedSubmit && notesMissing ? (
            <p className="mt-1 text-xs text-status-error-700">
              Detailed notes are required before you can submit.
            </p>
          ) : null}

          {/* "Summarise my notes" AI assist. */}
          {!submitted ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={summarize.isPending || aiUnavailable || !hasDraftText}
                onClick={runSummarize}
              >
                {summarize.isPending ? "Summarising…" : "Summarise my notes"}
              </Button>
              <span className="text-[11px] text-neutral-400">
                {aiUnavailable
                  ? "Note summarising is turned off for this tenant."
                  : "Tidies your own words back into these fields. You review and submit — nothing is auto-submitted."}
              </span>
            </div>
          ) : null}
          {aiError && !aiUnavailable ? (
            <p className="mt-1 text-xs text-status-error-700">{aiError}</p>
          ) : null}
        </div>

        {/* Overall recommendation — four equal-width buttons. */}
        <div className="mt-5">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Overall recommendation <span className="text-status-error-600">*</span>
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {RECOMMENDATIONS.map((r) => {
              const active = recommendation === r.value;
              return (
                <button
                  key={r.value}
                  type="button"
                  disabled={submitted}
                  onClick={() => setRecommendation(r.value)}
                  className={recommendationButtonClass(active, submitted)}
                  aria-pressed={active}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>

        {error ? <p className="mt-4 text-sm text-status-error-700">{error}</p> : null}

        {!submitted ? (
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={save.isPending} onClick={saveDraft}>
              Save draft
            </Button>
            <Button variant="primary" disabled={save.isPending || !canSubmit} onClick={submit}>
              Submit scorecard
            </Button>
            {!canSubmit ? (
              <span className="text-[11px] text-neutral-400">
                {!recommendation && notesMissing
                  ? "Pick a recommendation and add notes to submit."
                  : !recommendation
                    ? "Pick a recommendation to submit."
                    : "Add detailed notes to submit."}
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold text-neutral-900">{children}</h3>;
}

function PlainTextArea({
  value,
  onChange,
  disabled,
  rows = 3,
  invalid = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  rows?: number;
  invalid?: boolean;
}) {
  return (
    <textarea
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      className={
        "w-full rounded-md border px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-1 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500 " +
        (invalid
          ? "border-status-error-400 focus:border-status-error-500 focus:ring-status-error-500"
          : "border-neutral-300 bg-white focus:border-brand-500 focus:ring-brand-500")
      }
    />
  );
}

function scoreButtonClass(active: boolean, disabled: boolean): string {
  const base = "h-9 w-9 rounded-md border text-sm font-medium transition-colors";
  if (active) return `${base} border-brand-600 bg-brand-600 text-white`;
  if (disabled) return `${base} border-neutral-200 bg-neutral-50 text-neutral-400`;
  return `${base} border-neutral-300 text-neutral-600 hover:bg-neutral-100`;
}

function recommendationButtonClass(active: boolean, disabled: boolean): string {
  const base =
    "w-full rounded-md border px-3 py-2 text-sm font-medium transition-colors text-center";
  if (active) return `${base} border-brand-600 bg-brand-600 text-white`;
  if (disabled) return `${base} border-neutral-200 bg-neutral-50 text-neutral-400`;
  return `${base} border-neutral-300 text-neutral-600 hover:bg-neutral-100`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "TBC";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
