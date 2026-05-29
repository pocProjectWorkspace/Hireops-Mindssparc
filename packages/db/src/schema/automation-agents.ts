import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * HR-configurable automation agents — the spine of the agent surface.
 *
 * Wave 1 (AGENT-01a) ships three agent_type values that map to the demo
 * trio: scheduling, follow_up, candidate_qa. Additional types land via
 * CHECK-constraint extension (no pgEnum — same pattern as
 * integration_credentials.integration_type).
 *
 * version bumps on every edit (application layer; no trigger). Clients
 * use it for optimistic concurrency control. retired_at NULL = active;
 * setting retired_at preserves history and frees the (tenant_id, name)
 * slot for a new agent.
 *
 * created_by is NOT NULL — every agent has a known author. Compound FK
 * to tenant_user_memberships with RESTRICT so deletes don't orphan
 * authorship.
 */
export const automationAgents = pgTable(
  "automation_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentType: text("agent_type").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    enabled: boolean("enabled").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    unique("uniq_automation_agents_tenant_id_id").on(table.tenantId, table.id),
    // Name uniqueness only among active rows — HR can re-use a retired name.
    uniqueIndex("uniq_automation_agents_active_name")
      .on(table.tenantId, table.name)
      .where(sql`retired_at IS NULL`),
    // List active agents per tenant — the admin agents list query.
    index("idx_automation_agents_active").on(table.tenantId, table.enabled, table.retiredAt),
    check(
      "automation_agents_agent_type_check",
      sql`${table.agentType} IN ('scheduling', 'follow_up', 'candidate_qa')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.createdBy],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_automation_agents_created_by",
    }).onDelete("restrict"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type AutomationAgent = typeof automationAgents.$inferSelect;
export type NewAutomationAgent = typeof automationAgents.$inferInsert;
