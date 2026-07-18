/**
 * OFFBOARD-03 — the one read the offboarding surface adds: listHiredCandidates,
 * the picker behind the initiate-offboarding form.
 *
 * Coverage:
 *   1. Returns a hired candidate (accepted offer) with hasActiveOffboardingCase
 *      false and no onboarding status.
 *   2. Surfaces a candidate hired via an onboarding case (no accepted offer),
 *      carrying its onboarding status.
 *   3. Excludes a never-hired candidate (application only, no offer/onboarding).
 *   4. Flips hasActiveOffboardingCase to true once a live case is initiated, so
 *      the picker can disable the person (a second initiate would 409).
 *   5. Role gating — recruiter is FORBIDDEN.
 *
 * Mirrors offboard-02-lifecycle.test.ts's fixture + HTTP-over-app.request
 * harness. Its own '0f03' fixture block + '@off03.test' email marker.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const PASSWORD = "TestPassword123!";
const HR_OPS = "hr_ops1@kyndryl-poc.test";
const ADMIN = "admin1@kyndryl-poc.test";
const RECRUITER = "recruiter1@kyndryl-poc.test";
const TENANT_SLUG = "kyndryl-poc";

const OFF_BU = "00000000-0000-4000-8000-00000f030001";
const OFF_POSITION = "00000000-0000-4000-8000-00000f030002";
const OFF_JD = "00000000-0000-4000-8000-00000f030003";
const OFF_REQ = "00000000-0000-4000-8000-00000f030004";
const EMAIL_MARKER = "@off03.test";

let hrOpsJwt: string;
let recruiterJwt: string;
let tenantId: string;
let hrOpsMembershipId: string;

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
  error: { message?: string; data: { code: string; httpStatus?: number } };
}
function isErr<T>(e: TRPCSuccess<T> | TRPCErr): e is TRPCErr {
  return "error" in e;
}
function dataOf<T>(e: TRPCSuccess<T> | TRPCErr): T {
  assert.ok(!isErr(e), `unexpected error: ${JSON.stringify(e)}`);
  return (e as TRPCSuccess<T>).result.data;
}

async function trpcMutation<O>(name: string, input: unknown, jwt: string) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}
async function trpcQuery<O>(name: string, input: unknown, jwt: string) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

interface HiredRow {
  candidateId: string;
  personName: string | null;
  email: string | null;
  onboardingStatus: string | null;
  hasActiveOffboardingCase: boolean;
}

/** Seed a person + candidate + application. hired = accepted offer; onboarding
 *  = an onboarding_case (either satisfies the hired predicate). */
async function seedPerson(opts: {
  suffix: string;
  offer?: boolean;
  onboarding?: boolean;
}): Promise<string> {
  const personId = randomUUID();
  const candidateId = randomUUID();
  const applicationId = randomUUID();
  const email = `${opts.suffix}${EMAIL_MARKER}`;
  await poolSql`
    INSERT INTO public.persons
      (id, tenant_id, full_name, email_primary, email_normalised, location_country)
    VALUES (${personId}, ${tenantId}, ${"Off " + opts.suffix}, ${email}, ${email}, 'IN')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${candidateId}, ${tenantId}, ${personId}, 'career_site', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${applicationId}, ${tenantId}, ${candidateId}, ${OFF_REQ}, 'career_site',
            'offer_accepted', now())
  `;
  if (opts.offer) {
    await poolSql`
      INSERT INTO public.offers
        (tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
         joining_date, location, expiry_at, status)
      VALUES (${tenantId}, ${applicationId}, ${hrOpsMembershipId}, ${4_200_000 * 100},
              '2024-01-01', 'Bengaluru', now() + interval '7 days', 'accepted')
    `;
  }
  if (opts.onboarding) {
    await poolSql`
      INSERT INTO public.onboarding_cases
        (tenant_id, application_id, candidate_id, status, geography_code, probation_days)
      VALUES (${tenantId}, ${applicationId}, ${candidateId}, 'in_progress', 'IN', 90)
    `;
  }
  return candidateId;
}

