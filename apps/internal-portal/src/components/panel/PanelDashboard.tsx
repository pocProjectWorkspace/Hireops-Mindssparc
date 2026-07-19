"use client";

import { useMemo, useState } from "react";
import { Button, Card, StatTile } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { trpc } from "@/lib/trpc-client";
import type { GetPanelDashboardOutput, PanelInterviewRow } from "@hireops/api-types";
import { PageHeader, HeroStatCard, AlertCard, InboxIcon } from "@/components/patterns";
import { InterviewCard } from "./InterviewCard";

/**
 * PanelDashboard (PANEL-01) — the panel persona's landing experience.
 *
 * Two reads (both server-seeded): getPanelDashboard (hero stats + pending /
 * submitted lists, the urgent banner + overdue nudge feed) and
 * listMyPanelInterviews (the segmented interview cards). Structural richness on
 * OUR slate+indigo tokens, matching the HR-ops surfaces. Every number is real.
 */

type Tab = "today" | "upcoming" | "needs_scorecard";

const OVERDUE_DISMISS_KEY = "panel01_overdue_dismissed";

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfToday(): number {
  return startOfToday() + 86_400_000;
}

function inWindowNow(iv: PanelInterviewRow): boolean {
  if (iv.status !== "scheduled" || !iv.scheduledStart || !iv.scheduledEnd) return false;
  const now = Date.now();
  return new Date(iv.scheduledStart).getTime() <= now && new Date(iv.scheduledEnd).getTime() >= now;
}

function isPastWindow(iv: PanelInterviewRow): boolean {
  return (
    iv.status === "completed" ||
    (iv.scheduledEnd !== null && new Date(iv.scheduledEnd).getTime() < Date.now())
  );
}

