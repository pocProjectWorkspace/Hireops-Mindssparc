/**
 * R1.1 — the /reports catalog's sponsor pack: getHeadcountVsPlanReport
 * (#17) and getApprovalAnalyticsReport (#18).
 *
 * These pin the definitions the two reports live or die on:
 *   - an ENVELOPE is in range when its period OVERLAPS the window
 *     (period_start <= to AND period_end >= from), not when it is
 *     contained by it — so the straddling envelope below must appear;
 *   - requisitions are counted against an envelope over the ENVELOPE's
 *     whole life, never re-windowed by the report period;
 *   - `unplanned` is the off-plan half — requisitions with a null
 *     headcount_envelope_id, windowed on requisitions.created_at because
 *     they have no envelope period to overlap;
 *   - an approver's clock starts at the END OF THE PREVIOUS STEP (the
 *     previous decision on that request), NOT at the request. The fixture
 *     is built so a request-level attribution would give a visibly
 *     different answer (72h instead of 48h) — see Test 2.
 *
 * Coverage (5 cases):
 *   1. Headcount definitions — planned 10 / 5 openings / 50% utilisation
 *      / 1 hire on the main envelope; the straddling envelope is in and
 *      the 2014 envelope is out; ordering is newest period first; the
 *      off-plan requisition lands in `unplanned` and nowhere else.
 *   2. Approval turnaround + attribution — 24h and 72h spans give a 48h
 *      median and a 67.2h P90; one pending request; byStatus and
 *      bySubjectType zero-fill; per-step approver attribution.
 *   3. Filters — BU narrows the envelope table; a wider window pulls in
 *      both the 2014 envelope and the 2014 approval request that the
 *      fixture window excludes.
 *   4. Role gate — recruiter FORBIDDEN on BOTH procedures.
 *
 * Planted data — namespace 'a17', in the caller's own tenant, dated 2015
 * so the window isolates the fixture from live, demo and every other
 * suite's data (a14/a15 use 2016–2018); cleaned in afterAll. R1 is the
 * caller's own membership, R2 another active membership in the tenant.
 *
 *   ENVELOPE_A   BU-A  2015-03-01 → 2015-06-30  planned 10  approved
 *     REQ_1  3 openings  (APP_1 → offer_accepted = 1 hire)
 *     REQ_2  2 openings
 *   ENVELOPE_STRADDLE  BU-A  2015-06-01 → 2015-12-31  planned 3
 *   ENVELOPE_OUT       BU-A  2014-01-01 → 2014-02-28  planned 7
 *   ENVELOPE_B         BU-B  2015-03-01 → 2015-06-30  planned 4
 *     REQ_B  1 opening
 *   REQ_UNPLANNED      BU-A, no envelope, 4 openings, raised 2015-03-15
 *
 *   APPR_1        requested 2015-03-01 → decided 2015-03-02   (24h)
 *     DEC_1  step 0  R1  @ 2015-03-02                          (24h)
 *   APPR_2        requested 2015-03-01 → decided 2015-03-04   (72h)
 *     DEC_2  step 0  R1  @ 2015-03-02                          (24h)
 *     DEC_3  step 1  R2  @ 2015-03-04    48h after DEC_2, 72h after request
 *   APPR_PENDING  requested 2015-03-05, still pending
 *   APPR_OLD      requested 2014-01-01 → decided 2014-01-02 (out of window)
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

// Stable R1.1 fixture ids (hex-only suffix, v4 structure). 'a17' namespaces
// this ticket; 'a0xx' = BU-A chain, 'b0xx' = BU-B chain.
const BU_A = "00000000-0000-4000-8000-00000a17a001";
const ENVELOPE_A = "00000000-0000-4000-8000-00000a17a002";
const POSITION_A = "00000000-0000-4000-8000-00000a17a003";
const JD_A = "00000000-0000-4000-8000-00000a17a004";
const REQ_1 = "00000000-0000-4000-8000-00000a17a005";
const REQ_2 = "00000000-0000-4000-8000-00000a17a006";
const REQ_UNPLANNED = "00000000-0000-4000-8000-00000a17a007";
const ENVELOPE_STRADDLE = "00000000-0000-4000-8000-00000a17a008";
const ENVELOPE_OUT = "00000000-0000-4000-8000-00000a17a009";
const BU_B = "00000000-0000-4000-8000-00000a17b001";
const ENVELOPE_B = "00000000-0000-4000-8000-00000a17b002";
const POSITION_B = "00000000-0000-4000-8000-00000a17b003";
const JD_B = "00000000-0000-4000-8000-00000a17b004";
const REQ_B = "00000000-0000-4000-8000-00000a17b005";
const REQ_IDS = [REQ_1, REQ_2, REQ_UNPLANNED, REQ_B];
const ENVELOPE_IDS = [ENVELOPE_A, ENVELOPE_STRADDLE, ENVELOPE_OUT, ENVELOPE_B];

const PERSON_1 = "00000000-0000-4000-8000-00000a17c001";
const CAND_1 = "00000000-0000-4000-8000-00000a17d001";
const APP_1 = "00000000-0000-4000-8000-00000a17e001";

const MATRIX = "00000000-0000-4000-8000-00000a17f001";
const CHAIN = "00000000-0000-4000-8000-00000a17f002";
const APPR_1 = "00000000-0000-4000-8000-00000a170001";
const APPR_2 = "00000000-0000-4000-8000-00000a170002";
const APPR_PENDING = "00000000-0000-4000-8000-00000a170003";
const APPR_OLD = "00000000-0000-4000-8000-00000a170004";
const APPR_IDS = [APPR_1, APPR_2, APPR_PENDING, APPR_OLD];
const DEC_1 = "00000000-0000-4000-8000-00000a170101";
const DEC_2 = "00000000-0000-4000-8000-00000a170102";
const DEC_3 = "00000000-0000-4000-8000-00000a170103";

/** The fixture window: 2015 Q2-ish. Everything planted is inside it bar the 2014 pair. */
const WINDOW = { from: "2015-03-01T00:00:00Z", to: "2015-06-30T23:59:59Z" };
/** Wide enough to swallow the 2014 envelope and the 2014 approval request too. */
const WIDE_WINDOW = { from: "2014-01-01T00:00:00Z", to: "2015-12-31T23:59:59Z" };
const PENDING_REQUESTED_AT = "2015-03-05T00:00:00Z";

