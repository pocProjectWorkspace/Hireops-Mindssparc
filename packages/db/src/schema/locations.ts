import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  unique,
  index,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { legalEntities } from "./legal-entities";

/**
 * C1-F3 (0133) — work locations inside a tenant (Plan A TX3 / §15 P1).
 *
 * Country → region → city: `country_code` (ISO-3166 alpha-2), `region`
 * (state / province as text — no region table yet) and `city`. Market intel
 * keys off this later. Optionally owned by a legal entity; carries an IANA
 * timezone (validated in the API; NULL = the tenant default).
 *
 * positions / requisitions / comp_bands reference a location by compound FK,
 * ON DELETE RESTRICT — locations are deactivated, never deleted. The legacy
 * free-text positions.primary_location stays as the display fallback.
 */
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    city: text("city"),
    region: text("region"),
    countryCode: text("country_code").notNull(),
    legalEntityId: uuid("legal_entity_id"),
    timezone: text("timezone"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_locations_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_locations_tenant_name").on(table.tenantId, table.name),
    index("idx_locations_legal_entity").on(table.tenantId, table.legalEntityId),
    index("idx_locations_geo").on(table.tenantId, table.countryCode, table.region, table.city),
    check("locations_name_check", sql`char_length(${table.name}) BETWEEN 1 AND 160`),
    check("locations_city_check", sql`${table.city} IS NULL OR char_length(${table.city}) <= 120`),
    check(
      "locations_region_check",
      sql`${table.region} IS NULL OR char_length(${table.region}) <= 120`,
    ),
    check("locations_country_code_check", sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check(
      "locations_timezone_check",
      sql`${table.timezone} IS NULL OR char_length(${table.timezone}) BETWEEN 1 AND 64`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "locations_tenant_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.legalEntityId],
      foreignColumns: [legalEntities.tenantId, legalEntities.id],
      name: "fk_locations_legal_entity",
    }).onDelete("restrict"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type Location = typeof locations.$inferSelect;
export type NewLocation = typeof locations.$inferInsert;
