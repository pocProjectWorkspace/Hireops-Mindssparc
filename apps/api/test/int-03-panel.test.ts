/**
 * INT-03 — panel persona integration tests.
 *
 * Coverage:
 *   1. listMyPanelInterviews returns ONLY interviews the caller is a panelist
 *      on (panel1 sees R2, not R1), with myFeedbackState.
 *   2. getPanelInterviewBrief is ENFORCED: panel1 (not on R1) gets FORBIDDEN.
 *   3. Brief prior-round disclosure shape: earlier submitted feedback shows
 *      recommendation + strengths + concerns, with NO per-criterion scores.
 *   4. Scorecard validation: unknown criteria key rejected (BAD_REQUEST);
 *      out-of-range score rejected (zod BAD_REQUEST).
 *   5. Draft → submit lifecycle: draft keeps it editable; submit requires a
 *      recommendation; post-submit edit is CONFLICT (immutable).
 *   6. Recruiter listUpcomingInterviews shows the per-panelist feedback state
 *      chip (panel1 → submitted after submit).
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

const I3_BU = "00000000-0000-4000-8000-000000013c01";
const I3_POSITION = "00000000-0000-4000-8000-000000013c02";
const I3_JD = "00000000-0000-4000-8000-000000013c03";
const I3_REQ = "00000000-0000-4000-8000-000000013c04";
const I3_PERSON = "00000000-0000-4000-8000-000000013c05";
const I3_CANDIDATE = "00000000-0000-4000-8000-000000013c06";
const I3_APP = "00000000-0000-4000-8000-000000013c07";
const I3_IV1 = "00000000-0000-4000-8000-000000013c08"; // round 1 (technical), prior round
const I3_IV2 = "00000000-0000-4000-8000-000000013c09"; // round 2 (manager), panel1's round

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
      poolSql`DELETE FROM public.interview_feedback WHERE interview_id IN (${I3_IV1}, ${I3_IV2})`,
    () =>
      poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (${I3_IV1}, ${I3_IV2})`,
    () => poolSql`DELETE FROM public.interviews WHERE id IN (${I3_IV1}, ${I3_IV2})`,
    () => poolSql`DELETE FROM public.interview_plans WHERE requisition_id = ${I3_REQ}`,
    () => poolSql`DELETE FROM public.applications WHERE id = ${I3_APP}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${I3_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${I3_PERSON}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${I3_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${I3_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${I3_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${I3_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("INT-03 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${I3_BU}, ${tenantId}, 'INT03 BU', 'int03-bu')`;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${I3_POSITION}, ${tenantId}, ${I3_BU}, 'INT03 Staff Engineer', 'hybrid', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${I3_JD}, ${tenantId}, ${I3_POSITION}, 1, '# JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${I3_REQ}, ${tenantId}, ${I3_POSITION}, ${I3_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${I3_PERSON}, ${tenantId}, 'Anaya Krishnan', 'anaya.int03@example.com', 'anaya.int03@example.com', 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version, parsed_skills)
    VALUES (${I3_CANDIDATE}, ${tenantId}, ${I3_PERSON}, 'career_site', 'v1', ${JSON.stringify(["Go", "Kubernetes", "Distributed systems"])}::jsonb)
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${I3_APP}, ${tenantId}, ${I3_CANDIDATE}, ${I3_REQ}, 'career_site', 'tech_interview', now())
  `;

  // Plan: round 1 technical, round 2 manager.
  await poolSql`
    INSERT INTO public.interview_plans
      (tenant_id, requisition_id, round_number, round_name, duration_minutes, mode, scorecard_template, competency_focus)
    VALUES
      (${tenantId}, ${I3_REQ}, 1, 'Technical Screen', 60, 'video', 'technical', ${JSON.stringify(["system_design"])}::jsonb),
      (${tenantId}, ${I3_REQ}, 2, 'Hiring Manager', 45, 'onsite', 'manager', ${JSON.stringify(["ownership", "delivery"])}::jsonb)
  `;

  // R1 (round 1) — recruiterMembership is the panelist; completed, 2 days ago.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, created_by_membership_id)
    VALUES
      (${I3_IV1}, ${tenantId}, ${I3_APP}, ${I3_REQ}, 1, 'Technical Screen', 'completed',
       now() - interval '2 days', now() - interval '2 days' + interval '60 minutes', 60, 'video', ${recruiterMembershipId})
  `;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${I3_IV1}, ${recruiterMembershipId}, true)
  `;
  // R1 submitted feedback WITH scores — the prior-round disclosure source.
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, strengths, concerns, recommendation, submitted_at)
    VALUES (${tenantId}, ${I3_IV1}, ${recruiterMembershipId},
       ${JSON.stringify({ problem_solving: 4, technical_depth: 5, code_quality: 4, system_design: 5, communication: 4 })}::jsonb,
       'Excellent system design depth', 'Light on testing discipline', 'yes', now() - interval '1 day')
  `;

  // R2 (round 2) — panel1 is the panelist; scheduled FAR in the future so it
  // sorts to the top of the recruiter scheduled list (deterministic on page 1).
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, created_by_membership_id)
    VALUES
      (${I3_IV2}, ${tenantId}, ${I3_APP}, ${I3_REQ}, 2, 'Hiring Manager', 'scheduled',
       now() + interval '400 days', now() + interval '400 days' + interval '45 minutes', 45, 'onsite', ${recruiterMembershipId})
  `;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${I3_IV2}, ${panelMembershipId}, true)
  `;
}

interface PanelRow {
  id: string;
  roundNumber: number;
  myFeedbackState: string;
}
interface PanelChip {
  membershipId: string;
  feedbackState: string;
}
interface BriefOut {
  interview: { id: string; roundNumber: number };
  candidate: { name: string | null; parsedSkills: string[] };
  round: { scorecardTemplate: string; competencyFocus: string[] };
  coPanelists: { membershipId: string; isMe: boolean; isLead: boolean }[];
  priorRoundFeedback: Record<string, unknown>[];
  myFeedback: {
    state: string;
    criteria: { key: string; score: number | null }[];
    recommendation: string | null;
    submittedAt: string | null;
  };
}

describe("INT-03 panel persona", () => {
  beforeAll(async () => {
    [recruiterJwt, panelJwt] = await Promise.all([signIn(RECRUITER), signIn(PANEL)]);
    const rClaims = decodeJwt(recruiterJwt);
    const pClaims = decodeJwt(panelJwt);
    tenantId = (rClaims as { tid?: string }).tid as string;
    const recruiterUserId = rClaims.sub as string;
    const panelUserId = pClaims.sub as string;

    const [rm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${recruiterUserId} AND tenant_id = ${tenantId} LIMIT 1
    `;
    const [pm] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${panelUserId} AND tenant_id = ${tenantId} LIMIT 1
    `;
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

  it("1. listMyPanelInterviews returns only the caller's interviews", async () => {
    const res = await trpcQuery<{ rows: PanelRow[] }>("listMyPanelInterviews", {}, panelJwt);
    const rows = data(res).rows;
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(I3_IV2), "panel1 should see R2 (their round)");
    assert.ok(!ids.includes(I3_IV1), "panel1 must NOT see R1 (not their round)");
    const r2 = rows.find((r) => r.id === I3_IV2)!;
    assert.equal(r2.myFeedbackState, "none");
  });

  it("2. getPanelInterviewBrief is FORBIDDEN for a non-panelist", async () => {
    const res = await trpcQuery<BriefOut>(
      "getPanelInterviewBrief",
      { interviewId: I3_IV1 },
      panelJwt,
    );
    assert.equal(errCode(res), "FORBIDDEN");
  });

  it("3. brief exposes prior-round feedback WITHOUT scores", async () => {
    const res = await trpcQuery<BriefOut>(
      "getPanelInterviewBrief",
      { interviewId: I3_IV2 },
      panelJwt,
    );
    const brief = data(res);
    assert.equal(brief.interview.roundNumber, 2);
    assert.equal(brief.round.scorecardTemplate, "manager");
    assert.equal(brief.candidate.name, "Anaya Krishnan");
    assert.ok(brief.candidate.parsedSkills.includes("Kubernetes"));
    // manager template = 5 criteria.
    assert.equal(brief.myFeedback.criteria.length, 5);
    // Prior round (R1) present with rec + strengths + concerns, NO scores.
    assert.equal(brief.priorRoundFeedback.length, 1);
    const prior = brief.priorRoundFeedback[0]!;
    assert.equal(prior.recommendation, "yes");
    assert.equal(prior.strengths, "Excellent system design depth");
    assert.ok(!("scorecard" in prior), "prior-round feedback must not leak the scorecard");
    assert.ok(!("scores" in prior), "prior-round feedback must not leak scores");
    // co-panelists: panel1 is on this round and flagged isMe.
    const me = brief.coPanelists.find((p) => p.isMe);
    assert.ok(me, "panel1 should be flagged isMe");
    assert.equal(me!.membershipId, panelMembershipId);
  });

  it("4. scorecard validation rejects unknown keys and out-of-range scores", async () => {
    const badKey = await trpcMutation(
      "saveInterviewFeedback",
      { interviewId: I3_IV2, scorecard: { not_a_real_criterion: 3 }, action: "draft" },
      panelJwt,
    );
    assert.equal(errCode(badKey), "BAD_REQUEST");

    const badRange = await trpcMutation(
      "saveInterviewFeedback",
      { interviewId: I3_IV2, scorecard: { ownership: 6 }, action: "draft" },
      panelJwt,
    );
    assert.equal(errCode(badRange), "BAD_REQUEST");
  });

  it("5. draft → submit lifecycle: submit needs recommendation; post-submit edit is CONFLICT", async () => {
    // Draft with a partial (valid) scorecard.
    const draft = await trpcMutation<{ state: string }>(
      "saveInterviewFeedback",
      {
        interviewId: I3_IV2,
        scorecard: { ownership: 4, communication: 5 },
        strengths: "Strong ownership",
        action: "draft",
      },
      panelJwt,
    );
    assert.equal(data(draft).state, "draft");

    // Brief hydrates the saved scores + draft state.
    const afterDraft = await trpcQuery<BriefOut>(
      "getPanelInterviewBrief",
      { interviewId: I3_IV2 },
      panelJwt,
    );
    const bd = data(afterDraft);
    assert.equal(bd.myFeedback.state, "draft");
    assert.equal(bd.myFeedback.criteria.find((c) => c.key === "ownership")!.score, 4);

    // Submit WITHOUT a recommendation → BAD_REQUEST.
    const noRec = await trpcMutation(
      "saveInterviewFeedback",
      { interviewId: I3_IV2, scorecard: { ownership: 4 }, action: "submit" },
      panelJwt,
    );
    assert.equal(errCode(noRec), "BAD_REQUEST");

    // Submit WITH a recommendation (+ notes — mandatory since PANEL-01) → submitted.
    const submit = await trpcMutation<{ state: string; submittedAt: string | null }>(
      "saveInterviewFeedback",
      {
        interviewId: I3_IV2,
        scorecard: { ownership: 4, communication: 5 },
        recommendation: "strong_yes",
        notes: "Owned the delivery narrative end-to-end; clear stakeholder story.",
        action: "submit",
      },
      panelJwt,
    );
    const submitOut = data(submit);
    assert.equal(submitOut.state, "submitted");
    assert.ok(submitOut.submittedAt);

    // Any further save (draft or submit) → CONFLICT (immutable).
    const editAgain = await trpcMutation(
      "saveInterviewFeedback",
      { interviewId: I3_IV2, scorecard: { ownership: 3 }, action: "draft" },
      panelJwt,
    );
    assert.equal(errCode(editAgain), "CONFLICT");
  });

  it("6. recruiter interview rows carry the per-panelist feedback state", async () => {
    const res = await trpcQuery<{ rows: { id: string; panel: PanelChip[] }[] }>(
      "listUpcomingInterviews",
      { status: "scheduled", limit: 100 },
      recruiterJwt,
    );
    const rows = data(res).rows;
    const r2 = rows.find((r) => r.id === I3_IV2);
    assert.ok(r2, "recruiter should see R2 in the scheduled list");
    const chip = r2!.panel.find((p) => p.membershipId === panelMembershipId);
    assert.ok(chip, "panel1 should appear on R2's panel");
    assert.equal(chip!.feedbackState, "submitted");
  });
});
