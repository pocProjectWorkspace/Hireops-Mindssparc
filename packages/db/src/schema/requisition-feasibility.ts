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
import { requisitions } from "./requisitions";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * requisition_feasibility — the cached, REAL-AI feasibility assessment for a
 * requisition (HRHEAD-02). The prototype's "Feasibility Reports" cards FAKE
 * their fit percentages, difficulty chips, and recommendation prose. We build
 * them honestly: `generateRequisitionFeasibility` builds a structured prompt
 * from the requisition's JD skills + the position's comp band + the matching
 * market_benchmarks row and asks Claude (through @hireops/ai-client's
 * completeStructured, cost-logged to ai_usage_logs) for a structured verdict.
 * That verdict is cached here so the page renders instantly and one card =
 * one stored assessment, refreshed only on an explicit "Generate/Refresh"
 * click (ONE real AI call per click).
 *
 * `assessment` is the structured AI output jsonb (NOT NULL) — shape
 * `{ skillsFit, expCompFit, difficulty, recommendedSalaryAdjustmentPct,
 *    recommendation, supplyNote }` (validated by the api-types zod schema; kept
 * as jsonb here so a prompt-shape evolution doesn't need a migration). `model`
 * + `prompt_version` stamp provenance across a regenerated corpus.
 *
 * unique (tenant_id, requisition_id): ONE assessment per requisition —
 * regenerating REPLACES the row (ON CONFLICT upsert), never appends. This is a
 * derived cache, not an append-only audit log, so replacement is correct.
 *
 * FKs: compound (tenant_id, requisition_id) → requisitions with CASCADE — the
 * assessment is derived data that must not outlive its requisition (unlike the
 * offboarding compliance artifacts which RESTRICT). generated_by_membership_id
 * → tenant_user_memberships with RESTRICT (per the ticket): the actor who ran
 * the generation is a provenance leg that must not be silently nulled.
 *
 * Tenant-scoped + FORCE RLS + audit trigger (companions 0063/0064).
 */
export const requisitionFeasibility = pgTable(
  "requisition_feasibility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    requisitionId: uuid("requisition_id").notNull(),

    assessment: jsonb("assessment").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),

    generatedByMembershipId: uuid("generated_by_membership_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_requisition_feasibility_tenant_id_id").on(table.tenantId, table.id),
    // ONE assessment per requisition — the upsert (regenerate-replaces) target.
    unique("uniq_requisition_feasibility_per_req").on(table.tenantId, table.requisitionId),

    index("idx_requisition_feasibility_req").on(table.tenantId, table.requisitionId),

    foreignKey({
      columns: [table.tenantId, table.requisitionId],
      foreignColumns: [requisitions.tenantId, requisitions.id],
      name: "fk_requisition_feasibility_requisition",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.generatedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_requisition_feasibility_generated_by",
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

export type RequisitionFeasibility = typeof requisitionFeasibility.$inferSelect;
export type NewRequisitionFeasibility = typeof requisitionFeasibility.$inferInsert;
