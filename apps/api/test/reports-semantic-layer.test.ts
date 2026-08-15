/**
 * R0.1 — the reporting semantic layer (apps/api/src/lib/reports/) and
 * getRecruitmentReport refactored onto it.
 *
 * The referee for "the numbers didn't move" is the pre-existing
 * test/recruitment-report.test.ts, which pins the old inline SQL's exact
 * output and is unchanged by this ticket. THIS suite pins the things that
 * ticket could not: the newly-live dimension filters, the stage/source
 * zero-fill contract, and the measure definitions themselves.
 *
 * Coverage (5 cases):
 *   1. getRecruitmentReport({}) — unfiltered shape is unchanged: all 11
 *      stages in canonical order on both funnel and stageDurations, and
 *      the totals partition identity (active + hired + rejected = apps).
 *   2. from/to — a July-only window drops the August application.
 *   3. businessUnitId — the second BU's application is excluded (and, the
 *      other way round, is the ONLY thing the second BU sees). This is the
 *      requisitions → positions join path.
 *   4. timeToFillStats definition pin — one hire, created_at → earliest
 *      offer_accepted transition = exactly 10 days ⇒ median = p90 = 10.
 *   5. Measures with no procedure consumer yet (offerFunnel,
 *      timeInStageAvgs, zero-filled sourceMix) exercised directly inside a
 *      withTenantContext transaction, so the shared layer ships tested
 *      rather than on trust.
 *
 * Planted data — namespace 'a14', historical months so the window
 * isolates it from the tenant's live data (same idiom as REPORT-01), all
 * in the caller's own tenant, cleaned in afterAll:
 *
 *   BU-A chain: A1, A2, A3     BU-B chain: B1
 *   A1  referral     offer_accepted  created 2018-07-01
 *       application_received(07-01→07-05, 4d) → recruiter_review(07-05→07-11, 6d)
 *       → offer_accepted(07-11)         time to fill = 10d; accepted offer
 *   A2  career_site  tech_interview  created 2018-07-03
 *       application_received(07-03→07-09, 6d) → tech_interview(07-09, open)
 *   A3  referral     recruiter_review created 2018-08-05   ← outside the July window
 *       application_received(08-05→08-07, 2d) → recruiter_review(08-07, open)
 *   B1  job_board    shortlisted     created 2018-07-02    ← other BU
 *       application_received(07-02→07-06, 4d) → shortlisted(07-06, open)
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql, withTenantContext, type JwtClaims } from "@hireops/db";
import {
  CANONICAL_SOURCE_ORDER,
  CANONICAL_STAGE_ORDER,
  offerFunnel,
  sourceMix,
  timeInStageAvgs,
} from "../src/lib/reports/measures";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}
// Narrowed copies — the module-level guard above doesn't survive into the
// function bodies, and the house lint forbids non-null assertions.
const SB_URL: string = SUPABASE_URL;
const SB_ANON_KEY: string = SUPABASE_ANON_KEY;

// Stable R0.1 fixture ids (hex-only suffix, v4 structure). '0a14'
// namespaces this ticket; 'a0xx' = BU-A chain, 'b0xx' = BU-B chain.
const BU_A = "00000000-0000-4000-8000-00000a14a001";
const ENVELOPE_A = "00000000-0000-4000-8000-00000a14a002";
const POSITION_A = "00000000-0000-4000-8000-00000a14a003";
const JD_A = "00000000-0000-4000-8000-00000a14a004";
const REQ_A = "00000000-0000-4000-8000-00000a14a005";
const BU_B = "00000000-0000-4000-8000-00000a14b001";
const ENVELOPE_B = "00000000-0000-4000-8000-00000a14b002";
const POSITION_B = "00000000-0000-4000-8000-00000a14b003";
const JD_B = "00000000-0000-4000-8000-00000a14b004";
const REQ_B = "00000000-0000-4000-8000-00000a14b005";

const PERSON_A1 = "00000000-0000-4000-8000-00000a14c001";
const PERSON_A2 = "00000000-0000-4000-8000-00000a14c002";
const PERSON_A3 = "00000000-0000-4000-8000-00000a14c003";
const PERSON_B1 = "00000000-0000-4000-8000-00000a14c004";
const PERSON_IDS = [PERSON_A1, PERSON_A2, PERSON_A3, PERSON_B1];
const CAND_A1 = "00000000-0000-4000-8000-00000a14d001";
const CAND_A2 = "00000000-0000-4000-8000-00000a14d002";
const CAND_A3 = "00000000-0000-4000-8000-00000a14d003";
const CAND_B1 = "00000000-0000-4000-8000-00000a14d004";
const CAND_IDS = [CAND_A1, CAND_A2, CAND_A3, CAND_B1];
const APP_A1 = "00000000-0000-4000-8000-00000a14e001";
const APP_A2 = "00000000-0000-4000-8000-00000a14e002";
const APP_A3 = "00000000-0000-4000-8000-00000a14e003";
const APP_B1 = "00000000-0000-4000-8000-00000a14e004";
const APP_IDS = [APP_A1, APP_A2, APP_A3, APP_B1];
const OFFER_A1 = "00000000-0000-4000-8000-00000a14f001";

/** The whole fixture (both months). */
const BOTH_MONTHS = { from: "2018-07-01T00:00:00Z", to: "2018-08-31T23:59:59Z" };
/** July only — excludes A3 (created 2018-08-05). */
const JULY_ONLY = { from: "2018-07-01T00:00:00Z", to: "2018-07-31T23:59:59Z" };

