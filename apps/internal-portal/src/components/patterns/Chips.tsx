import { cn } from "@/components/ui/cn";
import type {
  RequisitionApprovalPriority,
  RequisitionApprovalOutcome,
  InterviewRecommendation,
  HrRoundRecommendation,
  HrCaseStage,
} from "@hireops/api-types";

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

/**
 * HROPS-01 additive chips.
 *
 *   RecommendationChip — the single interview-recommendation vocabulary
 *     (strong_yes | yes | hold | no). Rendered inline per round on the HR cases
 *     table and on the interview-feedback cards. `round` prefixes it "R1: …".
 *   HrRecChip          — the HR-round assessment recommendation
 *     (proceed | hold | reject) — the deterministic gate signal.
 *   StageChip          — the HR-case stage (tech interview → accepted).
 */
const REC_META: Record<InterviewRecommendation, { label: string; cls: string }> = {
  strong_yes: { label: "Strong yes", cls: "bg-status-positive-50 text-status-positive-700" },
  yes: { label: "Yes", cls: "bg-status-info-50 text-status-info-800" },
  hold: { label: "Hold", cls: "bg-status-warning-50 text-status-warning-800" },
  no: { label: "No", cls: "bg-status-error-50 text-status-error-700" },
};

export function RecommendationChip({
  recommendation,
  round,
  className,
}: {
  recommendation: InterviewRecommendation | null;
  /** Optional round number → renders "R2: Strong yes". */
  round?: number;
  className?: string;
}) {
  const prefix = round != null ? `R${round}: ` : "";
  if (!recommendation) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500",
          className,
        )}
      >
        {prefix}Awaiting
      </span>
    );
  }
  const meta = REC_META[recommendation];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        meta.cls,
        className,
      )}
    >
      {prefix}
      {meta.label}
    </span>
  );
}

const HR_REC_META: Record<HrRoundRecommendation, { label: string; cls: string }> = {
  proceed: { label: "Proceed", cls: "bg-status-positive-50 text-status-positive-700" },
  hold: { label: "Hold", cls: "bg-status-warning-50 text-status-warning-800" },
  reject: { label: "Reject", cls: "bg-status-error-50 text-status-error-700" },
};

export function HrRecChip({
  recommendation,
  className,
}: {
  recommendation: HrRoundRecommendation;
  className?: string;
}) {
  const meta = HR_REC_META[recommendation];
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

const STAGE_META: Record<HrCaseStage, { label: string; cls: string }> = {
  tech_interview: { label: "Tech interview", cls: "bg-status-info-50 text-status-info-800" },
  hr_round: { label: "HR round", cls: "bg-brand-50 text-brand-700" },
  offer_drafted: { label: "Offer stage", cls: "bg-status-warning-50 text-status-warning-800" },
  offer_accepted: { label: "Accepted", cls: "bg-status-positive-50 text-status-positive-700" },
};

export function StageChip({ stage, className }: { stage: HrCaseStage; className?: string }) {
  const meta = STAGE_META[stage];
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
