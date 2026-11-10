/**
 * PC-5 — triage at volume: server-side paging, SQL fact filters and the
 * checkbox bulk stage move, over the live HTTP stack.
 *
 * REQUIRES MIGRATION 0122 (PC-7 applications.notice_period_days /
 * current_location / … columns). Every list query selects them, so the whole
 * file fails on column-not-found until 0122 is applied.
 *
 * Slow against the remote pooler (~3–5 s per HTTP call from a laptop: the
 * time is round-trips, not query work), hence the per-test timeouts.
 *
 * Self-seeded fixture (pc05 namespace) on the kyndryl-poc tenant:
 *   FX_REQ — seven applications with varied facts:
 *     A1 application_received  notice 30   "Pune, MH"   ₹15L  ko pass    career_site
 *     A2 application_received  notice 90   "Bengaluru"  ₹25L  ko FAIL    career_site
 *     A3 recruiter_review      CV 45 only  person Pune  —     ko unknown partner_adhoc
 *     A4 recruiter_review      notice 15   "Hyderabad"  ₹10L  ko pass    referral
 *     A5 recruiter_rejected    (closed)
 *     A6 hr_round              no HR-round assessment → forward move gate-blocked
 *     A7 application_received  no facts
 *   FX_REQ_BIG — 501 bare applications (bulk "all matching" cap).
 *
 *   Test 1: paging — total, page sizes, no overlap, past-the-end keeps total.
 *   Test 2: each fact filter (knockout / notice / CTC / location / partner /
 *           source / stage) narrows in SQL; candidateCount = full match count.
 *   Test 3: listCandidates offset mode returns a total; a hiring manager's
 *           expected-CTC filter is ignored silently.
 *   Test 4: bulk role gate — hiring_manager and hr_ops FORBIDDEN.
 *   Test 5: bulk caps — 501 ids refused by the schema; "all matching" over 501
 *           refused (nothing moved).
 *   Test 6: bulk advance per-row results — moved / closed / gate_blocked /
 *           not_found; transition + per-row audit rows written.
 *   Test 7: bulk reject by filter (knockout = fail) — rejected and the
 *           candidate.application_closed email enqueued.
 *   Test 8: reject email preview names the role; suppression unsupported.
 *
 * Requires `pnpm db:seed:test-users`. Cleans up its own rows in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import type {
  BulkMoveApplicationsOutput,
  ListCandidatesByRequisitionOutput,
  ListCandidatesOutput,
  PreviewApplicationClosedEmailOutput,
} from "@hireops/api-types";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const RECRUITER = "recruiter1@mindssparc.com";
const HR_OPS = "hr_ops1@mindssparc.com";
const HIRING_MANAGER = "hiringmanager1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

const FX_BU = "00000000-0000-4000-8000-0000000c0501";
const FX_POSITION = "00000000-0000-4000-8000-0000000c0502";
const FX_JD = "00000000-0000-4000-8000-0000000c0503";
const FX_REQ = "00000000-0000-4000-8000-0000000c0504";
const FX_REQ_BIG = "00000000-0000-4000-8000-0000000c0505";
const PERSON = (n: number) => `00000000-0000-4000-8000-0000000c05${10 + n}`;
const CAND = (n: number) => `00000000-0000-4000-8000-0000000c05${30 + n}`;
const APP = (n: number) => `00000000-0000-4000-8000-0000000c05${50 + n}`;
const ALL = [1, 2, 3, 4, 5, 6, 7];

const RUN = Date.now().toString(36);
const LAKH_PAISE = 100_000 * 100;

let recruiterJwt: string;
let hrOpsJwt: string;
let hmJwt: string;
let tenantId: string;

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
  error: { message?: string; data: { code: string } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
function ok<T>(e: TRPCSuccess<T> | TRPCErr, what: string): T {
  if (isErr(e)) throw new Error(`${what}: ${e.error.data.code} ${e.error.message ?? ""}`);
  return e.result.data;
}
function errCode<T>(e: TRPCSuccess<T> | TRPCErr): string | null {
  return isErr(e) ? e.error.data.code : null;
}

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(
    `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`,
    { method: "GET", headers: { Authorization: `Bearer ${jwt}` } },
  );
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

function list(input: Record<string, unknown>) {
  return trpcQuery<ListCandidatesByRequisitionOutput>(
    "listCandidatesByRequisition",
    { requisitionId: FX_REQ, ...input },
    recruiterJwt,
  );
}
function idsOf(out: ListCandidatesByRequisitionOutput): string[] {
  return out.groups.flatMap((g) => g.rows.map((r) => r.applicationId));
}
async function matching(filter: Record<string, unknown>): Promise<string[]> {
  const out = ok(await list({ ...filter, page: { limit: 200 } }), JSON.stringify(filter));
  return idsOf(out).sort();
}

interface Fx {
  n: number;
  stage: string;
  source: string;
  notice: number | null;
  location: string | null;
  expected: number | null;
  ko: boolean | null;
  cv: Record<string, unknown>;
  city: string | null;
}
const FIXTURES: Fx[] = [
  {
    n: 1,
    stage: "application_received",
    source: "career_site",
    notice: 30,
    location: "Pune, MH",
    expected: 15,
    ko: true,
    cv: {},
    city: null,
  },
  {
    n: 2,
    stage: "application_received",
    source: "career_site",
    notice: 90,
    location: "Bengaluru",
    expected: 25,
    ko: false,
    cv: {},
    city: null,
  },
  {
    n: 3,
    stage: "recruiter_review",
    source: "partner_adhoc",
    notice: null,
    location: null,
    expected: null,
    ko: null,
    cv: { notice_period_days: 45 },
    city: "Pune",
  },
  {
    n: 4,
    stage: "recruiter_review",
    source: "referral",
    notice: 15,
    location: "Hyderabad",
    expected: 10,
    ko: true,
    cv: {},
    city: null,
  },
  {
    n: 5,
    stage: "recruiter_rejected",
    source: "career_site",
    notice: null,
    location: null,
    expected: null,
    ko: null,
    cv: {},
    city: null,
  },
  {
    n: 6,
    stage: "hr_round",
    source: "career_site",
    notice: null,
    location: null,
    expected: null,
    ko: null,
    cv: {},
    city: null,
  },
  {
    n: 7,
    stage: "application_received",
    source: "career_site",
    notice: null,
    location: null,
    expected: null,
    ko: null,
    cv: {},
    city: null,
  },
];

async function seedFixtures(): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${FX_BU}, ${tenantId}, ${`PC-5 QA ${RUN}`}, ${`pc5-qa-${RUN}`})
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location,
       comp_band_min, comp_band_max, comp_currency, is_active)
    VALUES (${FX_POSITION}, ${tenantId}, ${FX_BU}, ${`PC-5 AP Analyst ${RUN}`},
            'hybrid', 'Pune', 1200000, 1800000, 'INR', true)
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${FX_JD}, ${tenantId}, ${FX_POSITION}, 1, '# PC-5 JD', 'approved')
    ON CONFLICT (id) DO NOTHING
  `;
  const [m] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.tenant_user_memberships WHERE tenant_id = ${tenantId} LIMIT 1
  `;
  for (const req of [FX_REQ, FX_REQ_BIG]) {
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${req}, ${tenantId}, ${FX_POSITION}, ${FX_JD}, ${m!.id}, ${m!.id}, 'posted')
      ON CONFLICT (id) DO NOTHING
    `;
  }
  for (const f of FIXTURES) {
    const email = `pc5-cand-${f.n}-${RUN}@example.test`;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised, location_city)
      VALUES (${PERSON(f.n)}, ${tenantId}, ${`PC-5 Candidate ${f.n}`}, ${email}, ${email}, ${f.city})
      ON CONFLICT (id) DO NOTHING
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version, parsed_skills)
      VALUES (${CAND(f.n)}, ${tenantId}, ${PERSON(f.n)}, 'career_site', 'v1',
              ${JSON.stringify(f.cv)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;
    // created_at spaced a minute apart so "newest" order is deterministic.
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at,
         notice_period_days, current_location, expected_salary_inr_paise, knockout_passed,
         created_at)
      VALUES (${APP(f.n)}, ${tenantId}, ${CAND(f.n)}, ${FX_REQ}, ${f.source}, ${f.stage}, now(),
              ${f.notice}, ${f.location},
              ${f.expected === null ? null : String(f.expected * LAKH_PAISE)},
              ${f.ko}, now() - make_interval(mins => ${f.n}))
      ON CONFLICT (id) DO NOTHING
    `;
  }
  // 501 bare applications on FX_REQ_BIG (persons/candidates generated).
  await poolSql`
    WITH p AS (
      INSERT INTO public.persons (tenant_id, full_name, email_primary, email_normalised)
      SELECT ${tenantId}, 'PC-5 Bulk ' || g, 'pc5-big-' || g || ${`-${RUN}@example.test`},
             'pc5-big-' || g || ${`-${RUN}@example.test`}
      FROM generate_series(1, 501) g
      RETURNING id
    ), c AS (
      INSERT INTO public.candidates (tenant_id, person_id, source, consent_version)
      SELECT ${tenantId}, p.id, 'career_site', 'v1' FROM p
      RETURNING id
    )
    INSERT INTO public.applications (tenant_id, candidate_id, requisition_id, source, current_stage)
    SELECT ${tenantId}, c.id, ${FX_REQ_BIG}, 'career_site', 'application_received' FROM c
  `;
}

async function cleanup(): Promise<void> {
  const steps: (() => Promise<unknown>)[] = [
    () => poolSql`
      DELETE FROM public.notification_outbox
      WHERE recipient_candidate_id IN (
        SELECT candidate_id FROM public.applications WHERE requisition_id IN (${FX_REQ}, ${FX_REQ_BIG})
      )`,
    () => poolSql`
      DELETE FROM public.application_state_transitions
      WHERE application_id IN (
        SELECT id FROM public.applications WHERE requisition_id IN (${FX_REQ}, ${FX_REQ_BIG})
      )`,
    () => poolSql`
      DELETE FROM public.ai_score_outbox
      WHERE application_id IN (
        SELECT id FROM public.applications WHERE requisition_id IN (${FX_REQ}, ${FX_REQ_BIG})
      )`,
    () =>
      poolSql`DELETE FROM public.applications WHERE requisition_id IN (${FX_REQ}, ${FX_REQ_BIG})`,
    () => poolSql`
      DELETE FROM public.api_audit_logs
      WHERE tenant_id = ${tenantId}
        AND (input_json -> 'input' ->> 'applicationId' = ANY(${ALL.map(APP)}::text[])
             OR (action = 'bulk_move_applications'
                 AND input_json -> 'input' -> 'filter' ->> 'requisitionId' IN (${FX_REQ}, ${FX_REQ_BIG})))`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ANY(${ALL.map(CAND)}::uuid[])`,
    () => poolSql`DELETE FROM public.persons WHERE id = ANY(${ALL.map(PERSON)}::uuid[])`,
    () => poolSql`
      DELETE FROM public.candidates c USING public.persons p
      WHERE c.person_id = p.id AND p.tenant_id = ${tenantId}
        AND p.email_normalised LIKE 'pc5-big-%@example.test'`,
    () => poolSql`
      DELETE FROM public.persons
      WHERE tenant_id = ${tenantId} AND email_normalised LIKE 'pc5-big-%@example.test'`,
    () => poolSql`DELETE FROM public.requisitions WHERE id IN (${FX_REQ}, ${FX_REQ_BIG})`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${FX_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${FX_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${FX_BU}`,
  ];
  for (const run of steps) {
    try {
      await run();
    } catch (err) {
      console.warn("PC-5 cleanup step failed (continuing):", err);
    }
  }
}

describe("PC-5 triage at volume", () => {
  beforeAll(async () => {
    [recruiterJwt, hrOpsJwt, hmJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HR_OPS),
      signIn(HIRING_MANAGER),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    await cleanup();
    await seedFixtures();
  }, 120_000);

  afterAll(async () => {
    await cleanup();
  }, 120_000);

  it("Test 1: offset paging — total, page sizes, no overlap, past-the-end keeps total", async () => {
    const seen = new Set<string>();
    for (const [offset, expected] of [
      [0, 3],
      [3, 3],
      [6, 1],
    ] as const) {
      const out = ok(await list({ sort: "newest", page: { offset, limit: 3 } }), `page ${offset}`);
      assert.equal(out.page.total, 7, "total counts every match");
      assert.equal(out.totalCandidates, 7);
      assert.equal(out.page.offset, offset);
      const ids = idsOf(out);
      assert.equal(ids.length, expected, `page at ${offset}`);
      for (const id of ids) {
        assert.ok(!seen.has(id), "pages never overlap");
        seen.add(id);
      }
      assert.equal(out.groups[0]?.candidateCount, 7, "group count is the FULL match count");
    }
    assert.equal(seen.size, 7);

    // newest first: A1 was created most recently (1 min ago), A7 earliest.
    const first = ok(await list({ sort: "newest", page: { offset: 0, limit: 7 } }), "newest");
    assert.deepEqual(idsOf(first), ALL.map(APP));

    const past = ok(await list({ page: { offset: 50, limit: 50 } }), "past end");
    assert.equal(idsOf(past).length, 0);
    assert.equal(past.page.total, 7, "past-the-end page still reports the total");

    // Default page is 50.
    const def = ok(await list({}), "default page");
    assert.equal(def.page.limit, 50);
    assert.equal(def.compFilterAvailable, true, "recruiter can filter on expected CTC");
    assert.ok(def.requisitionFacets.some((f) => f.requisitionId === FX_REQ && f.count === 7));
  }, 240_000);

  it("Test 2: each fact filter narrows in SQL", async () => {
    assert.deepEqual(await matching({ knockout: "pass" }), [APP(1), APP(4)].sort());
    assert.deepEqual(await matching({ knockout: "fail" }), [APP(2)]);
    assert.deepEqual(
      await matching({ knockout: "unknown" }),
      [APP(3), APP(5), APP(6), APP(7)].sort(),
    );
    // Notice: the application's answer, else the CV (A3 = 45 from CV);
    // unknown notice never matches "≤ N".
    assert.deepEqual(await matching({ maxNoticeDays: 30 }), [APP(1), APP(4)].sort());
    assert.deepEqual(await matching({ maxNoticeDays: 45 }), [APP(1), APP(3), APP(4)].sort());
    assert.deepEqual(
      await matching({ maxExpectedSalaryInrPaise: 15 * LAKH_PAISE }),
      [APP(1), APP(4)].sort(),
    );
    // Location: application answer, else the person's city (A3 = Pune).
    assert.deepEqual(await matching({ locationContains: "pune" }), [APP(1), APP(3)].sort());
    assert.deepEqual(await matching({ locationContains: "%" }), [], "LIKE metachars escaped");
    assert.deepEqual(await matching({ hasPartner: true }), [APP(3)]);
    assert.equal((await matching({ hasPartner: false })).length, 6);
    assert.deepEqual(await matching({ source: "referral" }), [APP(4)]);
    assert.deepEqual(await matching({ stage: "recruiter_review" }), [APP(3), APP(4)].sort());
    assert.deepEqual(await matching({ search: "Candidate 4" }), [APP(4)]);
    // Combined.
    assert.deepEqual(
      await matching({ knockout: "pass", maxNoticeDays: 20, locationContains: "hyd" }),
      [APP(4)],
    );
    const filtered = ok(await list({ knockout: "pass" }), "count");
    assert.equal(filtered.page.total, 2);
    assert.equal(filtered.groups[0]?.candidateCount, 2);
  }, 240_000);

  it("Test 3: listCandidates offset mode + silent comp-filter drop for hiring managers", async () => {
    const base = {
      filters: { requisitionId: FX_REQ, stage: "application_received" },
      pagination: { limit: 2, offset: 0 },
      sort: "recent",
    };
    const p1 = ok(
      await trpcQuery<ListCandidatesOutput>("listCandidates", base, recruiterJwt),
      "listCandidates p1",
    );
    assert.equal(p1.total, 3);
    assert.equal(p1.rows.length, 2);
    assert.equal(p1.nextCursor, null, "offset mode does not hand out cursors");

    const knock = ok(
      await trpcQuery<ListCandidatesOutput>(
        "listCandidates",
        { ...base, filters: { ...base.filters, knockout: "fail" } },
        recruiterJwt,
      ),
      "listCandidates ko",
    );
    assert.deepEqual(
      knock.rows.map((r) => r.applicationId),
      [APP(2)],
    );

    const hmFiltered = ok(
      await trpcQuery<ListCandidatesOutput>(
        "listCandidates",
        { ...base, filters: { ...base.filters, maxExpectedSalaryInrPaise: 1 } },
        hmJwt,
      ),
      "listCandidates hm",
    );
    assert.equal(hmFiltered.total, 3, "HM's expected-CTC filter ignored, not applied");
    const recFiltered = ok(
      await trpcQuery<ListCandidatesOutput>(
        "listCandidates",
        { ...base, filters: { ...base.filters, maxExpectedSalaryInrPaise: 1 } },
        recruiterJwt,
      ),
      "listCandidates rec",
    );
    assert.equal(recFiltered.total, 0, "recruiter's expected-CTC filter applied");
  }, 240_000);

  it("Test 4: bulk role gate — hiring_manager and hr_ops are refused", async () => {
    for (const jwt of [hmJwt, hrOpsJwt]) {
      const res = await trpcMutation<BulkMoveApplicationsOutput>(
        "bulkMoveApplications",
        { action: "advance_next", selection: { mode: "ids", applicationIds: [APP(7)] } },
        jwt,
      );
      assert.equal(errCode(res), "FORBIDDEN");
    }
    const [row] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APP(7)}
    `;
    assert.equal(row!.current_stage, "application_received", "nothing moved");
  });

  it("Test 5: bulk caps — 501 ids and 501 matching are refused", async () => {
    const ids = Array.from({ length: 501 }, () => randomUUID());
    const tooMany = await trpcMutation<BulkMoveApplicationsOutput>(
      "bulkMoveApplications",
      { action: "advance_next", selection: { mode: "ids", applicationIds: ids } },
      recruiterJwt,
    );
    assert.equal(errCode(tooMany), "BAD_REQUEST");

    const started = Date.now();
    const big = ok(await list({ requisitionId: FX_REQ_BIG, page: { limit: 50 } }), "big list");
    console.log(`PC-5 perf: 501-row requisition first page in ${Date.now() - started} ms`);
    assert.equal(big.page.total, 501);

    const allMatching = await trpcMutation<BulkMoveApplicationsOutput>(
      "bulkMoveApplications",
      {
        action: "advance_next",
        selection: { mode: "filter", filter: { requisitionId: FX_REQ_BIG } },
      },
      recruiterJwt,
    );
    assert.equal(errCode(allMatching), "BAD_REQUEST");
    const [moved] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.applications
      WHERE requisition_id = ${FX_REQ_BIG} AND current_stage <> 'application_received'
    `;
    assert.equal(moved!.n, 0, "a refused bulk moves nothing");
  }, 240_000);

  it("Test 6: bulk advance — per-row moved / closed / gate_blocked / not_found + audit", async () => {
    const ghost = randomUUID();
    const [clock] = await poolSql<{ now: Date }[]>`SELECT now()`;
    const startedAt = clock?.now ?? new Date(0);
    const out = ok(
      await trpcMutation<BulkMoveApplicationsOutput>(
        "bulkMoveApplications",
        {
          action: "advance_next",
          selection: { mode: "ids", applicationIds: [APP(7), APP(5), APP(6), ghost] },
        },
        recruiterJwt,
      ),
      "bulk advance",
    );
    assert.equal(out.requested, 4);
    assert.equal(out.moved, 1);
    assert.equal(out.skipped, 3);
    const by = new Map(out.results.map((r) => [r.applicationId, r]));
    assert.equal(by.get(APP(7))?.status, "moved");
    assert.equal(by.get(APP(7))?.toStage, "recruiter_review");
    assert.equal(by.get(APP(5))?.skipReason, "closed");
    assert.equal(by.get(APP(6))?.skipReason, "gate_blocked");
    assert.match(by.get(APP(6))?.message ?? "", /HR round assessment/i);
    assert.equal(by.get(ghost)?.skipReason, "not_found");

    const [app7] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APP(7)}
    `;
    assert.equal(app7!.current_stage, "recruiter_review");
    const [app6] = await poolSql<{ current_stage: string }[]>`
      SELECT current_stage FROM public.applications WHERE id = ${APP(6)}
    `;
    assert.equal(app6!.current_stage, "hr_round", "gate-blocked row untouched");
    const [tx] = await poolSql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM public.application_state_transitions
      WHERE id = ${by.get(APP(7))!.transitionId!}
    `;
    assert.equal(tx?.metadata?.bulk, true, "transition marked as bulk");

    // Audit is fire-and-forget — poll briefly.
    let audit: { action: string }[] = [];
    for (let i = 0; i < 20 && audit.length === 0; i++) {
      audit = await poolSql<{ action: string }[]>`
        SELECT action FROM public.api_audit_logs
        WHERE tenant_id = ${tenantId} AND action = 'advance_application'
          AND created_at >= ${startedAt}
          AND input_json -> 'input' ->> 'applicationId' = ${APP(7)}
          AND (input_json -> 'input' ->> 'bulk')::boolean
      `;
      if (audit.length === 0) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(audit.length, 1, "per-row audit under the single-move action name");
  });

  it("Test 7: bulk reject by filter (knockout fail) — rejected + closing email enqueued", async () => {
    const out = ok(
      await trpcMutation<BulkMoveApplicationsOutput>(
        "bulkMoveApplications",
        {
          action: "reject",
          reason: "Notice period too long",
          selection: { mode: "filter", filter: { requisitionId: FX_REQ, knockout: "fail" } },
        },
        recruiterJwt,
      ),
      "bulk reject",
    );
    assert.equal(out.requested, 1);
    assert.equal(out.moved, 1);
    assert.equal(out.results[0]?.applicationId, APP(2));
    assert.equal(out.results[0]?.toStage, "recruiter_rejected");
    const mail = await poolSql<{ template_key: string }[]>`
      SELECT template_key FROM public.notification_outbox
      WHERE recipient_candidate_id = ${CAND(2)}
    `;
    assert.ok(
      mail.some((m) => m.template_key === "candidate.application_closed"),
      "closing email enqueued exactly like a single reject",
    );
  });

  it("Test 8: reject email preview names the role; suppression unsupported", async () => {
    const out = ok(
      await trpcQuery<PreviewApplicationClosedEmailOutput>(
        "previewApplicationClosedEmail",
        { requisitionId: FX_REQ },
        recruiterJwt,
      ),
      "preview",
    );
    assert.equal(out.suppressionSupported, false);
    assert.ok(out.html.length > 0);
    assert.ok(
      out.subject.includes("PC-5 AP Analyst") || out.html.includes("PC-5 AP Analyst"),
      "rendered with the role title",
    );
    const hm = await trpcQuery<PreviewApplicationClosedEmailOutput>(
      "previewApplicationClosedEmail",
      {},
      hmJwt,
    );
    assert.equal(errCode(hm), "FORBIDDEN");
  });
});
