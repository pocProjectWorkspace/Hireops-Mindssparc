"use client";

import { useEffect, useState } from "react";
import type { ListPanelSetupRequisitionsOutput, GetPanelSetupOutput } from "@hireops/api-types";
import { Badge, Card, EmptyState } from "@/components/ui";
import { InterviewPlanSection } from "@/components/interviews/InterviewPlanSection";
import { trpc } from "@/lib/trpc-client";

/**
 * RO-03 — the /panel-setup client. Pick a requisition (left rail with a plan
 * summary), then see the interview pipeline visualization + the embedded
 * InterviewPlanSection editor (reused as-is, props-level).
 */

type ReqRow = ListPanelSetupRequisitionsOutput["rows"][number];

function label(v: string): string {
  return v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function PanelSetupClient({ initial }: { initial: ListPanelSetupRequisitionsOutput }) {
  const query = trpc.listPanelSetupRequisitions.useQuery(
    { limit: 100 },
    { initialData: initial, refetchOnWindowFocus: false, staleTime: 5_000 },
  );
  const rows = query.data?.rows ?? initial.rows;

  const [selected, setSelected] = useState<string | null>(rows[0]?.requisitionId ?? null);
  useEffect(() => {
    const first = rows[0];
    if (selected === null && first) setSelected(first.requisitionId);
  }, [rows, selected]);

  if (rows.length === 0) {
    return (
      <div className="mx-auto w-full max-w-6xl px-8 py-6">
        <EmptyState
          title="No requisitions yet"
          hint="Create a requisition first — its interview loop is set up here."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-8 py-6 lg:grid-cols-[280px_1fr]">
      <aside className="space-y-2">
        <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
          Your requisitions
        </p>
        {rows.map((r) => (
          <ReqCard
            key={r.requisitionId}
            row={r}
            active={selected === r.requisitionId}
            onClick={() => setSelected(r.requisitionId)}
          />
        ))}
      </aside>
      <section className="min-w-0">
        {selected ? <PanelDetail requisitionId={selected} /> : null}
      </section>
    </div>
  );
}

function ReqCard({ row, active, onClick }: { row: ReqRow; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-card border p-3 text-left transition-colors ${
        active
          ? "border-brand-300 bg-brand-50"
          : "border-neutral-200 bg-white hover:border-neutral-300"
      }`}
      aria-current={active ? "true" : undefined}
    >
      <p className="truncate text-sm font-medium text-neutral-900">
        {row.title ?? "Untitled role"}
      </p>
      <p className="truncate text-xs text-neutral-500">{row.department ?? "—"}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
        <span>
          {row.roundCount} round{row.roundCount === 1 ? "" : "s"}
        </span>
        {row.totalDurationMinutes > 0 ? <span>{row.totalDurationMinutes} min total</span> : null}
        {row.templatesUsed.length > 0 ? (
          <span className="truncate">{row.templatesUsed.map(label).join(", ")}</span>
        ) : null}
      </div>
    </button>
  );
}

function PanelDetail({ requisitionId }: { requisitionId: string }) {
  const plan = trpc.getPanelSetup.useQuery(
    { requisitionId },
    { refetchOnWindowFocus: false, staleTime: 5_000 },
  );

  return (
    <div className="space-y-6">
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">
              {plan.data?.title ?? "Interview pipeline"}
            </h2>
            <p className="text-xs text-neutral-500">
              {plan.data && plan.data.rounds.length > 0
                ? `${plan.data.rounds.length} round${plan.data.rounds.length === 1 ? "" : "s"} · ${plan.data.totalDurationMinutes} min total`
                : "No rounds defined yet"}
            </p>
          </div>
          {plan.data ? <Badge tone="neutral">{label(plan.data.status)}</Badge> : null}
        </div>
        {plan.isLoading ? (
          <p className="text-sm text-neutral-500">Loading pipeline…</p>
        ) : plan.data && plan.data.rounds.length > 0 ? (
          <Pipeline rounds={plan.data.rounds} />
        ) : (
          <p className="text-sm text-neutral-500">
            Add rounds below to define the interview loop for this role.
          </p>
        )}
        <p className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
          Default panellists shown here are advisory. Actual panel members are assigned per round at
          scheduling —{" "}
          <a href="/interviews" className="font-medium text-brand-700 hover:underline">
            go to Interviews
          </a>
          .
        </p>
      </Card>

      {/* The existing plan editor, embedded as-is (props-level reuse). */}
      <InterviewPlanSection requisitionId={requisitionId} canManage />
    </div>
  );
}

const MODE_ICON: Record<string, React.ReactNode> = {
  video: <VideoIcon />,
  onsite: <BuildingIcon />,
  phone: <PhoneIcon />,
};

function Pipeline({ rounds }: { rounds: GetPanelSetupOutput["rounds"] }) {
  return (
    <div className="overflow-x-auto">
      <ol className="flex min-w-max items-stretch gap-0">
        {rounds.map((r, i) => (
          <li key={r.roundNumber} className="flex items-stretch">
            <div className="flex w-48 flex-col">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-semibold text-white">
                  {r.roundNumber}
                </span>
                <span className="text-neutral-400">{MODE_ICON[r.mode] ?? null}</span>
              </div>
              <div className="mt-2 pr-4">
                <p className="text-sm font-medium text-neutral-900">{r.roundName}</p>
                <p className="text-xs text-neutral-500">
                  {r.durationMinutes} min · {label(r.mode)} · {label(r.scorecardTemplate)}
                </p>
                {r.defaultPanelists.length > 0 ? (
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Default: {r.defaultPanelists.join(", ")}
                  </p>
                ) : (
                  <p className="mt-1 text-[11px] text-neutral-400">Panel assigned at scheduling</p>
                )}
              </div>
            </div>
            {i < rounds.length - 1 ? (
              <div className="flex items-center px-1 pt-3" aria-hidden>
                <div className="h-0.5 w-6 rounded-full bg-neutral-300" />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function VideoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 10l6-3v10l-6-3" />
    </svg>
  );
}
function BuildingIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" />
    </svg>
  );
}
function PhoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2" />
    </svg>
  );
}
