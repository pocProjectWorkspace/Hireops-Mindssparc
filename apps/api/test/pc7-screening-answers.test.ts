/**
 * PC-7 — per-application screening answers + candidate-asserted knockouts.
 *
 * REQUIRES MIGRATION 0122 (applications.notice_period_days /
 * current_salary_inr_paise / current_location / screening_answers_source /
 * screening_answers_updated_at). Will fail on column-not-found until applied.
 *
 * Self-seeded fixture: a posted req with three screening knockouts
 *   notice_period_days ≤ 60 (candidate_asserted, CV fallback)
 *   expected_ctc       ≤ ₹18,00,000 / year (candidate_asserted)
 *   current_location   ∈ [Pune] (candidate_asserted)
 * and one application at recruiter_review whose parsed CV says 30 days' notice.
 *
 *   Test 1: recruiter saves answers (notice 90, ₹12L → ₹15L, "Pune, MH") →
 *           stored with source 'recruiter'; knockouts re-evaluated: notice FAILS,
 *           CTC + location pass.
 *   Test 2: role gating on reads — recruiter / hr_ops see CTC; hiring_manager
 *           gets CTC nulled + compVisible=false (notice + location still shown)
 *           on getCandidateById AND listCandidates.
 *   Test 3: role gating on writes — hiring_manager and panel FORBIDDEN.
 *   Test 4: clearing notice + expected CTC → notice falls back to the CV (30,
 *           from parsed_cv) and passes; expected CTC is UNKNOWN (not a fail);
 *           verdict null.
 *
 * Requires `pnpm db:seed:test-users`. Cleans up its own rows in afterAll.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import type {
  GetCandidateByIdOutput,
  ListCandidatesOutput,
  UpdateApplicationScreeningAnswersOutput,
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
const PANEL = "panel1@mindssparc.com";
const TENANT_SLUG = "kyndryl-poc";

// Fixed fixture ids (pc07 namespace — groom-safe cleanup).
const FX_BU = "00000000-0000-4000-8000-0000000c0701";
const FX_POSITION = "00000000-0000-4000-8000-0000000c0702";
const FX_JD = "00000000-0000-4000-8000-0000000c0703";
const FX_REQ = "00000000-0000-4000-8000-0000000c0704";
const FX_PERSON = "00000000-0000-4000-8000-0000000c0705";
const FX_CANDIDATE = "00000000-0000-4000-8000-0000000c0706";
const FX_APP = "00000000-0000-4000-8000-0000000c0707";
const KO_NOTICE = "00000000-0000-4000-8000-0000000c0711";
const KO_CTC = "00000000-0000-4000-8000-0000000c0712";
const KO_LOCATION = "00000000-0000-4000-8000-0000000c0713";

const RUN = Date.now().toString(36);
const LAKH_PAISE = 100_000 * 100;

let recruiterJwt: string;
let hrOpsJwt: string;
let hmJwt: string;
let panelJwt: string;
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

async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(
    `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    },
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

async function seedFixtures(): Promise<void> {
  await poolSql`
    INSERT INTO public.business_units (id, tenant_id, name, slug)
    VALUES (${FX_BU}, ${tenantId}, ${`PC-7 QA ${RUN}`}, ${`pc7-qa-${RUN}`})
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, primary_location,
       comp_band_min, comp_band_max, comp_currency, is_active)
    VALUES (${FX_POSITION}, ${tenantId}, ${FX_BU}, ${`PC-7 GBS Analyst ${RUN}`},
            'hybrid', 'Pune', 1200000, 1800000, 'INR', true)
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${FX_JD}, ${tenantId}, ${FX_POSITION}, 1, '# PC-7 JD', 'approved')
    ON CONFLICT (id) DO NOTHING
  `;
  const [m] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.tenant_user_memberships WHERE tenant_id = ${tenantId} LIMIT 1
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${FX_REQ}, ${tenantId}, ${FX_POSITION}, ${FX_JD}, ${m!.id}, ${m!.id}, 'posted')
    ON CONFLICT (id) DO NOTHING
  `;
  const knockouts: [string, string, string, Record<string, unknown>, number][] = [
    [
      KO_NOTICE,
      "Notice period at most 60 days",
      "numeric_max",
      { field_path: "notice_period_days", fallback_field_path: "notice_period_days", max: 60 },
      0,
    ],
    [
      KO_CTC,
      "Expected CTC within band",
      "numeric_max",
      { field_path: "expected_ctc", max: 1800000 },
      1,
    ],
    [
      KO_LOCATION,
      "Based in Pune",
      "enum",
      { field_path: "current_location", allowed: ["Pune"] },
      2,
    ],
  ];
  for (const [id, q, type, tv, order] of knockouts) {
    await poolSql`
      INSERT INTO public.requisition_knockouts
        (id, tenant_id, requisition_id, question_text, type, threshold_value, source, order_index)
      VALUES (${id}, ${tenantId}, ${FX_REQ}, ${q}, ${type}::knockout_type, ${JSON.stringify(tv)}::jsonb,
              'candidate_asserted', ${order})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${FX_PERSON}, ${tenantId}, 'PC-7 Test Candidate',
            'pc7-cand@example.test', 'pc7-cand@example.test')
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version, parsed_skills)
    VALUES (${FX_CANDIDATE}, ${tenantId}, ${FX_PERSON}, 'career_site', 'v1',
            ${JSON.stringify({ notice_period_days: 30, skills: ["Excel"] })}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${FX_APP}, ${tenantId}, ${FX_CANDIDATE}, ${FX_REQ}, 'career_site',
            'recruiter_review', now())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function cleanup(): Promise<void> {
  const steps: (() => Promise<unknown>)[] = [
    () =>
      poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${FX_APP}`,
    () => poolSql`DELETE FROM public.applications WHERE id = ${FX_APP}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${FX_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${FX_PERSON}`,
    () => poolSql`DELETE FROM public.requisition_knockouts WHERE requisition_id = ${FX_REQ}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${FX_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${FX_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${FX_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${FX_BU}`,
  ];
  for (const run of steps) {
    try {
      await run();
    } catch (err) {
      console.warn("PC-7 cleanup step failed (continuing):", err);
    }
  }
}

describe("PC-7 screening answers + candidate-asserted knockouts", () => {
  beforeAll(async () => {
    [recruiterJwt, hrOpsJwt, hmJwt, panelJwt] = await Promise.all([
      signIn(RECRUITER),
      signIn(HR_OPS),
      signIn(HIRING_MANAGER),
      signIn(PANEL),
    ]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;
    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("Test 1: recruiter saves answers; stored as 'recruiter'; knockouts re-evaluated", async () => {
    const out = ok(
      await trpcMutation<UpdateApplicationScreeningAnswersOutput>(
        "updateApplicationScreeningAnswers",
        {
          applicationId: FX_APP,
          answers: {
            noticePeriodDays: 90,
            currentSalaryInrPaise: 12 * LAKH_PAISE,
            expectedSalaryInrPaise: 15 * LAKH_PAISE,
            currentLocation: "Pune, MH",
          },
        },
        recruiterJwt,
      ),
      "updateApplicationScreeningAnswers (recruiter)",
    );
    assert.equal(out.screening.noticePeriodDays, 90);
    assert.equal(out.screening.noticePeriodFrom, "application");
    assert.equal(out.screening.compVisible, true);
    assert.equal(out.screening.expectedSalaryInrPaise, 15 * LAKH_PAISE);
    assert.equal(out.screening.source, "recruiter");
    assert.equal(out.knockout.passed, false);
    assert.equal(out.knockout.failCount, 1);
    assert.equal(out.knockout.unknownCount, 0);
    assert.equal(out.knockout.items[0]!.knockoutId, KO_NOTICE);

    const [row] = await poolSql<
      {
        notice_period_days: number | null;
        current_salary_inr_paise: string | null;
        expected_salary_inr_paise: string | null;
        current_location: string | null;
        screening_answers_source: string | null;
        knockout_passed: boolean | null;
      }[]
    >`
      SELECT notice_period_days, current_salary_inr_paise::text, expected_salary_inr_paise::text,
             current_location, screening_answers_source, knockout_passed
      FROM public.applications WHERE id = ${FX_APP}
    `;
    assert.equal(row!.notice_period_days, 90);
    assert.equal(row!.current_salary_inr_paise, String(12 * LAKH_PAISE));
    assert.equal(row!.expected_salary_inr_paise, String(15 * LAKH_PAISE));
    assert.equal(row!.current_location, "Pune, MH");
    assert.equal(row!.screening_answers_source, "recruiter");
    assert.equal(row!.knockout_passed, false);
  });

  it("Test 2: CTC is visible to comp roles and nulled for hiring_manager", async () => {
    for (const [jwt, who] of [
      [recruiterJwt, "recruiter"],
      [hrOpsJwt, "hr_ops"],
    ] as const) {
      const d = ok(
        await trpcQuery<GetCandidateByIdOutput>(
          "getCandidateById",
          { id: FX_CANDIDATE, applicationId: FX_APP },
          jwt,
        ),
        `getCandidateById (${who})`,
      );
      assert.equal(d.application!.screening.compVisible, true, who);
      assert.equal(d.application!.screening.currentSalaryInrPaise, 12 * LAKH_PAISE, who);
      assert.equal(d.application!.screening.expectedSalaryInrPaise, 15 * LAKH_PAISE, who);
    }

    const hm = ok(
      await trpcQuery<GetCandidateByIdOutput>(
        "getCandidateById",
        { id: FX_CANDIDATE, applicationId: FX_APP },
        hmJwt,
      ),
      "getCandidateById (hiring_manager)",
    );
    assert.equal(hm.application!.screening.compVisible, false);
    assert.equal(hm.application!.screening.currentSalaryInrPaise, null);
    assert.equal(hm.application!.screening.expectedSalaryInrPaise, null);
    assert.equal(hm.application!.screening.noticePeriodDays, 90, "notice is not pay data");
    assert.equal(hm.application!.screening.currentLocation, "Pune, MH");
    assert.equal(hm.application!.knockout.failCount, 1);

    const listInput = {
      filters: { requisitionId: FX_REQ },
      pagination: { limit: 10 },
      sort: "recent",
    };
    const recList = ok(
      await trpcQuery<ListCandidatesOutput>("listCandidates", listInput, recruiterJwt),
      "listCandidates (recruiter)",
    );
    const recRow = recList.rows.find((r) => r.applicationId === FX_APP);
    assert.ok(recRow, "fixture row on the recruiter's triage list");
    assert.equal(recRow.screening.expectedSalaryInrPaise, 15 * LAKH_PAISE);
    assert.equal(recRow.knockout.failCount, 1);

    const hmList = ok(
      await trpcQuery<ListCandidatesOutput>("listCandidates", listInput, hmJwt),
      "listCandidates (hiring_manager)",
    );
    const hmRow = hmList.rows.find((r) => r.applicationId === FX_APP);
    assert.ok(hmRow, "fixture row on the hiring manager's list");
    assert.equal(hmRow.screening.compVisible, false);
    assert.equal(hmRow.screening.expectedSalaryInrPaise, null);
    assert.equal(hmRow.screening.currentSalaryInrPaise, null);
  });

  it("Test 3: hiring_manager and panel cannot edit screening answers", async () => {
    for (const [jwt, who] of [
      [hmJwt, "hiring_manager"],
      [panelJwt, "panel_member"],
    ] as const) {
      const r = await trpcMutation<UpdateApplicationScreeningAnswersOutput>(
        "updateApplicationScreeningAnswers",
        { applicationId: FX_APP, answers: { noticePeriodDays: 15 } },
        jwt,
      );
      assert.ok(isErr(r), `${who} must be refused`);
      assert.equal(r.error.data.code, "FORBIDDEN", who);
    }
    const [row] = await poolSql<{ notice_period_days: number | null }[]>`
      SELECT notice_period_days FROM public.applications WHERE id = ${FX_APP}
    `;
    assert.equal(row!.notice_period_days, 90, "refused writes changed nothing");
  });

  it("Test 4: cleared notice falls back to the CV; missing expected CTC is UNKNOWN, not a fail", async () => {
    const out = ok(
      await trpcMutation<UpdateApplicationScreeningAnswersOutput>(
        "updateApplicationScreeningAnswers",
        {
          applicationId: FX_APP,
          answers: { noticePeriodDays: null, expectedSalaryInrPaise: null },
        },
        recruiterJwt,
      ),
      "updateApplicationScreeningAnswers (clear)",
    );
    assert.equal(out.screening.noticePeriodDays, 30);
    assert.equal(out.screening.noticePeriodFrom, "parsed_cv");
    assert.equal(out.screening.expectedSalaryInrPaise, null);
    assert.equal(out.screening.currentSalaryInrPaise, 12 * LAKH_PAISE, "untouched by the patch");
    assert.equal(out.knockout.failCount, 0);
    assert.equal(out.knockout.unknownCount, 1);
    assert.equal(out.knockout.passed, null);
    const unknown = out.knockout.items[0]!;
    assert.equal(unknown.knockoutId, KO_CTC);
    assert.equal(unknown.result, "unknown");
    assert.equal(unknown.reason, "field_missing");
  });
});
