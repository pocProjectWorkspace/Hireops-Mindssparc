/**
 * R1.2 — the /reports catalog's last two sponsor reports, plus the 0115
 * timestamps they are built on:
 *   - interview & scorecard health (#9)
 *   - onboarding readiness (#19)
 *   - the api stamping `interviews.cancelled_at` / `completed_at`.
 *
 * THE THINGS THIS PINS, in the order they'd break:
 *
 *   1. THE STAMPS ARE WRITTEN BY THE REAL PATHS. Test 1 drives the actual
 *      `cancelInterview` and `completeInterview` mutations — not a hand-rolled
 *      UPDATE — and asserts the timestamps appear. It then re-cancels and
 *      asserts the stamp DID NOT MOVE: the recorded moment is the first one,
 *      not the most recent write. Without this the whole report measures
 *      nothing (the column existed before R1.2 and was never populated).
 *
 *   2. MEDIAN HOURS TO FEEDBACK is completed_at → submitted_at. Both planted
 *      pairs are exactly 30 hours apart, so the assertion is `=== 30` rather
 *      than a range: any other reading of the interval (using scheduled_end,
 *      created_at, or the interview's updated_at) produces a different number.
 *
 *   3. SCORECARD COVERAGE is expectation vs delivery, and a DRAFT IS NOT A
 *      DELIVERY. PANEL_B is on both completed interviews and submitted
 *      nothing — a bare draft row on one of them, no row at all on the other
 *      — so it must appear as a laggard owing 2, and coverage must read 2 of
 *      4. A reading that counted the draft would give 3 of 4 and a laggard of
 *      1.
 *
 *   4. THE COMPLETION RATE'S DENOMINATOR EXCLUDES STILL-SCHEDULED ROUNDS.
 *      The fixture has 2 completed / 1 cancelled / 1 no-show / 1 still
 *      scheduled, so the honest rate is 50% (2 of 4). Counting the scheduled
 *      round as a miss would give 40%.
 *
 *   5. ONBOARDING WINDOWS ON expected_start_date, NOT created_at. Test 4
 *      narrows the window past CASE_2's start date; the case must vanish
 *      while CASE_1 stays. Every case is created at test time (2026), so only
 *      the start-date reading can produce that.
 *
 *   6. DAYS TO START GOES NEGATIVE. Every planted start date is in 2013, so
 *      every active case is overdue and `daysToStart` must be < 0 — the sign
 *      that tones the row on the surface.
 *
 * Planted data — namespace 'a19', in the caller's own tenant, dated 2013 so
 * the window isolates the fixture from live, demo and every other suite's
 * data (a18 uses 2014, a17 2015, a14/a15 2016–2018); cleaned in afterAll.
 *
 *   BU_A → REQ_A                                   BU_B → REQ_B
 *     APP_1  IV_1  "Tech screen"  03-05  completed @12:00
 *                    panel PANEL_A (submitted 03-06 18:00 = +30h)
 *                          PANEL_B (nothing at all)
 *            IV_4  "Panel"        03-20  no_show
 *     APP_2  IV_2  "HR round"     03-10  completed @09:00
 *                    panel PANEL_A (submitted 03-11 15:00 = +30h)
 *                          PANEL_B (DRAFT — submitted_at NULL)
 *            IV_5  "Debrief"      03-25  scheduled
 *     APP_4  IV_CANCEL            04-05  scheduled → cancelInterview (Test 1)
 *            IV_COMPLETE          04-06  scheduled → completeInterview (Test 1)
 *                                                  APP_3  IV_3 "Tech screen"
 *                                                          03-12  cancelled
 *
 *     CASE_1 (APP_1, BU A)  in_progress   starts 2013-05-10
 *              tasks 1 done / 3 owed, 1 overdue, 1 skipped (out of scope)
 *              docs  2 verified / 3        bgv failed→in_progress (latest wins)
 *              it    1 provisioned / 2 (+1 cancelled, out of scope)
 *     CASE_2 (APP_2, BU A)  pre_boarding  starts 2013-05-01, nothing raised
 *     CASE_3 (APP_3, BU B)  completed     starts 2013-05-20  — mix only
 *     CASE_4 (APP_4, BU A)  cancelled     starts 2013-05-25  — mix only
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql, type JwtClaims } from "@hireops/db";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const RECRUITER_EMAIL = "recruiter1@mindssparc.com";
const RECRUITER_PASSWORD = "TestPassword123!";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}
// Narrowed copies — the module-level guard doesn't survive into the function
// bodies, and the house lint forbids non-null assertions.
const SB_URL: string = SUPABASE_URL;
const SB_ANON_KEY: string = SUPABASE_ANON_KEY;

// Stable R1.2 fixture ids (hex-only suffix, v4 structure). 'a19' namespaces
// this ticket; 'a0xx' = the BU-A chain, 'b0xx' = BU-B.
const BU_A = "00000000-0000-4000-8000-00000a19a001";
const POSITION_A = "00000000-0000-4000-8000-00000a19a002";
const JD_A = "00000000-0000-4000-8000-00000a19a003";
const REQ_A = "00000000-0000-4000-8000-00000a19a004";
const BU_B = "00000000-0000-4000-8000-00000a19b001";
const POSITION_B = "00000000-0000-4000-8000-00000a19b002";
const JD_B = "00000000-0000-4000-8000-00000a19b003";
const REQ_B = "00000000-0000-4000-8000-00000a19b004";
const REQ_IDS = [REQ_A, REQ_B];

const PERSON_1 = "00000000-0000-4000-8000-00000a19d001";
const PERSON_2 = "00000000-0000-4000-8000-00000a19d002";
const PERSON_3 = "00000000-0000-4000-8000-00000a19d003";
const PERSON_4 = "00000000-0000-4000-8000-00000a19d004";
const PERSON_IDS = [PERSON_1, PERSON_2, PERSON_3, PERSON_4];
const CAND_1 = "00000000-0000-4000-8000-00000a19e001";
const CAND_2 = "00000000-0000-4000-8000-00000a19e002";
const CAND_3 = "00000000-0000-4000-8000-00000a19e003";
const CAND_4 = "00000000-0000-4000-8000-00000a19e004";
const CAND_IDS = [CAND_1, CAND_2, CAND_3, CAND_4];
const APP_1 = "00000000-0000-4000-8000-00000a19f001";
const APP_2 = "00000000-0000-4000-8000-00000a19f002";
const APP_3 = "00000000-0000-4000-8000-00000a19f003";
const APP_4 = "00000000-0000-4000-8000-00000a19f004";
const APP_IDS = [APP_1, APP_2, APP_3, APP_4];

const IV_1 = "00000000-0000-4000-8000-00000a191001";
const IV_2 = "00000000-0000-4000-8000-00000a191002";
const IV_3 = "00000000-0000-4000-8000-00000a191003";
const IV_4 = "00000000-0000-4000-8000-00000a191004";
const IV_5 = "00000000-0000-4000-8000-00000a191005";
const IV_CANCEL = "00000000-0000-4000-8000-00000a191006";
const IV_COMPLETE = "00000000-0000-4000-8000-00000a191007";
const IV_IDS = [IV_1, IV_2, IV_3, IV_4, IV_5, IV_CANCEL, IV_COMPLETE];

const CASE_1 = "00000000-0000-4000-8000-00000a192001";
const CASE_2 = "00000000-0000-4000-8000-00000a192002";
const CASE_3 = "00000000-0000-4000-8000-00000a192003";
const CASE_4 = "00000000-0000-4000-8000-00000a192004";
const CASE_IDS = [CASE_1, CASE_2, CASE_3, CASE_4];

/** Interview window: March 2013. IV_CANCEL / IV_COMPLETE sit in April, outside it. */
const IV_WINDOW = { from: "2013-03-01T00:00:00Z", to: "2013-03-31T23:59:59Z" };
/** Onboarding window: May 2013 — every planted expected_start_date. */
const ONB_WINDOW = { from: "2013-05-01T00:00:00Z", to: "2013-05-31T23:59:59Z" };
/** Opens after CASE_2's start (2013-05-01) but before CASE_1's (2013-05-10). */
const ONB_LATE_WINDOW = { from: "2013-05-05T00:00:00Z", to: "2013-05-31T23:59:59Z" };

