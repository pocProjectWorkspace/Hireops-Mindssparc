import { pgTable, uuid, text, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * Intra-tenant org structure. Recruiters, requisitions, and partners will
 * attach to business units in later DB-* migrations.
 *
 * - Hierarchical via parent_business_unit_id (self-FK). NULL = top-level.
 *   No DB-level depth limit; the app enforces sensible limits if needed.
 * - Tenant-scoped: standard tenant_isolation RLS policy in 0005.
 * - (tenant_id, slug) unique constraint added in 0005 SQL.
 *
 * Tenant-specific terminology: a tenant whose internal language is
 * "departments" or "divisions" can override the display label in tenant
 * settings without changing the schema.
 */

export const businessUnits = pgTable("business_units", {
  id: uuid("id").primaryKey().defaultRandom().notNull(),

  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),

  parentBusinessUnitId: uuid("parent_business_unit_id").references(
    (): AnyPgColumn => businessUnits.id,
    { onDelete: "set null" },
  ),

  name: text("name").notNull(),
  slug: text("slug").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BusinessUnit = typeof businessUnits.$inferSelect;
export type NewBusinessUnit = typeof businessUnits.$inferInsert;