function fmtAvg(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}`;
}

export function PanelDashboard({
  initialBoard,
  initialInterviews,
  displayName,
}: {
  initialBoard: GetPanelDashboardOutput;
  initialInterviews: PanelInterviewRow[];
  displayName: string;
}) {
  const boardQuery = trpc.getPanelDashboard.useQuery(undefined, { initialData: initialBoard });
  const listQuery = trpc.listMyPanelInterviews.useQuery(
    {},
    { initialData: { rows: initialInterviews } },
  );
  const board = boardQuery.data ?? initialBoard;
  const rows = useMemo(() => listQuery.data?.rows ?? [], [listQuery.data]);

  const buckets = useMemo(() => {
    const sod = startOfToday();
    const eod = endOfToday();
    const today: PanelInterviewRow[] = [];
    const upcoming: PanelInterviewRow[] = [];
    const needsScorecard: PanelInterviewRow[] = [];
    for (const r of rows) {
      if (r.status === "cancelled") continue;
      const startMs = r.scheduledStart ? new Date(r.scheduledStart).getTime() : null;
      if (isPastWindow(r) && r.myFeedbackState !== "submitted") needsScorecard.push(r);
      if (startMs !== null && startMs >= sod && startMs < eod) today.push(r);
      else if (r.status === "scheduled" && startMs !== null && startMs >= eod) upcoming.push(r);
    }
    // Nearest first for schedule tabs; oldest-first for the scorecard backlog.
    today.sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
    upcoming.sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
    needsScorecard.sort((a, b) => (a.scheduledStart ?? "").localeCompare(b.scheduledStart ?? ""));
    return { today, upcoming, needsScorecard };
  }, [rows]);

  const defaultTab: Tab =
    buckets.needsScorecard.length > 0 && buckets.today.length === 0 ? "needs_scorecard" : "today";
  const [tab, setTab] = useState<Tab>(defaultTab);

  const overdue = board.pending.filter((p) => p.overdue);
  const [dismissedOverdue, setDismissedOverdue] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(OVERDUE_DISMISS_KEY) === "1";
  });
  function dismissOverdue() {
    if (typeof window !== "undefined") window.sessionStorage.setItem(OVERDUE_DISMISS_KEY, "1");
    setDismissedOverdue(true);
  }

  const stats = board.stats;
  const pendingCount = stats.pendingFeedback;
  const bannerNames = board.pending.slice(0, 3).map((p) => p.candidateName ?? "a candidate");

  const active =
    tab === "today"
      ? buckets.today
      : tab === "upcoming"
        ? buckets.upcoming
        : buckets.needsScorecard;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-6">
      <PageHeader
        title={`Welcome back, ${displayName}`}
        subtitle="Your interviews, pending scorecards, and feedback at a glance."
      />

      {/* Hero stat strip. Pending feedback becomes the accent hero when > 0. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {pendingCount > 0 ? (
          <HeroStatCard
            label="Pending feedback"
            value={pendingCount}
            caption="scorecards awaiting you"
            href="/panel/feedback"
            icon={<InboxIcon width={18} height={18} />}
          />
        ) : (
          <HeroStatCard
            label="Today's interviews"
            value={stats.todayInterviews}
            caption={
              stats.inWindowNow > 0 ? `${stats.inWindowNow} in window now` : "you're all caught up"
            }
            href="/panel"
            icon={<InboxIcon width={18} height={18} />}
          />
        )}
        {pendingCount > 0 ? (
          <StatTileLink
            href="/panel"
            label="Today's interviews"
            value={stats.todayInterviews}
            hint={stats.inWindowNow > 0 ? `${stats.inWindowNow} in window now` : "scheduled today"}
          />
        ) : null}
        <StatTileLink
          href="/panel/history"
          label="Avg score I've given"
          value={fmtAvg(stats.avgScoreGiven)}
          hint={stats.avgScoreGiven === null ? "no scores yet" : "across my scorecards"}
        />
        <StatTileLink
          href="/panel"
          label="Completed today"
          value={stats.completedToday}
          hint="interviews wrapped"
        />
      </div>

      {/* Urgent-action banner (red strip). */}
      {pendingCount > 0 ? (
        <AlertCard
          severity="critical"
          chip={`${pendingCount}`}
          entity={`${pendingCount} interview${pendingCount === 1 ? "" : "s"} awaiting your score`}
          consequence={
            bannerNames.length > 0
              ? `${bannerNames.join(", ")}${board.pending.length > 3 ? " and more" : ""} — score them before the loop closes.`
              : "Score them before the loop closes."
          }
          href="/panel/feedback"
        />
      ) : null}

      {/* Segmented tabs + interview cards. */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-1 sm:w-fit">
          <TabButton
            active={tab === "today"}
            onClick={() => setTab("today")}
            label="Today"
            count={buckets.today.length}
          />
          <TabButton
            active={tab === "upcoming"}
            onClick={() => setTab("upcoming")}
            label="Upcoming"
            count={buckets.upcoming.length}
          />
          <TabButton
            active={tab === "needs_scorecard"}
            onClick={() => setTab("needs_scorecard")}
            label="Needs scorecard"
            count={buckets.needsScorecard.length}
            alert={buckets.needsScorecard.length > 0}
          />
        </div>

        {active.length === 0 ? (
          <Card>
            <p className="text-sm text-neutral-500">
              {tab === "today"
                ? "No interviews scheduled for today."
                : tab === "upcoming"
                  ? "No upcoming interviews on your panel."
                  : "No scorecards waiting — you're all caught up."}
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {active.map((iv) => (
              <InterviewCard key={iv.id} interview={iv} inWindowNow={inWindowNow(iv)} />
            ))}
          </div>
        )}
      </section>

      {/* Overdue nudge — a dismissible (per-session) modal, deterministic. */}
      {overdue[0] && !dismissedOverdue ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4">
          <Card className="w-full max-w-md">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-status-error-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-status-error-700">
                Overdue
              </span>
              <h2 className="text-base font-semibold text-neutral-900">Scorecard overdue</h2>
            </div>
            <p className="mb-3 text-sm text-neutral-600">
              {overdue.length === 1
                ? "One interview has been waiting over 24 hours for your scorecard:"
                : `${overdue.length} interviews have been waiting over 24 hours for your scorecard:`}
            </p>
            <ul className="mb-4 space-y-2">
              {overdue.slice(0, 3).map((o) => (
                <li
                  key={o.interviewId}
                  className="rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2"
                >
                  <p className="text-sm font-medium text-neutral-900">
                    {o.candidateName ?? "Candidate"}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {o.roleTitle} · Round {o.roundNumber}: {o.roundName} ·{" "}
                    {o.completedAt ? `interviewed ${daysAgo(o.completedAt)}` : "past its window"}
                  </p>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={dismissOverdue}>
                Remind me later
              </Button>
              <a
                href={`/panel/${overdue[0].interviewId}`}
                className="inline-flex h-8 items-center justify-center rounded-button bg-brand-600 px-3 text-sm font-medium text-white shadow-1 hover:bg-brand-700"
              >
                Score now
              </a>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function StatTileLink({
  href,
  label,
  value,
  hint,
}: {
  href: string;
  label: string;
  value: number | string;
  hint: string;
}) {
  return (
    <a
      href={href}
      className="rounded-card outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
    >
      <StatTile
        label={label}
        value={value}
        hint={hint}
        className="h-full transition-colors hover:border-neutral-300"
      />
    </a>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  alert = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  alert?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-brand-600 text-white shadow-1" : "text-neutral-600 hover:bg-neutral-100",
      )}
    >
      {label}
      <span
        className={cn(
          "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold",
          active
            ? "bg-white/20 text-white"
            : alert
              ? "bg-status-error-100 text-status-error-700"
              : "bg-neutral-100 text-neutral-600",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function daysAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const hours = Math.floor((Date.now() - then) / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
