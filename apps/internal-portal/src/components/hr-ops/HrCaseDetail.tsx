"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { GetHrCaseDetailOutput, HrCaseFeedbackCard } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Card, Badge } from "@/components/ui";
import { StageChip, RecommendationChip, HrRecChip } from "@/components/patterns";
import { TabBar, type TabItem } from "./TabBar";
import { HrRoundAssessmentForm } from "./HrRoundAssessmentForm";

/**
 * HrCaseDetail (HROPS-01) — the tabbed HR case record.
 *
 * Tabs: Summary | Interview feedback | HR round. The tab bar is generic
 * (TabBar) so the parallel HROPS-02/03 tickets add Compensation / Offer /
 * Documents by appending to the array — no shell rework. Seeds from the server
 * render and stays live via React Query (the assessment save invalidates the
 * detail query).
 *
 * Interview feedback shows recommendation + qualitative summary text only — NO
 * numeric scores (the anti-anchoring convention the panel brief also follows).
 */

type TabKey = "summary" | "feedback" | "hr-round";

export function HrCaseDetail({
  applicationId,
  initial,
}: {
  applicationId: string;
  initial: GetHrCaseDetailOutput;
}) {
  const { data } = trpc.getHrCaseDetail.useQuery(
    { applicationId },
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: true },
  );
  const [tab, setTab] = useState<TabKey>("summary");

  const { candidate, pipeline, interviewFeedback, assessment } = data;
  const gateSatisfied = assessment?.recommendation === "proceed";

  const tabs: TabItem<TabKey>[] = [
    { key: "summary", label: "Summary" },
    {
      key: "feedback",
      label: "Interview feedback",
      badge:
        interviewFeedback.length > 0 ? (
          <span className="rounded-full bg-neutral-100 px-1.5 text-[11px] tabular-nums text-neutral-500">
            {interviewFeedback.length}
          </span>
        ) : undefined,
    },
    {
      key: "hr-round",
      label: "HR round",
      badge: assessment ? (
        <span className="h-1.5 w-1.5 rounded-full bg-status-positive-500" aria-hidden />
      ) : data.advanceRequiresAssessment ? (
        <span className="h-1.5 w-1.5 rounded-full bg-status-warning-500" aria-hidden />
      ) : undefined,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-8 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <a
            href="/hr-cases"
            className="mb-1 inline-block text-xs font-medium text-neutral-500 hover:text-neutral-800"
          >
            ← HR cases
          </a>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
              {candidate.name ?? "Unknown candidate"}
            </h1>
            <StageChip stage={pipeline.stage} />
          </div>
          <p className="mt-1 text-sm text-neutral-500">
            {pipeline.roleTitle ?? "—"}
            {pipeline.department ? ` · ${pipeline.department}` : ""}
          </p>
        </div>
        {pipeline.aiScore != null ? (
          <div className="rounded-card border border-neutral-200 bg-white px-4 py-2.5 text-center shadow-card">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              AI score
            </p>
            <p className="text-2xl font-semibold tabular-nums text-neutral-900">
              {Math.round(pipeline.aiScore)}%
            </p>
          </div>
        ) : null}
      </div>

      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      {tab === "summary" ? (
        <SummaryTab data={data} />
      ) : tab === "feedback" ? (
        <FeedbackTab feedback={interviewFeedback} />
      ) : (
        <HrRoundTab
          applicationId={applicationId}
          assessment={assessment}
          advanceRequiresAssessment={data.advanceRequiresAssessment}
          gateSatisfied={gateSatisfied}
        />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-neutral-900">{value}</dd>
    </div>
  );
}

function SummaryTab({ data }: { data: GetHrCaseDetailOutput }) {
  const { candidate, pipeline } = data;
  const location = [candidate.locationCity, candidate.locationCountry].filter(Boolean).join(", ");
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-neutral-900">Candidate</h2>
        <dl className="grid grid-cols-2 gap-4">
          <Field label="Email" value={candidate.email ?? "—"} />
          <Field label="Phone" value={candidate.phone ?? "—"} />
          <Field label="Location" value={location || "—"} />
          <Field
            label="Experience"
            value={candidate.yearsOfExperience != null ? `${candidate.yearsOfExperience} yrs` : "—"}
          />
          <Field
            label="LinkedIn"
            value={
              candidate.linkedinUrl ? (
                <a
                  href={candidate.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-700 hover:underline"
                >
                  Profile ↗
                </a>
              ) : (
                "—"
              )
            }
          />
        </dl>
        {candidate.parsedSkills.length > 0 ? (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
              Skills
            </p>
            <div className="flex flex-wrap gap-1.5">
              {candidate.parsedSkills.slice(0, 16).map((s) => (
                <Badge key={s} tone="neutral">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-neutral-900">Pipeline status</h2>
        <dl className="grid grid-cols-2 gap-4">
          <Field
            label="AI score"
            value={pipeline.aiScore != null ? `${Math.round(pipeline.aiScore)}%` : "Not scored"}
          />
          <Field label="Salary band" value={pipeline.salaryBand ?? "—"} />
          <Field label="Recruiter" value={pipeline.assignedRecruiterName ?? "—"} />
          <Field label="Stage" value={<StageChip stage={pipeline.stage} />} />
        </dl>
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            Interview rounds
          </p>
          {pipeline.roundResults.length === 0 ? (
            <p className="text-sm text-neutral-500">No interviews yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {pipeline.roundResults.map((rr) => (
                <RecommendationChip
                  key={rr.interviewId}
                  round={rr.roundNumber}
                  recommendation={rr.recommendation}
                />
              ))}
            </div>
          )}
        </div>
        {data.assessment ? (
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-600">HR round assessment</span>
              <HrRecChip recommendation={data.assessment.recommendation} />
            </div>
            <p className="mt-1 text-sm text-neutral-700">
              Rating {data.assessment.rating}/5
              {data.assessment.completedByName ? ` · ${data.assessment.completedByName}` : ""}
            </p>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function FeedbackTab({ feedback }: { feedback: HrCaseFeedbackCard[] }) {
  if (feedback.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-neutral-500">
        No submitted interview feedback yet. Recommendations and summaries appear here once
        panellists submit their scorecards.
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-500">
        Panel recommendations and written summaries. Numeric scores are withheld here by design
        (anti-anchoring) — the HR round is a fresh assessment.
      </p>
      {feedback.map((f) => (
        <Card key={f.interviewId + f.roundNumber} className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-neutral-900">
                Round {f.roundNumber} · {f.roundName}
              </h3>
              {f.panelistName ? <p className="text-xs text-neutral-500">{f.panelistName}</p> : null}
            </div>
            <RecommendationChip recommendation={f.recommendation} />
          </div>
          {f.strengths ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-status-positive-700">
                Strengths
              </p>
              <p className="mt-0.5 text-sm text-neutral-700">{f.strengths}</p>
            </div>
          ) : null}
          {f.concerns ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-status-warning-800">
                Concerns
              </p>
              <p className="mt-0.5 text-sm text-neutral-700">{f.concerns}</p>
            </div>
          ) : null}
          {f.notes ? (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                Notes
              </p>
              <p className="mt-0.5 text-sm text-neutral-700">{f.notes}</p>
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

function HrRoundTab({
  applicationId,
  assessment,
  advanceRequiresAssessment,
  gateSatisfied,
}: {
  applicationId: string;
  assessment: GetHrCaseDetailOutput["assessment"];
  advanceRequiresAssessment: boolean;
  gateSatisfied: boolean;
}) {
  return (
    <div className="space-y-4">
      {advanceRequiresAssessment ? (
        <div
          className={`rounded-md border p-3 text-sm ${
            gateSatisfied
              ? "border-status-positive-200 bg-status-positive-50 text-status-positive-800"
              : "border-status-warning-200 bg-status-warning-50 text-status-warning-800"
          }`}
        >
          {gateSatisfied
            ? "HR round complete — this candidate can be advanced to the offer stage."
            : "This candidate is in the HR round. Advancing to the offer stage is blocked until a saved assessment recommends Proceed."}
        </div>
      ) : null}
      <Card className="p-5">
        <HrRoundAssessmentForm applicationId={applicationId} initial={assessment} />
      </Card>
    </div>
  );
}
