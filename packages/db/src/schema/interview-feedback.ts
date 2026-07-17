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
import { interviews } from "./interviews";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * interview_feedback — one scorecard per (interview, panelist) (Wave B,
 * INT-01). Draft-capable: `recommendation` and `submitted_at` stay NULL
 * until the panelist submits, so a partial scorecard can be saved.
 *
 * `scorecard` jsonb carries the criteria→score map (1..5 per competency);
 * its shape is enforced at the API layer (INT-03/04), not here — the schema
 * only guarantees a non-null object default.
 *
 * `recommendation` is THE single interview-recommendation vocabulary —
 * `strong_yes | yes | hold | no` — standardised in the gap audit (§5); the
 * prototype carried three inconsistent vocabularies and we collapse them to
 * this one everywhere. NULL until submitted (text + CHECK passes on NULL).
 *
 * Both compound FKs; the membership (panelist) FK uses onDelete RESTRICT
 * (compound FKs cannot SET NULL — HANDOVER reality #63). The interview FK
 * cascades.
 */
export const interviewFeedback = pgTable(
  "interview_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    interviewId: uuid("interview_id").notNull(),
    membershipId: uuid("membership_id").notNull(),

    // criteria → 1..5 scores; shape enforced at the API layer (INT-03/04).
    scorecard: jsonb("scorecard").notNull().default({}),
    strengths: text("strengths"),
    concerns: text("concerns"),
    notes: text("notes"),

    // THE single recommendation vocabulary (gap-audit §5). NULL until submitted.
    recommendation: text("recommendation"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_feedback_tenant_id_id").on(table.tenantId, table.id),

    // One scorecard per panelist per interview.
    unique("uniq_interview_feedback_interview_membership").on(
      table.tenantId,
      table.interviewId,
      table.membershipId,
    ),

    index("idx_interview_feedback_interview").on(table.tenantId, table.interviewId),

    check(
      "interview_feedback_recommendation_check",
      sql`${table.recommendation} IN ('strong_yes', 'yes', 'hold', 'no')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.interviewId],
      foreignColumns: [interviews.tenantId, interviews.id],
      name: "fk_interview_feedback_interview",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_interview_feedback_membership",
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

export type InterviewFeedback = typeof interviewFeedback.$inferSelect;
export type NewInterviewFeedback = typeof interviewFeedback.$inferInsert;
