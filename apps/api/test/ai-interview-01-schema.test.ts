/**
 * N4.1 — DB-level constraint tests for the asynchronous AI first-round
 * interview (migration 0119: three CHECK widenings + ai_interview_sessions).
 *
 * Schema-only phase — no procedures, no candidate surface, no prompts and no
 * AI call (those are N4.2–N4.5) — so this suite is deliberately raw SQL
 * against the tables, the same shape notetaker-01 used for 0116.
 *
 * GATED ON MIGRATION 0119. The migration is authored here but the HUMAN
 * applies it, so every case reads the catalog first and branches: before 0119
 * it asserts the PRE-migration reality (the widened values are rejected, the
 * table is absent), after 0119 it asserts the real behaviour. No edit is
 * needed when the migration lands — the discipline notetaker-02a used for the
 * unapplied 0117 and notetaker-06 for 0118. READ THE SKIP LINES: a green run
 * on an unmigrated database is NOT evidence any of this works.
 *
 * What each case protects:
 *
 *   1. 'ai_async' is accepted by ALL THREE mode CHECKs — interviews,
 *      interview_plans and tenant_interview_round_template. They constrain
 *      one vocabulary along a path the product walks (tenant default round →
 *      plan round → booked interview), so a partial widening is a bug that
 *      only shows up at the third step. The control assertion — an
 *      unrelated value is STILL rejected — is what distinguishes "widened"
 *      from "someone dropped the CHECK".
 *   2. interview_recordings.source accepts 'ai_interview' and
 *      interview_recording_consents.captured_via accepts 'ai_interview_link',
 *      with the same control. Consent captured on the AI round's entry screen
 *      must stay distinguishable from consent clicked on the confirm page
 *      (0117's honesty-of-provenance argument).
 *   3. ONE session per interview: the second insert is rejected 23505.
 *   4. Deleting an interview CASCADEs its session — a session is derived data
 *      describing one round and must not outlive it.
 *   5. THE GOVERNANCE GUARD. ai_interview_sessions carries no column whose
 *      name contains score / rating / recommendation / verdict / sentiment.
 *      The AI round produces EVIDENCE; a human advances or rejects. That
 *      omission is a product stance (GDPR Art. 22, EU AI Act Annex III), so
 *      it is asserted rather than trusted to a comment — exactly as
 *      notetaker-01 test 5 and notetaker-08 test 4 do for the notes.
 *   6. The approval gate holds in the DATABASE: a session cannot reach a
 *      state the candidate can see without a named human approval and a
 *      frozen question set.
 *
 * Runs entirely inside its own synthetic tenant (n119 namespace, RUN-suffixed
 * slugs/emails) via poolSql, so it touches no demo data and needs no JWT.
 * REQUIRES migrations 0116 + 0117 + 0118 to have been applied.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { sql as poolSql } from "@hireops/db";

// Fixed synthetic ids (119 namespace — hex only; raw SQL, no Zod in the way).
const T = "00000000-0000-4000-8000-000000119001";
const BU = "00000000-0000-4000-8000-000000119002";
const POSITION = "00000000-0000-4000-8000-000000119003";
const JD = "00000000-0000-4000-8000-000000119004";
const REQ = "00000000-0000-4000-8000-000000119005";
const PERSON = "00000000-0000-4000-8000-000000119006";
const CANDIDATE = "00000000-0000-4000-8000-000000119007";
const APP = "00000000-0000-4000-8000-000000119008";
const MEMBERSHIP = "00000000-0000-4000-8000-000000119009";

/** Carries the long-lived fixtures (tests 2, 3, 5, 6). */
const IV_MAIN = "00000000-0000-4000-8000-00000011900a";
/** Exists purely to be destroyed by the cascade test (test 4). */
const IV_CASCADE = "00000000-0000-4000-8000-00000011900b";
/** The 'ai_async' booking test 1 attempts. */
const IV_AI = "00000000-0000-4000-8000-00000011900c";

/** Round numbers high enough not to collide with anything a fixture seeds. */
const PLAN_ROUND = 91;
const TEMPLATE_ROUND = 92;

const RUN = Date.now().toString(36);

/** A real auth.users id — tenant_user_memberships.user_id FKs to it at the SQL
 * level (drizzle can't model the cross-schema FK). Borrowing an existing
 * membership's user_id is the cheapest valid value and needs no sign-in. */
let userId: string;

/** Has 0119 been applied? Everything below branches on it. */
let migrated = false;

