import { cn } from "@/components/ui/cn";
import type { CompVerdict, OfferApprovalStatus } from "@hireops/api-types";

/**
 * Comp desk chips (HROPS-02) — the verdict + offer-status + approval-status
 * pills, tuned to the slate+indigo tokens like the HRHEAD-01 Chips. Text-only
 * tinted grounds so a row reads as quiet metadata.
 */

const VERDICT_META: Record<CompVerdict, { label: string; cls: string }> = {
  proceed: { label: "Proceed", cls: "bg-status-positive-50 text-status-positive-700" },
  negotiate: { label: "Negotiate", cls: "bg-status-warning-50 text-status-warning-800" },
  need_approval: { label: "Need approval", cls: "bg-status-error-50 text-status-error-700" },
};

export function VerdictChip({
  verdict,
  className,
}: {
  verdict: CompVerdict | null;
  className?: string;
}) {
  if (verdict == null) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500",
          className,
        )}
      >
        No verdict
      </span>
    );
  }
  const meta = VERDICT_META[verdict];
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

const OFFER_STATUS_NONE = { label: "No offer", cls: "bg-neutral-100 text-neutral-500" };
const OFFER_STATUS_META: Record<string, { label: string; cls: string }> = {
  none: OFFER_STATUS_NONE,
  drafted: { label: "Drafted", cls: "bg-neutral-100 text-neutral-600" },
  extended: { label: "Extended", cls: "bg-status-info-50 text-status-info-800" },
  accepted: { label: "Accepted", cls: "bg-status-positive-50 text-status-positive-700" },
  declined: { label: "Declined", cls: "bg-status-warning-50 text-status-warning-800" },
  expired: { label: "Expired", cls: "bg-status-warning-50 text-status-warning-800" },
  cancelled: { label: "Cancelled", cls: "bg-neutral-100 text-neutral-500" },
};

export function OfferStatusChip({
  status,
  className,
}: {
  status: string | null;
  className?: string;
}) {
  const meta = OFFER_STATUS_META[status ?? "none"] ?? OFFER_STATUS_NONE;
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

const APPROVAL_META: Record<OfferApprovalStatus, { label: string; cls: string }> = {
  not_required: { label: "In band", cls: "bg-neutral-100 text-neutral-500" },
  required: { label: "Approval needed", cls: "bg-status-error-50 text-status-error-700" },
  pending: { label: "Awaiting HR head", cls: "bg-status-warning-50 text-status-warning-800" },
  approved: { label: "Approved", cls: "bg-status-positive-50 text-status-positive-700" },
  rejected: { label: "Rejected", cls: "bg-status-error-50 text-status-error-700" },
};

export function ApprovalStatusChip({
  status,
  className,
}: {
  status: OfferApprovalStatus;
  className?: string;
}) {
  const meta = APPROVAL_META[status];
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
