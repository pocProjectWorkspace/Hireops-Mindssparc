import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { positions } from "./positions";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Versioned JD content per position. Each JD edit creates a new version row.
 *
 * Per requirements.md §5.2: "Versioning per JD". The "current" JD for a
 * position is determined by app logic (most recent approved; or most recent
 * draft if no approved yet).
 *
 * Requisitions (DB-02b) FK to a specific jd_version_id, locking JD content
 * at req-creation time. Subsequent JD edits don't affect active reqs.
 */
export const jdVersions = pgTable(
  "jd_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    positionId: uuid("position_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull().default("draft"),
    jdText: text("jd_text").notNull(),
    summary: text("summary"),
    aiMetadata: jsonb("ai_metadata").notNull().default({}),
    createdBy: uuid("created_by"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_jd_version").on(table.positionId, table.versionNumber),
    unique("uniq_jd_versions_tenant_id_id").on(table.tenantId, table.id),
    check("jd_version_status_check", sql`${table.status} IN ('draft', 'approved', 'archived')`),
    check("jd_version_number_check", sql`${table.versionNumber} >= 1`),
    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [positions.tenantId, positions.id],
      name: "fk_jd_versions_position",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_jd_versions_created_by",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.tenantId, table.approvedBy],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_jd_versions_approved_by",
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

export type JdVersion = typeof jdVersions.$inferSelect;
export type NewJdVersion = typeof jdVersions.$inferInsert;
