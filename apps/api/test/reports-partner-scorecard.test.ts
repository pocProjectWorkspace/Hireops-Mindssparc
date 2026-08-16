/**
 * R1.3 — the /reports catalog's partner / agency scorecard (#7).
 *
 * This pins the definitions the report lives or dies on:
 *   - SHORTLIST RATE is EVER-REACHED, off application_state_transitions,
 *     NOT the current stage. The fixture is built so the two readings
 *     disagree: org A's hired submission currently sits at offer_accepted,
 *     and it must still count as shortlisted because it passed through the
 *     stage. A current-stage reading would report 0%, not 50%.
 *   - FEES follow the HIRE date (`partner_fees.hired_at`), not the
 *     application date — Test 3 narrows the window so the submissions stay
 *     in range while the fee drops out, which only one of those two
 *     readings can produce.
 *   - MEDIAN DAYS TO SUBMIT is assignment → first submission on that
 *     requisition; the assignment is planted exactly 10 days before org A's
 *     first submission and 5 before org B's, so the number is pinned.
 *   - DUPLICATE BLOCKS are attributed through partner_users (the attempt
 *     records the person, not the org) and windowed on attempted_at.
 *   - ACTIVE ASSIGNMENTS / ACTIVE CLAIMS are current state and take no
 *     window at all — Test 3's narrow window must not move them.
 *   - A DIRECT (non-partner) application is the negative control: it sits
 *     on org A's own requisition, in the window, at offer_accepted with a
 *     full transition history, and it must influence nothing.
 *
 * Coverage (4 cases):
 *   1. Row correctness — org A: 2 submissions, 50% shortlist, 1 hire, 50%
 *      hire rate, ₹5,00,000 accrued, 10 median days, 1 active claim, 1
 *      assignment. Org B: 1 submission, 0% shortlist, 1 duplicate blocked,
 *      5 median days. The direct application is counted nowhere.
 *   2. Ever-reached vs current stage — the hired application still counts
 *      in the shortlist rate; the one that never left recruiter_review does
 *      not.
 *   3. Window — a from-bound past org B's submission zeroes its volume
 *      columns while leaving the row (it is active) and its current-state
 *      columns alone; a to-bound before the hire date drops the fee while
 *      keeping the submissions that earned it.
 *   4. BU filter narrows to one agency's requisition; role gate: recruiter
 *      is FORBIDDEN.
 *
 * Planted data — namespace 'a18', in the caller's own tenant, dated 2014 so
 * the window isolates the fixture from live, demo and every other suite's
 * data (a17 uses 2015, a14/a15 use 2016–2018); cleaned in afterAll. Both
 * orgs are ACTIVE, which is also what makes Test 3's "zeroed but present"
 * assertion meaningful.
 *
 *   ORG_A  empanelled, active            ORG_B  empanelled, active
 *     ASG_A   REQ_A (BU A)  2014-03-01     ASG_B   REQ_B (BU B)  2014-03-01
 *     APP_A1  2014-03-11  → shortlisted 03-15 → offer_accepted 04-01 (HIRE)
 *             FEE_A  ₹5,00,000 accrued, hired_at 2014-04-01
 *     APP_A2  2014-03-21  → recruiter_review only
 *     CLAIM_A active on APP_A1's person
 *                                          APP_B1  2014-03-06  (received)
 *                                          DEDUP_B block_active_claim 03-15
 *   APP_DIRECT  REQ_A, career_site, 2014-03-12 → offer_accepted (control)
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

// Stable R1.3 fixture ids (hex-only suffix, v4 structure). 'a18' namespaces
// this ticket; 'a0xx' = the BU-A / org-A chain, 'b0xx' = BU-B / org-B.
const BU_A = "00000000-0000-4000-8000-00000a18a001";
const POSITION_A = "00000000-0000-4000-8000-00000a18a002";
const JD_A = "00000000-0000-4000-8000-00000a18a003";
const REQ_A = "00000000-0000-4000-8000-00000a18a004";
const BU_B = "00000000-0000-4000-8000-00000a18b001";
const POSITION_B = "00000000-0000-4000-8000-00000a18b002";
const JD_B = "00000000-0000-4000-8000-00000a18b003";
const REQ_B = "00000000-0000-4000-8000-00000a18b004";
const REQ_IDS = [REQ_A, REQ_B];

const ORG_A = "00000000-0000-4000-8000-00000a18c001";
const ORG_B = "00000000-0000-4000-8000-00000a18c002";
const ORG_IDS = [ORG_A, ORG_B];
const PU_A = "00000000-0000-4000-8000-00000a18c101";
const PU_B = "00000000-0000-4000-8000-00000a18c102";
const PU_IDS = [PU_A, PU_B];
const ASG_A = "00000000-0000-4000-8000-00000a18c201";
const ASG_B = "00000000-0000-4000-8000-00000a18c202";
const ASG_IDS = [ASG_A, ASG_B];

const PERSON_A1 = "00000000-0000-4000-8000-00000a18d001";
const PERSON_A2 = "00000000-0000-4000-8000-00000a18d002";
const PERSON_B1 = "00000000-0000-4000-8000-00000a18d003";
const PERSON_DIRECT = "00000000-0000-4000-8000-00000a18d004";
const PERSON_IDS = [PERSON_A1, PERSON_A2, PERSON_B1, PERSON_DIRECT];
const CAND_A1 = "00000000-0000-4000-8000-00000a18e001";
const CAND_A2 = "00000000-0000-4000-8000-00000a18e002";
const CAND_B1 = "00000000-0000-4000-8000-00000a18e003";
const CAND_DIRECT = "00000000-0000-4000-8000-00000a18e004";
const CAND_IDS = [CAND_A1, CAND_A2, CAND_B1, CAND_DIRECT];
const APP_A1 = "00000000-0000-4000-8000-00000a18f001";
const APP_A2 = "00000000-0000-4000-8000-00000a18f002";
const APP_B1 = "00000000-0000-4000-8000-00000a18f003";
const APP_DIRECT = "00000000-0000-4000-8000-00000a18f004";
const APP_IDS = [APP_A1, APP_A2, APP_B1, APP_DIRECT];

const FEE_A = "00000000-0000-4000-8000-00000a180001";
const CLAIM_A = "00000000-0000-4000-8000-00000a180002";
const DEDUP_B = "00000000-0000-4000-8000-00000a180003";

/** The fixture window: 2014 Q1–Q2. Everything planted is inside it. */
const WINDOW = { from: "2014-03-01T00:00:00Z", to: "2014-06-30T23:59:59Z" };
/** Opens after org B's submission (2014-03-06) but before org A's (2014-03-11). */
const LATE_WINDOW = { from: "2014-03-10T00:00:00Z", to: "2014-06-30T23:59:59Z" };
/** Closes before the hire date (2014-04-01) but after every submission. */
const PRE_HIRE_WINDOW = { from: "2014-03-01T00:00:00Z", to: "2014-03-31T23:59:59Z" };

