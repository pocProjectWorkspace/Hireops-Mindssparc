"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@hireops/ui";
import { Badge, Card, EmptyState } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { trpc } from "@/lib/trpc-client";
import { getSupabaseBrowserClient } from "@/lib/supabase-client";
import { TRPCClientError } from "@trpc/client";
import type { CandidateInterviewRow } from "@hireops/api-types";

/**
 * Candidate dashboard — applications (stage stepper), interviews (confirm),
 * and a quiet placeholder for documents + offers (CAND-02). Reads are
 * person-scoped by the API; a non-candidate identity gets a calm notice.
 */

const STAGE_LABELS: Record<string, string> = {
  application_received: "Applied",
  ai_screening: "Screening",
  recruiter_review: "Under review",
  shortlisted: "Shortlisted",
  tech_interview: "Tech interview",
  hr_round: "HR round",
  offer_drafted: "Offer prepared",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  withdrawn: "Withdrawn",
  recruiter_rejected: "Not progressing",
};

const TERMINAL_NEGATIVE = new Set(["offer_declined", "withdrawn", "recruiter_rejected"]);

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

export function CandidateDashboardClient() {
  const router = useRouter();
  const me = trpc.candidateGetMe.useQuery(undefined, { retry: false });

  if (me.isLoading) {
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState title="Loading your dashboard…" />
        </Card>
      </CandidateShell>
    );
  }

  if (me.isError) {
    const forbidden = me.error instanceof TRPCClientError && me.error.data?.code === "FORBIDDEN";
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState
            title={forbidden ? "This isn't a candidate account" : "We couldn't load your dashboard"}
            hint={
              forbidden
                ? "You're signed in, but not as a candidate. If you applied for a role, activate your candidate account from the sign-in page."
                : "Please try again in a moment."
            }
            action={
              <Button variant="secondary" onClick={() => void signOut(router)}>
                Sign out
              </Button>
            }
          />
        </Card>
      </CandidateShell>
    );
  }

  const person = me.data;
  if (!person) {
    return (
      <CandidateShell>
        <Card className="my-auto">
          <EmptyState title="Loading your dashboard…" />
        </Card>
      </CandidateShell>
    );
  }

  return (
    <CandidateShell
      brand={person.tenantDisplayName}
      width="2xl"
      footer={
        <button
          type="button"
          className="text-xs font-medium text-neutral-500 underline"
          onClick={() => void signOut(router)}
        >
          Sign out
        </button>
      }
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Hi {person.fullName.split(" ")[0]}
        </h1>
        <p className="text-sm text-neutral-600">
          Your applications and interviews with {person.tenantDisplayName}.
        </p>
      </header>

      <ApplicationsSection />
      <InterviewsSection />

      <Card className="flex flex-col gap-1 border-dashed bg-neutral-50/60 p-5 text-center">
        <p className="text-sm font-medium text-neutral-700">Documents &amp; offers</p>
        <p className="text-sm text-neutral-500">
          When there&rsquo;s a document to share or an offer to review, it&rsquo;ll appear here.
        </p>
      </Card>
    </CandidateShell>
  );
}

function ApplicationsSection() {
  const apps = trpc.candidateListMyApplications.useQuery();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Applications
      </h2>
      {apps.isLoading ? (
        <Card className="p-5">
          <p className="text-sm text-neutral-500">Loading…</p>
        </Card>
      ) : !apps.data || apps.data.items.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            title="No applications yet"
            hint="When you apply for a role, its progress shows up here."
          />
        </Card>
      ) : (
        apps.data.items.map((a) => (
          <Card key={a.applicationId} className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-base font-semibold text-neutral-900">{a.positionTitle}</p>
                {a.location ? <p className="text-sm text-neutral-500">{a.location}</p> : null}
              </div>
              <StageBadge stage={a.currentStage} />
            </div>
            <StageStepper steps={a.stageSteps} current={a.currentStage} />
          </Card>
        ))
      )}
    </section>
  );
}

function StageBadge({ stage }: { stage: string }) {
  const label = STAGE_LABELS[stage] ?? stage;
  if (stage === "offer_accepted") return <Badge tone="success">{label}</Badge>;
  if (TERMINAL_NEGATIVE.has(stage)) return <Badge tone="neutral">{label}</Badge>;
  return <Badge tone="accent">{label}</Badge>;
}

/**
 * Horizontal stepper over the candidate-visible stage vocabulary. The current
 * stage (if it's one of the steps) marks how far along the row is; a terminal
 * negative stage renders the steps muted with a status note instead.
 */
function StageStepper({ steps, current }: { steps: string[]; current: string }) {
  const currentIdx = steps.indexOf(current);
  const isNegativeTerminal = TERMINAL_NEGATIVE.has(current);

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex items-center gap-1.5" aria-label="Application progress">
        {steps.map((s, i) => {
          const reached = !isNegativeTerminal && currentIdx >= 0 && i <= currentIdx;
          const isCurrent = !isNegativeTerminal && i === currentIdx;
          return (
            <li key={s} className="flex flex-1 items-center gap-1.5" title={STAGE_LABELS[s] ?? s}>
              <span
                className={[
                  "h-2 flex-1 rounded-full transition-colors",
                  reached ? "bg-brand-500" : "bg-neutral-200",
                  isCurrent ? "ring-2 ring-brand-200" : "",
                ].join(" ")}
              />
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-neutral-500">
        {isNegativeTerminal
          ? `Status: ${STAGE_LABELS[current] ?? current}`
          : currentIdx >= 0
            ? `Now: ${STAGE_LABELS[current] ?? current}`
            : `Status: ${STAGE_LABELS[current] ?? current}`}
      </p>
    </div>
  );
}

function InterviewsSection() {
  const interviews = trpc.candidateListMyInterviews.useQuery();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Interviews</h2>
      {interviews.isLoading ? (
        <Card className="p-5">
          <p className="text-sm text-neutral-500">Loading…</p>
        </Card>
      ) : !interviews.data || interviews.data.items.length === 0 ? (
        <Card className="p-0">
          <EmptyState
            title="No interviews scheduled"
            hint="When a round is scheduled, you'll see it here and can confirm your attendance."
          />
        </Card>
      ) : (
        interviews.data.items.map((iv) => <InterviewRow key={iv.interviewId} interview={iv} />)
      )}
    </section>
  );
}

function InterviewRow({ interview }: { interview: CandidateInterviewRow }) {
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
          <p className="text-base font-semibold text-neutral-900">{interview.roundName}</p>
          <p className="text-sm text-neutral-500">{interview.positionTitle}</p>
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
        <Row label="When" value={formatWhen(interview.scheduledStart)} />
        <Row
          label="Format"
          value={`${MODE_LABEL[interview.mode] ?? interview.mode} · ${interview.durationMinutes} min`}
        />
        {interview.meetingUrl ? <Row label="Meeting link" value={interview.meetingUrl} /> : null}
      </dl>
      {error ? (
        <p role="alert" className="text-sm text-status-error-700">
          {error}
        </p>
      ) : null}
      {canConfirm ? (
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
      ) : null}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right font-medium text-neutral-900 break-all">{value}</dd>
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "To be confirmed";
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

async function signOut(router: ReturnType<typeof useRouter>): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  await supabase.auth.signOut();
  router.replace("/candidate/login");
  router.refresh();
}
