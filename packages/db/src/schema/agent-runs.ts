import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
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
import { agentActions } from "./agent-actions";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * agent_runs — one row per agent execution attempt.
 *
 * status lifecycle:
 *   pending → running → awaiting_approval ↔ approved → completed
 *                              ↓                        ↑
 *                           rejected                  cancelled
 *                              ↓
 *                            failed
 *
 * triggered_by_user_id is set ONLY when triggered_by = 'manual'. CHECK
 * constraint enforces this pairing.
 *
 * trigger_context is the snapshot of "what fired this" — the trigger
 * config + the matching row(s) at the time. Frozen at run start.
 *
 * cost_micros is the running total of LLM cost from ai_usage_logs rows
 * attributed to this run. Aggregated at completion time by the worker.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    triggeredBy: text("triggered_by").notNull(),
    triggeredByUserId: uuid("triggered_by_user_id"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    triggerContext: jsonb("trigger_context").notNull(),
    status: text("status").notNull().default("pending"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    // sql`0` default — passing 0n is rejected by drizzle-kit's BigInt
    // JSON serializer in the snapshot diff (TypeError on JSON.stringify).
    costMicros: bigint("cost_micros", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    unique("uniq_agent_runs_tenant_id_id").on(table.tenantId, table.id),
    // Run history per agent, newest first.
    index("idx_agent_runs_history").on(table.tenantId, table.agentId, table.triggeredAt.desc()),
    check(
      "agent_runs_triggered_by_check",
      sql`${table.triggeredBy} IN ('system', 'cron', 'event', 'manual')`,
    ),
    check(
      "agent_runs_status_check",
      sql`${table.status} IN ('pending', 'running', 'awaiting_approval', 'approved', 'rejected', 'completed', 'failed', 'cancelled')`,
    ),
    // triggered_by_user_id is set iff triggered_by = 'manual'.
    check(
      "agent_runs_triggered_by_user_pair_check",
      sql`(${table.triggeredBy} = 'manual') = (${table.triggeredByUserId} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [automationAgents.tenantId, automationAgents.id],
      name: "fk_agent_runs_agent",
    }).onDelete("cascade"),
    // triggered_by_user_id nullable + SET NULL — single-column FK per
    // notification_outbox HANDOVER #63 pattern.
    foreignKey({
      columns: [table.triggeredByUserId],
      foreignColumns: [tenantUserMemberships.id],
      name: "fk_agent_runs_triggered_by_user",
    }).onDelete("set null"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;

/**
 * agent_run_actions — per-action state within an agent_run.
 *
 * action_order is denormalised from agent_actions.action_order so that
 * historical runs survive subsequent edits to the agent definition. The
 * action_id FK is RESTRICT (not CASCADE) — an action row can only be
 * deleted if no run references it.
 *
 * status lifecycle:
 *   pending → running → completed
 *                  ↓
 *               failed
 *                  ↓
 *               skipped (downstream of failed/rejected)
 *                  ↑
 *           awaiting_approval (when approval mode requires it)
 *
 * approval_request_id is a denormalised back-pointer; the canonical FK
 * direction is agent_approval_requests.run_action_id → agent_run_actions.
 * Single-column FK with SET NULL (compound + NOT NULL tenant_id issue).
 */
export const agentRunActions = pgTable(
  "agent_run_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    actionId: uuid("action_id").notNull(),
    actionOrder: integer("action_order").notNull(),
    status: text("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    input: jsonb("input"),
    output: jsonb("output"),
    approvalRequestId: uuid("approval_request_id"),
    error: text("error"),
  },
  (table) => [
    unique("uniq_agent_run_actions_tenant_id_id").on(table.tenantId, table.id),
    index("idx_agent_run_actions_run").on(table.tenantId, table.runId, table.actionOrder),
    check(
      "agent_run_actions_status_check",
      sql`${table.status} IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'skipped')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [agentRuns.tenantId, agentRuns.id],
      name: "fk_agent_run_actions_run",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.actionId],
      foreignColumns: [agentActions.tenantId, agentActions.id],
      name: "fk_agent_run_actions_action",
    }).onDelete("restrict"),
    // approval_request_id is intentionally a denormalised uuid pointer with
    // no FK. The canonical relationship goes the other way:
    // agent_approval_requests.run_action_id → agent_run_actions. Adding a
    // reverse FK would either need a circular Drizzle import or a hand-written
    // post-create ALTER. Stale-pointer risk is theoretical because approval
    // requests are audit-preserved (never deleted) per the agent design.
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type AgentRunAction = typeof agentRunActions.$inferSelect;
export type NewAgentRunAction = typeof agentRunActions.$inferInsert;
