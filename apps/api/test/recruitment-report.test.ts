/**
 * REPORT-01 — tRPC tests for getRecruitmentReport (/admin/reports).
 *
 * Coverage (4 cases):
 *   1. Shape + zero-fill on an empty result set. Querying a window with no
 *      applications must return all 11 stages zero-filled in enum order
 *      (funnel + stageDurations), an empty sourceMix, null time-to-hire
 *      medians with hires_count = 0, and zero totals — never NOT_FOUND.
 *      (An empty date window is aggregate-equivalent to an empty tenant;
 *      the tRPC path is scoped to the JWT's tenant, so an empty window is
 *      how we exercise the zero-fill path — same idiom as ADMIN-03 Test 15.)
 *   2. Correctness on planted fixtures. Three applications with a known
 *      transition history (REPORT-prefixed ids, historical 2020-05 dates so
 *      the from/to window isolates them from the tenant's live data,
 *      cleaned in afterAll) — assert exact funnel counts, source mix +
 *      conversion, hand-computed medians (time-to-hire + stage durations),
 *      and totals.
 *   3. Tenant isolation. A fourth application planted in a synthetic OTHER
 *      tenant, in the same window, must be invisible: totals/funnel/
 *      sourceMix are unchanged from Test 2.
 *   4. from/to narrowing. A window that excludes R1's created_at drops it
 *      from every rollup.
 *
 * Planted data (window 2020-05-01 .. 2020-05-31):
 *   R1  referral    offer_accepted  created 05-01
 *       app_received(05-01→05-03, 2d) → recruiter_review(05-03→05-11, 8d)
 *       → offer_accepted(05-11)          time-to-hire = 10d
 *   R2  referral    offer_accepted  created 05-02
 *       app_received(05-02→05-06, 4d) → offer_accepted(05-06)
 *                                        time-to-hire = 4d
 *   R3  career_site tech_interview  created 05-03
 *       app_received(05-03→05-09, 6d) → tech_interview(05-09, open)
 *
 * Hand-computed expectations:
 *   funnel: offer_accepted 2, tech_interview 1, rest 0
 *   sourceMix: referral {apps 2, hires 2}, career_site {apps 1, hires 0}
 *   timeToHire: hires 2, median 7 (percentile_cont .5 of [4,10]),
 *               p90 9.4 (.9 of [4,10])
 *   stageDurations: application_received median 4 ([2,4,6]),
 *                   recruiter_review 8 ([8]), all others null
 *   totals: applications 3, active 1 (R3), hired 2, rejected_or_withdrawn 0
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

// Stable REPORT-01 fixture ids (hex-only suffix, v4 structure). '0e01'
// namespaces this ticket; 'a0xx' = test-tenant chain, 'f0xx' = synth tenant.
const R_BU = "00000000-0000-4000-8000-00000e01a001";
const R_ENVELOPE = "00000000-0000-4000-8000-00000e01a002";
const R_POSITION = "00000000-0000-4000-8000-00000e01a003";
const R_JD = "00000000-0000-4000-8000-00000e01a004";
const R_REQ = "00000000-0000-4000-8000-00000e01a005";
const R_PERSON_1 = "00000000-0000-4000-8000-00000e01a011";
const R_PERSON_2 = "00000000-0000-4000-8000-00000e01a012";
const R_PERSON_3 = "00000000-0000-4000-8000-00000e01a013";
const R_CAND_1 = "00000000-0000-4000-8000-00000e01a021";
const R_CAND_2 = "00000000-0000-4000-8000-00000e01a022";
const R_CAND_3 = "00000000-0000-4000-8000-00000e01a023";
const R_APP_1 = "00000000-0000-4000-8000-00000e01a031";
const R_APP_2 = "00000000-0000-4000-8000-00000e01a032";
const R_APP_3 = "00000000-0000-4000-8000-00000e01a033";

const R_SYNTH_TENANT = "00000000-0000-4000-8000-00000e01f001";
const R_SYNTH_MEMBERSHIP = "00000000-0000-4000-8000-00000e01f002";
const R_SYNTH_BU = "00000000-0000-4000-8000-00000e01f003";
const R_SYNTH_ENVELOPE = "00000000-0000-4000-8000-00000e01f004";
const R_SYNTH_POSITION = "00000000-0000-4000-8000-00000e01f005";
const R_SYNTH_JD = "00000000-0000-4000-8000-00000e01f006";
const R_SYNTH_REQ = "00000000-0000-4000-8000-00000e01f007";
const R_SYNTH_PERSON = "00000000-0000-4000-8000-00000e01f008";
const R_SYNTH_CAND = "00000000-0000-4000-8000-00000e01f009";
const R_SYNTH_APP = "00000000-0000-4000-8000-00000e01f00a";

const WINDOW_FROM = "2020-05-01T00:00:00Z";
const WINDOW_TO = "2020-05-31T23:59:59Z";

let jwt: string;
let testTenantId: string;
let testMembershipId: string;

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { data: { code: string; httpStatus?: number } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin: ${error?.message}`);
  return data.session.access_token;
}

async function trpcQuery<O>(
  name: string,
  input: unknown = undefined,
): Promise<TRPCSuccess<O> | TRPCErr> {
  const inputParam =
    input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(`/trpc/${name}${inputParam}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface RecruitmentReport {
  funnel: Array<{ stage: string; current_count: number }>;
  sourceMix: Array<{ source: string; applications: number; hires: number }>;
  timeToHire: { median_days: number | null; p90_days: number | null; hires_count: number };
  stageDurations: Array<{ stage: string; median_days: number | null }>;
  totals: { applications: number; active: number; hired: number; rejected_or_withdrawn: number };
}

const ALL_STAGES = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
];

/**
 * Plants the requisition FK chain (bu → envelope → position → jd → req)
 * for a tenant. Recruiter/HM/created_by all point at the given membership.
 */
