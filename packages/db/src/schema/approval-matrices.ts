import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { approvalSubjectTypeEnum } from "./approval-subject-type";

/**
 * Per-tenant, per-subject-type approval matrix. Time-bounded via
 * effective_from / effective_to. rules is opaque jsonb: the rules engine
 * owns the shape (grade × cost × org-level conditions per requirements
 * §170 / §902).
 *
 * NO DB-level exclusion constraint on overlapping effective windows.
 * Two reasons:
 *   (a) overlapping matrices may be a real configuration mistake we
 *       want to surface in admin UI rather than block at the DB
 *   (b) EXCLUDE USING gist on (effective_from, effective_to) is
 *       expensive; the rules engine already needs to pick one matrix
 *       when several overlap and the admin UI is the right place to
 *       warn humans about the ambiguity.
 *
 * RLS: standard tenant_isolation. Trigger: audit_record_change() fires.
 */
export const approvalMatrices = pgTable(
  "approval_matrices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    subjectType: approvalSubjectTypeEnum("subject_type").notNull(),
    name: text("name").notNull(),
    rules: jsonb("rules").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_approval_matrices_tenant_id_id").on(table.tenantId, table.id),
    // Primary lookup: "what's the active matrix for this subject_type
    // right now". effective_from descending so newest-first; effective_to
    // tail for range overlap pruning at app layer.
    index("idx_approval_matrices_active_lookup").on(
      table.tenantId,
      table.subjectType,
      table.effectiveFrom,
      table.effectiveTo,
    ),
    foreignKey({
      columns: [table.tenantId, table.createdByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_approval_matrices_created_by",
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

export type ApprovalMatrix = typeof approvalMatrices.$inferSelect;
export type NewApprovalMatrix = typeof approvalMatrices.$inferInsert;
