import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  timestamp,
  uniqueIndex,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { requisitions } from "./requisitions";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Junction for the multi-recruiter case. Sparse — most reqs have only the
 * primary recruiter (FK on requisitions). This table records additional
 * assignees beyond the primary.
 *
 * Cascades from requisitions: when a req is deleted, its extra-recruiter
 * assignments go with it. Audit history of "who was assigned when" is
 * tracked elsewhere (state_transitions / audit_logs) — this table is the
 * live association only.
 */
export const requisitionRecruiters = pgTable(
  "requisition_recruiters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").notNull(),
    recruiterId: uuid("recruiter_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedBy: uuid("assigned_by"),
  },
  (table) => [
    uniqueIndex("idx_req_recruiters_unique").on(table.requisitionId, table.recruiterId),
    unique("uniq_requisition_recruiters_tenant_id_id").on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_requisition_recruiters_requisition",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.recruiterId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_requisition_recruiters_recruiter",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.assignedBy],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_requisition_recruiters_assigned_by",
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

export type RequisitionRecruiter = typeof requisitionRecruiters.$inferSelect;
export type NewRequisitionRecruiter = typeof requisitionRecruiters.$inferInsert;
