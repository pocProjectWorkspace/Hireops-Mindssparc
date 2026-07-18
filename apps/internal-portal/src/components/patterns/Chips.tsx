import { cn } from "@/components/ui/cn";
import type { RequisitionApprovalPriority, RequisitionApprovalOutcome } from "@hireops/api-types";

/**
 * Chip refinements (HRHEAD-01 shared pattern). Two small pills tuned to the
 * prototype's feel under OUR slate+indigo tokens:
 *
 *   PriorityChip — lowercase, soft-tinted high / medium / low.
 *   OutcomeChip  — the approval outcome (pending / approved / sent back / …),
 *                  consistent with the prototype's status-pill feel.
 *
 * Both are text-only tinted grounds (no borders) so a row of them reads as
 * quiet metadata, not a stack of buttons.
 */

const PRIORITY_STYLES: Record<RequisitionApprovalPriority, string> = {
  high: "bg-status-error-50 text-status-error-700",
  medium: "bg-status-warning-50 text-status-warning-800",
  low: "bg-neutral-100 text-neutral-600",
};

export function PriorityChip({
  priority,
  className,
}: {
  priority: RequisitionApprovalPriority;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium lowercase tracking-wide",
        PRIORITY_STYLES[priority],
        className,
      )}
    >
      {priority}
    </span>
  );
}

const OUTCOME_META: Record<RequisitionApprovalOutcome, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-status-warning-50 text-status-warning-800" },
  approved: { label: "Approved", cls: "bg-status-positive-50 text-status-positive-700" },
  sent_back: { label: "Sent back", cls: "bg-status-info-50 text-status-info-800" },
  rejected: { label: "Rejected", cls: "bg-status-error-50 text-status-error-700" },
  expired: { label: "Expired", cls: "bg-neutral-100 text-neutral-600" },
};

export function OutcomeChip({
  outcome,
  className,
}: {
  outcome: RequisitionApprovalOutcome;
  className?: string;
}) {
  const meta = OUTCOME_META[outcome];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        meta.cls,
        className,
      )}
    >
      {meta.label}
    </span>
  );
}
