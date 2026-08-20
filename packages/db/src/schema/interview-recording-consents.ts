import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  customType,
  unique,
  index,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { interviews } from "./interviews";

// inet narrow type, same shape as audit_logs.ip_address / signed_link_uses.
const inet = customType<{ data: string; default: false }>({
  dataType() {
    return "inet";
  },
});

/**
 * interview_recording_consents — the append-only consent event log for
 * interview recording (notetaker phase, N1 / migration 0116).
 *
 * This is the table the "no consent → no recording" rule reads. It is
 * deliberately NOT modelled on `signed_link_uses`, even though the capture
 * seam is the same candidate interview-confirm signed link: that table's
 * PARTIAL UNIQUE (successful = true) makes a redemption single-use and
 * TERMINAL, which is precisely the wrong shape for a permission the
 * candidate must be able to take back.
 *
 * The three properties this shape encodes:
 *
 *   PER-INTERVIEW. Consent attaches to one interview round, not to the
 *   candidate or the application. Agreeing to have a screening call
 *   recorded is not agreeing to have every future round recorded.
 *
 *   PURPOSE-SCOPED BY CONSTRUCTION. `purpose` is CHECKed to the single
 *   value 'interview_recording'. A row here cannot be quietly reused to
 *   authorise anything else; widening it is a deliberate CHECK edit in a
 *   future migration, visible in review.
 *
 *   WITHDRAWABLE. A withdrawal is a NEW ROW (decision = 'withdrawn'), not
 *   an UPDATE of the granting row. Hence there is deliberately NO unique on
 *   (tenant_id, interview_id) — multiple rows per interview is the entire
 *   point, and the EFFECTIVE state is the latest row by `created_at`. The
 *   (tenant_id, interview_id, created_at DESC) index makes that read a
 *   single index lookup, because it sits on the hot path of every capture
 *   decision.
 *
 * There is no verbal-attestation column and no "recruiter asserts consent"
 * path — that is the point of decision 3, not an unfinished shape. Note
 * also that consent is necessary but NOT sufficient: the recruiter's own
 * `interviews.recording_requested` toggle must also be true.
 *
 * RLS: SPLIT policies (tenant_isolation_select + tenant_isolation_insert)
 * with no UPDATE and no DELETE policy, so under FORCE RLS an attempt to
 * mutate history from `authenticated` matches no policy and affects zero
 * rows. Same treatment as signed_link_uses / candidate_dedup_attempts /
 * api_audit_logs / *_state_transitions. Append-onlyness is therefore a
 * database guarantee here, not a convention the writing code observes.
 *
 * No audit trigger attached — this IS the consent log, and every row in it
 * is immutable; auditing immutable inserts is noise (the documented
 * exclusion alongside the outbox tables and the state-transition logs).
 * The two facts compose deliberately: a log that could be silently edited
 * AND carried no audit trail would be evidence-free, which is why the RLS
 * above is split rather than FOR ALL.
 *
 * FK: compound (tenant_id, interview_id) → interviews with CASCADE. A
 * consent record for a deleted interview has nothing left to authorise.
 */
export const interviewRecordingConsents = pgTable(
  "interview_recording_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    interviewId: uuid("interview_id").notNull(),

    /** 'granted' | 'declined' | 'withdrawn' — latest row by createdAt wins. */
    decision: text("decision").notNull(),
    /** CHECKed to 'interview_recording' — see the header on purpose-scoping. */
    purpose: text("purpose").notNull().default("interview_recording"),
    /** The disclosure copy version the candidate actually saw. */
    consentVersion: text("consent_version").notNull(),
    /**
     * Capture seam. 'candidate_confirm_link' = the candidate's own click on
     * the signed confirm page. 'internal_revocation' (added by migration
     * 0117, N2a) = a recruiter/HR-ops staff member recording a WITHDRAWAL on
     * the candidate's behalf, because the signed link expires but the right
     * to withdraw does not. The two values stay distinct so a staff-actioned
     * row is never indistinguishable from one the candidate created.
     */
    capturedVia: text("captured_via").notNull(),

    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_interview_recording_consents_tenant_id_id").on(table.tenantId, table.id),

    // NO unique on (tenantId, interviewId) — withdrawability depends on it.
    // "Current consent" = ORDER BY created_at DESC LIMIT 1, served here.
    index("idx_interview_recording_consents_current").on(
      table.tenantId,
      table.interviewId,
      table.createdAt.desc(),
    ),

    check(
      "interview_recording_consents_decision_check",
      sql`${table.decision} IN ('granted', 'declined', 'withdrawn')`,
    ),
    check(
      "interview_recording_consents_purpose_check",
      sql`${table.purpose} = 'interview_recording'`,
    ),
    // 0117 (N2a) widened this from the single 'candidate_confirm_link'. Note
    // what it does NOT widen: `decision` is untouched, and the internal path
    // hard-codes 'withdrawn', so there is still no seam by which staff can
    // manufacture a GRANT on a candidate's behalf.
    check(
      "interview_recording_consents_captured_via_check",
      sql`${table.capturedVia} IN ('candidate_confirm_link', 'internal_revocation')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.interviewId],
      foreignColumns: [interviews.tenantId, interviews.id],
      name: "fk_interview_recording_consents_interview",
    }).onDelete("cascade"),

    pgPolicy("tenant_isolation_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
    }),
    pgPolicy("tenant_isolation_insert", {
      as: "permissive",
      for: "insert",
      to: ["authenticated"],
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
    // No UPDATE / DELETE policies — append-only under FORCE RLS.
  ],
).enableRLS();

export type InterviewRecordingConsent = typeof interviewRecordingConsents.$inferSelect;
export type NewInterviewRecordingConsent = typeof interviewRecordingConsents.$inferInsert;