let jwt: string;
let recruiterJwt: string;
let testTenantId: string;
let r1: string;
let r2: string;

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

interface EnvelopeRow {
  envelopeId: string;
  businessUnitId: string;
  businessUnitName: string;
  periodStart: string;
  periodEnd: string;
  plannedHeadcount: number;
  status: string;
  reqsRaised: number;
  openingsRequested: number;
  hires: number;
  utilisationPct: number | null;
}
interface HeadcountReport {
  envelopes: EnvelopeRow[];
  totals: {
    envelopes: number;
    plannedHeadcount: number;
    reqsRaised: number;
    openingsRequested: number;
    hires: number;
    utilisationPct: number | null;
  };
  unplanned: { reqsRaised: number; openingsRequested: number };
}
interface ApprovalReport {
  byStatus: { status: string; count: number }[];
  turnaround: {
    medianHours: number | null;
    p90Hours: number | null;
    decidedCount: number;
    pendingCount: number;
    oldestPendingHours: number | null;
  };
  bottleneckApprovers: {
    approverMembershipId: string;
    approverName: string | null;
    decisions: number;
    medianHours: number;
  }[];
  bySubjectType: { subjectType: string; requests: number; medianHours: number | null }[];
}

async function headcount(input: unknown): Promise<HeadcountReport> {
  const body = await trpcQuery<HeadcountReport>("getHeadcountVsPlanReport", input, jwt);
  assert.ok(!isErr(body), `headcount query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}
async function approvals(input: unknown): Promise<ApprovalReport> {
  const body = await trpcQuery<ApprovalReport>("getApprovalAnalyticsReport", input, jwt);
  assert.ok(!isErr(body), `approval query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}

function envelopeFor(report: HeadcountReport, envelopeId: string): EnvelopeRow {
  const row = report.envelopes.find((e) => e.envelopeId === envelopeId);
  assert.ok(row, `envelope ${envelopeId} should be in the report`);
  return row;
}

async function plantChain(ids: {
  bu: string;
  position: string;
  jd: string;
  label: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${ids.bu}, ${testTenantId}, ${`R1.1 ${ids.label}`},
            ${`r11-bu-${ids.bu.slice(-6)}`})
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
    VALUES (${ids.position}, ${testTenantId}, ${ids.bu}, ${`R1.1 ${ids.label} Engineer`},
            'hybrid', 'Bengaluru', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${ids.jd}, ${testTenantId}, ${ids.position}, 1, 'R1.1 JD', 'approved')
  `;
}

async function plantEnvelope(args: {
  id: string;
  bu: string;
  periodStart: string;
  periodEnd: string;
  planned: number;
  status: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.headcount_envelopes
      (id, tenant_id, business_unit_id, period_start, period_end, planned_headcount, status)
    VALUES (${args.id}, ${testTenantId}, ${args.bu}, ${args.periodStart}::date,
            ${args.periodEnd}::date, ${args.planned}, ${args.status})
  `;
}

async function plantRequisition(args: {
  id: string;
  position: string;
  jd: string;
  envelope: string | null;
  openings: number;
  createdAt: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
       primary_recruiter_id, hiring_manager_id, created_by, status, number_of_openings,
       created_at, updated_at)
    VALUES (${args.id}, ${testTenantId}, ${args.position}, ${args.jd}, ${args.envelope},
            ${r1}, ${r1}, ${r1}, 'posted', ${args.openings},
            ${args.createdAt}::timestamptz, ${args.createdAt}::timestamptz)
  `;
}

async function plantApprovalRequest(args: {
  id: string;
  status: string;
  requestedAt: string;
  decidedAt: string | null;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.approval_requests
      (id, tenant_id, chain_id, subject_type, subject_id, status, requested_at, decided_at)
    VALUES (${args.id}, ${testTenantId}, ${CHAIN}, 'requisition', gen_random_uuid(),
            ${args.status}::approval_request_status, ${args.requestedAt}::timestamptz,
            ${args.decidedAt}::timestamptz)
  `;
}

async function plantDecision(args: {
  id: string;
  requestId: string;
  stepIndex: number;
  approver: string;
  decidedAt: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.approval_decisions
      (id, tenant_id, request_id, step_index, outcome, approver_membership_id, decided_at)
    VALUES (${args.id}, ${testTenantId}, ${args.requestId}, ${args.stepIndex}, 'approved',
            ${args.approver}, ${args.decidedAt}::timestamptz)
  `;
}

async function cleanup(): Promise<void> {
  for (const id of [DEC_1, DEC_2, DEC_3]) {
    await poolSql`DELETE FROM public.approval_decisions WHERE id = ${id}`;
  }
  for (const id of APPR_IDS) {
    await poolSql`DELETE FROM public.approval_requests WHERE id = ${id}`;
  }
  await poolSql`DELETE FROM public.approval_chains WHERE id = ${CHAIN}`;
  await poolSql`DELETE FROM public.approval_matrices WHERE id = ${MATRIX}`;

  await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${APP_1}`;
  await poolSql`DELETE FROM public.applications WHERE id = ${APP_1}`;
  await poolSql`DELETE FROM public.candidates WHERE id = ${CAND_1}`;
  await poolSql`DELETE FROM public.persons WHERE id = ${PERSON_1}`;

  // Transitions FK the requisition with ON DELETE RESTRICT — history first.
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
  // Requisitions FK the envelope — envelopes only after the reqs are gone.
  for (const id of ENVELOPE_IDS) {
    await poolSql`DELETE FROM public.headcount_envelopes WHERE id = ${id}`;
  }
  for (const id of [BU_A, BU_B]) {
    await poolSql`DELETE FROM public.business_units WHERE id = ${id}`;
  }
}

describe("R1.1 — /reports sponsor pack: headcount vs plan + approval cycle analytics", () => {
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

    // A SECOND membership in the same tenant, for the two-approver chain.
    const [other] = await poolSql<{ id: string }[]>`
      SELECT tum.id::text AS id
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE tum.tenant_id = ${testTenantId} AND tum.status = 'active' AND tum.id::text <> ${r1}
      ORDER BY (au.email = ${RECRUITER_EMAIL}) DESC, tum.id ASC
      LIMIT 1
    `;
    if (!other) throw new Error("a second membership is required for the approver fixture");
    r2 = other.id;

    await cleanup();

    await plantChain({ bu: BU_A, position: POSITION_A, jd: JD_A, label: "BU A" });
    await plantChain({ bu: BU_B, position: POSITION_B, jd: JD_B, label: "BU B" });

    await plantEnvelope({
      id: ENVELOPE_A,
      bu: BU_A,
      periodStart: "2015-03-01",
      periodEnd: "2015-06-30",
      planned: 10,
      status: "approved",
    });
    // Starts inside the window and ends long after it — the overlap case.
    await plantEnvelope({
      id: ENVELOPE_STRADDLE,
      bu: BU_A,
      periodStart: "2015-06-01",
      periodEnd: "2015-12-31",
      planned: 3,
      status: "approved",
    });
    // Ends before the window opens — the only excluded envelope.
    await plantEnvelope({
      id: ENVELOPE_OUT,
      bu: BU_A,
      periodStart: "2014-01-01",
      periodEnd: "2014-02-28",
      planned: 7,
      status: "closed",
    });
    await plantEnvelope({
      id: ENVELOPE_B,
      bu: BU_B,
      periodStart: "2015-03-01",
      periodEnd: "2015-06-30",
      planned: 4,
      status: "approved",
    });

    await plantRequisition({
      id: REQ_1,
      position: POSITION_A,
      jd: JD_A,
      envelope: ENVELOPE_A,
      openings: 3,
      createdAt: "2015-03-05T00:00:00Z",
    });
    await plantRequisition({
      id: REQ_2,
      position: POSITION_A,
      jd: JD_A,
      envelope: ENVELOPE_A,
      openings: 2,
      createdAt: "2015-03-10T00:00:00Z",
    });
    await plantRequisition({
      id: REQ_UNPLANNED,
      position: POSITION_A,
      jd: JD_A,
      envelope: null,
      openings: 4,
      createdAt: "2015-03-15T00:00:00Z",
    });
    await plantRequisition({
      id: REQ_B,
      position: POSITION_B,
      jd: JD_B,
      envelope: ENVELOPE_B,
      openings: 1,
      createdAt: "2015-03-20T00:00:00Z",
    });

    // The one hire — an application at offer_accepted on REQ_1.
    await poolSql`
      INSERT INTO public.persons
        (id, tenant_id, full_name, email_primary, email_normalised, location_country)
      VALUES (${PERSON_1}, ${testTenantId}, 'R1.1 Person',
              ${`${PERSON_1}@r11.test`}, ${`${PERSON_1}@r11.test`}, 'IN')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${CAND_1}, ${testTenantId}, ${PERSON_1}, 'referral'::application_source, 'v1')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, assigned_recruiter_membership_id, source,
         current_stage, stage_entered_at, created_at, updated_at)
      VALUES (${APP_1}, ${testTenantId}, ${CAND_1}, ${REQ_1}, ${r1},
              'referral'::application_source, 'offer_accepted'::application_stage,
              '2015-04-01T00:00:00Z'::timestamptz, '2015-03-06T00:00:00Z'::timestamptz,
              '2015-04-01T00:00:00Z'::timestamptz)
    `;

    // Self-contained matrix + chain so the approval fixture owns its own
    // graph (same idiom as t42-governance-policy).
    await poolSql`
      INSERT INTO public.approval_matrices
        (id, tenant_id, subject_type, name, rules, effective_from, effective_to,
         created_by_membership_id)
      VALUES (${MATRIX}, ${testTenantId}, 'requisition', 'R1.1 Test Matrix',
              ${JSON.stringify({ steps: [{ approver_kind: "role", approver_ref: "hr_head", required: true }] })},
              '2015-01-01T00:00:00Z', '2016-01-01T00:00:00Z', ${r1})
    `;
    await poolSql`
      INSERT INTO public.approval_chains
        (id, tenant_id, matrix_id, matrix_version_snapshot, resolved_steps)
      VALUES (${CHAIN}, ${testTenantId}, ${MATRIX},
              ${JSON.stringify({ steps: [{ approver_kind: "role", approver_ref: "hr_head" }] })},
              ${JSON.stringify([
                {
                  step_index: 0,
                  approver_kind: "membership",
                  approver_ref: r1,
                  required: true,
                  order_index: 0,
                },
                {
                  step_index: 1,
                  approver_kind: "membership",
                  approver_ref: r2,
                  required: true,
                  order_index: 1,
                },
              ])})
    `;

    await plantApprovalRequest({
      id: APPR_1,
      status: "approved",
      requestedAt: "2015-03-01T00:00:00Z",
      decidedAt: "2015-03-02T00:00:00Z",
    });
    await plantApprovalRequest({
      id: APPR_2,
      status: "approved",
      requestedAt: "2015-03-01T00:00:00Z",
      decidedAt: "2015-03-04T00:00:00Z",
    });
    await plantApprovalRequest({
      id: APPR_PENDING,
      status: "pending",
      requestedAt: PENDING_REQUESTED_AT,
      decidedAt: null,
    });
    await plantApprovalRequest({
      id: APPR_OLD,
      status: "approved",
      requestedAt: "2014-01-01T00:00:00Z",
      decidedAt: "2014-01-02T00:00:00Z",
    });

    await plantDecision({
      id: DEC_1,
      requestId: APPR_1,
      stepIndex: 0,
      approver: r1,
      decidedAt: "2015-03-02T00:00:00Z",
    });
    await plantDecision({
      id: DEC_2,
      requestId: APPR_2,
      stepIndex: 0,
      approver: r1,
      decidedAt: "2015-03-02T00:00:00Z",
    });
    // 48h after DEC_2 but 72h after the request — the whole point of the
    // per-step attribution rule.
    await plantDecision({
      id: DEC_3,
      requestId: APPR_2,
      stepIndex: 1,
      approver: r2,
      decidedAt: "2015-03-04T00:00:00Z",
    });
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: headcount — plan vs raised, overlap semantics, and the off-plan reqs", async () => {
    // Scoped to BU A so the numbers are exact regardless of anything else
    // the tenant happens to hold in 2015.
    const report = await headcount({ ...WINDOW, businessUnitId: BU_A });

    const main = envelopeFor(report, ENVELOPE_A);
    assert.equal(main.plannedHeadcount, 10);
    assert.equal(main.status, "approved");
    assert.equal(main.periodStart, "2015-03-01", "date columns come back as calendar days");
    assert.equal(main.periodEnd, "2015-06-30");
    assert.equal(main.businessUnitName, "R1.1 BU A");
    assert.equal(main.reqsRaised, 2, "REQ_1 + REQ_2 point at this envelope");
    assert.equal(main.openingsRequested, 5, "3 + 2 openings");
    assert.equal(main.utilisationPct, 50, "5 openings against a plan of 10");
    assert.equal(main.hires, 1, "APP_1 sits at offer_accepted on REQ_1");

    // Overlap, not containment: the straddler starts inside the window and
    // ends six months past it, and must still be reported.
    const straddle = envelopeFor(report, ENVELOPE_STRADDLE);
    assert.equal(straddle.plannedHeadcount, 3);
    assert.equal(straddle.reqsRaised, 0, "nothing was raised against it");
    assert.equal(straddle.utilisationPct, 0, "0 of 3 is 0%, not null");
    assert.equal(
      report.envelopes.find((e) => e.envelopeId === ENVELOPE_OUT),
      undefined,
      "an envelope whose period ended before the window opened is out of range",
    );

    // Newest period first.
    assert.deepEqual(
      report.envelopes.map((e) => e.envelopeId),
      [ENVELOPE_STRADDLE, ENVELOPE_A],
      "envelopes are ordered newest period first",
    );

    assert.deepEqual(
      report.totals,
      {
        envelopes: 2,
        plannedHeadcount: 13,
        reqsRaised: 2,
        openingsRequested: 5,
        hires: 1,
        utilisationPct: 38.5,
      },
      "the rollup sums every envelope in range (5/13 = 38.5%)",
    );

    // The off-plan requisition is counted here and NOWHERE in the table.
    assert.deepEqual(
      report.unplanned,
      { reqsRaised: 1, openingsRequested: 4 },
      "REQ_UNPLANNED has no envelope, so it lands in the unplanned callout",
    );
    assert.equal(
      report.envelopes.reduce((sum, e) => sum + e.reqsRaised, 0),
      2,
      "…and it is not double-counted against any envelope",
    );
  });

  it("Test 2: approvals — 48h median, per-step approver attribution, zero-filled series", async () => {
    const pendingFloorHours = (Date.now() - Date.parse(PENDING_REQUESTED_AT)) / 3_600_000;
    const report = await approvals(WINDOW);

    assert.deepEqual(
      report.byStatus.map((s) => s.status),
      ["pending", "approved", "rejected", "cancelled", "expired"],
      "byStatus is zero-filled in lifecycle order",
    );
    const status = Object.fromEntries(report.byStatus.map((s) => [s.status, s.count]));
    assert.equal(status.approved, 2, "APPR_1 + APPR_2 (APPR_OLD is out of window)");
    assert.equal(status.pending, 1, "APPR_PENDING");
    assert.equal(status.rejected, 0, "an empty status still reports");

    assert.equal(report.turnaround.decidedCount, 2);
    assert.equal(report.turnaround.medianHours, 48, "median of a 24h and a 72h span");
    assert.equal(report.turnaround.p90Hours, 67.2, "percentile_cont interpolates: 24 + 0.9×48");
    assert.equal(report.turnaround.pendingCount, 1);
    assert.ok(
      (report.turnaround.oldestPendingHours ?? 0) >= pendingFloorHours - 1,
      `the pending request ages to now: ${report.turnaround.oldestPendingHours} >= ${pendingFloorHours}`,
    );

    // THE definition: R2's step-1 decision is timed from R1's step-0
    // decision (48h), not from the request (which would read 72h).
    assert.equal(
      report.bottleneckApprovers.length,
      2,
      "only the two fixture approvers are in range",
    );
    const [slowest, fastest] = report.bottleneckApprovers;
    assert.equal(slowest?.approverMembershipId, r2, "slowest median first");
    assert.equal(slowest?.decisions, 1);
    assert.equal(
      slowest?.medianHours,
      48,
      "a step's clock starts at the PREVIOUS decision, not at the request",
    );
    assert.equal(fastest?.approverMembershipId, r1);
    assert.equal(fastest?.decisions, 2, "DEC_1 + DEC_2");
    assert.equal(fastest?.medianHours, 24, "both of R1's step-0 decisions took 24h");
    assert.ok(fastest?.approverName, "approver display names resolve off the RLS path");

    assert.deepEqual(
      report.bySubjectType.map((s) => s.subjectType),
      ["headcount_envelope", "requisition", "jd_version", "offer"],
      "bySubjectType is zero-filled in enum order",
    );
    const bySubject = Object.fromEntries(report.bySubjectType.map((s) => [s.subjectType, s]));
    assert.equal(bySubject.requisition?.requests, 3, "two decided + one pending");
    assert.equal(bySubject.requisition?.medianHours, 48, "the median ignores the pending one");
    assert.equal(bySubject.offer?.requests, 0);
    assert.equal(bySubject.offer?.medianHours, null, "…with a null median, not a zero");
  });

  it("Test 3: filters — BU narrows the envelopes, the period bounds both reports", async () => {
    const buB = await headcount({ ...WINDOW, businessUnitId: BU_B });
    assert.deepEqual(
      buB.envelopes.map((e) => e.envelopeId),
      [ENVELOPE_B],
      "BU B sees only its own envelope",
    );
    assert.equal(buB.envelopes[0]?.plannedHeadcount, 4);
    assert.equal(buB.envelopes[0]?.openingsRequested, 1, "REQ_B's single opening");
    assert.equal(buB.envelopes[0]?.hires, 0);
    assert.equal(buB.totals.plannedHeadcount, 4, "BU A's 13 planned heads are out of scope");
    assert.deepEqual(
      buB.unplanned,
      { reqsRaised: 0, openingsRequested: 0 },
      "the off-plan requisition hangs off BU A",
    );

    // A wider period pulls the 2014 envelope back in — the window really is
    // doing the excluding in Test 1, not the business unit.
    const wide = await headcount({ ...WIDE_WINDOW, businessUnitId: BU_A });
    assert.deepEqual(
      wide.envelopes.map((e) => e.envelopeId),
      [ENVELOPE_STRADDLE, ENVELOPE_A, ENVELOPE_OUT],
      "the 2014 envelope overlaps the wider window",
    );
    assert.equal(wide.totals.plannedHeadcount, 20, "13 + the 2014 envelope's 7");

    // Same story on the approval side: the 2014 request appears only when
    // the window reaches back for it.
    const wideApprovals = await approvals(WIDE_WINDOW);
    const wideStatus = Object.fromEntries(wideApprovals.byStatus.map((s) => [s.status, s.count]));
    assert.equal(wideStatus.approved, 3, "APPR_OLD joins APPR_1 + APPR_2");
    assert.equal(wideApprovals.turnaround.decidedCount, 3);
  });

  it("Test 4: role gate — recruiter is FORBIDDEN on both sponsor reports", async () => {
    const headcountRes = await trpcQuery("getHeadcountVsPlanReport", {}, recruiterJwt);
    assert.ok(
      isErr(headcountRes) && headcountRes.error.data.code === "FORBIDDEN",
      `recruiter must not read the headcount report: ${JSON.stringify(headcountRes)}`,
    );
    const approvalRes = await trpcQuery("getApprovalAnalyticsReport", {}, recruiterJwt);
    assert.ok(
      isErr(approvalRes) && approvalRes.error.data.code === "FORBIDDEN",
      `recruiter must not read the approval report: ${JSON.stringify(approvalRes)}`,
    );
  });
});