/** postgres.js surfaces the SQLSTATE on `.code`; 23505 = unique_violation,
 * 23514 = check_violation. */
function pgCode(err: unknown): string {
  return (err as { code?: string }).code ?? "";
}

async function expectPgError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return pgCode(err);
  }
  assert.fail("expected the statement to be rejected, but it succeeded");
}

/** Ran a statement and reports whether Postgres accepted it. */
async function accepted(fn: () => Promise<unknown>): Promise<{ ok: boolean; code: string }> {
  try {
    await fn();
    return { ok: true, code: "" };
  } catch (err) {
    return { ok: false, code: pgCode(err) };
  }
}

async function hasAiInterviewSessions(): Promise<boolean> {
  const rows = await poolSql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ai_interview_sessions'
  `;
  return rows.length > 0;
}

function skipUnmigrated(caseName: string): boolean {
  if (migrated) return false;
  console.warn(
    `N4.1 ${caseName}: migration 0119 is NOT applied — skipping. ` +
      `Apply it and re-run; this file needs no edit.`,
  );
  return true;
}

/**
 * The pre-migration half of a widening case. Reports whether the assertion was
 * handled here (unmigrated), so the caller can return early.
 */
function assertRejectedBefore0119(label: string, code: string): boolean {
  if (migrated) return false;
  assert.equal(
    code,
    "23514",
    `${label}: before 0119 the CHECK must still reject it (got ${code || "acceptance"})`,
  );
  console.warn(`N4.1 ${label}: migration 0119 is NOT applied — asserted the pre-0119 rejection.`);
  return true;
}

async function seedInterview(interviewId: string, round: number, mode: string): Promise<void> {
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name,
       status, duration_minutes, mode, created_by_membership_id)
    VALUES (${interviewId}, ${T}, ${APP}, ${REQ}, ${round}, ${`N119 Round ${round}`},
            'scheduled', 60, ${mode}, ${MEMBERSHIP})
  `;
}

/** The minimal legal session row: a draft needs questions and nothing else. */
async function insertDraftSession(interviewId: string): Promise<void> {
  await poolSql`
    INSERT INTO public.ai_interview_sessions (tenant_id, interview_id, questions)
    VALUES (${T}, ${interviewId},
            ${JSON.stringify([
              {
                key: "q1",
                prompt: "Walk me through a system you designed.",
                rubricKey: "technical_depth",
              },
            ])}::jsonb)
  `;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    // Audit rows first — the trigger on ai_interview_sessions writes into the
    // partitioned audit_logs and would otherwise be left behind.
    () =>
      poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${T} AND entity_type IN ('ai_interview_sessions','interview_recordings','interviews','applications','requisitions')`,
    // Guarded rather than caught: pre-0119 the relation does not exist, and a
    // 42P01 stack trace on every run would bury the skip lines this file's
    // whole gating design exists to make readable.
    ...(migrated
      ? [() => poolSql`DELETE FROM public.ai_interview_sessions WHERE tenant_id = ${T}`]
      : []),
    () => poolSql`DELETE FROM public.interview_recording_consents WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_recordings WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.interview_plans WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenant_interview_round_template WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.application_state_transitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.applications WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.candidates WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.persons WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.positions WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.business_units WHERE tenant_id = ${T}`,
    () => poolSql`DELETE FROM public.tenants WHERE id = ${T}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("N4.1 cleanup step failed (continuing):", err);
    }
  }
}

