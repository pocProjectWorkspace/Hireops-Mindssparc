import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * candidate_field_policy — the REQUIRED-CANDIDATE-FIELD policy (T2.1 / G05).
 *
 * WHY THIS TABLE EXISTS (read this — it is the whole point):
 * The Missing Info tracker classifies SEVEN known candidate-data fields
 * (expected_salary, notice_period, availability_date, work_authorization,
 * current_location, skills_confirmation, education_year). Each field's
 * `requiredness` (required | optional) and the stage a missing REQUIRED field
 * blocks (`blocks_advance_stage`, or none) lived ONLY in a code constant
 * (apps/api/src/lib/missing-info.ts — MISSING_INFO_FIELDS). An org had no way
 * to say which of the seven it actually requires, or what those requirements
 * gate. This table is that config LAYER over the code-owned catalog.
 *
 * CATALOG, NOT INVENTION: the seven field keys are NOT arbitrary — each maps to
 * a specific data source the parser/application already populates. So this table
 * is an OVERRIDE over the fixed seven-field catalog (like the sourcing-channel
 * registry over the application_source enum, or the email-template overrides over
 * the code-owned slot catalog). It NEVER invents new trackable fields; the
 * field_key CHECK pins it to the seven. One row per (tenant, field_key) overrides
 * that field's requiredness + gate for the org; a field with NO row falls back to
 * the code default.
 *
 * HONESTY — tracked vs gated (this is the config-lie class G05 fixes):
 * every one of the seven fields is always TRACKED (surfaced in the recruiter's
 * Missing Info tracker + candidate brief). A field becomes a HARD GATE — advancing
 * a candidate to `blocks_advance_stage` while the field is missing is refused
 * server-side — only when the tenant SAVES a policy row for it. The code-owned
 * catalog defaults are tracking hints, NOT gates, until a tenant opts in by
 * saving them. The admin editor says so; the enforcement (router
 * transitionApplicationStage + the offer-desk offer_drafted transition) honours
 * only saved rows, so tenants without any policy behave byte-identically to today.
 *
 * Tenant-scoped + FORCE RLS + audit trigger (companions in 0098/0099), exactly
 * like every other tenant-editable config table (market_benchmarks pattern) — an
 * admin edit here is audit-worthy.
 *
 * unique (tenant_id, field_key): one policy row per catalog field per tenant —
 * the upsert target for upsertCandidateFieldPolicy and the seed's ON CONFLICT.
 */
export const candidateFieldPolicy = pgTable(
  "candidate_field_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    // The catalog field this policy row overrides. Pinned to the seven known
    // keys by CHECK — an org configures the catalog, it never invents fields.
    fieldKey: text("field_key").notNull(),

    // 'required' | 'optional' — whether the tenant treats this field as required.
    requiredness: text("requiredness").notNull().default("optional"),

    // The application_stage a missing REQUIRED field blocks advancement to, or
    // NULL when the field gates nothing (tracked-only). Text + CHECK (the
    // application_stage pgEnum is the platform key; this is config over it).
    blocksAdvanceStage: text("blocks_advance_stage"),

    // The membership id of the admin who last saved this row (audit convenience;
    // the audit trigger + api_audit_logs are the authoritative record).
    updatedBy: uuid("updated_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_candidate_field_policy_tenant_id_id").on(table.tenantId, table.id),
    // One policy row per catalog field per tenant — the upsert / seed conflict target.
    unique("uniq_candidate_field_policy_tenant_field").on(table.tenantId, table.fieldKey),

    index("idx_candidate_field_policy_tenant").on(table.tenantId),

    check(
      "candidate_field_policy_field_key_check",
      sql`${table.fieldKey} IN ('expected_salary', 'notice_period', 'availability_date', 'work_authorization', 'current_location', 'skills_confirmation', 'education_year')`,
    ),
    check(
      "candidate_field_policy_requiredness_check",
      sql`${table.requiredness} IN ('required', 'optional')`,
    ),
    check(
      "candidate_field_policy_blocks_advance_stage_check",
      sql`${table.blocksAdvanceStage} IS NULL OR ${table.blocksAdvanceStage} IN ('application_received', 'ai_screening', 'recruiter_review', 'shortlisted', 'tech_interview', 'hr_round', 'offer_drafted', 'offer_accepted', 'offer_declined', 'withdrawn', 'recruiter_rejected')`,
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

export type CandidateFieldPolicyRow = typeof candidateFieldPolicy.$inferSelect;
export type NewCandidateFieldPolicyRow = typeof candidateFieldPolicy.$inferInsert;
