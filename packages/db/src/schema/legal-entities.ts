import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * C1-F3 (0133) — legal entities inside a tenant (Plan A §15 P1).
 *
 * The top of the organisation scoping hierarchy: legal entity → country →
 * business unit → location. One customer = one tenant; a second legal entity
 * (e.g. a US company joining later) is a new row here, not a new tenant.
 *
 * Deactivated, never deleted: business_units / locations compound-FK an entity
 * ON DELETE RESTRICT. Tenant-scoped config: tenant_isolation + FORCE RLS + the
 * audit trigger (migration 0133).
 */
export const legalEntities = pgTable(
  "legal_entities",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    /** ISO-3166 alpha-2, upper-case (CHECK ^[A-Z]{2}$). */
    countryCode: text("country_code").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_legal_entities_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_legal_entities_tenant_name").on(table.tenantId, table.name),
    check("legal_entities_name_check", sql`char_length(${table.name}) BETWEEN 1 AND 160`),
    check("legal_entities_country_code_check", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "legal_entities_tenant_id_fkey",
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

export type LegalEntity = typeof legalEntities.$inferSelect;
export type NewLegalEntity = typeof legalEntities.$inferInsert;