async function plantChain(
  tid: string,
  membershipId: string,
  ids: { bu: string; envelope: string; position: string; jd: string; req: string; slug: string },
): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${ids.bu}, ${tid}, 'REPORT-01 BU', ${`report01-bu-${ids.bu.slice(-6)}`})
  `;
  await poolSql`
    INSERT INTO public.headcount_envelopes
      (id, tenant_id, business_unit_id, period_start, period_end, planned_headcount, status)
    VALUES (${ids.envelope}, ${tid}, ${ids.bu}, '2020-04-01', '2021-03-31', 5, 'approved')
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
    VALUES (${ids.position}, ${tid}, ${ids.bu}, 'REPORT-01 Engineer', 'hybrid', 'Bengaluru', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${ids.jd}, ${tid}, ${ids.position}, 1, 'REPORT-01 JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
       primary_recruiter_id, hiring_manager_id, created_by, status, number_of_openings)
    VALUES (${ids.req}, ${tid}, ${ids.position}, ${ids.jd}, ${ids.envelope},
            ${membershipId}, ${membershipId}, ${membershipId}, 'posted', 1)
  `;
}

async function plantCandidate(
  tid: string,
  personId: string,
  candId: string,
  source: string,
): Promise<void> {
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${personId}, ${tid}, 'REPORT Person', ${`${personId}@report.test`},
            ${`${personId}@report.test`}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${candId}, ${tid}, ${personId}, ${source}::application_source, 'v1')
  `;
}

