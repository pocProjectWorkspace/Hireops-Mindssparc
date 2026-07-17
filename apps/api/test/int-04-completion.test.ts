/**
 * INT-04 — interview completion + stage transitions integration tests.
 *
 * Coverage:
 *   1a. Template snapshot: scheduleInterview stamps interviews.scorecard_template
 *       from the plan round (proven on an API-scheduled interview).
 *   1b. Drift safety: after the plan round is edited, saveInterviewFeedback still
 *       validates against the interview's SNAPSHOT, not the live plan.
 *   2.  completeInterview gate: blocked (PRECONDITION_FAILED) while a panelist
 *       hasn't submitted; force without a reason → BAD_REQUEST; all-submitted →
 *       completed; re-complete → CONFLICT.
 *   3.  Force path: partial panel + force + reason → completed (forced=true).
 *   4.  markInterviewNoShow: scheduled → no_show; re-mark → CONFLICT.
 *   5.  advanceApplicationAfterInterview: rejected when the interview isn't
 *       completed; rejected when it belongs to a different stage than the app;
 *       happy path advances the stage AND writes a transition row carrying the
 *       roll-up metadata.
 *   6.  getInterviewDecisionSummary exposes FULL per-criterion scores to the
 *       recruiter, while getPanelInterviewBrief STILL hides prior-round scores
 *       (regression assert).
 *   7.  The panel persona is FORBIDDEN from the recruiter decision summary.
 *
 * NOTE (discovery): scheduleInterview's assertActiveMemberships runs under the
 * caller's tenant-scoped RLS, and tenant_user_memberships only exposes
 * memberships_self_select — so the API can only validate the CALLER's own
 * membership as a panelist. Test 1a therefore panels the recruiter on itself
 * (as int-02 does); panel1-driven fixtures are SQL-seeded. See the hand-back.
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

// The final UUID group is 12 hex chars: this 10-char prefix + a 2-char suffix.
const P = "00000000-0000-4000-8000-000000e04b";
const I4_BU = `${P}01`;
const I4_POSITION = `${P}02`;
const I4_JD = `${P}03`;
const I4_REQ = `${P}04`;
// APP1 — the happy-path arc (drift/save-validation, complete, advance).
const I4_PERSON1 = `${P}05`;
const I4_CAND1 = `${P}06`;
const I4_APP1 = `${P}07`;
// APP2 — force / no-show / guard / decision-summary / brief scenarios.
const I4_PERSON2 = `${P}08`;
const I4_CAND2 = `${P}09`;
const I4_APP2 = `${P}0a`;
// APP3 — the API-scheduled snapshot-stamping proof (recruiter panels itself).
const I4_PERSON3 = `${P}0b`;
const I4_CAND3 = `${P}0c`;
const I4_APP3 = `${P}0d`;
const I4_IV1 = `${P}0e`; // APP1 round 1 technical — panel1 (SQL-seeded)
const I4_IV_FORCE = `${P}0f`; // APP2 round 1 technical — partial panel
const I4_IV_HR = `${P}10`; // APP2 round 2 hr — belongs to hr_round
const I4_IV_NOSHOW = `${P}11`; // APP2 round 3 — no-show

const ALL_APPS = [I4_APP1, I4_APP2, I4_APP3];

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
      poolSql`DELETE FROM public.interview_feedback WHERE interview_id IN (SELECT id FROM public.interviews WHERE application_id = ANY(${ALL_APPS}::uuid[]))`,
    () =>
      poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (SELECT id FROM public.interviews WHERE application_id = ANY(${ALL_APPS}::uuid[]))`,
    () => poolSql`DELETE FROM public.interviews WHERE application_id = ANY(${ALL_APPS}::uuid[])`,
    () => poolSql`DELETE FROM public.interview_plans WHERE requisition_id = ${I4_REQ}`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${ALL_APPS}::uuid[])`,
    () => poolSql`DELETE FROM public.applications WHERE id = ANY(${ALL_APPS}::uuid[])`,
    () =>
      poolSql`DELETE FROM public.candidates WHERE id IN (${I4_CAND1}, ${I4_CAND2}, ${I4_CAND3})`,
    () =>
      poolSql`DELETE FROM public.persons WHERE id IN (${I4_PERSON1}, ${I4_PERSON2}, ${I4_PERSON3})`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${I4_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${I4_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${I4_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${I4_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("INT-04 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${I4_BU}, ${tenantId}, 'INT04 BU', 'int04-bu')`;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${I4_POSITION}, ${tenantId}, ${I4_BU}, 'INT04 Staff Engineer', 'hybrid', true)`;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${I4_JD}, ${tenantId}, ${I4_POSITION}, 1, '# JD', 'approved')`;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${I4_REQ}, ${tenantId}, ${I4_POSITION}, ${I4_JD}, ${recruiterMembershipId}, ${recruiterMembershipId}, 'posted')`;

  // Three candidates / applications, all at tech_interview.
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES
      (${I4_PERSON1}, ${tenantId}, 'Ravi Menon', 'ravi.int04@example.com', 'ravi.int04@example.com', 'IN'),
      (${I4_PERSON2}, ${tenantId}, 'Sana Iqbal', 'sana.int04@example.com', 'sana.int04@example.com', 'IN'),
      (${I4_PERSON3}, ${tenantId}, 'Dev Rao', 'dev.int04@example.com', 'dev.int04@example.com', 'IN')`;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version, parsed_skills)
    VALUES
      (${I4_CAND1}, ${tenantId}, ${I4_PERSON1}, 'career_site', 'v1', ${JSON.stringify(["Go", "AWS"])}::jsonb),
      (${I4_CAND2}, ${tenantId}, ${I4_PERSON2}, 'career_site', 'v1', ${JSON.stringify(["Java", "Kafka"])}::jsonb),
      (${I4_CAND3}, ${tenantId}, ${I4_PERSON3}, 'career_site', 'v1', ${JSON.stringify(["Rust"])}::jsonb)`;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES
      (${I4_APP1}, ${tenantId}, ${I4_CAND1}, ${I4_REQ}, 'career_site', 'tech_interview', now()),
      (${I4_APP2}, ${tenantId}, ${I4_CAND2}, ${I4_REQ}, 'career_site', 'tech_interview', now()),
      (${I4_APP3}, ${tenantId}, ${I4_CAND3}, ${I4_REQ}, 'career_site', 'tech_interview', now())`;

  // Plan: round 1 technical, round 2 hr.
  await poolSql`
    INSERT INTO public.interview_plans
      (tenant_id, requisition_id, round_number, round_name, duration_minutes, mode, scorecard_template, competency_focus)
    VALUES
      (${tenantId}, ${I4_REQ}, 1, 'Technical Screen', 60, 'video', 'technical', ${JSON.stringify(["system_design"])}::jsonb),
      (${tenantId}, ${I4_REQ}, 2, 'HR Round', 45, 'phone', 'hr', ${JSON.stringify(["motivation"])}::jsonb)`;

  // APP1 / IV1 — round 1 technical, panel = panel1 (lead). SQL-seeded with the
  // scorecard_template SNAPSHOT so the drift/complete/advance arc runs on it.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, created_by_membership_id)
    VALUES (${I4_IV1}, ${tenantId}, ${I4_APP1}, ${I4_REQ}, 1, 'Technical Screen', 'scheduled',
       now() + interval '404 days', now() + interval '404 days' + interval '60 minutes', 60, 'video', 'technical', ${recruiterMembershipId})`;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${I4_IV1}, ${panelMembershipId}, true)`;

  // APP2 / IV_FORCE — round 1 technical, panel = panel1 (lead, submitted) +
  // recruiter (never submits → PARTIAL).
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, created_by_membership_id)
    VALUES (${I4_IV_FORCE}, ${tenantId}, ${I4_APP2}, ${I4_REQ}, 1, 'Technical Screen', 'scheduled',
       now() + interval '405 days', now() + interval '405 days' + interval '60 minutes', 60, 'video', 'technical', ${recruiterMembershipId})`;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${I4_IV_FORCE}, ${panelMembershipId}, true),
           (${tenantId}, ${I4_IV_FORCE}, ${recruiterMembershipId}, false)`;
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, strengths, concerns, recommendation, submitted_at)
    VALUES (${tenantId}, ${I4_IV_FORCE}, ${panelMembershipId},
       ${JSON.stringify({ problem_solving: 4, technical_depth: 4, code_quality: 3, system_design: 5, communication: 4 })}::jsonb,
       'Solid architecture instincts', 'Rushed the coding', 'yes', now() - interval '1 hour')`;

  // APP2 / IV_HR — round 2 hr, panel = panel1 (submitted). Used for the
  // wrong-stage advance guard (belongs to hr_round; app is at tech_interview)
  // and as the prior-round source for the brief-hiding regression.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, created_by_membership_id)
    VALUES (${I4_IV_HR}, ${tenantId}, ${I4_APP2}, ${I4_REQ}, 2, 'HR Round', 'scheduled',
       now() + interval '406 days', now() + interval '406 days' + interval '45 minutes', 45, 'phone', 'hr', ${recruiterMembershipId})`;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${tenantId}, ${I4_IV_HR}, ${panelMembershipId}, true)`;
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, recommendation, submitted_at)
    VALUES (${tenantId}, ${I4_IV_HR}, ${panelMembershipId},
       ${JSON.stringify({ culture_alignment: 4, motivation: 5, communication: 4, integrity: 5, growth_mindset: 4 })}::jsonb,
       'strong_yes', now() - interval '30 minutes')`;

  // APP2 / IV_NOSHOW — round 3, scheduled, no panel needed.
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, created_by_membership_id)
    VALUES (${I4_IV_NOSHOW}, ${tenantId}, ${I4_APP2}, ${I4_REQ}, 3, 'Bar Raiser', 'scheduled',
       now() + interval '407 days', now() + interval '407 days' + interval '45 minutes', 45, 'video', 'technical', ${recruiterMembershipId})`;
}

interface CompleteOut {
  status: string;
  forced: boolean;
  panelistCount: number;
  submittedCount: number;
  belongsToStage: string;
  suggestedNextStage: string | null;
}
interface SummaryOut {
  scorecardTemplate: string;
  rollup: {
    panelistCount: number;
    submittedCount: number;
    counts: { strong_yes: number; yes: number; hold: number; no: number };
    leadRecommendation: string | null;
  };
  panelists: {
    membershipId: string;
    isLead: boolean;
    recommendation: string | null;
    scorecard: { key: string; score: number | null }[];
  }[];
}
interface BriefOut {
  priorRoundFeedback: Record<string, unknown>[];
}

describe("INT-04 completion + stage transitions", () => {
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

  it("1a. scheduleInterview stamps the scorecard template snapshot", async () => {
    // Recruiter panels itself (see file-header RLS note). The plan round 1 is
    // still 'technical' at this point, so the snapshot must be stamped 'technical'.
    const sched = await trpcMutation<{ interviewId: string }>(
      "scheduleInterview",
      {
        applicationId: I4_APP3,
        roundNumber: 1,
        scheduledStart: "2027-01-05T10:00:00Z",
        panelMembershipIds: [recruiterMembershipId],
        leadMembershipId: recruiterMembershipId,
      },
      recruiterJwt,
    );
    const interviewId = data(sched).interviewId;
    const [row] = await poolSql<{ scorecard_template: string | null }[]>`
      SELECT scorecard_template FROM public.interviews WHERE id = ${interviewId}`;
    assert.equal(
      row?.scorecard_template,
      "technical",
      "schedule must stamp the plan round template",
    );
  });

  it("1b. save validates against the SNAPSHOT after the plan round drifts", async () => {
    // DRIFT plan round 1 to 'hr' AFTER IV1 was seeded with a 'technical' snapshot.
    await poolSql`
      UPDATE public.interview_plans SET scorecard_template = 'hr'
      WHERE requisition_id = ${I4_REQ} AND round_number = 1`;

    // panel1 saves a TECHNICAL-template key (system_design) on IV1 — valid only
    // if validated against the SNAPSHOT ('technical'), not the drifted plan.
    const draft = await trpcMutation<{ state: string }>(
      "saveInterviewFeedback",
      { interviewId: I4_IV1, scorecard: { system_design: 5 }, action: "draft" },
      panelJwt,
    );
    assert.equal(data(draft).state, "draft", "snapshot template must accept the technical key");

    // An HR-only key (culture_alignment) must be REJECTED — proving the snapshot,
    // not the drifted 'hr' plan, is the source of truth.
    const badKey = await trpcMutation(
      "saveInterviewFeedback",
      { interviewId: I4_IV1, scorecard: { culture_alignment: 4 }, action: "draft" },
      panelJwt,
    );
    assert.equal(errCode(badKey), "BAD_REQUEST");
  });

  it("2. complete is gated on full submission; force needs a reason; all-submitted completes", async () => {
    // panel1 has only a DRAFT on IV1 → blocked.
    const blocked = await trpcMutation("completeInterview", { interviewId: I4_IV1 }, recruiterJwt);
    assert.equal(errCode(blocked), "PRECONDITION_FAILED");

    // force WITHOUT a reason → BAD_REQUEST.
    const noReason = await trpcMutation(
      "completeInterview",
      { interviewId: I4_IV1, force: true },
      recruiterJwt,
    );
    assert.equal(errCode(noReason), "BAD_REQUEST");

    // panel1 submits → all-submitted.
    const submit = await trpcMutation<{ state: string }>(
      "saveInterviewFeedback",
      {
        interviewId: I4_IV1,
        scorecard: { problem_solving: 5, technical_depth: 5, system_design: 5 },
        recommendation: "strong_yes",
        action: "submit",
      },
      panelJwt,
    );
    assert.equal(data(submit).state, "submitted");

    const done = await trpcMutation<CompleteOut>(
      "completeInterview",
      { interviewId: I4_IV1 },
      recruiterJwt,
    );
    const out = data(done);
    assert.equal(out.status, "completed");
    assert.equal(out.forced, false);
    assert.equal(out.panelistCount, 1);
    assert.equal(out.submittedCount, 1);
    assert.equal(out.belongsToStage, "tech_interview");
    assert.equal(out.suggestedNextStage, "hr_round");

    // Re-complete → CONFLICT (already completed).
    const again = await trpcMutation("completeInterview", { interviewId: I4_IV1 }, recruiterJwt);
    assert.equal(errCode(again), "CONFLICT");
  });

  it("3. force-complete a partial panel with a reason", async () => {
    const forced = await trpcMutation<CompleteOut>(
      "completeInterview",
      { interviewId: I4_IV_FORCE, force: true, reason: "second panelist was a no-show" },
      recruiterJwt,
    );
    const out = data(forced);
    assert.equal(out.status, "completed");
    assert.equal(out.forced, true);
    assert.equal(out.panelistCount, 2);
    assert.equal(out.submittedCount, 1);
  });

  it("4. markInterviewNoShow: scheduled → no_show; re-mark → CONFLICT", async () => {
    const ns = await trpcMutation<{ status: string }>(
      "markInterviewNoShow",
      { interviewId: I4_IV_NOSHOW, reason: "candidate did not attend" },
      recruiterJwt,
    );
    assert.equal(data(ns).status, "no_show");

    const again = await trpcMutation(
      "markInterviewNoShow",
      { interviewId: I4_IV_NOSHOW },
      recruiterJwt,
    );
    assert.equal(errCode(again), "CONFLICT");
  });

  it("5. advance is guarded (not-completed, wrong-stage) then advances with roll-up metadata", async () => {
    // NOT completed: IV_HR is still scheduled → advance rejected.
    const notDone = await trpcMutation(
      "advanceApplicationAfterInterview",
      { interviewId: I4_IV_HR },
      recruiterJwt,
    );
    assert.equal(errCode(notDone), "PRECONDITION_FAILED");

    // Complete IV_HR (hr template → belongs to hr_round) but APP2 is at
    // tech_interview → wrong-stage CONFLICT.
    const doneHr = await trpcMutation<CompleteOut>(
      "completeInterview",
      { interviewId: I4_IV_HR },
      recruiterJwt,
    );
    assert.equal(data(doneHr).belongsToStage, "hr_round");
    const wrongStage = await trpcMutation(
      "advanceApplicationAfterInterview",
      { interviewId: I4_IV_HR },
      recruiterJwt,
    );
    assert.equal(errCode(wrongStage), "CONFLICT");

    // Happy path: IV1 is completed, belongs to tech_interview, APP1 is at
    // tech_interview → advances to hr_round.
    const adv = await trpcMutation<{ fromStage: string; toStage: string; transitionId: string }>(
      "advanceApplicationAfterInterview",
      { interviewId: I4_IV1 },
      recruiterJwt,
    );
    const out = data(adv);
    assert.equal(out.fromStage, "tech_interview");
    assert.equal(out.toStage, "hr_round");

    // The application actually advanced.
    const [appRow] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${I4_APP1}`;
    assert.equal(appRow?.current_stage, "hr_round");

    // The transition row carries the roll-up metadata.
    const [tx] = await poolSql<{ to_stage: string; metadata: Record<string, unknown> | null }[]>`
      SELECT to_stage, metadata FROM public.application_state_transitions WHERE id = ${out.transitionId}`;
    assert.equal(tx?.to_stage, "hr_round");
    assert.ok(tx?.metadata, "transition metadata must be present");
    const meta = tx!.metadata as { source?: string; rollup?: { leadRecommendation?: string } };
    assert.equal(meta.source, "advance_application_after_interview");
    assert.ok(meta.rollup, "roll-up must be embedded in the transition metadata");
    assert.equal(meta.rollup!.leadRecommendation, "strong_yes");
  });

  it("6. decision summary shows FULL scores to the recruiter; panel brief still HIDES prior scores", async () => {
    // Recruiter decision summary for IV_FORCE — full per-criterion scores + lead rec.
    const sum = await trpcQuery<SummaryOut>(
      "getInterviewDecisionSummary",
      { interviewId: I4_IV_FORCE },
      recruiterJwt,
    );
    const s = data(sum);
    assert.equal(s.scorecardTemplate, "technical");
    const lead = s.panelists.find((p) => p.isLead)!;
    assert.equal(lead.membershipId, panelMembershipId);
    assert.equal(lead.recommendation, "yes");
    const sysDesign = lead.scorecard.find((c) => c.key === "system_design")!;
    assert.equal(sysDesign.score, 5, "recruiter decision summary must expose the criterion score");
    assert.equal(s.rollup.leadRecommendation, "yes");
    assert.equal(s.rollup.counts.yes, 1);

    // Panel brief for IV_HR (round 2) — prior round (IV_FORCE) discloses the
    // recommendation but NEVER the per-criterion scores (INT-03 regression).
    const brief = await trpcQuery<BriefOut>(
      "getPanelInterviewBrief",
      { interviewId: I4_IV_HR },
      panelJwt,
    );
    const b = data(brief);
    const prior = b.priorRoundFeedback.find((p) => p.roundNumber === 1);
    assert.ok(prior, "prior round 1 feedback should be disclosed on the brief");
    assert.equal(prior!.recommendation, "yes");
    assert.ok(!("scorecard" in prior!), "panel brief must not leak the scorecard");
    assert.ok(!("scores" in prior!), "panel brief must not leak scores");
  });

  it("7. panel persona is FORBIDDEN from the recruiter decision summary", async () => {
    const res = await trpcQuery(
      "getInterviewDecisionSummary",
      { interviewId: I4_IV_FORCE },
      panelJwt,
    );
    assert.equal(errCode(res), "FORBIDDEN");
  });
});