async function cleanup(): Promise<void> {
  await poolSql`
    DELETE FROM public.offboarding_cases
    WHERE tenant_id = ${tenantId}
      AND candidate_id IN (
        SELECT c.id FROM public.candidates c
        JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
        WHERE p.email_normalised LIKE ${"%" + EMAIL_MARKER})
  `;
  await poolSql`
    DELETE FROM public.onboarding_cases
    WHERE application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${OFF_REQ})
  `;
  await poolSql`
    DELETE FROM public.application_state_transitions
    WHERE application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${OFF_REQ})
  `;
  await poolSql`
    DELETE FROM public.offers
    WHERE application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${OFF_REQ})
  `;
  await poolSql`DELETE FROM public.applications WHERE requisition_id = ${OFF_REQ}`;
  await poolSql`
    DELETE FROM public.candidates
    WHERE tenant_id = ${tenantId}
      AND person_id IN (SELECT id FROM public.persons WHERE email_normalised LIKE ${"%" + EMAIL_MARKER})
  `;
  await poolSql`
    DELETE FROM public.persons
    WHERE tenant_id = ${tenantId} AND email_normalised LIKE ${"%" + EMAIL_MARKER}
  `;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${OFF_REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${OFF_JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${OFF_POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${OFF_BU}`;
}

describe("OFFBOARD-03 — listHiredCandidates picker", () => {
  beforeAll(async () => {
    [hrOpsJwt, recruiterJwt] = await Promise.all([signIn(HR_OPS), signIn(RECRUITER)]);
    const [t] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${TENANT_SLUG} LIMIT 1
    `;
    if (!t) throw new Error(`tenant ${TENANT_SLUG} not found`);
    tenantId = t.id;

    const [m] = await poolSql<{ id: string }[]>`
      SELECT tum.id FROM public.tenant_user_memberships tum
      JOIN auth.users au ON au.id = tum.user_id
      WHERE tum.tenant_id = ${tenantId} AND au.email = ${HR_OPS} LIMIT 1
    `;
    if (!m) throw new Error(`membership for ${HR_OPS} not found`);
    hrOpsMembershipId = m.id;

    await cleanup();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${OFF_BU}, ${tenantId}, 'OFF03 BU', 'off03-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${OFF_POSITION}, ${tenantId}, ${OFF_BU}, 'OFF03 Engineer', 'onsite', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${OFF_JD}, ${tenantId}, ${OFF_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${OFF_REQ}, ${tenantId}, ${OFF_POSITION}, ${OFF_JD}, ${hrOpsMembershipId}, ${hrOpsMembershipId}, 'posted')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("returns offer-hired + onboarding-hired candidates, excludes never-hired", async () => {
    const offerHired = await seedPerson({ suffix: "offer", offer: true });
    const onbHired = await seedPerson({ suffix: "onb", onboarding: true });
    await seedPerson({ suffix: "nonhire" }); // application only — not hired

    const rows = dataOf(
      await trpcQuery<{ items: HiredRow[] }>("listHiredCandidates", { limit: 200 }, hrOpsJwt),
    ).items;
    const byId = new Map(rows.map((r) => [r.candidateId, r]));

    const offer = byId.get(offerHired);
    assert.ok(offer, "offer-hired candidate present");
    assert.equal(offer.hasActiveOffboardingCase, false);
    assert.equal(offer.onboardingStatus, null);

    const onb = byId.get(onbHired);
    assert.ok(onb, "onboarding-hired candidate present");
    assert.equal(onb.onboardingStatus, "in_progress");

    // The never-hired candidate must NOT appear.
    const nonHirePresent = rows.some((r) => r.email === `nonhire${EMAIL_MARKER}`);
    assert.equal(nonHirePresent, false, "never-hired candidate excluded");
  });

  it("flips hasActiveOffboardingCase once a case is initiated", async () => {
    const cand = await seedPerson({ suffix: "flip", offer: true });

    const before = dataOf(
      await trpcQuery<{ items: HiredRow[] }>("listHiredCandidates", { limit: 200 }, hrOpsJwt),
    ).items.find((r) => r.candidateId === cand);
    assert.ok(before && before.hasActiveOffboardingCase === false);

    const init = await trpcMutation<{ caseId: string }>(
      "initiateOffboarding",
      { candidateId: cand, initiationType: "resignation" },
      hrOpsJwt,
    );
    assert.ok(!isErr(init), `initiate: ${JSON.stringify(init)}`);

    const after = dataOf(
      await trpcQuery<{ items: HiredRow[] }>("listHiredCandidates", { limit: 200 }, hrOpsJwt),
    ).items.find((r) => r.candidateId === cand);
    assert.ok(after && after.hasActiveOffboardingCase === true);
  });

  it("forbids a recruiter (OFFBOARD_MANAGE_ROLES gate)", async () => {
    const env = await trpcQuery<{ items: HiredRow[] }>(
      "listHiredCandidates",
      { limit: 50 },
      recruiterJwt,
    );
    assert.ok(isErr(env), "recruiter should be forbidden");
    assert.equal((env as TRPCErr).error.data.code, "FORBIDDEN");
  });
});
