import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { candidates } from "./candidates";
import { applications } from "./applications";
import { onboardingCases } from "./onboarding-cases";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * offboarding_cases — one per departure (architecture.md §5.1 offboarding
 * group: "one per resignation/termination"; requirements.md §8.1). Opened
 * when a resignation is submitted or a termination is HR-initiated
 * (OFFBOARD-02 lifecycle).
 *
 * EMPLOYEE-ANCHOR MODELLING (flagged — read this):
 * There is NO employees table in HireOps. The "employed person" is the
 * recruitment record that reached a hire: the candidate/application chain,
 * which ONBOARD-01/02 turned into an onboarding_case (and, at Day-0, a
 * simulated Workday worker_id). So an offboarding case anchors on the same
 * chain the onboarding side did:
 *   - candidate_id  — the durable person-in-this-tenant anchor (NOT NULL,
 *     RESTRICT). Mirrors onboarding_cases.candidate_id. This is the one
 *     stable identity a departing employee always has.
 *   - application_id — nullable context pointer to the specific hire req the
 *     person was hired against. Nullable because a departure record must
 *     survive even if the recruitment context is unavailable, and because
 *     future non-ATS-originated employees (imported workers) may have no
 *     application row.
 *   - onboarding_case_id — nullable back-link to the onboarding_case, when
 *     one exists, so OFFBOARD-02 can pull start date / geography / manager
 *     without re-deriving them.
 * All three anchor legs use RESTRICT (not CASCADE): a departure record is a
 * compliance/HR artifact that must outlive edits to the recruitment side —
 * deleting an application or onboarding_case must NOT silently erase the
 * offboarding history. Compound FKs cannot SET NULL (the tenant_id leg is
 * NOT NULL — HANDOVER reality #63), so RESTRICT is the correct guard for the
 * nullable legs too (it only fires when a matching parent row is deleted).
 * When a real employees/workers table lands (post-Workday-integration), this
 * anchors to it and the candidate/application legs become historical context.
 *
 * `initiation_type` / `status` are text + CHECK (NOT pgEnum) — HANDOVER
 * reality #114 (comparing an enum column against invalid text THROWS in
 * Postgres; text + CHECK compares cleanly and grows with a one-line additive
 * ALTER). Lifecycle (OFFBOARD-02):
 *   initiated → notice_period → clearance → completed
 *                                         ↘ cancelled
 *
 * notice_start_date / last_working_day model the notice clock (requirements
 * §8.1–8.2); both nullable because a just-initiated case may not yet have a
 * confirmed LWD. `reason` is the free-text/dropdown resignation reason.
 *
 * Partial unique (tenant_id, candidate_id) WHERE status <> 'cancelled':
 * at most one live offboarding case per person at a time — a cancelled case
 * (e.g. a withdrawn resignation) leaves the person free to be offboarded
 * again later. Same partial-unique discipline as interviews' active-round.
 *
 * Compound (tenant_id, *) FKs throughout, same discipline as
 * onboarding_cases / offers.
 */
export const offboardingCases = pgTable(
  "offboarding_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    // Employee anchor — see file header.
    candidateId: uuid("candidate_id").notNull(),
    applicationId: uuid("application_id"),
    onboardingCaseId: uuid("onboarding_case_id"),

    initiationType: text("initiation_type").notNull(),
    status: text("status").notNull().default("initiated"),

    noticeStartDate: date("notice_start_date"),
    lastWorkingDay: date("last_working_day"),
    reason: text("reason"),

    initiatedByMembershipId: uuid("initiated_by_membership_id").notNull(),
    managerMembershipId: uuid("manager_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_offboarding_cases_tenant_id_id").on(table.tenantId, table.id),

    // At most one NON-cancelled case per (tenant, candidate). A cancelled
    // case frees the person to be offboarded again later.
    uniqueIndex("uniq_offboarding_cases_active_per_candidate")
      .on(table.tenantId, table.candidateId)
      .where(sql`status <> 'cancelled'`),

    index("idx_offboarding_cases_status").on(table.tenantId, table.status),
    index("idx_offboarding_cases_candidate").on(table.tenantId, table.candidateId),
    index("idx_offboarding_cases_onboarding_case").on(table.tenantId, table.onboardingCaseId),

    check(
      "offboarding_cases_initiation_type_check",
      sql`${table.initiationType} IN ('resignation', 'termination', 'end_of_contract')`,
    ),
    check(
      "offboarding_cases_status_check",
      sql`${table.status} IN ('initiated', 'notice_period', 'clearance', 'completed', 'cancelled')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.candidateId],
      foreignColumns: [candidates.tenantId, candidates.id],
      name: "fk_offboarding_cases_candidate",
    }).onDelete("restrict"),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_offboarding_cases_application",
    }).onDelete("restrict"),

    foreignKey({
      columns: [table.tenantId, table.onboardingCaseId],
      foreignColumns: [onboardingCases.tenantId, onboardingCases.id],
      name: "fk_offboarding_cases_onboarding_case",
    }).onDelete("restrict"),

    foreignKey({
      columns: [table.tenantId, table.initiatedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_offboarding_cases_initiated_by",
    }).onDelete("restrict"),

    foreignKey({
      columns: [table.tenantId, table.managerMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_offboarding_cases_manager",
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

export type OffboardingCase = typeof offboardingCases.$inferSelect;
export type NewOffboardingCase = typeof offboardingCases.$inferInsert;
