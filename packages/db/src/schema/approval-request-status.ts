import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Lifecycle status of an approval request.
 *
 *  - pending    — default; one or more steps still need a decision
 *  - approved   — terminal: every required step reached an approval
 *  - rejected   — terminal: an approver rejected, chain stopped
 *  - cancelled  — terminal: requester withdrew before completion
 *  - expired    — terminal: chain hit its expires_at without resolution
 *
 * Only `pending` is non-terminal. The partial unique index on
 * (tenant_id, subject_type, subject_id) WHERE status = 'pending'
 * enforces "one open approval per subject"; raising a fresh request
 * against the same subject is fine once the prior one moved to any
 * terminal state.
 */
export const approvalRequestStatusEnum = pgEnum("approval_request_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "expired",
]);

export type ApprovalRequestStatus = (typeof approvalRequestStatusEnum.enumValues)[number];
