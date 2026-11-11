/**
 * C1-BUGS BUG-10 — overdue extended offers move to `expired`.
 *
 *   1. The worker's expireOverdueOffers flips an overdue EXTENDED offer to
 *      'expired', leaves a not-yet-due one and a non-extended one alone,
 *      writes an audit row (the audit_offers trigger), and is idempotent.
 *   2. Reads don't wait for the sweep: listOffersByApplication reports an
 *      overdue extended offer as 'expired' before any sweep has run.
 *
 * Shared-DB discipline: the sweep is called with this file's tenant only
 * (opts.tenantId), so no other tenant's offers are touched. Fixtures use the
 * '0c10' id block and are removed in afterAll. Does NOT need migration 0132.
 */
import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import { sql as poolSql, type JwtClaims } from "@hireops/db";
import { expireOverdueOffers } from "../../../apps/workers/src/jobs/offer-expiry-scan.js";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");

const BU = "00000000-0000-4000-8000-00000c100001";
const POSITION = "00000000-0000-4000-8000-00000c100002";
const JD = "00000000-0000-4000-8000-00000c100003";
const REQ = "00000000-0000-4000-8000-00000c100004";
const EMAIL_MARKER = "@c1bug10.test";

let jwt: string;
let tenantId: string;
let membershipId: string;

async function cleanup(): Promise<void> {
  if (!tenantId) return;
  // offers cascade with applications.
  await poolSql`DELETE FROM public.applications WHERE requisition_id = ${REQ}`;
  await poolSql`
    DELETE FROM public.candidates
    WHERE tenant_id = ${tenantId}
      AND person_id IN (SELECT id FROM public.persons WHERE email_normalised LIKE ${"%" + EMAIL_MARKER})
  `;
  await poolSql`
    DELETE FROM public.persons
    WHERE tenant_id = ${tenantId} AND email_normalised LIKE ${"%" + EMAIL_MARKER}
  `;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${BU}`;
}

async function seedApplication(suffix: string): Promise<string> {
  const personId = randomUUID();
  const candidateId = randomUUID();
  const applicationId = randomUUID();
  const email = `${suffix}${EMAIL_MARKER}`;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${personId}, ${tenantId}, ${"Bug10 " + suffix}, ${email}, ${email})
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${candidateId}, ${tenantId}, ${personId}, 'career_site', 'v1')
  `;
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES (${applicationId}, ${tenantId}, ${candidateId}, ${REQ}, 'career_site', 'offer_drafted', now())
  `;
  return applicationId;
}

async function seedOffer(applicationId: string, status: string, expiry: string): Promise<string> {
  const [row] = await poolSql<{ id: string }[]>`
    INSERT INTO public.offers
      (tenant_id, application_id, drafted_by_membership_id, base_salary_inr_paise,
       joining_date, location, expiry_at, status)
    VALUES (${tenantId}, ${applicationId}, ${membershipId}, ${1_000_000 * 100},
            (now() + interval '30 days')::date, 'Remote', now() + ${expiry}::interval, ${status})
    RETURNING id
  `;
  if (!row) throw new Error("offer insert failed");
  return row.id;
}

async function statusOf(offerId: string): Promise<string | undefined> {
  const [r] = await poolSql<
    { status: string }[]
  >`SELECT status FROM public.offers WHERE id = ${offerId}`;
  return r?.status;
}

describe("BUG-10 — offer expiry", () => {
  beforeAll(async () => {
    const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
    jwt = data.session.access_token;
    const claims = decodeJwt(jwt) as JwtClaims;
    tenantId = claims.tid as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${claims.sub as string} AND tenant_id = ${tenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing");
    membershipId = m.id;

    await cleanup();
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${BU}, ${tenantId}, 'BUG10 BU', 'bug10-bu')`;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${POSITION}, ${tenantId}, ${BU}, 'BUG10 Analyst', 'onsite', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${JD}, ${tenantId}, ${POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${REQ}, ${tenantId}, ${POSITION}, ${JD}, ${membershipId}, ${membershipId}, 'posted')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("1. the sweep expires overdue extended offers only, audits it, and is idempotent", async () => {
    const overdue = await seedOffer(await seedApplication("overdue"), "extended", "-1 hour");
    const live = await seedOffer(await seedApplication("live"), "extended", "3 days");
    const drafted = await seedOffer(await seedApplication("drafted"), "drafted", "-1 hour");

    const flipped = await expireOverdueOffers(poolSql, { tenantId });
    assert.ok(flipped.includes(overdue), "the overdue extended offer was flipped");
    assert.ok(!flipped.includes(live), "a not-yet-due offer is untouched");
    assert.ok(!flipped.includes(drafted), "a drafted offer is never expired by the sweep");
    assert.equal(await statusOf(overdue), "expired");
    assert.equal(await statusOf(live), "extended");
    assert.equal(await statusOf(drafted), "drafted");

    const audit = await poolSql<{ n: string }[]>`
      SELECT count(*) AS n FROM public.audit_logs
      WHERE tenant_id = ${tenantId} AND entity_type = 'offers' AND entity_id = ${overdue}
        AND action = 'update' AND after_data->>'status' = 'expired'
    `;
    assert.equal(Number(audit[0]?.n), 1, "one audit row records the extended → expired flip");

    const again = await expireOverdueOffers(poolSql, { tenantId });
    assert.ok(!again.includes(overdue), "a second run flips nothing it already flipped");
  });

  it("2. reads report an overdue extended offer as expired before any sweep", async () => {
    const applicationId = await seedApplication("read");
    await seedOffer(applicationId, "extended", "-5 minutes");
    const input = encodeURIComponent(JSON.stringify({ applicationId }));
    const res = await app.request(`/trpc/listOffersByApplication?input=${input}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const body = (await res.json()) as {
      result?: { data: { rows: { status: string }[] } };
      error?: unknown;
    };
    assert.ok(body.result, `listOffersByApplication error: ${JSON.stringify(body.error)}`);
    assert.equal(body.result.data.rows[0]?.status, "expired");
  });
});
