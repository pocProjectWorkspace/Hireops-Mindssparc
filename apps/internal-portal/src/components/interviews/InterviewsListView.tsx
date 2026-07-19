"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@hireops/ui";
import { Badge, EmptyState, Card } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { trpc } from "@/lib/trpc-client";
import type { InterviewRow, InterviewRecommendation } from "@hireops/api-types";

/**
 * INT-02 / RECR-01 — recruiter interviews surface, elevated to the prototype
 * gestalt: Scheduled / Overdue / Completed tabs with live counts, a card layout
 * per interview (confirmation + invite-status badges), a "Start" that opens the
 * existing candidate context board (NOT a call), and an elevated close path that
 * surfaces the interview decision summary inline.
 *
 * Honest calendar story: the invite badge reads "invite sent (.ics)" — a REAL
 * generated calendar attachment rode the candidate.interview_invitation email.
 * It is deliberately NOT "calendar synced": there is no two-way Google/Outlook
 * sync (that is deferred connector work), and we never fake a Meet link.
 */

const MODE_LABEL: Record<string, string> = { video: "Video", onsite: "On-site", phone: "Phone" };

type TabKey = "scheduled" | "overdue" | "completed";

const REC_LABEL: Record<InterviewRecommendation, string> = {
  strong_yes: "Strong yes",
  yes: "Yes",
  hold: "Hold",
  no: "No",
};
const REC_TONE: Record<InterviewRecommendation, "success" | "warning" | "error"> = {
  strong_yes: "success",
  yes: "success",
  hold: "warning",
  no: "error",
};

function initials(name: string | null): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "??";
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "TBC";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "TBC";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Compact, read-only decision summary — the elevated close path. Editing /
 * completing / reopening remains in the triage-drawer controls; this surfaces
 * the roll-up so the recruiter sees where the decision stands before acting. */
