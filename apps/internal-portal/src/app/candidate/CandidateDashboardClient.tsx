"use client";

import { Badge, Card, EmptyState, StatTile } from "@/components/ui";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { CandidateOfferCard } from "@/components/candidate/CandidateOfferCard";
import { trpc } from "@/lib/trpc-client";
import type { CandidateInterviewRow, CandidateApplicationRow } from "@hireops/api-types";
import {
  STAGE_LABELS,
  TERMINAL_NEGATIVE,
  MODE_LABEL,
  stageLabel,
  formatDate,
  formatWhen,
} from "@/components/candidate/candidate-format";

/**
 * Candidate dashboard landing (CAND-01) — "Your Hiring Journey" stepper, the
 * next upcoming interview, a DETERMINISTIC tasks checklist (from real state:
 * missing documents, unconfirmed interview, an open offer), stat tiles, a
 * recent-updates strip, and the in-portal offer. Everything here is
 * score-free: candidates are an external party and never see the AI score,
 * feedback, or scorecards.
 */
export function CandidateDashboardClient() {
  return (
    <CandidateShell variant="portal" active="dashboard">
      <DashboardBody />
    </CandidateShell>
  );
}

function DashboardBody() {
  const me = trpc.candidateGetMe.useQuery(undefined, { retry: false });
  const appsQ = trpc.candidateListMyApplications.useQuery();
  const interviewsQ = trpc.candidateListMyInterviews.useQuery();
  const onboardingQ = trpc.candidateGetMyOnboarding.useQuery();
  const appDocsQ = trpc.candidateListMyApplicationDocuments.useQuery();
  const offerQ = trpc.candidateGetMyOffer.useQuery();

  const firstName = me.data?.fullName.split(" ")[0] ?? "there";
  const apps = appsQ.data?.items ?? [];
  const interviews = interviewsQ.data?.items ?? [];

  // The primary application drives the journey stepper (most recent).
  const primary = apps[0] ?? null;

  // Next upcoming interview (soonest scheduled + future).
  const upcoming = interviews
    .filter((iv) => iv.isUpcoming)
    .sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""))[0];

  const activeApplications = apps.filter((a) => !TERMINAL_NEGATIVE.has(a.currentStage)).length;
  const interviewsDone = interviews.filter((iv) => iv.status === "completed").length;

  const tasks = buildTasks({
    interviews,
    onboardingDocsMissing: (onboardingQ.data?.documents ?? []).some(
      (s) => s.document === null || s.document.verificationStatus === "rejected",
    ),
    preOfferDocsMissing: (appDocsQ.data?.groups ?? []).some((g) =>
      g.documents.some((d) => d.status === "requested" || d.status === "rejected"),
    ),
    offerOpen: offerQ.data?.offer != null && offerQ.data.offer.status === "extended",
  });

  const updates = buildUpdates({ primary, upcoming, offerOpen: offerQ.data?.offer?.status });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
          Welcome, {firstName}
        </h1>
        <p className="text-sm text-neutral-600">
          {me.data
            ? `Your applications and interviews with ${me.data.tenantDisplayName}.`
            : "Your hiring journey at a glance."}
        </p>
      </header>

      <CandidateOfferCard />

      {/* Your Hiring Journey */}
      <Card className="flex flex-col gap-5 p-5">
        <h2 className="text-sm font-semibold text-neutral-900">Your hiring journey</h2>
        {appsQ.isLoading ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : primary ? (
          <JourneyStepper steps={primary.stageSteps} current={primary.currentStage} />
        ) : (
          <EmptyState
            title="No applications yet"
            hint="When you apply for a role, your progress shows up here."
          />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: upcoming interview + tasks */}
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card className="flex flex-col gap-3 p-5">
            <h2 className="text-sm font-semibold text-neutral-900">Upcoming interview</h2>
            {upcoming ? (
              <UpcomingInterview interview={upcoming} />
            ) : (
              <p className="text-sm text-neutral-500">
                No interview scheduled right now. When a round is scheduled, it&rsquo;ll appear
                here.
              </p>
            )}
          </Card>

          <Card className="flex flex-col gap-3 p-5">
            <h2 className="text-sm font-semibold text-neutral-900">Tasks checklist</h2>
            {tasks.length === 0 ? (
              <p className="text-sm text-neutral-500">
                You&rsquo;re all caught up — nothing to do.
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {tasks.map((t) => (
                  <TaskRow key={t.key} task={t} />
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* Right: stat tiles + recent updates */}
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3">
            <StatTile label="Active applications" value={activeApplications} tone="accent" />
            <StatTile label="Interviews done" value={interviewsDone} />
          </div>
          <Card className="flex flex-col gap-3 p-5">
            <h2 className="text-sm font-semibold text-neutral-900">Recent updates</h2>
            {updates.length === 0 ? (
              <p className="text-sm text-neutral-500">No recent updates.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {updates.map((u, i) => (
                  <li key={i} className="flex flex-col gap-0.5">
                    <p className="text-sm text-neutral-800">{u.text}</p>
                    {u.meta ? <p className="text-xs text-neutral-400">{u.meta}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * Horizontal journey over the candidate-visible stage vocabulary. Deterministic
 * from stageSteps + currentStage — NO scores, no invented per-stage dates. A
 * terminal-negative current stage renders the row muted with a status note.
 */
function JourneyStepper({ steps, current }: { steps: string[]; current: string }) {
  const isNegativeTerminal = TERMINAL_NEGATIVE.has(current);
  const currentIdx = steps.indexOf(current);

  return (
    <div className="flex flex-col gap-3">
      <ol className="flex items-start gap-0">
        {steps.map((s, i) => {
          const reached = !isNegativeTerminal && currentIdx >= 0 && i <= currentIdx;
          const isCurrent = !isNegativeTerminal && i === currentIdx;
          const lineReached = !isNegativeTerminal && currentIdx >= 0 && i < currentIdx;
          return (
            <li key={s} className="flex flex-1 flex-col items-center gap-2">
              <div className="flex w-full items-center">
                {/* left connector */}
                <span
                  className={[
                    "h-0.5 flex-1 rounded-full",
                    i === 0
                      ? "opacity-0"
                      : reached && i <= currentIdx
                        ? "bg-brand-500"
                        : "bg-neutral-200",
                  ].join(" ")}
                />
                <span
                  className={[
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-[11px] transition-colors",
                    reached
                      ? "border-brand-500 bg-brand-500 text-white"
                      : isCurrent
                        ? "border-brand-500 bg-white text-brand-600"
                        : "border-neutral-300 bg-white text-neutral-400",
                  ].join(" ")}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  {reached && !isCurrent ? "✓" : ""}
                </span>
                {/* right connector */}
                <span
                  className={[
                    "h-0.5 flex-1 rounded-full",
                    i === steps.length - 1
                      ? "opacity-0"
                      : lineReached
                        ? "bg-brand-500"
                        : "bg-neutral-200",
                  ].join(" ")}
                />
              </div>
              <span
                className={[
                  "text-center text-[11px] leading-tight",
                  isCurrent
                    ? "font-semibold text-brand-700"
                    : reached
                      ? "text-neutral-700"
                      : "text-neutral-400",
                ].join(" ")}
              >
                {stageLabel(s)}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-neutral-500">
        {isNegativeTerminal
          ? `Status: ${stageLabel(current)}`
          : currentIdx >= 0
            ? `Now: ${stageLabel(current)}`
            : `Status: ${stageLabel(current)}`}
      </p>
    </div>
  );
}

function UpcomingInterview({ interview }: { interview: CandidateInterviewRow }) {
  const confirmed = interview.confirmedAt !== null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-neutral-900">{interview.positionTitle}</p>
          <p className="text-sm text-neutral-500">{interview.roundName}</p>
        </div>
        {confirmed ? (
          <Badge tone="success">Confirmed</Badge>
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
        {interview.meetingUrl ? (
          <InfoRow label="Meeting link" value={interview.meetingUrl} />
        ) : null}
      </dl>
      <a
        href="/candidate/interviews"
        className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        Go to interviews →
      </a>
    </div>
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

interface Task {
  key: string;
  label: string;
  href: string;
  done: boolean;
}

function buildTasks(input: {
  interviews: CandidateInterviewRow[];
  onboardingDocsMissing: boolean;
  preOfferDocsMissing: boolean;
  offerOpen: boolean;
}): Task[] {
  const tasks: Task[] = [];

  const unconfirmed = input.interviews.find((iv) => iv.isUpcoming && iv.confirmedAt === null);
  const confirmedUpcoming = input.interviews.find((iv) => iv.isUpcoming && iv.confirmedAt !== null);
  if (unconfirmed) {
    tasks.push({
      key: "confirm-interview",
      label: `Confirm your ${unconfirmed.roundName} interview`,
      href: "/candidate/interviews",
      done: false,
    });
  } else if (confirmedUpcoming) {
    tasks.push({
      key: "confirm-interview-done",
      label: "Interview attendance confirmed",
      href: "/candidate/interviews",
      done: true,
    });
  }

  if (input.offerOpen) {
    tasks.push({
      key: "respond-offer",
      label: "Review and respond to your offer",
      href: "/candidate",
      done: false,
    });
  }

  if (input.preOfferDocsMissing) {
    tasks.push({
      key: "verification-docs",
      label: "Upload requested verification documents",
      href: "/candidate/documents",
      done: false,
    });
  }
  if (input.onboardingDocsMissing) {
    tasks.push({
      key: "onboarding-docs",
      label: "Upload your onboarding documents",
      href: "/candidate/documents",
      done: false,
    });
  }

  return tasks;
}

function TaskRow({ task }: { task: Task }) {
  return (
    <li>
      <a
        href={task.href}
        className="flex items-center gap-3 rounded-md px-1 py-1 transition-colors hover:bg-neutral-50"
      >
        <span
          aria-hidden
          className={[
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
            task.done
              ? "border-status-success-500 bg-status-success-500 text-white"
              : "border-neutral-300 text-transparent",
          ].join(" ")}
        >
          ✓
        </span>
        <span
          className={[
            "text-sm",
            task.done ? "text-neutral-400 line-through" : "text-neutral-800",
          ].join(" ")}
        >
          {task.label}
        </span>
      </a>
    </li>
  );
}

interface Update {
  text: string;
  meta?: string;
}

function buildUpdates(input: {
  primary: CandidateApplicationRow | null;
  upcoming: CandidateInterviewRow | undefined;
  offerOpen: string | undefined;
}): Update[] {
  const updates: Update[] = [];
  if (input.offerOpen === "extended") {
    updates.push({ text: "An offer has been extended to you.", meta: "See Your offer above" });
  } else if (input.offerOpen === "accepted") {
    updates.push({ text: "You accepted your offer.", meta: "Onboarding to follow" });
  }
  if (input.upcoming) {
    updates.push({
      text: `${input.upcoming.roundName} scheduled`,
      meta: formatWhen(input.upcoming.scheduledStart),
    });
  }
  if (input.primary && !TERMINAL_NEGATIVE.has(input.primary.currentStage)) {
    updates.push({
      text: `${input.primary.positionTitle}: now at ${STAGE_LABELS[input.primary.currentStage] ?? input.primary.currentStage}`,
      meta: `Applied ${formatDate(input.primary.appliedAt)}`,
    });
  }
  return updates.slice(0, 4);
}
