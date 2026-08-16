/**
 * R1.4 — /reports catalog #23: getExecutiveSummaryReport (the board pack).
 *
 * The report computes almost nothing of its own, so these tests are mostly
 * about the two properties that make it worth shipping:
 *
 *   1. COMPOSITION — every headline number is byte-identical to the number
 *      the owning report publishes for the SAME filters. Test 1 fetches
 *      getPipelineReport / getHeadcountVsPlanReport / getRequisitionAgingReport
 *      / getInterviewHealthReport alongside the summary and asserts equality
 *      field by field. That is the semantic layer's whole promise: the slide
 *      a sponsor forwards upward cannot disagree with the page it was cut
 *      from. If someone later "optimises" the summary with its own SQL, this
 *      test is what fails.
 *
 *   2. THE TREND'S AXIS — `timeToFillTrend` buckets and windows on the HIRE
 *      date, unlike every other period in the catalog (which bounds
 *      applications.created_at). The fixture is built so the two readings
 *      visibly disagree: the one hire APPLIED in February and was HIRED in
 *      March, so a window closing on 28 February still counts it in the
 *      headline (1 hire, 30 median days) while the trend shows an empty
 *      February — Test 2's second half. A trend that bucketed on the
 *      application date could not produce that pair.
 *
 * Also pinned: agency cost is the honest subset of plan #8 (spend and
 * spend-per-fee-bearing-hire out of `partner_fees`, null-safe when the
 * window has no fee), the AI-governance block is admin-only, and the
 * diversity placeholder is always `{ available: false }` — never a zero and
 * never absent.
 *
 * Coverage (4 cases):
 *   1. Composition + the absolute fixture numbers.
 *   2. The trend: 12 zero-filled buckets, the hire in its HIRE month with a
 *      pinned 30-day median, and the headline/trend disagreement.
 *   3. Agency cost from the planted fee; null-safe in a window with no fee.
 *   4. Roles: aiGovernance populated for admin, null for hr_head (with the
 *      rest of the pack intact), diversity placeholder in both, recruiter
 *      FORBIDDEN.
 *
 * Planted data — namespace 'a20', in the caller's own tenant, dated 2012 so
 * the window isolates the fixture from live, demo and every other suite's
 * data (a17 uses 2015, a18 2014, a14/a15 2016–2018; nothing else uses 2012).
 * Every query is additionally scoped to BU_A, so an unrelated 2012 row in
 * another business unit still could not move a number. Cleaned in afterAll.
 *
 *   BU_A → POSITION_A → JD_A → REQ_A (3 openings, raised 2012-01-10)
 *   ENVELOPE_A  BU_A  2012-01-01 → 2012-12-31, planned 8, approved
 *               REQ_A points at it
 *   ORG_A       empanelled partner agency
 *   APP_HIRE     applied 2012-02-01 → offer_accepted 2012-03-02  (TTF = 30d)
 *                partner-sourced (ORG_A) · FEE_A ₹4,00,000 accrued, hired
 *                2012-03-02
 *   APP_SLA      applied 2012-02-05, still at recruiter_review since then —
 *                a 48h threshold breached by ~14 years
 *   APP_REJECTED applied 2012-02-10, recruiter_rejected (terminal, so it is
 *                in `applications` but not in `activePipeline`)
 *   AI_LOG_1/2/3 2012-02, 1000 + 2000 + 500 micros, one of them failed
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
const HR_HEAD_EMAIL = "hrhead1@mindssparc.com";
const RECRUITER_EMAIL = "recruiter1@mindssparc.com";
const STAFF_PASSWORD = "TestPassword123!";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}
// Narrowed copies — the module-level guard doesn't survive into the function
// bodies, and the house lint forbids non-null assertions.
const SB_URL: string = SUPABASE_URL;
const SB_ANON_KEY: string = SUPABASE_ANON_KEY;

// Stable R1.4 fixture ids (hex-only suffix, v4 structure). 'a20' namespaces
// this ticket.
const BU_A = "00000000-0000-4000-8000-00000a20a001";
const POSITION_A = "00000000-0000-4000-8000-00000a20a002";
const JD_A = "00000000-0000-4000-8000-00000a20a003";
const REQ_A = "00000000-0000-4000-8000-00000a20a004";
const ENVELOPE_A = "00000000-0000-4000-8000-00000a20a005";

const ORG_A = "00000000-0000-4000-8000-00000a20c001";

const PERSON_HIRE = "00000000-0000-4000-8000-00000a20d001";
const PERSON_SLA = "00000000-0000-4000-8000-00000a20d002";
const PERSON_REJECTED = "00000000-0000-4000-8000-00000a20d003";
const PERSON_IDS = [PERSON_HIRE, PERSON_SLA, PERSON_REJECTED];
const CAND_HIRE = "00000000-0000-4000-8000-00000a20e001";
const CAND_SLA = "00000000-0000-4000-8000-00000a20e002";
const CAND_REJECTED = "00000000-0000-4000-8000-00000a20e003";
const CAND_IDS = [CAND_HIRE, CAND_SLA, CAND_REJECTED];
const APP_HIRE = "00000000-0000-4000-8000-00000a20f001";
const APP_SLA = "00000000-0000-4000-8000-00000a20f002";
const APP_REJECTED = "00000000-0000-4000-8000-00000a20f003";
const APP_IDS = [APP_HIRE, APP_SLA, APP_REJECTED];

const FEE_A = "00000000-0000-4000-8000-00000a200001";
const AI_LOG_1 = "00000000-0000-4000-8000-00000a200101";
const AI_LOG_2 = "00000000-0000-4000-8000-00000a200102";
const AI_LOG_3 = "00000000-0000-4000-8000-00000a200103";
const AI_LOG_IDS = [AI_LOG_1, AI_LOG_2, AI_LOG_3];

/** The fixture window: all of 2012. Everything planted is inside it. */
const WINDOW = { from: "2012-01-01T00:00:00Z", to: "2012-12-31T23:59:59Z" };
/**
 * The same window narrowed to the fixture's business unit. Every assertion
 * on an absolute number uses this, so an unrelated 2012 row elsewhere in the
 * tenant cannot move one.
 */
