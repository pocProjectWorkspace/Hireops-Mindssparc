/**
 * PC-11 (getCandidateAssessmentSummary) + PC-12 (recordSelectionDecision,
 * listSelectionDecisions, listLatestSelectionDecisions) integration tests.
 *
 * Fixtures (SQL-seeded; see the INT-04 header for why panels are not API-built):
 *   REQ_A — hiring manager = hiringmanager1.
 *     APP1 (tech_interview) — the summary subject:
 *       R1 technical, completed, panel = panel1 (lead, submitted yes) +
 *          admin1 (submitted strong_yes).
 *       R2 hr, scheduled, panel = panel1 (NO feedback) + recruiter1 (submitted no).
 *       R3 manager, scheduled, panel = admin1 only (panel1 not on it).
 *       R4 ai_async, completed, no panel and no evidence (status "none").
 *       R5 cancelled — never shown.
 *     APP2 (tech_interview) — the decision subject.
 *   REQ_B — hiring manager = recruiter1 (so hiringmanager1 does NOT own it).
 *     APP3 (tech_interview), no rounds.
 *
 * The SUMMARY tests need nothing new from the database. The DECISION tests need
 * migration 0129 (application_selection_decisions); when the table is absent
 * they skip with a console note rather than fail.
 *
 * Requires `pnpm db:seed:test-users`.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import type {
  GetCandidateAssessmentSummaryOutput,
  ListLatestSelectionDecisionsOutput,
  ListSelectionDecisionsOutput,
  RecordSelectionDecisionOutput,
} from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const USERS = {
  recruiter: "recruiter1@mindssparc.com",
  admin: "admin1@mindssparc.com",
  hm: "hiringmanager1@mindssparc.com",
  hrOps: "hr_ops1@mindssparc.com",
  hrHead: "hrhead1@mindssparc.com",
  panel: "panel1@mindssparc.com",
} as const;
type Who = keyof typeof USERS;

// Final UUID group = 12 hex: this 10-char prefix + a 2-char suffix.
const P = "00000000-0000-4000-8000-000000bc11";
const BU = `${P}01`;
const POSITION = `${P}02`;
const JD = `${P}03`;
const REQ_A = `${P}04`;
const REQ_B = `${P}05`;
const PERSON1 = `${P}06`;
const CAND1 = `${P}07`;
const APP1 = `${P}08`;
const PERSON2 = `${P}09`;
const CAND2 = `${P}0a`;
const APP2 = `${P}0b`;
const PERSON3 = `${P}0c`;
const CAND3 = `${P}0d`;
const APP3 = `${P}0e`;
const IV_R1 = `${P}10`;
const IV_R2 = `${P}11`;
const IV_R3 = `${P}12`;
const IV_R4 = `${P}13`;
const IV_R5 = `${P}14`;

const ALL_APPS = [APP1, APP2, APP3];

const jwt = {} as Record<Who, string>;
const mid = {} as Record<Who, string>;
let tenantId: string;
let hasDecisionTable = false;

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

async function trpcQuery<O>(name: string, input: unknown, who: Who) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt[who]}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcMutation<O>(name: string, input: unknown, who: Who) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt[who]}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

const summary = (who: Who, applicationId = APP1) =>
  trpcQuery<GetCandidateAssessmentSummaryOutput>(
    "getCandidateAssessmentSummary",
    { applicationId },
    who,
  );

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    ...(hasDecisionTable
      ? [
          () =>
            poolSql`DELETE FROM public.application_selection_decisions WHERE application_id = ANY(${ALL_APPS}::uuid[])`,
        ]
      : []),
    () =>
      poolSql`DELETE FROM public.notification_outbox WHERE recipient_candidate_id IN (${CAND1}, ${CAND2}, ${CAND3})`,
    () =>
      poolSql`DELETE FROM public.interview_feedback WHERE interview_id IN (SELECT id FROM public.interviews WHERE application_id = ANY(${ALL_APPS}::uuid[]))`,
    () =>
      poolSql`DELETE FROM public.interview_panelists WHERE interview_id IN (SELECT id FROM public.interviews WHERE application_id = ANY(${ALL_APPS}::uuid[]))`,
    () => poolSql`DELETE FROM public.interviews WHERE application_id = ANY(${ALL_APPS}::uuid[])`,
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${ALL_APPS}::uuid[])`,
    () => poolSql`DELETE FROM public.applications WHERE id = ANY(${ALL_APPS}::uuid[])`,
    () => poolSql`DELETE FROM public.candidates WHERE id IN (${CAND1}, ${CAND2}, ${CAND3})`,
    () => poolSql`DELETE FROM public.persons WHERE id IN (${PERSON1}, ${PERSON2}, ${PERSON3})`,
    () => poolSql`DELETE FROM public.requisitions WHERE id IN (${REQ_A}, ${REQ_B})`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("PC-11/12 cleanup step failed (continuing):", err);
    }
  }
}

/**
 * `selected` goes through transitionApplicationStage and so respects the T2.1
 * candidate-field policy gate. Its CODE DEFAULT (MISSING_INFO_FIELDS) requires
 * Expected Salary, Notice Period and Availability Date before offer_drafted, in
 * every environment with or without candidate_field_policy rows — so the
 * fixtures carry them (same shape as hr-round-assessment.test.ts). parsed_skills
 * must be an OBJECT: the reader is `parsed_skills->>'notice_period_days'`.
 */
