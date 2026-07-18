"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { RequisitionApprovalRow, RequisitionApprovalOutcome } from "@hireops/api-types";
import { TableShell, Thead, Th, Tbody, Tr, Td, EmptyState } from "@/components/ui";
import { PriorityChip, OutcomeChip } from "@/components/patterns";

/**
 * RequisitionApprovalsTable (HRHEAD-01) — the full approvals queue table with
 * filter tabs (All / Pending / Approved / Sent back). Each row is the enriched
 * listRequisitionApprovals shape (ref, role, dept, budget, priority, requester,
 * status, age); clicking a row opens the existing decision view on the
 * requisition detail page. Read-only here — decisions happen on the detail
 * surface (and inline on the HR-head dashboard).
 */

type TabKey = "all" | "pending" | "approved" | "sent_back";

const TABS: { key: TabKey; label: string; match: (o: RequisitionApprovalOutcome) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "pending", label: "Pending", match: (o) => o === "pending" },
  { key: "approved", label: "Approved", match: (o) => o === "approved" },
  { key: "sent_back", label: "Sent back", match: (o) => o === "sent_back" },
];

function shortRef(subjectId: string): string {
  return subjectId.slice(0, 8).toUpperCase();
}

export function RequisitionApprovalsTable({ rows }: { rows: RequisitionApprovalRow[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("pending");

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { all: rows.length, pending: 0, approved: 0, sent_back: 0 };
    for (const r of rows) {
      if (r.outcome === "pending") c.pending += 1;
      else if (r.outcome === "approved") c.approved += 1;
      else if (r.outcome === "sent_back") c.sent_back += 1;
    }
    return c;
  }, [rows]);

  const active = TABS.find((t) => t.key === tab) ?? TABS[0]!;
  const filtered = rows.filter((r) => active.match(r.outcome));

  return (
    <div className="space-y-4">
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
            <span className="rounded-full bg-neutral-100 px-1.5 text-[11px] tabular-nums text-neutral-500">
              {counts[t.key]}
            </span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="Nothing here"
          hint="No requisitions match this filter. When a hiring manager submits a requisition it lands in Pending for you to decide."
        />
      ) : (
        <TableShell>
          <Thead>
            <Th>Ref</Th>
            <Th>Role</Th>
            <Th>Dept</Th>
            <Th>Budget</Th>
            <Th>Priority</Th>
            <Th>Requested by</Th>
            <Th>Status</Th>
            <Th numeric>Age</Th>
            <Th className="w-8" aria-label="Open" />
          </Thead>
          <Tbody>
            {filtered.map((r) => (
              <Tr
                key={r.id}
                onClick={() => router.push(`/requisitions/${r.subjectId}`)}
                className="cursor-pointer"
              >
                <Td className="font-mono text-xs text-neutral-500">{shortRef(r.subjectId)}</Td>
                <Td className="font-medium text-neutral-900">
                  {r.title ?? "Untitled requisition"}
                </Td>
                <Td>{r.department ?? "—"}</Td>
                <Td>{r.budgetBand ?? "—"}</Td>
                <Td>
                  <PriorityChip priority={r.priority} />
                </Td>
                <Td>{r.requestedByName ?? "—"}</Td>
                <Td>
                  <OutcomeChip outcome={r.outcome} />
                </Td>
                <Td numeric>{r.ageDays > 0 ? `${r.ageDays}d` : "today"}</Td>
                <Td className="text-neutral-300" aria-hidden>
                  →
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </div>
  );
}
