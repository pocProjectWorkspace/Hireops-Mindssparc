import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  check,
  unique,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { platformOperators } from "./platform";

/**
 * C1-F11 — tenant_provisioning_jobs (migration 0135). One row per tenant made
 * through the platform console; `steps` records which provisioning steps are
 * done so a failed run resumes and a re-run never duplicates. PLATFORM table:
 * RLS enabled + FORCED with NO policies (service-role pool only), allowlisted
 * in lint-rls.ts. Mirrors the hand-written SQL.
 */
export const tenantProvisioningJobs = pgTable(
  "tenant_provisioning_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // pending | running | failed | completed
    starterPackKey: text("starter_pack_key").notNull(),
    starterPackVersion: integer("starter_pack_version").notNull(),
    request: jsonb("request").notNull().default({}),
    steps: jsonb("steps").notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdByOperator: uuid("created_by_operator").references(() => platformOperators.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("uniq_tenant_provisioning_jobs_tenant").on(t.tenantId),
    index("idx_tenant_provisioning_jobs_status").on(t.status, t.updatedAt),
    check(
      "tenant_provisioning_jobs_status_check",
      sql`${t.status} IN ('pending', 'running', 'failed', 'completed')`,
    ),
    check(
      "tenant_provisioning_jobs_pack_key_check",
      sql`${t.starterPackKey} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`,
    ),
    check("tenant_provisioning_jobs_pack_version_check", sql`${t.starterPackVersion} >= 1`),
    check("tenant_provisioning_jobs_request_check", sql`jsonb_typeof(${t.request}) = 'object'`),
    check("tenant_provisioning_jobs_steps_check", sql`jsonb_typeof(${t.steps}) = 'object'`),
    check(
      "tenant_provisioning_jobs_last_error_check",
      sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 2000`,
    ),
  ],
).enableRLS();

export type TenantProvisioningJob = typeof tenantProvisioningJobs.$inferSelect;
export type NewTenantProvisioningJob = typeof tenantProvisioningJobs.$inferInsert;
