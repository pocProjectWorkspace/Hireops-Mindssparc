import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { applications } from "./applications";

/**
 * application_screening_evidence — PC-6 (migration 0124). The per-criterion
 * CV screening evidence for ONE application.
 *
 * Screening shows EVIDENCE, not a score (decision D2). For each requisition
 * criterion (must-have jd_skills + the JD's required-qualification lines) the
 * row holds a verdict (met / partially_met / not_met / unclear), a short
 * reason, and 0–2 VERBATIM CV quotes that were verified against the CV text
 * before being stored (`quotes_dropped` counts the ones that were not). The
 * legacy 0–100 `applications.ai_score` is still written by the same model
 * call, for ordering and back-compat; it is no longer the primary UI.
 *
 * Why a table and not a jsonb column on `applications`: the score lives on
 * applications, but (a) this is derived AI output with its own provenance
 * (model, prompt version, criteria fingerprint) and lifecycle (stale →
 * re-run), the same shape as `ai_interview_evidence`; (b) the four verdict
 * counts are real integer columns so list endpoints can ORDER BY the
 * deterministic evidence sort key in SQL; (c) it keeps this ticket off the
 * applications table, which parallel tickets are migrating.
 *
 * ── status ──────────────────────────────────────────────────────────
 * text + CHECK (NOT pgEnum) — HANDOVER reality #114.
 *   done   evidence matches the requisition's current criteria.
 *   stale  the requisition's criteria changed after this was produced (the
 *          `criteria_fingerprint` no longer matches); the ai_score_outbox row
 *          has been re-queued and the drain will overwrite this row.
 *
 * ── Conventions ─────────────────────────────────────────────────────
 * Compound (tenant_id, application_id) FK → applications, CASCADE (derived
 * data must not outlive its source); ONE row per application; tenant-scoped
 * RLS + FORCE ROW LEVEL SECURITY; audit trigger (AI output about a person).
 */
export const applicationScreeningEvidence = pgTable(
  "application_screening_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),

    /** done | stale. */
    status: text("status").notNull().default("done"),

    /** [{ key, kind, label, verdict, reason, quotes[] }] in criteria order. */
    criteria: jsonb("criteria").notNull().default([]),
    criteriaCount: integer("criteria_count").notNull().default(0),
    metCount: integer("met_count").notNull().default(0),
    partiallyMetCount: integer("partially_met_count").notNull().default(0),
    notMetCount: integer("not_met_count").notNull().default(0),
    unclearCount: integer("unclear_count").notNull().default(0),
    quotesDropped: integer("quotes_dropped").notNull().default(0),

    /** md5 of the requisition's criteria inputs at generation time (see 0124). */
    criteriaFingerprint: text("criteria_fingerprint").notNull(),

    /** Provenance of the generating call. */
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_application_screening_evidence_tenant_id_id").on(table.tenantId, table.id),
    // ONE evidence row per application — the drain's upsert target.
    unique("uniq_application_screening_evidence_per_application").on(
      table.tenantId,
      table.applicationId,
    ),
    check("application_screening_evidence_status_check", sql`${table.status} IN ('done', 'stale')`),
    check(
      "application_screening_evidence_counts_check",
      sql`${table.metCount} >= 0 AND ${table.partiallyMetCount} >= 0 AND ${table.notMetCount} >= 0 AND ${table.unclearCount} >= 0 AND ${table.quotesDropped} >= 0 AND ${table.criteriaCount} = ${table.metCount} + ${table.partiallyMetCount} + ${table.notMetCount} + ${table.unclearCount}`,
    ),
    check(
      "application_screening_evidence_criteria_array_check",
      sql`jsonb_typeof(${table.criteria}) = 'array'`,
    ),
    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_application_screening_evidence_application",
    }).onDelete("cascade"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type ApplicationScreeningEvidence = typeof applicationScreeningEvidence.$inferSelect;
export type NewApplicationScreeningEvidence = typeof applicationScreeningEvidence.$inferInsert;
