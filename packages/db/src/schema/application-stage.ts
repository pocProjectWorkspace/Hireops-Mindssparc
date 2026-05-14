import { pgEnum } from "drizzle-orm/pg-core";

/**
 * 11 canonical lifecycle stages for an application. Aligned with the
 * recruitment portion of the state machine in requirements.md §4 plus
 * the triage flow in §5.3a and three terminal outcomes.
 *
 * Ordering reflects the typical forward progression for documentation
 * purposes; Postgres does not enforce ordering on enums and the state
 * machine is enforced at the application layer, not the DB.
 *
 *  1. application_received  — new submission, default for INSERT
 *  2. ai_screening          — AI scoring + knockout evaluation in flight
 *  3. recruiter_review      — AI done, awaiting recruiter triage decision
 *                             (§5.3a — 24-working-hour SLA clock runs here)
 *  4. shortlisted           — recruiter triage accepted into pipeline
 *  5. tech_interview        — technical interview stage
 *  6. hr_round              — HR / behavioural round
 *  7. offer_drafted         — offer prepared, pending approval / extension
 *  8. offer_accepted        — candidate signed; hands off to onboarding
 *  9. offer_declined        — terminal: candidate declined the offer
 * 10. withdrawn             — terminal: candidate-initiated withdrawal
 * 11. recruiter_rejected    — terminal: triage rejection or any-stage reject
 *
 * Terminal stages 9–11 lock the application out of further pipeline
 * advancement at the app layer. The DB just stores the value.
 */
export const applicationStageEnum = pgEnum("application_stage", [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
]);

export type ApplicationStage = (typeof applicationStageEnum.enumValues)[number];
