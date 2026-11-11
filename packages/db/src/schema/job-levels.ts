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
 * C1-F3 (0133) — job levels / grades / bands (Plan A TX1 / §15 P2).
 *
 * `key` is the stable grade code (e.g. "IN12") — the Workday import maps a
 * Compensation Grade onto it by key. `rank` orders levels (higher = more
 * senior) so ranges and pickers sort correctly whatever the labels say.
 * Deactivated, never deleted. The legacy free-text positions.level and
 * comp_bands.level stay as the display fallback.
 */
export const jobLevels = pgTable(
  "job_levels",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    rank: integer("rank").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_job_levels_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_job_levels_tenant_key").on(table.tenantId, table.key),
    check("job_levels_key_check", sql`${table.key} ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'`),
    check("job_levels_label_check", sql`char_length(${table.label}) BETWEEN 1 AND 120`),
    check("job_levels_rank_check", sql`${table.rank} BETWEEN 0 AND 10000`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "job_levels_tenant_id_fkey",
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

export type JobLevel = typeof jobLevels.$inferSelect;
export type NewJobLevel = typeof jobLevels.$inferInsert;
