"use client";

import type { PendingApprovalItem } from "@hireops/api-types";
import { candidateLabel, timeAgo } from "@/lib/approval-format";

/**
 * One row in the approval queue list. Deliberately terse — the full draft
 * lives in the detail panel; the card is just enough to choose what to
 * open: which agent, about which candidate, and how long it has waited.
 */
export function ApprovalCard({
  item,
  selected,
  onSelect,
}: {
  item: PendingApprovalItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const who = candidateLabel(item.proposedActionPayload);
  const snoozed = item.snoozedUntil !== null;

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={`w-full border-l-2 px-4 py-3 text-left transition-colors ${
        selected ? "border-brand-600 bg-brand-50" : "border-transparent hover:bg-neutral-50"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium text-neutral-900">{item.agentName}</span>
        <span className="shrink-0 text-xs text-neutral-400">{timeAgo(item.proposedAt)}</span>
      </div>
      <div className="mt-0.5 truncate text-sm text-neutral-600">{item.proposedActionSummary}</div>
      <div className="mt-1 flex items-center gap-2">
        {who ? <span className="truncate text-xs text-neutral-500">{who}</span> : null}
        {snoozed ? (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
            snoozed
          </span>
        ) : null}
      </div>
    </button>
  );
}
