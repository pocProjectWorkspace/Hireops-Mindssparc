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
import { offboardingCases } from "./offboarding-cases";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * offboarding_tasks — atomic offboarding checklist (architecture.md §5.1:
 * "atomic tasks (KT, asset return, F&F, etc.)"; requirements.md §8.2–8.3).
 * The clearance spine: knowledge transfer, asset return, access revocation,
 * final settlement, exit interview scheduling, manager sign-off, HR
 * clearance. Direct mirror of onboarding_tasks — atomic rows, no separate
 * milestone tables; a scanner/lifecycle (OFFBOARD-02) generates the standard
 * set when a case is initiated.
 *
 * task_type / status are text + CHECK (NOT pgEnum) — HANDOVER reality #114.
 * `metadata` carries task-shaped extras (e.g. SCIM app list for an
 * access_revocation task) without a schema change, same as onboarding_tasks.
 */
export const offboardingTasks = pgTable(
  "offboarding_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),

    taskType: text("task_type").notNull(),
    status: text("status").notNull().default("pending"),
    title: text("title").notNull(),

    assigneeMembershipId: uuid("assignee_membership_id"),

    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    blockedReason: text("blocked_reason"),

    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_offboarding_tasks_tenant_id_id").on(table.tenantId, table.id),

    index("idx_offboarding_tasks_case").on(table.tenantId, table.caseId),
    // Persona work-queues (IT asset-return queue, HR clearance queue).
    index("idx_offboarding_tasks_type_status").on(table.tenantId, table.taskType, table.status),
    // Due/overdue sweep across notice-period tasks.
    index("idx_offboarding_tasks_due").on(table.tenantId, table.dueAt),

    check(
      "offboarding_tasks_task_type_check",
      sql`${table.taskType} IN ('knowledge_transfer', 'asset_return', 'access_revocation', 'final_settlement', 'exit_interview', 'manager_signoff', 'hr_clearance')`,
    ),
    check(
      "offboarding_tasks_status_check",
      sql`${table.status} IN ('pending', 'in_progress', 'completed', 'blocked', 'skipped')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [offboardingCases.tenantId, offboardingCases.id],
      name: "fk_offboarding_tasks_case",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.assigneeMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_offboarding_tasks_assignee",
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

export type OffboardingTask = typeof offboardingTasks.$inferSelect;
export type NewOffboardingTask = typeof offboardingTasks.$inferInsert;