describe("N4.1 — AI interview schema (migration 0119)", () => {
  beforeAll(async () => {
    const [existing] = await poolSql<{ user_id: string }[]>`
      SELECT user_id FROM public.tenant_user_memberships LIMIT 1
    `;
    assert.ok(existing, "no tenant_user_memberships row to borrow user_id from");
    userId = existing.user_id;

    migrated = await hasAiInterviewSessions();

    await cleanup();

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T}, ${`synth-n119-${RUN}`}, ${`N119 ${RUN}`}, 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU}, ${T}, ${`N119 BU ${RUN}`}, ${`n119-bu-${RUN}`})
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships
        (id, tenant_id, user_id, roles, status, business_unit_id)
      VALUES (${MEMBERSHIP}, ${T}, ${userId}, ARRAY['recruiter']::tenant_role[], 'active', ${BU})
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${T}, ${BU}, ${`N119 Position ${RUN}`}, 'hybrid', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${T}, ${POSITION}, 1, '# N119 JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${T}, ${POSITION}, ${JD}, ${MEMBERSHIP}, ${MEMBERSHIP}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${PERSON}, ${T}, 'N119 Candidate', ${`n119-${RUN}@example.test`},
              ${`n119-${RUN}@example.test`})
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CANDIDATE}, ${T}, ${PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${APP}, ${T}, ${CANDIDATE}, ${REQ}, 'career_site', 'tech_interview', now())
    `;

    // Two ordinary 'video' rounds — the AI-specific inserts are the tests.
    await seedInterview(IV_MAIN, 1, "video");
    await seedInterview(IV_CASCADE, 2, "video");
  });

  afterAll(async () => {
    await cleanup();
  });

  it("1. 'ai_async' is accepted by all three mode CHECKs (and nothing else is)", async () => {
    // interviews — the booking.
    const iv = await accepted(() => seedInterview(IV_AI, 3, "ai_async"));
    if (!assertRejectedBefore0119("interviews.mode", iv.code)) {
      assert.ok(
        iv.ok,
        `interviews.mode must accept 'ai_async' after 0119 (got ${iv.code || "unknown error"})`,
      );
    }

    // interview_plans — the blueprint the booking is instantiated from.
    const plan = await accepted(
      () => poolSql`
        INSERT INTO public.interview_plans
          (tenant_id, requisition_id, round_number, round_name, duration_minutes,
           mode, scorecard_template)
        VALUES (${T}, ${REQ}, ${PLAN_ROUND}, 'N119 AI round', 30, 'ai_async', 'general')
      `,
    );
    if (!assertRejectedBefore0119("interview_plans.mode", plan.code)) {
      assert.ok(
        plan.ok,
        `interview_plans.mode must accept 'ai_async' after 0119 (got ${plan.code || "unknown error"})`,
      );
    }

    // tenant_interview_round_template — the tenant's default loop.
    const tmpl = await accepted(
      () => poolSql`
        INSERT INTO public.tenant_interview_round_template
          (tenant_id, round_number, round_name, duration_minutes, mode, scorecard_template_key)
        VALUES (${T}, ${TEMPLATE_ROUND}, 'N119 AI round', 30, 'ai_async', 'general')
      `,
    );
    if (!assertRejectedBefore0119("tenant_interview_round_template.mode", tmpl.code)) {
      assert.ok(
        tmpl.ok,
        `tenant_interview_round_template.mode must accept 'ai_async' after 0119 ` +
          `(got ${tmpl.code || "unknown error"})`,
      );
    }

    // THE CONTROL, in both worlds. Widening the vocabulary must not have
    // dropped the guard: a mode nobody has designed is still rejected. 0119's
    // header is explicit that real-time duplex voice, if it ever ships, is a
    // DIFFERENT value — not a quiet redefinition of 'ai_async'.
    const bogus = await expectPgError(
      () => poolSql`
        INSERT INTO public.interviews
          (tenant_id, application_id, requisition_id, round_number, round_name,
           status, duration_minutes, mode, created_by_membership_id)
        VALUES (${T}, ${APP}, ${REQ}, 4, 'N119 bogus', 'scheduled', 60,
                'ai_realtime', ${MEMBERSHIP})
      `,
    );
    assert.equal(bogus, "23514", "an undesigned mode must still be rejected by the CHECK");
  });

  it("2. 'ai_interview' source and 'ai_interview_link' consent capture are accepted", async () => {
    const rec = await accepted(
      () => poolSql`
        INSERT INTO public.interview_recordings
          (tenant_id, interview_id, source, status, requested_by_membership_id)
        VALUES (${T}, ${IV_MAIN}, 'ai_interview', 'pending', ${MEMBERSHIP})
      `,
    );
    if (!assertRejectedBefore0119("interview_recordings.source", rec.code)) {
      assert.ok(
        rec.ok,
        `interview_recordings.source must accept 'ai_interview' after 0119 ` +
          `(got ${rec.code || "unknown error"})`,
      );
    }

    const consent = await accepted(
      () => poolSql`
        INSERT INTO public.interview_recording_consents
          (tenant_id, interview_id, decision, consent_version, captured_via)
        VALUES (${T}, ${IV_MAIN}, 'granted', 'ai-v1', 'ai_interview_link')
      `,
    );
    if (!assertRejectedBefore0119("interview_recording_consents.captured_via", consent.code)) {
      assert.ok(
        consent.ok,
        `interview_recording_consents.captured_via must accept 'ai_interview_link' after 0119 ` +
          `(got ${consent.code || "unknown error"})`,
      );
    }

    // The control. 0116 made `purpose` CHECK-scoped and 0117 made the point
    // that each capture seam is a deliberate, reviewable edit — so an
    // invented seam must still fail in both worlds.
    const bogus = await expectPgError(
      () => poolSql`
        INSERT INTO public.interview_recording_consents
          (tenant_id, interview_id, decision, consent_version, captured_via)
        VALUES (${T}, ${IV_MAIN}, 'granted', 'ai-v1', 'recruiter_asserted')
      `,
    );
    assert.equal(bogus, "23514", "an unreviewed capture seam must still be rejected");
  });

  it("3. ONE session per interview — the second insert is rejected", async () => {
    if (skipUnmigrated("test 3")) return;

    await insertDraftSession(IV_MAIN);
    const code = await expectPgError(() => insertDraftSession(IV_MAIN));
    assert.equal(
      code,
      "23505",
      "uniq_ai_interview_sessions_per_interview must reject a second session — nothing " +
        "downstream should have to pick which session of a round is 'the' one",
    );
  });

  it("4. deleting an interview CASCADEs its session", async () => {
    if (skipUnmigrated("test 4")) return;

    await insertDraftSession(IV_CASCADE);
    const [before] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.ai_interview_sessions
      WHERE tenant_id = ${T} AND interview_id = ${IV_CASCADE}
    `;
    assert.equal(before!.n, 1, "precondition: the session exists");

    await poolSql`DELETE FROM public.interviews WHERE tenant_id = ${T} AND id = ${IV_CASCADE}`;

    const [after] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.ai_interview_sessions
      WHERE tenant_id = ${T} AND interview_id = ${IV_CASCADE}
    `;
    assert.equal(
      after!.n,
      0,
      "a session is derived data describing one round and must not outlive it",
    );
  });

  it("5. ai_interview_sessions carries NO score / rating / recommendation / verdict / sentiment column", async () => {
    if (!migrated) {
      assert.equal(
        await hasAiInterviewSessions(),
        false,
        "pre-0119 reality: the table should not exist yet",
      );
      console.warn(
        "N4.1 test 5: migration 0119 is NOT applied — asserted the table's absence instead.",
      );
      return;
    }

    // The AI round produces EVIDENCE; a human advances or rejects. That is a
    // product stance with a regulatory floor under it (GDPR Art. 22, EU AI Act
    // Annex III), so it gets a guard rather than a comment — the same guard
    // notetaker-01 test 5 puts on interview_notes.
    const cols = await poolSql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ai_interview_sessions'
    `;
    const names = cols.map((c) => c.column_name);
    assert.ok(names.length > 0, "ai_interview_sessions must exist");
    for (const banned of ["score", "rating", "rank", "recommendation", "verdict", "sentiment"]) {
      const offenders = names.filter((n) => n.includes(banned));
      assert.deepEqual(
        offenders,
        [],
        `ai_interview_sessions must not carry a '${banned}' column — see the schema header`,
      );
    }
  });

  it("6. no session reaches the candidate without a named human approval", async () => {
    if (skipUnmigrated("test 6")) return;

    // The approval gate is a CHECK, not procedure code, precisely so a later
    // ticket cannot route around it. Moving straight to 'issued' with no
    // approver and no freeze must fail.
    const code = await expectPgError(
      () => poolSql`
        UPDATE public.ai_interview_sessions
        SET status = 'issued', link_token_hash = ${`n119-${RUN}-hash`}
        WHERE tenant_id = ${T} AND interview_id = ${IV_MAIN}
      `,
    );
    assert.equal(
      code,
      "23514",
      "ai_interview_sessions_approval_check must reject an unapproved issue",
    );

    // With the approval legs and the freeze in place, the same move is legal.
    await poolSql`
      UPDATE public.ai_interview_sessions
      SET status = 'issued',
          approved_by_membership_id = ${MEMBERSHIP},
          approved_at = now(),
          questions_frozen_at = now(),
          link_token_hash = ${`n119-${RUN}-hash`},
          expires_at = now() + interval '7 days'
      WHERE tenant_id = ${T} AND interview_id = ${IV_MAIN}
    `;
    const [row] = await poolSql<{ status: string; questions_frozen_at: Date | string | null }[]>`
      SELECT status, questions_frozen_at FROM public.ai_interview_sessions
      WHERE tenant_id = ${T} AND interview_id = ${IV_MAIN}
    `;
    assert.equal(row!.status, "issued");
    assert.ok(row!.questions_frozen_at, "the question set freezes at approval");
  });
});
