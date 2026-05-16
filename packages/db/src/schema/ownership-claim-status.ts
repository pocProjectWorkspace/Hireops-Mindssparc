import { pgEnum } from "drizzle-orm/pg-core";

/**
 * candidate_ownership_claims.status.
 *
 * Denormalised alongside expires_at. The partial-unique index
 * (one_active_claim_per_person) uses `expires_at > now()` not status; a
 * background sweep reconciles rows where `now() > expires_at AND status =
 * 'active'`. Readers MAY rely on status for display but the partial
 * unique is the source of truth.
 *
 * - active:     within the 6-month window
 * - released:   partner voluntarily released early
 * - expired:    time window passed (sweep marks)
 * - superseded: replaced by a newer claim after release (the new claim
 *               links back via superseded_by_claim_id)
 */
export const ownershipClaimStatusEnum = pgEnum("ownership_claim_status", [
  "active",
  "released",
  "expired",
  "superseded",
]);
export type OwnershipClaimStatus = (typeof ownershipClaimStatusEnum.enumValues)[number];
