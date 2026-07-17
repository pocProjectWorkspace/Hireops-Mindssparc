"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { Badge, Card } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import type { GetPanelInterviewBriefOutput, InterviewRecommendation } from "@hireops/api-types";

/**
 * INT-03 — the candidate brief + the scorecard form for one interview.
 *
 * The brief is read-only context: candidate facet, round competencies,
 * co-panelists, and prior-round submitted feedback (recommendation +
 * strengths + concerns only — no scores, by design). The scorecard is MY
 * single feedback row: 1–5 per criterion, strengths / concerns / notes, and a
 * recommendation. Save draft keeps it editable; Submit (recommendation
 * required, confirm-gated) freezes it — after which the whole form renders
 * read-only.
 */

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

const RECOMMENDATIONS: { value: InterviewRecommendation; label: string; tone: BadgeTone }[] = [
  { value: "strong_yes", label: "Strong yes", tone: "success" },
  { value: "yes", label: "Yes", tone: "success" },
  { value: "hold", label: "Hold", tone: "warning" },
  { value: "no", label: "No", tone: "error" },
];

const SCORES = [1, 2, 3, 4, 5] as const;

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
    },
    onError: (err) => handleTRPCError(err, { onMessage: setError }),
  });

  const iv = brief.interview;

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
    if (!recommendation) {
      setError("Pick a recommendation before submitting.");
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

  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-6">
      <a href="/panel" className="mb-4 inline-block text-sm text-brand-700 hover:underline">
        ← My interviews
      </a>

      {/* Header */}
      <Card className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">
              {brief.candidate.name ?? "Candidate"}
            </h2>
            <p className="text-sm text-neutral-600">{iv.positionTitle}</p>
          </div>
          <div className="flex flex-col items-end gap-1 text-sm">
            <span className="font-medium text-neutral-800">
              Round {iv.roundNumber}: {iv.roundName}
            </span>
            <span className="text-neutral-500">
              {formatWhen(iv.scheduledStart)} · {MODE_LABEL[iv.mode] ?? iv.mode} ·{" "}
              {iv.durationMinutes}m
            </span>
            <div className="flex items-center gap-2">
              <Badge tone={statusTone(iv.status)}>{iv.status}</Badge>
              {iv.candidateConfirmedAt ? (
                <Badge tone="success">Candidate confirmed</Badge>
              ) : iv.status === "scheduled" ? (
                <Badge tone="warning">Awaiting confirmation</Badge>
              ) : null}
            </div>
          </div>
        </div>
        {iv.meetingUrl ? (
          <div className="mt-4 border-t border-neutral-100 pt-3">
            <a
              href={iv.meetingUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-brand-700 hover:underline"
            >
              Join meeting →
            </a>
          </div>
        ) : null}
      </Card>

      {/* Candidate facet */}
      <Card className="mb-5">
        <SectionTitle>Candidate</SectionTitle>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <Field label="Current stage" value={humanStage(brief.candidate.currentStage)} />
          <Field label="Location" value={brief.candidate.locationCountry ?? "—"} />
        </dl>
        {brief.candidate.parsedSkills.length > 0 ? (
          <div className="mt-3">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Resume skills
            </p>
            <div className="flex flex-wrap gap-1.5">
              {brief.candidate.parsedSkills.map((s) => (
                <Badge key={s} tone="neutral">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {/* Round focus + co-panelists */}
      <div className="mb-5 grid gap-5 md:grid-cols-2">
        <Card>
          <SectionTitle>This round probes</SectionTitle>
          {brief.round.competencyFocus.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {brief.round.competencyFocus.map((c) => (
                <Badge key={c} tone="info">
                  {c}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-sm text-neutral-400">No specific competencies flagged.</p>
          )}
          <p className="mt-3 text-xs text-neutral-400">
            Scorecard template: {brief.round.scorecardTemplate}
          </p>
        </Card>
        <Card>
          <SectionTitle>Panel</SectionTitle>
          <ul className="space-y-1 text-sm">
            {brief.coPanelists.map((p) => (
              <li key={p.membershipId} className="flex items-center gap-2">
                <span className={p.isMe ? "font-medium text-neutral-900" : "text-neutral-700"}>
                  {p.name ?? "Panellist"}
                  {p.isMe ? " (you)" : ""}
                </span>
                {p.isLead ? <Badge tone="accent">Lead</Badge> : null}
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Prior-round feedback — recommendation + strengths + concerns only */}
      {brief.priorRoundFeedback.length > 0 ? (
        <Card className="mb-5">
          <SectionTitle>Earlier rounds</SectionTitle>
          <p className="mb-3 text-xs text-neutral-400">
            Summaries only — per-criterion scores are not shared across rounds.
          </p>
          <div className="space-y-3">
            {brief.priorRoundFeedback.map((f) => (
              <div key={f.interviewId} className="rounded-md border border-neutral-100 p-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-medium text-neutral-800">
                    Round {f.roundNumber}: {f.roundName}
                    <span className="ml-2 font-normal text-neutral-500">
                      {f.panelistName ?? "Panellist"}
                    </span>
                  </span>
                  {f.recommendation ? (
                    <Badge tone={recommendationTone(f.recommendation)}>
                      {recommendationLabel(f.recommendation)}
                    </Badge>
                  ) : null}
                </div>
                {f.strengths ? (
                  <p className="text-sm text-neutral-700">
                    <span className="text-neutral-400">Strengths: </span>
                    {f.strengths}
                  </p>
                ) : null}
                {f.concerns ? (
                  <p className="text-sm text-neutral-700">
                    <span className="text-neutral-400">Concerns: </span>
                    {f.concerns}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Scorecard */}
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

        <div className="space-y-3">
          {brief.myFeedback.criteria.map((c) => (
            <div key={c.key} className="flex items-center justify-between gap-4">
              <span className="text-sm text-neutral-700">{c.label}</span>
              <div className="flex gap-1">
                {SCORES.map((n) => {
                  const active = scores[c.key] === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      disabled={submitted}
                      onClick={() => setScores((prev) => ({ ...prev, [c.key]: n }))}
                      className={scoreButtonClass(active, submitted)}
                      aria-pressed={active}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-5 space-y-4">
          <TextArea
            label="Strengths"
            value={strengths}
            onChange={setStrengths}
            disabled={submitted}
          />
          <TextArea label="Concerns" value={concerns} onChange={setConcerns} disabled={submitted} />
          <TextArea
            label="Notes (private to the hiring team)"
            value={notes}
            onChange={setNotes}
            disabled={submitted}
          />
        </div>

        <div className="mt-5">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
            Recommendation
          </p>
          <div className="flex flex-wrap gap-2">
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
          <div className="mt-6 flex gap-2">
            <Button variant="secondary" disabled={save.isPending} onClick={saveDraft}>
              Save draft
            </Button>
            <Button variant="primary" disabled={save.isPending || !recommendation} onClick={submit}>
              Submit scorecard
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold text-neutral-900">{children}</h3>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </span>
      <textarea
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-500"
      />
    </label>
  );
}

function scoreButtonClass(active: boolean, disabled: boolean): string {
  const base = "h-8 w-8 rounded-md border text-sm font-medium transition-colors";
  if (active) return `${base} border-brand-600 bg-brand-600 text-white`;
  if (disabled) return `${base} border-neutral-200 bg-neutral-50 text-neutral-400`;
  return `${base} border-neutral-300 text-neutral-600 hover:bg-neutral-100`;
}

function recommendationButtonClass(active: boolean, disabled: boolean): string {
  const base = "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors";
  if (active) return `${base} border-brand-600 bg-brand-600 text-white`;
  if (disabled) return `${base} border-neutral-200 bg-neutral-50 text-neutral-400`;
  return `${base} border-neutral-300 text-neutral-600 hover:bg-neutral-100`;
}

function statusTone(status: string): BadgeTone {
  switch (status) {
    case "scheduled":
      return "info";
    case "completed":
      return "success";
    case "no_show":
    case "cancelled":
      return "warning";
    default:
      return "neutral";
  }
}

function recommendationTone(rec: InterviewRecommendation): BadgeTone {
  switch (rec) {
    case "strong_yes":
    case "yes":
      return "success";
    case "hold":
      return "warning";
    case "no":
      return "error";
  }
}

function recommendationLabel(rec: InterviewRecommendation): string {
  return RECOMMENDATIONS.find((r) => r.value === rec)?.label ?? rec;
}

function humanStage(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatWhen(iso: string | null): string {
  if (!iso) return "TBC";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
