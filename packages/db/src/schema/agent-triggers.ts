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
import { automationAgents } from "./automation-agents";

/**
 * Trigger definition for an automation_agent.
 *
 * AGENT-01a is 1:1 with automation_agents (one trigger per agent),
 * enforced at the application layer. AGENT-01b/c may relax this; the
 * schema accommodates multiple rows per agent.
 *
 * trigger_type is one of:
 *   - stage_stale          — application has sat in a stage too long
 *   - stage_entered        — application just transitioned into a stage
 *   - message_received     — candidate inbound message landed
 *   - time_scheduled       — cron-shaped recurring trigger
 *   - manual               — fired by a human via the admin UI
 *
 * trigger_config shape is discriminated by trigger_type and validated
 * application-side by TriggerConfigSchema (packages/db/src/zod/agent-configs).
 */
export const agentTriggers = pgTable(
  "agent_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    triggerType: text("trigger_type").notNull(),
    triggerConfig: jsonb("trigger_config").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_agent_triggers_tenant_id_id").on(table.tenantId, table.id),
    index("idx_agent_triggers_agent").on(table.tenantId, table.agentId),
    check(
      "agent_triggers_type_check",
      sql`${table.triggerType} IN ('stage_stale', 'stage_entered', 'message_received', 'time_scheduled', 'manual')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [automationAgents.tenantId, automationAgents.id],
      name: "fk_agent_triggers_agent",
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

export type AgentTrigger = typeof agentTriggers.$inferSelect;
export type NewAgentTrigger = typeof agentTriggers.$inferInsert;
