"use client";

import type { PendingApprovalItem } from "@hireops/api-types";
import { Badge, cn } from "@/components/ui";
import { candidateLabel, formatCostMicros, timeAgo } from "@/lib/approval-format";

/**
 * One row in the approval queue list. Terse by design — the full draft lives
 * in the detail panel; the card carries just enough to choose what to open:
 * which agent (accent Badge), about which candidate, the proposed action, how
 * long it has waited, and the run cost so far. Selected rows get a brand rule
 * + wash.
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
      aria-pressed={selected}
      className={cn(
        "w-full border-l-2 px-4 py-3.5 text-left transition-colors",
        "focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-brand-500",
        selected ? "border-brand-600 bg-brand-50" : "border-transparent hover:bg-neutral-50",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone="accent" className="max-w-[70%] truncate">
          {item.agentName}
        </Badge>
        <span className="shrink-0 text-xs tabular-nums text-neutral-400">
          {timeAgo(item.proposedAt)}
        </span>
      </div>
      <p className="mt-2 truncate text-sm font-semibold text-neutral-900">{who ?? "Candidate"}</p>
      <p className="mt-0.5 truncate text-sm text-neutral-600">{item.proposedActionSummary}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-xs tabular-nums text-neutral-400">
          {formatCostMicros(item.costMicrosSoFar)}
        </span>
        {snoozed ? <Badge tone="warning">Snoozed</Badge> : null}
      </div>
    </button>
  );
}
