import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  date,
  timestamp,
  uniqueIndex,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { businessUnits } from "./business-units";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Approved hiring budget per (business_unit, period).
 *
 * Per requirements.md §5.1: "Annual or quarterly headcount must be approved
 * as a budget envelope **before** requisitions are created against it."
 *
 * Granularity is intentionally coarse — no role_family. Role-level reporting
 * comes from joining requisitions → positions, not from finer envelopes.
 *
 * "Remaining headcount" is not stored; it's computed by counting active
 * requisitions against this envelope (DB-02b adds the FK).
 */
export const headcountEnvelopes = pgTable(
  "headcount_envelopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    plannedHeadcount: integer("planned_headcount").notNull(),
    status: text("status").notNull().default("draft"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_envelope_scope").on(
      table.tenantId,
      table.businessUnitId,
      table.periodStart,
      table.periodEnd,
    ),
    unique("uniq_headcount_envelopes_tenant_id_id").on(table.tenantId, table.id),
    check("envelope_status_check", sql`${table.status} IN ('draft', 'approved', 'closed')`),
    check("envelope_period_check", sql`${table.periodStart} <= ${table.periodEnd}`),
    check("envelope_planned_check", sql`${table.plannedHeadcount} > 0`),
    foreignKey({
      columns: [table.tenantId, table.businessUnitId],
      foreignColumns: [businessUnits.tenantId, businessUnits.id],
      name: "fk_headcount_envelopes_business_unit",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.approvedBy],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_headcount_envelopes_approved_by",
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

export type HeadcountEnvelope = typeof headcountEnvelopes.$inferSelect;
export type NewHeadcountEnvelope = typeof headcountEnvelopes.$inferInsert;