/** The one interval the feedback median is built from — 30h, twice. */
const FEEDBACK_LAG_HOURS = 30;

let jwt: string;
let recruiterJwt: string;
let testTenantId: string;
/** The caller's own membership — creator of every planted interview. */
let r1: string;
/** Submits both scorecards. */
let panelA: string;
/** Submits nothing — the laggard. */
let panelB: string;

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { data: { code: string; httpStatus?: number } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function signIn(email: string, password: string): Promise<string> {
  const supabase = createClient(SB_URL, SB_ANON_KEY);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signin ${email}: ${error?.message}`);
  return data.session.access_token;
}

async function trpcQuery<O>(
  name: string,
  input: unknown,
  token: string,
): Promise<TRPCSuccess<O> | TRPCErr> {
  const res = await app.request(
    `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
  );
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function trpcMutation<O>(
  name: string,
  input: unknown,
  token: string,
): Promise<TRPCSuccess<O> | TRPCErr> {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

// ─────────────────────── wire shapes (mirror the zod output) ───────────────

interface HealthReport {
  totals: {
    scheduled: number;
    completed: number;
    cancelled: number;
    noShow: number;
    total: number;
    completionRate: number | null;
    medianHoursToFeedback: number | null;
    feedbackPairs: number;
  };
  scorecardCompletion: {
    interviewsCompleted: number;
    expectedScorecards: number;
    submittedScorecards: number;
    completionRate: number | null;
    laggards: { membershipId: string; panelistName: string | null; outstanding: number }[];
  };
  byRound: {
    roundName: string;
    total: number;
    scheduled: number;
    completed: number;
    cancelled: number;
    noShow: number;
    medianHoursToFeedback: number | null;
  }[];
}

interface OnboardingReport {
  byStatus: { status: string; count: number }[];
  rows: {
    caseId: string;
    candidateName: string | null;
    status: string;
    expectedStartDate: string | null;
    daysToStart: number | null;
    tasksDone: number;
    tasksTotal: number;
    overdueTasks: number;
    docsVerified: number;
    docsTotal: number;
    bgvStatus: string | null;
    itProvisioned: number;
    itTotal: number;
  }[];
  rollups: {
    activeCases: number;
    startingWithin14Days: number;
    overdueStart: number;
    casesWithOverdueTasks: number;
    bgvInProgress: number;
    bgvFailed: number;
  };
  truncated: boolean;
}

async function health(input: unknown): Promise<HealthReport> {
  const body = await trpcQuery<HealthReport>("getInterviewHealthReport", input, jwt);
  assert.ok(!isErr(body), `interview health query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}

async function onboarding(input: unknown): Promise<OnboardingReport> {
  const body = await trpcQuery<OnboardingReport>("getOnboardingReadinessReport", input, jwt);
  assert.ok(!isErr(body), `onboarding query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}

function roundFor(report: HealthReport, roundName: string): HealthReport["byRound"][number] {
  const row = report.byRound.find((r) => r.roundName === roundName);
  assert.ok(row, `round ${roundName} should be in the report`);
  return row;
}

function caseFor(report: OnboardingReport, caseId: string): OnboardingReport["rows"][number] {
  const row = report.rows.find((r) => r.caseId === caseId);
  assert.ok(row, `case ${caseId} should be in the report`);
  return row;
}

function statusCount(report: OnboardingReport, status: string): number {
  const hit = report.byStatus.find((s) => s.status === status);
  assert.ok(hit, `byStatus must be zero-filled and include ${status}`);
  return hit.count;
}

/** The raw stamps, read past RLS — the report is not the only witness. */
async function stampsFor(interviewId: string): Promise<{
  status: string;
  completed_at: string | null;
  cancelled_at: string | null;
}> {
  const [row] = await poolSql<
    { status: string; completed_at: string | null; cancelled_at: string | null }[]
  >`
    SELECT status,
           completed_at::text AS completed_at,
           cancelled_at::text AS cancelled_at
    FROM public.interviews WHERE id = ${interviewId}
  `;
  assert.ok(row, `interview ${interviewId} should exist`);
  return row;
}

// ─────────────────────────────── fixtures ──────────────────────────────────

async function plantChain(ids: {
  bu: string;
  position: string;
  jd: string;
  req: string;
  label: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${ids.bu}, ${testTenantId}, ${`R1.2 ${ids.label}`},
            ${`r12-bu-${ids.bu.slice(-6)}`})
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
    VALUES (${ids.position}, ${testTenantId}, ${ids.bu}, ${`R1.2 ${ids.label} Engineer`},
            'hybrid', 'Bengaluru', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${ids.jd}, ${testTenantId}, ${ids.position}, 1, 'R1.2 JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id,
       created_by, status, number_of_openings, created_at, updated_at)
    VALUES (${ids.req}, ${testTenantId}, ${ids.position}, ${ids.jd}, ${r1}, ${r1}, ${r1},
            'posted', 2, '2013-01-01T00:00:00Z'::timestamptz, '2013-01-01T00:00:00Z'::timestamptz)
  `;
}

async function plantApplication(args: {
  person: string;
  candidate: string;
  application: string;
  req: string;
  stage: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${args.person}, ${testTenantId}, ${`R1.2 Candidate ${args.person.slice(-4)}`},
            ${`${args.person}@r12.test`}, ${`${args.person}@r12.test`}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${args.candidate}, ${testTenantId}, ${args.person},
            'career_site'::application_source, 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, assigned_recruiter_membership_id, source,
       current_stage, stage_entered_at, created_at, updated_at)
    VALUES (${args.application}, ${testTenantId}, ${args.candidate}, ${args.req}, ${r1},
            'career_site'::application_source, ${args.stage}::application_stage,
            '2013-02-01T00:00:00Z'::timestamptz, '2013-02-01T00:00:00Z'::timestamptz,
            '2013-02-01T00:00:00Z'::timestamptz)
  `;
}

async function plantInterview(args: {
  id: string;
  application: string;
  req: string;
  roundNumber: number;
  roundName: string;
  status: string;
  scheduledStart: string;
  /** Written directly for the FIXTURE rows; Test 1 drives the api instead. */
  completedAt?: string;
  cancelledAt?: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, duration_minutes, mode, created_by_membership_id,
       completed_at, cancelled_at)
    VALUES (${args.id}, ${testTenantId}, ${args.application}, ${args.req}, ${args.roundNumber},
            ${args.roundName}, ${args.status}, ${args.scheduledStart}::timestamptz,
            ${args.scheduledStart}::timestamptz + interval '60 minutes', 60, 'video', ${r1},
            ${args.completedAt ?? null}::timestamptz, ${args.cancelledAt ?? null}::timestamptz)
  `;
}

async function plantPanelist(interviewId: string, membershipId: string, isLead: boolean) {
  await poolSql`
    INSERT INTO public.interview_panelists (tenant_id, interview_id, membership_id, is_lead)
    VALUES (${testTenantId}, ${interviewId}, ${membershipId}, ${isLead})
  `;
}

async function plantFeedback(args: {
  interviewId: string;
  membershipId: string;
  /** null = a DRAFT: the row exists, nothing was submitted. */
  submittedAt: string | null;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.interview_feedback
      (tenant_id, interview_id, membership_id, scorecard, recommendation, submitted_at)
    VALUES (${testTenantId}, ${args.interviewId}, ${args.membershipId},
            ${JSON.stringify({ overall: 4 })}, ${args.submittedAt ? "yes" : null},
            ${args.submittedAt}::timestamptz)
  `;
}

async function plantCase(args: {
  id: string;
  application: string;
  candidate: string;
  status: string;
  expectedStart: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.onboarding_cases
      (id, tenant_id, application_id, candidate_id, status, geography_code, probation_days,
       expected_start_date)
    VALUES (${args.id}, ${testTenantId}, ${args.application}, ${args.candidate}, ${args.status},
            'IN', 90, ${args.expectedStart}::date)
  `;
}

async function cleanup(): Promise<void> {
  for (const id of CASE_IDS) {
    await poolSql`DELETE FROM public.onboarding_tasks WHERE case_id = ${id}`;
    await poolSql`DELETE FROM public.onboarding_documents WHERE case_id = ${id}`;
    await poolSql`DELETE FROM public.bgv_runs WHERE case_id = ${id}`;
    await poolSql`DELETE FROM public.it_provisioning_requests WHERE case_id = ${id}`;
  }
  for (const id of CASE_IDS) {
    await poolSql`DELETE FROM public.onboarding_cases WHERE id = ${id}`;
  }

  for (const id of IV_IDS) {
    await poolSql`DELETE FROM public.interview_feedback WHERE interview_id = ${id}`;
    await poolSql`DELETE FROM public.interview_panelists WHERE interview_id = ${id}`;
  }
  for (const id of IV_IDS) {
    await poolSql`DELETE FROM public.interviews WHERE id = ${id}`;
  }

  // Notifications the real cancel path best-effort enqueues (Test 1).
  await poolSql`
    DELETE FROM public.notification_outbox WHERE dedup_key = ${`interview_cancelled:${IV_CANCEL}`}
  `;

  // Transitions FK the application with ON DELETE RESTRICT — history first.
  for (const id of APP_IDS) {
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${id}`;
  }
  for (const id of APP_IDS) {
    await poolSql`DELETE FROM public.applications WHERE id = ${id}`;
  }
  for (const id of CAND_IDS) {
    await poolSql`DELETE FROM public.candidates WHERE id = ${id}`;
  }
  for (const id of PERSON_IDS) {
    await poolSql`DELETE FROM public.persons WHERE id = ${id}`;
  }

  for (const id of REQ_IDS) {
    await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${id}`;
  }
  for (const id of REQ_IDS) {
    await poolSql`DELETE FROM public.requisitions WHERE id = ${id}`;
  }
  for (const id of [JD_A, JD_B]) {
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${id}`;
  }
  for (const id of [POSITION_A, POSITION_B]) {
    await poolSql`DELETE FROM public.positions WHERE id = ${id}`;
  }
  for (const id of [BU_A, BU_B]) {
    await poolSql`DELETE FROM public.business_units WHERE id = ${id}`;
  }
}

describe("R1.2 — /reports interview health + onboarding readiness", () => {
  beforeAll(async () => {
    jwt = await signIn(TEST_EMAIL, TEST_PASSWORD);
    recruiterJwt = await signIn(RECRUITER_EMAIL, RECRUITER_PASSWORD);
    const claims = decodeJwt(jwt) as JwtClaims;
    const tid = claims.tid;
    const authUserId = claims.sub;
    if (!tid || !authUserId) throw new Error("test JWT missing tid/sub");
    testTenantId = tid;

    const [own] = await poolSql<{ id: string }[]>`
      SELECT id::text AS id FROM public.tenant_user_memberships
      WHERE tenant_id = ${testTenantId} AND user_id = ${authUserId} AND status = 'active'
      LIMIT 1
    `;
    if (!own) throw new Error("test user membership not found in its tenant");
    r1 = own.id;
    panelA = r1;

    // A SECOND, distinct membership for the laggard. Any active membership in
    // the tenant will do — the assertions are on its id and its count, never
    // on whose it is — but it must not be the caller's own, or the "0 of 2"
    // laggard would be the same person as the one who submitted everything.
    const [other] = await poolSql<{ id: string }[]>`
      SELECT id::text AS id FROM public.tenant_user_memberships
      WHERE tenant_id = ${testTenantId} AND status = 'active' AND id <> ${r1}::uuid
      ORDER BY id ASC
      LIMIT 1
    `;
    if (!other) throw new Error("a second active membership is required — run db:seed:test-users");
    panelB = other.id;

    await cleanup();

    await plantChain({ bu: BU_A, position: POSITION_A, jd: JD_A, req: REQ_A, label: "BU A" });
    await plantChain({ bu: BU_B, position: POSITION_B, jd: JD_B, req: REQ_B, label: "BU B" });

    await plantApplication({
      person: PERSON_1,
      candidate: CAND_1,
      application: APP_1,
      req: REQ_A,
      stage: "offer_accepted",
    });
    await plantApplication({
      person: PERSON_2,
      candidate: CAND_2,
      application: APP_2,
      req: REQ_A,
      stage: "offer_accepted",
    });
    await plantApplication({
      person: PERSON_3,
      candidate: CAND_3,
      application: APP_3,
      req: REQ_B,
      stage: "offer_accepted",
    });
    await plantApplication({
      person: PERSON_4,
      candidate: CAND_4,
      application: APP_4,
      req: REQ_A,
      stage: "tech_interview",
    });

    // IV_1 — completed at 12:00; PANEL_A writes it up 30h later, PANEL_B never.
    await plantInterview({
      id: IV_1,
      application: APP_1,
      req: REQ_A,
      roundNumber: 1,
      roundName: "R1.2 Tech screen",
      status: "completed",
      scheduledStart: "2013-03-05T10:00:00Z",
      completedAt: "2013-03-05T12:00:00Z",
    });
    await plantPanelist(IV_1, panelA, true);
    await plantPanelist(IV_1, panelB, false);
    await plantFeedback({
      interviewId: IV_1,
      membershipId: panelA,
      submittedAt: "2013-03-06T18:00:00Z",
    });

    // IV_2 — completed at 09:00; PANEL_A +30h again, PANEL_B leaves a DRAFT.
    await plantInterview({
      id: IV_2,
      application: APP_2,
      req: REQ_A,
      roundNumber: 1,
      roundName: "R1.2 HR round",
      status: "completed",
      scheduledStart: "2013-03-10T08:00:00Z",
      completedAt: "2013-03-10T09:00:00Z",
    });
    await plantPanelist(IV_2, panelA, true);
    await plantPanelist(IV_2, panelB, false);
    await plantFeedback({
      interviewId: IV_2,
      membershipId: panelA,
      submittedAt: "2013-03-11T15:00:00Z",
    });
    await plantFeedback({ interviewId: IV_2, membershipId: panelB, submittedAt: null });

    // IV_3 — cancelled, on the OTHER business unit.
    await plantInterview({
      id: IV_3,
      application: APP_3,
      req: REQ_B,
      roundNumber: 1,
      roundName: "R1.2 Tech screen",
      status: "cancelled",
      scheduledStart: "2013-03-12T10:00:00Z",
      cancelledAt: "2013-03-11T10:00:00Z",
    });

    // IV_4 — no-show. IV_5 — still on the calendar.
    await plantInterview({
      id: IV_4,
      application: APP_1,
      req: REQ_A,
      roundNumber: 2,
      roundName: "R1.2 Panel",
      status: "no_show",
      scheduledStart: "2013-03-20T10:00:00Z",
    });
    await plantInterview({
      id: IV_5,
      application: APP_2,
      req: REQ_A,
      roundNumber: 2,
      roundName: "R1.2 Debrief",
      status: "scheduled",
      scheduledStart: "2013-03-25T10:00:00Z",
    });

    // The two rounds Test 1 drives through the real mutations. April, so they
    // stay out of the March window every other interview assertion uses.
    await plantInterview({
      id: IV_CANCEL,
      application: APP_4,
      req: REQ_A,
      roundNumber: 1,
      roundName: "R1.2 Stamp cancel",
      status: "scheduled",
      scheduledStart: "2013-04-05T10:00:00Z",
    });
    await plantInterview({
      id: IV_COMPLETE,
      application: APP_4,
      req: REQ_A,
      roundNumber: 2,
      roundName: "R1.2 Stamp complete",
      status: "scheduled",
      scheduledStart: "2013-04-06T10:00:00Z",
    });

    // ── onboarding ──
    await plantCase({
      id: CASE_1,
      application: APP_1,
      candidate: CAND_1,
      status: "in_progress",
      expectedStart: "2013-05-10",
    });
    await plantCase({
      id: CASE_2,
      application: APP_2,
      candidate: CAND_2,
      status: "pre_boarding",
      expectedStart: "2013-05-01",
    });
    await plantCase({
      id: CASE_3,
      application: APP_3,
      candidate: CAND_3,
      status: "completed",
      expectedStart: "2013-05-20",
    });
    await plantCase({
      id: CASE_4,
      application: APP_4,
      candidate: CAND_4,
      status: "cancelled",
      expectedStart: "2013-05-25",
    });

    // CASE_1's checklist: 1 done, 1 overdue, 1 pending, 1 skipped. The skipped
    // one is the control for the denominator — it must NOT be counted.
    await poolSql`
      INSERT INTO public.onboarding_tasks (tenant_id, case_id, task_type, status, title, due_at)
      VALUES
        (${testTenantId}, ${CASE_1}, 'orientation', 'completed', 'R1.2 done', NULL),
        (${testTenantId}, ${CASE_1}, 'document_collection', 'pending', 'R1.2 overdue',
         '2013-05-01T00:00:00Z'::timestamptz),
        (${testTenantId}, ${CASE_1}, 'payroll_form', 'pending', 'R1.2 pending', NULL),
        (${testTenantId}, ${CASE_1}, 'training', 'skipped', 'R1.2 skipped', NULL)
    `;

    const [docType] = await poolSql<{ id: string }[]>`
      SELECT id::text AS id FROM public.document_types WHERE code = 'pan_card' LIMIT 1
    `;
    if (!docType) throw new Error("expected the pan_card reference document_type to exist");
    await poolSql`
      INSERT INTO public.onboarding_documents
        (tenant_id, case_id, document_type_id, storage_ref, verification_status)
      VALUES
        (${testTenantId}, ${CASE_1}, ${docType.id}, 'seed://a19-doc-1', 'verified'),
        (${testTenantId}, ${CASE_1}, ${docType.id}, 'seed://a19-doc-2', 'verified'),
        (${testTenantId}, ${CASE_1}, ${docType.id}, 'seed://a19-doc-3', 'rejected')
    `;

    // Two BGV runs: the FAILED one is older, so the latest (in_progress) wins.
    await poolSql`
      INSERT INTO public.bgv_runs (tenant_id, case_id, vendor, status, initiated_at)
      VALUES
        (${testTenantId}, ${CASE_1}, 'R1.2 Vendor', 'failed',
         '2013-04-01T00:00:00Z'::timestamptz),
        (${testTenantId}, ${CASE_1}, 'R1.2 Vendor', 'in_progress',
         '2013-04-10T00:00:00Z'::timestamptz)
    `;

    // IT: 1 provisioned, 1 outstanding, 1 cancelled (out of the denominator).
    await poolSql`
      INSERT INTO public.it_provisioning_requests (tenant_id, case_id, resource_type, status)
      VALUES
        (${testTenantId}, ${CASE_1}, 'laptop', 'provisioned'),
        (${testTenantId}, ${CASE_1}, 'email_account', 'requested'),
        (${testTenantId}, ${CASE_1}, 'vpn', 'cancelled')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: the real cancel / complete paths stamp 0115, and never re-stamp", async () => {
    const before = await stampsFor(IV_CANCEL);
    assert.equal(before.status, "scheduled");
    assert.equal(before.cancelled_at, null, "nothing is stamped before the mutation runs");

    const cancelled = await trpcMutation(
      "cancelInterview",
      { interviewId: IV_CANCEL, reason: "R1.2 stamp test" },
      jwt,
    );
    assert.ok(!isErr(cancelled), `cancelInterview should succeed: ${JSON.stringify(cancelled)}`);

    const afterCancel = await stampsFor(IV_CANCEL);
    assert.equal(afterCancel.status, "cancelled");
    assert.ok(afterCancel.cancelled_at, "cancelInterview must stamp cancelled_at");
    // A real "now", not a fixture date: the stamp is minted by the mutation.
    const stampedAt = new Date(afterCancel.cancelled_at).getTime();
    assert.ok(
      Math.abs(Date.now() - stampedAt) < 5 * 60 * 1000,
      `cancelled_at should be ~now, got ${afterCancel.cancelled_at}`,
    );

    // Re-cancel: the procedure short-circuits, and even if it did not, the
    // COALESCE in the write keeps the FIRST moment authoritative.
    const again = await trpcMutation(
      "cancelInterview",
      { interviewId: IV_CANCEL, reason: "R1.2 second attempt" },
      jwt,
    );
    assert.ok(!isErr(again), `a second cancel is idempotent: ${JSON.stringify(again)}`);
    const afterSecond = await stampsFor(IV_CANCEL);
    assert.equal(
      afterSecond.cancelled_at,
      afterCancel.cancelled_at,
      "a re-cancel must not move the recorded moment",
    );
    assert.equal(afterSecond.completed_at, null, "…and must not touch the other stamp");

    // The completion leg, through completeInterview's force path (IV_COMPLETE
    // has no panel, so the full-submission gate cannot pass).
    const completed = await trpcMutation(
      "completeInterview",
      { interviewId: IV_COMPLETE, force: true, reason: "R1.2 stamp test" },
      jwt,
    );
    assert.ok(!isErr(completed), `completeInterview should succeed: ${JSON.stringify(completed)}`);
    const afterComplete = await stampsFor(IV_COMPLETE);
    assert.equal(afterComplete.status, "completed");
    assert.ok(afterComplete.completed_at, "completeInterview must stamp completed_at");
    assert.equal(afterComplete.cancelled_at, null, "a completion is not a cancellation");
  });

  it("Test 2: the funnel, the 30-hour feedback median and scorecard coverage", async () => {
    const report = await health(IV_WINDOW);

    assert.equal(report.totals.total, 5, "IV_1…IV_5 — the April stamp rounds are out of window");
    assert.equal(report.totals.scheduled, 1, "IV_5 is still on the calendar");
    assert.equal(report.totals.completed, 2, "IV_1 + IV_2");
    assert.equal(report.totals.cancelled, 1, "IV_3");
    assert.equal(report.totals.noShow, 1, "IV_4");
    assert.equal(
      report.totals.completionRate,
      50,
      "2 completed of 4 RESOLVED rounds — the still-scheduled IV_5 is not a miss",
    );

    assert.equal(
      report.totals.medianHoursToFeedback,
      FEEDBACK_LAG_HOURS,
      "both pairs are completed_at → submitted_at = 30h exactly",
    );
    assert.equal(
      report.totals.feedbackPairs,
      2,
      "one observation per SUBMITTED scorecard — PANEL_B's draft is not one",
    );

    const sc = report.scorecardCompletion;
    assert.equal(sc.interviewsCompleted, 2);
    assert.equal(sc.expectedScorecards, 4, "2 completed interviews × 2 panelists");
    assert.equal(sc.submittedScorecards, 2, "only PANEL_A submitted, on both");
    assert.equal(sc.completionRate, 50);

    const laggard = sc.laggards.find((l) => l.membershipId === panelB);
    assert.ok(laggard, `PANEL_B should be named as a laggard: ${JSON.stringify(sc.laggards)}`);
    assert.equal(
      laggard.outstanding,
      2,
      "0 of 2 — a saved draft counts as outstanding, because nobody can read it",
    );
    assert.ok(
      !sc.laggards.some((l) => l.membershipId === panelA),
      "PANEL_A owes nothing and must not appear",
    );
    // The name join runs off the service-role connection; assert the field is
    // present (null is legitimate for a membership with no display name).
    assert.ok("panelistName" in laggard, "the router must attach a resolved display name");

    // byRound — busiest first, then A→Z across the three single-interview rounds.
    assert.deepEqual(
      report.byRound.map((r) => r.roundName),
      ["R1.2 Tech screen", "R1.2 Debrief", "R1.2 HR round", "R1.2 Panel"],
      "ordered by volume desc, then round name asc",
    );
    const tech = roundFor(report, "R1.2 Tech screen");
    assert.equal(tech.total, 2, "IV_1 (completed) + IV_3 (cancelled) share the round name");
    assert.equal(tech.completed, 1);
    assert.equal(tech.cancelled, 1);
    assert.equal(tech.medianHoursToFeedback, FEEDBACK_LAG_HOURS);
    const panel = roundFor(report, "R1.2 Panel");
    assert.equal(panel.noShow, 1);
    assert.equal(panel.medianHoursToFeedback, null, "no completion, no feedback pair, no median");
  });

  it("Test 3: onboarding rows, rollups and the zero-filled status mix", async () => {
    const report = await onboarding(ONB_WINDOW);

    // byStatus covers EVERY case in range, terminal ones included, and is
    // zero-filled in lifecycle order so the chip row never reflows.
    assert.deepEqual(
      report.byStatus.map((s) => s.status),
      ["pre_boarding", "day_zero", "in_progress", "completed", "cancelled"],
      "zero-filled across the CHECK's five values, in lifecycle order",
    );
    assert.equal(statusCount(report, "pre_boarding"), 1, "CASE_2");
    assert.equal(statusCount(report, "day_zero"), 0, "nothing planted here — and it still appears");
    assert.equal(statusCount(report, "in_progress"), 1, "CASE_1");
    assert.equal(statusCount(report, "completed"), 1, "CASE_3");
    assert.equal(statusCount(report, "cancelled"), 1, "CASE_4");

    // Only ACTIVE cases are listed, soonest start first.
    assert.deepEqual(
      report.rows.map((r) => r.caseId),
      [CASE_2, CASE_1],
      "CASE_2 starts 05-01, CASE_1 05-10; the terminal cases are not listed at all",
    );
    assert.equal(report.truncated, false);

    const c1 = caseFor(report, CASE_1);
    assert.equal(c1.status, "in_progress");
    assert.equal(c1.expectedStartDate, "2013-05-10", "a date column, not an instant");
    assert.ok(c1.candidateName?.startsWith("R1.2 Candidate"), "name resolves via candidate→person");
    assert.equal(c1.tasksDone, 1);
    assert.equal(c1.tasksTotal, 3, "the skipped task is not work anyone owes");
    assert.equal(c1.overdueTasks, 1);
    assert.equal(c1.docsVerified, 2);
    assert.equal(c1.docsTotal, 3, "the rejected upload stays in the denominator");
    assert.equal(c1.bgvStatus, "in_progress", "the LATEST run wins over the older failure");
    assert.equal(c1.itProvisioned, 1);
    assert.equal(c1.itTotal, 2, "the cancelled request is out of the denominator");

    const c2 = caseFor(report, CASE_2);
    assert.equal(c2.tasksTotal, 0, "nothing raised reads 0 / 0, not a null pair");
    assert.equal(c2.docsTotal, 0);
    assert.equal(c2.bgvStatus, null, "no run ever raised");
    assert.equal(c2.itTotal, 0);

    // THE SIGN. Every planted start date is in 2013, so both active cases are
    // past their start with the case still open — daysToStart must be negative.
    assert.ok(
      c1.daysToStart !== null && c1.daysToStart < 0,
      `an overdue start must read negative, got ${c1.daysToStart}`,
    );
    assert.ok(c2.daysToStart !== null && c2.daysToStart < 0);
    assert.ok(
      c2.daysToStart !== null && c1.daysToStart !== null && c2.daysToStart < c1.daysToStart,
      "CASE_2 started nine days before CASE_1, so it is nine days further overdue",
    );

    const ru = report.rollups;
    assert.equal(ru.activeCases, 2, "the two terminal cases are excluded from every rollup");
    assert.equal(ru.startingWithin14Days, 0, "a start date in the past is not 'starting soon'");
    assert.equal(ru.overdueStart, 2, "…it is late, and this is where it lands");
    assert.equal(ru.casesWithOverdueTasks, 1, "CASE_1 only");
    assert.equal(ru.bgvInProgress, 1, "counted by CASE, off its latest run");
    assert.equal(
      ru.bgvFailed,
      0,
      "the failed run was superseded — the case is in flight, not failed",
    );
  });

  it("Test 4: the window bounds expected_start_date; BU filters and recruiter is FORBIDDEN", async () => {
    // (a) The onboarding window is on the START date, not created_at — every
    // case was created just now, so only that reading can drop CASE_2.
    const late = await onboarding(ONB_LATE_WINDOW);
    assert.deepEqual(
      late.rows.map((r) => r.caseId),
      [CASE_1],
      "CASE_2 starts 2013-05-01, before a window that opens 05-05",
    );
    assert.equal(statusCount(late, "pre_boarding"), 0, "…and it leaves the status mix too");
    assert.equal(late.rollups.activeCases, 1);
    assert.equal(late.rollups.overdueStart, 1);

    // (b) BU narrows through application → requisition → position.
    const onbA = await onboarding({ ...ONB_WINDOW, businessUnitId: BU_A });
    assert.deepEqual(
      onbA.rows.map((r) => r.caseId),
      [CASE_2, CASE_1],
      "both active cases hang off REQ_A, in BU A",
    );
    assert.equal(statusCount(onbA, "cancelled"), 1, "CASE_4 is on REQ_A too");
    assert.equal(statusCount(onbA, "completed"), 0, "CASE_3 is not");

    const onbB = await onboarding({ ...ONB_WINDOW, businessUnitId: BU_B });
    assert.equal(onbB.rows.length, 0, "BU B's only case is completed — nothing active to list");
    assert.equal(statusCount(onbB, "completed"), 1, "…but it is still part of the mix");
    assert.equal(onbB.rollups.activeCases, 0);

    // (c) BU narrows the interview report through the interview's OWN
    // requisition — no application join in the path.
    const healthA = await health({ ...IV_WINDOW, businessUnitId: BU_A });
    assert.equal(healthA.totals.total, 4, "IV_3 is the only round on REQ_B");
    assert.equal(healthA.totals.cancelled, 0, "…and it was the only cancellation");
    assert.equal(healthA.totals.completed, 2);

    const healthB = await health({ ...IV_WINDOW, businessUnitId: BU_B });
    assert.equal(healthB.totals.total, 1);
    assert.equal(healthB.totals.cancelled, 1);
    assert.equal(healthB.totals.completed, 0);
    assert.equal(healthB.totals.completionRate, 0, "0 of 1 resolved — 0%, not null");
    assert.equal(healthB.scorecardCompletion.expectedScorecards, 0);
    assert.equal(
      healthB.scorecardCompletion.completionRate,
      null,
      "a rate over an empty expectation is unknown, not zero",
    );

    // (d) requisitionId narrows the interview report on its own.
    const healthReqB = await health({ ...IV_WINDOW, requisitionId: REQ_B });
    assert.equal(healthReqB.totals.total, 1);

    // (e) The role gate — both reports are REPORTS_READ_ROLES.
    const forbiddenHealth = await trpcQuery("getInterviewHealthReport", {}, recruiterJwt);
    assert.ok(
      isErr(forbiddenHealth) && forbiddenHealth.error.data.code === "FORBIDDEN",
      `recruiter must not read interview health: ${JSON.stringify(forbiddenHealth)}`,
    );
    const forbiddenOnb = await trpcQuery("getOnboardingReadinessReport", {}, recruiterJwt);
    assert.ok(
      isErr(forbiddenOnb) && forbiddenOnb.error.data.code === "FORBIDDEN",
      `recruiter must not read onboarding readiness: ${JSON.stringify(forbiddenOnb)}`,
    );
  });
});
