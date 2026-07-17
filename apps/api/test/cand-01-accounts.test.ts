/**
 * CAND-01 — candidate accounts: activation, candidateProcedure, dashboard
 * reads, person-scoping, interview confirm.
 *
 * Coverage:
 *   1. requestCandidateActivation never enumerates: returns ok for a
 *      non-existent email (creates nothing) AND for a real person (creates a
 *      pending candidate_accounts row + enqueues the activation email).
 *   2. completeCandidateActivation activates the account (creates the Supabase
 *      auth user, flips status→active, NULLs the hash) and consumes the link —
 *      a second use of the same token is rejected.
 *   3. Identity-tier isolation: an INTERNAL user is FORBIDDEN on
 *      candidateProcedure; a CANDIDATE identity is rejected on a
 *      protectedProcedure path (UNAUTHORIZED — no tid) and FORBIDDEN on
 *      partnerProcedure.
 *   4. Person-scoping: candidate A's dashboard reads return ONLY person A's
 *      applications/interviews — person B's are invisible.
 *   5. candidateConfirmInterview stamps only the caller's own interview; a
 *      cross-person confirm attempt is NOT_FOUND.
 *
 * Harness mirrors partner-auth.test.ts: real appRouter via createCaller with a
 * synthetic HonoTRPCContext. candidate_accounts.user_id has no auth.users FK
 * (future cross-schema migration), so candidate identities use plain UUIDs;
 * tenant_user_memberships.user_id DOES FK auth.users, so the one membership we
 * need borrows the signed-in test user's id. The activation-complete test DOES
 * create a real auth user (that's the point) and tears it down.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { TRPCError } from "@trpc/server";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { appRouter } from "../src/trpc/router";
import type { HonoTRPCContext } from "../src/trpc/trpc-core";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY");
}

// CAND-01 synth namespace (a04 marker) — valid v4-format UUIDs.
const CT_TENANT = "00000000-0000-4000-8000-0000000a04a1";
const CT_BU = "00000000-0000-4000-8000-0000000a04b1";
const CT_MEMBERSHIP = "00000000-0000-4000-8000-0000000a04b2";
const CT_POSITION = "00000000-0000-4000-8000-0000000a04b3";
const CT_JD = "00000000-0000-4000-8000-0000000a04b4";
const CT_REQ = "00000000-0000-4000-8000-0000000a04b5";
const PERSON_A = "00000000-0000-4000-8000-0000000a04c1";
const PERSON_B = "00000000-0000-4000-8000-0000000a04c2";
const PERSON_C = "00000000-0000-4000-8000-0000000a04c3"; // activation target, no account
const CAND_A = "00000000-0000-4000-8000-0000000a04d1";
const CAND_B = "00000000-0000-4000-8000-0000000a04d2";
const APP_A = "00000000-0000-4000-8000-0000000a04e1";
const APP_B = "00000000-0000-4000-8000-0000000a04e2";
const INTERVIEW_A = "00000000-0000-4000-8000-0000000a04f1";
const INTERVIEW_B = "00000000-0000-4000-8000-0000000a04f2";

// Candidate auth identities (no auth.users FK — random uuids are fine).
const CAND_AUTH_A = randomUUID();
const CAND_AUTH_B = randomUUID();

const EMAIL_C = "candidate-c-cand01@hireops-dev.local";

const log = createLogger({ level: "error" });
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let testUserId: string;
let createdAuthUserId: string | null = null;

async function getTestUserId(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin failed: ${error?.message}`);
  return decodeJwt(data.session.access_token).sub as string;
}

function makeCaller(userId: string | null) {
  const ctx: HonoTRPCContext = {
    tenantId: null,
    userId,
    roles: [],
    claims: userId ? { sub: userId } : null,
    db: undefined,
    sql: poolSql,
    log,
    requestId: `test-cand-${randomUUID()}`,
    userAgent: null,
    ipAddress: null,
  };
  return appRouter.createCaller(ctx);
}

async function cleanup(): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.signed_link_uses WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.notification_outbox WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.candidate_accounts WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.interviews WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.applications WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.candidates WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.persons WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.requisitions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.jd_versions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.positions WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${CT_TENANT}`;
  await poolSql`DELETE FROM public.tenants WHERE id = ${CT_TENANT}`;
}

describe("CAND-01 candidate accounts", () => {
  beforeAll(async () => {
    testUserId = await getTestUserId();
    await cleanup();

    await poolSql`INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES (${CT_TENANT}, 'synth-cand-01', 'Candidate-01 Synth', 'ap-northeast-1', 'active')`;
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${CT_BU}, ${CT_TENANT}, 'CT BU', 'ct-bu')`;
    await poolSql`INSERT INTO public.tenant_user_memberships (id, tenant_id, user_id, roles, status, business_unit_id) VALUES (${CT_MEMBERSHIP}, ${CT_TENANT}, ${testUserId}, ARRAY['recruiter']::tenant_role[], 'active', ${CT_BU})`;
    await poolSql`INSERT INTO public.positions (id, tenant_id, business_unit_id, title, location_type, primary_location, is_active) VALUES (${CT_POSITION}, ${CT_TENANT}, ${CT_BU}, 'Senior Platform Engineer', 'hybrid', 'Bengaluru', true)`;
    await poolSql`INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text, status) VALUES (${CT_JD}, ${CT_TENANT}, ${CT_POSITION}, 1, '# JD', 'approved')`;
    await poolSql`INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status, is_public) VALUES (${CT_REQ}, ${CT_TENANT}, ${CT_POSITION}, ${CT_JD}, ${CT_MEMBERSHIP}, ${CT_MEMBERSHIP}, 'posted', true)`;

    // Persons A/B (accounts) + C (activation target).
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised) VALUES (${PERSON_A}, ${CT_TENANT}, 'Aanya Rao', 'aanya-cand01@hireops-dev.local', 'aanya-cand01@hireops-dev.local')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised) VALUES (${PERSON_B}, ${CT_TENANT}, 'Bharat Singh', 'bharat-cand01@hireops-dev.local', 'bharat-cand01@hireops-dev.local')`;
    await poolSql`INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised) VALUES (${PERSON_C}, ${CT_TENANT}, 'Chetan Verma', ${EMAIL_C}, ${EMAIL_C})`;

    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_A}, ${CT_TENANT}, ${PERSON_A}, 'career_site')`;
    await poolSql`INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES (${CAND_B}, ${CT_TENANT}, ${PERSON_B}, 'career_site')`;

    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_A}, ${CT_TENANT}, ${CAND_A}, ${CT_REQ}, 'career_site', 'tech_interview')`;
    await poolSql`INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source, current_stage) VALUES (${APP_B}, ${CT_TENANT}, ${CAND_B}, ${CT_REQ}, 'career_site', 'shortlisted')`;

    await poolSql`INSERT INTO public.interviews (id, tenant_id, application_id, requisition_id, round_number, round_name, status, mode, scheduled_start, duration_minutes, created_by_membership_id) VALUES (${INTERVIEW_A}, ${CT_TENANT}, ${APP_A}, ${CT_REQ}, 1, 'Tech Screen', 'scheduled', 'video', now() + interval '2 days', 60, ${CT_MEMBERSHIP})`;
    await poolSql`INSERT INTO public.interviews (id, tenant_id, application_id, requisition_id, round_number, round_name, status, mode, scheduled_start, duration_minutes, created_by_membership_id) VALUES (${INTERVIEW_B}, ${CT_TENANT}, ${APP_B}, ${CT_REQ}, 1, 'Tech Screen', 'scheduled', 'onsite', now() + interval '3 days', 60, ${CT_MEMBERSHIP})`;

    // Active candidate accounts for A + B.
    await poolSql`INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at) VALUES (${CT_TENANT}, ${PERSON_A}, ${CAND_AUTH_A}, 'active', now())`;
    await poolSql`INSERT INTO public.candidate_accounts (tenant_id, person_id, user_id, status, activated_at) VALUES (${CT_TENANT}, ${PERSON_B}, ${CAND_AUTH_B}, 'active', now())`;
  });

  afterAll(async () => {
    if (createdAuthUserId) {
      await admin.auth.admin.deleteUser(createdAuthUserId).catch(() => undefined);
    }
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  async function expectCode(fn: () => Promise<unknown>, code: string, label: string) {
    let thrown: unknown;
    try {
      await fn();
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof TRPCError, `${label}: expected a TRPCError, got ${String(thrown)}`);
    assert.equal((thrown as TRPCError).code, code, `${label}: wrong code`);
  }

  // ─────────────── activation: no enumeration ───────────────

  it("Test 1a: requestCandidateActivation for an unknown email → ok, creates nothing", async () => {
    const res = await makeCaller(null).requestCandidateActivation({
      email: "nobody-cand01@hireops-dev.local",
      tenantSlug: "synth-cand-01",
    });
    assert.equal(res.ok, true);
    const rows =
      await poolSql`SELECT count(*)::int AS n FROM public.candidate_accounts WHERE tenant_id = ${CT_TENANT} AND person_id NOT IN (${PERSON_A}, ${PERSON_B})`;
    assert.equal(rows[0]?.n, 0, "no pending account for an unknown email");
  });

  it("Test 1b: requestCandidateActivation for a real person → ok + pending row + email enqueued", async () => {
    const res = await makeCaller(null).requestCandidateActivation({
      email: EMAIL_C,
      tenantSlug: "synth-cand-01",
    });
    assert.equal(res.ok, true);
    const [acct] = await poolSql<{ status: string; activation_token_hash: string | null }[]>`
      SELECT status, activation_token_hash FROM public.candidate_accounts
      WHERE tenant_id = ${CT_TENANT} AND person_id = ${PERSON_C} LIMIT 1
    `;
    assert.ok(acct, "pending account created for person C");
    assert.equal(acct.status, "pending");
    assert.ok(acct.activation_token_hash, "activation hash stored");
    const [note] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.notification_outbox
      WHERE tenant_id = ${CT_TENANT} AND template_key = 'candidate.account_activation'
    `;
    assert.equal(note!.n, 1, "activation email enqueued");
  });

  // ─────────────── activation: complete + single-use ───────────────

  it("Test 2: completeCandidateActivation activates + consumes the link (second use rejected)", async () => {
    // Pull the raw link from the enqueued notification payload — exactly how a
    // candidate receives it (and how the live spot-check pulls it from outbox).
    const [outbox] = await poolSql<{ template_data: { activationUrl?: string } }[]>`
      SELECT template_data FROM public.notification_outbox
      WHERE tenant_id = ${CT_TENANT} AND template_key = 'candidate.account_activation'
      ORDER BY created_at DESC LIMIT 1
    `;
    const activationUrl = outbox?.template_data?.activationUrl;
    assert.ok(activationUrl, "activation url present in payload");
    const token = activationUrl.split("/candidate/activate/")[1]!;

    const res = await makeCaller(null).completeCandidateActivation({
      token,
      password: "CandidateActivate123!",
    });
    assert.equal(res.ok, true);
    assert.equal(res.email, EMAIL_C);

    const [acct] = await poolSql<
      { status: string; user_id: string | null; activation_token_hash: string | null }[]
    >`
      SELECT status, user_id, activation_token_hash FROM public.candidate_accounts
      WHERE tenant_id = ${CT_TENANT} AND person_id = ${PERSON_C} LIMIT 1
    `;
    assert.ok(acct, "account row present");
    assert.equal(acct.status, "active", "account activated");
    assert.ok(acct.user_id, "auth user id set");
    assert.equal(acct.activation_token_hash, null, "hash cleared on use");
    createdAuthUserId = acct.user_id; // teardown deletes the real auth user

    // signed_link_uses recorded the redemption.
    const [use] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.signed_link_uses
      WHERE tenant_id = ${CT_TENANT} AND action = 'candidate.activate_account' AND successful = true
    `;
    assert.equal(use!.n, 1, "redemption recorded");

    // Second use of the SAME token → rejected (hash gone, status active).
    await expectCode(
      () =>
        makeCaller(null).completeCandidateActivation({
          token,
          password: "CandidateActivate123!",
        }),
      "BAD_REQUEST",
      "replayed activation link",
    );
  });

  // ─────────────── identity-tier isolation ───────────────

  it("Test 3a: internal user → FORBIDDEN on candidateProcedure", async () => {
    // testUserId has a tenant_user_membership but no candidate_accounts row.
    await expectCode(() => makeCaller(testUserId).candidateGetMe(), "FORBIDDEN", "internal user");
  });

  it("Test 3b: unknown identity → FORBIDDEN on candidateProcedure", async () => {
    await expectCode(
      () => makeCaller(randomUUID()).candidateGetMe(),
      "FORBIDDEN",
      "unknown identity",
    );
  });

  it("Test 3c: candidate identity → rejected on protectedProcedure (no tid) and partnerProcedure", async () => {
    // A candidate JWT carries sub but NO tid, so protectedProcedure's auth gate
    // (needs tenantId) rejects with UNAUTHORIZED — the candidate can't reach
    // internal reads. partnerProcedure rejects with FORBIDDEN (no partner row).
    await expectCode(
      () => makeCaller(CAND_AUTH_A).listCandidates({ pagination: { limit: 10 } }),
      "UNAUTHORIZED",
      "candidate on protected path",
    );
    await expectCode(
      () => makeCaller(CAND_AUTH_A).partnerGetMe(),
      "FORBIDDEN",
      "candidate on partner path",
    );
  });

  // ─────────────── person-scoping ───────────────

  it("Test 4a: candidateGetMe resolves the caller's own person", async () => {
    const me = await makeCaller(CAND_AUTH_A).candidateGetMe();
    assert.equal(me.personId, PERSON_A);
    assert.equal(me.tenantId, CT_TENANT);
    assert.equal(me.fullName, "Aanya Rao");
  });

  it("Test 4b: candidateListMyApplications returns ONLY the caller's person's applications", async () => {
    const a = await makeCaller(CAND_AUTH_A).candidateListMyApplications();
    assert.equal(a.items.length, 1, "candidate A sees exactly their own application");
    assert.equal(a.items[0]!.applicationId, APP_A);
    assert.equal(a.items[0]!.currentStage, "tech_interview");
    assert.ok(a.items[0]!.stageSteps.includes("tech_interview"), "stepper vocabulary present");

    const b = await makeCaller(CAND_AUTH_B).candidateListMyApplications();
    assert.equal(b.items.length, 1);
    assert.equal(b.items[0]!.applicationId, APP_B, "candidate B sees only their own");
  });

  it("Test 4c: candidateListMyInterviews returns ONLY the caller's person's interviews", async () => {
    const a = await makeCaller(CAND_AUTH_A).candidateListMyInterviews();
    assert.equal(a.items.length, 1);
    assert.equal(a.items[0]!.interviewId, INTERVIEW_A);
    assert.equal(a.items[0]!.isUpcoming, true, "future scheduled round is upcoming");
    assert.equal(a.items[0]!.confirmedAt, null, "not yet confirmed");
  });

  // ─────────────── interview confirm (own only) ───────────────

  it("Test 5a: candidateConfirmInterview stamps the caller's own interview", async () => {
    const res = await makeCaller(CAND_AUTH_A).candidateConfirmInterview({
      interviewId: INTERVIEW_A,
    });
    assert.equal(res.ok, true);
    assert.equal(res.interviewId, INTERVIEW_A);
    const [row] = await poolSql<{ candidate_confirmed_at: Date | null }[]>`
      SELECT candidate_confirmed_at FROM public.interviews WHERE id = ${INTERVIEW_A} LIMIT 1
    `;
    assert.ok(row!.candidate_confirmed_at, "interview A confirmed");
  });

  it("Test 5b: candidateConfirmInterview cannot touch another candidate's interview", async () => {
    // Candidate A tries to confirm candidate B's interview → NOT_FOUND (opaque).
    await expectCode(
      () => makeCaller(CAND_AUTH_A).candidateConfirmInterview({ interviewId: INTERVIEW_B }),
      "NOT_FOUND",
      "cross-person confirm",
    );
    const [row] = await poolSql<{ candidate_confirmed_at: Date | null }[]>`
      SELECT candidate_confirmed_at FROM public.interviews WHERE id = ${INTERVIEW_B} LIMIT 1
    `;
    assert.equal(row!.candidate_confirmed_at, null, "interview B untouched");
  });
});
