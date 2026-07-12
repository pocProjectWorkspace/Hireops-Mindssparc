/**
 * WORKER-01 — integration tests for the stage_stale scanner worker.
 *
 * Mirrors agent-run-drain.test.ts: signs in the existing test user
 * against the kyndryl-poc tenant, creates the follow-up agent via the
 * tRPC API (the real writer), plants applications via poolSql
 * (service_role), runs stageStaleScan directly, asserts the enqueued
 * agent_run_outbox rows.
 *
 * The scan is cross-tenant (it also sees the dev DB's Demo Follow-ups
 * Agent) and runs against the shared kyndryl-poc tenant, so assertions
 * target THIS agent's rows for a SPECIFIC planted application_id rather
 * than a global count — ambient stale applications in the same stage
 * would otherwise perturb a total count. Fixtures are WK01-prefixed.
 * current_stage is the application_stage enum, so the stage must be a
 * real label (tech_interview here).
 *
 * Cases (ordered so the enable/disable toggle stays isolated — the
 * fresh-application case runs while the agent is still enabled, and the
 * respects-enabled case disables the agent last):
 *   (a) happy path — one stale application enqueues exactly one row with
 *       the right agent_id + application_id in trigger_context.
 *   (b) dedup — a second scan enqueues nothing new.
 *   (d) fresh application (inside the threshold) gets no row.
 *   (c) respects enabled — a disabled agent enqueues nothing for a newly
 *       planted stale application.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { stageStaleScan } from "../../../apps/workers/src/jobs/stage-stale-scan.js";
import { createLogger } from "@hireops/observability";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const AGENT_NAME = "wk01-stage-stale-agent";
// A real application_stage enum label (current_stage is that enum).
const STALE_STAGE = "tech_interview";

// Stable UUIDs (v4 shape: version nibble 4, variant 8). WK01 fixtures.
const WK01_BU = "d0000000-0000-4000-8000-00000000bb01";
const WK01_POSITION = "d0000000-0000-4000-8000-00000000bb02";
const WK01_JD = "d0000000-0000-4000-8000-00000000bb03";
const WK01_REQ = "d0000000-0000-4000-8000-00000000bb04";
// One candidate per application — applications are UNIQUE per
// (candidate, requisition), so each planted app needs its own candidate.
const WK01_PERSON = "d0000000-0000-4000-8000-00000000bb05";
const WK01_CANDIDATE = "d0000000-0000-4000-8000-00000000bb06";
const WK01_APP_STALE = "d0000000-0000-4000-8000-00000000bb07";
const WK01_PERSON_F = "d0000000-0000-4000-8000-00000000bb0a";
const WK01_CANDIDATE_F = "d0000000-0000-4000-8000-00000000bb0b";
const WK01_APP_FRESH = "d0000000-0000-4000-8000-00000000bb08";
const WK01_PERSON_S2 = "d0000000-0000-4000-8000-00000000bb0c";
const WK01_CANDIDATE_S2 = "d0000000-0000-4000-8000-00000000bb0d";
const WK01_APP_STALE2 = "d0000000-0000-4000-8000-00000000bb09";

let jwt: string;
let testTenantId: string;
let testMembershipId: string;
let agentId: string;
// ROBUST-01 Fix 2 — DB clock captured at suite start. The scan is
// cross-tenant, so it enqueues rows for ambient enabled agents (e.g. the
// SEED-01 demo follow-ups agent) as a side effect. Any agent_run_outbox
// row with enqueued_at >= this instant and agent_id != our WK01 agent was
// created by THIS suite's scans and must be cleaned so the table is left
// exactly as found. Pre-existing ambient rows (enqueued earlier) are left
// untouched.
let suiteStartTs: string;

const scanLog = createLogger({ base: { service: "wk01-test" } });

interface TRPCSuccess<T> {
  result: { data: T };
}
interface TRPCErr {
  error: { data: { code: string } };
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

async function outboxCountForAgent(): Promise<number> {
  const [row] = await poolSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.agent_run_outbox WHERE agent_id = ${agentId}
  `;
  return row?.n ?? 0;
}

async function outboxCountForApp(appId: string): Promise<number> {
  const [row] = await poolSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM public.agent_run_outbox
    WHERE agent_id = ${agentId} AND trigger_context->>'application_id' = ${appId}
  `;
  return row?.n ?? 0;
}

// ROBUST-01 Fix 2 — remove outbox rows the cross-tenant scan enqueued for
// ambient (non-WK01) agents during this suite. Scoped by enqueued_at so
// pre-existing ambient rows are never touched. These are pending outbox
// rows with no children (this file never drains), so a direct delete is
// safe.
async function deleteLeakedAmbientRows(): Promise<number> {
  if (!suiteStartTs || !agentId) return 0;
  const deleted = await poolSql<{ id: string }[]>`
    DELETE FROM public.agent_run_outbox
    WHERE agent_id != ${agentId}
      AND enqueued_at >= ${suiteStartTs}::timestamptz
    RETURNING id
  `;
  return deleted.length;
}

async function cleanup(): Promise<void> {
  // Agent chain by name (the tRPC-created agent has a dynamic id). Order:
  // children before parents.
  const stmts: Array<() => Promise<unknown>> = [
    () => poolSql`
      DELETE FROM public.agent_run_actions WHERE run_id IN (
        SELECT id FROM public.agent_runs WHERE agent_id IN (
          SELECT id FROM public.automation_agents WHERE name = ${AGENT_NAME}
        )
      )
    `,
    () => poolSql`
      DELETE FROM public.agent_runs WHERE agent_id IN (
        SELECT id FROM public.automation_agents WHERE name = ${AGENT_NAME}
      )
    `,
    () => poolSql`
      DELETE FROM public.agent_run_outbox WHERE agent_id IN (
        SELECT id FROM public.automation_agents WHERE name = ${AGENT_NAME}
      )
    `,
    () => poolSql`
      DELETE FROM public.agent_approval_rules WHERE agent_id IN (
        SELECT id FROM public.automation_agents WHERE name = ${AGENT_NAME}
      )
    `,
    () => poolSql`
      DELETE FROM public.agent_actions WHERE agent_id IN (
        SELECT id FROM public.automation_agents WHERE name = ${AGENT_NAME}
      )
    `,
    () => poolSql`
      DELETE FROM public.agent_triggers WHERE agent_id IN (
        SELECT id FROM public.automation_agents WHERE name = ${AGENT_NAME}
      )
    `,
    () => poolSql`DELETE FROM public.automation_agents WHERE name = ${AGENT_NAME}`,
    // Application chain by WK01 ids.
    () => poolSql`
      DELETE FROM public.applications
      WHERE id IN (${WK01_APP_STALE}, ${WK01_APP_FRESH}, ${WK01_APP_STALE2})
    `,
    () => poolSql`
      DELETE FROM public.candidates
      WHERE id IN (${WK01_CANDIDATE}, ${WK01_CANDIDATE_F}, ${WK01_CANDIDATE_S2})
    `,
    () => poolSql`
      DELETE FROM public.persons
      WHERE id IN (${WK01_PERSON}, ${WK01_PERSON_F}, ${WK01_PERSON_S2})
    `,
    () => poolSql`DELETE FROM public.requisitions WHERE id = ${WK01_REQ}`,
    () => poolSql`DELETE FROM public.jd_versions WHERE id = ${WK01_JD}`,
    () => poolSql`DELETE FROM public.positions WHERE id = ${WK01_POSITION}`,
    () => poolSql`DELETE FROM public.business_units WHERE id = ${WK01_BU}`,
  ];
  for (const run of stmts) {
    try {
      await run();
    } catch (err) {
      console.warn("WK01 cleanup step failed (continuing):", err);
    }
  }
}

async function seedRequisitionChain(): Promise<void> {
  await poolSql`INSERT INTO public.business_units (id, tenant_id, name, slug) VALUES (${WK01_BU}, ${testTenantId}, 'WK01 BU', 'wk01-bu')`;
  await poolSql`
    INSERT INTO public.positions
      (id, tenant_id, business_unit_id, title, location_type, is_active)
    VALUES (${WK01_POSITION}, ${testTenantId}, ${WK01_BU}, 'WK01 Engineer', 'remote', true)
  `;
  await poolSql`
    INSERT INTO public.jd_versions
      (id, tenant_id, position_id, version_number, jd_text, status)
    VALUES (${WK01_JD}, ${testTenantId}, ${WK01_POSITION}, 1, '# JD', 'approved')
  `;
  await poolSql`
    INSERT INTO public.requisitions
      (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
    VALUES (${WK01_REQ}, ${testTenantId}, ${WK01_POSITION}, ${WK01_JD}, ${testMembershipId}, ${testMembershipId}, 'posted')
  `;
  const people: Array<[string, string, string]> = [
    [WK01_PERSON, WK01_CANDIDATE, "wk01-stale@example.com"],
    [WK01_PERSON_F, WK01_CANDIDATE_F, "wk01-fresh@example.com"],
    [WK01_PERSON_S2, WK01_CANDIDATE_S2, "wk01-stale2@example.com"],
  ];
  for (const [personId, candidateId, email] of people) {
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${personId}, ${testTenantId}, 'WK01 Tester', ${email}, ${email})
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source, consent_version)
      VALUES (${candidateId}, ${testTenantId}, ${personId}, 'career_site', 'v1')
    `;
  }
}

async function plantApplication(
  appId: string,
  candidateId: string,
  ageInterval: string,
): Promise<void> {
  // ageInterval is a Postgres interval literal, e.g. '10 days' / '1 day'.
  await poolSql`
    INSERT INTO public.applications
      (id, tenant_id, candidate_id, requisition_id, source, current_stage, stage_entered_at)
    VALUES
      (${appId}, ${testTenantId}, ${candidateId}, ${WK01_REQ}, 'career_site',
       ${STALE_STAGE}, now() - ${ageInterval}::interval)
  `;
}

describe("WORKER-01 — stage_stale scanner", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testTenantId = (claims as { tid?: string }).tid as string;
    const userId = claims.sub as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${userId} AND tenant_id = ${testTenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing in kyndryl-poc");
    testMembershipId = m.id;

    // Defensive wipe of any leftovers from a prior failed run.
    await cleanup();

    // Create the follow-up agent via the real tRPC writer — it plants a
    // stage_stale trigger with { stage, days_threshold }.
    const createRes = await app.request("/trpc/createFollowUpAgent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        name: AGENT_NAME,
        description: "WORKER-01 stage_stale scanner test",
        days_threshold: 5,
        stage: STALE_STAGE,
        tone: "friendly",
        max_tokens: 200,
      }),
    });
    const createEnv = (await createRes.json()) as
      | TRPCSuccess<{ agentId: string }>
      | TRPCErr;
    assert.ok(!isErr(createEnv), `create should succeed: ${JSON.stringify(createEnv)}`);
    agentId = createEnv.result.data.agentId;

    await seedRequisitionChain();

    // Capture the DB clock AFTER setup, BEFORE any scan runs — the
    // watermark for ambient-row cleanup (Fix 2).
    const [nowRow] = await poolSql<{ now: string }[]>`SELECT now()::text AS now`;
    suiteStartTs = nowRow!.now;
  });

  afterAll(async () => {
    // Guaranteed cleanup of ambient scan side effects even if a test
    // failed before case (e) ran, then WK01 fixtures.
    await deleteLeakedAmbientRows();
    await cleanup();
    await poolSql.end({ timeout: 10 });
  });

  it("(a) happy path: a stale application enqueues exactly one run", async () => {
    await plantApplication(WK01_APP_STALE, WK01_CANDIDATE, "10 days"); // threshold is 5

    await stageStaleScan(scanLog);

    assert.equal(
      await outboxCountForApp(WK01_APP_STALE),
      1,
      "exactly one row enqueued for the stale application",
    );

    const [row] = await poolSql<
      { agent_id: string; status: string; trigger_context: Record<string, unknown> }[]
    >`
      SELECT agent_id::text AS agent_id, status, trigger_context
      FROM public.agent_run_outbox
      WHERE agent_id = ${agentId}
        AND trigger_context->>'application_id' = ${WK01_APP_STALE}
    `;
    assert.ok(row);
    assert.equal(row.agent_id, agentId);
    assert.equal(row.status, "pending");
    assert.equal(row.trigger_context.application_id, WK01_APP_STALE);
    assert.equal(row.trigger_context.trigger, "stage_stale");
    assert.equal(row.trigger_context.stage, STALE_STAGE);
  });

  it("(b) dedup: a second scan enqueues nothing new", async () => {
    await stageStaleScan(scanLog);
    assert.equal(
      await outboxCountForApp(WK01_APP_STALE),
      1,
      "still exactly one row for the stale application after re-scan",
    );
  });

  it("(d) fresh application inside the threshold gets no row", async () => {
    await plantApplication(WK01_APP_FRESH, WK01_CANDIDATE_F, "1 day"); // well inside the 5-day threshold
    const before = await outboxCountForAgent();

    await stageStaleScan(scanLog);

    assert.equal(await outboxCountForApp(WK01_APP_FRESH), 0, "fresh application untouched");
    assert.equal(await outboxCountForAgent(), before, "no new rows enqueued");
  });

  it("(c) respects enabled: a disabled agent enqueues nothing", async () => {
    await poolSql`
      UPDATE public.automation_agents SET enabled = false WHERE id = ${agentId}
    `;
    await plantApplication(WK01_APP_STALE2, WK01_CANDIDATE_S2, "10 days"); // stale, but agent is off
    const before = await outboxCountForAgent();

    await stageStaleScan(scanLog);

    assert.equal(
      await outboxCountForApp(WK01_APP_STALE2),
      0,
      "no row for a stale application under a disabled agent",
    );
    assert.equal(await outboxCountForAgent(), before, "disabled agent produced no new rows");
  });

  it("(e) leaves no residue: ambient outbox rows the cross-tenant scan enqueued are cleaned", async () => {
    // The scan is cross-tenant and enqueues for ambient enabled agents
    // (e.g. the SEED-01 demo follow-ups agent). Clean those side effects,
    // then assert none survive — the suite leaves the table exactly as it
    // found it apart from its own WK01 rows (cleaned in afterAll).
    await deleteLeakedAmbientRows();

    const [residual] = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.agent_run_outbox
      WHERE agent_id != ${agentId}
        AND enqueued_at >= ${suiteStartTs}::timestamptz
    `;
    assert.equal(
      residual?.n,
      0,
      "no non-WK01 outbox rows added by this suite's scans survive",
    );
  });
});