const EXPECTED_SALARY_PAISE = 250_000_000; // ₹25L
function parsedSkills(skills: string[]): Record<string, unknown> {
  return { skills, notice_period_days: 60, availability_date: "2026-12-01" };
}

async function seedFixtures(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, 'PC11 BU', 'pc11-bu')`;
  await poolSql`
    INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${POSITION}, ${tenantId}, ${BU}, 'PC11 Finance Analyst', 'hybrid', true)`;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${JD}, ${tenantId}, ${POSITION}, 1, '# JD', 'approved')`;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES
      (${REQ_A}, ${tenantId}, ${POSITION}, ${JD}, ${mid.recruiter}, ${mid.hm}, 'posted'),
      (${REQ_B}, ${tenantId}, ${POSITION}, ${JD}, ${mid.recruiter}, ${mid.recruiter}, 'posted')`;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES
      (${PERSON1}, ${tenantId}, 'Meera Pillai', 'meera.pc11@example.com', 'meera.pc11@example.com', 'IN'),
      (${PERSON2}, ${tenantId}, 'Arjun Shah', 'arjun.pc11@example.com', 'arjun.pc11@example.com', 'IN'),
      (${PERSON3}, ${tenantId}, 'Kiran Das', 'kiran.pc11@example.com', 'kiran.pc11@example.com', 'IN')`;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version, parsed_skills)
    VALUES
      (${CAND1}, ${tenantId}, ${PERSON1}, 'career_site', 'v1', ${JSON.stringify(parsedSkills(["SAP", "IFRS"]))}::jsonb),
      (${CAND2}, ${tenantId}, ${PERSON2}, 'career_site', 'v1', ${JSON.stringify(parsedSkills(["Excel"]))}::jsonb),
      (${CAND3}, ${tenantId}, ${PERSON3}, 'career_site', 'v1', ${JSON.stringify(parsedSkills(["Tally"]))}::jsonb)`;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at,
       expected_salary_inr_paise)
    VALUES
      (${APP1}, ${tenantId}, ${CAND1}, ${REQ_A}, 'career_site', 'tech_interview', now(), ${EXPECTED_SALARY_PAISE}),
      (${APP2}, ${tenantId}, ${CAND2}, ${REQ_A}, 'career_site', 'tech_interview', now(), ${EXPECTED_SALARY_PAISE}),
      (${APP3}, ${tenantId}, ${CAND3}, ${REQ_B}, 'career_site', 'tech_interview', now(), ${EXPECTED_SALARY_PAISE})`;

  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, scorecard_template, completed_at,
       created_by_membership_id)
    VALUES
      (${IV_R1}, ${tenantId}, ${APP1}, ${REQ_A}, 1, 'Technical Screen', 'completed',
       now() - interval '3 days', now() - interval '3 days' + interval '60 minutes', 60, 'video',
       'technical', now() - interval '3 days', ${mid.recruiter}),
      (${IV_R2}, ${tenantId}, ${APP1}, ${REQ_A}, 2, 'HR Round', 'scheduled',
       now() - interval '1 day', now() - interval '1 day' + interval '45 minutes', 45, 'phone',
       'hr', NULL, ${mid.recruiter}),
      (${IV_R3}, ${tenantId}, ${APP1}, ${REQ_A}, 3, 'Manager Round', 'scheduled',
       now() + interval '3 days', now() + interval '3 days' + interval '45 minutes', 45, 'video',
       'manager', NULL, ${mid.recruiter}),
      (${IV_R4}, ${tenantId}, ${APP1}, ${REQ_A}, 4, 'AI First Round', 'completed',
       now() - interval '4 days', now() - interval '4 days' + interval '30 minutes', 30, 'ai_async',
       'general', now() - interval '4 days', ${mid.recruiter}),
      (${IV_R5}, ${tenantId}, ${APP1}, ${REQ_A}, 5, 'Cancelled Round', 'cancelled',
       now() + interval '9 days', now() + interval '9 days' + interval '45 minutes', 45, 'video',
       'general', NULL, ${mid.recruiter})`;
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES
      (${tenantId}, ${IV_R1}, ${mid.panel}, true),
      (${tenantId}, ${IV_R1}, ${mid.admin}, false),
      (${tenantId}, ${IV_R2}, ${mid.panel}, true),
      (${tenantId}, ${IV_R2}, ${mid.recruiter}, false),
      (${tenantId}, ${IV_R3}, ${mid.admin}, true)`;
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, strengths, concerns, notes, recommendation, submitted_at)
    VALUES
      (${tenantId}, ${IV_R1}, ${mid.panel},
       ${JSON.stringify({ problem_solving: 4, technical_depth: 3 })}::jsonb,
       'Clear on IFRS 16', 'Light on consolidation', 'PANEL PRIVATE NOTE', 'yes', now() - interval '3 days'),
      (${tenantId}, ${IV_R1}, ${mid.admin},
       ${JSON.stringify({ problem_solving: 5, technical_depth: 4 })}::jsonb,
       'Strong close process', NULL, 'ADMIN PRIVATE NOTE', 'strong_yes', now() - interval '3 days'),
      (${tenantId}, ${IV_R2}, ${mid.recruiter},
       ${JSON.stringify({ motivation: 2 })}::jsonb,
       'Polite', 'RECRUITER R2 CONCERN', 'RECRUITER R2 NOTE', 'no', now() - interval '20 hours')`;
}

describe("PC-11 / PC-12 assessment summary + selection decision", () => {
  beforeAll(async () => {
    const whos = Object.keys(USERS) as Who[];
    const tokens = await Promise.all(whos.map((w) => signIn(USERS[w])));
    whos.forEach((w, i) => (jwt[w] = tokens[i]!));
    tenantId = (decodeJwt(jwt.recruiter) as { tid?: string }).tid as string;
    for (const w of whos) {
      const userId = decodeJwt(jwt[w]).sub as string;
      const [m] = await poolSql<{ id: string }[]>`
        SELECT id FROM public.tenant_user_memberships
        WHERE user_id = ${userId} AND tenant_id = ${tenantId} LIMIT 1`;
      if (!m) throw new Error(`${w} membership missing — run pnpm db:seed:test-users`);
      mid[w] = m.id;
    }
    const [reg] = await poolSql<{ t: string | null }[]>`
      SELECT to_regclass('public.application_selection_decisions')::text AS t`;
    hasDecisionTable = Boolean(reg?.t);
    if (!hasDecisionTable) {
      console.warn(
        "PC-12: application_selection_decisions absent (migration 0129 not applied) — decision tests skip.",
      );
    }
    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  // ─────────────────────────── PC-11 content ───────────────────────────

  it("1. HM of the requisition sees every non-cancelled round in order, full feedback, counts + averages", async () => {
    const out = data(await summary("hm"));
    assert.equal(out.viewer.mode, "full");
    assert.equal(out.viewer.canDecide, true);
    assert.deepEqual(
      out.rounds.map((r) => r.roundNumber),
      [1, 2, 3, 4],
      "cancelled round 5 is left out; order by round number",
    );
    const r1 = out.rounds[0]!;
    assert.equal(r1.roundName, "Technical Screen");
    assert.equal(r1.feedback.length, 2);
    assert.equal(r1.feedback[0]!.isLead, true, "lead first");
    for (const f of r1.feedback) assert.equal(f.disclosure, "full");
    assert.ok(r1.feedback.some((f) => f.notes === "ADMIN PRIVATE NOTE"));
    assert.deepEqual(r1.rollup.counts, { strong_yes: 1, yes: 1, hold: 0, no: 0 });
    assert.equal(r1.rollup.positiveCount, 2);
    assert.equal(r1.rollup.submittedCount, 2);
    assert.equal(r1.rollup.leadRecommendation, "yes");
    const ps = r1.criterionAverages.find((c) => c.key === "problem_solving");
    assert.equal(ps?.average, 4.5, "human rating average");
    assert.equal(ps?.ratingCount, 2);
    assert.equal(r1.outcome.kind, "completed");

    const r2 = out.rounds[1]!;
    assert.equal(r2.outcome.kind, "awaiting_feedback", "past start, not completed");
    assert.equal(r2.rollup.submittedCount, 1);
    assert.equal(out.rounds[2]!.outcome.kind, "scheduled");

    // Overall = counts across rounds, no blended score.
    assert.equal(out.overall.submittedScorecards, 3);
    assert.equal(out.overall.positiveScorecards, 2);
    assert.deepEqual(out.overall.counts, { strong_yes: 1, yes: 1, hold: 0, no: 1 });
    assert.ok(!("score" in out.overall));

    // AI round: evidence only (status none — nothing generated), never a score.
    const r4 = out.rounds[3]!;
    assert.equal(r4.mode, "ai_async");
    assert.equal(r4.aiEvidence?.status, "none");
    assert.equal(r4.aiEvidence?.restricted, false);

    // Notes pointer: HM holds an interview-manage role → present.
    assert.ok(r1.notetaker, "HM passes the existing notes rule");
    assert.ok(out.decisionReasons.length > 0, "decider gets the reason list");
  });

  it("2. recruiter / admin / hr_ops / hr_head are full viewers; only recruiter + admin decide", async () => {
    for (const who of ["recruiter", "admin", "hrOps", "hrHead"] as const) {
      const out = data(await summary(who));
      assert.equal(out.viewer.mode, "full", who);
      assert.equal(out.rounds.length, 4, who);
      const expectDecide = who === "recruiter" || who === "admin";
      assert.equal(out.viewer.canDecide, expectDecide, `${who} canDecide`);
      assert.equal(out.decisionReasons.length > 0, expectDecide, `${who} reasons`);
    }
  });

  it("3. hr_ops / hr_head do NOT get the notes pointer or the AI digest (existing rules not widened)", async () => {
    for (const who of ["hrOps", "hrHead"] as const) {
      const out = data(await summary(who));
      for (const r of out.rounds) assert.equal(r.notetaker, null, `${who} round ${r.roundNumber}`);
      const ai = out.rounds.find((r) => r.mode === "ai_async")!;
      assert.equal(ai.aiEvidence?.restricted, true, who);
      assert.deepEqual(ai.aiEvidence?.quotes, [], who);
    }
  });

  it("4. a hiring manager who does not own the requisition is FORBIDDEN", async () => {
    assert.equal(errCode(await summary("hm", APP3)), "FORBIDDEN");
  });

  it("5. a panellist sees only the rounds they sat on", async () => {
    const out = data(await summary("panel"));
    assert.equal(out.viewer.mode, "panellist");
    assert.equal(out.viewer.canDecide, false);
    assert.deepEqual(
      out.rounds.map((r) => r.roundNumber),
      [1, 2],
    );
    assert.equal(out.screening, null);
    assert.deepEqual(out.decisionReasons, []);
    for (const r of out.rounds) {
      assert.deepEqual(r.criterionAverages, [], "no averages for a panellist");
      assert.ok(r.notetaker, "panellist passes the existing notes rule for their own rounds");
    }
  });

  it("6. panellist after submitting: co-panellists in summary form only (no ratings, no notes)", async () => {
    const r1 = data(await summary("panel")).rounds[0]!;
    assert.equal(r1.peerFeedbackVisible, true);
    const me = r1.feedback.find((f) => f.isMe)!;
    assert.equal(me.disclosure, "full");
    assert.equal(me.notes, "PANEL PRIVATE NOTE");
    assert.ok(me.ratings.length > 0);
    const other = r1.feedback.find((f) => !f.isMe)!;
    assert.equal(other.disclosure, "summary");
    assert.equal(other.recommendation, "strong_yes");
    assert.equal(other.strengths, "Strong close process");
    assert.deepEqual(other.ratings, []);
    assert.equal(other.notes, null);
    assert.deepEqual(r1.rollup.counts, { strong_yes: 1, yes: 1, hold: 0, no: 0 });
  });

  it("7. panellist BEFORE submitting their own scorecard sees nobody else's feedback", async () => {
    const r2 = data(await summary("panel")).rounds[1]!;
    assert.equal(r2.peerFeedbackVisible, false);
    const other = r2.feedback.find((f) => !f.isMe)!;
    assert.equal(other.disclosure, "hidden");
    assert.equal(other.recommendation, null);
    assert.equal(other.concerns, null);
    assert.equal(other.notes, null);
    assert.equal(r2.rollup.counts, null);
    assert.equal(r2.rollup.leadRecommendation, null);
    assert.ok(!JSON.stringify(r2).includes("RECRUITER R2"), "no leak anywhere in the round");
  });

  it("8. a panellist with no round on this application is FORBIDDEN", async () => {
    assert.equal(errCode(await summary("panel", APP3)), "FORBIDDEN");
  });

  // ─────────────────────────── PC-12 decisions (need 0129) ───────────────────────────

  const decide = (who: Who, input: Record<string, unknown>) =>
    trpcMutation<RecordSelectionDecisionOutput>("recordSelectionDecision", input, who);

  it("9. decision role gates: hr_ops, hr_head, panellist and a non-owner HM are FORBIDDEN", async (ctx) => {
    if (!hasDecisionTable) ctx.skip();
    assert.equal(
      errCode(await decide("hrOps", { applicationId: APP2, decision: "on_hold" })),
      "FORBIDDEN",
    );
    assert.equal(
      errCode(await decide("hrHead", { applicationId: APP2, decision: "on_hold" })),
      "FORBIDDEN",
    );
    assert.equal(
      errCode(await decide("panel", { applicationId: APP2, decision: "on_hold" })),
      "FORBIDDEN",
    );
    assert.equal(
      errCode(await decide("hm", { applicationId: APP3, decision: "on_hold" })),
      "FORBIDDEN",
    );
  });

  it("10. a reason that does not apply to the decision is BAD_REQUEST", async (ctx) => {
    if (!hasDecisionTable) ctx.skip();
    const res = await decide("hm", {
      applicationId: APP2,
      decision: "selected",
      reasonKey: "skills_gap",
    });
    assert.equal(errCode(res), "BAD_REQUEST");
  });

  it("11. on_hold by the owning HM records only — the stage does not move", async (ctx) => {
    if (!hasDecisionTable) ctx.skip();
    const out = data(
      await decide("hm", {
        applicationId: APP2,
        decision: "on_hold",
        reasonKey: "comparing_candidates",
        notes: "Waiting on the second finalist",
      }),
    );
    assert.equal(out.fromStage, "tech_interview");
    assert.equal(out.toStage, null);
    assert.equal(out.transitionId, null);
    const [a] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APP2}`;
    assert.equal(a?.current_stage, "tech_interview");
  });

  it("12. selected moves to offer_drafted via a transition row, and is audit-logged", async (ctx) => {
    if (!hasDecisionTable) ctx.skip();
    const out = data(
      await decide("hm", {
        applicationId: APP2,
        decision: "selected",
        reasonKey: "panel_consensus",
      }),
    );
    assert.equal(out.toStage, "offer_drafted");
    assert.ok(out.transitionId);
    const [t] = await poolSql<{ to_stage: string; source: string | null }[]>`
      SELECT to_stage, metadata ->> 'source' AS source
      FROM public.application_state_transitions WHERE id = ${out.transitionId}`;
    assert.equal(t?.to_stage, "offer_drafted");
    assert.equal(t?.source, "record_selection_decision");

    let audited = false;
    for (let i = 0; i < 15 && !audited; i++) {
      const [row] = await poolSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM public.api_audit_logs
        WHERE tenant_id = ${tenantId} AND action = 'record_selection_decision'
          AND created_at >= now() - interval '2 minutes'`;
      audited = Number(row?.n) >= 1;
      if (!audited) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(audited, "a record_selection_decision api_audit_logs row exists");
  });

  it("13. not_selected follows the reject path (recruiter_rejected + closing email)", async (ctx) => {
    if (!hasDecisionTable) ctx.skip();
    const out = data(
      await decide("recruiter", {
        applicationId: APP2,
        decision: "not_selected",
        reasonKey: "stronger_candidate",
      }),
    );
    assert.equal(out.fromStage, "offer_drafted");
    assert.equal(out.toStage, "recruiter_rejected");
    const [n] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.notification_outbox
      WHERE dedup_key = ${`application_closed:${out.transitionId}`}`;
    assert.equal(Number(n?.n), 1, "the unchanged closing email is enqueued");
  });

  it("14. a closed application refuses a further decision", async (ctx) => {
    if (!hasDecisionTable) ctx.skip();
    assert.equal(
      errCode(await decide("admin", { applicationId: APP2, decision: "on_hold" })),
      "PRECONDITION_FAILED",
    );
  });

  it("15. history is kept newest-first; the latest feeds the list chip (scoped per viewer)", async (ctx) => {
    if (!hasDecisionTable) ctx.skip();
    const hist = data(
      await trpcQuery<ListSelectionDecisionsOutput>(
        "listSelectionDecisions",
        { applicationId: APP2 },
        "hm",
      ),
    );
    assert.deepEqual(
      hist.history.map((h) => h.decision),
      ["not_selected", "selected", "on_hold"],
    );
    assert.equal(hist.latest?.decision, "not_selected");
    assert.equal(hist.latest?.reasonLabel, "Another candidate was preferred");
    assert.equal(hist.history[2]?.notes, "Waiting on the second finalist");

    assert.equal(
      errCode(await trpcQuery("listSelectionDecisions", { applicationId: APP2 }, "panel")),
      "FORBIDDEN",
    );

    const latestFor = async (who: Who) =>
      data(
        await trpcQuery<ListLatestSelectionDecisionsOutput>(
          "listLatestSelectionDecisions",
          { applicationIds: [APP1, APP2, APP3] },
          who,
        ),
      ).rows;
    const rec = await latestFor("recruiter");
    assert.deepEqual(
      rec.map((r) => [r.applicationId, r.decision]),
      [[APP2, "not_selected"]],
    );
    assert.equal((await latestFor("hm")).length, 1, "HM owns REQ_A");
    assert.deepEqual(await latestFor("panel"), [], "panellists get no chips");
  });
});
