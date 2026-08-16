/**
 * R0.3 — getPipelineReport: the catalog's "pipeline & speed" report
 * (plan #2 funnel, #3 time to fill, #4 stage velocity & SLA, #6 source
 * mix, #10 offer funnel).
 *
 * Five of those six parts are pure composition over the R0.1 semantic
 * layer, so what needs pinning is (a) that the composition really is the
 * published measure — same zero-fill, same present-only source mix, same
 * time-to-fill span — and (b) the one genuinely new piece:
 *
 *   DEFINITION — SLA breach: an application whose CURRENT stage has a
 *   threshold and which has been sitting in that stage
 *   (now() − stage_entered_at) longer than the threshold. A LIVE snapshot,
 *   not a history. Thresholds are the tenant's RESOLVED map
 *   (tenants.settings.slaThresholds over the code defaults), so an
 *   override genuinely moves the numbers — the honesty test T4.1 applies
 *   to listCandidates, applied here.
 *
 * Coverage (4 cases):
 *   1. Composition — funnel zero-filled across all 11 stages in enum
 *      order; time to fill pins a KNOWN 10-day span; time in stage reports
 *      only the completed visit; source mix is present-only and ordered;
 *      the offer funnel counts drafted vs extended vs accepted.
 *   2. SLA — the 10-days-in-stage application breaches and the 6-hours-in
 *      one does not (1 breached of 2 in stage); a row is emitted for every
 *      THRESHOLDED stage even at zero; an unthresholded stage
 *      (offer_accepted, terminal) produces no row at all.
 *   3. Tenant override — tightening recruiter_review to 1 hour flips the
 *      fresh application into breach (2 of 2) and the reported
 *      thresholdHours with it; disabling the stage (explicit null) removes
 *      its row entirely.
 *   4. Scope + gate — a BU filter excludes the other BU's breaching
 *      application (and only that one); recruiter is FORBIDDEN.
 *
 * Planted data — namespace 'a16', in the caller's own tenant, dated
 * March 2016 so the period filter isolates the fixture from the tenant's
 * live, demo and sibling-suite data (a14 = 2018, a15 = 2017); cleaned in
 * afterAll. `stage_entered_at` is deliberately RECENT while `created_at`
 * is historical — that is exactly the shape the SLA table reads (a live
 * clock over a windowed population).
 *
 *   BU-A                                                    BU-B
 *   APP_HIRED  referral     offer_accepted   created 03-01
 *              → application_received 03-01, → offer_accepted 03-11
 *              ⇒ time to fill 10 days, time in application_received 10 days
 *              offer EXTENDED + accepted
 *   APP_STALE  career_site  recruiter_review created 03-02
 *              in stage since now − 10 days  ⇒ BREACH (48h default)
 *              offer DRAFTED only
 *   APP_FRESH  career_site  recruiter_review created 03-03
 *              in stage since now − 6 hours  ⇒ no breach at 48h,
 *                                              breach at a 1h override
 *   APP_B      job_board    recruiter_review created 03-05    ← other BU
 *              in stage since now − 10 days  ⇒ BREACH
 *
 * The tenant's stored slaThresholds are stripped in beforeAll and the
 * whole settings blob restored in afterAll (the idiom t41-sla-thresholds
 * uses), so tests 1/2/4 see the code defaults whatever the tenant had.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql, type ApplicationStage, type JwtClaims } from "@hireops/db";
import { SLA_THRESHOLDS_HOURS } from "../src/lib/sla-thresholds";

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

// Stable R0.3 fixture ids (hex-only suffix, v4 structure). '0a16' namespaces
// this ticket; 'a0xx' = BU-A chain, 'b0xx' = BU-B chain.
const BU_A = "00000000-0000-4000-8000-00000a16a001";
const ENVELOPE_A = "00000000-0000-4000-8000-00000a16a002";
const POSITION_A = "00000000-0000-4000-8000-00000a16a003";
const JD_A = "00000000-0000-4000-8000-00000a16a004";
const REQ_A = "00000000-0000-4000-8000-00000a16a005";
const BU_B = "00000000-0000-4000-8000-00000a16b001";
const ENVELOPE_B = "00000000-0000-4000-8000-00000a16b002";
const POSITION_B = "00000000-0000-4000-8000-00000a16b003";
const JD_B = "00000000-0000-4000-8000-00000a16b004";
const REQ_B = "00000000-0000-4000-8000-00000a16b005";
const REQ_IDS = [REQ_A, REQ_B];

const PERSON_HIRED = "00000000-0000-4000-8000-00000a16c001";
const PERSON_STALE = "00000000-0000-4000-8000-00000a16c002";
const PERSON_FRESH = "00000000-0000-4000-8000-00000a16c003";
const PERSON_B = "00000000-0000-4000-8000-00000a16c004";
const PERSON_IDS = [PERSON_HIRED, PERSON_STALE, PERSON_FRESH, PERSON_B];
const CAND_HIRED = "00000000-0000-4000-8000-00000a16d001";
const CAND_STALE = "00000000-0000-4000-8000-00000a16d002";
const CAND_FRESH = "00000000-0000-4000-8000-00000a16d003";
const CAND_B = "00000000-0000-4000-8000-00000a16d004";
const CAND_IDS = [CAND_HIRED, CAND_STALE, CAND_FRESH, CAND_B];
const APP_HIRED = "00000000-0000-4000-8000-00000a16e001";
const APP_STALE = "00000000-0000-4000-8000-00000a16e002";
const APP_FRESH = "00000000-0000-4000-8000-00000a16e003";
const APP_B = "00000000-0000-4000-8000-00000a16e004";
const APP_IDS = [APP_HIRED, APP_STALE, APP_FRESH, APP_B];
const OFFER_ACCEPTED = "00000000-0000-4000-8000-00000a16f001";
const OFFER_DRAFTED = "00000000-0000-4000-8000-00000a16f002";
const OFFER_IDS = [OFFER_ACCEPTED, OFFER_DRAFTED];

/** The fixture window: every planted application is received inside it. */
const WINDOW = { from: "2016-03-01T00:00:00Z", to: "2016-04-30T23:59:59Z" };
/** APP_HIRED: received 2016-03-01, accepted 2016-03-11 — exactly 10 days. */
const HIRED_CREATED = "2016-03-01T00:00:00Z";
const HIRED_ACCEPTED_AT = "2016-03-11T00:00:00Z";
const TIME_TO_FILL_DAYS = 10;

