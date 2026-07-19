"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { ListHrRoundsOutput, HrRoundRow } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import {
  TableShell,
  Thead,
  Th,
  Tbody,
  Tr,
  Td,
  EmptyState,
  StatTile,
  Button,
} from "@/components/ui";
import { PageHeader, HeroStatCard, HrRecChip, InboxIcon } from "@/components/patterns";
import { HrRoundAssessmentForm } from "./HrRoundAssessmentForm";

/**
 * HrRoundsView (HROPS-01) — the HR-round scheduler + assessment surface.
 *
 * Hero stats (Total / Scheduled / Completed / Pending), a status filter, and a
 * table of HR-round interviews (+ pending hr_round cases). View opens the case
 * detail; Complete opens the assessment form in a modal (the SAME component the
 * detail HR-round tab uses). Pending rows link to the existing scheduling
 * surface rather than a parallel scheduler.
 */

type StatusTab = "all" | "scheduled" | "completed" | "pending";

const TABS: { key: StatusTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
  { key: "pending", label: "Pending" },
];

const STATUS_META: Record<string, { label: string; cls: string }> = {
  scheduled: { label: "Scheduled", cls: "bg-status-info-50 text-status-info-800" },
  completed: { label: "Completed", cls: "bg-status-positive-50 text-status-positive-700" },
  cancelled: { label: "Cancelled", cls: "bg-neutral-100 text-neutral-500" },
  no_show: { label: "No show", cls: "bg-status-error-50 text-status-error-700" },
  pending: { label: "Pending", cls: "bg-status-warning-50 text-status-warning-800" },
};

function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, cls: "bg-neutral-100 text-neutral-600" };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HrRoundsView({ initial }: { initial: ListHrRoundsOutput }) {
  const router = useRouter();
  const { data } = trpc.listHrRounds.useQuery(undefined, {
    initialData: initial,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const [tab, setTab] = useState<StatusTab>("all");
  const [assessingAppId, setAssessingAppId] = useState<string | null>(null);

  const stats = data.stats;
  const filtered = useMemo(() => {
    return data.rows.filter((r) => {
      if (tab === "all") return true;
      return r.status === tab;
    });
  }, [data.rows, tab]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-8 py-6">
      <PageHeader
        title="HR rounds"
        subtitle="The HR behavioural round across active cases — schedule, complete the assessment, and record the outcome."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <HeroStatCard
          label="Pending"
          value={stats.pending}
          caption="HR round not scheduled"
          icon={<InboxIcon />}
        />
        <StatTile label="Total" value={stats.total} tone="neutral" />
        <StatTile label="Scheduled" value={stats.scheduled} tone="info" />
        <StatTile label="Completed" value={stats.completed} tone="positive" />
      </div>

      <div className="flex flex-wrap gap-1 border-b border-neutral-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "border-brand-600 text-brand-700"
                : "border-transparent text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No HR rounds"
          hint="HR-round interviews for active cases appear here. A case reaching the HR round with no interview scheduled shows as Pending."
        />
      ) : (
        <TableShell>
          <Thead>
            <Th>Candidate</Th>
            <Th>Role</Th>
            <Th>When</Th>
            <Th>Mode</Th>
            <Th>Owner</Th>
            <Th>Status</Th>
            <Th numeric>Rating</Th>
            <Th className="w-40" aria-label="Actions" />
          </Thead>
          <Tbody>
            {filtered.map((r) => (
              <HrRoundRowView
                key={(r.interviewId ?? "pending") + r.applicationId}
                row={r}
                onView={() => router.push(`/hr-cases/${r.applicationId}`)}
                onComplete={() => setAssessingAppId(r.applicationId)}
                onSchedule={() => router.push("/interviews")}
              />
            ))}
          </Tbody>
        </TableShell>
      )}

      {assessingAppId ? (
        <AssessmentModal applicationId={assessingAppId} onClose={() => setAssessingAppId(null)} />
      ) : null}
    </div>
  );
}

function HrRoundRowView({
  row,
  onView,
  onComplete,
  onSchedule,
}: {
  row: HrRoundRow;
  onView: () => void;
  onComplete: () => void;
  onSchedule: () => void;
}) {
  return (
    <Tr>
      <Td className="font-medium text-neutral-900">{row.candidateName ?? "Unknown candidate"}</Td>
      <Td>{row.roleTitle ?? "—"}</Td>
      <Td className="text-neutral-600">{formatWhen(row.scheduledStart)}</Td>
      <Td className="capitalize">{row.mode ?? "—"}</Td>
      <Td>{row.ownerName ?? "—"}</Td>
      <Td>
        <StatusBadge status={row.status} />
      </Td>
      <Td numeric>
        {row.hasAssessment && row.assessmentRecommendation ? (
          <div className="flex items-center justify-end gap-1.5">
            <span className="tabular-nums text-neutral-700">{row.rating}/5</span>
            <HrRecChip recommendation={row.assessmentRecommendation} />
          </div>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </Td>
      <Td>
        <div className="flex items-center justify-end gap-2">
          {row.status === "pending" ? (
            <Button variant="secondary" size="sm" onClick={onSchedule}>
              Schedule
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onView}>
            View
          </Button>
          <Button size="sm" onClick={onComplete}>
            {row.hasAssessment ? "Edit" : "Complete"}
          </Button>
        </div>
      </Td>
    </Tr>
  );
}

function AssessmentModal({
  applicationId,
  onClose,
}: {
  applicationId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = trpc.getHrCaseDetail.useQuery({ applicationId });
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="HR round assessment"
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-card bg-white p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-neutral-900">HR round assessment</h2>
            {data ? (
              <p className="text-sm text-neutral-500">
                {data.candidate.name ?? "Candidate"} · {data.pipeline.roleTitle ?? "—"}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          >
            Close
          </button>
        </div>
        {isLoading || !data ? (
          <p className="py-8 text-center text-sm text-neutral-500">Loading…</p>
        ) : (
          <HrRoundAssessmentForm
            applicationId={applicationId}
            initial={data.assessment}
            onSaved={onClose}
          />
        )}
      </div>
    </div>
  );
}
