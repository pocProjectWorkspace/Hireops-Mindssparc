"use client";

import { trpc } from "@/lib/trpc-client";
import { Card, StatTile } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { PageHeader, HeroStatCard, InboxIcon } from "@/components/patterns";
import type { GetRequirementOwnerDashboardOutput } from "@hireops/api-types";
import { HealthBar, DifficultyChip, ReqStatusChip, WaitingChip } from "./shared";

/**
 * RequirementOwnerDashboard (RO-01) — the rebuilt hiring_manager landing surface.
 * Hero stat strip + health-scores card + deterministic action-required list +
 * market insights (curated difficulty + OUR historical time-to-hire) on the main
 * column; a pending-approval SLA rail on the right. Mirrors the HR-head gestalt
 * on the same tokens.
 */

const SEVERITY_CLS: Record<"urgent" | "attention" | "info", string> = {
  urgent: "bg-status-error-50 text-status-error-700",
  attention: "bg-status-warning-50 text-status-warning-800",
  info: "bg-neutral-100 text-neutral-600",
};

const SEVERITY_LABEL: Record<"urgent" | "attention" | "info", string> = {
  urgent: "high",
  attention: "medium",
  info: "low",
};

export function RequirementOwnerDashboard({
  initial,
  displayName,
}: {
  initial: GetRequirementOwnerDashboardOutput;
  displayName: string;
}) {
  const query = trpc.getRequirementOwnerDashboard.useQuery(undefined, { initialData: initial });
  const data = query.data ?? initial;

  const hero = data.stats.find((s) => s.key === "total");
  const rest = data.stats.filter((s) => s.key !== "total");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-6">
      <PageHeader
        title={`Welcome back, ${displayName}`}
        subtitle="Your requisitions, their health, and where they're stuck — at a glance."
      />

      {/* Hero + sibling stat strip. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-4">
        {hero ? (
          <HeroStatCard
            label={hero.label}
            value={hero.value}
            caption="requisitions"
            href={hero.href ?? undefined}
            icon={<InboxIcon width={18} height={18} />}
          />
        ) : null}
        {rest.map((s) => (
          <a
            key={s.key}
            href={s.href ?? undefined}
            className="rounded-card outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          >
            <StatTile
              label={s.label}
              value={s.value}
              className="h-full transition-colors hover:border-neutral-300"
            />
          </a>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {/* Action required. */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Action required</h2>
            {data.actions.length === 0 ? (
              <Card>
                <p className="text-sm text-neutral-500">
                  Nothing needs your attention. New gaps or stalled approvals surface here.
                </p>
              </Card>
            ) : (
              <Card padded={false}>
                <div className="divide-y divide-neutral-100">
                  {data.actions.map((a) => (
                    <a
                      key={a.key}
                      href={a.href}
                      className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-neutral-900">{a.title}</p>
                        <p className="truncate text-xs text-neutral-500">{a.detail}</p>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          SEVERITY_CLS[a.severity],
                        )}
                      >
                        {SEVERITY_LABEL[a.severity]}
                      </span>
                    </a>
                  ))}
                </div>
              </Card>
            )}
          </section>

          {/* Health scores. */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Requisition health</h2>
            {data.healthRows.length === 0 ? (
              <Card>
                <p className="text-sm text-neutral-500">No requisitions yet.</p>
              </Card>
            ) : (
              <Card padded={false}>
                <div className="divide-y divide-neutral-100">
                  {data.healthRows.map((h) => (
                    <a
                      key={h.requisitionId}
                      href={`/requisitions/${h.requisitionId}`}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-neutral-900">
                            {h.title ?? "Untitled requisition"}
                          </span>
                          <ReqStatusChip status={h.status} />
                        </div>
                      </div>
                      <DifficultyChip difficulty={h.difficulty} />
                      <div className="w-40 shrink-0">
                        <HealthBar health={{ score: h.score, components: [] }} />
                      </div>
                    </a>
                  ))}
                </div>
              </Card>
            )}
          </section>

          {/* Market insights. */}
          <section>
            <h2 className="mb-2 text-sm font-semibold text-neutral-900">Market insights</h2>
            <Card padded={false}>
              {data.marketInsights.length === 0 ? (
                <div className="px-4 py-3">
                  <p className="text-sm text-neutral-500">
                    Difficulty and historical time-to-hire appear here once you have requisitions.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-100">
                  {data.marketInsights.map((m) => (
                    <div key={m.roleTitle} className="flex items-center gap-3 px-4 py-3">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900">
                        {m.roleTitle}
                      </span>
                      <DifficultyChip difficulty={m.difficulty} />
                      <span className="w-44 shrink-0 text-right text-xs text-neutral-500">
                        {m.sampleSize > 0 && m.historicalAvgTimeToHireDays != null
                          ? `${m.historicalAvgTimeToHireDays}d avg (historical, n=${m.sampleSize})`
                          : m.benchmarkTtfDays != null
                            ? `~${m.benchmarkTtfDays}d benchmark TTF`
                            : "no history yet"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <p className="mt-1.5 px-1 text-[11px] text-neutral-400">
              Historical averages are computed from this organisation&apos;s own hiring data.
              Benchmark time-to-fill is curated reference data, not a live market feed.
            </p>
          </section>
        </div>

        {/* Right rail: approval SLA. */}
        <aside className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-neutral-900">Approvals — waiting</h2>
          {data.approvalSla.length === 0 ? (
            <Card>
              <p className="text-sm text-neutral-500">No requisitions are awaiting approval.</p>
            </Card>
          ) : (
            <Card padded={false}>
              <div className="divide-y divide-neutral-100">
                {data.approvalSla.map((s) => (
                  <a
                    key={s.approvalRequestId}
                    href="/approval-tracker"
                    className="flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-neutral-50"
                  >
                    <span className="truncate text-sm font-medium text-neutral-900">
                      {s.title ?? "Untitled requisition"}
                    </span>
                    <div className="flex items-center gap-2">
                      <WaitingChip hours={s.hoursWaiting} breach={s.breach} />
                      <span className="text-[11px] text-neutral-400">
                        SLA {Math.round(s.slaHours / 24)}d
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