/**
 * The live SLA clock. Computed once at module load: the breach test runs
 * against the server's now(), seconds later, and both margins (10 days vs
 * a 48h threshold, 6 hours vs 48h / 1h) are far wider than that drift.
 */
const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000).toISOString();
const SIX_HOURS_AGO = new Date(Date.now() - 6 * 3_600_000).toISOString();

/** The 11 application_stage values, in pgEnum order — the funnel's contract. */
const ALL_STAGES: ApplicationStage[] = [
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
/** Stages carrying a default threshold — the SLA table's row set. */
const THRESHOLDED_STAGES = ALL_STAGES.filter((s) => SLA_THRESHOLDS_HOURS[s] != null);

let jwt: string;
let recruiterJwt: string;
let testTenantId: string;
let testMembershipId: string;
let originalSettings: unknown = {};

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

interface SlaRow {
  stage: string;
  thresholdHours: number;
  breachedCount: number;
  totalInStage: number;
}
interface PipelineReport {
  funnel: { stage: string; count: number }[];
  timeToFill: { medianDays: number | null; p90Days: number | null; hires: number };
  timeInStage: { stage: string; medianDays: number | null }[];
  sourceMix: { source: string; applications: number; hires: number }[];
  offers: { drafted: number; extended: number; accepted: number; declined: number };
  slaBreaches: SlaRow[];
}

async function pipeline(input: unknown): Promise<PipelineReport> {
  const body = await trpcQuery<PipelineReport>("getPipelineReport", input, jwt);
  assert.ok(!isErr(body), `pipeline query should succeed: ${JSON.stringify(body)}`);
  return body.result.data;
}

function slaRow(report: PipelineReport, stage: string): SlaRow {
  const row = report.slaBreaches.find((r) => r.stage === stage);
  assert.ok(row, `stage ${stage} should have an SLA row`);
  return row;
}

/** Overwrite the tenant's stored SLA overrides (raw jsonb, as T4.1 does). */
async function setSlaThresholds(override: Record<string, number | null>): Promise<void> {
  await poolSql`
    UPDATE public.tenants
    SET settings = COALESCE(settings, '{}'::jsonb)
        || jsonb_build_object('slaThresholds', ${JSON.stringify(override)}::jsonb)
    WHERE id = ${testTenantId}
  `;
}
async function stripSlaThresholds(): Promise<void> {
  await poolSql`
    UPDATE public.tenants SET settings = settings - 'slaThresholds' WHERE id = ${testTenantId}
  `;
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
    VALUES (${ids.bu}, ${testTenantId}, ${`R0.3 ${ids.label}`},
            ${`r03-bu-${ids.bu.slice(-6)}`})
  `;
  await poolSql`
    INSERT INTO public.headcount_envelopes
      (id, tenant_id, business_unit_id, period_start, period_end, planned_headcount, status)
    VALUES (${ids.envelope}, ${testTenantId}, ${ids.bu}, '2016-01-01', '2016-12-31', 5, 'approved')
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active)
    VALUES (${ids.position}, ${testTenantId}, ${ids.bu}, ${`R0.3 ${ids.label} Engineer`},
            'hybrid', 'Bengaluru', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${ids.jd}, ${testTenantId}, ${ids.position}, 1, 'R0.3 JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, headcount_envelope_id,
       primary_recruiter_id, hiring_manager_id, created_by, status, number_of_openings,
       created_at, updated_at)
    VALUES (${ids.req}, ${testTenantId}, ${ids.position}, ${ids.jd}, ${ids.envelope},
            ${testMembershipId}, ${testMembershipId}, ${testMembershipId}, 'posted', 1,
            ${HIRED_CREATED}::timestamptz, ${HIRED_CREATED}::timestamptz)
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
  /** The live SLA clock — deliberately independent of created_at. */
  stageEnteredAt: string;
  transitions?: { from: string | null; to: string; at: string }[];
}): Promise<void> {
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${args.personId}, ${testTenantId}, 'R0.3 Person',
            ${`${args.personId}@r03.test`}, ${`${args.personId}@r03.test`}, 'IN')
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
    VALUES (${args.appId}, ${testTenantId}, ${args.candId}, ${args.reqId}, ${testMembershipId},
            ${args.source}::application_source, ${args.currentStage}::application_stage,
            ${args.stageEnteredAt}::timestamptz, ${args.createdAt}::timestamptz,
            ${args.createdAt}::timestamptz)
  `;
  for (const t of args.transitions ?? []) {
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
  for (const id of OFFER_IDS) {
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

describe("R0.3 — /reports catalog: pipeline & speed + SLA breaches", () => {
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
    testMembershipId = own.id;

    // Park whatever the tenant had configured and run the default-threshold
    // tests against the code defaults; restored wholesale in afterAll.
    const [t] = await poolSql<{ settings: unknown }[]>`
      SELECT settings FROM public.tenants WHERE id = ${testTenantId} LIMIT 1
    `;
    originalSettings = t?.settings ?? {};
    await stripSlaThresholds();

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

    // The hire — pins time to fill (10 days) and the one completed stage visit.
    await plantApplication({
      appId: APP_HIRED,
      personId: PERSON_HIRED,
      candId: CAND_HIRED,
      reqId: REQ_A,
      source: "referral",
      currentStage: "offer_accepted",
      createdAt: HIRED_CREATED,
      stageEnteredAt: HIRED_ACCEPTED_AT,
      transitions: [
        { from: null, to: "application_received", at: HIRED_CREATED },
        { from: "application_received", to: "offer_accepted", at: HIRED_ACCEPTED_AT },
      ],
    });
    // Sitting in recruiter_review for 10 days — breaches the 48h default.
    await plantApplication({
      appId: APP_STALE,
      personId: PERSON_STALE,
      candId: CAND_STALE,
      reqId: REQ_A,
      source: "career_site",
      currentStage: "recruiter_review",
      createdAt: "2016-03-02T00:00:00Z",
      stageEnteredAt: TEN_DAYS_AGO,
    });
    // In the same stage for 6 hours — inside 48h, outside a 1h override.
    await plantApplication({
      appId: APP_FRESH,
      personId: PERSON_FRESH,
      candId: CAND_FRESH,
      reqId: REQ_A,
      source: "career_site",
      currentStage: "recruiter_review",
      createdAt: "2016-03-03T00:00:00Z",
      stageEnteredAt: SIX_HOURS_AGO,
    });
    // The other BU's breach — must vanish under a BU-A filter.
    await plantApplication({
      appId: APP_B,
      personId: PERSON_B,
      candId: CAND_B,
      reqId: REQ_B,
      source: "job_board",
      currentStage: "recruiter_review",
      createdAt: "2016-03-05T00:00:00Z",
      stageEnteredAt: TEN_DAYS_AGO,
    });

    // APP_HIRED's offer went out and was accepted; APP_STALE's was only
    // drafted, so it counts as drafted but never as extended.
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, extended_at, accepted_at, created_at)
      VALUES (${OFFER_ACCEPTED}, ${testTenantId}, ${APP_HIRED}, ${testMembershipId}, 250000000,
              '2016-05-01', 'Bengaluru', '2016-04-20T00:00:00Z'::timestamptz, 'accepted',
              '2016-03-08T00:00:00Z'::timestamptz, ${HIRED_ACCEPTED_AT}::timestamptz,
              '2016-03-07T00:00:00Z'::timestamptz)
    `;
    await poolSql`
      INSERT INTO public.offers
        (id, tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status, created_at)
      VALUES (${OFFER_DRAFTED}, ${testTenantId}, ${APP_STALE}, ${testMembershipId}, 200000000,
              '2016-05-01', 'Bengaluru', '2016-04-20T00:00:00Z'::timestamptz, 'drafted',
              '2016-03-09T00:00:00Z'::timestamptz)
    `;
  });

  afterAll(async () => {
    try {
      await cleanup();
    } catch {
      // best-effort
    }
    try {
      await poolSql`
        UPDATE public.tenants
        SET settings = ${JSON.stringify(originalSettings ?? {})}::jsonb
        WHERE id = ${testTenantId}
      `;
    } catch {
      // best-effort restore
    }
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: composes the R0.1 measures — funnel, time to fill, time in stage, sources, offers", async () => {
    const report = await pipeline(WINDOW);

    // Funnel: zero-filled across all 11 stages, in pgEnum order.
    assert.deepEqual(
      report.funnel.map((f) => f.stage),
      ALL_STAGES,
      "the funnel is zero-filled across every stage, in canonical order",
    );
    const funnel = Object.fromEntries(report.funnel.map((f) => [f.stage, f.count]));
    assert.equal(funnel.recruiter_review, 3, "STALE + FRESH + the BU-B application");
    assert.equal(funnel.offer_accepted, 1, "the hire");
    assert.equal(funnel.shortlisted, 0, "an empty band is still a band");

    // Time to fill: created 2016-03-01 → accepted 2016-03-11.
    assert.equal(report.timeToFill.hires, 1, "one application is at offer_accepted");
    assert.equal(
      report.timeToFill.medianDays,
      TIME_TO_FILL_DAYS,
      "median days = the single hire's 10-day span",
    );
    assert.equal(report.timeToFill.p90Days, TIME_TO_FILL_DAYS, "p90 over one hire is that hire");

    // Time in stage: only APP_HIRED has a COMPLETED visit.
    assert.deepEqual(
      report.timeInStage.map((s) => s.stage),
      ALL_STAGES,
      "time in stage is zero-filled the same way",
    );
    const inStage = Object.fromEntries(report.timeInStage.map((s) => [s.stage, s.medianDays]));
    assert.equal(
      inStage.application_received,
      TIME_TO_FILL_DAYS,
      "the one completed visit: received 03-01 → left 03-11",
    );
    assert.equal(
      inStage.offer_accepted,
      null,
      "a terminal stage is never left, so it has no completed visit",
    );
    assert.equal(inStage.recruiter_review, null, "STALE/FRESH are still sitting there");

    // Source mix: PRESENT channels only, busiest first. The tiebreak is
    // `ORDER BY a.source ASC` on the pg ENUM column, which sorts by enum
    // DECLARATION order (referral before job_board), not alphabetically —
    // the behaviour the old getRecruitmentReport always had and the
    // recruitment-report referee suite pins.
    assert.deepEqual(
      report.sourceMix,
      [
        { source: "career_site", applications: 2, hires: 0 },
        { source: "referral", applications: 1, hires: 1 },
        { source: "job_board", applications: 1, hires: 0 },
      ],
      "present channels only, volume desc then enum-order tiebreak",
    );

    // Offer funnel: the drafted-only offer never reaches extended.
    assert.deepEqual(
      report.offers,
      { drafted: 2, extended: 1, accepted: 1, declined: 0 },
      "both offers were drafted; only one went out",
    );
  });

  it("Test 2: SLA — the stale application breaches, the fresh one does not; unthresholded stages get no row", async () => {
    const report = await pipeline({ ...WINDOW, businessUnitId: BU_A });

    assert.deepEqual(
      report.slaBreaches.map((r) => r.stage),
      THRESHOLDED_STAGES,
      "one row per THRESHOLDED stage, canonical order, zero-filled",
    );
    assert.equal(
      report.slaBreaches.find((r) => r.stage === "offer_accepted"),
      undefined,
      "a terminal stage has no threshold, so it has no row at all",
    );

    const review = slaRow(report, "recruiter_review");
    assert.equal(
      review.thresholdHours,
      SLA_THRESHOLDS_HOURS.recruiter_review,
      "the unconfigured tenant resolves to the code default (48h)",
    );
    assert.equal(review.totalInStage, 2, "STALE + FRESH are in recruiter_review in BU A");
    assert.equal(review.breachedCount, 1, "only the 10-day-old one is past 48h");

    const shortlisted = slaRow(report, "shortlisted");
    assert.equal(shortlisted.totalInStage, 0, "an empty thresholded stage still reports a row");
    assert.equal(shortlisted.breachedCount, 0);
  });

  it("Test 3: a tenant threshold override genuinely moves the breach counts", async () => {
    // Tighter than anything in stage: both applications are now late.
    await setSlaThresholds({ recruiter_review: 1 });
    const tightened = await pipeline({ ...WINDOW, businessUnitId: BU_A });
    const tight = slaRow(tightened, "recruiter_review");
    assert.equal(tight.thresholdHours, 1, "the report publishes the RESOLVED threshold");
    assert.equal(tight.totalInStage, 2, "the population is unchanged");
    assert.equal(tight.breachedCount, 2, "6 hours in stage is a breach against a 1-hour SLA");

    // An unrelated stage keeps its default — the override is per-stage.
    assert.equal(
      slaRow(tightened, "tech_interview").thresholdHours,
      SLA_THRESHOLDS_HOURS.tech_interview,
      "stages absent from the override keep the code default",
    );

    // Explicit null switches the stage's SLA off — the row disappears.
    await setSlaThresholds({ recruiter_review: null });
    const disabled = await pipeline({ ...WINDOW, businessUnitId: BU_A });
    assert.equal(
      disabled.slaBreaches.find((r) => r.stage === "recruiter_review"),
      undefined,
      "a disabled stage is unthresholded, so it drops out of the table",
    );
    assert.equal(
      disabled.slaBreaches.length,
      THRESHOLDED_STAGES.length - 1,
      "exactly one row fewer",
    );

    await stripSlaThresholds();
    const restored = await pipeline({ ...WINDOW, businessUnitId: BU_A });
    assert.equal(
      slaRow(restored, "recruiter_review").breachedCount,
      1,
      "back to the default 48h behaviour",
    );
  });

  it("Test 4: the BU filter scopes the breach table; recruiter is FORBIDDEN", async () => {
    const all = await pipeline(WINDOW);
    const allReview = slaRow(all, "recruiter_review");
    assert.equal(allReview.totalInStage, 3, "both BUs' in-stage applications");
    assert.equal(allReview.breachedCount, 2, "STALE and the BU-B application");

    const buA = await pipeline({ ...WINDOW, businessUnitId: BU_A });
    assert.equal(slaRow(buA, "recruiter_review").breachedCount, 1, "BU B's breach is excluded");
    assert.equal(slaRow(buA, "recruiter_review").totalInStage, 2);

    const buB = await pipeline({ ...WINDOW, businessUnitId: BU_B });
    assert.equal(slaRow(buB, "recruiter_review").breachedCount, 1, "…and is all BU B has");
    assert.equal(slaRow(buB, "recruiter_review").totalInStage, 1);
    assert.equal(buB.timeToFill.hires, 0, "the hire hangs off BU A");

    const res = await trpcQuery("getPipelineReport", {}, recruiterJwt);
    assert.ok(
      isErr(res) && res.error.data.code === "FORBIDDEN",
      `recruiter must not read the pipeline report: ${JSON.stringify(res)}`,
    );
  });
});
