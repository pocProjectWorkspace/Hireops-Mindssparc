"use client";

import { trpc } from "@/lib/trpc-client";
import { Card, StatTile, TableShell, Thead, Th, Tbody, Tr, Td, EmptyState } from "@/components/ui";
import { PageHeader } from "@/components/patterns";
import type { GetApprovalTrackerOutput } from "@hireops/api-types";
import { WaitingChip, formatReqDate } from "./shared";
import { RevisionSuggestionsCard } from "./RevisionSuggestionsCard";

/**
 * ApprovalTracker (RO-01) — the requirement-owner Approval Tracker. Pending /
 * approved / rejected stats, a pending-approval SLA card (breach accent), the
 * full approval history with elapsed SLA + the HR-head decision reason, and AI
 * revision suggestions for each rejected requisition. All rows are real.
 */

const OUTCOME_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-status-warning-50 text-status-warning-800" },
  approved: { label: "Approved", cls: "bg-status-positive-50 text-status-positive-700" },
  rejected: { label: "Rejected", cls: "bg-status-error-50 text-status-error-700" },
  sent_back: { label: "Sent back", cls: "bg-status-info-50 text-status-info-700" },
  cancelled: { label: "Cancelled", cls: "bg-neutral-100 text-neutral-600" },
  expired: { label: "Expired", cls: "bg-neutral-100 text-neutral-600" },
};

function OutcomeChip({ outcome }: { outcome: string }) {
  const m = OUTCOME_META[outcome] ?? { label: outcome, cls: "bg-neutral-100 text-neutral-600" };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function fmtElapsed(hours: number | null): string {
  if (hours == null) return "—";
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h`;
}

export function ApprovalTracker({
  initial,
  displayName,
}: {
  initial: GetApprovalTrackerOutput;
  displayName: string;
}) {
  const query = trpc.getApprovalTracker.useQuery(undefined, { initialData: initial });
  const data = query.data ?? initial;

  const rejectedReqIds = data.history
    .filter((h) => h.outcome === "rejected")
    .map((h) => h.requisitionId);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-6">
      <PageHeader
        title="Approval tracker"
        subtitle={`Where ${displayName === "there" ? "your" : `${displayName}'s`} requisitions stand in the approval spine.`}
      />

      {/* Stats. */}
      <div className="grid grid-cols-3 gap-4">
        <StatTile label="Pending" value={data.stats.pending} tone="warning" />
        <StatTile label="Approved" value={data.stats.approved} tone="positive" />
        <StatTile label="Rejected" value={data.stats.rejected} tone="error" />
      </div>

      {/* Pending SLA card. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Pending — waiting time</h2>
        {data.pending.length === 0 ? (
          <Card>
            <p className="text-sm text-neutral-500">Nothing is awaiting an HR-head decision.</p>
          </Card>
        ) : (
          <Card padded={false}>
            <div className="divide-y divide-neutral-100">
              {data.pending.map((p) => (
                <div
                  key={p.approvalRequestId}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                >
                  <div className="min-w-0">
                    <a
                      href={`/requisitions/${p.requisitionId}`}
                      className="truncate text-sm font-medium text-neutral-900 hover:text-brand-700 hover:underline"
                    >
                      {p.title ?? "Untitled requisition"}
                    </a>
                    <p className="text-xs text-neutral-500">
                      Submitted {formatReqDate(p.submittedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <WaitingChip hours={p.hoursWaiting} breach={p.breach} />
                    <span className="text-[11px] text-neutral-400">
                      SLA {Math.round(p.slaHours / 24)}d
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </section>

      {/* History table. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-neutral-900">Approval history</h2>
        {data.history.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              title="No approvals yet"
              hint="Once you submit a requisition for approval, its history appears here."
            />
          </Card>
        ) : (
          <TableShell>
            <Thead>
              <Th>Requisition</Th>
              <Th>Dept</Th>
              <Th>Outcome</Th>
              <Th>Submitted</Th>
              <Th>Decided</Th>
              <Th>SLA elapsed</Th>
              <Th>Reason</Th>
            </Thead>
            <Tbody>
              {data.history.map((h) => (
                <Tr key={h.approvalRequestId}>
                  <Td className="font-medium text-neutral-900">
                    <a
                      href={`/requisitions/${h.requisitionId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {h.title ?? "Untitled"}
                    </a>
                  </Td>
                  <Td>{h.department ?? "—"}</Td>
                  <Td>
                    <OutcomeChip outcome={h.outcome} />
                  </Td>
                  <Td>{formatReqDate(h.submittedAt)}</Td>
                  <Td>{h.decidedAt ? formatReqDate(h.decidedAt) : "—"}</Td>
                  <Td>
                    <span
                      className={
                        h.breach ? "font-medium text-status-error-700" : "text-neutral-700"
                      }
                    >
                      {fmtElapsed(h.slaElapsedHours)}
                    </span>
                  </Td>
                  <Td className="max-w-xs">
                    <span className="line-clamp-2 text-xs text-neutral-600">
                      {h.decisionReason ?? "—"}
                    </span>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </TableShell>
        )}
      </section>

      {/* Revision suggestions for rejected reqs. */}
      {rejectedReqIds.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">
            Rejected requisitions — revision help
          </h2>
          <div className="flex flex-col gap-4">
            {rejectedReqIds.map((id) => (
              <RevisionSuggestionsCard key={id} requisitionId={id} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
