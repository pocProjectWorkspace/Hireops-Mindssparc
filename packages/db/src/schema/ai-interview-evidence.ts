import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  unique,
  index,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { interviews } from "./interviews";
import { aiInterviewSessions } from "./ai-interview-sessions";

/**
 * ai_interview_evidence — the evidence report for ONE submitted AI interview
 * session (migration 0121). SKELETON: the table ships with AI-INT-1 so the
 * schema step is applied once; the drain worker that claims and fills rows
 * is the next ticket, and nothing writes here yet.
 *
 * ── NOTE THE ABSENCE ────────────────────────────────────────────────
 * EVIDENCE ONLY, BY DESIGN. There is NO score, NO rating, NO ranking, NO
 * recommendation and NO pass/fail column here, and there must never be one
 * (build plan §5: THE AI ROUND PRODUCES EVIDENCE; A HUMAN ADVANCES OR
 * REJECTS). `evidence` holds what the candidate said, organised against the
 * rubric keys — not a verdict on it. See the ai_interview_sessions header for
 * the GDPR Art. 22 / EU AI Act reasoning. A future ticket must not read the
 * omission as a gap to fill.
 *
 * ── The status ladder ───────────────────────────────────────────────
 * text + CHECK (NOT pgEnum) — HANDOVER reality #114.
 *
 *   pending     enqueued on submit, awaiting a worker.
 *   processing  claimed; `leaseExpiresAt` bounds the claim so a crashed
 *               worker's row becomes claimable again.
 *   done        `evidence` written, provenance stamped.
 *   failed      gave up after retries; `lastError` says why.
 *   skipped     nothing to generate from (e.g. no usable answers).
 *
 * `model` + `promptVersion` stamp the EVIDENCE generation call, distinct from
 * the question-generation provenance on ai_interview_sessions.
 *
 * ── Conventions ─────────────────────────────────────────────────────
 * Compound (tenant_id, session_id) FK onto the session and compound
 * (tenant_id, interview_id) FK onto the round, both CASCADE (derived data
 * must not outlive its source); ONE row per session; tenant-scoped RLS +
 * FORCE ROW LEVEL SECURITY; audit trigger (governed state).
 */
export const aiInterviewEvidence = pgTable(
  "ai_interview_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    sessionId: uuid("session_id").notNull(),
    interviewId: uuid("interview_id").notNull(),

    /** pending → processing → done | failed | skipped. */
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    /** Bounds a 'processing' claim; an expired lease is claimable again. */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),

    /** The evidence report. NULL until generated. Evidence only — no verdict. */
    evidence: jsonb("evidence"),

    /** Provenance of the EVIDENCE generation call. */
    model: text("model"),
    promptVersion: text("prompt_version"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_ai_interview_evidence_tenant_id_id").on(table.tenantId, table.id),
    // ONE evidence row per session.
    unique("uniq_ai_interview_evidence_per_session").on(table.tenantId, table.sessionId),

    // The drain claim. Cross-tenant (service-role worker), so tenant_id does
    // not lead.
    index("idx_ai_interview_evidence_drain").on(table.status, table.leaseExpiresAt),

    check(
      "ai_interview_evidence_status_check",
      sql`${table.status} IN ('pending', 'processing', 'done', 'failed', 'skipped')`,
    ),
    check("ai_interview_evidence_attempt_count_check", sql`${table.attemptCount} >= 0`),

    foreignKey({
      columns: [table.tenantId, table.sessionId],
      foreignColumns: [aiInterviewSessions.tenantId, aiInterviewSessions.id],
      name: "fk_ai_interview_evidence_session",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.interviewId],
      foreignColumns: [interviews.tenantId, interviews.id],
      name: "fk_ai_interview_evidence_interview",
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

export type AiInterviewEvidence = typeof aiInterviewEvidence.$inferSelect;
export type NewAiInterviewEvidence = typeof aiInterviewEvidence.$inferInsert;
