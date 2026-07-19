import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
  index,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { interviews } from "./interviews";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * interview_prep — the cached, REAL-AI interview prep for one interview
 * (PANEL-02). Same honest pattern as requisition_feasibility / comp
 * rationale: `generateInterviewPrep` builds a structured prompt from the JD +
 * skills, the parsed resume, prior-round recommendations + qualitative text
 * (NEVER scores — the anti-anchoring convention), and the round objective, then
 * asks Claude (through @hireops/ai-client's completeStructured, cost-logged to
 * ai_usage_logs) for a structured result. That result is cached here so the
 * brief renders instantly and one interview = one stored prep, refreshed only
 * on an explicit "Generate/Regenerate" click (ONE real AI call per click).
 *
 * `focus_areas` is a jsonb array of { title, why } (3–5 areas to probe);
 * `probing_questions` is a jsonb array of strings (6–8 suggested questions).
 * Kept as jsonb (validated by the api-types zod schema) so a prompt-shape
 * evolution doesn't need a migration. `model` + `prompt_version` stamp
 * provenance across a regenerated corpus.
 *
 * unique (tenant_id, interview_id): ONE prep per interview — regenerating
 * REPLACES the row (ON CONFLICT upsert), never appends. This is a derived
 * cache, not an append-only audit log, so replacement is correct.
 *
 * FKs: compound (tenant_id, interview_id) → interviews with CASCADE — the prep
 * is derived data that must not outlive its interview.
 * generated_by_membership_id → tenant_user_memberships with RESTRICT: the actor
 * who ran the generation is a provenance leg that must not be silently nulled
 * (compound FKs cannot SET NULL — the tenant_id leg is NOT NULL).
 *
 * Tenant-scoped + FORCE RLS + audit trigger (companions 0075/0076).
 */
export const interviewPrep = pgTable(
  "interview_prep",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    interviewId: uuid("interview_id").notNull(),

    focusAreas: jsonb("focus_areas").notNull(),
    probingQuestions: jsonb("probing_questions").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),

    generatedByMembershipId: uuid("generated_by_membership_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_prep_tenant_id_id").on(table.tenantId, table.id),
    // ONE prep per interview — the upsert (regenerate-replaces) target.
    unique("uniq_interview_prep_per_interview").on(table.tenantId, table.interviewId),

    index("idx_interview_prep_interview").on(table.tenantId, table.interviewId),

    foreignKey({
      columns: [table.tenantId, table.interviewId],
      foreignColumns: [interviews.tenantId, interviews.id],
      name: "fk_interview_prep_interview",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.generatedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_interview_prep_generated_by",
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

export type InterviewPrep = typeof interviewPrep.$inferSelect;
export type NewInterviewPrep = typeof interviewPrep.$inferInsert;
