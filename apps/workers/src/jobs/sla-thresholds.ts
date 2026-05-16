/**
 * Per-stage SLA thresholds in hours. Mirror of
 * apps/api/src/lib/sla-thresholds.ts — duplicated so the worker doesn't
 * take a cross-app import dependency on @hireops/api.
 *
 * KEEP IN SYNC. If thresholds move (Phase 3 will likely turn these
 * into a per-tenant DB-stored config), update BOTH places at once.
 *
 * Reason for the duplication-over-shared-package call: a single 11-entry
 * map isn't enough surface area to justify a third package; an explicit
 * "keep in sync" reality is cheap and visible.
 */

import type { ApplicationStage } from "@hireops/db";

export const SLA_THRESHOLDS_HOURS: Record<ApplicationStage, number | null> = {
  application_received: 24,
  ai_screening: 1,
  recruiter_review: 48,
  shortlisted: 24,
  tech_interview: 72,
  hr_round: 48,
  offer_drafted: 24,
  offer_accepted: null,
  offer_declined: null,
  withdrawn: null,
  recruiter_rejected: null,
};