const SCOPED = { ...WINDOW, businessUnitId: BU_A };
/**
 * Closes AFTER the hire's application (2012-02-01) but BEFORE the hire
 * itself (2012-03-02) — the window that makes the headline and the trend
 * disagree on purpose, and that drops the fee out of agency cost.
 */
const PRE_HIRE = {
  from: "2012-01-01T00:00:00Z",
  to: "2012-02-28T23:59:59Z",
  businessUnitId: BU_A,
};

/** ₹4,00,000 in paise — the one accrued fee. */
const FEE_A_MINOR = "40000000";
/** The hire's clock: 2012-02-01 → 2012-03-02 is exactly 30 days. */
const EXPECTED_TTF_DAYS = 30;

let jwt: string;
let hrHeadJwt: string;
let recruiterJwt: string;
let testTenantId: string;
let r1: string;

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
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface ExecSummary {
  headline: {
    hires: number;
    applications: number;
    activePipeline: number;
    offerAcceptanceRate: number | null;
    medianTimeToFill: number | null;
    oldestOpenReqDays: number | null;
  };
  hiresVsPlan: {
    plannedHeadcount: number;
    openingsRequested: number;
    hires: number;
    unplannedReqs: number;
  };
  timeToFillTrend: { month: string; medianDays: number | null; hires: number }[];
  agencyCost: {
    agencySpendMinor: string;
    currency: string | null;
    agencyHires: number;
    costPerAgencyHireMinor: string | null;
  };
  pipelineHealth: {
    totalSlaBreaches: number;
    breachedStages: number;
    interviewsCompleted: number;
    interviewCompletionRate: number | null;
  };
  aiGovernance: { calls: number; costMicros: string; failures: number } | null;
  diversity: { available: boolean; reason: string };
}
interface PipelineReport {
  funnel: { stage: string; count: number }[];
  timeToFill: { medianDays: number | null; p90Days: number | null; hires: number };
  offers: { drafted: number; extended: number; accepted: number; declined: number };
  slaBreaches: { stage: string; thresholdHours: number; breachedCount: number }[];
}
interface HeadcountReport {
  totals: { plannedHeadcount: number; openingsRequested: number; hires: number };
  unplanned: { reqsRaised: number; openingsRequested: number };
}
interface AgingReport {
  rows: { requisitionId: string; isTerminal: boolean; daysOpen: number }[];
}
interface InterviewHealthReport {
  totals: { completed: number; completionRate: number | null };
}

