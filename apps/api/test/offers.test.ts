/**
 * Module 4 — offers + Workday simulation worker integration tests.
 *
 * Coverage:
 *   1.  draftOffer happy path writes offers row with status='drafted'
 *   2.  draftOffer rejects when application is in a non-draftable stage
 *   3.  extendOffer moves drafted → extended + stores token hash + advances application
 *   4.  extendOffer enqueues 'candidate.offer_extended' notification
 *   5.  Second extendOffer on same application — partial UNIQUE on (tenant, application_id) WHERE status='extended' rejects
 *   6.  cancelOffer extended → cancelled + transitions application back to hr_round
 *   7.  /api/offers/preview/:token returns offer summary for the candidate page
 *   8.  /api/offers/accept/:token rejects when name_mismatch
 *   9.  /api/offers/accept/:token happy path → offer accepted, application offer_accepted, workday_sync_outbox row inserted
 *  10.  /api/offers/accept/:token second attempt returns 409 already_resolved
 *  11.  /api/offers/decline/:token happy path → offer declined + recruiter notification enqueued
 *  12.  Workday simulation drain picks up pending hire_employee row and marks 'simulated'
 *  13.  Generated mock response includes 'simulation_notes'
 *  14.  Workday business_key UNIQUE prevents duplicate hire enqueue (idempotency)
 *  15.  listOffersByApplication returns rows ordered desc + currentStage
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { randomUUID } from "node:crypto";
import { app } from "../src/index.js";
import {
  sql as poolSql,
  db as poolDb,
  offers,
  notificationOutbox,
  workdaySyncOutbox,
  applications,
} from "@hireops/db";
import { and, eq } from "drizzle-orm";
import { signLink, hashToken } from "@hireops/notifications";
import {
  drainWorkdayOutboxOnce,
  generateMockWorkdayResponse,
} from "../../../apps/workers/src/lib/workday-simulation-drain.js";
import { createLogger } from "@hireops/observability";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");

const M4_BU = "00000000-0000-4000-8000-000000a4b001";
const M4_POSITION = "00000000-0000-4000-8000-000000a4b002";
const M4_JD = "00000000-0000-4000-8000-000000a4b003";
const M4_REQ = "00000000-0000-4000-8000-000000a4b004";
const M4_PERSON = "00000000-0000-4000-8000-000000a4b005";
const M4_CANDIDATE = "00000000-0000-4000-8000-000000a4b006";
const M4_APP = "00000000-0000-4000-8000-000000a4b007";

const log = createLogger({ level: "error" });

let jwt: string;
let testTenantId: string;
let testMembershipId: string;

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return data.session.access_token;
}

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErrorEnv {
  error: { data: { code: string; httpStatus: number } };
}

async function trpcMutation<O>(name: string, input: unknown, opts: { jwt?: string } = {}) {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {}),
    },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErrorEnv;
}

async function trpcQuery<O>(name: string, input: unknown, opts: { jwt?: string } = {}) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : undefined,
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErrorEnv;
}

function isError<T>(env: TRPCSuccess<T> | TRPCErrorEnv): env is TRPCErrorEnv {
  return "error" in env;
}

async function cleanup(): Promise<void> {
  const stmts: (() => Promise<unknown>)[] = [
    () => poolSql`DELETE FROM public.workday_sync_outbox WHERE tenant_id = ${testTenantId}`,
    () => poolSql`DELETE FROM public.dev_email_outbox WHERE tenant_id = ${testTenantId}`,
    () => poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${testTenantId}`,
    () => poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${testTenantId}`,
    () => poolSql`DELETE FROM public.offers WHERE tenant_id = ${testTenantId}`,
    () => poolSql`
      DELETE FROM public.application_state_transitions
      WHERE application_id IN (SELECT id FROM public.applications WHERE requisition_id = ${M4_REQ})
    `,
    () => poolSql`DELETE FROM public.applications WHERE requisition_id = ${M4_REQ}`,
    () => poolSql`DELETE FROM public.candidates WHERE id = ${M4_CANDIDATE}`,
    () => poolSql`DELETE FROM public.persons WHERE id = ${M4_PERSON}`,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${M4_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${M4_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${M4_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${M4_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("M4 cleanup step failed (continuing):", err);
    }
  }
}

async function seedFixtures(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${M4_BU}, ${testTenantId}, 'M4 BU', 'm4-bu')`;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${M4_POSITION}, ${testTenantId}, ${M4_BU}, 'M4 Senior Engineer', 'remote', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${M4_JD}, ${testTenantId}, ${M4_POSITION}, 1, '# JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${M4_REQ}, ${testTenantId}, ${M4_POSITION}, ${M4_JD}, ${testMembershipId}, ${testMembershipId}, 'posted')
  `;
  await poolSql`
    INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
    VALUES (${M4_PERSON}, ${testTenantId}, 'Priya Subramanian', 'priya.s@example.com', 'priya.s@example.com')
  `;
  await poolSql`
    INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
    VALUES (${M4_CANDIDATE}, ${testTenantId}, ${M4_PERSON}, 'career_site', 'v1')
  `;
}

async function seedApplication(stage: string): Promise<void> {
  await poolSql.unsafe(`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES ('${M4_APP}', '${testTenantId}', '${M4_CANDIDATE}', '${M4_REQ}', 'career_site', '${stage}', now())
  `);
}

interface DraftOfferInput {
  applicationId: string;
  baseSalaryInrPaise: number;
  variableTargetInrPaise?: number;
  joiningBonusInrPaise?: number;
  joiningDate: string;
  location: string;
  expiryDays: number;
  termsHtml?: string;
}

const SAMPLE_DRAFT: DraftOfferInput = {
  applicationId: M4_APP,
  baseSalaryInrPaise: 4_200_000 * 100, // ₹42L
  variableTargetInrPaise: 800_000 * 100,
  joiningBonusInrPaise: 200_000 * 100,
  joiningDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  location: "Bengaluru (Hybrid)",
  expiryDays: 7,
  termsHtml: "Standard at-will employment.",
};

async function freshApplication(stage: string): Promise<void> {
  await poolSql`DELETE FROM public.workday_sync_outbox WHERE subject_application_id = ${M4_APP}`;
  await poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${testTenantId}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${testTenantId}`;
  await poolSql`DELETE FROM public.offers WHERE application_id = ${M4_APP}`;
  await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${M4_APP}`;
  await poolSql`DELETE FROM public.applications WHERE id = ${M4_APP}`;
  await seedApplication(stage);
}

describe("Module 4 — offers + Workday simulation", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    const userId = claims.sub as string;
    testTenantId = (claims as { tid?: string }).tid as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${userId} AND tenant_id = ${testTenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing");
    testMembershipId = m.id;
    await cleanup();
    await seedFixtures();
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  // ─────────── draft / extend / cancel ───────────

  it("1. draftOffer writes offers row with status='drafted'", async () => {
    await freshApplication("hr_round");
    const env = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    assert.ok(!isError(env), `draftOffer error: ${JSON.stringify(env)}`);
    const offerId = (env as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    const [row] = await poolDb.select().from(offers).where(eq(offers.id, offerId));
    assert.equal(row?.status, "drafted");
    assert.equal(String(row?.baseSalaryInrPaise), String(SAMPLE_DRAFT.baseSalaryInrPaise));
  });

  it("2. draftOffer rejects from a non-draftable stage", async () => {
    await freshApplication("recruiter_review");
    const env = await trpcMutation("draftOffer", SAMPLE_DRAFT, { jwt });
    assert.ok(isError(env));
    assert.equal((env as TRPCErrorEnv).error.data.code, "BAD_REQUEST");
  });

  it("3. extendOffer flips drafted → extended + stores token hash", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerId = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    const env2 = await trpcMutation<{ offerId: string; signedLinkSentTo: string }>(
      "extendOffer",
      { offerId },
      { jwt },
    );
    assert.ok(!isError(env2));
    const [row] = await poolDb.select().from(offers).where(eq(offers.id, offerId));
    assert.equal(row?.status, "extended");
    assert.ok(row?.acceptSignedLinkTokenHash && row.acceptSignedLinkTokenHash.length === 64);
    const [appRow] = await poolDb
      .select({ stage: applications.currentStage })
      .from(applications)
      .where(eq(applications.id, M4_APP));
    assert.equal(appRow?.stage, "offer_drafted");
  });

  it("4. extendOffer enqueues candidate.offer_extended notification", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerId = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    await trpcMutation("extendOffer", { offerId }, { jwt });

    const rows = await poolDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.tenantId, testTenantId),
          eq(notificationOutbox.templateKey, "candidate.offer_extended"),
        ),
      );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.recipientEmail, "priya.s@example.com");
  });

  it("5. Second extendOffer on same application rejected by partial UNIQUE", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerA = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    await trpcMutation("extendOffer", { offerId: offerA }, { jwt });

    // Draft a second offer + try to extend → must fail because the
    // partial UNIQUE allows only one extended offer per application.
    const env2 = await trpcMutation<{ offerId: string }>(
      "draftOffer",
      { ...SAMPLE_DRAFT, baseSalaryInrPaise: SAMPLE_DRAFT.baseSalaryInrPaise + 100_000 },
      { jwt },
    );
    const offerB = (env2 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    const env3 = await trpcMutation("extendOffer", { offerId: offerB }, { jwt });
    assert.ok(isError(env3), "expected extendOffer to fail with active extended sibling");
  });

  it("6. cancelOffer extended → cancelled + application transitions back to hr_round", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerId = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    await trpcMutation("extendOffer", { offerId }, { jwt });

    const env2 = await trpcMutation(
      "cancelOffer",
      { offerId, reason: "Position rescoped" },
      { jwt },
    );
    assert.ok(!isError(env2));
    const [row] = await poolDb.select().from(offers).where(eq(offers.id, offerId));
    assert.equal(row?.status, "cancelled");
    const [appRow] = await poolDb
      .select({ stage: applications.currentStage })
      .from(applications)
      .where(eq(applications.id, M4_APP));
    assert.equal(appRow?.stage, "hr_round");
  });

  // ─────────── public REST: preview / accept / decline ───────────

  it("7. /api/offers/preview/:token returns offer summary", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerId = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    await trpcMutation("extendOffer", { offerId }, { jwt });
    const token = await getExtendedToken(offerId);

    const res = await app.request(`/api/offers/preview/${token}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; positionTitle: string; candidateFullName: string };
    assert.equal(body.ok, true);
    assert.equal(body.candidateFullName, "Priya Subramanian");
    assert.equal(body.positionTitle, "M4 Senior Engineer");
  });

  it("8. /api/offers/accept/:token rejects when name_mismatch", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerId = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    await trpcMutation("extendOffer", { offerId }, { jwt });
    const token = await getExtendedToken(offerId);

    const res = await app.request(`/api/offers/accept/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName: "Someone Else" }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { reason: string };
    assert.equal(body.reason, "name_mismatch");
  });

  it("9. /api/offers/accept happy path → offer accepted + workday_sync_outbox row inserted", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerId = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    await trpcMutation("extendOffer", { offerId }, { jwt });
    const token = await getExtendedToken(offerId);

    const res = await app.request(`/api/offers/accept/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName: "Priya Subramanian" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; offerId: string };
    assert.equal(body.ok, true);
    assert.equal(body.offerId, offerId);

    const [offerRow] = await poolDb.select().from(offers).where(eq(offers.id, offerId));
    assert.equal(offerRow?.status, "accepted");

    const [appRow] = await poolDb
      .select({ stage: applications.currentStage })
      .from(applications)
      .where(eq(applications.id, M4_APP));
    assert.equal(appRow?.stage, "offer_accepted");

    const workday = await poolDb
      .select()
      .from(workdaySyncOutbox)
      .where(eq(workdaySyncOutbox.subjectApplicationId, M4_APP));
    assert.equal(workday.length, 1);
    assert.equal(workday[0]?.eventType, "hire_employee");
    assert.equal(workday[0]?.businessKey, `hire:application:${M4_APP}`);
  });

  it("10. /api/offers/accept second attempt returns 409 already_resolved", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerId = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    await trpcMutation("extendOffer", { offerId }, { jwt });
    const token = await getExtendedToken(offerId);

    await app.request(`/api/offers/accept/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName: "Priya Subramanian" }),
    });
    const res2 = await app.request(`/api/offers/accept/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName: "Priya Subramanian" }),
    });
    assert.equal(res2.status, 409);
  });

  it("11. /api/offers/decline → declined + recruiter notification enqueued", async () => {
    await freshApplication("hr_round");
    const env1 = await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });
    const offerId = (env1 as TRPCSuccess<{ offerId: string }>).result.data.offerId;
    await trpcMutation("extendOffer", { offerId }, { jwt });
    const token = await getExtendedToken(offerId);

    const res = await app.request(`/api/offers/decline/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Counter offer from current employer" }),
    });
    assert.equal(res.status, 200);

    const [row] = await poolDb.select().from(offers).where(eq(offers.id, offerId));
    assert.equal(row?.status, "declined");
    assert.equal(row?.declinedReason, "Counter offer from current employer");

    const notice = await poolDb
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.tenantId, testTenantId),
          eq(notificationOutbox.templateKey, "recruiter.offer_declined"),
        ),
      );
    assert.equal(notice.length, 1);
  });

  // ─────────── workday simulation worker ───────────

  it("12. drainWorkdayOutboxOnce processes pending row → simulated", async () => {
    await poolSql`DELETE FROM public.workday_sync_outbox WHERE tenant_id = ${testTenantId}`;
    const [row] = await poolSql<{ id: string }[]>`
      INSERT INTO public.workday_sync_outbox
        (tenant_id, event_type, business_key, subject_application_id, payload)
      VALUES (${testTenantId}, 'hire_employee',
              ${"test-" + randomUUID()},
              ${M4_APP},
              ${JSON.stringify({ pre_hire: { full_name: "Priya S" }, effective_date: "2026-06-01" })}::jsonb)
      RETURNING id
    `;
    const result = await drainWorkdayOutboxOnce({ log });
    assert.ok(result.simulated >= 1);

    const [after] = await poolDb
      .select()
      .from(workdaySyncOutbox)
      .where(eq(workdaySyncOutbox.id, row!.id));
    assert.equal(after?.status, "simulated");
    assert.ok(after?.simulatedAt);
    assert.ok(after?.simulatedResponse !== null);
  }, 30_000);

  it("13. generateMockWorkdayResponse includes simulation_notes", () => {
    const resp = generateMockWorkdayResponse("hire_employee", {
      pre_hire: { full_name: "Test User" },
      effective_date: "2026-06-01",
    });
    assert.ok(typeof (resp as { simulation_notes?: string }).simulation_notes === "string");
    assert.ok(
      (resp as { simulation_notes: string }).simulation_notes.includes("simulated"),
    );
  });

  it("14. business_key UNIQUE prevents duplicate hire enqueue", async () => {
    await poolSql`DELETE FROM public.workday_sync_outbox WHERE tenant_id = ${testTenantId}`;
    const bk = `hire:application:dup-${randomUUID()}`;
    await poolSql`
      INSERT INTO public.workday_sync_outbox
        (tenant_id, event_type, business_key, payload)
      VALUES (${testTenantId}, 'hire_employee', ${bk}, ${JSON.stringify({})}::jsonb)
    `;
    let threw = false;
    try {
      await poolSql`
        INSERT INTO public.workday_sync_outbox
          (tenant_id, event_type, business_key, payload)
        VALUES (${testTenantId}, 'hire_employee', ${bk}, ${JSON.stringify({})}::jsonb)
      `;
    } catch (err) {
      threw = true;
      const e = err as { code?: string };
      assert.equal(e.code, "23505");
    }
    assert.equal(threw, true);
  });

  it("15. listOffersByApplication returns rows + applicationCurrentStage", async () => {
    await freshApplication("hr_round");
    await trpcMutation<{ offerId: string }>("draftOffer", SAMPLE_DRAFT, { jwt });

    const env = await trpcQuery<{ rows: { id: string }[]; applicationCurrentStage: string }>(
      "listOffersByApplication",
      { applicationId: M4_APP },
      { jwt },
    );
    assert.ok(!isError(env));
    const data = (env as TRPCSuccess<{ rows: { id: string }[]; applicationCurrentStage: string }>)
      .result.data;
    assert.equal(data.applicationCurrentStage, "hr_round");
    assert.equal(data.rows.length, 1);
  });
});

async function getExtendedToken(offerId: string): Promise<string> {
  // The route stores token_hash; we don't get the raw token back from
  // extendOffer (it goes to email). For tests we re-sign with the SAME
  // (action, subject, expiresAt) using SIGNED_LINK_SECRET and POST that
  // token — the api route looks up by hash, so as long as the hash
  // matches an existing offer row, we're good.
  //
  // To make hashes match: re-sign producing the SAME nonce isn't
  // possible (random), so instead we fetch the stored hash and reverse-
  // engineer: we generate a fresh token, update the offer row's
  // accept_signed_link_token_hash to the fresh hash, then use that token.
  const [row] = await poolSql<{ tenant_id: string; expiry_at: Date | string }[]>`
    SELECT tenant_id, expiry_at FROM public.offers WHERE id = ${offerId}
  `;
  if (!row) throw new Error(`offer ${offerId} not found`);
  const expiresAt = row.expiry_at instanceof Date ? row.expiry_at : new Date(row.expiry_at);
  const token = signLink({
    action: "candidate.accept_offer",
    subjectId: offerId,
    expiresAt,
  });
  await poolSql`
    UPDATE public.offers
    SET accept_signed_link_token_hash = ${hashToken(token)}
    WHERE id = ${offerId}
  `;
  return token;
}
