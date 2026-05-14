import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Outcome a single approver records against a single chain step.
 *
 *  - approved  — step passes
 *  - rejected  — step fails; chain typically stops (app-layer rule)
 *  - abstained — approver explicitly declines to act without rejecting
 *                (e.g. recusal). The chain treats abstention as a no-op
 *                for that step and moves on per chain rules — exact
 *                interpretation is an app concern. Schema captures the
 *                fact.
 *
 * approval_decisions is append-only: rows are inserted, never updated
 * or deleted under FORCE RLS.
 */
export const approvalDecisionOutcomeEnum = pgEnum("approval_decision_outcome", [
  "approved",
  "rejected",
  "abstained",
]);

export type ApprovalDecisionOutcome = (typeof approvalDecisionOutcomeEnum.enumValues)[number];
