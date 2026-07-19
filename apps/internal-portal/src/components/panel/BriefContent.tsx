"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { Badge, Card } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";
import { RecommendationChip } from "@/components/patterns";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import type { GetPanelInterviewBriefOutput, GetInterviewPrepOutput } from "@hireops/api-types";
import { SKILLS_MATCH_AMBER_THRESHOLD } from "@hireops/api-types";

/**
 * PANEL-02 — the candidate BRIEF content for one interview (the read-only
 * context a panellist reads before scoring). Split out of PanelInterviewBrief so
 * the scorecard form (owned by PANEL-01 in the main tree) stays untouched: this
 * component renders ABOVE the scorecard block.
 *
 * Sections, all honest / no theatre:
 *   1. Interview context header — candidate, role, round, time window, mode,
 *      Join button, co-panelists, confirmation state.
 *   2. Experience summary — real parsed resume fields only (YoE, stage,
 *      location, resume skills); honest empty state when nothing is parsed.
 *   3. Resume vs JD skills — DETERMINISTIC parsed overlap (no AI claim), amber
 *      below the coverage threshold.
 *   4. Previous round feedback — recommendation chips + strengths/concerns text,
 *      NEVER scores (anti-anchoring caption stated).
 *   5. Interview prep (real AI) — areas to probe + probing questions, generate/
 *      regenerate, honest disabled/empty states, cost note.
 */

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

