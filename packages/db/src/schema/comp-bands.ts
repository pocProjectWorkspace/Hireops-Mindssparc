import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  numeric,
  boolean,
  timestamp,
  index,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * Comp-band LIBRARY (T3.2 / G15, Phase 3 org structure). A tenant's editable set
 * of NAMED compensation bands — a controlled list the requisition wizard's picker
 * reads, so a position's comp values come from a managed band rather than a
 * free-typed guess.
 *
 * FLAT + named, with an optional free-text `level` label (no structured BU /
 * location scoping — deferred). Tenant-scoped: standard tenant_isolation RLS.
 *
 * HONESTY: this is NOT a decorative dropdown. When the wizard sends a
 * `compBandId`, createRequisitionDraft COPIES the band's min/max/currency onto
 * positions.comp_band_min/max/comp_currency (MAJOR INR), which the existing
 * comp-rules.ts verdict engine + feasibility/detail views already read — so the
 * chosen band genuinely drives the position's comp. positions.comp_band_id is
 * retained as provenance, so an override (edited values) shows as a divergence.
 *
 * min_major / max_major are MAJOR-unit currency (INR rupees), matching
 * positions.comp_band_min/max. Bands are archived, never deleted (positions
 * compound-FK them ON DELETE RESTRICT).
 */
export const compBands = pgTable(
  "comp_bands",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),

    tenantId: uuid("tenant_id").notNull(),

    name: text("name").notNull(),
    // Optional free-text level label (e.g. "Senior", "P4"). No structured scope.
    level: text("level"),

    currency: char("currency", { length: 3 }).notNull(),
    minMajor: numeric("min_major", { precision: 12, scale: 2 }).notNull(),
    maxMajor: numeric("max_major", { precision: 12, scale: 2 }).notNull(),

    // Archived bands are retired from the requisition-creation picker but stay
    // valid for positions already attached to them.
    isArchived: boolean("is_archived").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_comp_bands_tenant_name").on(table.tenantId, table.name),
    // Compound unique enables compound (tenant_id, id) FKs from peer domain
    // tables — positions.comp_band_id (DB-TENANT-FK).
    unique("uniq_comp_bands_tenant_id_id").on(table.tenantId, table.id),
    index("idx_comp_bands_tenant").on(table.tenantId),
    check("comp_bands_range_check", sql`(${table.minMajor} <= ${table.maxMajor})`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "comp_bands_tenant_id_fkey",
    }).onDelete("cascade"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type CompBand = typeof compBands.$inferSelect;
export type NewCompBand = typeof compBands.$inferInsert;
