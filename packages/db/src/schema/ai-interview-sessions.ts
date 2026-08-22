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
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { interviews } from "./interviews";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * ai_interview_sessions — the asynchronous AI first-round interview attached
 * to ONE interview round (build plan phase N4 / migration 0119).
 *
 * The AI round IS a round. It is an `interviews` row whose `mode` is
 * 'ai_async' (widened by 0119 across interviews / interview_plans /
 * tenant_interview_round_template and `interviewModeSchema`), NOT a separate
 * pre-interview screening entity. That choice is what makes it inherit,
 * unchanged: the plan → interview instantiation path, `completed_at` /
 * `cancelled_at` (0115) and the interview-health reports that read them, the
 * consent resolver, the recording → transcript → notes chain (0116) and the
 * 30-day media retention sweep (0118). A parallel entity would have been
 * excluded from every one of those on day one.
 *
 * Asynchronous and STRUCTURED: a fixed question set, one question at a time,
 * voice answers with a typed fallback (which is also the accessibility
 * answer). No real-time duplex voice, no turn-taking, no telephony — that is
 * a later phase and would be a DIFFERENT mode value, not a redefinition of
 * this one.
 *
 * ── NOTE THE ABSENCE ────────────────────────────────────────────────
 * There is NO score, NO rating, NO ranking, NO recommendation, NO pass/fail,
 * NO sentiment and NO confidence column here, and there must never be one.
 * 0116 set the precedent on interview_notes and said so in the DDL; an AI
 * that CONDUCTS the round makes it load-bearing rather than merely
 * principled. The product position is: THE AI ROUND PRODUCES EVIDENCE; A
 * HUMAN ADVANCES OR REJECTS. GDPR Art. 22 forbids a decision based solely on
 * automated processing with legal or similarly significant effect, and the
 * EU AI Act puts candidate filtering in Annex III. The same clause bans
 * inference beyond the words — no psychometric, personality, fluency or
 * demographic derivation from voice, video or text. This is a product stance,
 * not an unfinished schema, and a future ticket must not read the omission as
 * a gap to fill.
 *
 * ── The status ladder ───────────────────────────────────────────────
 * `status` uses the text + CHECK convention (NOT pgEnum) — HANDOVER reality
 * #114.
 *
 *   draft        questions generated, not yet seen or approved by a human;
 *                regenerating replaces them and nothing has been issued.
 *   approved     a named recruiter approved the set. This is the instant the
 *                questions FREEZE (`questionsFrozenAt`).
 *   issued       the signed link exists and the invite has gone out.
 *   in_progress  the candidate opened the link and started answering.
 *   submitted    finished; answers stitched into the recording and the
 *                transcript_outbox row enqueued. The only success terminal.
 *   expired      `expiresAt` passed with no submission. Terminal.
 *   cancelled    pulled, or the round was cancelled. Terminal, and reachable
 *                from 'draft', which is why the approval CHECK exempts it.
 *
 * It tracks the SESSION, not the interview: `interviews.status` remains the
 * authority on the round. A 'submitted' session on a 'scheduled' interview is
 * the normal shape between the candidate finishing and a human reviewing.
 *
 * ── The shapes ──────────────────────────────────────────────────────
 * `questions` is an ordered jsonb array, one entry per question, each
 * carrying the question text AND THE RUBRIC KEY IT PROBES. That key maps onto
 * interviews.scorecard_criteria_snapshot (0102) — the resolved, ordered
 * [{key,label}] a HUMAN panellist is scored against, frozen at schedule time.
 * Reusing it instead of inventing a parallel vocabulary is what lets the
 * evidence report speak in the same terms as a human scorecard, and inherits
 * 0102's anti-drift guarantee. NOT NULL with no default: the row is created
 * BY the generation call, so an empty array could only ever be a lie.
 *
 * `turnState` is per-answer capture bookkeeping — which question the
 * candidate is on, what has been captured, what failed and was retried. jsonb
 * for interview_prep's reason and more strongly: its shape will move while
 * the candidate surface is built, and none of that is worth a migration.
 *
 * `questionsFrozenAt` is the discriminator between "generated but not yet
 * approved" and "frozen and issued", stamped at draft → approved because
 * approval is what makes the set immutable. It looks redundant with
 * `approvedAt` and is not: `approvedAt` answers "when did a human say yes",
 * `questionsFrozenAt` answers "from when is this content immutable". The
 * approval CHECK turns the pairing into a database guarantee — no session can
 * reach a state a candidate can see without a NAMED HUMAN having approved the
 * questions.
 *
 * `linkTokenHash` is SHA-256 ONLY. The raw token lives in the invitation
 * email and nowhere else, exactly as interviews.confirm_signed_link_token_hash
 * (0054), with the same partial index for the unauthenticated lookup.
 * Single-use redemption stays in `signed_link_uses`; this is the lookup key,
 * not the redemption log.
 *
 * `model` + `promptVersion` stamp the QUESTION GENERATION only, per
 * interview_prep's provenance convention. The evidence report's provenance is
 * stamped on interview_notes, by a separate call under a separate feature key.
 *
 * ── Conventions ─────────────────────────────────────────────────────
 * Composite (tenant_id, id) unique so the row can be a compound-FK target;
 * compound (tenant_id, interview_id) FK → interviews with CASCADE (a session
 * is derived data that must not outlive its round); tenant-scoped RLS + FORCE
 * ROW LEVEL SECURITY; and an audit trigger, because unlike the consent log
 * and the outbox tables this is MUTABLE GOVERNED STATE — an approval, a
 * freeze and a status that walks a ladder are exactly the facts a regulator
 * or a rejected candidate would ask about.
 *
 * `approvedByMembershipId` is a provenance leg and therefore RESTRICT, not
 * SET NULL (compound FKs cannot SET NULL — the tenant_id leg is NOT NULL, so
 * per HANDOVER reality #63 we RESTRICT rather than erase WHO approved a
 * question set that was put to a candidate). It is nullable for the draft
 * state; a compound FK is MATCH SIMPLE, so a NULL leg leaves the constraint
 * unchecked for that row — the interview_plans.panel_pool_id precedent.
 *
 * Deliberately NOT changed by 0119: uniq_interview_recordings_per_interview.
 * One AI round still produces ONE recording; per-question boundaries live in
 * interview_transcripts.segments, which already carries startMs/endMs.
 */
