/**
 * Presentation helpers for the onboarding surfaces (ONBOARD-03). Pure —
 * no DOM, no React — so the status/tone maps, the task grouping, and the
 * forward-only transition logic stay testable and shared between the list
 * and the case-detail view.
 *
 * The case-status transition map here MIRRORS the server guard
 * (ALLOWED_CASE_TRANSITIONS in apps/api/src/trpc/router.ts). It is a
 * client-side affordance only: it decides which advance/cancel buttons to
 * show. The API re-validates every transition and 400s an illegal one, so a
 * drift between the two maps degrades to "the button 400s", never to an
 * unauthorised state change.
 */
import type { OnboardingCaseStatus, OnboardingTaskStatus } from "@hireops/api-types";
import type { BadgeTone } from "@/components/ui";

// ─────────────── case status ───────────────

export const CASE_STATUS_META: Record<OnboardingCaseStatus, { label: string; tone: BadgeTone }> = {
  pre_boarding: { label: "Pre-boarding", tone: "info" },
  day_zero: { label: "Day zero", tone: "accent" },
  in_progress: { label: "In progress", tone: "accent" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/**
 * Legal forward-only case transitions, mirrored from the server guard.
 * completed / cancelled are terminal (no onward actions).
 */
const ALLOWED_CASE_TRANSITIONS: Record<OnboardingCaseStatus, OnboardingCaseStatus[]> = {
  pre_boarding: ["day_zero", "cancelled"],
  day_zero: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export interface CaseStatusAction {
  /** Target status to send to updateOnboardingCase. */
  status: OnboardingCaseStatus;
  /** Button label, in the product's voice. */
  label: string;
  /** 'advance' = the forward step (primary); 'cancel' = the abort (guarded). */
  kind: "advance" | "cancel";
}

/**
 * The status actions to offer for a case in `status`. The forward step is
 * labelled as an action ("Advance to Day zero"), not the bare enum; cancel
 * is separated so the UI can guard it behind a confirm.
 */
export function caseStatusActions(status: OnboardingCaseStatus): CaseStatusAction[] {
  const next = ALLOWED_CASE_TRANSITIONS[status] ?? [];
  const actions: CaseStatusAction[] = [];
  for (const target of next) {
    if (target === "cancelled") {
      actions.push({ status: target, label: "Cancel onboarding", kind: "cancel" });
    } else {
      actions.push({
        status: target,
        label: `Advance to ${CASE_STATUS_META[target].label}`,
        kind: "advance",
      });
    }
  }
  return actions;
}

// ─────────────── task status ───────────────

export const TASK_STATUS_META: Record<OnboardingTaskStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: "To do", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  blocked: { label: "Blocked", tone: "error" },
  completed: { label: "Done", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  skipped: { label: "Skipped", tone: "neutral" },
};

/** A task counts as "resolved" (not outstanding) once it is any of these. */
const RESOLVED_TASK_STATUSES: OnboardingTaskStatus[] = ["completed", "cancelled", "skipped"];

export function isTaskResolved(status: OnboardingTaskStatus): boolean {
  return RESOLVED_TASK_STATUSES.includes(status);
}

// ─────────────── task grouping ───────────────

export interface TaskGroupDef {
  key: string;
  title: string;
  /** task_type values that belong to this group. */
  types: string[];
}

/**
 * The checklist grouped the way the onboarding lifecycle reads: what the
 * candidate must hand over, what IT stands up, the human touchpoints, then
 * the probation gate. Task types are the ONBOARD-02 checklist generator's
 * values (see apps/api/src/lib/onboarding-case.ts). Any unmapped type falls
 * into "Other" so a future task type is never silently dropped.
 */
export const TASK_GROUPS: TaskGroupDef[] = [
  { key: "documents", title: "Document collection", types: ["document_collection"] },
  { key: "it", title: "IT & assets", types: ["it_provisioning"] },
  {
    key: "people",
    title: "People & check-ins",
    types: ["buddy_assignment", "training", "check_in"],
  },
  { key: "probation", title: "Probation", types: ["probation_review"] },
];

const OTHER_GROUP: TaskGroupDef = { key: "other", title: "Other", types: [] };

/** Resolve the group a task_type belongs to (falling back to "Other"). */
export function groupForTaskType(taskType: string): TaskGroupDef {
  return TASK_GROUPS.find((g) => g.types.includes(taskType)) ?? OTHER_GROUP;
}

// ─────────────── geography ───────────────

const GEOGRAPHY_NAMES: Record<string, string> = {
  IN: "India",
  PH: "Philippines",
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
};

/** "IN" → "India (IN)"; an unknown code shows verbatim. */
export function formatGeography(code: string): string {
  const name = GEOGRAPHY_NAMES[code.toUpperCase()];
  return name ? `${name} (${code.toUpperCase()})` : code.toUpperCase();
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