function DecisionSummary({ interviewId }: { interviewId: string }) {
  const summary = trpc.getInterviewDecisionSummary.useQuery({ interviewId });
  if (summary.isLoading) return <p className="mt-2 text-xs text-neutral-500">Loading decision…</p>;
  if (!summary.data) return null;
  const { rollup, panelists } = summary.data;
  return (
    <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50/60 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-neutral-700">Decision summary</span>
        {rollup.leadRecommendation ? (
          <Badge tone={REC_TONE[rollup.leadRecommendation]}>
            Lead: {REC_LABEL[rollup.leadRecommendation]}
          </Badge>
        ) : (
          <span className="text-neutral-400">Lead recommendation pending</span>
        )}
        <span className="text-neutral-500">
          {rollup.submittedCount}/{rollup.panelistCount} in · SY {rollup.counts.strong_yes} · Y{" "}
          {rollup.counts.yes} · H {rollup.counts.hold} · N {rollup.counts.no}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {panelists.map((p) => (
          <div key={p.membershipId} className="flex items-center justify-between gap-2">
            <span className="truncate text-neutral-700">
              {p.name ?? "Panellist"}
              {p.isLead ? <span className="ml-1 text-brand-700">· lead</span> : null}
            </span>
            {p.recommendation ? (
              <Badge tone={REC_TONE[p.recommendation]}>{REC_LABEL[p.recommendation]}</Badge>
            ) : (
              <span className="text-neutral-400">
                {p.feedbackState === "submitted" ? "no rec" : "pending"}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-neutral-400">
        Complete and advance from the candidate board — human decision, machine bookkeeping.
      </p>
    </div>
  );
}

function InterviewCardRow({
  iv,
  onCancel,
  cancelPending,
}: {
  iv: InterviewRow;
  onCancel: (id: string) => void;
  cancelPending: boolean;
}) {
  const [showDecision, setShowDecision] = useState(false);
  const confirmed = !!iv.candidateConfirmedAt;
  const allFeedbackIn =
    iv.panel.length > 0 && iv.panel.every((p) => p.feedbackState === "submitted");
  const boardHref = `/triage?candidateId=${iv.candidateId}&applicationId=${iv.applicationId}`;
  const isScheduled = iv.status === "scheduled";
  const canShowDecision = iv.status === "completed" || allFeedbackIn;

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#16181f] text-xs font-semibold text-white">
            {initials(iv.candidateName)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-neutral-900">
              {iv.candidateName ?? "Candidate"}
            </p>
            <p className="truncate text-xs text-neutral-500">
              {iv.positionTitle} · Round {iv.roundNumber}
              <span className="ml-1 text-neutral-400">({MODE_LABEL[iv.mode] ?? iv.mode})</span>
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {confirmed ? (
                <span className="inline-flex items-center rounded-full bg-status-positive-50 px-2 py-0.5 text-[11px] font-medium text-status-positive-700">
                  ✓ Confirmed
                </span>
              ) : isScheduled ? (
                <span className="inline-flex items-center rounded-full bg-status-warning-50 px-2 py-0.5 text-[11px] font-medium text-status-warning-800">
                  ⧗ Pending confirmation
                </span>
              ) : null}
              {iv.invitationSentAt ? (
                <span
                  className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600"
                  title="A real .ics calendar file was attached to the invitation email. No two-way calendar sync — that is deferred connector work."
                >
                  📎 invite sent (.ics)
                </span>
              ) : null}
              {allFeedbackIn && isScheduled ? <Badge tone="success">Ready to close</Badge> : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <div className="text-xs tabular-nums text-neutral-600">{fmtWhen(iv.scheduledStart)}</div>
          {iv.panel.length > 0 ? (
            <div className="max-w-[16rem] truncate text-xs text-neutral-500">
              {iv.panel.map((p) => p.name ?? "member").join(", ")}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {canShowDecision ? (
              <button
                type="button"
                onClick={() => setShowDecision((v) => !v)}
                className="text-xs font-medium text-brand-700 hover:underline"
              >
                {showDecision ? "Hide decision" : "View decision"}
              </button>
            ) : null}
            <a
              href={boardHref}
              className="inline-flex h-8 items-center rounded-button bg-brand-600 px-3 text-xs font-medium text-white transition-colors hover:bg-brand-700"
            >
              {iv.status === "completed" ? "Open board" : "Start"}
            </a>
            {isScheduled ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={cancelPending}
                onClick={() => onCancel(iv.id)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {showDecision ? <DecisionSummary interviewId={iv.id} /> : null}
    </Card>
  );
}

export function InterviewsListView() {
  const [tab, setTab] = useState<TabKey>("scheduled");
  const queryClient = useQueryClient();

  const scheduled = trpc.listUpcomingInterviews.useQuery(
    { status: "scheduled", limit: 100 },
    { placeholderData: (prev) => prev },
  );
  const completed = trpc.listUpcomingInterviews.useQuery(
    { status: "completed", limit: 100 },
    { placeholderData: (prev) => prev },
  );
  const cancel = trpc.cancelInterview.useMutation({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [["listUpcomingInterviews"]] });
    },
  });

  const { upcomingRows, overdueRows } = useMemo(() => {
    const now = Date.now();
    const up: InterviewRow[] = [];
    const od: InterviewRow[] = [];
    for (const iv of scheduled.data?.rows ?? []) {
      const start = iv.scheduledStart ? new Date(iv.scheduledStart).getTime() : NaN;
      if (Number.isFinite(start) && start < now) od.push(iv);
      else up.push(iv);
    }
    // Upcoming: soonest first. Overdue: most-overdue first.
    up.sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
    od.sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
    return { upcomingRows: up, overdueRows: od };
  }, [scheduled.data?.rows]);

  const completedRows = completed.data?.rows ?? [];

  const onCancel = (id: string) => {
    const reason = window.prompt("Cancel reason?", "No longer needed") ?? "";
    if (reason) cancel.mutate({ interviewId: id, reason });
  };

  const TABS: { key: TabKey; label: string; count: number; danger?: boolean }[] = [
    { key: "scheduled", label: "Scheduled", count: upcomingRows.length },
    { key: "overdue", label: "Overdue", count: overdueRows.length, danger: true },
    { key: "completed", label: "Completed", count: completedRows.length },
  ];

  const rows = tab === "scheduled" ? upcomingRows : tab === "overdue" ? overdueRows : completedRows;
  const loading = scheduled.isLoading || completed.isLoading;

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <div className="mb-4 inline-flex rounded-lg border border-neutral-200 bg-neutral-50 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === t.key
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-500 hover:text-neutral-700",
            )}
          >
            {t.label}
            <span
              className={cn(
                "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                t.danger && t.count > 0
                  ? "bg-status-error-500 text-white"
                  : "bg-neutral-200 text-neutral-600",
              )}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            tab === "overdue"
              ? "Nothing overdue"
              : tab === "completed"
                ? "No completed interviews"
                : "No scheduled interviews"
          }
          hint={
            tab === "completed"
              ? "Completed interviews appear here with their decision summary."
              : "Schedule interviews from a candidate in Triage."
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((iv) => (
            <InterviewCardRow
              key={iv.id}
              iv={iv}
              onCancel={onCancel}
              cancelPending={cancel.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
