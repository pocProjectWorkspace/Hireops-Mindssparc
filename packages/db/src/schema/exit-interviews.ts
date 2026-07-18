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
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { offboardingCases } from "./offboarding-cases";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * exit_interviews — one structured + free-text exit interview per case
 * (architecture.md §5.1 "structured + free text"; requirements.md §8.3
 * "Online questionnaire + optional 1:1 with HR. Themes captured,
 * anonymisable for analytics").
 *
 * `structured_responses` holds the questionnaire answers as jsonb (schema
 * of questions is app/template-driven, not modelled per-column). `free_text`
 * is the open commentary the §8.4 LLM theme-clustering reads. `submitted_at`
 * distinguishes a scheduled-but-not-yet-conducted interview (null) from a
 * completed one.
 *
 * unique (tenant_id, case_id): exactly one exit interview per offboarding
 * case.
 */
export const exitInterviews = pgTable(
  "exit_interviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),

    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    conductedByMembershipId: uuid("conducted_by_membership_id"),

    structuredResponses: jsonb("structured_responses").notNull().default({}),
    freeText: text("free_text"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_exit_interviews_tenant_id_id").on(table.tenantId, table.id),
    // One exit interview per offboarding case.
    unique("uniq_exit_interviews_tenant_case").on(table.tenantId, table.caseId),

    index("idx_exit_interviews_case").on(table.tenantId, table.caseId),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [offboardingCases.tenantId, offboardingCases.id],
      name: "fk_exit_interviews_case",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.conductedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_exit_interviews_conducted_by",
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

export type ExitInterview = typeof exitInterviews.$inferSelect;
export type NewExitInterview = typeof exitInterviews.$inferInsert;
