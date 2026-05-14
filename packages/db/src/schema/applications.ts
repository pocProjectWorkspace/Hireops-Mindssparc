import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { candidates } from "./candidates";
import { requisitions } from "./requisitions";
import { tenantUserMemberships } from "./tenant-user-memberships";
import { applicationSourceEnum } from "./application-source";
import { applicationStageEnum } from "./application-stage";

/**
 * Per-submission-to-a-requisition row. The central table of the
 * recruitment lifecycle.
 *
 * Source is stored explicitly even though it usually mirrors the
 * candidate's source on first insert, because a single candidate can
 * apply to multiple reqs via different channels (referral for one, job
 * board for another).
 *
 * source_partner_id / submitted_by_partner_user_id reference the partner
 * tables that DB-PARTNER will introduce. Those FKs are intentionally NOT
 * enforced here — the columns exist and are indexed, but the constraints
 * land with the partner schema.
 *
 * RLS: standard tenant_isolation. Trigger: audit_record_change() fires.
 */
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id").notNull(),
    requisitionId: uuid("requisition_id").notNull(),
    source: applicationSourceEnum("source").notNull(),
    currentStage: applicationStageEnum("current_stage").notNull().default("application_received"),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
    assignedRecruiterMembershipId: uuid("assigned_recruiter_membership_id"),
    aiScore: numeric("ai_score", { precision: 5, scale: 2 }),
    aiScoreExplanation: jsonb("ai_score_explanation"),
    aiScoredAt: timestamp("ai_scored_at", { withTimezone: true }),
    knockoutPassed: boolean("knockout_passed"),
    knockoutEvaluatedAt: timestamp("knockout_evaluated_at", { withTimezone: true }),
    knockoutFailures: jsonb("knockout_failures"),
    // FKs deferred to DB-PARTNER — the columns + indexes are pre-wired so
    // queries land cleanly when partners ship; the constraints are added
    // by the partner-schema migration.
    sourcePartnerId: uuid("source_partner_id"),
    submittedByPartnerUserId: uuid("submitted_by_partner_user_id"),
    partnerSubmissionMetadata: jsonb("partner_submission_metadata"),
    triageDecisionAt: timestamp("triage_decision_at", { withTimezone: true }),
    triageDecisionReason: text("triage_decision_reason"),
    withdrawnReason: text("withdrawn_reason"),
    rejectedReason: text("rejected_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_applications_tenant_id_id").on(table.tenantId, table.id),
    // Hard uniqueness: a candidate can't apply to the same req twice in
    // Wave 1. Withdraw-and-reapply is a Wave 2 flow that may either lift
    // this constraint or model re-apply as a new candidate row.
    unique("uniq_applications_candidate_req").on(
      table.tenantId,
      table.candidateId,
      table.requisitionId,
    ),
    // Pipeline-view per requisition.
    index("idx_applications_req_stage").on(table.tenantId, table.requisitionId, table.currentStage),
    // Recruiter dashboard ("my pipeline by stage").
    index("idx_applications_recruiter_stage").on(
      table.tenantId,
      table.assignedRecruiterMembershipId,
      table.currentStage,
    ),
    // Candidate cross-req view ("what reqs has this candidate applied to").
    index("idx_applications_candidate").on(table.tenantId, table.candidateId),
    // Partner dashboard. Partial: only rows with a partner attribution.
    index("idx_applications_partner")
      .on(table.tenantId, table.sourcePartnerId, table.createdAt)
      .where(sql`source_partner_id IS NOT NULL`),
    // SLA breach detection — "stuck in stage X for > N hours".
    index("idx_applications_sla").on(table.tenantId, table.currentStage, table.stageEnteredAt),
    // Score-sorted shortlist. Partial: skip un-scored rows.
    index("idx_applications_ai_score")
      .on(table.tenantId, table.aiScore)
      .where(sql`ai_score IS NOT NULL`),
    // Compound FKs — domain-table convention.
    foreignKey({
      columns: [table.tenantId, table.candidateId],
      foreignColumns: [candidates.tenantId, candidates.id],
      name: "fk_applications_candidate",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_applications_requisition",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.assignedRecruiterMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_applications_assigned_recruiter",
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

export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
