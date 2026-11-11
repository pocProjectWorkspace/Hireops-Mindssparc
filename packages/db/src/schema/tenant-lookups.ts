import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * C1-F3 (0133) — tenant values for simple lists (Plan A §4 "Shape").
 *
 * One row per (tenant, kind, key). The PLATFORM DEFAULT lists live in code
 * (@hireops/api-types tenant-lookups.ts) and resolve even when a tenant has no
 * rows; a row whose key matches a platform default OVERRIDES it (label, order,
 * active, attrs), a new key ADDS a tenant-specific value. Keys are the
 * canonical values records store (requisitions.employment_type_key, …), so
 * relabelling never breaks analytics.
 *
 * `kind` is format-checked text, not a fixed list — the kinds are a code
 * catalogue (TENANT_LOOKUP_KINDS). Tenant config: FORCE RLS + audit trigger.
 */
export const tenantLookups = pgTable(
  "tenant_lookups",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    attrs: jsonb("attrs")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_tenant_lookups_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_tenant_lookups_kind_key").on(table.tenantId, table.kind, table.key),
    check("tenant_lookups_kind_check", sql`${table.kind} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    check("tenant_lookups_key_check", sql`${table.key} ~ '^[a-z0-9][a-z0-9_]{0,39}$'`),
    check("tenant_lookups_label_check", sql`char_length(${table.label}) BETWEEN 1 AND 80`),
    check("tenant_lookups_attrs_check", sql`jsonb_typeof(${table.attrs}) = 'object'`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "tenant_lookups_tenant_id_fkey",
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

export type TenantLookup = typeof tenantLookups.$inferSelect;
export type NewTenantLookup = typeof tenantLookups.$inferInsert;
