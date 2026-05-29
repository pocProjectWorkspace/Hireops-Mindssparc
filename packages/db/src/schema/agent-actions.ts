import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
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
 * Ordered actions an agent performs when its trigger fires.
 *
 * action_order is per-agent and gap-tolerant (HR can delete an action
 * mid-sequence; the remaining rows keep their numbers). It's denormalised
 * onto agent_run_actions so historical runs survive subsequent edits to
 * the agent definition.
 *
 * action_type values:
 *   - draft_message              — LLM drafts an outbound message
 *   - send_message               — dispatches via notification_outbox
 *   - propose_calendar_slots     — Google Calendar slot search
 *   - create_calendar_event      — book a slot
 *   - update_application_stage   — advance/reject the application
 *   - notify_recruiter           — internal in-app + email
 *   - create_audit_entry         — append a row to audit_logs
 *
 * action_config shape is discriminated by action_type and validated
 * application-side by ActionConfigSchema.
 */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    actionOrder: integer("action_order").notNull(),
    actionType: text("action_type").notNull(),
    actionConfig: jsonb("action_config").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_agent_actions_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_agent_actions_agent_order").on(table.tenantId, table.agentId, table.actionOrder),
    index("idx_agent_actions_agent").on(table.tenantId, table.agentId),
    check(
      "agent_actions_type_check",
      sql`${table.actionType} IN ('draft_message', 'send_message', 'propose_calendar_slots', 'create_calendar_event', 'update_application_stage', 'notify_recruiter', 'create_audit_entry')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [automationAgents.tenantId, automationAgents.id],
      name: "fk_agent_actions_agent",
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

export type AgentAction = typeof agentActions.$inferSelect;
export type NewAgentAction = typeof agentActions.$inferInsert;