async function plantApplication(
  tid: string,
  appId: string,
  candId: string,
  reqId: string,
  source: string,
  currentStage: string,
  createdAt: string,
  transitions: Array<{ from: string | null; to: string; at: string }>,
): Promise<void> {
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage,
       stage_entered_at, created_at, updated_at)
    VALUES (${appId}, ${tid}, ${candId}, ${reqId}, ${source}::application_source,
            ${currentStage}::application_stage, ${createdAt}::timestamptz,
            ${createdAt}::timestamptz, ${createdAt}::timestamptz)
  `;
  for (const t of transitions) {
    await poolSql`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, transitioned_at)
      VALUES (${tid}, ${appId},
              ${t.from === null ? null : t.from}::application_stage,
              ${t.to}::application_stage, ${t.at}::timestamptz)
    `;
  }
}

async function cleanup(): Promise<void> {
  const appIds = [R_APP_1, R_APP_2, R_APP_3, R_SYNTH_APP];
  for (const id of appIds) {
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${id}`;
  }
  for (const id of appIds) {
    await poolSql`DELETE FROM public.applications WHERE id = ${id}`;
  }
  const candIds = [R_CAND_1, R_CAND_2, R_CAND_3, R_SYNTH_CAND];
  for (const id of candIds) {
    await poolSql`DELETE FROM public.candidates WHERE id = ${id}`;
  }
  const personIds = [R_PERSON_1, R_PERSON_2, R_PERSON_3, R_SYNTH_PERSON];
  for (const id of personIds) {
    await poolSql`DELETE FROM public.persons WHERE id = ${id}`;
  }
  for (const id of [R_REQ, R_SYNTH_REQ]) {
    await poolSql`DELETE FROM public.requisitions WHERE id = ${id}`;
  }
  for (const id of [R_JD, R_SYNTH_JD]) {
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${id}`;
  }
  for (const id of [R_POSITION, R_SYNTH_POSITION]) {
    await poolSql`DELETE FROM public.positions WHERE id = ${id}`;
  }
  for (const id of [R_ENVELOPE, R_SYNTH_ENVELOPE]) {
    await poolSql`DELETE FROM public.headcount_envelopes WHERE id = ${id}`;
  }
  for (const id of [R_BU, R_SYNTH_BU]) {
    await poolSql`DELETE FROM public.business_units WHERE id = ${id}`;
  }
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE id = ${R_SYNTH_MEMBERSHIP}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${R_SYNTH_TENANT}`;
}

