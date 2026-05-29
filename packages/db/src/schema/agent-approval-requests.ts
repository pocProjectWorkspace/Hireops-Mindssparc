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
import { agentRuns, agentRunActions } from "./agent-runs";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Per-action approval request — created when an agent_run_action hits
 * an approval_mode that isn't 'auto'.
 *
 * status:
 *   - pending        — awaiting human decision
 *   - approved       — human said yes (with optional edited_payload)
 *   - rejected       — human said no
 *   - expired        — TTL elapsed (only relevant for human_optional)
 *   - auto_approved  — TTL elapsed on human_optional → auto-approve
 *
 * ttl_at is NULL unless approval_mode = 'human_optional'. The
 * application layer enforces this; we don't constrain it at schema
 * level because the rule depends on the related approval_rules row.
 *
 * edited_payload is populated when a human approved-with-edits — the
 * action runs with this payload instead of proposed_action_payload.
 */
export const agentApprovalRequests = pgTable(
  "agent_approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    runActionId: uuid("run_action_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    proposedActionSummary: text("proposed_action_summary").notNull(),
    proposedActionPayload: jsonb("proposed_action_payload").notNull(),
    approverRole: text("approver_role").notNull(),
    status: text("status").notNull().default("pending"),
    ttlAt: timestamp("ttl_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id"),
    decisionNotes: text("decision_notes"),
    editedPayload: jsonb("edited_payload"),
  },
  (table) => [
    unique("uniq_agent_approval_requests_tenant_id_id").on(table.tenantId, table.id),
    // The approval-queue query — pending requests across all agents.
    index("idx_agent_approval_requests_queue").on(
      table.tenantId,
      table.status,
      table.proposedAt,
    ),
    // Per-agent pending count.
    index("idx_agent_approval_requests_agent_status").on(
      table.tenantId,
      table.agentId,
      table.status,
    ),
    check(
      "agent_approval_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'rejected', 'expired', 'auto_approved')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.runId],
      foreignColumns: [agentRuns.tenantId, agentRuns.id],
      name: "fk_agent_approval_requests_run",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.runActionId],
      foreignColumns: [agentRunActions.tenantId, agentRunActions.id],
      name: "fk_agent_approval_requests_run_action",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [automationAgents.tenantId, automationAgents.id],
      name: "fk_agent_approval_requests_agent",
    }).onDelete("cascade"),
    // decided_by_user_id nullable + SET NULL — single-column FK pattern.
    foreignKey({
      columns: [table.decidedByUserId],
      foreignColumns: [tenantUserMemberships.id],
      name: "fk_agent_approval_requests_decided_by_user",
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

export type AgentApprovalRequest = typeof agentApprovalRequests.$inferSelect;
export type NewAgentApprovalRequest = typeof agentApprovalRequests.$inferInsert;
