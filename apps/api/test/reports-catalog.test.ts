/**
 * R0.2 — the /reports catalog's two genuinely-new P0 reports:
 * getRequisitionAgingReport (#1) and getRecruiterProductivityReport (#5).
 *
 * These pin the two DEFINITIONS the reports live or die on:
 *   - daysOpen stops at the first transition into the current terminal
 *     status (there is no closed_at column — the assessment pinned this),
 *     and keeps running to now while the requisition is live.
 *   - productivity attribution is two-keyed: reqsOwned follows
 *     requisitions.primary_recruiter_id over the REQUISITION-created
 *     window; the four activity counts follow
 *     applications.assigned_recruiter_membership_id over the
 *     APPLICATION-created window. A source filter therefore narrows
 *     applications but must NOT change reqsOwned.
 *
 * Coverage (6 cases):
 *   1. Aging definitions — the filled req's daysOpen stops at exactly 40
 *      days with closedAt stamped; the open req keeps ageing past its
 *      created→now floor; the byStatus rollup is zero-filled across all
 *      eight statuses and counts the window's reqs; rows are oldest-first;
 *      recruiter display names resolve (the service-role name path).
 *   2. Aging filters — businessUnitId excludes the other BU's req (both
 *      ways round); recruiterMembershipId narrows to that owner's reqs.
 *   3. Productivity pinned counts — per-recruiter reqsOwned /
 *      applications / interviewsScheduled / offersExtended / hires, with
 *      the drafted-but-never-extended offer excluded and the busiest
 *      recruiter sorted first.
 *   4. Productivity source filter — referral narrows R1's applications
 *      2-of-3 and leaves reqsOwned untouched; R2, whose only application
 *      is off-channel, still appears on the strength of the req it owns.
 *   5. Productivity BU filter — BU-B sees only R2's chain.
 *   6. Role gate — recruiter FORBIDDEN on BOTH procedures.
 *
 * Planted data — namespace 'a15', in the caller's own tenant, dated
 * March/April 2017 so the window isolates the fixture from the tenant's
 * live and demo data (the same idiom as R0.1's a14 suite); cleaned in
 * afterAll. R1 is the caller's own membership, R2 another active
 * membership in the same tenant (recruiter1 when present).
 *
 *   BU-A                                       BU-B
 *   REQ_OPEN    posted, opened 2017-03-01, R1, 2 openings   (never closed)
 *   REQ_FILLED  filled, opened 2017-03-01, R1, 1 opening
 *               transitions: → posted 03-01, → filled 04-10   ⇒ 40 days
 *   REQ_B       posted, opened 2017-03-05, R2, 1 opening
 *
 *   APP_1  R1  referral     offer_accepted  2017-03-02  offer EXTENDED+accepted
 *   APP_2  R1  career_site  tech_interview  2017-03-03  2 interviews
 *   APP_3  R1  referral     recruiter_review 2017-03-04 offer DRAFTED (not extended)
 *   APP_4  R2  job_board    shortlisted     2017-03-06  1 interview  (REQ_B)
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

// Stable R0.2 fixture ids (hex-only suffix, v4 structure). '0a15' namespaces
// this ticket; 'a0xx' = BU-A chain, 'b0xx' = BU-B chain.
const BU_A = "00000000-0000-4000-8000-00000a15a001";
const ENVELOPE_A = "00000000-0000-4000-8000-00000a15a002";
const POSITION_A = "00000000-0000-4000-8000-00000a15a003";
const JD_A = "00000000-0000-4000-8000-00000a15a004";
const REQ_OPEN = "00000000-0000-4000-8000-00000a15a005";
const REQ_FILLED = "00000000-0000-4000-8000-00000a15a006";
const BU_B = "00000000-0000-4000-8000-00000a15b001";
const ENVELOPE_B = "00000000-0000-4000-8000-00000a15b002";
const POSITION_B = "00000000-0000-4000-8000-00000a15b003";
const JD_B = "00000000-0000-4000-8000-00000a15b004";
const REQ_B = "00000000-0000-4000-8000-00000a15b005";
const REQ_IDS = [REQ_OPEN, REQ_FILLED, REQ_B];

const PERSON_1 = "00000000-0000-4000-8000-00000a15c001";
const PERSON_2 = "00000000-0000-4000-8000-00000a15c002";
const PERSON_3 = "00000000-0000-4000-8000-00000a15c003";
const PERSON_4 = "00000000-0000-4000-8000-00000a15c004";
const PERSON_IDS = [PERSON_1, PERSON_2, PERSON_3, PERSON_4];
const CAND_1 = "00000000-0000-4000-8000-00000a15d001";
const CAND_2 = "00000000-0000-4000-8000-00000a15d002";
const CAND_3 = "00000000-0000-4000-8000-00000a15d003";
const CAND_4 = "00000000-0000-4000-8000-00000a15d004";
const CAND_IDS = [CAND_1, CAND_2, CAND_3, CAND_4];
const APP_1 = "00000000-0000-4000-8000-00000a15e001";
const APP_2 = "00000000-0000-4000-8000-00000a15e002";
const APP_3 = "00000000-0000-4000-8000-00000a15e003";
const APP_4 = "00000000-0000-4000-8000-00000a15e004";
const APP_IDS = [APP_1, APP_2, APP_3, APP_4];
const OFFER_EXTENDED = "00000000-0000-4000-8000-00000a15f001";
const OFFER_DRAFTED = "00000000-0000-4000-8000-00000a15f002";
const INTERVIEW_1 = "00000000-0000-4000-8000-00000a150001";
const INTERVIEW_2 = "00000000-0000-4000-8000-00000a150002";
const INTERVIEW_3 = "00000000-0000-4000-8000-00000a150003";
const INTERVIEW_IDS = [INTERVIEW_1, INTERVIEW_2, INTERVIEW_3];

/** The fixture window: everything planted is raised/received inside it. */
const WINDOW = { from: "2017-03-01T00:00:00Z", to: "2017-04-30T23:59:59Z" };
/** REQ_FILLED: raised 2017-03-01, filled 2017-04-10 — exactly 40 days. */
const FILLED_DAYS = 40;
const REQ_OPEN_CREATED = "2017-03-01T00:00:00Z";

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

