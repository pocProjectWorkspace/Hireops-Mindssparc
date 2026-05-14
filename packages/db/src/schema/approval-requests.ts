import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { approvalChains } from "./approval-chains";
import { approvalSubjectTypeEnum } from "./approval-subject-type";
import { approvalRequestStatusEnum } from "./approval-request-status";

/**
 * One approval request per thing-needing-approval. subject_type must
 * match the chain's matrix subject_type at insert time (app-layer
 * guarantee, not DB-enforced — the matrix lookup at chain-creation time
 * already ensures alignment).
 *
 * subject_id is an opaque uuid pointer to the source row (requisition,
 * offer, etc). NOT a FK: the chain may outlive the subject row, the
 * subject may live in a table we haven't built yet, and resolving the
 * subject is an app-layer concern keyed by subject_type.
 *
 * "One open approval per subject at a time" is enforced by the partial
 * unique index on (tenant_id, subject_type, subject_id) WHERE
 * status = 'pending'. Once a request moves to any terminal status
 * (approved / rejected / cancelled / expired) a fresh request can be
 * raised against the same subject.
 *
 * RLS: standard tenant_isolation. Trigger: audit_record_change() fires.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    chainId: uuid("chain_id").notNull(),
    subjectType: approvalSubjectTypeEnum("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    status: approvalRequestStatusEnum("status").notNull().default("pending"),
    currentStepIndex: integer("current_step_index").notNull().default(0),
    requestedByMembershipId: uuid("requested_by_membership_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    context: jsonb("context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_approval_requests_tenant_id_id").on(table.tenantId, table.id),
    // Only one pending request per subject at a time. Terminal-status
    // rows are exempt so a fresh request can be raised after rejection
    // or cancellation. Partial-unique pattern same as candidates.
    uniqueIndex("uniq_approval_requests_one_pending_per_subject")
      .on(table.tenantId, table.subjectType, table.subjectId)
      .where(sql`status = 'pending'`),
    // Expiry sweep: scan pending rows with expires_at in the past.
    index("idx_approval_requests_expiry_sweep")
      .on(table.tenantId, table.status, table.expiresAt)
      .where(sql`status = 'pending'`),
    // "My approval requests" view, partial because system-raised rows
    // have a null requester.
    index("idx_approval_requests_by_requester")
      .on(table.tenantId, table.requestedByMembershipId, table.createdAt)
      .where(sql`requested_by_membership_id IS NOT NULL`),
    // Analytics: count by subject_type × status × window.
    index("idx_approval_requests_analytics").on(
      table.tenantId,
      table.subjectType,
      table.status,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.tenantId, table.chainId],
      foreignColumns: [approvalChains.tenantId, approvalChains.id],
      name: "fk_approval_requests_chain",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.requestedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_approval_requests_requested_by",
    }).onDelete("set null"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;
