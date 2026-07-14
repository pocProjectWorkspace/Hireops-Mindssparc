import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  integer,
  date,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { candidates } from "./candidates";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * onboarding_cases — one per new hire. Opened when an application reaches
 * offer_accepted (architecture.md §5.1 onboarding group).
 *
 * `status` uses the text + CHECK convention adopted by the agent_* domain
 * tables — deliberately NOT a pgEnum. Rationale (flagged in hand-back):
 * comparing an enum column against invalid text THROWS in Postgres
 * (HANDOVER reality #114); text + CHECK compares cleanly and grows with a
 * one-line additive ALTER instead of ALTER TYPE. Lifecycle:
 *   pre_boarding → day_zero → in_progress → completed
 *                                         ↘ cancelled
 *
 * `geography_code` is the new hire's GCC location (IN / PH). It selects
 * which `document_types` rows apply (requirements.md §7.1 — "filtered per
 * the candidate's GCC location").
 *
 * Probation: default 90 days, configurable up to 180 per role/grade
 * (requirements.md §7.3). Stored on the case; the CHECK caps it at 180.
 * The probation-review milestone is modelled as an onboarding_task
 * (task_type = 'probation_review'), not a column.
 *
 * `workday_worker_id` is written back after the Day-0 Hire sync
 * (requirements.md §7.2); everything here runs against the Workday
 * simulator for now.
 *
 * Compound (tenant_id, *) FKs to applications/candidates/memberships,
 * same discipline as offers/applications.
 */
export const onboardingCases = pgTable(
  "onboarding_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),

    status: text("status").notNull().default("pre_boarding"),
    geographyCode: char("geography_code", { length: 2 }).notNull(),

    expectedStartDate: date("expected_start_date"),
    actualStartDate: date("actual_start_date"),

    probationDays: integer("probation_days").notNull().default(90),
    probationEndsAt: date("probation_ends_at"),

    buddyMembershipId: uuid("buddy_membership_id"),
    managerMembershipId: uuid("manager_membership_id"),

    workdayWorkerId: text("workday_worker_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_onboarding_cases_tenant_id_id").on(table.tenantId, table.id),

    index("idx_onboarding_cases_status").on(table.tenantId, table.status),
    index("idx_onboarding_cases_application").on(table.tenantId, table.applicationId),

    check(
      "onboarding_cases_status_check",
      sql`${table.status} IN ('pre_boarding', 'day_zero', 'in_progress', 'completed', 'cancelled')`,
    ),
    check("onboarding_cases_probation_days_check", sql`${table.probationDays} BETWEEN 1 AND 180`),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_onboarding_cases_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.candidateId],
      foreignColumns: [candidates.tenantId, candidates.id],
      name: "fk_onboarding_cases_candidate",
    }).onDelete("restrict"),

    foreignKey({
      columns: [table.tenantId, table.buddyMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_onboarding_cases_buddy",
    }).onDelete("restrict"),

    foreignKey({
      columns: [table.tenantId, table.managerMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_onboarding_cases_manager",
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

export type OnboardingCase = typeof onboardingCases.$inferSelect;
export type NewOnboardingCase = typeof onboardingCases.$inferInsert;
