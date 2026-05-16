import { pgEnum } from "drizzle-orm/pg-core";

/**
 * candidate_dedup_attempts.decision.
 *
 * - allow_new:           no existing person matched; create fresh
 * - link_existing:       matched existing person; reuse it
 * - block_active_claim:  existing active ownership claim by another partner
 * - block_in_pipeline:   candidate already in active recruitment
 *                        (per partner doc rule, requirements.md §6.4)
 */
export const dedupDecisionEnum = pgEnum("dedup_decision", [
  "allow_new",
  "link_existing",
  "block_active_claim",
  "block_in_pipeline",
]);
export type DedupDecision = (typeof dedupDecisionEnum.enumValues)[number];
