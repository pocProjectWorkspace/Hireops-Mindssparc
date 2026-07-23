import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * Intra-tenant org structure. Recruiters, requisitions, and partners will
 * attach to business units in later DB-* migrations.
 *
 * - Hierarchical via parent_business_unit_id (self-FK). NULL = top-level.
 *   No DB-level depth limit; the app enforces sensible limits if needed.
 * - Tenant-scoped: standard tenant_isolation RLS policy.
 * - (tenant_id, slug) unique constraint.
 *
 * FK constraint names are explicit (`*_fkey`) to match the hand-written
 * 0004 migration's Postgres-default names; Drizzle's auto-derived names
 * would diverge and produce spurious renames on db:generate.
 */

export const businessUnits = pgTable(
  "business_units",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),

    tenantId: uuid("tenant_id").notNull(),

    parentBusinessUnitId: uuid("parent_business_unit_id"),

    name: text("name").notNull(),
    slug: text("slug").notNull(),

    // T3.1 / G14 — archived units are retired from the requisition-creation
    // picker but stay valid for positions already attached to them.
    isArchived: boolean("is_archived").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("business_units_tenant_id_slug_key").on(table.tenantId, table.slug),
    // Compound unique enables compound (tenant_id, id) FKs from peer
    // domain tables (DB-TENANT-FK).
    unique("uniq_business_units_tenant_id_id").on(table.tenantId, table.id),
    index("idx_business_units_tenant").on(table.tenantId),
    index("idx_business_units_parent").on(table.parentBusinessUnitId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "business_units_tenant_id_fkey",
    }).onDelete("cascade"),
    // Self-FK now compound so child + parent must share a tenant.
    foreignKey({
      columns: [table.tenantId, table.parentBusinessUnitId],
      foreignColumns: [table.tenantId, table.id],
      name: "fk_business_units_parent",
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

export type BusinessUnit = typeof businessUnits.$inferSelect;
export type NewBusinessUnit = typeof businessUnits.$inferInsert;
