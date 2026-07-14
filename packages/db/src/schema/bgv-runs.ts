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
import { onboardingCases } from "./onboarding-cases";

/**
 * bgv_runs — background-verification vendor coordination (architecture.md
 * §5.1). One row per BGV engagement for a case. `vendor` is free text
 * (HireRight / FirstAdvantage / AuthBridge — requirements.md §7.1); the
 * vendor list grows so it is not constrained.
 *
 * `status` (text + CHECK, reality #114) is driven by vendor webhooks
 * (requirements.md §7.1 — "Receive status webhooks. Auto-update
 * HireOps"); `webhook_last_received_at` records the last callback.
 * `packages` (jsonb) captures which checks were requested (education,
 * employment, criminal, …). Per-check outcomes live in bgv_results.
 */
export const bgvRuns = pgTable(
  "bgv_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),

    vendor: text("vendor").notNull(),
    vendorReference: text("vendor_reference"),
    status: text("status").notNull().default("initiated"),
    packages: jsonb("packages"),

    initiatedAt: timestamp("initiated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    webhookLastReceivedAt: timestamp("webhook_last_received_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_bgv_runs_tenant_id_id").on(table.tenantId, table.id),

    index("idx_bgv_runs_case").on(table.tenantId, table.caseId),
    index("idx_bgv_runs_status").on(table.tenantId, table.status),

    check(
      "bgv_runs_status_check",
      sql`${table.status} IN ('initiated', 'in_progress', 'completed', 'failed', 'cancelled')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [onboardingCases.tenantId, onboardingCases.id],
      name: "fk_bgv_runs_case",
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

export type BgvRun = typeof bgvRuns.$inferSelect;
export type NewBgvRun = typeof bgvRuns.$inferInsert;
