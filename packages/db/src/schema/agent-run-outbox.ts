import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  smallint,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { automationAgents } from "./automation-agents";

/**
 * Outbox for agent run dispatch — mirrors notification_outbox /
 * workday_sync_outbox / ai_score_outbox shape.
 *
 * Writers (trigger evaluators, manual-run mutations) INSERT a row in the
 * same tx as the triggering event. The worker polls every 5 s, claims
 * via UPDATE ... FOR UPDATE SKIP LOCKED + locked_until, dispatches by
 * creating an agent_runs row and walking its actions.
 *
 * status lifecycle:
 *   pending → processing → completed | failed
 *                  ↓
 *           awaiting_approval (run paused on an approval_request)
 *
 * awaiting_approval rows leave polling rotation — the worker skips them
 * via the partial index predicate. When the approval resolves the
 * approval-handler flips status back to processing.
 *
 * RLS: tenant_isolation. No audit trigger — this IS the dispatch log
 * (same exclusion as notification_outbox / ai_score_outbox).
 */
export const agentRunOutbox = pgTable(
  "agent_run_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    triggerContext: jsonb("trigger_context").notNull(),
    status: text("status").notNull().default("pending"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    attemptCount: smallint("attempt_count").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    unique("uniq_agent_run_outbox_tenant_id_id").on(table.tenantId, table.id),
    // Primary worker query — partial to skip terminal + awaiting_approval rows.
    index("idx_agent_run_outbox_queue")
      .on(table.tenantId, table.status, table.enqueuedAt)
      .where(sql`status IN ('pending', 'processing')`),
    // Orphan-recovery sweep — stuck-in-processing rows.
    index("idx_agent_run_outbox_orphan_sweep")
      .on(table.lockedUntil)
      .where(sql`status = 'processing'`),
    check(
      "agent_run_outbox_status_check",
      sql`${table.status} IN ('pending', 'processing', 'awaiting_approval', 'completed', 'failed')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [automationAgents.tenantId, automationAgents.id],
      name: "fk_agent_run_outbox_agent",
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

export type AgentRunOutbox = typeof agentRunOutbox.$inferSelect;
export type NewAgentRunOutbox = typeof agentRunOutbox.$inferInsert;
