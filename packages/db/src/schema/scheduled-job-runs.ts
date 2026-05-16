import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, pgPolicy } from "drizzle-orm/pg-core";

/**
 * Last-run bookkeeping for the worker's scheduled jobs.
 *
 * Platform table — NOT tenant-scoped. Each job has one row keyed by
 * its name. The worker reads last_run_at to decide whether to run
 * again; on completion (or failure) it upserts the row.
 *
 * Added to packages/db/src/lint-rls.ts's PLATFORM_TABLES_ALLOWLIST.
 * The single "service_role only" stance (RLS enabled + forced, NO
 * policies for authenticated) matches tenant_encryption_keys —
 * the worker uses the unscoped pool (service_role) so RLS doesn't
 * block reads/writes, and no authenticated path needs this table.
 */
export const scheduledJobRuns = pgTable(
  "scheduled_job_runs",
  {
    jobName: text("job_name").primaryKey(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
    lastRunDurationMs: integer("last_run_duration_ms"),
    lastRunStatus: text("last_run_status").notNull(),
    lastRunError: text("last_run_error"),
  },
  () => [
    // No authenticated policies — service_role only. Same default-deny
    // posture as tenant_encryption_keys.
    pgPolicy("scheduled_job_runs_auth_admin_read", {
      as: "permissive",
      for: "select",
      to: ["supabase_auth_admin"],
      using: sql`true`,
    }),
  ],
).enableRLS();

export type ScheduledJobRun = typeof scheduledJobRuns.$inferSelect;
export type NewScheduledJobRun = typeof scheduledJobRuns.$inferInsert;
