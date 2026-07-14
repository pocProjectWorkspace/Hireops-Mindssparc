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
import { onboardingCases } from "./onboarding-cases";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * onboarding_tasks — atomic onboarding tasks (architecture.md §5.1:
 * "collect doc, IT provision, training, etc."). Architecture says tasks
 * are atomic and there is NO separate check-ins table, so the 7/14/30-day
 * check-ins (requirements.md §7.3) are modelled here as rows with
 * task_type = 'check_in' and a `metadata` payload carrying the offset
 * (e.g. { "checkInDay": 7 }); `due_at` holds the computed date. The
 * probation-review milestone is likewise task_type = 'probation_review'.
 *
 * task_type / status are text + CHECK (not pgEnum) — same rationale as
 * onboarding_cases.status (HANDOVER reality #114).
 */
export const onboardingTasks = pgTable(
  "onboarding_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),

    taskType: text("task_type").notNull(),
    status: text("status").notNull().default("pending"),
    title: text("title").notNull(),
    description: text("description"),

    assigneeMembershipId: uuid("assignee_membership_id"),

    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    blockedReason: text("blocked_reason"),

    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_onboarding_tasks_tenant_id_id").on(table.tenantId, table.id),

    index("idx_onboarding_tasks_case").on(table.tenantId, table.caseId),
    // Persona work-queues (IT provisioning queue, People Ops check-ins).
    index("idx_onboarding_tasks_type_status").on(table.tenantId, table.taskType, table.status),
    // Due/overdue sweep for scheduled check-ins + probation reviews.
    index("idx_onboarding_tasks_due").on(table.tenantId, table.dueAt),

    check(
      "onboarding_tasks_task_type_check",
      sql`${table.taskType} IN ('document_collection', 'bgv', 'it_provisioning', 'asset_assignment', 'training', 'orientation', 'buddy_assignment', 'probation_review', 'check_in', 'medical', 'payroll_form', 'equipment_preference', 'other')`,
    ),
    check(
      "onboarding_tasks_status_check",
      sql`${table.status} IN ('pending', 'in_progress', 'blocked', 'completed', 'cancelled', 'skipped')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [onboardingCases.tenantId, onboardingCases.id],
      name: "fk_onboarding_tasks_case",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.assigneeMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_onboarding_tasks_assignee",
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

export type OnboardingTask = typeof onboardingTasks.$inferSelect;
export type NewOnboardingTask = typeof onboardingTasks.$inferInsert;
