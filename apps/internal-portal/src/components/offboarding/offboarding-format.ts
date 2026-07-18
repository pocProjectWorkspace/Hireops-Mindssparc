/**
 * Presentation helpers for the offboarding surfaces (OFFBOARD-03). Pure —
 * no DOM, no React — so the status/tone maps, the task grouping, the money
 * formatter and the gated forward-transition logic stay testable and shared
 * between the list, the initiate form and the case-detail view.
 *
 * The transition maps here MIRROR the server guards (ALLOWED_OFFBOARDING_-
 * TRANSITIONS / ALLOWED_SETTLEMENT_TRANSITIONS in apps/api/src/trpc/router.ts).
 * They are client-side affordances only: they decide which action buttons show
 * and which are disabled-with-a-reason. The API re-validates every transition
 * and 400s an illegal one, so drift between the two degrades to "the button
 * 400s", never to an unauthorised state change.
 */
import type {
  AssetReturnStatus,
  FinalSettlementStatus,
  OffboardingCaseStatus,
  OffboardingInitiationType,
  OffboardingTaskStatus,
} from "@hireops/api-types";
import type { BadgeTone } from "@/components/ui";

// ─────────────── case status ───────────────

export const CASE_STATUS_META: Record<OffboardingCaseStatus, { label: string; tone: BadgeTone }> = {
  initiated: { label: "Initiated", tone: "info" },
  notice_period: { label: "Notice period", tone: "accent" },
  clearance: { label: "Clearance", tone: "accent" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/**
 * Legal forward-only case transitions, mirrored from the server guard.
 * completed / cancelled are terminal (no onward actions).
 */
const ALLOWED_CASE_TRANSITIONS: Record<OffboardingCaseStatus, OffboardingCaseStatus[]> = {
  initiated: ["notice_period", "cancelled"],
  notice_period: ["clearance", "cancelled"],
  clearance: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export interface CaseStatusAction {
  /** Target status to send to advanceOffboardingCase. */
  status: OffboardingCaseStatus;
  /** Button label, in the product's voice. */
  label: string;
  /** 'advance' = the forward step (primary); 'cancel' = the abort (guarded). */
  kind: "advance" | "cancel";
  /** True when the server gate for this step is not yet satisfied. */
  disabled: boolean;
  /** Why the step is blocked (rendered under the button). Null when enabled. */
  reason: string | null;
}

/** The gate inputs a case-advance decision needs from the detail payload. */
export interface OffboardingGateState {
  status: OffboardingCaseStatus;
  lastWorkingDay: string | null;
  /** access_revocation task completed. */
  accessRevoked: boolean;
  /** asset_return task completed. */
  assetsReturned: boolean;
  /** settlement approved | paid. */
  settlementReady: boolean;
}

/**
 * The status actions to offer for a case, with the server gates surfaced as
 * honest disabled-state reasons:
 *   → clearance needs a last working day;
 *   → completed needs access revoked + assets returned + settlement approved.
 * Cancel is always offered from a non-terminal state (reason collected in the
 * UI). The forward step is labelled as an action, not the bare enum.
 */
export function caseStatusActions(gate: OffboardingGateState): CaseStatusAction[] {
  const next = ALLOWED_CASE_TRANSITIONS[gate.status] ?? [];
  const actions: CaseStatusAction[] = [];
  for (const target of next) {
    if (target === "cancelled") {
      actions.push({
        status: target,
        label: "Cancel offboarding",
        kind: "cancel",
        disabled: false,
        reason: null,
      });
      continue;
    }
    let disabled = false;
    let reason: string | null = null;
    if (target === "clearance" && !gate.lastWorkingDay) {
      disabled = true;
      reason = "Set the last working day before moving to clearance.";
    }
    if (target === "completed") {
      const missing: string[] = [];
      if (!gate.accessRevoked) missing.push("complete access revocation");
      if (!gate.assetsReturned) missing.push("record asset returns");
      if (!gate.settlementReady) missing.push("approve the final settlement");
      if (missing.length > 0) {
        disabled = true;
        reason = `To complete: ${missing.join(", ")}.`;
      }
    }
    actions.push({
      status: target,
      label: `Advance to ${CASE_STATUS_META[target].label.toLowerCase()}`,
      kind: "advance",
      disabled,
      reason,
    });
  }
  return actions;
}

// ─────────────── initiation type ───────────────

export const INITIATION_TYPE_META: Record<OffboardingInitiationType, { label: string }> = {
  resignation: { label: "Resignation" },
  termination: { label: "Termination" },
  end_of_contract: { label: "End of contract" },
};

export const INITIATION_TYPE_OPTIONS: { value: OffboardingInitiationType; label: string }[] = (
  ["resignation", "termination", "end_of_contract"] as OffboardingInitiationType[]
).map((v) => ({ value: v, label: INITIATION_TYPE_META[v].label }));

// ─────────────── task status ───────────────

export const TASK_STATUS_META: Record<OffboardingTaskStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "To do", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  blocked: { label: "Blocked", tone: "error" },
  completed: { label: "Done", tone: "success" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** A task counts as "resolved" (not outstanding) once it is any of these. */
const RESOLVED_TASK_STATUSES: OffboardingTaskStatus[] = ["completed", "skipped"];

export function isTaskResolved(status: OffboardingTaskStatus): boolean {
  return RESOLVED_TASK_STATUSES.includes(status);
}

// ─────────────── asset-return status ───────────────

export const ASSET_STATUS_META: Record<AssetReturnStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "Awaiting return", tone: "warning" },
  returned: { label: "Returned", tone: "success" },
  written_off: { label: "Written off", tone: "neutral" },
  lost: { label: "Lost", tone: "error" },
};

export const ASSET_STATUS_OPTIONS: { value: AssetReturnStatus; label: string }[] = (
  ["pending", "returned", "written_off", "lost"] as AssetReturnStatus[]
).map((v) => ({ value: v, label: ASSET_STATUS_META[v].label }));

// ─────────────── final-settlement status ───────────────

export const SETTLEMENT_STATUS_META: Record<
  FinalSettlementStatus,
  { label: string; tone: BadgeTone }
> = {
  pending: { label: "Pending", tone: "neutral" },
  calculated: { label: "Calculated", tone: "info" },
  approved: { label: "Approved", tone: "accent" },
  paid: { label: "Paid", tone: "success" },
};

/** Forward-only settlement walk, mirrored from ALLOWED_SETTLEMENT_TRANSITIONS. */
const ALLOWED_SETTLEMENT_TRANSITIONS: Record<FinalSettlementStatus, FinalSettlementStatus[]> = {
  pending: ["calculated"],
  calculated: ["approved"],
  approved: ["paid"],
  paid: [],
};

export interface SettlementAction {
  target: FinalSettlementStatus;
  label: string;
  /** True when the server gate isn't met (→ approved needs access revoked). */
  disabled: boolean;
  reason: string | null;
}

/**
 * The single forward action offered for a settlement in `status`, with the
 * §8.3 gate surfaced: → approved needs the access_revocation task completed.
 * `current` is null when no settlement row exists yet (first touch creates a
 * pending row) — the first offered step is then "calculate".
 */
export function settlementActions(
  status: FinalSettlementStatus | null,
  accessRevoked: boolean,
): SettlementAction[] {
  const from: FinalSettlementStatus = status ?? "pending";
  const next = ALLOWED_SETTLEMENT_TRANSITIONS[from] ?? [];
  return next.map((target) => {
    let disabled = false;
    let reason: string | null = null;
    if (target === "approved" && !accessRevoked) {
      disabled = true;
      reason = "Complete access revocation before approving the settlement.";
    }
    return {
      target,
      label: `Mark ${SETTLEMENT_STATUS_META[target].label.toLowerCase()}`,
      disabled,
      reason,
    };
  });
}

// ─────────────── task grouping ───────────────

export interface TaskGroupDef {
  key: string;
  title: string;
  /** task_type values that belong to this group. */
  types: string[];
}

/**
 * The clearance checklist grouped the way an exit reads: what the departing
 * person hands over (knowledge transfer + manager sign-off), what IT/HR must
 * reclaim (assets + access), then the clearance & settlement gate. Task types
 * are the OFFBOARD-01/02 checklist generator's values (apps/api/src/lib/
 * offboarding-case.ts). Any unmapped type falls into "Other" so a future task
 * type is never silently dropped.
 */
export const TASK_GROUPS: TaskGroupDef[] = [
  {
    key: "knowledge_transfer",
    title: "Knowledge transfer",
    types: ["knowledge_transfer", "manager_signoff"],
  },
  { key: "assets_access", title: "Assets & access", types: ["asset_return", "access_revocation"] },
  {
    key: "clearance",
    title: "Clearance & settlement",
    types: ["final_settlement", "exit_interview", "hr_clearance"],
  },
];

const OTHER_GROUP: TaskGroupDef = { key: "other", title: "Other", types: [] };

/** Resolve the group a task_type belongs to (falling back to "Other"). */
export function groupForTaskType(taskType: string): TaskGroupDef {
  return TASK_GROUPS.find((g) => g.types.includes(taskType)) ?? OTHER_GROUP;
}

// ─────────────── money ───────────────

/**
 * Minor-unit amount (paise/cents) + ISO currency → a localised money string.
 * Null amount → an em dash so the layout never collapses. Uses en-IN so the
 * demo INR amounts group the Indian way (₹12,34,567.00).
 */
export function formatMoney(amountMinor: number | null, currency: string | null): string {
  if (amountMinor == null) return "—";
  const code = (currency ?? "INR").toUpperCase();
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: code }).format(
      amountMinor / 100,
    );
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${code}`;
  }
}

// ─────────────── dates ───────────────

const DATE_FMT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

/**
 * Format a date-only ('YYYY-MM-DD') or ISO-timestamp string to the platform
 * default (dd MMM yyyy, IST). Null / unparseable → an em dash so the layout
 * never collapses.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_FMT.format(d);
}