describe("REPORT-01 — getRecruitmentReport", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testTenantId = (claims as { tid?: string }).tid as string;
    const synthAuthUser = claims.sub as string;

    // The test user's membership in its own tenant — recruiter/HM/created_by
    // for the test-tenant requisition.
    const [membership] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE tenant_id = ${testTenantId} AND user_id = ${synthAuthUser} AND status = 'active'
      LIMIT 1
    `;
    if (!membership) throw new Error("test user membership not found in its tenant");
    testMembershipId = membership.id;

    await cleanup();

    // ── Test-tenant fixtures (the 3 planted applications) ──
    await plantChain(testTenantId, testMembershipId, {
      bu: R_BU,
      envelope: R_ENVELOPE,
      position: R_POSITION,
      jd: R_JD,
      req: R_REQ,
      slug: "report01-req",
    });
    await plantCandidate(testTenantId, R_PERSON_1, R_CAND_1, "referral");
    await plantCandidate(testTenantId, R_PERSON_2, R_CAND_2, "referral");
    await plantCandidate(testTenantId, R_PERSON_3, R_CAND_3, "career_site");

    await plantApplication(
      testTenantId,
      R_APP_1,
      R_CAND_1,
      R_REQ,
      "referral",
      "offer_accepted",
      "2020-05-01T00:00:00Z",
      [
        { from: null, to: "application_received", at: "2020-05-01T00:00:00Z" },
        { from: "application_received", to: "recruiter_review", at: "2020-05-03T00:00:00Z" },
        { from: "recruiter_review", to: "offer_accepted", at: "2020-05-11T00:00:00Z" },
      ],
    );
    await plantApplication(
      testTenantId,
      R_APP_2,
      R_CAND_2,
      R_REQ,
      "referral",
      "offer_accepted",
      "2020-05-02T00:00:00Z",
      [
        { from: null, to: "application_received", at: "2020-05-02T00:00:00Z" },
        { from: "application_received", to: "offer_accepted", at: "2020-05-06T00:00:00Z" },
      ],
    );
    await plantApplication(
      testTenantId,
      R_APP_3,
      R_CAND_3,
      R_REQ,
      "career_site",
      "tech_interview",
      "2020-05-03T00:00:00Z",
      [
        { from: null, to: "application_received", at: "2020-05-03T00:00:00Z" },
        { from: "application_received", to: "tech_interview", at: "2020-05-09T00:00:00Z" },
      ],
    );

    // ── Synthetic other-tenant fixture (isolation) ──
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${R_SYNTH_TENANT}, ${`report01-synth-${R_SYNTH_TENANT.slice(-6)}`},
              'REPORT-01 Synth', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status)
      VALUES (${R_SYNTH_MEMBERSHIP}, ${R_SYNTH_TENANT}, ${synthAuthUser},
              ARRAY['admin']::tenant_role[], 'active')
    `;
    await plantChain(R_SYNTH_TENANT, R_SYNTH_MEMBERSHIP, {
      bu: R_SYNTH_BU,
      envelope: R_SYNTH_ENVELOPE,
      position: R_SYNTH_POSITION,
      jd: R_SYNTH_JD,
      req: R_SYNTH_REQ,
      slug: "report01-synth-req",
    });
    await plantCandidate(R_SYNTH_TENANT, R_SYNTH_PERSON, R_SYNTH_CAND, "whatsapp");
    // Same window, a hire — must be invisible to the test tenant's rollup.
    await plantApplication(
      R_SYNTH_TENANT,
      R_SYNTH_APP,
      R_SYNTH_CAND,
      R_SYNTH_REQ,
      "whatsapp",
      "offer_accepted",
      "2020-05-04T00:00:00Z",
      [
        { from: null, to: "application_received", at: "2020-05-04T00:00:00Z" },
        { from: "application_received", to: "offer_accepted", at: "2020-05-05T00:00:00Z" },
      ],
    );
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: empty window → all 11 stages zero-filled, empty sourceMix, null medians, zero totals", async () => {
    const res = await trpcQuery<RecruitmentReport>("getRecruitmentReport", {
      from: "2019-01-01T00:00:00Z",
      to: "2019-01-02T00:00:00Z",
    });
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    const { funnel, sourceMix, timeToHire, stageDurations, totals } = res.result.data;

    assert.equal(funnel.length, 11, "funnel lists all 11 stages");
    assert.deepEqual(
      funnel.map((f) => f.stage),
      ALL_STAGES,
      "funnel is in enum order",
    );
    assert.ok(
      funnel.every((f) => f.current_count === 0),
      "every stage zero-filled",
    );
    assert.equal(sourceMix.length, 0, "no sources in an empty window");
    assert.equal(timeToHire.hires_count, 0, "no hires");
    assert.equal(timeToHire.median_days, null, "null median when no hires");
    assert.equal(timeToHire.p90_days, null, "null p90 when no hires");
    assert.equal(stageDurations.length, 11, "stageDurations lists all 11 stages");
    assert.deepEqual(
      stageDurations.map((s) => s.stage),
      ALL_STAGES,
      "stageDurations in enum order",
    );
    assert.ok(
      stageDurations.every((s) => s.median_days === null),
      "every stage null median",
    );
    assert.deepEqual(totals, { applications: 0, active: 0, hired: 0, rejected_or_withdrawn: 0 });
  });

  it("Test 2: planted fixtures → exact funnel, source mix, medians, totals", async () => {
    const res = await trpcQuery<RecruitmentReport>("getRecruitmentReport", {
      from: WINDOW_FROM,
      to: WINDOW_TO,
    });
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    const { funnel, sourceMix, timeToHire, stageDurations, totals } = res.result.data;

    // funnel — offer_accepted 2, tech_interview 1, everything else 0.
    const funnelByStage = Object.fromEntries(funnel.map((f) => [f.stage, f.current_count]));
    assert.equal(funnel.length, 11, "all 11 stages present");
    assert.equal(funnelByStage.offer_accepted, 2, "2 at offer_accepted");
    assert.equal(funnelByStage.tech_interview, 1, "1 at tech_interview");
    assert.equal(
      ALL_STAGES.filter((s) => s !== "offer_accepted" && s !== "tech_interview").every(
        (s) => funnelByStage[s] === 0,
      ),
      true,
      "all other stages zero",
    );

    // sourceMix — referral {2,2} then career_site {1,0}, ordered by apps desc.
    assert.equal(sourceMix.length, 2, "two sources");
    assert.equal(sourceMix[0]?.source, "referral", "referral first (most applications)");
    assert.equal(sourceMix[0]?.applications, 2);
    assert.equal(sourceMix[0]?.hires, 2);
    assert.equal(sourceMix[1]?.source, "career_site");
    assert.equal(sourceMix[1]?.applications, 1);
    assert.equal(sourceMix[1]?.hires, 0);

    // timeToHire — days [R2=4, R1=10]; median 7, p90 9.4.
    assert.equal(timeToHire.hires_count, 2, "2 hires");
    assert.equal(timeToHire.median_days, 7, "median of [4,10] = 7");
    assert.equal(timeToHire.p90_days, 9.4, "p90 of [4,10] = 9.4");

    // stageDurations — application_received median 4 ([2,4,6]),
    // recruiter_review 8 ([8]); everything else null.
    const durByStage = Object.fromEntries(stageDurations.map((s) => [s.stage, s.median_days]));
    assert.equal(durByStage.application_received, 4, "app_received median of [2,4,6] = 4");
    assert.equal(durByStage.recruiter_review, 8, "recruiter_review median of [8] = 8");
    assert.equal(durByStage.tech_interview, null, "tech_interview never left → null");
    assert.equal(durByStage.offer_accepted, null, "terminal stage → null");
    assert.equal(durByStage.hr_round, null, "unused stage → null");

    // totals.
    assert.deepEqual(totals, {
      applications: 3,
      active: 1,
      hired: 2,
      rejected_or_withdrawn: 0,
    });
  });

  it("Test 3: tenant isolation — the synthetic other-tenant hire is invisible", async () => {
    const res = await trpcQuery<RecruitmentReport>("getRecruitmentReport", {
      from: WINDOW_FROM,
      to: WINDOW_TO,
    });
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    const { funnel, sourceMix, totals } = res.result.data;
    const funnelByStage = Object.fromEntries(funnel.map((f) => [f.stage, f.current_count]));

    // The synth app is offer_accepted / whatsapp in the same window; if RLS
    // or the tenant filter leaked it, offer_accepted would be 3 and a
    // whatsapp source row would appear.
    assert.equal(funnelByStage.offer_accepted, 2, "cross-tenant hire must not inflate the funnel");
    assert.equal(totals.applications, 3, "cross-tenant app must not inflate totals");
    assert.equal(totals.hired, 2, "cross-tenant hire must not inflate hired");
    assert.equal(
      sourceMix.find((s) => s.source === "whatsapp"),
      undefined,
      "cross-tenant source must be invisible",
    );
  });

  it("Test 4: from/to narrowing — a window after R1's created_at drops it", async () => {
    // 2020-05-02 onward excludes R1 (created 05-01); R2 (05-02) + R3 (05-03)
    // remain. offer_accepted drops to 1, applications to 2.
    const res = await trpcQuery<RecruitmentReport>("getRecruitmentReport", {
      from: "2020-05-02T00:00:00Z",
      to: WINDOW_TO,
    });
    assert.ok(!isErr(res), `query should succeed: ${JSON.stringify(res)}`);
    const { funnel, timeToHire, totals } = res.result.data;
    const funnelByStage = Object.fromEntries(funnel.map((f) => [f.stage, f.current_count]));

    assert.equal(totals.applications, 2, "R1 excluded by the from bound");
    assert.equal(funnelByStage.offer_accepted, 1, "only R2 remains at offer_accepted");
    assert.equal(funnelByStage.tech_interview, 1, "R3 still present");
    assert.equal(timeToHire.hires_count, 1, "only R2 counts as a hire");
    assert.equal(timeToHire.median_days, 4, "R2 time-to-hire = 4d");
  });
});
