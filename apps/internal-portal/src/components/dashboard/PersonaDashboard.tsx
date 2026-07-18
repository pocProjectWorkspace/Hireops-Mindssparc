import type {
  GetMyDashboardOutput,
  DashboardKpi,
  DashboardAction,
  DashboardActivity,
  DashboardUrgency,
} from "@hireops/api-types";
import { Card, StatTile, EmptyState, type StatTileTone } from "@/components/ui";
import { cn } from "@/components/ui/cn";

/**
 * PersonaDashboard — the DASH-01 landing surface (DESIGN primitives only).
 *
 * Presentational server component fed by a single getMyDashboard read. Three
 * honest sections: a KPI tile grid (each tile deep-links its surface), a
 * recommended-actions card (urgency-toned rows, each a link), and an optional
 * recent-activity strip (admin only today — cuttable). Every section carries a
 * calm empty state; no number is fabricated.
 *
 * `tone` on a KPI is the server's StatTileTone verbatim; `urgency` on an action
 * tints its row rail. No client hooks — renders inside the server-rendered page.
 */

function KpiTile({ kpi }: { kpi: DashboardKpi }) {
  return (
    <a
      href={kpi.href}
      className="rounded-md outline-none transition focus-visible:ring-2 focus-visible:ring-brand-400"
    >
      <StatTile
        label={kpi.label}
        value={kpi.value}
        hint={kpi.hint ?? undefined}
        tone={kpi.tone as StatTileTone}
        className="h-full transition-colors hover:border-neutral-300"
      />
    </a>
  );
}

const URGENCY_RAIL: Record<DashboardUrgency, string> = {
  urgent: "border-l-status-error-400",
  attention: "border-l-status-warning-400",
  normal: "border-l-neutral-200",
};

const URGENCY_LABEL: Record<DashboardUrgency, { text: string; cls: string } | null> = {
  urgent: { text: "Urgent", cls: "bg-status-error-50 text-status-error-700" },
  attention: { text: "Soon", cls: "bg-status-warning-50 text-status-warning-700" },
  normal: null,
};

function ActionRow({ action }: { action: DashboardAction }) {
  const badge = URGENCY_LABEL[action.urgency];
  return (
    <a
      href={action.href}
      className={cn(
        "flex items-center justify-between gap-3 border-l-2 px-4 py-3 transition-colors hover:bg-neutral-50",
        URGENCY_RAIL[action.urgency],
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-neutral-900">{action.label}</p>
        {action.detail ? (
          <p className="truncate text-xs text-neutral-500">{action.detail}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {badge ? (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
              badge.cls,
            )}
          >
            {badge.text}
          </span>
        ) : null}
        <span aria-hidden className="text-neutral-300">
          →
        </span>
      </div>
    </a>
  );
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ActivityRow({ item }: { item: DashboardActivity }) {
  const body = (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <p className="truncate text-sm text-neutral-700">{item.label}</p>
      <span className="shrink-0 text-xs tabular-nums text-neutral-400">{fmtWhen(item.at)}</span>
    </div>
  );
  return item.href ? (
    <a href={item.href} className="block transition-colors hover:bg-neutral-50">
      {body}
    </a>
  ) : (
    body
  );
}

export function PersonaDashboard({ data }: { data: GetMyDashboardOutput }) {
  const { kpis, actions, activity } = data;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-8 py-8">
      {/* KPI grid */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          At a glance
        </h2>
        {kpis.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="Nothing to show yet"
              hint="Your key numbers will appear here as work flows through your queues."
            />
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {kpis.map((k) => (
              <KpiTile key={k.key} kpi={k} />
            ))}
          </div>
        )}
      </section>

      {/* Recommended actions */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight text-neutral-900">
          Recommended actions
        </h2>
        {actions.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="Nothing needs you right now"
              hint="You're all caught up. New items that need a decision will surface here."
            />
          </Card>
        ) : (
          <Card padded={false}>
            <div className="divide-y divide-neutral-100">
              {actions.map((a) => (
                <ActionRow key={a.key} action={a} />
              ))}
            </div>
          </Card>
        )}
      </section>

      {/* Recent activity (optional strip) */}
      {activity && activity.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold tracking-tight text-neutral-900">
            Recent activity
          </h2>
          <Card padded={false}>
            <div className="divide-y divide-neutral-100">
              {activity.map((item) => (
                <ActivityRow key={item.key} item={item} />
              ))}
            </div>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
