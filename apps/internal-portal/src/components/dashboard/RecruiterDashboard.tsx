"use client";

import type {
  GetRecruiterDashboardExtrasOutput,
  DashboardKpi,
  InterviewRow,
  RecruiterInsight,
  RecruiterTask,
  RecruiterFollowUp,
} from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Card, StatTile, type StatTileTone } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { PageHeader, StageFunnel, ShieldIcon } from "@/components/patterns";

/**
 * RecruiterDashboard (RECR-01) — the bespoke recruiter landing surface. Two
 * reads: getMyDashboard (the six real recruiter KPIs) and
 * getRecruiterDashboardExtras (pipeline funnel with conversion deltas, computed
 * AI insights, today's tasks, smart follow-ups, data-completeness + risk
 * flags), plus listUpcomingInterviews for the interviews rail.
 *
 * EVERYTHING here is DETERMINISTIC and honest:
 *   · No "AI Confidence" tile — that invented aggregate probability is refused
 *     (EU AI Act posture).
 *   · Insight CTAs link to the real SkillWeightsEditor / triage — never an
 *     auto-adjust magic button.
 *   · Smart-follow-up "Ping" routes into the human-in-loop approvals queue,
 *     never a one-click send.
 */

const KPI_TONE: Record<string, StatTileTone> = {
  accent: "accent",
  error: "error",
  warning: "warning",
  info: "info",
  positive: "positive",
  neutral: "neutral",
};

function KpiTile({ kpi }: { kpi: DashboardKpi }) {
  return (
    <a
      href={kpi.href}
      className="rounded-card outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400"
    >
      <StatTile
        label={kpi.label}
        value={kpi.value}
        hint={kpi.hint ?? undefined}
        tone={(KPI_TONE[kpi.tone] ?? "neutral") as StatTileTone}
        className="h-full transition-colors hover:border-neutral-300"
      />
    </a>
  );
}

const PRIORITY_META: Record<RecruiterTask["priority"], { label: string; cls: string }> = {
  high: { label: "high", cls: "bg-status-error-50 text-status-error-700" },
  medium: { label: "medium", cls: "bg-status-warning-50 text-status-warning-800" },
  low: { label: "low", cls: "bg-neutral-100 text-neutral-600" },
};

const INSIGHT_META: Record<
  RecruiterInsight["severity"],
  { rail: string; dot: string; label: string }
> = {
  critical: { rail: "border-l-status-error-400", dot: "bg-status-error-500", label: "Attention" },
  warning: {
    rail: "border-l-status-warning-400",
    dot: "bg-status-warning-500",
    label: "Review",
  },
  info: { rail: "border-l-status-info-400", dot: "bg-status-info-500", label: "Note" },
};

function InsightCard({ insight }: { insight: RecruiterInsight }) {
  const m = INSIGHT_META[insight.severity];
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-card border border-neutral-200 border-l-2 bg-white p-4",
        m.rail,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} aria-hidden />
        <p className="text-sm font-semibold text-neutral-900">{insight.title}</p>
      </div>
      <p className="text-xs leading-relaxed text-neutral-600">{insight.body}</p>
      {insight.cta ? (
        <a
          href={insight.cta.href}
          className="mt-0.5 inline-flex w-fit items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
        >
          {insight.cta.label}
          <span aria-hidden>→</span>
        </a>
      ) : null}
    </div>
  );
}

function FollowUpRow({ item }: { item: RecruiterFollowUp }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-neutral-900">{item.candidateName}</p>
        <p className="truncate text-xs text-neutral-500">{item.reason}</p>
      </div>
      <a
        href={item.href}
        title="Draft a follow-up for approval (human-in-loop — never auto-sent)"
        className="shrink-0 rounded-button border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-100"
      >
        Ping
      </a>
    </div>
  );
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

function UpcomingRow({ iv }: { iv: InterviewRow }) {
  const confirmed = !!iv.candidateConfirmedAt;
  return (
    <a
      href={`/triage?candidateId=${iv.candidateId}&applicationId=${iv.applicationId}`}
      className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-neutral-900">
          {iv.candidateName ?? "Candidate"}
        </p>
        <p className="truncate text-xs text-neutral-500">
          {iv.positionTitle} · {fmtWhen(iv.scheduledStart)}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600">
          R{iv.roundNumber}
        </span>
        {confirmed ? (
          <span className="text-[11px] font-medium text-status-positive-700">Confirmed</span>
        ) : (
          <span className="text-[11px] font-medium text-status-warning-700">Pending</span>
        )}
      </div>
    </a>
  );
}