interface AgingRow {
  requisitionId: string;
  title: string;
  status: string;
  isTerminal: boolean;
  openings: number;
  businessUnitId: string;
  businessUnitName: string;
  recruiterMembershipId: string;
  recruiterName: string | null;
  createdAt: string;
  closedAt: string | null;
  daysOpen: number;
}
interface AgingReport {
  rows: AgingRow[];
  byStatus: { status: string; count: number; avgDaysOpen: number | null }[];
  truncated: boolean;
}
interface ProductivityRow {
  recruiterMembershipId: string;
  recruiterName: string | null;
  reqsOwned: number;
  applications: number;
  interviewsScheduled: number;
  offersExtended: number;
  hires: number;
}
interface ProductivityReport {
  rows: ProductivityRow[];
}

async function aging(input: unknown): Promise<AgingReport> {
  const body = await trpcQuery<AgingReport>("getRequisitionAgingReport", input, jwt);
  assert.ok(!isErr(body), `aging query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}
async function productivity(input: unknown): Promise<ProductivityReport> {
  const body = await trpcQuery<ProductivityReport>("getRecruiterProductivityReport", input, jwt);
  assert.ok(!isErr(body), `productivity query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}

function rowFor(report: AgingReport, requisitionId: string): AgingRow {
  const row = report.rows.find((r) => r.requisitionId === requisitionId);
  assert.ok(row, `requisition ${requisitionId} should be in the report`);
  return row;
}
function recruiterRow(report: ProductivityReport, membershipId: string): ProductivityRow {
  const row = report.rows.find((r) => r.recruiterMembershipId === membershipId);
  assert.ok(row, `recruiter ${membershipId} should be in the report`);
  return row;
}

async function plantChain(ids: {
  bu: string;
  envelope: string;
  position: string;
  jd: string;
  label: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${ids.bu}, ${testTenantId}, ${`R0.2 ${ids.label}`},
            ${`r02-bu-${ids.bu.slice(-6)}`})
  `;
  await poolSql`
    INSERT INTO public.headcount_envelopes
      (id, tenant_id, business_unit_id, period_start, period_end, planned_headcount, status)
    VALUES (${ids.envelope}, ${testTenantId}, ${ids.bu}, '2017-01-01', '2017-12-31', 5, 'approved')
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
    VALUES (${ids.position}, ${testTenantId}, ${ids.bu}, ${`R0.2 ${ids.label} Engineer`},
            'hybrid', 'Bengaluru', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${ids.jd}, ${testTenantId}, ${ids.position}, 1, 'R0.2 JD', 'approved')
  `;
}

async function plantRequisition(args: {
  id: string;
  position: string;
  jd: string;
  envelope: string;
  recruiter: string;
  status: string;
  openings: number;
  createdAt: string;
  transitions: { from: string | null; to: string; at: string }[];
}): Promise<void> {
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
       primary_recruiter_id, hiring_manager_id, created_by, status, number_of_openings,
       created_at, updated_at)
    VALUES (${args.id}, ${testTenantId}, ${args.position}, ${args.jd}, ${args.envelope},
            ${args.recruiter}, ${r1}, ${r1}, ${args.status}, ${args.openings},
            ${args.createdAt}::timestamptz, ${args.createdAt}::timestamptz)
  `;
  for (const t of args.transitions) {
    await poolSql`
      INSERT INTO public.requisition_state_transitions
        (tenant_id, requisition_id, from_status, to_status, transitioned_at)
      VALUES (${testTenantId}, ${args.id}, ${t.from}, ${t.to}, ${t.at}::timestamptz)
    `;
  }
}

async function plantApplication(args: {
  appId: string;
  personId: string;
  candId: string;
  reqId: string;
  recruiter: string;
  source: string;
  currentStage: string;
  createdAt: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${args.personId}, ${testTenantId}, 'R0.2 Person',
            ${`${args.personId}@r02.test`}, ${`${args.personId}@r02.test`}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${args.candId}, ${testTenantId}, ${args.personId},
            ${args.source}::application_source, 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, assigned_recruiter_membership_id, source,
       current_stage, stage_entered_at, created_at, updated_at)
    VALUES (${args.appId}, ${testTenantId}, ${args.candId}, ${args.reqId}, ${args.recruiter},
            ${args.source}::application_source, ${args.currentStage}::application_stage,
            ${args.createdAt}::timestamptz, ${args.createdAt}::timestamptz,
            ${args.createdAt}::timestamptz)
  `;
}

async function plantInterview(args: {
  id: string;
  appId: string;
  reqId: string;
  round: number;
  at: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.interviews
      (id, tenant_id, application_id, requisition_id, round_number, round_name, status,
       scheduled_start, scheduled_end, mode, created_by_membership_id, created_at, updated_at)
    VALUES (${args.id}, ${testTenantId}, ${args.appId}, ${args.reqId}, ${args.round},
            ${`R0.2 round ${args.round}`}, 'scheduled', ${args.at}::timestamptz,
            ${args.at}::timestamptz, 'video', ${r1},
            ${args.at}::timestamptz, ${args.at}::timestamptz)
  `;
}

async function cleanup(): Promise<void> {
  for (const id of INTERVIEW_IDS) {
    await poolSql`DELETE FROM public.interviews WHERE id = ${id}`;
  }
  for (const id of [OFFER_EXTENDED, OFFER_DRAFTED]) {
    await poolSql`DELETE FROM public.offers WHERE id = ${id}`;
  }
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
  for (const id of [ENVELOPE_A, ENVELOPE_B]) {
    await poolSql`DELETE FROM public.headcount_envelopes WHERE id = ${id}`;
  }
  for (const id of [BU_A, BU_B]) {
    await poolSql`DELETE FROM public.business_units WHERE id = ${id}`;
  }
}

describe("R0.2 — /reports catalog: requisition aging + recruiter productivity", () => {
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

    // A SECOND recruiter in the same tenant. recruiter1 when it is a member
    // (it is on the seeded demo tenant); otherwise any other active
    // membership, so the suite doesn't depend on a particular seed run.
    const [other] = await poolSql<{ id: string }[]>`
      SELECT tum.id::text AS id
      FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE tum.tenant_id = ${testTenantId} AND tum.status = 'active' AND tum.id::text <> ${r1}
      ORDER BY (au.email = ${RECRUITER_EMAIL}) DESC, tum.id ASC
      LIMIT 1
    `;
    if (!other) throw new Error("a second membership is required for the productivity fixture");
    r2 = other.id;

    await cleanup();

    await plantChain({
      bu: BU_A,
      envelope: ENVELOPE_A,
      position: POSITION_A,
      jd: JD_A,
      label: "BU A",
    });
    await plantChain({
      bu: BU_B,
      envelope: ENVELOPE_B,
      position: POSITION_B,
      jd: JD_B,
      label: "BU B",
    });

    await plantRequisition({
      id: REQ_OPEN,
      position: POSITION_A,
      jd: JD_A,
      envelope: ENVELOPE_A,
      recruiter: r1,
      status: "posted",
      openings: 2,
      createdAt: REQ_OPEN_CREATED,
      transitions: [{ from: null, to: "posted", at: REQ_OPEN_CREATED }],
    });
    await plantRequisition({
      id: REQ_FILLED,
      position: POSITION_A,
      jd: JD_A,
      envelope: ENVELOPE_A,
      recruiter: r1,
      status: "filled",
      openings: 1,
      createdAt: "2017-03-01T00:00:00Z",
      transitions: [
        { from: null, to: "posted", at: "2017-03-01T00:00:00Z" },
        { from: "posted", to: "filled", at: "2017-04-10T00:00:00Z" },
      ],
    });
    await plantRequisition({
      id: REQ_B,
      position: POSITION_B,
      jd: JD_B,
      envelope: ENVELOPE_B,
      recruiter: r2,
      status: "posted",
      openings: 1,
      createdAt: "2017-03-05T00:00:00Z",
      transitions: [{ from: null, to: "posted", at: "2017-03-05T00:00:00Z" }],
    });

    await plantApplication({
      appId: APP_1,
      personId: PERSON_1,
      candId: CAND_1,
      reqId: REQ_OPEN,
      recruiter: r1,
      source: "referral",
      currentStage: "offer_accepted",
      createdAt: "2017-03-02T00:00:00Z",
    });
    await plantApplication({
      appId: APP_2,
      personId: PERSON_2,
      candId: CAND_2,
      reqId: REQ_OPEN,
      recruiter: r1,
      source: "career_site",
      currentStage: "tech_interview",
      createdAt: "2017-03-03T00:00:00Z",
    });
    await plantApplication({
      appId: APP_3,
      personId: PERSON_3,
      candId: CAND_3,
      reqId: REQ_FILLED,
      recruiter: r1,
      source: "referral",
      currentStage: "recruiter_review",
      createdAt: "2017-03-04T00:00:00Z",
    });
    await plantApplication({
      appId: APP_4,
      personId: PERSON_4,
      candId: CAND_4,
      reqId: REQ_B,
      recruiter: r2,
      source: "job_board",
      currentStage: "shortlisted",
      createdAt: "2017-03-06T00:00:00Z",
    });

    await plantInterview({
      id: INTERVIEW_1,
      appId: APP_2,
      reqId: REQ_OPEN,
      round: 1,
      at: "2017-03-10T09:00:00Z",
    });
    await plantInterview({
      id: INTERVIEW_2,
      appId: APP_2,
      reqId: REQ_OPEN,
      round: 2,
      at: "2017-03-17T09:00:00Z",
    });
    await plantInterview({
      id: INTERVIEW_3,
      appId: APP_4,
      reqId: REQ_B,
      round: 1,
      at: "2017-03-20T09:00:00Z",
    });

    // APP_1's offer went OUT and was accepted; APP_3's was only drafted, so
    // it must not count towards offersExtended.
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, extended_at, accepted_at, created_at)
      VALUES (${OFFER_EXTENDED}, ${testTenantId}, ${APP_1}, ${r1}, 250000000,
              '2017-05-01', 'Bengaluru', '2017-04-20T00:00:00Z'::timestamptz, 'accepted',
              '2017-04-01T00:00:00Z'::timestamptz, '2017-04-05T00:00:00Z'::timestamptz,
              '2017-03-28T00:00:00Z'::timestamptz)
    `;
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, created_at)
      VALUES (${OFFER_DRAFTED}, ${testTenantId}, ${APP_3}, ${r1}, 200000000,
              '2017-05-01', 'Bengaluru', '2017-04-20T00:00:00Z'::timestamptz, 'drafted',
              '2017-03-29T00:00:00Z'::timestamptz)
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: aging — the filled req's clock stops, the open req's keeps running", async () => {
    // The floor is computed BEFORE the query, so the server's now() is at
    // or after it; 2dp rounding can shave up to 0.005 days off.
    const openFloorDays = (Date.now() - Date.parse(REQ_OPEN_CREATED)) / 86_400_000;
    const report = await aging(WINDOW);

    const filled = rowFor(report, REQ_FILLED);
    assert.equal(filled.status, "filled");
    assert.equal(filled.isTerminal, true, "filled is a terminal status");
    assert.equal(
      filled.daysOpen,
      FILLED_DAYS,
      "2017-03-01 → the first 'filled' transition on 2017-04-10 = 40 days",
    );
    assert.ok(filled.closedAt, "closedAt is derived from requisition_state_transitions");
    assert.equal(
      new Date(filled.closedAt ?? "").toISOString(),
      "2017-04-10T00:00:00.000Z",
      "closedAt is the filled transition, not the req's updated_at",
    );
    assert.equal(filled.openings, 1);
    assert.equal(filled.businessUnitId, BU_A);
    assert.equal(filled.recruiterMembershipId, r1);
    assert.ok(filled.recruiterName, "the recruiter's display name resolves off the RLS path");

    const open = rowFor(report, REQ_OPEN);
    assert.equal(open.isTerminal, false, "posted is a live status");
    assert.equal(open.closedAt, null, "a live req has no close time");
    assert.ok(
      open.daysOpen >= openFloorDays - 0.05,
      `an open req ages to now: ${open.daysOpen} should be >= ${openFloorDays}`,
    );
    assert.ok(open.daysOpen > filled.daysOpen, "the 2017 open req is far older than 40 days");
    assert.equal(open.openings, 2);

    // Oldest first — REQ_OPEN (2017-03-01, still ageing) leads, then REQ_B
    // (2017-03-05, still ageing), then the 40-day filled req.
    const order = report.rows.map((r) => r.requisitionId);
    assert.deepEqual(order, [REQ_OPEN, REQ_B, REQ_FILLED], "rows are sorted oldest first");
    assert.equal(report.truncated, false, "three rows is well under the cap");

    // Rollup: zero-filled across all eight statuses, in lifecycle order.
    assert.deepEqual(
      report.byStatus.map((s) => s.status),
      [
        "draft",
        "pending_approval",
        "approved",
        "on_hold",
        "posted",
        "filled",
        "cancelled",
        "closed",
      ],
      "byStatus is zero-filled in canonical status order",
    );
    const rollup = Object.fromEntries(report.byStatus.map((s) => [s.status, s]));
    assert.equal(rollup.posted?.count, 2, "REQ_OPEN + REQ_B are posted");
    assert.equal(rollup.filled?.count, 1, "REQ_FILLED");
    assert.equal(rollup.draft?.count, 0, "an empty status still reports");
    assert.equal(rollup.draft?.avgDaysOpen, null, "…with a null average, not a zero");
    assert.equal(rollup.filled?.avgDaysOpen, FILLED_DAYS, "the only filled req is 40 days old");
    assert.equal(
      report.byStatus.reduce((sum, s) => sum + s.count, 0),
      report.rows.length,
      "the rollup accounts for every row",
    );
  });

  it("Test 2: aging filters — BU excludes the other chain, recruiter narrows to the owner", async () => {
    const buA = await aging({ ...WINDOW, businessUnitId: BU_A });
    assert.deepEqual(
      buA.rows.map((r) => r.requisitionId).sort(),
      [REQ_OPEN, REQ_FILLED].sort(),
      "BU A sees only its own two requisitions",
    );
    assert.equal(
      buA.byStatus.find((s) => s.status === "posted")?.count,
      1,
      "REQ_B's posted row is out of the BU A rollup too",
    );

    const buB = await aging({ ...WINDOW, businessUnitId: BU_B });
    assert.equal(buB.rows.length, 1, "BU B sees only REQ_B");
    assert.equal(buB.rows[0]?.requisitionId, REQ_B);
    assert.equal(buB.rows[0]?.businessUnitName, "R0.2 BU B");
    assert.equal(buB.byStatus.find((s) => s.status === "filled")?.count, 0);

    const owner = await aging({ ...WINDOW, recruiterMembershipId: r1 });
    assert.deepEqual(
      owner.rows.map((r) => r.requisitionId).sort(),
      [REQ_OPEN, REQ_FILLED].sort(),
      "the recruiter filter is the req's PRIMARY recruiter",
    );
    assert.ok(
      owner.rows.every((r) => r.recruiterMembershipId === r1),
      "no other owner's reqs leak in",
    );

    const otherOwner = await aging({ ...WINDOW, recruiterMembershipId: r2 });
    assert.deepEqual(
      otherOwner.rows.map((r) => r.requisitionId),
      [REQ_B],
    );
  });

  it("Test 3: productivity — pinned per-recruiter counts, busiest first", async () => {
    const report = await productivity(WINDOW);

    const one = recruiterRow(report, r1);
    assert.equal(one.reqsOwned, 2, "R1 is primary on REQ_OPEN + REQ_FILLED");
    assert.equal(one.applications, 3, "APP_1, APP_2, APP_3 are assigned to R1");
    assert.equal(one.interviewsScheduled, 2, "both rounds on APP_2");
    assert.equal(one.offersExtended, 1, "APP_1's offer went out; APP_3's was only drafted");
    assert.equal(one.hires, 1, "APP_1 sits at offer_accepted");
    assert.ok(one.recruiterName, "display names resolve for the productivity rows too");

    const two = recruiterRow(report, r2);
    assert.equal(two.reqsOwned, 1, "R2 owns REQ_B");
    assert.equal(two.applications, 1, "APP_4");
    assert.equal(two.interviewsScheduled, 1);
    assert.equal(two.offersExtended, 0);
    assert.equal(two.hires, 0);

    const positions = report.rows.map((r) => r.recruiterMembershipId);
    assert.ok(
      positions.indexOf(r1) < positions.indexOf(r2),
      "sorted by applications desc — R1 (3) before R2 (1)",
    );
  });

  it("Test 4: productivity source filter — narrows applications, never reqsOwned", async () => {
    const referral = await productivity({ ...WINDOW, source: "referral" });

    const one = recruiterRow(referral, r1);
    assert.equal(one.applications, 2, "APP_1 + APP_3 are referrals; APP_2 (career_site) drops");
    assert.equal(one.hires, 1, "APP_1 is still the hire");
    assert.equal(one.interviewsScheduled, 0, "APP_2's interviews leave with APP_2");
    assert.equal(one.offersExtended, 1, "APP_1's extended offer stays");
    assert.equal(
      one.reqsOwned,
      2,
      "ownership is a requisition fact — an application-source filter must not change it",
    );

    const two = recruiterRow(referral, r2);
    assert.equal(two.applications, 0, "APP_4 is job_board");
    assert.equal(
      two.reqsOwned,
      1,
      "R2 still earns a row on the strength of the requisition it owns",
    );
  });

  it("Test 5: productivity BU filter — BU B sees only the second chain", async () => {
    const buB = await productivity({ ...WINDOW, businessUnitId: BU_B });
    const two = recruiterRow(buB, r2);
    assert.equal(two.reqsOwned, 1);
    assert.equal(two.applications, 1);
    assert.equal(
      buB.rows.find((r) => r.recruiterMembershipId === r1),
      undefined,
      "R1's chain hangs off BU A entirely",
    );
  });

  it("Test 6: role gate — recruiter is FORBIDDEN on both catalog reports", async () => {
    const agingRes = await trpcQuery("getRequisitionAgingReport", {}, recruiterJwt);
    assert.ok(
      isErr(agingRes) && agingRes.error.data.code === "FORBIDDEN",
      `recruiter must not read the aging report: ${JSON.stringify(agingRes)}`,
    );
    const productivityRes = await trpcQuery("getRecruiterProductivityReport", {}, recruiterJwt);
    assert.ok(
      isErr(productivityRes) && productivityRes.error.data.code === "FORBIDDEN",
      `recruiter must not read the productivity report: ${JSON.stringify(productivityRes)}`,
    );
  });
});
