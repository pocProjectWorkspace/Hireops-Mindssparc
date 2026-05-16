import { pgEnum } from "drizzle-orm/pg-core";

/**
 * partner_assignments.status. Lets us pause a partner without ending the
 * assignment (their inflight submissions don't vanish) and end a partner
 * fully (e.g. assignment ran its course).
 */
export const partnerAssignmentStatusEnum = pgEnum("partner_assignment_status", [
  "active",
  "paused",
  "ended",
]);
export type PartnerAssignmentStatus = (typeof partnerAssignmentStatusEnum.enumValues)[number];
