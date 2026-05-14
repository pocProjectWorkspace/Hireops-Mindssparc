import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  timestamp,
  char,
  uniqueIndex,
  index,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { businessUnits } from "./business-units";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { locationTypeEnum } from "./location-type";

/**
 * Canonical role slot. One row per slot-in-the-org-chart.
 *
 * Per requirements.md §5.1 and architecture.md §5.1: position ≠ requisition.
 * Position is the Workday-mirrored org-chart slot. Requisition (DB-02b) is
 * active hiring against this slot.
 *
 * Comp lives here, not on jd_versions — comp is a property of the role, not
 * of the description. JD edits don't trigger comp re-review.
 *
 * Soft retirement via is_active + retired_at — a replacement position can
 * share the same title in the same BU once the old one is retired (enforced
 * by the partial unique index).
 */
export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id")
      .notNull()
      .references(() => businessUnits.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    level: text("level"),
    // Field renamed to jobFunction in TS (the SQL column is still `function`)
    // because `function` is a reserved word in some toolchains and pattern
    // matchers — avoiding it as a property name is cheaper than discovering
    // an edge case later.
    jobFunction: text("function"),
    locationType: locationTypeEnum("location_type").notNull().default("onsite"),
    primaryLocation: text("primary_location"),
    compBandMin: numeric("comp_band_min", { precision: 12, scale: 2 }),
    compBandMax: numeric("comp_band_max", { precision: 12, scale: 2 }),
    compCurrency: char("comp_currency", { length: 3 }),
    hiringManagerId: uuid("hiring_manager_id").references(() => tenantUserMemberships.id, {
      onDelete: "set null",
    }),
    workdayPositionWid: text("workday_position_wid"),
    isActive: boolean("is_active").notNull().default(true),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => tenantUserMemberships.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Active positions in the same BU can't share a title; retired ones are exempt.
    uniqueIndex("idx_positions_active_title")
      .on(table.tenantId, table.businessUnitId, table.title)
      .where(sql`is_active = true`),
    // Query path: positions in a BU.
    index("idx_positions_bu").on(table.tenantId, table.businessUnitId),
    check(
      "positions_comp_range_check",
      sql`(${table.compBandMin} IS NULL OR ${table.compBandMax} IS NULL OR ${table.compBandMin} <= ${table.compBandMax})`,
    ),
    check(
      "positions_retired_coherence_check",
      sql`(${table.isActive} = true AND ${table.retiredAt} IS NULL) OR (${table.isActive} = false AND ${table.retiredAt} IS NOT NULL)`,
    ),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