let jwt: string;
let claims: JwtClaims;
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
  const supabase = createClient(SB_URL, SB_ANON_KEY);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin: ${error?.message}`);
  return data.session.access_token;
}

interface RecruitmentReport {
  funnel: { stage: string; current_count: number }[];
  sourceMix: { source: string; applications: number; hires: number }[];
  timeToHire: { median_days: number | null; p90_days: number | null; hires_count: number };
  stageDurations: { stage: string; median_days: number | null }[];
  totals: { applications: number; active: number; hired: number; rejected_or_withdrawn: number };
}

async function report(input: unknown): Promise<RecruitmentReport> {
  const res = await app.request(
    `/trpc/getRecruitmentReport?input=${encodeURIComponent(JSON.stringify(input))}`,
    { method: "GET", headers: { Authorization: `Bearer ${jwt}` } },
  );
  const body = (await res.json()) as TRPCSuccess<RecruitmentReport> | TRPCErr;
  assert.ok(!isErr(body), `query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}

/** Count per stage, as a lookup. */
function byStage(funnel: { stage: string; current_count: number }[]): Record<string, number> {
  return Object.fromEntries(funnel.map((f) => [f.stage, f.current_count]));
}

async function plantChain(ids: {
  bu: string;
  envelope: string;
  position: string;
  jd: string;
  req: string;
  label: string;
}): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${ids.bu}, ${testTenantId}, ${`R0.1 ${ids.label}`},
            ${`r01-bu-${ids.bu.slice(-6)}`})
  `;
  await poolSql`
    INSERT INTO public.headcount_envelopes
      (id, tenant_id, business_unit_id, period_start, period_end, planned_headcount, status)
    VALUES (${ids.envelope}, ${testTenantId}, ${ids.bu}, '2018-04-01', '2019-03-31', 5, 'approved')
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
    VALUES (${ids.position}, ${testTenantId}, ${ids.bu}, ${`R0.1 ${ids.label} Engineer`},
            'hybrid', 'Bengaluru', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${ids.jd}, ${testTenantId}, ${ids.position}, 1, 'R0.1 JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
       primary_recruiter_id, hiring_manager_id, created_by, status, number_of_openings)
    VALUES (${ids.req}, ${testTenantId}, ${ids.position}, ${ids.jd}, ${ids.envelope},
            ${testMembershipId}, ${testMembershipId}, ${testMembershipId}, 'posted', 1)
  `;
}

async function plantApplication(args: {
  appId: string;
  personId: string;
  candId: string;
  reqId: string;
  source: string;
  currentStage: string;
  createdAt: string;
  transitions: { from: string | null; to: string; at: string }[];
}): Promise<void> {
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${args.personId}, ${testTenantId}, 'R0.1 Person',
            ${`${args.personId}@r01.test`}, ${`${args.personId}@r01.test`}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${args.candId}, ${testTenantId}, ${args.personId},
            ${args.source}::application_source, 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage,
       stage_entered_at, created_at, updated_at)
    VALUES (${args.appId}, ${testTenantId}, ${args.candId}, ${args.reqId},
            ${args.source}::application_source, ${args.currentStage}::application_stage,
            ${args.createdAt}::timestamptz, ${args.createdAt}::timestamptz,
            ${args.createdAt}::timestamptz)
  `;
  for (const t of args.transitions) {
    await poolSql`
      INSERT INTO public.application_state_transitions
        (tenant_id, application_id, from_stage, to_stage, transitioned_at)
      VALUES (${testTenantId}, ${args.appId},
              ${t.from === null ? null : t.from}::application_stage,
              ${t.to}::application_stage, ${t.at}::timestamptz)
    `;
  }
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.offers WHERE id = ${OFFER_A1}`;
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
  for (const id of [REQ_A, REQ_B]) {
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

describe("R0.1 — reporting semantic layer", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    claims = decodeJwt(jwt) as JwtClaims;
    const tid = claims.tid;
    const authUserId = claims.sub;
    if (!tid || !authUserId) throw new Error("test JWT missing tid/sub");
    testTenantId = tid;

    const [membership] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE tenant_id = ${testTenantId} AND user_id = ${authUserId} AND status = 'active'
      LIMIT 1
    `;
    if (!membership) throw new Error("test user membership not found in its tenant");
    testMembershipId = membership.id;

    await cleanup();

    await plantChain({
      bu: BU_A,
      envelope: ENVELOPE_A,
      position: POSITION_A,
      jd: JD_A,
      req: REQ_A,
      label: "BU A",
    });
    await plantChain({
      bu: BU_B,
      envelope: ENVELOPE_B,
      position: POSITION_B,
      jd: JD_B,
      req: REQ_B,
      label: "BU B",
    });

    await plantApplication({
      appId: APP_A1,
      personId: PERSON_A1,
      candId: CAND_A1,
      reqId: REQ_A,
      source: "referral",
      currentStage: "offer_accepted",
      createdAt: "2018-07-01T00:00:00Z",
      transitions: [
        { from: null, to: "application_received", at: "2018-07-01T00:00:00Z" },
        { from: "application_received", to: "recruiter_review", at: "2018-07-05T00:00:00Z" },
        { from: "recruiter_review", to: "offer_accepted", at: "2018-07-11T00:00:00Z" },
      ],
    });
    await plantApplication({
      appId: APP_A2,
      personId: PERSON_A2,
      candId: CAND_A2,
      reqId: REQ_A,
      source: "career_site",
      currentStage: "tech_interview",
      createdAt: "2018-07-03T00:00:00Z",
      transitions: [
        { from: null, to: "application_received", at: "2018-07-03T00:00:00Z" },
        { from: "application_received", to: "tech_interview", at: "2018-07-09T00:00:00Z" },
      ],
    });
    await plantApplication({
      appId: APP_A3,
      personId: PERSON_A3,
      candId: CAND_A3,
      reqId: REQ_A,
      source: "referral",
      currentStage: "recruiter_review",
      createdAt: "2018-08-05T00:00:00Z",
      transitions: [
        { from: null, to: "application_received", at: "2018-08-05T00:00:00Z" },
        { from: "application_received", to: "recruiter_review", at: "2018-08-07T00:00:00Z" },
      ],
    });
    await plantApplication({
      appId: APP_B1,
      personId: PERSON_B1,
      candId: CAND_B1,
      reqId: REQ_B,
      source: "job_board",
      currentStage: "shortlisted",
      createdAt: "2018-07-02T00:00:00Z",
      transitions: [
        { from: null, to: "application_received", at: "2018-07-02T00:00:00Z" },
        { from: "application_received", to: "shortlisted", at: "2018-07-06T00:00:00Z" },
      ],
    });

    // The accepted offer behind A1's hire (offerFunnel fixture).
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, extended_at, accepted_at, created_at)
      VALUES (${OFFER_A1}, ${testTenantId}, ${APP_A1}, ${testMembershipId}, 250000000,
              '2018-08-01', 'Bengaluru', '2018-07-20T00:00:00Z'::timestamptz, 'accepted',
              '2018-07-09T00:00:00Z'::timestamptz, '2018-07-11T00:00:00Z'::timestamptz,
              '2018-07-08T00:00:00Z'::timestamptz)
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: no filters → unchanged shape, full canonical stage coverage, totals partition", async () => {
    const data = await report({});

    assert.equal(data.funnel.length, 11, "funnel lists all 11 stages");
    assert.deepEqual(
      data.funnel.map((f) => f.stage),
      [...CANONICAL_STAGE_ORDER],
      "funnel is in canonical (enum) order",
    );
    assert.ok(
      data.funnel.every((f) => Number.isInteger(f.current_count) && f.current_count >= 0),
      "every stage carries a non-negative integer count (zero-filled)",
    );
    assert.equal(data.stageDurations.length, 11, "stageDurations lists all 11 stages");
    assert.deepEqual(
      data.stageDurations.map((s) => s.stage),
      [...CANONICAL_STAGE_ORDER],
      "stageDurations is in canonical order",
    );

    // The unfiltered call spans the tenant's live data too, so pin the
    // invariants rather than the absolute counts: the three partitions sum
    // to the total, and the funnel sums to the total.
    const { totals, funnel } = data;
    assert.equal(
      totals.active + totals.hired + totals.rejected_or_withdrawn,
      totals.applications,
      "active + hired + rejected_or_withdrawn = applications",
    );
    assert.equal(
      funnel.reduce((sum, f) => sum + f.current_count, 0),
      totals.applications,
      "the funnel accounts for every application",
    );
    assert.ok(totals.applications >= 4, "the four planted applications are in the all-time view");
    assert.ok(
      data.sourceMix.every((s) => s.hires <= s.applications),
      "hires never exceed applications on a channel",
    );
    assert.ok(typeof data.timeToHire.hires_count === "number", "timeToHire carries a hire count");
  });

  it("Test 2: from/to → the July window drops the August application", async () => {
    const both = await report(BOTH_MONTHS);
    assert.equal(both.totals.applications, 4, "both months = all four planted applications");
    assert.equal(both.totals.hired, 1, "A1 is the only hire");
    assert.equal(both.totals.active, 3, "A2, A3, B1 are non-terminal");
    assert.equal(both.totals.rejected_or_withdrawn, 0);

    const bothFunnel = byStage(both.funnel);
    assert.equal(bothFunnel.offer_accepted, 1, "A1");
    assert.equal(bothFunnel.tech_interview, 1, "A2");
    assert.equal(bothFunnel.recruiter_review, 1, "A3");
    assert.equal(bothFunnel.shortlisted, 1, "B1");

    // referral (2) leads; career_site and job_board tie at 1 and break by
    // source ASC — the documented source-mix ordering.
    assert.deepEqual(
      both.sourceMix,
      [
        { source: "referral", applications: 2, hires: 1 },
        { source: "career_site", applications: 1, hires: 0 },
        { source: "job_board", applications: 1, hires: 0 },
      ],
      "source mix over both months",
    );

    const july = await report(JULY_ONLY);
    assert.equal(july.totals.applications, 3, "A3 (created 08-05) is out of the July window");
    assert.equal(july.totals.active, 2, "A2 + B1");
    assert.equal(july.totals.hired, 1, "A1 still counted");
    const julyFunnel = byStage(july.funnel);
    assert.equal(julyFunnel.recruiter_review, 0, "A3 gone from the funnel");
    assert.equal(julyFunnel.offer_accepted, 1);
    assert.equal(julyFunnel.tech_interview, 1);
    assert.equal(julyFunnel.shortlisted, 1);
    assert.equal(
      july.sourceMix.find((s) => s.source === "referral")?.applications,
      1,
      "referral loses A3",
    );

    // Stage durations follow the window too: application_received medians
    // over [4, 6, 2, 4] (both months) vs [4, 6, 4] (July) — both 4 — and
    // recruiter_review is A1's single completed 6d visit (A3 never left it).
    const bothDur = Object.fromEntries(both.stageDurations.map((s) => [s.stage, s.median_days]));
    assert.equal(bothDur.application_received, 4, "median of [2,4,4,6] = 4");
    assert.equal(bothDur.recruiter_review, 6, "A1 spent 6d in recruiter_review");
    assert.equal(bothDur.tech_interview, null, "never left → null");
    assert.equal(bothDur.offer_accepted, null, "terminal → null");
  });

  it("Test 3: businessUnitId → the other BU's application is excluded", async () => {
    const buA = await report({ ...BOTH_MONTHS, businessUnitId: BU_A });
    assert.equal(buA.totals.applications, 3, "B1 excluded — it hangs off BU B's requisition");
    assert.equal(byStage(buA.funnel).shortlisted, 0, "B1's stage is empty under BU A");
    assert.equal(
      buA.sourceMix.find((s) => s.source === "job_board"),
      undefined,
      "B1's channel disappears under BU A",
    );
    assert.equal(buA.totals.hired, 1, "A1 still hired");

    const buB = await report({ ...BOTH_MONTHS, businessUnitId: BU_B });
    assert.equal(buB.totals.applications, 1, "BU B sees only B1");
    assert.equal(byStage(buB.funnel).shortlisted, 1);
    assert.equal(byStage(buB.funnel).offer_accepted, 0, "A1 is BU A's");
    assert.deepEqual(buB.sourceMix, [{ source: "job_board", applications: 1, hires: 0 }]);
    assert.equal(buB.timeToHire.hires_count, 0, "no hires in BU B");
    assert.equal(buB.timeToHire.median_days, null);
    assert.equal(buB.funnel.length, 11, "zero-fill survives the BU join");
  });

  it("Test 4: timeToFillStats definition pin — created_at → earliest offer_accepted = 10d", async () => {
    const data = await report({ ...JULY_ONLY, businessUnitId: BU_A });
    assert.equal(data.timeToHire.hires_count, 1, "A1 is the only hire in scope");
    assert.equal(data.timeToHire.median_days, 10, "07-01 → 07-11 = 10 days");
    assert.equal(data.timeToHire.p90_days, 10, "single value ⇒ p90 = median");
  });

  it("Test 5: measures without a procedure consumer — offerFunnel, avgs, zero-filled sourceMix", async () => {
    await withTenantContext(claims, async ({ db }) => {
      const offers = await offerFunnel(db, testTenantId, BOTH_MONTHS);
      assert.deepEqual(
        offers,
        { drafted: 1, extended: 1, accepted: 1, declined: 0 },
        "A1's accepted offer, scoped through its application's created_at",
      );

      const avgs = await timeInStageAvgs(db, testTenantId, {
        ...BOTH_MONTHS,
        businessUnitId: BU_A,
      });
      assert.equal(avgs.length, 11, "avgs are zero-filled to the canonical stages");
      const avgByStage = Object.fromEntries(avgs.map((a) => [a.stage, a.days]));
      assert.equal(avgByStage.application_received, 4, "avg of [4,6,2] = 4");
      assert.equal(avgByStage.recruiter_review, 6, "avg of [6] = 6");
      assert.equal(avgByStage.tech_interview, null, "never left → null");

      const padded = await sourceMix(db, testTenantId, BOTH_MONTHS, { zeroFill: true });
      assert.equal(padded.length, CANONICAL_SOURCE_ORDER.length, "every channel present");
      assert.equal(padded[0]?.source, "referral", "present channels keep their volume order");
      assert.ok(
        padded.filter((s) => s.applications === 0).length === CANONICAL_SOURCE_ORDER.length - 3,
        "the five unused channels are padded with zeroes",
      );
    });
  });
});