/** ₹5,00,000 in paise — the one accrued fee. */
const FEE_A_MINOR = "50000000";

let jwt: string;
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

interface ScorecardRow {
  partnerOrgId: string;
  orgName: string;
  tier: string;
  active: boolean;
  activeAssignments: number;
  submissions: number;
  shortlistRate: number | null;
  hires: number;
  hireRate: number | null;
  duplicateBlocked: number;
  activeClaims: number;
  feesAccruedMinor: string;
  feesCurrency: string | null;
  medianDaysToSubmit: number | null;
}
interface ScorecardReport {
  rows: ScorecardRow[];
}

async function scorecard(input: unknown): Promise<ScorecardReport> {
  const body = await trpcQuery<ScorecardReport>("getPartnerScorecardReport", input, jwt);
  assert.ok(!isErr(body), `scorecard query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}

function rowFor(report: ScorecardReport, partnerOrgId: string): ScorecardRow {
  const row = report.rows.find((r) => r.partnerOrgId === partnerOrgId);
  assert.ok(row, `partner org ${partnerOrgId} should be in the report`);
  return row;
}

async function plantChain(ids: {
  bu: string;
  position: string;
  jd: string;
  req: string;
  label: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${ids.bu}, ${testTenantId}, ${`R1.3 ${ids.label}`},
            ${`r13-bu-${ids.bu.slice(-6)}`})
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
    VALUES (${ids.position}, ${testTenantId}, ${ids.bu}, ${`R1.3 ${ids.label} Engineer`},
            'hybrid', 'Bengaluru', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${ids.jd}, ${testTenantId}, ${ids.position}, 1, 'R1.3 JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id,
       created_by, status, number_of_openings, created_at, updated_at)
    VALUES (${ids.req}, ${testTenantId}, ${ids.position}, ${ids.jd}, ${r1}, ${r1}, ${r1},
            'posted', 2, '2014-02-01T00:00:00Z'::timestamptz, '2014-02-01T00:00:00Z'::timestamptz)
  `;
}

async function plantOrg(args: { id: string; name: string; userId: string }): Promise<void> {
  await poolSql`
    INSERT INTO public.partner_orgs (id, tenant_id, name, tier, active, onboarded_at)
    VALUES (${args.id}, ${testTenantId}, ${args.name}, 'empanelled'::partner_tier, true,
            '2014-01-01T00:00:00Z'::timestamptz)
  `;
  await poolSql`
    INSERT INTO public.partner_users
      (id, tenant_id, partner_org_id, user_id, full_name, email, role, active)
    VALUES (${args.userId}, ${testTenantId}, ${args.id}, gen_random_uuid(),
            ${`${args.name} Recruiter`}, ${`${args.userId}@r13.test`},
            'partner_user'::partner_user_role, true)
  `;
}

async function plantAssignment(args: {
  id: string;
  org: string;
  req: string;
  assignedAt: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.partner_assignments
      (id, tenant_id, partner_org_id, requisition_id, assigned_by_membership_id, assigned_at,
       status)
    VALUES (${args.id}, ${testTenantId}, ${args.org}, ${args.req}, ${r1},
            ${args.assignedAt}::timestamptz, 'active'::partner_assignment_status)
  `;
}

async function plantApplication(args: {
  person: string;
  candidate: string;
  application: string;
  req: string;
  /** null for the direct-applicant control. */
  org: string | null;
  source: string;
  stage: string;
  createdAt: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${args.person}, ${testTenantId}, ${`R1.3 ${args.person.slice(-4)}`},
            ${`${args.person}@r13.test`}, ${`${args.person}@r13.test`}, 'IN')
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
    VALUES (${args.application}, ${testTenantId}, ${args.candidate}, ${args.req}, ${r1},
            ${args.source}::application_source, ${args.org},
            ${args.stage}::application_stage, ${args.createdAt}::timestamptz,
            ${args.createdAt}::timestamptz, ${args.createdAt}::timestamptz)
  `;
}

async function plantTransition(args: {
  application: string;
  fromStage: string | null;
  toStage: string;
  at: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.application_state_transitions
      (tenant_id, application_id, from_stage, to_stage, transitioned_at, actor_membership_id)
    VALUES (${testTenantId}, ${args.application}, ${args.fromStage}::application_stage,
            ${args.toStage}::application_stage, ${args.at}::timestamptz, ${r1})
  `;
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.partner_fees WHERE id = ${FEE_A}`;
  await poolSql`DELETE FROM public.candidate_dedup_attempts WHERE id = ${DEDUP_B}`;
  await poolSql`DELETE FROM public.candidate_ownership_claims WHERE id = ${CLAIM_A}`;

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

  for (const id of ASG_IDS) {
    await poolSql`DELETE FROM public.partner_assignments WHERE id = ${id}`;
  }
  for (const id of PU_IDS) {
    await poolSql`DELETE FROM public.partner_users WHERE id = ${id}`;
  }
  for (const id of ORG_IDS) {
    await poolSql`DELETE FROM public.partner_orgs WHERE id = ${id}`;
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

describe("R1.3 — /reports partner scorecard", () => {
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

    await cleanup();

    await plantChain({ bu: BU_A, position: POSITION_A, jd: JD_A, req: REQ_A, label: "BU A" });
    await plantChain({ bu: BU_B, position: POSITION_B, jd: JD_B, req: REQ_B, label: "BU B" });

    await plantOrg({ id: ORG_A, name: "R1.3 Agency A", userId: PU_A });
    await plantOrg({ id: ORG_B, name: "R1.3 Agency B", userId: PU_B });

    // The clocks: 10 days before org A's first submission, 5 before org B's.
    await plantAssignment({
      id: ASG_A,
      org: ORG_A,
      req: REQ_A,
      assignedAt: "2014-03-01T00:00:00Z",
    });
    await plantAssignment({
      id: ASG_B,
      org: ORG_B,
      req: REQ_B,
      assignedAt: "2014-03-01T00:00:00Z",
    });

    // Org A's hire — currently offer_accepted, but it PASSED THROUGH
    // shortlisted, which is the only reason it counts in the shortlist rate.
    await plantApplication({
      person: PERSON_A1,
      candidate: CAND_A1,
      application: APP_A1,
      req: REQ_A,
      org: ORG_A,
      source: "partner_empanelled",
      stage: "offer_accepted",
      createdAt: "2014-03-11T00:00:00Z",
    });
    await plantTransition({
      application: APP_A1,
      fromStage: "recruiter_review",
      toStage: "shortlisted",
      at: "2014-03-15T00:00:00Z",
    });
    await plantTransition({
      application: APP_A1,
      fromStage: "offer_drafted",
      toStage: "offer_accepted",
      at: "2014-04-01T00:00:00Z",
    });

    // Org A's second submission — never got past recruiter_review.
    await plantApplication({
      person: PERSON_A2,
      candidate: CAND_A2,
      application: APP_A2,
      req: REQ_A,
      org: ORG_A,
      source: "partner_empanelled",
      stage: "recruiter_review",
      createdAt: "2014-03-21T00:00:00Z",
    });
    await plantTransition({
      application: APP_A2,
      fromStage: "ai_screening",
      toStage: "recruiter_review",
      at: "2014-03-22T00:00:00Z",
    });

    // Org B's single submission.
    await plantApplication({
      person: PERSON_B1,
      candidate: CAND_B1,
      application: APP_B1,
      req: REQ_B,
      org: ORG_B,
      source: "partner_empanelled",
      stage: "application_received",
      createdAt: "2014-03-06T00:00:00Z",
    });

    // The negative control: a direct applicant on ORG A's requisition, in
    // the window, hired, with a transition history. Belongs to no partner.
    await plantApplication({
      person: PERSON_DIRECT,
      candidate: CAND_DIRECT,
      application: APP_DIRECT,
      req: REQ_A,
      org: null,
      source: "career_site",
      stage: "offer_accepted",
      createdAt: "2014-03-12T00:00:00Z",
    });
    await plantTransition({
      application: APP_DIRECT,
      fromStage: "recruiter_review",
      toStage: "shortlisted",
      at: "2014-03-16T00:00:00Z",
    });
    await plantTransition({
      application: APP_DIRECT,
      fromStage: "offer_drafted",
      toStage: "offer_accepted",
      at: "2014-04-02T00:00:00Z",
    });

    // The fee org A's hire accrued — dated by the HIRE, not the submission.
    await poolSql`
      INSERT INTO public.partner_fees
        (id, tenant_id, partner_org_id, application_id, msa_snapshot, fee_minor, fee_currency,
         status, hired_at)
      VALUES (${FEE_A}, ${testTenantId}, ${ORG_A}, ${APP_A1},
              ${JSON.stringify({ feeModel: "flat_per_hire", flatFeeMinor: 50000000 })},
              ${FEE_A_MINOR}::bigint, 'INR', 'accrued', '2014-04-01T00:00:00Z'::timestamptz)
    `;

    // Org A's live ownership claim on the candidate it placed.
    await poolSql`
      INSERT INTO public.candidate_ownership_claims
        (id, tenant_id, person_id, partner_org_id, claimed_via_partner_user_id,
         claimed_via_application_id, claimed_at, expires_at, status)
      VALUES (${CLAIM_A}, ${testTenantId}, ${PERSON_A1}, ${ORG_A}, ${PU_A}, ${APP_A1},
              '2014-03-11T00:00:00Z'::timestamptz, '2099-01-01T00:00:00Z'::timestamptz,
              'active'::ownership_claim_status)
    `;

    // Org B tried to submit someone another partner already owned.
    await poolSql`
      INSERT INTO public.candidate_dedup_attempts
        (id, tenant_id, attempted_at, attempted_by_partner_user_id, submitted_email,
         matched_person_id, decision, decision_reason, submission_metadata)
      VALUES (${DEDUP_B}, ${testTenantId}, '2014-03-15T00:00:00Z'::timestamptz, ${PU_B},
              ${`${PERSON_A1}@r13.test`}, ${PERSON_A1},
              'block_active_claim'::dedup_decision, 'owned_by_other_partner',
              ${JSON.stringify({ source: "partner_portal_submit", requisitionId: REQ_B })})
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: one row per agency — volume, quality, speed and money", async () => {
    const report = await scorecard(WINDOW);

    const a = rowFor(report, ORG_A);
    assert.equal(a.orgName, "R1.3 Agency A");
    assert.equal(a.tier, "empanelled");
    assert.equal(a.active, true);
    assert.equal(a.activeAssignments, 1, "ASG_A is the org's only live assignment");
    assert.equal(a.submissions, 2, "APP_A1 + APP_A2 carry source_partner_id = org A");
    assert.equal(a.shortlistRate, 50, "1 of 2 submissions reached shortlisted or beyond");
    assert.equal(a.hires, 1, "APP_A1 sits at offer_accepted");
    assert.equal(a.hireRate, 50);
    assert.equal(a.duplicateBlocked, 0, "org A was never turned away");
    assert.equal(a.activeClaims, 1, "CLAIM_A — a current-state count, not a windowed one");
    assert.equal(a.feesAccruedMinor, FEE_A_MINOR, "bigint minor units cross the wire as a string");
    assert.equal(a.feesCurrency, "INR");
    assert.equal(
      a.medianDaysToSubmit,
      10,
      "assigned 2014-03-01, first submission 2014-03-11 — one pair, so the median is that pair",
    );

    const b = rowFor(report, ORG_B);
    assert.equal(b.submissions, 1);
    assert.equal(b.shortlistRate, 0, "APP_B1 never left application_received — 0%, not null");
    assert.equal(b.hires, 0);
    assert.equal(b.hireRate, 0);
    assert.equal(
      b.duplicateBlocked,
      1,
      "DEDUP_B — the quality signal, attributed via partner_users",
    );
    assert.equal(b.activeClaims, 0);
    assert.equal(b.feesAccruedMinor, "0", "no hire, no fee");
    assert.equal(b.feesCurrency, null, "…and no currency to state");
    assert.equal(b.medianDaysToSubmit, 5, "assigned 2014-03-01, submitted 2014-03-06");

    // Busiest first: org A's 2 submissions outrank org B's 1. Other orgs in
    // the tenant (if any) have no 2014 activity and sort below both.
    const planted = report.rows.filter((r) => r.partnerOrgId === ORG_A || r.partnerOrgId === ORG_B);
    assert.deepEqual(
      planted.map((r) => r.partnerOrgId),
      [ORG_A, ORG_B],
      "rows are ordered submissions desc",
    );

    // THE negative control: the direct applicant is on org A's requisition,
    // in the window, hired — and lands on nobody's row.
    assert.equal(
      report.rows.reduce((sum, r) => sum + r.submissions, 0),
      3,
      "only the three partner-attributed applications are counted, tenant-wide",
    );
    assert.equal(
      report.rows.reduce((sum, r) => sum + r.hires, 0),
      1,
      "…and only org A's hire, never the direct one",
    );
  });

  it("Test 2: shortlist rate is EVER-REACHED, not the current stage", async () => {
    const a = rowFor(await scorecard(WINDOW), ORG_A);

    // APP_A1's current stage is offer_accepted; it is in the numerator only
    // because a transition INTO shortlisted exists. A current-stage reading
    // ('shortlisted' right now) would put this at 0.
    assert.equal(
      a.shortlistRate,
      50,
      "the hired application still counts — it passed through shortlisted",
    );
    // …and APP_A2, whose only transition was into recruiter_review, does not
    // count, which is what keeps the rate at 50 rather than 100.
    assert.equal(a.submissions, 2);
    assert.equal(a.hires, 1, "the hire is a subset of the shortlisted, not a second count");
  });

  it("Test 3: the window bounds submissions, fees and blocks on their own clocks", async () => {
    // (a) A from-bound past org B's submission zeroes its volume columns —
    // but the row survives, because the org is ACTIVE.
    const late = await scorecard(LATE_WINDOW);
    const lateB = rowFor(late, ORG_B);
    assert.equal(lateB.submissions, 0, "APP_B1 (2014-03-06) is out of range");
    assert.equal(lateB.shortlistRate, null, "a rate over zero submissions is unknown, not 0%");
    assert.equal(lateB.hireRate, null);
    assert.equal(lateB.medianDaysToSubmit, null, "no submission, no pair, no median");
    assert.equal(lateB.activeAssignments, 1, "assignments are current state — the window is N/A");
    assert.equal(lateB.duplicateBlocked, 1, "the block (2014-03-15) is still in range");

    const lateA = rowFor(late, ORG_A);
    assert.equal(lateA.submissions, 2, "org A's submissions are both after the from-bound");
    assert.equal(lateA.feesAccruedMinor, FEE_A_MINOR);

    // (b) A to-bound before the hire date drops the FEE while keeping the
    // submissions that earned it — only "fees follow hired_at" does this.
    const preHire = await scorecard(PRE_HIRE_WINDOW);
    const preHireA = rowFor(preHire, ORG_A);
    assert.equal(preHireA.submissions, 2, "both submissions were made in March");
    assert.equal(preHireA.hires, 1, "the hire is a current-stage count on those submissions");
    assert.equal(
      preHireA.feesAccruedMinor,
      "0",
      "the fee's hired_at is 2014-04-01, outside a window that closes 2014-03-31",
    );
    assert.equal(preHireA.feesCurrency, null);
    assert.equal(preHireA.activeClaims, 1, "claims never move with the window");
  });

  it("Test 4: BU narrows to that agency's requisition; recruiter is FORBIDDEN", async () => {
    const buA = await scorecard({ ...WINDOW, businessUnitId: BU_A });
    const a = rowFor(buA, ORG_A);
    assert.equal(a.submissions, 2, "org A works REQ_A, which sits in BU A");
    assert.equal(a.activeAssignments, 1);
    assert.equal(a.feesAccruedMinor, FEE_A_MINOR, "the fee's application is on REQ_A too");

    const b = rowFor(buA, ORG_B);
    assert.equal(b.submissions, 0, "org B's submission is on REQ_B, in BU B");
    assert.equal(b.activeAssignments, 0, "…as is its assignment");
    assert.equal(b.active, true, "an active org with nothing in scope still gets a row");

    const buB = await scorecard({ ...WINDOW, businessUnitId: BU_B });
    assert.equal(rowFor(buB, ORG_B).submissions, 1);
    assert.equal(rowFor(buB, ORG_A).submissions, 0);
    assert.equal(rowFor(buB, ORG_A).feesAccruedMinor, "0", "BU narrows the money too");

    const forbidden = await trpcQuery("getPartnerScorecardReport", {}, recruiterJwt);
    assert.ok(
      isErr(forbidden) && forbidden.error.data.code === "FORBIDDEN",
      `recruiter must not read the partner scorecard: ${JSON.stringify(forbidden)}`,
    );
  });
});