export const aiInterviewSessions = pgTable(
  "ai_interview_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    interviewId: uuid("interview_id").notNull(),

    /** draft → approved → issued → in_progress → submitted; expired / cancelled terminal. */
    status: text("status").notNull().default("draft"),

    /** Ordered [{ key, prompt, rubricKey, ... }] — see the header. */
    questions: jsonb("questions").notNull(),
    /** Stamped at draft → approved: from here the question set is immutable. */
    questionsFrozenAt: timestamp("questions_frozen_at", { withTimezone: true }),

    /** Provenance: WHO approved the questions that were put to the candidate. */
    approvedByMembershipId: uuid("approved_by_membership_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),

    /** Per-answer capture bookkeeping; '{}' is the honest empty state. */
    turnState: jsonb("turn_state").notNull().default({}),

    /** SHA-256 of the candidate's signed link. Never the raw token. */
    linkTokenHash: text("link_token_hash"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),

    /** Provenance of the QUESTION GENERATION call only. */
    model: text("model"),
    promptVersion: text("prompt_version"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_ai_interview_sessions_tenant_id_id").on(table.tenantId, table.id),
    // ONE session per AI round — the uniq_interview_recordings_per_interview
    // rationale: nothing downstream should have to pick which one is "the" one.
    unique("uniq_ai_interview_sessions_per_interview").on(table.tenantId, table.interviewId),

    // Recruiter worklist: what is awaiting approval / still in flight.
    index("idx_ai_interview_sessions_status").on(table.tenantId, table.status),
    // The unauthenticated candidate route resolves the tenant FROM the hash,
    // so tenant_id cannot lead. Partial for the same reason
    // idx_interviews_confirm_token_hash is (0054).
    index("idx_ai_interview_sessions_link_token_hash")
      .on(table.linkTokenHash)
      .where(sql`link_token_hash IS NOT NULL`),

    check(
      "ai_interview_sessions_status_check",
      sql`${table.status} IN ('draft', 'approved', 'issued', 'in_progress', 'submitted', 'expired', 'cancelled')`,
    ),
    // THE APPROVAL GATE, in the database rather than only in the procedure a
    // later ticket could route around: no session leaves 'draft' for any state
    // a candidate can see without a named human having approved the question
    // set, and the set freezing at that moment. 'cancelled' is exempt — a
    // draft can legitimately be abandoned before anyone approves it.
    check(
      "ai_interview_sessions_approval_check",
      sql`${table.status} IN ('draft', 'cancelled')
		OR (${table.approvedByMembershipId} IS NOT NULL AND ${table.approvedAt} IS NOT NULL AND ${table.questionsFrozenAt} IS NOT NULL)`,
    ),
    // 'issued' and everything after it means a link exists, so a session can
    // never claim to have been sent with nothing for the candidate to open.
    check(
      "ai_interview_sessions_issued_link_check",
      sql`${table.status} NOT IN ('issued', 'in_progress', 'submitted')
		OR ${table.linkTokenHash} IS NOT NULL`,
    ),

    foreignKey({
      columns: [table.tenantId, table.interviewId],
      foreignColumns: [interviews.tenantId, interviews.id],
      name: "fk_ai_interview_sessions_interview",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.approvedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_ai_interview_sessions_approved_by",
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

export type AiInterviewSession = typeof aiInterviewSessions.$inferSelect;
export type NewAiInterviewSession = typeof aiInterviewSessions.$inferInsert;
