/**
 * POLISH-01 — recruiter-surface polish batch integration tests.
 *
 * Coverage:
 *   Item A — drawer AI-score read:
 *     1. getCandidateById carries the application's AI score + top factors for a
 *        SCORED application (scored_by present, factors non-empty).
 *     2. getCandidateById reports the SKIPPED state honestly (ai_score null,
 *        scored_by === 'skipped').
 *   Item B — lifecycle emails:
 *     3. cancelInterview enqueues a candidate.interview_cancelled notification.
 *   Item C — scorecard reopen:
 *     4. reopenInterviewFeedback clears submitted_at (→ draft) + writes an audit
 *        row + the panelist can then resubmit.
 *     5. reopen on a COMPLETED interview → CONFLICT.
 *     6. role gating: a panel_member is FORBIDDEN from reopening; a manage-role
 *        actor is FORBIDDEN from reopening their OWN scorecard.
 *
 * Requires `pnpm db:seed:test-users` (recruiter1 / panel1 seeded).
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const PANEL = "panel1@kyndryl-poc.test";

// Last UUID group is 12 hex: this 10-char prefix + a 2-char suffix.
const P = "00000000-0000-4000-8000-0000009f01";
const PL_BU = `${P}01`;
const PL_POS = `${P}02`;
const PL_JD = `${P}03`;
const PL_REQ = `${P}04`;
// Scored / skipped candidates (drawer read).
const PERSON_S = `${P}05`;
const CAND_S = `${P}06`;
const APP_S = `${P}07`;
const PERSON_K = `${P}08`;
const CAND_K = `${P}09`;
const APP_K = `${P}0a`;
// Reopen / completed / own / cancel candidates (interview items).
const PERSON_R = `${P}0b`;
const CAND_R = `${P}0c`;
const APP_R = `${P}0d`;
const PERSON_C = `${P}0e`;
const CAND_C = `${P}0f`;
const APP_C = `${P}10`;
const PERSON_O = `${P}11`;
const CAND_O = `${P}12`;
const APP_O = `${P}13`;
const PERSON_X = `${P}14`;
const CAND_X = `${P}15`;
const APP_X = `${P}16`;
const IV_REOPEN = `${P}17`;
const IV_COMPLETED = `${P}18`;
const IV_OWN = `${P}19`;
const IV_CANCEL = `${P}1a`;

const ALL_APPS = [APP_S, APP_K, APP_R, APP_C, APP_O, APP_X];
const ALL_CANDS = [CAND_S, CAND_K, CAND_R, CAND_C, CAND_O, CAND_X];
const ALL_PERSONS = [PERSON_S, PERSON_K, PERSON_R, PERSON_C, PERSON_O, PERSON_X];

const TECH_SCORECARD = {
  problem_solving: 4,
  technical_depth: 4,
  code_quality: 3,
  system_design: 5,
  communication: 4,
};

let recruiterJwt: string;
let panelJwt: string;
let tenantId: string;
let recruiterMembershipId: string;
let panelMembershipId: string;

async function signIn(email: string): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { message?: string; data: { code: string; httpStatus?: number } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
function data<T>(e: TRPCSuccess<T> | TRPCErr): T {
  assert.ok(!isErr(e), `unexpected tRPC error: ${JSON.stringify(e)}`);
  return (e as TRPCSuccess<T>).result.data;
}
function errCode<T>(e: TRPCSuccess<T> | TRPCErr): string {
  assert.ok(isErr(e), `expected tRPC error, got: ${JSON.stringify(e)}`);
  return (e as TRPCErr).error.data.code;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.interview_feedback WHERE interview_id IN (${IV_REOPEN}, ${IV_COMPLETED}, ${IV_OWN}, ${IV_CANCEL})`,
    () =>
      poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (${IV_REOPEN}, ${IV_COMPLETED}, ${IV_OWN}, ${IV_CANCEL})`,
    () =>
      poolSql`DELETE FROM public.interviews WHERE id IN (${IV_REOPEN}, ${IV_COMPLETED}, ${IV_OWN}, ${IV_CANCEL})`,
    () => poolSql`DELETE FROM public.interview_plans WHERE requisition_id = ${PL_REQ}`,
    () =>
      poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${tenantId} AND recipient_candidate_id = ANY(${ALL_CANDS}::uuid[])`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${ALL_APPS}::uuid[])`,
    () => poolSql`DELETE FROM public.applications WHERE id = ANY(${ALL_APPS}::uuid[])`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ANY(${ALL_CANDS}::uuid[])`,
    () => poolSql`DELETE FROM public.persons WHERE id = ANY(${ALL_PERSONS}::uuid[])`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${PL_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${PL_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${PL_POS}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${PL_BU}`,
    () =>
      poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${tenantId} AND action = 'reopen_interview_feedback'`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("POLISH-01 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${PL_BU}, ${tenantId}, 'POLISH01 BU', 'polish01-bu')`;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${PL_POS}, ${tenantId}, ${PL_BU}, 'POLISH01 Staff Engineer', 'hybrid', true)`;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${PL_JD}, ${tenantId}, ${PL_POS}, 1, '# JD', 'approved')`;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${PL_REQ}, ${tenantId}, ${PL_POS}, ${PL_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')`;

  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES
      (${PERSON_S}, ${tenantId}, 'Scored Cand', 'scored.polish01@example.com', 'scored.polish01@example.com', 'IN'),
      (${PERSON_K}, ${tenantId}, 'Skipped Cand', 'skipped.polish01@example.com', 'skipped.polish01@example.com', 'IN'),
      (${PERSON_R}, ${tenantId}, 'Reopen Cand', 'reopen.polish01@example.com', 'reopen.polish01@example.com', 'IN'),
      (${PERSON_C}, ${tenantId}, 'Completed Cand', 'completed.polish01@example.com', 'completed.polish01@example.com', 'IN'),
      (${PERSON_O}, ${tenantId}, 'Own Cand', 'own.polish01@example.com', 'own.polish01@example.com', 'IN'),
      (${PERSON_X}, ${tenantId}, 'Cancel Cand', 'cancel.polish01@example.com', 'cancel.polish01@example.com', 'IN')`;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version, parsed_skills)
    VALUES
      (${CAND_S}, ${tenantId}, ${PERSON_S}, 'career_site', 'v1', ${JSON.stringify(["Go", "AWS"])}::jsonb),
      (${CAND_K}, ${tenantId}, ${PERSON_K}, 'career_site', 'v1', ${JSON.stringify(["Java"])}::jsonb),
      (${CAND_R}, ${tenantId}, ${PERSON_R}, 'career_site', 'v1', ${JSON.stringify(["Rust"])}::jsonb),
      (${CAND_C}, ${tenantId}, ${PERSON_C}, 'career_site', 'v1', ${JSON.stringify(["Kotlin"])}::jsonb),
      (${CAND_O}, ${tenantId}, ${PERSON_O}, 'career_site', 'v1', ${JSON.stringify(["Scala"])}::jsonb),
      (${CAND_X}, ${tenantId}, ${PERSON_X}, 'career_site', 'v1', ${JSON.stringify(["Python"])}::jsonb)`;

  // Scored application — ai_score + a real-shape explanation (scored_by simulated).
  const scoredExplanation = {
    scored_by: "simulated",
    model: "claude-sonnet-4-6",
    scored_at: new Date().toISOString(),
    top_factors: [
      { factor: "skills_match", score: 0.95, note: "5/5 required skills matched" },
      { factor: "experience_level", score: 0.9, note: "8 years matches band" },
    ],
    caveats: [],
    prompt_version: "ai-03-v2",
  };
  // Skipped application — ai_score null + the skipped vocabulary.
  const skippedExplanation = {
    scored_by: "skipped",
    reason: "ai_scoring_disabled",
    skipped_at: new Date().toISOString(),
  };
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at, ai_score, ai_score_explanation, ai_scored_at)
    VALUES
      (${APP_S}, ${tenantId}, ${CAND_S}, ${PL_REQ}, 'career_site', 'recruiter_review', now(), 91, ${JSON.stringify(scoredExplanation)}::jsonb, now()),
      (${APP_K}, ${tenantId}, ${CAND_K}, ${PL_REQ}, 'career_site', 'recruiter_review', now(), NULL, ${JSON.stringify(skippedExplanation)}::jsonb, NULL)`;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES
      (${APP_R}, ${tenantId}, ${CAND_R}, ${PL_REQ}, 'career_site', 'tech_interview', now()),
      (${APP_C}, ${tenantId}, ${CAND_C}, ${PL_REQ}, 'career_site', 'tech_interview', now()),
      (${APP_O}, ${tenantId}, ${CAND_O}, ${PL_REQ}, 'career_site', 'tech_interview', now()),
      (${APP_X}, ${tenantId}, ${CAND_X}, ${PL_REQ}, 'career_site', 'tech_interview', now())`;

  // Plan: round 1 technical (needed so the panel scorecard template resolves).
  await poolSql`
    INSERT INTO public.interview_plans
      (tenant_id, requisition_id, round_number, round_name, duration_minutes, mode, scorecard_template, competency_focus)
    VALUES (${tenantId}, ${PL_REQ}, 1, 'Technical Screen', 60, 'video', 'technical', ${JSON.stringify(["system_design"])}::jsonb)`;

  // IV_REOPEN — scheduled, panel1 (lead) submitted → reopen happy path.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, created_by_membership_id)
    VALUES (${IV_REOPEN}, ${tenantId}, ${APP_R}, ${PL_REQ}, 1, 'Technical Screen', 'scheduled',
       now() + interval '410 days', now() + interval '410 days' + interval '60 minutes', 60, 'video', 'technical', ${recruiterMembershipId})`;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${IV_REOPEN}, ${panelMembershipId}, true)`;
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, strengths, recommendation, submitted_at)
    VALUES (${tenantId}, ${IV_REOPEN}, ${panelMembershipId}, ${JSON.stringify(TECH_SCORECARD)}::jsonb,
       'Strong', 'yes', now() - interval '1 hour')`;

  // IV_COMPLETED — completed, panel1 submitted → reopen must CONFLICT.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, created_by_membership_id)
    VALUES (${IV_COMPLETED}, ${tenantId}, ${APP_C}, ${PL_REQ}, 1, 'Technical Screen', 'completed',
       now() + interval '411 days', now() + interval '411 days' + interval '60 minutes', 60, 'video', 'technical', ${recruiterMembershipId})`;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${IV_COMPLETED}, ${panelMembershipId}, true)`;
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, recommendation, submitted_at)
    VALUES (${tenantId}, ${IV_COMPLETED}, ${panelMembershipId}, ${JSON.stringify(TECH_SCORECARD)}::jsonb,
       'yes', now() - interval '2 hours')`;

  // IV_OWN — scheduled, RECRUITER is the panelist + submitted (SQL-seeded) →
  // recruiter reopening their OWN scorecard must be FORBIDDEN.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, created_by_membership_id)
    VALUES (${IV_OWN}, ${tenantId}, ${APP_O}, ${PL_REQ}, 1, 'Technical Screen', 'scheduled',
       now() + interval '412 days', now() + interval '412 days' + interval '60 minutes', 60, 'video', 'technical', ${recruiterMembershipId})`;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${IV_OWN}, ${recruiterMembershipId}, true)`;
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, recommendation, submitted_at)
    VALUES (${tenantId}, ${IV_OWN}, ${recruiterMembershipId}, ${JSON.stringify(TECH_SCORECARD)}::jsonb,
       'yes', now() - interval '3 hours')`;

  // IV_CANCEL — scheduled, for the cancellation-email test.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, created_by_membership_id)
    VALUES (${IV_CANCEL}, ${tenantId}, ${APP_X}, ${PL_REQ}, 1, 'Technical Screen', 'scheduled',
       now() + interval '413 days', now() + interval '413 days' + interval '60 minutes', 60, 'video', 'technical', ${recruiterMembershipId})`;
}

interface CandidateByIdOut {
  application: {
    id: string;
    aiScore: number | null;
    aiScoreExplanation: { scored_by?: string; top_factors?: unknown[] } | null;
    aiScoredAt: string | null;
  } | null;
}
interface ReopenOut {
  interviewId: string;
  membershipId: string;
  state: string;
}

describe("POLISH-01 recruiter-surface polish batch", () => {
  beforeAll(async () => {
    [recruiterJwt, panelJwt] = await Promise.all([signIn(RECRUITER), signIn(PANEL)]);
    const rClaims = decodeJwt(recruiterJwt);
    const pClaims = decodeJwt(panelJwt);
    tenantId = (rClaims as { tid?: string }).tid as string;
    const recruiterUserId = rClaims.sub as string;
    const panelUserId = pClaims.sub as string;

    const [rm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships WHERE user_id = ${recruiterUserId} AND tenant_id = ${tenantId} LIMIT 1`;
    const [pm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships WHERE user_id = ${panelUserId} AND tenant_id = ${tenantId} LIMIT 1`;
    if (!rm) throw new Error("recruiter membership missing");
    if (!pm) throw new Error("panel membership missing — run pnpm db:seed:test-users");
    recruiterMembershipId = rm.id;
    panelMembershipId = pm.id;

    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  // ─────────── Item A — drawer AI-score read ───────────

  it("1. getCandidateById carries the AI score + top factors (scored state)", async () => {
    const out = data<CandidateByIdOut>(
      await trpcQuery("getCandidateById", { id: CAND_S, applicationId: APP_S }, recruiterJwt),
    );
    assert.ok(out.application, "application facet present");
    assert.equal(out.application.id, APP_S);
    assert.equal(out.application.aiScore, 91, "score surfaced as a number");
    assert.ok(out.application.aiScoredAt, "scored_at surfaced");
    const exp = out.application.aiScoreExplanation;
    assert.ok(exp, "explanation present");
    assert.equal(exp.scored_by, "simulated", "scored_by rides in the explanation");
    assert.ok(Array.isArray(exp.top_factors) && exp.top_factors.length >= 2, "top factors present");
  });

  it("2. getCandidateById reports the skipped state honestly", async () => {
    const out = data<CandidateByIdOut>(
      await trpcQuery("getCandidateById", { id: CAND_K, applicationId: APP_K }, recruiterJwt),
    );
    assert.ok(out.application, "application facet present");
    assert.equal(out.application.aiScore, null, "skipped rows have no score");
    assert.equal(
      out.application.aiScoreExplanation?.scored_by,
      "skipped",
      "scored_by === 'skipped'",
    );
  });

  // ─────────── Item B — cancellation email ───────────

  it("3. cancelInterview enqueues a candidate.interview_cancelled notification", async () => {
    const out = data<{ interviewId: string }>(
      await trpcMutation(
        "cancelInterview",
        { interviewId: IV_CANCEL, reason: "panel unavailable" },
        recruiterJwt,
      ),
    );
    assert.equal(out.interviewId, IV_CANCEL);
    const [row] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.notification_outbox
      WHERE tenant_id = ${tenantId}
        AND recipient_candidate_id = ${CAND_X}
        AND template_key = 'candidate.interview_cancelled'`;
    assert.equal(row?.n, 1, "exactly one cancellation notification enqueued");
  });

  // ─────────── Item C — scorecard reopen ───────────

  it("4. reopen clears submitted_at + writes an audit row + panelist can resubmit", async () => {
    await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${tenantId} AND action = 'reopen_interview_feedback'`;

    const out = data<ReopenOut>(
      await trpcMutation(
        "reopenInterviewFeedback",
        { interviewId: IV_REOPEN, membershipId: panelMembershipId, reason: "score entered wrong" },
        recruiterJwt,
      ),
    );
    assert.equal(out.state, "draft", "reopened → draft");

    const [fb] = await poolSql<{ submitted_at: string | null }[]>`
      SELECT submitted_at FROM public.interview_feedback
      WHERE interview_id = ${IV_REOPEN} AND membership_id = ${panelMembershipId}`;
    assert.equal(fb?.submitted_at, null, "submitted_at cleared");

    // Panelist can now resubmit (immutability guard passes on a null submitted_at;
    // notes mandatory since PANEL-01).
    const resubmit = data<{ state: string }>(
      await trpcMutation(
        "saveInterviewFeedback",
        {
          interviewId: IV_REOPEN,
          scorecard: TECH_SCORECARD,
          action: "submit",
          recommendation: "strong_yes",
          notes: "Re-checked after the reopen — recommendation stands.",
        },
        panelJwt,
      ),
    );
    assert.equal(resubmit.state, "submitted", "panelist resubmitted");

    // Audit row (fire-and-forget) — give the unscoped pool time to commit.
    await new Promise((r) => setTimeout(r, 3000));
    const [audit] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.api_audit_logs
      WHERE tenant_id = ${tenantId} AND action = 'reopen_interview_feedback'`;
    assert.ok((audit?.n ?? 0) >= 1, "reopen wrote an api_audit_logs row");
  });

  it("5. reopen on a completed interview → CONFLICT", async () => {
    const res = await trpcMutation(
      "reopenInterviewFeedback",
      { interviewId: IV_COMPLETED, membershipId: panelMembershipId, reason: "too late" },
      recruiterJwt,
    );
    assert.equal(errCode(res), "CONFLICT");
  });

  it("6. role gating: panel_member forbidden; manage-role can't reopen their own", async () => {
    // A panel_member has no manage role → FORBIDDEN at the coarse gate.
    const asPanel = await trpcMutation(
      "reopenInterviewFeedback",
      { interviewId: IV_REOPEN, membershipId: panelMembershipId, reason: "nope" },
      panelJwt,
    );
    assert.equal(errCode(asPanel), "FORBIDDEN", "panel_member cannot reopen");

    // The recruiter reopening THEIR OWN scorecard → FORBIDDEN (self-guard).
    const own = await trpcMutation(
      "reopenInterviewFeedback",
      { interviewId: IV_OWN, membershipId: recruiterMembershipId, reason: "mine" },
      recruiterJwt,
    );
    assert.equal(errCode(own), "FORBIDDEN", "cannot reopen your own scorecard");
  });
});
