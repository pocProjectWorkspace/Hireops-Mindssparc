import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { requisitions } from "./requisitions";
import { panelPools } from "./panel-pools";

/**
 * interview_plans — per-requisition round templates (Wave B, INT-01).
 *
 * A requisition owner / recruiter defines the intended interview loop for a
 * role once: an ordered set of rounds, each with a mode, a scorecard
 * template, and the competencies that round probes. When a candidate reaches
 * the interview stage, INT-02 instantiates `interviews` rows FROM these
 * templates — the plan is the blueprint, the interview is the booking.
 *
 * `mode` / `scorecard_template` use the text + CHECK convention (NOT pgEnum),
 * same rationale as onboarding_cases.status / agent_* tables: comparing an
 * enum column against invalid text THROWS in Postgres (HANDOVER reality
 * #114); text + CHECK compares cleanly and grows with a one-line additive
 * ALTER instead of ALTER TYPE.
 *
 * `default_panel_membership_ids` is a DEFAULTS-ONLY hint (which memberships
 * typically staff this round) — the REAL panel is relational, captured per
 * interview on interview_panelists. It is a bare uuid[] (no FK enforcement;
 * it is advisory config, not a referential relationship).
 *
 * Compound (tenant_id, requisition_id) FK — same discipline as the rest of
 * the tenant-scoped schema.
 */
export const interviewPlans = pgTable(
  "interview_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id").notNull(),

    roundNumber: integer("round_number").notNull(),
    roundName: text("round_name").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    mode: text("mode").notNull(),
    scorecardTemplate: text("scorecard_template").notNull(),

    // Competencies this round probes, e.g. ["system_design", "ownership"].
    competencyFocus: jsonb("competency_focus").notNull().default([]),
    // Advisory default panel (config hint only; the real panel is relational
    // on interview_panelists). Bare uuid[] — intentionally NOT FK-enforced.
    defaultPanelMembershipIds: uuid("default_panel_membership_ids").array().notNull().default([]),

    // T3.3 / G16 — provenance link to the panel pool this round's default panel
    // was populated FROM (nullable; null when the round was staffed manually).
    // Compound (tenant_id, panel_pool_id) FK, ON DELETE RESTRICT (pools are
    // archived, never deleted — mirrors positions.comp_band_id).
    panelPoolId: uuid("panel_pool_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_plans_tenant_id_id").on(table.tenantId, table.id),

    // One template per (tenant, requisition, round_number) — the ordered loop.
    unique("uniq_interview_plans_req_round").on(
      table.tenantId,
      table.requisitionId,
      table.roundNumber,
    ),

    index("idx_interview_plans_requisition").on(table.tenantId, table.requisitionId),

    check("interview_plans_mode_check", sql`${table.mode} IN ('video', 'onsite', 'phone')`),
    // T2.2 / G07: RELAXED from the fixed 4-value set to a lax SHAPE check
    // (snake_case, ≤64) so a tenant-defined scorecard key (tenant_scorecard_
    // template) is accepted. The strict membership guard MOVED to the procedure:
    // upsertInterviewPlan / applyInterviewRoundTemplate reject any key not in
    // {4 code defaults} ∪ {the tenant's saved scorecard keys}. The DB shape check
    // backstops garbage/injection; the procedure enforces membership. Migration
    // 0102 swaps the DB constraint.
    check(
      "interview_plans_scorecard_template_check",
      sql`${table.scorecardTemplate} ~ '^[a-z0-9_]{1,64}$'`,
    ),

    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_interview_plans_requisition",
    }).onDelete("cascade"),

    // T3.3 / G16 — provenance link to the panel pool. ON DELETE RESTRICT (pools
    // are archived, never deleted).
    index("idx_interview_plans_panel_pool").on(table.tenantId, table.panelPoolId),
    foreignKey({
      columns: [table.tenantId, table.panelPoolId],
      foreignColumns: [panelPools.tenantId, panelPools.id],
      name: "fk_interview_plans_panel_pool",
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

export type InterviewPlan = typeof interviewPlans.$inferSelect;
export type NewInterviewPlan = typeof interviewPlans.$inferInsert;
