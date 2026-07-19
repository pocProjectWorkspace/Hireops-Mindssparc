"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc, handleTRPCError } from "@/lib/trpc-client";
import { Card, EmptyState, TableShell, Thead, Th, Tbody, Tr, Td } from "@/components/ui";
import type { ListMyRequisitionsV2Output } from "@hireops/api-types";
import { HealthBar, DifficultyChip, ReqStatusChip, formatReqDate } from "./shared";

/**
 * RequisitionsListV2 (RO-01) — My Requisitions v2. Search + status filter over
 * the enriched rows (health composite + difficulty per row from the rule
 * engine). Contextual row actions: open; submit-for-approval when the draft is
 * complete; edit. Existing behaviour preserved — rows still link to the detail
 * page.
 */

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "approved", label: "Approved" },
  { value: "posted", label: "Live" },
  { value: "on_hold", label: "On hold" },
  { value: "filled", label: "Filled" },
  { value: "cancelled", label: "Rejected" },
  { value: "closed", label: "Closed" },
];

export function RequisitionsListV2({
  initial,
  initialStatus = "all",
}: {
  initial: ListMyRequisitionsV2Output;
  initialStatus?: string;
}) {
  const router = useRouter();
  const query = trpc.listMyRequisitionsV2.useQuery({ limit: 100 }, { initialData: initial });
  const submit = trpc.submitRequisitionForApproval.useMutation();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const rows = query.data?.rows ?? initial.rows;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (!q) return true;
      return (
        (r.title ?? "").toLowerCase().includes(q) ||
        (r.department ?? "").toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q)
      );
    });
  }, [rows, search, status]);

  async function onSubmit(id: string) {
    setError(null);
    setBusyId(id);
    try {
      await submit.mutateAsync({ requisitionId: id });
      await query.refetch();
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      handleTRPCError(err, { onMessage: () => undefined });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search role, department, or ID…"
          className="h-9 w-full max-w-xs rounded-md border border-neutral-300 px-3 text-sm text-neutral-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <div className="mb-3 rounded-md border border-status-error-200 bg-status-error-50 px-4 py-2 text-sm text-status-error-700">
          {error}
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            title={rows.length === 0 ? "No requisitions yet" : "No matches"}
            hint={
              rows.length === 0
                ? "When you create a requisition it appears here."
                : "Try a different search or status filter."
            }
          />
        </Card>
      ) : (
        <TableShell>
          <Thead>
            <Th>Req ID</Th>
            <Th>Role</Th>
            <Th>Dept</Th>
            <Th>Status</Th>
            <Th>Health</Th>
            <Th>Difficulty</Th>
            <Th>Budget</Th>
            <Th>Created</Th>
            <Th>Actions</Th>
          </Thead>
          <Tbody>
            {filtered.map((r) => (
              <Tr key={r.id}>
                <Td className="font-mono text-xs text-neutral-500">{r.id.slice(0, 8)}</Td>
                <Td className="font-medium text-neutral-900">
                  <a href={`/requisitions/${r.id}`} className="text-brand-700 hover:underline">
                    {r.title ?? "Untitled role"}
                  </a>
                </Td>
                <Td>{r.department ?? "—"}</Td>
                <Td>
                  <ReqStatusChip status={r.status} />
                </Td>
                <Td>
                  <HealthBar health={r.health} compact />
                </Td>
                <Td>
                  <DifficultyChip difficulty={r.difficulty} />
                </Td>
                <Td>{r.budgetBand ?? "—"}</Td>
                <Td>{formatReqDate(r.createdAt)}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <a
                      href={`/requisitions/${r.id}`}
                      className="text-xs font-medium text-brand-700 hover:underline"
                    >
                      Open
                    </a>
                    {r.canSubmit ? (
                      <button
                        type="button"
                        onClick={() => onSubmit(r.id)}
                        disabled={busyId === r.id}
                        className="text-xs font-medium text-status-positive-700 hover:underline disabled:opacity-50"
                      >
                        {busyId === r.id ? "Submitting…" : "Submit"}
                      </button>
                    ) : null}
                  </div>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </TableShell>
      )}
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Something went wrong. Please try again.";
}
