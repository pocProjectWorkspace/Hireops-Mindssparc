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
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * tenant_interview_round_template — the org's DEFAULT interview loop (T2.2 / G07).
 *
 * WHY THIS TABLE EXISTS (read this — it is half of the T2.2 gap):
 * `interview_plans` is PER-REQUISITION: a recruiter authors the ordered loop on
 * each req from scratch (upsertInterviewPlan). There was NO tenant-level default
 * loop to SEED a new req from. This table is that default — ordered rounds the
 * `applyInterviewRoundTemplate` procedure copies into a requisition's
 * interview_plans.
 *
 * HONESTY — genuinely CONSUMED, real fallback: applyInterviewRoundTemplate READS
 * these rows and WRITES interview_plans (a real seed, not a stored-and-ignored
 * knob). A tenant with NO template rows gets applied:false and builds the plan
 * from scratch exactly as today (byte-identical fallback).
 *
 * `scorecardTemplateKey` is text with a lax SHAPE check only (snake_case, ≤64):
 * it may name one of the 4 code-default scorecards OR a tenant-defined scorecard
 * key (tenant_scorecard_template). Membership in {4 defaults} ∪ {tenant's saved
 * keys} is enforced at WRITE by the procedure — the DB shape check backstops
 * garbage/injection, the procedure rejects unknown keys.
 *
 * `mode` uses text + CHECK (NOT pgEnum) — HANDOVER reality #114.
 *
 * One row per (tenant, round_number) — the ordered loop, the replace-set / seed
 * conflict target. Tenant-scoped + FORCE RLS + audit trigger (companions in
 * 0103), like every tenant-editable config table (market_benchmarks pattern).
 */
export const tenantInterviewRoundTemplate = pgTable(
  "tenant_interview_round_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    roundNumber: integer("round_number").notNull(),
    roundName: text("round_name").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    mode: text("mode").notNull().default("video"),
    // A scorecard key — one of the 4 code defaults OR a tenant custom key. Lax
    // shape check here; membership is enforced in the procedure at write.
    scorecardTemplateKey: text("scorecard_template_key").notNull(),

    // Competencies this round probes, e.g. ["system_design", "ownership"].
    competencyFocus: jsonb("competency_focus").notNull().default([]),

    // Membership id of the admin who last saved this row (audit convenience; the
    // audit trigger + api_audit_logs are the authoritative record).
    updatedBy: uuid("updated_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_tenant_interview_round_template_tenant_id_id").on(table.tenantId, table.id),
    // One template row per round per tenant — the seed / replace-set conflict target.
    unique("uniq_tenant_interview_round_template_tenant_round").on(
      table.tenantId,
      table.roundNumber,
    ),

    index("idx_tenant_interview_round_template_tenant").on(table.tenantId),

    check(
      "tenant_interview_round_template_mode_check",
      sql`${table.mode} IN ('video', 'onsite', 'phone')`,
    ),
    check(
      "tenant_interview_round_template_scorecard_key_check",
      sql`${table.scorecardTemplateKey} ~ '^[a-z0-9_]{1,64}$'`,
    ),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type TenantInterviewRoundTemplateRow = typeof tenantInterviewRoundTemplate.$inferSelect;
export type NewTenantInterviewRoundTemplateRow = typeof tenantInterviewRoundTemplate.$inferInsert;
