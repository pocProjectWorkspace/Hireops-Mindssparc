import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
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
import { offboardingCases } from "./offboarding-cases";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * final_settlements — full-and-final (F&F) settlement record for a departure
 * (architecture.md §5.1 "final_settlements — F&F calculation rows";
 * requirements.md §8.2 "Salary + leave encashment + bonus pro-rata − loans −
 * notice-shortfall" and §8.3 "final settlement is released" after hardware
 * return).
 *
 * SIMULATED PAYROLL (flagged): HireOps has no real payment rails. These
 * columns model the SETTLEMENT RECORD (the calculation + approval + paid
 * marker), NOT a money transfer. Same posture as the Workday hire/terminate
 * simulator.
 *
 * `amount_minor` is the net settlement in minor currency units (paise/cents)
 * — bigint for headroom, matching offers.base_salary_inr_paise. Nullable +
 * `currency` char(3) nullable because a freshly-opened settlement is not yet
 * calculated. `breakdown` jsonb holds the itemised lines
 * (salary/leave/bonus/deductions).
 *
 * `status` text + CHECK (NOT pgEnum) — HANDOVER reality #114. Lifecycle:
 *   pending → calculated → approved → paid
 *
 * unique (tenant_id, case_id): exactly one F&F settlement per case.
 */
export const finalSettlements = pgTable(
  "final_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),

    status: text("status").notNull().default("pending"),

    // Net settlement in minor units (paise/cents) — simulated, see header.
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    currency: char("currency", { length: 3 }),
    breakdown: jsonb("breakdown").notNull().default({}),

    approvedByMembershipId: uuid("approved_by_membership_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_final_settlements_tenant_id_id").on(table.tenantId, table.id),
    // One final settlement per offboarding case.
    unique("uniq_final_settlements_tenant_case").on(table.tenantId, table.caseId),

    index("idx_final_settlements_status").on(table.tenantId, table.status),

    check(
      "final_settlements_status_check",
      sql`${table.status} IN ('pending', 'calculated', 'approved', 'paid')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [offboardingCases.tenantId, offboardingCases.id],
      name: "fk_final_settlements_case",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.approvedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_final_settlements_approved_by",
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

export type FinalSettlement = typeof finalSettlements.$inferSelect;
export type NewFinalSettlement = typeof finalSettlements.$inferInsert;
