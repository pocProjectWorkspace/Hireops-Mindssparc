/**
 * Per-stage SLA thresholds in hours. A candidate is "in breach" if their
 * current stage's elapsed time exceeds the threshold.
 *
 * Hardcoded for Wave 1 by design — the ticket calls out that tenant-
 * configurable thresholds (e.g. a `tenant_sla_configurations` table)
 * is Phase 3 work. Keeping it as a TS map means the listCandidates
 * sql can compose a CASE expression off these values without a JOIN.
 *
 * null = stage has no SLA (terminal states like accepted/declined, and
 * the post-decision stages that wait on an external counterparty).
 *
 * Stage names come from the actual application_stage pgEnum
 * (packages/db/src/schema/application-stage.ts). The Module 1b ticket
 * used a few names that don't exist in the DB (recruiter_shortlist /
 * hr_interview / offer_extended); we map to the real enum values and
 * adjust hours to match the ticket's intent.
 */

import type { ApplicationStage } from "@hireops/db";

export const SLA_THRESHOLDS_HOURS: Record<ApplicationStage, number | null> = {
  application_received: 24,
  ai_screening: 1,
  // Ticket said recruiter_shortlist=48h; mapped to the actual
  // recruiter_review stage which sits between AI and shortlisted.
  recruiter_review: 48,
  // Once shortlisted, the SLA clock owns the interview-scheduling
  // window. Hardcoding 24h means recruiters surface scheduling
  // bottlenecks rather than letting candidates sit.
  shortlisted: 24,
  tech_interview: 72,
  // Ticket's hr_interview=48h; mapped to the actual hr_round.
  hr_round: 48,
  // Ticket's offer_drafted=24h.
  offer_drafted: 24,
  // Ticket had offer_extended=168h (waiting for candidate). Our enum
  // jumps directly from drafted → accepted/declined; the "waiting for
  // candidate" state is implicit. No SLA here — the next stage IS the
  // candidate's decision.
  offer_accepted: null,
  offer_declined: null,
  withdrawn: null,
  recruiter_rejected: null,
};

/**
 * Stages with a real (non-null) threshold. Useful for SQL WHERE clauses
 * that only consider breach-eligible rows.
 */
export const SLA_BREACH_STAGES: ApplicationStage[] = (
  Object.entries(SLA_THRESHOLDS_HOURS) as [ApplicationStage, number | null][]
)
  .filter(([, hours]) => hours !== null)
  .map(([stage]) => stage);

/**
 * SQL fragment-friendly: returns the threshold for a stage value, or
 * Infinity when terminal (callers should test `Number.isFinite`).
 */
export function thresholdHoursFor(stage: ApplicationStage): number {
  const t = SLA_THRESHOLDS_HOURS[stage];
  return t === null ? Number.POSITIVE_INFINITY : t;
}
