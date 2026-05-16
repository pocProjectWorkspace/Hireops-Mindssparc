import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { partnerOrgs } from "./partner-orgs";
import { requisitions } from "./requisitions";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { partnerAssignmentStatusEnum } from "./partner-assignment-status";

/**
 * Which partners work which requisitions.
 *
 * Partial unique on (tenant_id, partner_org_id, requisition_id)
 * WHERE status = 'active' enforces "one active assignment per
 * (partner, req)" while letting historical (ended) assignments coexist.
 * A partner can be assigned, ended, then re-assigned later.
 *
 * RLS: standard single tenant_isolation. Audit trigger attached.
 */
export const partnerAssignments = pgTable(
  "partner_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    partnerOrgId: uuid("partner_org_id").notNull(),
    requisitionId: uuid("requisition_id").notNull(),
    assignedByMembershipId: uuid("assigned_by_membership_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    status: partnerAssignmentStatusEnum("status").notNull().default("active"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (table) => [
    unique("uniq_partner_assignments_tenant_id_id").on(table.tenantId, table.id),
    uniqueIndex("uniq_partner_assignments_active")
      .on(table.tenantId, table.partnerOrgId, table.requisitionId)
      .where(sql`status = 'active'`),
    index("idx_partner_assignments_req_status").on(
      table.tenantId,
      table.requisitionId,
      table.status,
    ),
    index("idx_partner_assignments_partner_status").on(
      table.tenantId,
      table.partnerOrgId,
      table.status,
    ),
    foreignKey({
      columns: [table.tenantId, table.partnerOrgId],
      foreignColumns: [partnerOrgs.tenantId, partnerOrgs.id],
      name: "fk_partner_assignments_partner_org",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_partner_assignments_requisition",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.assignedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_partner_assignments_assigned_by",
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

export type PartnerAssignment = typeof partnerAssignments.$inferSelect;
export type NewPartnerAssignment = typeof partnerAssignments.$inferInsert;
