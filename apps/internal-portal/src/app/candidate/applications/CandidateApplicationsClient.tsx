"use client";

import { Badge, Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { trpc } from "@/lib/trpc-client";
import type { CandidateApplicationRow } from "@hireops/api-types";
import {
  STAGE_TIMELINE_NOTE,
  TERMINAL_NEGATIVE,
  stageLabel,
  formatDate,
} from "@/components/candidate/candidate-format";

/**
 * Candidate applications (CAND-01). Each application renders as a vertical
 * timeline over the candidate-safe stage vocabulary. REFUSAL: candidates are
 * an external party — this surface shows neutral status ONLY. No AI score, no
 * "AI Screened: Score 94", no top-factors, no panel feedback. The API already
 * omits the score; we keep it that way.
 */
export function CandidateApplicationsClient() {
  const appsQ = trpc.candidateListMyApplications.useQuery();
  const apps = appsQ.data?.items ?? [];

  return (
    <CandidateShell variant="portal" active="applications">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            My applications
          </h1>
          <p className="text-sm text-neutral-600">
            Where each of your applications stands, step by step.
          </p>
        </header>

        {appsQ.isLoading ? (
          <Card className="p-5">
            <p className="text-sm text-neutral-500">Loading…</p>
          </Card>
        ) : apps.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              title="No applications yet"
              hint="When you apply for a role, its progress shows up here."
            />
          </Card>
        ) : (
          apps.map((a) => <ApplicationCard key={a.applicationId} application={a} />)
        )}
      </div>
    </CandidateShell>
  );
}

function StageBadge({ stage }: { stage: string }) {
  const label = stageLabel(stage);
  if (stage === "offer_accepted") return <Badge tone="success">{label}</Badge>;
  if (TERMINAL_NEGATIVE.has(stage)) return <Badge tone="neutral">{label}</Badge>;
  return <Badge tone="accent">{label}</Badge>;
}

function ApplicationCard({ application }: { application: CandidateApplicationRow }) {
  const { stageSteps, currentStage } = application;
  const isNegativeTerminal = TERMINAL_NEGATIVE.has(currentStage);
  const currentIdx = stageSteps.indexOf(currentStage);

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-lg font-semibold text-neutral-900">{application.positionTitle}</p>
          <p className="text-sm text-neutral-500">
            {application.location ? `${application.location} · ` : ""}Applied{" "}
            {formatDate(application.appliedAt)}
          </p>
        </div>
        <StageBadge stage={currentStage} />
      </div>

      <div>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
          Application timeline
        </p>
        <ol className="flex flex-col">
          {stageSteps.map((s, i) => {
            const reached = !isNegativeTerminal && currentIdx >= 0 && i <= currentIdx;
            const isCurrent = !isNegativeTerminal && i === currentIdx;
            const isLast = i === stageSteps.length - 1;
            const note =
              i === 0
                ? `Application received · ${formatDate(application.appliedAt)}`
                : isCurrent
                  ? `${STAGE_TIMELINE_NOTE[s] ?? stageLabel(s)} — in progress`
                  : reached
                    ? `${STAGE_TIMELINE_NOTE[s] ?? stageLabel(s)} — complete`
                    : (STAGE_TIMELINE_NOTE[s] ?? stageLabel(s));
            return (
              <li key={s} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={[
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
                      reached
                        ? "border-brand-500 bg-brand-500"
                        : isCurrent
                          ? "border-brand-500 bg-white"
                          : "border-neutral-300 bg-white",
                    ].join(" ")}
                    aria-hidden
                  />
                  {!isLast ? (
                    <span
                      className={[
                        "w-0.5 flex-1",
                        reached && i < currentIdx ? "bg-brand-500" : "bg-neutral-200",
                      ].join(" ")}
                    />
                  ) : null}
                </div>
                <div className={isLast ? "pb-0" : "pb-5"}>
                  <p
                    className={[
                      "text-sm font-medium",
                      isCurrent
                        ? "text-brand-700"
                        : reached
                          ? "text-neutral-900"
                          : "text-neutral-400",
                    ].join(" ")}
                  >
                    {stageLabel(s)}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">{note}</p>
                </div>
              </li>
            );
          })}
        </ol>
        {isNegativeTerminal ? (
          <p className="mt-2 rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
            Status: {stageLabel(currentStage)}
          </p>
        ) : null}
      </div>
    </Card>
  );
}
