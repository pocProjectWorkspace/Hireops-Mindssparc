import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  integer,
  text,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { approvalRequests } from "./approval-requests";
import { approvalDecisionOutcomeEnum } from "./approval-decision-outcome";

/**
 * Append-only log of approver actions. One row per (request, step,
 * approver) decision. Same enforcement shape as application_state_
 * transitions / requisition_state_transitions: split RLS policies and
 * no UPDATE/DELETE policy under FORCE.
 *
 * Exactly one of approver_membership_id / approver_external_ref must
 * be set (CHECK constraint). External approvers are how Workday-side
 * approvals land in HireOps — the Workday approval id arrives via
 * webhook and is stored as a free-text ref.
 *
 * NOT audited by audit_record_change() — this table IS the audit trail
 * for the approval chain's progression. Same exclusion as the other
 * state-transition tables.
 */
export const approvalDecisions = pgTable(
  "approval_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    outcome: approvalDecisionOutcomeEnum("outcome").notNull(),
    approverMembershipId: uuid("approver_membership_id"),
    approverExternalRef: text("approver_external_ref"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    comment: text("comment"),
    metadata: jsonb("metadata"),
  },
  (table) => [
    unique("uniq_approval_decisions_tenant_id_id").on(table.tenantId, table.id),
    // Exactly one of the two approver fields must be set.
    check(
      "approval_decisions_approver_xor_check",
      sql`(approver_membership_id IS NOT NULL AND approver_external_ref IS NULL)
        OR (approver_membership_id IS NULL AND approver_external_ref IS NOT NULL)`,
    ),
    // Primary access: every decision recorded against a request, ordered
    // by step then time.
    index("idx_approval_decisions_request").on(
      table.tenantId,
      table.requestId,
      table.stepIndex,
      table.decidedAt,
    ),
    // "What have I approved recently" — partial because external
    // approvers don't have a membership id.
    index("idx_approval_decisions_by_approver")
      .on(table.tenantId, table.approverMembershipId, table.decidedAt)
      .where(sql`approver_membership_id IS NOT NULL`),
    foreignKey({
      columns: [table.tenantId, table.requestId],
      foreignColumns: [approvalRequests.tenantId, approvalRequests.id],
      name: "fk_approval_decisions_request",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.approverMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_approval_decisions_approver",
    }).onDelete("set null"),
    pgPolicy("tenant_isolation_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
    // No UPDATE / DELETE policies — append-only under FORCE RLS.
  ],
).enableRLS();

export type ApprovalDecision = typeof approvalDecisions.$inferSelect;
export type NewApprovalDecision = typeof approvalDecisions.$inferInsert;
