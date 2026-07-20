"use client";

import type { GetAdminDashboardExtrasOutput, DashboardAction } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { Card, StatTile, type StatTileTone } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { PageHeader } from "@/components/patterns";

/**
 * AdminDashboard (AD-01) — the bespoke admin landing surface, mirroring the
 * RecruiterDashboard pattern. Two reads: getMyDashboard (its recommended
 * `actions` feed the "Tasks due today" strip) and getAdminDashboardExtras
 * (four DETERMINISTIC governance tiles — open reqs, active users, active
 * workflows, 7-day audit events).
 *
 * HONESTY GUARDRAILS (this is the governance persona where the EU story sells):
 *   · NO "Bias Alert: gender skew 72% male" notification — the prototype's
 *     demographic alert is REFUSED. We make no demographic/gender/ethnicity
 *     inference anywhere.
 *   · NO "AI Report Scheduler — Coming Soon" placeholder — omitted.
 *   · Every tile is a real COUNT deep-linked to the admin surface that owns it.
 *     Quick actions deep-link to the seven real admin pages.
 */

const TILE_HREF = {
  openRequisitions: "/admin/reports",
  activeUsers: "/admin/users",
  activeWorkflows: "/admin/workflows",
  auditEvents7d: "/admin/audit",
} as const;

function Tile({
  href,
  label,
  value,
  hint,
  tone,
}: {
  href: string;
  label: string;
  value: number;
  hint: string;
  tone: StatTileTone;
}) {
  return (
    <a
      href={href}
      className="rounded-card outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400"
    >
      <StatTile
        label={label}
        value={value.toLocaleString()}
        hint={hint}
        tone={tone}
        className="h-full transition-colors hover:border-neutral-300"
      />
    </a>
  );
}

const URGENCY_META: Record<DashboardAction["urgency"], { label: string; cls: string }> = {
  urgent: { label: "urgent", cls: "bg-status-error-50 text-status-error-700" },
  attention: { label: "attention", cls: "bg-status-warning-50 text-status-warning-800" },
  normal: { label: "review", cls: "bg-neutral-100 text-neutral-600" },
};

const QUICK_ACTIONS: { label: string; href: string; hint: string }[] = [
  { label: "Users & roles", href: "/admin/users", hint: "Members, roles, invites" },
  { label: "AI settings", href: "/admin/ai-settings", hint: "Model, emphasis, bias, PII" },
  { label: "Workflows", href: "/admin/workflows", hint: "Automation agents" },
  { label: "Audit", href: "/admin/audit", hint: "Governance event log" },
  { label: "Costs", href: "/admin/costs", hint: "AI spend, per feature" },
  { label: "Reports", href: "/admin/reports", hint: "Recruitment funnel" },
  { label: "Integrations", href: "/admin/integrations", hint: "Connected systems" },
];

export function AdminDashboard({
  initialExtras,
  tasks,
  displayName,
}: {
  initialExtras: GetAdminDashboardExtrasOutput;
  tasks: DashboardAction[];
  displayName: string;
}) {
  const extrasQuery = trpc.getAdminDashboardExtras.useQuery(undefined, {
    initialData: initialExtras,
  });
  const tiles = (extrasQuery.data ?? initialExtras).tiles;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-6">
      <PageHeader
        title={`Welcome, ${displayName}`}
        subtitle="Admin console · settings, integrations & governance."
      />

      {/* Governance tiles — four real, tenant-scoped counts. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          href={TILE_HREF.openRequisitions}
          label="Open requisitions"
          value={tiles.openRequisitions}
          hint="live-to-fill statuses"
          tone="accent"
        />
        <Tile
          href={TILE_HREF.activeUsers}
          label="Active users"
          value={tiles.activeUsers}
          hint="active memberships"
          tone="info"
        />
        <Tile
          href={TILE_HREF.activeWorkflows}
          label="Active workflows"
          value={tiles.activeWorkflows}
          hint="enabled automation agents"
          tone="positive"
        />
        <Tile
          href={TILE_HREF.auditEvents7d}
          label="Audit events"
          value={tiles.auditEvents7d}
          hint="last 7 days"
          tone="neutral"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Tasks due today — the real getMyDashboard recommended actions. */}
        <div className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Tasks due today</h2>
          {tasks.length === 0 ? (
            <Card>
              <p className="text-sm text-neutral-500">
                Nothing needs your attention right now. Recommended admin actions surface here as
                requisitions, approvals and agent drafts flow in.
              </p>
            </Card>
          ) : (
            <Card padded={false}>
              <div className="divide-y divide-neutral-100">
                {tasks.map((t) => {
                  const m = URGENCY_META[t.urgency];
                  return (
                    <a
                      key={t.key}
                      href={t.href}
                      className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-neutral-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-neutral-900">{t.label}</p>
                        {t.detail ? (
                          <p className="truncate text-xs text-neutral-500">{t.detail}</p>
                        ) : null}
                      </div>
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
        </div>

        {/* Quick actions — deep-links to the seven real admin surfaces. */}
        <aside>
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">Quick actions</h2>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_ACTIONS.map((a) => (
              <a
                key={a.href}
                href={a.href}
                className="flex flex-col gap-0.5 rounded-card border border-neutral-200 bg-white p-3 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
              >
                <span className="text-sm font-medium text-neutral-900">{a.label}</span>
                <span className="text-[11px] leading-snug text-neutral-500">{a.hint}</span>
              </a>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
