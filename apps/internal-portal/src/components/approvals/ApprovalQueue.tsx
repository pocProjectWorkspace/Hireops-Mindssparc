"use client";

import type { ListPendingApprovalsOutput } from "@hireops/api-types";
import { trpc } from "@/lib/trpc-client";
import { useApprovalSelection } from "@/lib/use-approval-selection";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalDetailPanel } from "./ApprovalDetailPanel";

/**
 * Master-detail approval queue.
 *
 * Left: the pending list, seeded from the server render (`initial`) and
 * kept live by a React Query fetch so a resolution elsewhere (or the
 * detail panel's own invalidate) reflows the list. Right: the detail +
 * decision panel for `?approvalId=`.
 *
 * When the selected item resolves, the panel calls onResolved → we clear
 * the selection; the invalidate it already fired drops the row from the
 * list. Selecting nothing (or a now-gone id) shows the empty/prompt state.
 */
export function ApprovalQueue({ initial }: { initial: ListPendingApprovalsOutput }) {
  const { selectedId, select, clear } = useApprovalSelection();

  const query = trpc.listPendingApprovals.useQuery(
    { limit: 50 },
    { initialData: initial, staleTime: 5_000, refetchOnWindowFocus: true },
  );

  const items = query.data?.items ?? [];
  const selectedStillPresent = selectedId && items.some((i) => i.id === selectedId);

  return (
    <div className="flex min-h-0 flex-1">
      {/* List */}
      <aside className="flex w-[380px] shrink-0 flex-col border-r border-neutral-200">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Pending
          </span>
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
            {items.length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-neutral-500">
              ✓ Nothing waiting on you
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {items.map((item) => (
                <li key={item.id}>
                  <ApprovalCard item={item} selected={item.id === selectedId} onSelect={select} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Detail */}
      <section className="min-h-0 flex-1">
        {selectedStillPresent ? (
          <ApprovalDetailPanel approvalId={selectedId} onResolved={clear} />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-neutral-400">
            {items.length === 0
              ? "No pending approvals. Agent actions that need a human land here."
              : "Select an item to review the drafted action."}
          </div>
        )}
      </section>
    </div>
  );
}