export function RecruiterDashboard({
  initialExtras,
  initialInterviews,
  kpis,
  displayName,
}: {
  initialExtras: GetRecruiterDashboardExtrasOutput;
  initialInterviews: InterviewRow[];
  kpis: DashboardKpi[];
  displayName: string;
}) {
  const extrasQuery = trpc.getRecruiterDashboardExtras.useQuery(undefined, {
    initialData: initialExtras,
  });
  const upcomingQuery = trpc.listUpcomingInterviews.useQuery(
    { status: "scheduled", limit: 5 },
    { initialData: { rows: initialInterviews, nextCursor: null } },
  );
  const data = extrasQuery.data ?? initialExtras;
  const upcoming = (upcomingQuery.data?.rows ?? initialInterviews).slice(0, 5);

  const funnelStages = data.funnel.stages.map((s) => ({
    stage: s.stage,
    label: s.label,
    count: s.count,
    pct: s.pct,
    deltaPct: s.conversionPct == null ? null : s.conversionPct - 100,
  }));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-6">
      <PageHeader
        title={`Welcome back, ${displayName}`}
        subtitle="Your pipeline, interviews, and follow-ups at a glance."
      />

      {/* KPI strip — the six real recruiter KPIs + the honest avg match score. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {kpis.map((k) => (
          <KpiTile key={k.key} kpi={k} />
        ))}
        <StatTile
          label="Avg match score"
          value={data.avgMatchScore == null ? "—" : `${data.avgMatchScore}%`}
          hint={data.avgMatchScore == null ? "no candidates scored yet" : "AI screening average"}
          tone="neutral"
          className="h-full"
        />
      </div>

      {/* 2-col main + right rail. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* Pipeline funnel. */}
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-neutral-900">Pipeline funnel</h2>
              <span className="text-xs text-neutral-400">
                {data.funnel.total} candidates in flight
              </span>
            </div>
            <Card>
              {data.funnel.total === 0 ? (
                <p className="text-sm text-neutral-500">
                  No candidates in the pipeline yet. Stage counts appear here as applications flow
                  in.
                </p>
              ) : (
                <StageFunnel stages={funnelStages} bottleneck={data.funnel.bottleneck} />
              )}
            </Card>
          </section>

          {/* Completeness + risk flags. */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                Data completeness
              </p>
              <p className="mt-1 text-3xl font-semibold tabular-nums text-neutral-900">
                {data.dataCompleteness.pct}%
              </p>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-100">
                <div
                  className="h-full rounded-full bg-brand-500"
                  style={{ width: `${data.dataCompleteness.pct}%` }}
                  aria-hidden
                />
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                {data.dataCompleteness.needInfoCount === 0
                  ? "All in-flight candidates have score + expected salary."
                  : `${data.dataCompleteness.needInfoCount} candidate${
                      data.dataCompleteness.needInfoCount === 1 ? "" : "s"
                    } missing score or expected salary.`}
              </p>
            </Card>
            <Card>
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                Risk flags
              </p>
              <p
                className={cn(
                  "mt-1 text-3xl font-semibold tabular-nums",
                  data.riskFlags.total > 0 ? "text-status-error-700" : "text-neutral-900",
                )}
              >
                {data.riskFlags.total}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.riskFlags.skillMismatch > 0 ? (
                  <span className="rounded-full bg-status-error-50 px-2 py-0.5 text-[11px] font-medium text-status-error-700">
                    Skill mismatch · {data.riskFlags.skillMismatch}
                  </span>
                ) : null}
                {data.riskFlags.salaryGap > 0 ? (
                  <span className="rounded-full bg-status-warning-50 px-2 py-0.5 text-[11px] font-medium text-status-warning-800">
                    Salary gap · {data.riskFlags.salaryGap}
                  </span>
                ) : null}
                {data.riskFlags.total === 0 ? (
                  <span className="text-xs text-neutral-500">
                    No risk flags on in-flight candidates.
                  </span>
                ) : null}
              </div>
            </Card>
          </section>

          {/* AI insights. */}
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
              <ShieldIcon width={15} height={15} className="text-neutral-500" />
              AI insights
              <span className="font-normal text-neutral-400">· computed observations</span>
            </h2>
            {data.insights.length === 0 ? (
              <Card>
                <p className="text-sm text-neutral-500">
                  No notable patterns right now. Observations surface here as the pipeline grows.
                </p>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {data.insights.map((ins) => (
                  <InsightCard key={ins.key} insight={ins} />
                ))}
              </div>
            )}
          </section>

          {/* Today's tasks. */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Today&apos;s tasks</h2>
            {data.tasks.length === 0 ? (
              <Card>
                <p className="text-sm text-neutral-500">You&apos;re all caught up.</p>
              </Card>
            ) : (
              <Card padded={false}>
                <div className="divide-y divide-neutral-100">
                  {data.tasks.map((t) => {
                    const m = PRIORITY_META[t.priority];
                    return (
                      <a
                        key={t.key}
                        href={t.href}
                        className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
                      >
                        <p className="min-w-0 truncate text-sm font-medium text-neutral-900">
                          {t.label}
                        </p>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                            m.cls,
                          )}
                        >
                          {m.label}
                        </span>
                      </a>
                    );
                  })}
                </div>
              </Card>
            )}
          </section>
        </div>

        {/* Right rail: upcoming interviews + smart follow-ups. */}
        <aside className="flex flex-col gap-6">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-900">Upcoming interviews</h2>
              <a href="/interviews" className="text-xs font-medium text-brand-700 hover:underline">
                View all →
              </a>
            </div>
            {upcoming.length === 0 ? (
              <Card>
                <p className="text-sm text-neutral-500">No scheduled interviews.</p>
              </Card>
            ) : (
              <Card padded={false}>
                <div className="divide-y divide-neutral-100">
                  {upcoming.map((iv) => (
                    <UpcomingRow key={iv.id} iv={iv} />
                  ))}
                </div>
              </Card>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-900">Smart follow-ups</h2>
              <a href="/approvals" className="text-xs font-medium text-brand-700 hover:underline">
                Queue →
              </a>
            </div>
            {data.followUps.length === 0 ? (
              <Card>
                <p className="text-sm text-neutral-500">No stalled candidates need a nudge.</p>
              </Card>
            ) : (
              <Card padded={false}>
                <div className="divide-y divide-neutral-100">
                  {data.followUps.map((f) => (
                    <FollowUpRow key={f.key} item={f} />
                  ))}
                </div>
              </Card>
            )}
            <p className="mt-2 px-1 text-[11px] leading-relaxed text-neutral-400">
              Ping drafts a follow-up for your approval — nothing is sent without a human sign-off.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