export function BriefContent({
  interviewId,
  brief,
}: {
  interviewId: string;
  brief: GetPanelInterviewBriefOutput;
}) {
  const iv = brief.interview;
  const c = brief.candidate;

  return (
    <div className="space-y-5">
      {/* 1 — Interview context header */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-neutral-900">{c.name ?? "Candidate"}</h2>
            <p className="text-sm text-neutral-600">{iv.positionTitle}</p>
            <p className="mt-1 text-sm font-medium text-neutral-800">
              Round {iv.roundNumber}: {iv.roundName}
            </p>
            <p className="text-sm text-neutral-500">
              {formatWindow(iv.scheduledStart, iv.scheduledEnd)} · {MODE_LABEL[iv.mode] ?? iv.mode}{" "}
              · {iv.durationMinutes}m
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge tone={statusTone(iv.status)}>{iv.status.replace(/_/g, " ")}</Badge>
              {iv.candidateConfirmedAt ? (
                <Badge tone="success">Candidate confirmed</Badge>
              ) : iv.status === "scheduled" ? (
                <Badge tone="warning">Awaiting confirmation</Badge>
              ) : null}
            </div>
            {iv.meetingUrl ? (
              <a href={iv.meetingUrl} target="_blank" rel="noreferrer">
                <Button variant="primary">Join meeting</Button>
              </a>
            ) : null}
          </div>
        </div>
        {brief.coPanelists.length > 0 ? (
          <div className="mt-4 border-t border-neutral-100 pt-3">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Panel
            </p>
            <div className="flex flex-wrap gap-2">
              {brief.coPanelists.map((p) => (
                <span
                  key={p.membershipId}
                  className={
                    p.isMe
                      ? "inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700"
                      : "inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-700"
                  }
                >
                  {p.name ?? "Panellist"}
                  {p.isMe ? " (you)" : ""}
                  {p.isLead ? " · lead" : ""}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {/* 2 + 3 — Experience summary + Skills match */}
      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <SectionTitle>Experience summary</SectionTitle>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <Field
              label="Experience"
              value={c.yearsOfExperience != null ? `${c.yearsOfExperience} yrs` : "—"}
            />
            <Field label="Current stage" value={humanStage(c.currentStage)} />
            <Field label="Location" value={c.locationCountry ?? "—"} />
            <Field label="Resume skills" value={String(c.parsedSkills.length || "—")} />
          </dl>
          {c.parsedSkills.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                Parsed resume skills
              </p>
              <div className="flex flex-wrap gap-1.5">
                {c.parsedSkills.map((s) => (
                  <Badge key={s} tone="neutral">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-neutral-400">
              No parsed resume details on file for this candidate.
            </p>
          )}
        </Card>

        <SkillsMatchCard match={brief.skillsMatch} />
      </div>

      {/* Round focus */}
      {brief.round.competencyFocus.length > 0 ? (
        <Card>
          <SectionTitle>This round probes</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {brief.round.competencyFocus.map((cf) => (
              <Badge key={cf} tone="info">
                {cf}
              </Badge>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-400">
            Scorecard template: {brief.round.scorecardTemplate}
          </p>
        </Card>
      ) : null}

      {/* 4 — Previous round feedback (NO scores) */}
      {brief.priorRoundFeedback.length > 0 ? (
        <Card>
          <SectionTitle>Previous round feedback</SectionTitle>
          <p className="mb-3 text-xs text-neutral-400">
            Recommendations + notes only — per-round scores are hidden until you submit
            (anti-anchoring).
          </p>
          <div className="space-y-3">
            {brief.priorRoundFeedback.map((f) => (
              <div key={f.interviewId} className="rounded-md border border-neutral-100 p-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-neutral-800">
                    Round {f.roundNumber}: {f.roundName}
                    <span className="ml-2 font-normal text-neutral-500">
                      {f.panelistName ?? "Panellist"}
                    </span>
                  </span>
                  <RecommendationChip recommendation={f.recommendation} />
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

      {/* 5 — Interview prep (real AI) */}
      <InterviewPrepSection interviewId={interviewId} />
    </div>
  );
}

// ─────────────────────────── skills match ───────────────────────────

function SkillsMatchCard({ match }: { match: GetPanelInterviewBriefOutput["skillsMatch"] }) {
  const amber = match.coveragePct < SKILLS_MATCH_AMBER_THRESHOLD;
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-2">
        <SectionTitle className="mb-0">Resume vs JD skills — parsed match</SectionTitle>
        {match.totalCount > 0 ? (
          <span
            className={
              amber
                ? "text-sm font-semibold text-status-warning-800"
                : "text-sm font-semibold text-status-positive-700"
            }
          >
            {match.coveragePct}%
          </span>
        ) : null}
      </div>
      {match.totalCount === 0 ? (
        <p className="mt-2 text-sm text-neutral-400">
          No JD skills recorded for this requisition — nothing to match against.
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-neutral-400">
            {match.matchedCount} of {match.totalCount} JD skills present in the parsed resume
            (deterministic overlap — not an AI judgement).
          </p>
          <ul className="space-y-2">
            {match.items.map((item) => (
              <li key={item.skill}>
                <div className="mb-0.5 flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-neutral-700">
                    {item.skill}
                    {item.isRequired ? (
                      <span className="ml-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                        must-have
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={
                      item.matched
                        ? "shrink-0 text-xs font-medium text-status-positive-700"
                        : "shrink-0 text-xs font-medium text-status-warning-800"
                    }
                  >
                    {item.matched ? "Matched" : "Not found"}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                  <div
                    className={
                      item.matched
                        ? "h-full rounded-full bg-status-positive-500"
                        : "h-full rounded-full bg-status-warning-400"
                    }
                    style={{ width: item.matched ? "100%" : "8%" }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ─────────────────────────── interview prep (real AI) ───────────────────────────

function InterviewPrepSection({ interviewId }: { interviewId: string }) {
  const queryClient = useQueryClient();
  const query = trpc.getInterviewPrep.useQuery({ interviewId });
  const [error, setError] = useState<string | null>(null);

  const generate = trpc.generateInterviewPrep.useMutation({
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: [["getInterviewPrep"]] });
    },
    onError: (err) => handleTRPCError(err, { onMessage: setError }),
  });

  const data: GetInterviewPrepOutput | undefined = query.data;
  const prep = data?.prep ?? null;
  const aiEnabled = data?.aiEnabled ?? false;

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-2">
        <SectionTitle className="mb-0">Interview prep</SectionTitle>
        {aiEnabled ? (
          <Button
            variant="secondary"
            disabled={generate.isPending}
            onClick={() => generate.mutate({ interviewId })}
          >
            {generate.isPending ? "Generating…" : prep ? "Regenerate" : "Generate prep"}
          </Button>
        ) : null}
      </div>
      <p className="mb-4 text-xs text-neutral-400">
        AI-suggested focus areas + questions, grounded in the JD, the parsed resume, and prior-round
        notes (never scores). Suggestions only — you decide what to ask.
      </p>

      {query.isLoading ? (
        <p className="text-sm text-neutral-400">Loading…</p>
      ) : !aiEnabled ? (
        <p className="rounded-md bg-neutral-50 p-3 text-sm text-neutral-500">
          Interview prep is turned off for this workspace. An administrator can enable it in Admin →
          AI settings.
        </p>
      ) : !prep ? (
        <p className="rounded-md bg-neutral-50 p-3 text-sm text-neutral-500">
          No prep generated yet. Click “Generate prep” to draft focus areas and probing questions
          for this round.
        </p>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Areas to probe
            </p>
            <div className="space-y-2">
              {prep.focusAreas.map((a, i) => (
                <div
                  key={`${a.title}-${i}`}
                  className="rounded-lg border border-status-error-100 bg-status-error-50 px-3 py-2.5"
                >
                  <p className="text-sm font-semibold text-status-error-700">{a.title}</p>
                  <p className="mt-0.5 text-sm text-neutral-700">{a.why}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
              Suggested questions
            </p>
            <ul className="space-y-1.5">
              {prep.probingQuestions.map((q, i) => (
                <li key={`${i}-${q.slice(0, 12)}`} className="flex gap-2 text-sm text-neutral-700">
                  <span aria-hidden className="mt-0.5 text-neutral-300">
                    ▢
                  </span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </div>
          {prep.generatedAt ? (
            <p className="text-xs text-neutral-400">
              Generated {formatWhen(prep.generatedAt)}
              {prep.model ? ` · ${prep.model}` : ""} · one AI call per generate, cost-logged.
            </p>
          ) : null}
        </div>
      )}

      {error ? <p className="mt-3 text-sm text-status-error-700">{error}</p> : null}
    </Card>
  );
}

// ─────────────────────────── small helpers ───────────────────────────

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h3 className={`mb-3 text-sm font-semibold text-neutral-900 ${className ?? ""}`}>{children}</h3>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-neutral-400">{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </div>
  );
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

function humanStage(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatWhen(iso: string | null): string {
  if (!iso) return "TBC";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function formatWindow(start: string | null, end: string | null): string {
  if (!start) return "Time TBC";
  const startStr = `${start.slice(0, 10)} ${start.slice(11, 16)}`;
  if (end && end.slice(0, 10) === start.slice(0, 10)) return `${startStr}–${end.slice(11, 16)}`;
  return startStr;
}
