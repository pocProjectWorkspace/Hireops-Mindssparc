import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * hr_round_assessments — the HR-round behavioural assessment (HROPS-01).
 *
 * One row per (tenant, application): the HR Ops team's deterministic,
 * human-completed record of the HR round for a candidate sitting in (or past)
 * the hr_round stage. No AI — every field is a person's judgement captured
 * verbatim. The six booleans are the standing HR checklist (motivation, salary
 * expectation, culture fit, work authorization, notice period, relocation);
 * `rating` is a 1–5 overall score; `recommendation` is the deterministic gate
 * signal (proceed | hold | reject) the stage-advance rule reads.
 *
 * DETERMINISTIC GATE (read this — it is the point of the table): advancing an
 * application FORWARD out of hr_round (→ offer_drafted) is blocked server-side
 * unless a row exists here with recommendation = 'proceed'. The table is the
 * source of truth for that rule; the router enforces it in
 * transitionApplicationStage.
 *
 * unique (tenant_id, application_id): one live assessment per application — the
 * upsert target for saveHrRoundAssessment. A re-save updates in place (the HR
 * round can be revisited before the candidate advances).
 *
 * `recommendation` is text + CHECK (not pgEnum) — HANDOVER reality #114: an
 * enum column compared against invalid text THROWS in Postgres; text + CHECK
 * compares cleanly and grows with a one-line additive ALTER.
 *
 * Compound tenant FKs throughout (domain-table convention). The membership FK
 * (completed_by) uses onDelete RESTRICT — compound FKs cannot SET NULL (the
 * tenant_id leg is NOT NULL), HANDOVER reality #63, same treatment as
 * offers.drafted_by / interviews.created_by. Tenant-scoped + FORCE RLS + audit
 * trigger (companions in the force-rls / audit-trigger migrations) exactly like
 * every other tenant-editable domain table — an HR assessment is audit-worthy.
 */
export const hrRoundAssessments = pgTable(
  "hr_round_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),

    // The standing HR checklist — six deterministic booleans.
    motivationDiscussed: boolean("motivation_discussed").notNull().default(false),
    salaryExpectationDiscussed: boolean("salary_expectation_discussed").notNull().default(false),
    cultureFitAssessed: boolean("culture_fit_assessed").notNull().default(false),
    workAuthorizationVerified: boolean("work_authorization_verified").notNull().default(false),
    noticePeriodConfirmed: boolean("notice_period_confirmed").notNull().default(false),
    relocationWillingness: boolean("relocation_willingness").notNull().default(false),

    notes: text("notes"),
    // Overall 1–5 HR rating.
    rating: integer("rating").notNull(),
    // Deterministic gate signal — the stage-advance rule reads this.
    recommendation: text("recommendation").notNull(),

    completedByMembershipId: uuid("completed_by_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_round_assessments_tenant_id_id").on(table.tenantId, table.id),
    // One assessment per application per tenant — the upsert conflict target.
    unique("uniq_hr_round_assessments_tenant_application").on(table.tenantId, table.applicationId),

    index("idx_hr_round_assessments_application").on(table.tenantId, table.applicationId),

    check("hr_round_assessments_rating_check", sql`${table.rating} BETWEEN 1 AND 5`),
    check(
      "hr_round_assessments_recommendation_check",
      sql`${table.recommendation} IN ('proceed', 'hold', 'reject')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_hr_round_assessments_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.completedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_hr_round_assessments_completed_by",
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

export type HrRoundAssessment = typeof hrRoundAssessments.$inferSelect;
export type NewHrRoundAssessment = typeof hrRoundAssessments.$inferInsert;