async function execSummary(input: unknown, token = jwt): Promise<ExecSummary> {
  const body = await trpcQuery<ExecSummary>("getExecutiveSummaryReport", input, token);
  assert.ok(!isErr(body), `executive summary should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}
async function pipeline(input: unknown): Promise<PipelineReport> {
  const body = await trpcQuery<PipelineReport>("getPipelineReport", input, jwt);
  assert.ok(!isErr(body), `pipeline query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}
async function headcount(input: unknown): Promise<HeadcountReport> {
  const body = await trpcQuery<HeadcountReport>("getHeadcountVsPlanReport", input, jwt);
  assert.ok(!isErr(body), `headcount query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}
async function aging(input: unknown): Promise<AgingReport> {
  const body = await trpcQuery<AgingReport>("getRequisitionAgingReport", input, jwt);
  assert.ok(!isErr(body), `aging query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}
async function interviewHealth(input: unknown): Promise<InterviewHealthReport> {
  const body = await trpcQuery<InterviewHealthReport>("getInterviewHealthReport", input, jwt);
  assert.ok(!isErr(body), `interview health query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}

function monthIn(report: ExecSummary, month: string): { medianDays: number | null; hires: number } {
  const point = report.timeToFillTrend.find((p) => p.month === month);
  assert.ok(point, `${month} should be a bucket on the trend`);
  return point;
}

/** The four stages the platform never leaves — mirrors applicationTotals. */
const TERMINAL_STAGES = new Set([
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
]);

async function plantApplication(args: {
  person: string;
  candidate: string;
  application: string;
  /** null for a direct applicant; ORG_A for the partner-sourced hire. */
  org: string | null;
  source: string;
  stage: string;
  createdAt: string;
  stageEnteredAt: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${args.person}, ${testTenantId}, ${`R1.4 ${args.person.slice(-4)}`},
            ${`${args.person}@r14.test`}, ${`${args.person}@r14.test`}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${args.candidate}, ${testTenantId}, ${args.person},
            ${args.source}::application_source, 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, assigned_recruiter_membership_id, source,
       source_partner_id, current_stage, stage_entered_at, created_at, updated_at)
    VALUES (${args.application}, ${testTenantId}, ${args.candidate}, ${REQ_A}, ${r1},
            ${args.source}::application_source, ${args.org},
            ${args.stage}::application_stage, ${args.stageEnteredAt}::timestamptz,
            ${args.createdAt}::timestamptz, ${args.stageEnteredAt}::timestamptz)
  `;
}

async function cleanup(): Promise<void> {
  for (const id of AI_LOG_IDS) {
    await poolSql`DELETE FROM public.ai_usage_logs WHERE id = ${id}`;
  }
  await poolSql`DELETE FROM public.partner_fees WHERE id = ${FEE_A}`;

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
  await poolSql`DELETE FROM public.partner_orgs WHERE id = ${ORG_A}`;

  await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${REQ_A}`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${REQ_A}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${JD_A}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${POSITION_A}`;
  // Requisitions FK the envelope — the envelope only after the req is gone.
  await poolSql`DELETE FROM public.headcount_envelopes WHERE id = ${ENVELOPE_A}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${BU_A}`;
}

describe("R1.4 — /reports executive summary (board pack)", () => {
  beforeAll(async () => {
    jwt = await signIn(TEST_EMAIL, TEST_PASSWORD);
    hrHeadJwt = await signIn(HR_HEAD_EMAIL, STAFF_PASSWORD);
    recruiterJwt = await signIn(RECRUITER_EMAIL, STAFF_PASSWORD);
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

    await cleanup();

    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${BU_A}, ${testTenantId}, 'R1.4 BU A', 'r14-bu-a20a001')
    `;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
      VALUES (${POSITION_A}, ${testTenantId}, ${BU_A}, 'R1.4 BU A Engineer',
              'hybrid', 'Bengaluru', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD_A}, ${testTenantId}, ${POSITION_A}, 1, 'R1.4 JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.headcount_envelopes
        (id, tenant_id, business_unit_id, period_start, period_end, planned_headcount, status)
      VALUES (${ENVELOPE_A}, ${testTenantId}, ${BU_A}, '2012-01-01'::date, '2012-12-31'::date,
              8, 'approved')
    `;
    // On plan, and still open — so it is also the oldest OPEN requisition.
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
         primary_recruiter_id, hiring_manager_id, created_by, status, number_of_openings,
         created_at, updated_at)
      VALUES (${REQ_A}, ${testTenantId}, ${POSITION_A}, ${JD_A}, ${ENVELOPE_A},
              ${r1}, ${r1}, ${r1}, 'posted', 3,
              '2012-01-10T00:00:00Z'::timestamptz, '2012-01-10T00:00:00Z'::timestamptz)
    `;
    await poolSql`
      INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active, onboarded_at)
      VALUES (${ORG_A}, ${testTenantId}, 'R1.4 Agency A', 'empanelled'::partner_tier, true,
              '2012-01-01T00:00:00Z'::timestamptz)
    `;

    // The hire: applied in FEBRUARY, hired in MARCH. The month gap is what
    // Test 2 reads the trend's axis off.
    await plantApplication({
      person: PERSON_HIRE,
      candidate: CAND_HIRE,
      application: APP_HIRE,
      org: ORG_A,
      source: "partner_empanelled",
      stage: "offer_accepted",
      createdAt: "2012-02-01T00:00:00Z",
      stageEnteredAt: "2012-03-02T00:00:00Z",
    });
    await poolSql`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, transitioned_at, actor_membership_id)
      VALUES (${testTenantId}, ${APP_HIRE}, 'offer_drafted'::application_stage,
              'offer_accepted'::application_stage, '2012-03-02T00:00:00Z'::timestamptz, ${r1})
    `;

    // Sitting in a 48h-threshold stage since 2012 — a breach by any reading.
    await plantApplication({
      person: PERSON_SLA,
      candidate: CAND_SLA,
      application: APP_SLA,
      org: null,
      source: "career_site",
      stage: "recruiter_review",
      createdAt: "2012-02-05T00:00:00Z",
      stageEnteredAt: "2012-02-06T00:00:00Z",
    });

    // Terminal, so it counts in `applications` but not in `activePipeline`.
    await plantApplication({
      person: PERSON_REJECTED,
      candidate: CAND_REJECTED,
      application: APP_REJECTED,
      org: null,
      source: "career_site",
      stage: "recruiter_rejected",
      createdAt: "2012-02-10T00:00:00Z",
      stageEnteredAt: "2012-02-20T00:00:00Z",
    });

    // The fee the hire accrued — dated by the HIRE, which is also what makes
    // it drop out of the PRE_HIRE window in Test 3.
    await poolSql`
      INSERT INTO public.partner_fees
        (id, tenant_id, partner_org_id, application_id, msa_snapshot, fee_minor, fee_currency,
         status, hired_at)
      VALUES (${FEE_A}, ${testTenantId}, ${ORG_A}, ${APP_HIRE},
              ${JSON.stringify({ feeModel: "flat_per_hire", flatFeeMinor: 40000000 })},
              ${FEE_A_MINOR}::bigint, 'INR', 'accrued', '2012-03-02T00:00:00Z'::timestamptz)
    `;

    // Three model calls in the window, one of them failed: 3500 micros total.
    await poolSql`
      INSERT INTO public.ai_usage_logs
        (id, tenant_id, provider, model, feature, input_tokens, output_tokens, cost_micros,
         latency_ms, succeeded, error_code, created_at)
      VALUES
        (${AI_LOG_1}, ${testTenantId}, 'anthropic', 'r14-model', 'r14_feature', 100, 50, 1000,
         200, true, NULL, '2012-02-01T10:00:00Z'::timestamptz),
        (${AI_LOG_2}, ${testTenantId}, 'anthropic', 'r14-model', 'r14_feature', 200, 80, 2000,
         400, true, NULL, '2012-02-01T11:00:00Z'::timestamptz),
        (${AI_LOG_3}, ${testTenantId}, 'anthropic', 'r14-model', 'r14_feature', 50, 10, 500,
         600, false, 'r14_err', '2012-02-01T12:00:00Z'::timestamptz)
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: composition — every headline number is the owning report's own number", async () => {
    const summary = await execSummary(SCOPED);
    const pipe = await pipeline(SCOPED);
    const plan = await headcount(SCOPED);
    const reqs = await aging(SCOPED);
    const health = await interviewHealth(SCOPED);

    // ── the pipeline report owns the funnel, the speed and the offers ──
    const applications = pipe.funnel.reduce((sum, f) => sum + f.count, 0);
    const active = pipe.funnel
      .filter((f) => !TERMINAL_STAGES.has(f.stage))
      .reduce((sum, f) => sum + f.count, 0);
    assert.equal(
      summary.headline.applications,
      applications,
      "applications === the funnel's total",
    );
    assert.equal(
      summary.headline.activePipeline,
      active,
      "activePipeline === the non-terminal bands",
    );
    assert.equal(summary.headline.hires, pipe.timeToFill.hires, "hires === the pipeline's hires");
    assert.equal(
      summary.headline.medianTimeToFill,
      pipe.timeToFill.medianDays,
      "the headline median IS the pipeline report's median",
    );
    const expectedAcceptance =
      pipe.offers.extended > 0
        ? Math.round((pipe.offers.accepted / pipe.offers.extended) * 1000) / 10
        : null;
    assert.equal(summary.headline.offerAcceptanceRate, expectedAcceptance);

    // ── the aging report owns "how old is the oldest open req" ──
    const oldestOpen = reqs.rows.find((r) => !r.isTerminal)?.daysOpen ?? null;
    assert.equal(
      summary.headline.oldestOpenReqDays,
      oldestOpen,
      "the board pack reads the aging report's own oldest-open row",
    );
    assert.equal(reqs.rows.find((r) => !r.isTerminal)?.requisitionId, REQ_A, "…which is REQ_A");

    // ── the headcount report owns the plan ──
    assert.deepEqual(
      summary.hiresVsPlan,
      {
        plannedHeadcount: plan.totals.plannedHeadcount,
        openingsRequested: plan.totals.openingsRequested,
        hires: plan.totals.hires,
        unplannedReqs: plan.unplanned.reqsRaised,
      },
      "hiresVsPlan is the headcount report's totals, unchanged",
    );

    // ── pipeline health: the SLA table and the interview funnel ──
    assert.equal(
      summary.pipelineHealth.totalSlaBreaches,
      pipe.slaBreaches.reduce((sum, s) => sum + s.breachedCount, 0),
      "SLA breaches are summed from the pipeline report's own table",
    );
    assert.equal(
      summary.pipelineHealth.breachedStages,
      pipe.slaBreaches.filter((s) => s.breachedCount > 0).length,
    );
    assert.equal(summary.pipelineHealth.interviewsCompleted, health.totals.completed);
    assert.equal(
      summary.pipelineHealth.interviewCompletionRate,
      health.totals.completionRate,
      "the completion rate is the interview-health report's rate",
    );

    // ── and the fixture's absolute values, so the equalities above are not
    //    two reports agreeing on nothing ──
    assert.equal(summary.headline.applications, 3, "APP_HIRE + APP_SLA + APP_REJECTED");
    assert.equal(summary.headline.activePipeline, 1, "only APP_SLA is still live");
    assert.equal(summary.headline.hires, 1, "APP_HIRE sits at offer_accepted");
    assert.equal(summary.headline.medianTimeToFill, EXPECTED_TTF_DAYS, "2012-02-01 → 2012-03-02");
    assert.equal(summary.hiresVsPlan.plannedHeadcount, 8);
    assert.equal(summary.hiresVsPlan.openingsRequested, 3, "REQ_A's three openings");
    assert.equal(summary.hiresVsPlan.hires, 1);
    assert.equal(summary.hiresVsPlan.unplannedReqs, 0, "REQ_A sits against the envelope");
    assert.equal(
      summary.pipelineHealth.totalSlaBreaches,
      1,
      "APP_SLA has been in stage since 2012",
    );
    assert.equal(summary.pipelineHealth.breachedStages, 1, "…in exactly one stage");
  });

  it("Test 2: the trend buckets on the HIRE month, zero-filled, and disagrees with the headline", async () => {
    const summary = await execSummary(SCOPED);

    assert.equal(summary.timeToFillTrend.length, 12, "a 12-month window is 12 buckets");
    assert.deepEqual(
      summary.timeToFillTrend.map((p) => p.month),
      [
        "2012-01",
        "2012-02",
        "2012-03",
        "2012-04",
        "2012-05",
        "2012-06",
        "2012-07",
        "2012-08",
        "2012-09",
        "2012-10",
        "2012-11",
        "2012-12",
      ],
      "oldest first, zero-filled — the sparkline has no gaps",
    );

    const march = monthIn(summary, "2012-03");
    assert.equal(march.hires, 1, "the hire lands in the month it was HIRED");
    assert.equal(march.medianDays, EXPECTED_TTF_DAYS, "and pins the known 30-day span");

    const february = monthIn(summary, "2012-02");
    assert.equal(february.hires, 0, "February is when it APPLIED, which is not the axis");
    assert.equal(february.medianDays, null, "an empty month reports null, never a zero median");
    assert.equal(
      summary.timeToFillTrend.filter((p) => p.hires > 0).length,
      1,
      "exactly one month has a hire",
    );

    // THE difference, made visible: a window that closes before the hire
    // still counts it in the headline (the application was raised inside the
    // window) but must show an empty trend.
    const preHire = await execSummary(PRE_HIRE);
    assert.equal(preHire.headline.hires, 1, "the headline windows on the APPLICATION date");
    assert.equal(preHire.headline.medianTimeToFill, EXPECTED_TTF_DAYS);
    assert.deepEqual(
      preHire.timeToFillTrend.map((p) => p.month),
      ["2012-01", "2012-02"],
      "the trend covers the window's months",
    );
    assert.equal(
      preHire.timeToFillTrend.reduce((sum, p) => sum + p.hires, 0),
      0,
      "…and shows no hire at all, because the hire happened after the window closed",
    );
  });

  it("Test 3: agency cost — spend and cost per fee-bearing hire, null-safe with no fees", async () => {
    const summary = await execSummary(SCOPED);
    assert.deepEqual(
      summary.agencyCost,
      {
        agencySpendMinor: FEE_A_MINOR,
        currency: "INR",
        agencyHires: 1,
        costPerAgencyHireMinor: FEE_A_MINOR,
      },
      "one ₹4,00,000 fee over one fee-bearing hire",
    );

    // Fees are windowed on the HIRE date, so a window that closes before the
    // hire has no spend — and cost per hire is null, not zero.
    const preHire = await execSummary(PRE_HIRE);
    assert.deepEqual(preHire.agencyCost, {
      agencySpendMinor: "0",
      currency: null,
      agencyHires: 0,
      costPerAgencyHireMinor: null,
    });
  });

  it("Test 4: aiGovernance is admin-only, diversity is always the placeholder, recruiter FORBIDDEN", async () => {
    const asAdmin = await execSummary(SCOPED);
    assert.deepEqual(
      asAdmin.aiGovernance,
      { calls: 3, costMicros: "3500", failures: 1 },
      "an admin sees the AI ledger's three governance numbers",
    );

    const asHrHead = await execSummary(SCOPED, hrHeadJwt);
    assert.equal(
      asHrHead.aiGovernance,
      null,
      "hr_head reads the pack but not the admin-only AI ledger",
    );
    assert.equal(asHrHead.headline.hires, 1, "…and gets the whole of the rest of the pack");
    assert.equal(asHrHead.agencyCost.agencySpendMinor, FEE_A_MINOR);

    for (const [who, pack] of [
      ["admin", asAdmin],
      ["hr_head", asHrHead],
    ] as const) {
      assert.deepEqual(
        pack.diversity,
        { available: false, reason: "not_captured" },
        `${who} sees the honest placeholder, never a fabricated zero`,
      );
    }

    const forbidden = await trpcQuery("getExecutiveSummaryReport", {}, recruiterJwt);
    assert.ok(
      isErr(forbidden) && forbidden.error.data.code === "FORBIDDEN",
      `recruiter must not read the board pack: ${JSON.stringify(forbidden)}`,
    );
  });
});
