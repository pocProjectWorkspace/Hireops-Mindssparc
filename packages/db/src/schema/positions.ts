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
  unique,
  index,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { businessUnits } from "./business-units";
import { compBands } from "./comp-bands";
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
    businessUnitId: uuid("business_unit_id").notNull(),
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
    // T3.2 / G15 — provenance: the comp-band this position's comp values were
    // populated from (nullable; free-typed / seed positions carry no band). The
    // band's min/max/currency are COPIED onto the comp_* columns above, so an
    // edited value shows as a divergence from the linked band.
    compBandId: uuid("comp_band_id"),
    hiringManagerId: uuid("hiring_manager_id"),
    workdayPositionWid: text("workday_position_wid"),
    isActive: boolean("is_active").notNull().default(true),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Active positions in the same BU can't share a title; retired ones are exempt.
    uniqueIndex("idx_positions_active_title")
      .on(table.tenantId, table.businessUnitId, table.title)
      .where(sql`is_active = true`),
    unique("uniq_positions_tenant_id_id").on(table.tenantId, table.id),
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
    foreignKey({
      columns: [table.tenantId, table.businessUnitId],
      foreignColumns: [businessUnits.tenantId, businessUnits.id],
      name: "fk_positions_business_unit",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.hiringManagerId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_positions_hiring_manager",
    }).onDelete("set null"),
    // T3.2 / G15 — provenance FK to the comp-band library. Compound (tenant, id)
    // so a position + its band share a tenant. RESTRICT: bands are archived,
    // never deleted, so a linked band can't vanish out from under a position.
    foreignKey({
      columns: [table.tenantId, table.compBandId],
      foreignColumns: [compBands.tenantId, compBands.id],
      name: "fk_positions_comp_band",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_positions_created_by",
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

export type Position = typeof positions.$inferSelect;
export type NewPosition = typeof positions.$inferInsert;
