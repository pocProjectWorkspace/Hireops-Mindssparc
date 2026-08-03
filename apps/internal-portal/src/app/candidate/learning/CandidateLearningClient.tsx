"use client";

import { useState } from "react";
import { TRPCClientError } from "@trpc/client";
import type { CandidateLearningItem } from "@hireops/api-types";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { PageContainer } from "@/components/nav/PageContainer";
import { CandidateShell } from "@/components/candidate/CandidateShell";
import { formatDate } from "@/components/candidate/candidate-format";
import { trpc } from "@/lib/trpc-client";
import {
  LEARNING_ASSIGNMENT_LAYER_LABELS,
  LEARNING_ASSIGNMENT_LAYER_ORDER,
  formatMinutes,
  learningStatusMeta,
  providerLabel,
  totalMinutes,
} from "@/components/learning/learning-format";

/**
 * Candidate learning (LD-1B) — the hire's own list, read from
 * candidateGetMyOnboarding().learning (the same already-resolved case the
 * documents list uses) and grouped by layer.
 *
 * Each item shows what it is, where it lives, roughly how long it takes and
 * when it's due, then hands off: the link opens the provider's own page in a
 * new tab. HireOps stores none of the material.
 *
 * HONEST LIMITATION, and the copy says so: progress here is SELF-ATTESTED.
 * Without an LMS callback nothing verifies the hire consumed anything —
 * "I've started" / "Mark complete" is their own claim, and it is forward-only
 * (a completed item can't be reopened from this side).
 */
export function CandidateLearningClient() {
  const me = trpc.candidateGetMe.useQuery(undefined, { retry: false });
  const onboarding = trpc.candidateGetMyOnboarding.useQuery();

  if (me.isError) {
    const forbidden = me.error instanceof TRPCClientError && me.error.data?.code === "FORBIDDEN";
    return (
      <CandidateShell variant="portal" active="learning">
        <PageContainer variant="measure">
          <Card className="p-6">
            <EmptyState
              title={
                forbidden ? "This isn't a candidate account" : "We couldn't load your learning"
              }
              hint={forbidden ? "You're signed in, but not as a candidate." : "Please try again."}
            />
          </Card>
        </PageContainer>
      </CandidateShell>
    );
  }

  const items = onboarding.data?.learning ?? [];
  const onboardingCase = onboarding.data?.case ?? null;
  const minutes = totalMinutes(items);
  const done = items.filter((i) => i.status === "completed").length;

  // Group by layer in a fixed order; an unrecognised layer is folded into the
  // per-individual bucket by the API, so nothing can vanish here.
  const byLayer = new Map<string, CandidateLearningItem[]>();
  for (const item of items) {
    const bucket = byLayer.get(item.layer) ?? [];
    bucket.push(item);
    byLayer.set(item.layer, bucket);
  }
  const groups = LEARNING_ASSIGNMENT_LAYER_ORDER.map((layer) => ({
    layer,
    label: LEARNING_ASSIGNMENT_LAYER_LABELS[layer],
    items: byLayer.get(layer) ?? [],
  })).filter((g) => g.items.length > 0);

  return (
    <CandidateShell variant="portal" active="learning">
      <PageContainer variant="measure" className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Learning</h1>
          <p className="text-sm text-neutral-600">
            What your new team would like you to work through
            {onboardingCase?.positionTitle ? ` for ${onboardingCase.positionTitle}` : ""}. Each item
            opens where it&rsquo;s hosted; you mark your own progress here.
          </p>
        </header>

        {onboarding.isLoading ? (
          <Card className="p-6">
            <EmptyState title="Loading your learning…" />
          </Card>
        ) : items.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              title="Nothing assigned yet"
              hint="When your team assigns you a course, a policy doc or an induction video, it’ll appear here with a link and a due date."
            />
          </Card>
        ) : (
          <>
            <Card className="flex flex-wrap items-center gap-x-8 gap-y-2 p-5">
              <Stat label="Items" value={`${done}/${items.length} done`} />
              {minutes > 0 ? <Stat label="Estimated time" value={formatMinutes(minutes)} /> : null}
              {onboardingCase?.expectedStartDate ? (
                <Stat
                  label="Your start date"
                  value={formatDate(onboardingCase.expectedStartDate)}
                />
              ) : null}
            </Card>

            {groups.map((group) => (
              <section key={group.layer} className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
                  {group.label}
                </h2>
                <Card className="flex flex-col divide-y divide-neutral-100 p-0">
                  {group.items.map((item) => (
                    <LearningRow key={item.taskId} item={item} />
                  ))}
                </Card>
              </section>
            ))}

            <p className="text-xs text-neutral-500">
              Marking something complete records your own confirmation — we link to the material, we
              don&rsquo;t track what you watched or read.
            </p>
          </>
        )}
      </PageContainer>
    </CandidateShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-neutral-900">{value}</p>
    </div>
  );
}

/**
 * One learning item. The progress control is forward-only and mirrors the
 * server: pending → in_progress → completed, nothing beyond. A blocked,
 * skipped or cancelled item (a recruiter-side move) shows its chip with no
 * control — the hire can't act on it from here.
 */
function LearningRow({ item }: { item: CandidateLearningItem }) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  const update = trpc.candidateUpdateLearningProgress.useMutation({
    onSuccess: () => void utils.candidateGetMyOnboarding.invalidate(),
    onError: (e) => setError(e.message),
  });

  const meta = learningStatusMeta(item.status);
  const busy = update.isPending;
  const actionable = item.status === "pending" || item.status === "in_progress";

  const detail = [
    providerLabel(item.provider),
    item.estimatedMinutes == null ? null : formatMinutes(item.estimatedMinutes),
    item.dueAt ? `Due ${formatDate(item.dueAt)}` : null,
  ]
    .filter((s): s is string => Boolean(s) && s !== "—")
    .join(" · ");

  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-neutral-900">{item.title}</p>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          {item.isRequired ? <Badge tone="accent">Required</Badge> : null}
        </div>
        {item.description ? (
          <p className="mt-0.5 text-xs text-neutral-500">{item.description}</p>
        ) : null}
        <p className="mt-0.5 text-xs text-neutral-400">{detail}</p>
        {item.status === "completed" && item.completedAt ? (
          <p className="mt-1 text-xs text-status-success-700">
            You marked this complete on {formatDate(item.completedAt)}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-xs text-status-error-700">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-button border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            Open ↗
          </a>
        ) : (
          <span className="text-xs text-neutral-400">No link recorded</span>
        )}
        {actionable && item.status === "pending" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              update.mutate({ taskId: item.taskId, status: "in_progress" });
            }}
          >
            I&rsquo;ve started
          </Button>
        ) : null}
        {actionable ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setError(null);
              update.mutate({ taskId: item.taskId, status: "completed" });
            }}
          >
            Mark complete
          </Button>
        ) : null}
      </div>
    </div>
  );
}
