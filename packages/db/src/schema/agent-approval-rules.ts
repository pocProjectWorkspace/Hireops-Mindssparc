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
import { agentActions } from "./agent-actions";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Per-action approval rules. Determines whether an action runs
 * autonomously, waits for human approval, or is human-optional (auto-
 * approves after ttl).
 *
 * approval_mode:
 *   - auto             — action runs without human gate
 *   - human_required   — action waits for explicit approval
 *   - human_optional   — action waits with a TTL; auto-approves after
 *
 * approver_role and approver_user_id are paired:
 *   - approval_mode = 'auto'           → approver_role IS NULL
 *   - approval_mode != 'auto'          → approver_role IS NOT NULL
 *   - approver_role = 'specific_user'  → approver_user_id IS NOT NULL
 *   - approver_role != 'specific_user' → approver_user_id IS NULL
 *
 * Both pairings are enforced by CHECK constraints below.
 *
 * conditions (jsonb) is a placeholder for AGENT-01b conditional approval
 * (e.g. "auto-approve if cost_micros < N"). Present in the schema so the
 * later ticket doesn't need a column migration.
 */
export const agentApprovalRules = pgTable(
  "agent_approval_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    actionId: uuid("action_id").notNull(),
    approvalMode: text("approval_mode").notNull(),
    approverRole: text("approver_role"),
    approverUserId: uuid("approver_user_id"),
    conditions: jsonb("conditions"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_agent_approval_rules_tenant_id_id").on(table.tenantId, table.id),
    index("idx_agent_approval_rules_agent").on(table.tenantId, table.agentId),
    index("idx_agent_approval_rules_action").on(table.tenantId, table.actionId),
    check(
      "agent_approval_rules_mode_check",
      sql`${table.approvalMode} IN ('auto', 'human_required', 'human_optional')`,
    ),
    check(
      "agent_approval_rules_role_check",
      sql`${table.approverRole} IS NULL OR ${table.approverRole} IN ('any_recruiter', 'owning_recruiter', 'hr_team', 'specific_user')`,
    ),
    // Biconditional: mode='auto' iff approver_role IS NULL.
    check(
      "agent_approval_rules_mode_role_pair_check",
      sql`(${table.approvalMode} = 'auto') = (${table.approverRole} IS NULL)`,
    ),
    // Biconditional: approver_role='specific_user' iff approver_user_id IS NOT NULL.
    check(
      "agent_approval_rules_role_user_pair_check",
      sql`(${table.approverRole} = 'specific_user') = (${table.approverUserId} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.tenantId, table.agentId],
      foreignColumns: [automationAgents.tenantId, automationAgents.id],
      name: "fk_agent_approval_rules_agent",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.actionId],
      foreignColumns: [agentActions.tenantId, agentActions.id],
      name: "fk_agent_approval_rules_action",
    }).onDelete("cascade"),
    // approver_user_id is nullable + ON DELETE SET NULL — compound FK
    // here would null tenant_id too (same Postgres restriction as
    // notification_outbox HANDOVER #63). Tenant integrity is enforced by
    // the row's own tenant_id FK + tenant_isolation policy.
    foreignKey({
      columns: [table.approverUserId],
      foreignColumns: [tenantUserMemberships.id],
      name: "fk_agent_approval_rules_approver_user",
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

export type AgentApprovalRule = typeof agentApprovalRules.$inferSelect;
export type NewAgentApprovalRule = typeof agentApprovalRules.$inferInsert;
