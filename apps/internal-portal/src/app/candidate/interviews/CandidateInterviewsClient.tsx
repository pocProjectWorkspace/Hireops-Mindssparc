"use client";

import { useState } from "react";
import { Button } from "@hireops/ui";
import { Badge, Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { trpc } from "@/lib/trpc-client";
import type { CandidateInterviewRow } from "@hireops/api-types";
import { MODE_LABEL, formatWhen } from "@/components/candidate/candidate-format";

/**
 * Candidate interviews (CAND-01). Upcoming rounds show the schedule, the
 * meeting link (as a link — the REAL external Teams/Zoom URL), and a confirm
 * action. Past rounds surface ONLY the tenant-policy-gated, SCORE-FREE shared
 * summary / recommendation (often null).
 *
 * REFUSALS: no live "Join Interview Room" / in-app video (that's a post-deal
 * connector — the link is the join), no numeric score, no raw panel feedback,
 * no scorecards. The API omits all of those from candidate reads.
 */
export function CandidateInterviewsClient() {
  const q = trpc.candidateListMyInterviews.useQuery();
  const items = q.data?.items ?? [];
  const upcoming = items
    .filter((iv) => iv.isUpcoming)
    .sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
  const past = items
    .filter((iv) => !iv.isUpcoming)
    .sort((a, b) => (b.scheduledStart ?? "").localeCompare(a.scheduledStart ?? ""));

  return (
    <CandidateShell variant="portal" active="interviews">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">My interviews</h1>
          <p className="text-sm text-neutral-600">Your scheduled rounds and past interviews.</p>
        </header>

        {q.isLoading ? (
          <Card className="p-5">
            <p className="text-sm text-neutral-500">Loading…</p>
          </Card>
        ) : items.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              title="No interviews scheduled"
              hint="When a round is scheduled, you'll see it here and can confirm your attendance."
            />
          </Card>
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                Upcoming
              </h2>
              {upcoming.length === 0 ? (
                <Card className="p-5">
                  <p className="text-sm text-neutral-500">No upcoming interviews right now.</p>
                </Card>
              ) : (
                upcoming.map((iv) => <UpcomingCard key={iv.interviewId} interview={iv} />)
              )}
            </section>

            {past.length > 0 ? (
              <section className="flex flex-col gap-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                  Past interviews
                </h2>
                {past.map((iv) => (
                  <PastCard key={iv.interviewId} interview={iv} />
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
    </CandidateShell>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="break-all text-right font-medium text-neutral-900">{value}</dd>
    </div>
  );
}

function UpcomingCard({ interview }: { interview: CandidateInterviewRow }) {
  const utils = trpc.useUtils();
  const [localConfirmedAt, setLocalConfirmedAt] = useState<string | null>(interview.confirmedAt);
  const [error, setError] = useState<string | null>(null);
  const confirm = trpc.candidateConfirmInterview.useMutation({
    onSuccess: (res) => {
      setLocalConfirmedAt(res.confirmedAt);
      void utils.candidateListMyInterviews.invalidate();
    },
    onError: () => setError("Couldn't confirm just now. Please try again."),
  });

  const confirmed = localConfirmedAt !== null;
  const canConfirm = interview.status === "scheduled" && !confirmed;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-neutral-900">{interview.positionTitle}</p>
          <p className="text-sm text-neutral-500">{interview.roundName}</p>
        </div>
        {confirmed ? (
          <Badge tone="success">Confirmed</Badge>
        ) : interview.status !== "scheduled" ? (
          <Badge tone="neutral">{interview.status}</Badge>
        ) : (
          <Badge tone="warning">Awaiting confirmation</Badge>
        )}
      </div>

      <dl className="flex flex-col gap-1 text-sm">
        <InfoRow label="When" value={formatWhen(interview.scheduledStart)} />
        <InfoRow
          label="Format"
          value={`${MODE_LABEL[interview.mode] ?? interview.mode} · ${interview.durationMinutes} min`}
        />
      </dl>

      {interview.meetingUrl ? (
        <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
          <p className="text-xs font-medium text-neutral-500">Meeting link</p>
          <a
            href={interview.meetingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block break-all text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            {interview.meetingUrl}
          </a>
          <p className="mt-1.5 text-xs text-neutral-500">
            Use this link to join your interview at the scheduled time.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-status-error-700">
          {error}
        </p>
      ) : null}

      {canConfirm ? (
        <div>
          <Button
            variant="primary"
            size="sm"
            disabled={confirm.isPending}
            loading={confirm.isPending}
            onClick={() => {
              setError(null);
              confirm.mutate({ interviewId: interview.interviewId });
            }}
          >
            Confirm attendance
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function PastCard({ interview }: { interview: CandidateInterviewRow }) {
  const hasSummary = interview.sharedSummary !== null;
  const hasRec = interview.sharedRecommendation !== null;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-neutral-900">{interview.positionTitle}</p>
          <p className="text-sm text-neutral-500">{interview.roundName}</p>
        </div>
        <Badge tone="neutral">
          {interview.status === "completed" ? "Completed" : interview.status}
        </Badge>
      </div>

      <dl className="flex flex-col gap-1 text-sm">
        <InfoRow label="When" value={formatWhen(interview.scheduledStart)} />
      </dl>

      {hasSummary || hasRec ? (
        <div className="flex flex-col gap-2">
          {hasSummary ? (
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs font-medium text-neutral-500">Interview summary</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">
                {interview.sharedSummary}
              </p>
            </div>
          ) : null}
          {hasRec ? (
            <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
              <p className="text-xs font-medium text-neutral-500">Panel recommendation</p>
              <p className="mt-1 text-sm text-neutral-700">{interview.sharedRecommendation}</p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-neutral-500">No feedback has been shared for this interview.</p>
      )}
    </Card>
  );
}
