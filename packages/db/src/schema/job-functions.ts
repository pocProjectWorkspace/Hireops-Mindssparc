import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * C1-F3 (0133) — job functions / job families (Plan A TX2 / §15 P2).
 *
 * `key` is the stable canonical value (analytics, imports); `label` is what
 * the tenant calls it. Deactivated, never deleted (RESTRICT FKs from
 * job_profiles / positions / requisitions / comp_bands). The legacy free-text
 * positions.function stays as the display fallback.
 */
export const jobFunctions = pgTable(
  "job_functions",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_job_functions_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_job_functions_tenant_key").on(table.tenantId, table.key),
    check("job_functions_key_check", sql`${table.key} ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'`),
    check("job_functions_label_check", sql`char_length(${table.label}) BETWEEN 1 AND 120`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "job_functions_tenant_id_fkey",
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

export type JobFunction = typeof jobFunctions.$inferSelect;
export type NewJobFunction = typeof jobFunctions.$inferInsert;
