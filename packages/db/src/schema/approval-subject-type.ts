import { pgEnum } from "drizzle-orm/pg-core";

/**
 * The things that can require an approval chain in Wave 1.
 *
 * Each value points at a source table; the approval_requests row stores
 * the subject_id as an opaque uuid, intentionally NOT FK-enforced — the
 * chain may outlive the subject row, or the subject may live in a
 * future table we haven't built yet.
 *
 *  - headcount_envelope — annual/quarterly budget envelope per §168
 *  - requisition        — requisition approval before posting (§170)
 *  - jd_version         — JD approval (§5.2 / §170)
 *  - offer              — offer approval before extension (§243)
 *
 * Termination approvals (§469) and BGV / SOW approvals are deferred:
 * Wave 2 work per §11.
 */
export const approvalSubjectTypeEnum = pgEnum("approval_subject_type", [
  "headcount_envelope",
  "requisition",
  "jd_version",
  "offer",
]);

export type ApprovalSubjectType = (typeof approvalSubjectTypeEnum.enumValues)[number];
