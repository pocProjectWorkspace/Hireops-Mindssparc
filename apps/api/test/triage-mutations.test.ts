/**
 * Module 1b — tRPC tests for the new triage mutations + the extended
 * listCandidates sort/filter modes.
 *
 * Coverage (8 cases):
 *   1.  advanceApplication: happy path moves stage + writes a transition row
 *   2.  advanceApplication: rejects when current_stage === targetStage (BAD_REQUEST)
 *   3.  rejectApplication: writes recruiter_rejected transition + audit row with action='reject_application'
 *   4.  revertApplicationStage: happy path within 30s; restores from_stage + writes revert transition
 *   5.  revertApplicationStage: rejects when transition is older than 30s
 *   6.  revertApplicationStage: rejects when a newer transition has been recorded
 *   7.  listCandidates sort='ai_score_desc' orders by aiScore DESC NULLS LAST
 *   8.  listCandidates filters.slaBreachOnly returns only rows past their SLA
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import {
  sql as poolSql,
  db,
  applications,
  applicationStateTransitions,
  apiAuditLogs,
  type ApplicationStage,
} from "@hireops/db";
import { and, eq } from "drizzle-orm";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");

// Synth FK chain in kyndryl-poc (testTenantId) so RLS lets the test
// user read the rows the mutations operate on. Hex-only suffixes,
// proper v4 UUID structure for Zod compatibility.
const M1B_BU = "00000000-0000-4000-8000-000000a1b001";
const M1B_POSITION = "00000000-0000-4000-8000-000000a1b002";
const M1B_JD = "00000000-0000-4000-8000-000000a1b003";
const M1B_REQ = "00000000-0000-4000-8000-000000a1b004";
const M1B_PERSON = "00000000-0000-4000-8000-000000a1b005";
const M1B_CANDIDATE = "00000000-0000-4000-8000-000000a1b006";
const M1B_APP = "00000000-0000-4000-8000-000000a1b007";
const M1B_APP_OLDER = "00000000-0000-4000-8000-000000a1b008";
// Second person+candidate for Tests 7+8 — two applications against the
// same requisition would violate UNIQUE(tenant, candidate, req).
const M1B_PERSON_2 = "00000000-0000-4000-8000-000000a1b009";
const M1B_CANDIDATE_2 = "00000000-0000-4000-8000-000000a1b00a";

let jwt: string;
let testUserId: string;
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
interface TRPCError {
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
  return (await res.json()) as TRPCSuccess<O> | TRPCError;
}

async function trpcQuery<O>(name: string, input: unknown, opts: { jwt?: string } = {}) {
  const url = `/trpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await app.request(url, {
    method: "GET",
    headers: opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : undefined,
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCError;
}

function isError<T>(env: TRPCSuccess<T> | TRPCError): env is TRPCError {
  return "error" in env;
}

async function cleanup(): Promise<void> {
  // Order matters — children before parents.
  await poolSql`DELETE FROM public.application_state_transitions WHERE application_id IN (${M1B_APP}, ${M1B_APP_OLDER})`;
  await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${testTenantId} AND action IN ('advance_application', 'reject_application', 'revert_application_stage')`;
  await poolSql`DELETE FROM public.applications WHERE id IN (${M1B_APP}, ${M1B_APP_OLDER})`;
  await poolSql`DELETE FROM public.candidates WHERE id IN (${M1B_CANDIDATE}, ${M1B_CANDIDATE_2})`;
  await poolSql`DELETE FROM public.persons WHERE id IN (${M1B_PERSON}, ${M1B_PERSON_2})`;
  await poolSql`DELETE FROM public.requisitions WHERE id = ${M1B_REQ}`;
  await poolSql`DELETE FROM public.jd_versions WHERE id = ${M1B_JD}`;
  await poolSql`DELETE FROM public.positions WHERE id = ${M1B_POSITION}`;
  await poolSql`DELETE FROM public.business_units WHERE id = ${M1B_BU}`;
}

async function seedApplication(
  id: string,
  stage: ApplicationStage,
  aiScore: number | null,
  candidateId: string = M1B_CANDIDATE,
): Promise<void> {
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at, ai_score)
    VALUES (${id}, ${testTenantId}, ${candidateId}, ${M1B_REQ}, 'career_site', ${stage}, now(), ${aiScore})
  `;
}

describe("Module 1b — triage mutations + listCandidates extensions", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testUserId = claims.sub as string;
    testTenantId = (claims as { tid?: string }).tid as string;

    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${testUserId} AND tenant_id = ${testTenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing in kyndryl-poc");
    testMembershipId = m.id;

    await cleanup();
    // Build the FK chain.
    await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${M1B_BU}, ${testTenantId}, 'M1B BU', 'm1b-bu')`;
    await poolSql`
      INSERT INTO public.positions
        (id, tenant_id, business_unit_id, title, location_type, is_active)
      VALUES (${M1B_POSITION}, ${testTenantId}, ${M1B_BU}, 'M1B Eng', 'remote', true)
    `;
    await poolSql`
      INSERT INTO public.jd_versions
        (id, tenant_id, position_id, version_number, jd_text, status)
      VALUES (${M1B_JD}, ${testTenantId}, ${M1B_POSITION}, 1, '# JD', 'approved')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${M1B_REQ}, ${testTenantId}, ${M1B_POSITION}, ${M1B_JD}, ${testMembershipId}, ${testMembershipId}, 'posted')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${M1B_PERSON}, ${testTenantId}, 'M1B Tester', 'm1b-test@example.com', 'm1b-test@example.com')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${M1B_CANDIDATE}, ${testTenantId}, ${M1B_PERSON}, 'career_site', 'v1')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${M1B_PERSON_2}, ${testTenantId}, 'M1B Tester 2', 'm1b-test-2@example.com', 'm1b-test-2@example.com')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${M1B_CANDIDATE_2}, ${testTenantId}, ${M1B_PERSON_2}, 'career_site', 'v1')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await poolSql.end({ timeout: 2 });
  });

  it("Test 1: advanceApplication moves stage + writes transition row", async () => {
    await seedApplication(M1B_APP, "application_received", 85);
    try {
      const env = await trpcMutation<{ transitionId: string; toStage: string }>(
        "advanceApplication",
        { applicationId: M1B_APP, targetStage: "recruiter_review" },
        { jwt },
      );
      assert.ok(!isError(env), `mutation should succeed: ${JSON.stringify(env)}`);
      assert.equal(env.result.data.toStage, "recruiter_review");

      const [app] = await poolSql<{ current_stage: string }[]>`
        SELECT current_stage FROM public.applications WHERE id = ${M1B_APP}
      `;
      assert.equal(app?.current_stage, "recruiter_review");

      const tx = await poolSql<{ from_stage: string; to_stage: string }[]>`
        SELECT from_stage, to_stage FROM public.application_state_transitions
        WHERE id = ${env.result.data.transitionId}
      `;
      assert.equal(tx[0]?.from_stage, "application_received");
      assert.equal(tx[0]?.to_stage, "recruiter_review");
    } finally {
      await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${M1B_APP}`;
      await poolSql`DELETE FROM public.applications WHERE id = ${M1B_APP}`;
    }
  });

  it("Test 2: advanceApplication rejects already-at-target with BAD_REQUEST", async () => {
    await seedApplication(M1B_APP, "recruiter_review", null);
    try {
      const env = await trpcMutation(
        "advanceApplication",
        {
          applicationId: M1B_APP,
          targetStage: "recruiter_review",
        },
        { jwt },
      );
      assert.ok(isError(env));
      assert.equal(env.error.data.code, "BAD_REQUEST");
    } finally {
      await poolSql`DELETE FROM public.applications WHERE id = ${M1B_APP}`;
    }
  });

  it("Test 3: rejectApplication writes recruiter_rejected transition + audit row", async () => {
    await seedApplication(M1B_APP, "application_received", null);
    try {
      const env = await trpcMutation<{ toStage: string }>(
        "rejectApplication",
        { applicationId: M1B_APP },
        { jwt },
      );
      assert.ok(!isError(env));
      assert.equal(env.result.data.toStage, "recruiter_rejected");
      // Audit fire-and-forget — let it land.
      await new Promise((r) => setTimeout(r, 1500));
      const audit = await db
        .select({ action: apiAuditLogs.action })
        .from(apiAuditLogs)
        .where(
          and(
            eq(apiAuditLogs.tenantId, testTenantId),
            eq(apiAuditLogs.action, "reject_application"),
          ),
        );
      assert.ok(audit.length >= 1, "api_audit_logs row missing");
    } finally {
      await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${M1B_APP}`;
      await poolSql`DELETE FROM public.applications WHERE id = ${M1B_APP}`;
      await poolSql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${testTenantId} AND action = 'reject_application'`;
    }
  });

  it("Test 4: revertApplicationStage restores from_stage when within 30s", async () => {
    await seedApplication(M1B_APP, "application_received", null);
    try {
      const adv = await trpcMutation<{ transitionId: string }>(
        "advanceApplication",
        { applicationId: M1B_APP, targetStage: "recruiter_review" },
        { jwt },
      );
      assert.ok(!isError(adv));
      const revertEnv = await trpcMutation<{ currentStage: string }>(
        "revertApplicationStage",
        { applicationId: M1B_APP, transitionId: adv.result.data.transitionId },
        { jwt },
      );
      assert.ok(!isError(revertEnv), `revert should succeed: ${JSON.stringify(revertEnv)}`);
      assert.equal(revertEnv.result.data.currentStage, "application_received");

      const [a] = await poolSql<{ current_stage: string }[]>`
        SELECT current_stage FROM public.applications WHERE id = ${M1B_APP}
      `;
      assert.equal(a?.current_stage, "application_received");

      // The original transition stays put + a NEW revert transition exists.
      const [count] = await poolSql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM public.application_state_transitions WHERE application_id = ${M1B_APP}
      `;
      assert.equal(count?.n, 2, "expected forward + revert transitions");
    } finally {
      await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${M1B_APP}`;
      await poolSql`DELETE FROM public.applications WHERE id = ${M1B_APP}`;
    }
  });

  it("Test 5: revertApplicationStage rejects when transition is older than 30s", async () => {
    await seedApplication(M1B_APP, "application_received", null);
    try {
      // Insert a transition with a fabricated old timestamp.
      const [oldTx] = await poolSql<{ id: string }[]>`
        INSERT INTO public.application_state_transitions
          (tenant_id, application_id, from_stage, to_stage, transitioned_at, actor_membership_id)
        VALUES (${testTenantId}, ${M1B_APP}, 'application_received', 'recruiter_review', now() - interval '5 minutes', ${testMembershipId})
        RETURNING id
      `;
      await poolSql`UPDATE public.applications SET current_stage = 'recruiter_review' WHERE id = ${M1B_APP}`;

      const env = await trpcMutation(
        "revertApplicationStage",
        { applicationId: M1B_APP, transitionId: oldTx?.id ?? "" },
        { jwt },
      );
      assert.ok(isError(env));
      assert.equal(env.error.data.code, "FORBIDDEN");
    } finally {
      await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${M1B_APP}`;
      await poolSql`DELETE FROM public.applications WHERE id = ${M1B_APP}`;
    }
  });

  it("Test 6: revertApplicationStage rejects when a newer transition exists", async () => {
    await seedApplication(M1B_APP, "application_received", null);
    try {
      const adv1 = await trpcMutation<{ transitionId: string }>(
        "advanceApplication",
        { applicationId: M1B_APP, targetStage: "recruiter_review" },
        { jwt },
      );
      assert.ok(!isError(adv1));
      // Second advance (a newer transition) — revert of the first should fail.
      await trpcMutation(
        "advanceApplication",
        { applicationId: M1B_APP, targetStage: "shortlisted" },
        { jwt },
      );
      const env = await trpcMutation(
        "revertApplicationStage",
        { applicationId: M1B_APP, transitionId: adv1.result.data.transitionId },
        { jwt },
      );
      assert.ok(isError(env));
      assert.equal(env.error.data.code, "FORBIDDEN");
    } finally {
      await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ${M1B_APP}`;
      await poolSql`DELETE FROM public.applications WHERE id = ${M1B_APP}`;
    }
  });

  it("Test 7: listCandidates sort='ai_score_desc' orders by aiScore DESC NULLS LAST", async () => {
    await seedApplication(M1B_APP, "application_received", 90);
    await seedApplication(M1B_APP_OLDER, "application_received", 50, M1B_CANDIDATE_2);
    try {
      const env = await trpcQuery<{ rows: { applicationId: string; aiScore: number | null }[] }>(
        "listCandidates",
        {
          filters: { stage: "application_received", requisitionId: M1B_REQ },
          pagination: { limit: 50 },
          sort: "ai_score_desc",
        },
        { jwt },
      );
      assert.ok(!isError(env));
      const filtered = env.result.data.rows.filter(
        (r) => r.applicationId === M1B_APP || r.applicationId === M1B_APP_OLDER,
      );
      assert.equal(filtered.length, 2);
      assert.equal(filtered[0]?.applicationId, M1B_APP, "score 90 must come before score 50");
      assert.equal(filtered[1]?.applicationId, M1B_APP_OLDER);
    } finally {
      await poolSql`DELETE FROM public.applications WHERE id IN (${M1B_APP}, ${M1B_APP_OLDER})`;
    }
  });

  it("Test 8: listCandidates filters.slaBreachOnly returns only past-SLA rows", async () => {
    // application_received SLA is 24h. Seed one fresh (no breach) + one
    // 48h old (breach).
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${M1B_APP}, ${testTenantId}, ${M1B_CANDIDATE}, ${M1B_REQ}, 'career_site', 'application_received', now())
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
      VALUES (${M1B_APP_OLDER}, ${testTenantId}, ${M1B_CANDIDATE_2}, ${M1B_REQ}, 'career_site', 'application_received', now() - interval '48 hours')
    `;
    try {
      const env = await trpcQuery<{ rows: { applicationId: string }[] }>(
        "listCandidates",
        {
          filters: { slaBreachOnly: true, requisitionId: M1B_REQ },
          pagination: { limit: 50 },
          sort: "sla_breach",
        },
        { jwt },
      );
      assert.ok(!isError(env));
      const ids = env.result.data.rows.map((r) => r.applicationId);
      assert.ok(ids.includes(M1B_APP_OLDER), "48h-old row must be returned");
      assert.ok(!ids.includes(M1B_APP), "fresh row must NOT be returned");
    } finally {
      await poolSql`DELETE FROM public.applications WHERE id IN (${M1B_APP}, ${M1B_APP_OLDER})`;
    }
  });
});

// Silence unused-import lint.
void applications;
void applicationStateTransitions;
