import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { bgvRuns } from "./bgv-runs";

/**
 * bgv_results — per-check outcomes for a bgv_run (architecture.md §5.1
 * "vendor outcomes"). One row per verified item (education, employment,
 * criminal, identity, address, …); `check_type` is free text since the
 * vendor package catalogue varies. `outcome` is text + CHECK
 * (reality #114). `details` (jsonb) holds the vendor's structured payload.
 */
export const bgvResults = pgTable(
  "bgv_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bgvRunId: uuid("bgv_run_id").notNull(),

    checkType: text("check_type").notNull(),
    outcome: text("outcome").notNull().default("pending"),
    details: jsonb("details"),

    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_bgv_results_tenant_id_id").on(table.tenantId, table.id),

    index("idx_bgv_results_run").on(table.tenantId, table.bgvRunId),

    check(
      "bgv_results_outcome_check",
      sql`${table.outcome} IN ('clear', 'discrepancy', 'flagged', 'unable_to_verify', 'pending')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.bgvRunId],
      foreignColumns: [bgvRuns.tenantId, bgvRuns.id],
      name: "fk_bgv_results_run",
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

export type BgvResult = typeof bgvResults.$inferSelect;
export type NewBgvResult = typeof bgvResults.$inferInsert;
