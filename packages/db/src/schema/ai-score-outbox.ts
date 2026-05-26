import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  smallint,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";

/**
 * Outbox for async AI fit-scoring (AI-03).
 *
 * One row per application that's eligible for scoring (knockouts pass +
 * parser confidence above threshold). The score-application worker
 * polls this table on a 5 s loop, claims a batch via UPDATE ... WHERE
 * id IN (... FOR UPDATE SKIP LOCKED), calls the tenant's configured
 * AI provider, writes the result onto `applications.ai_score` /
 * `ai_score_explanation` / `ai_scored_at`, and marks the outbox row
 * 'completed'.
 *
 * status: 'pending' → 'processing' → 'completed' | 'failed'. Failed
 * rows are retried by the worker up to `attempt_cap`; after the cap
 * they stay 'failed' for the ops dashboard surface (open-question #10).
 *
 * Compound unique (tenant_id, application_id) — one scoring attempt
 * per application, ever. Re-scoring (e.g. when JD skills change) is a
 * separate ticket; AI-03 is submit-time scoring only.
 *
 * RLS: tenant_isolation. No audit trigger attached — this IS the log
 * of scoring attempts (same exclusion as notification_outbox,
 * workday_sync_outbox, ai_usage_logs, *_state_transitions).
 *
 * FK strategy: compound (tenant_id, application_id) → applications
 * per HANDOVER §4.5/#13. application_id is NOT NULL.
 */
export const aiScoreOutbox = pgTable(
  "ai_score_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    attemptCap: smallint("attempt_cap").notNull().default(5),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedBy: text("claimed_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_ai_score_outbox_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_ai_score_outbox_per_application").on(table.tenantId, table.applicationId),
    // Primary worker query — partial to skip terminal rows.
    index("idx_ai_score_outbox_queue")
      .on(table.tenantId, table.status, table.createdAt)
      .where(sql`status IN ('pending', 'processing')`),
    // Orphan-recovery sweep — stuck-in-processing rows.
    index("idx_ai_score_outbox_orphan_sweep")
      .on(table.claimedAt)
      .where(sql`status = 'processing'`),
    check(
      "ai_score_outbox_status_check",
      sql`${table.status} IN ('pending', 'processing', 'completed', 'failed')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_ai_score_outbox_application",
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

export type AIScoreOutbox = typeof aiScoreOutbox.$inferSelect;
export type NewAIScoreOutbox = typeof aiScoreOutbox.$inferInsert;
