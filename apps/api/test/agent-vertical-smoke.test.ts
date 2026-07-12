/**
 * AGENT-02 — vertical proof-of-life smoke test.
 *
 * Exercises the full vertical:
 *   tRPC createFollowUpAgent
 *   → INSERT agent_run_outbox (manual)
 *   → drainAgentRunOutboxOnce
 *   → bridgeActionConfig → executor dispatch
 *   → outbox/run/run_actions reach the expected paused state on
 *     the draft_message approval gate.
 *
 * FOLLOWUP-01 update: the gate moved from send_message to
 * draft_message. The drain executes an action and only THEN evaluates
 * the gate, resuming afterwards without re-executing — so the gated
 * action must be the PURE one. After one drain pass the Follow-Up Agent
 * now halts ON action 1 (draft_message, awaiting_approval); action 2
 * (send_message) has not executed and has no run_action row yet.
 *
 * The assertion that no email was enqueued before approval is the
 * regression guard: under the old placement, send_message ran to
 * completion and only then paused for a human, which — once the executor
 * became real — would have put the message in the outbox before anyone
 * approved it.
 *
 * The full approve + resume + completion cycle is exercised by
 * agent-approval-vertical-smoke.test.ts.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { sql as poolSql } from "@hireops/db";
import { drainAgentRunOutboxOnce } from "../../../apps/workers/src/lib/agent-run-drain.js";
import { fakeExecutorDeps } from "./agent-executor-fakes.js";
import { createLogger } from "@hireops/observability";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

const SMOKE_AGENT_NAME = "agent-02-vertical-smoke";

let jwt: string;
let testTenantId: string;
const drainLog = createLogger({ base: { service: "agent-02-smoke" } });

// FOLLOWUP-01: draft_message + send_message are real executors now.
// These tests cover the DRAIN, not the executors, so the ports are faked
// -- no LLM call, no applications row, no notification_outbox write.
// Executor behaviour lives in packages/agent-actions unit tests.
const execDeps = fakeExecutorDeps();

interface TRPCSuccess<T> { result: { data: T } }
interface TRPCErr { error: { data: { code: string } } }
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

async function cleanupSmoke(): Promise<void> {
  await poolSql`
    DELETE FROM public.agent_run_actions
    WHERE run_id IN (
      SELECT id FROM public.agent_runs
      WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${SMOKE_AGENT_NAME})
    )
  `;
  await poolSql`
    DELETE FROM public.agent_runs
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${SMOKE_AGENT_NAME})
  `;
  await poolSql`
    DELETE FROM public.agent_run_outbox
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${SMOKE_AGENT_NAME})
  `;
  await poolSql`
    DELETE FROM public.agent_approval_rules
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${SMOKE_AGENT_NAME})
  `;
  await poolSql`
    DELETE FROM public.agent_actions
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${SMOKE_AGENT_NAME})
  `;
  await poolSql`
    DELETE FROM public.agent_triggers
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${SMOKE_AGENT_NAME})
  `;
  await poolSql`DELETE FROM public.automation_agents WHERE name = ${SMOKE_AGENT_NAME}`;
}

describe("AGENT-02 — vertical smoke", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testTenantId = (claims as { tid?: string }).tid as string;
    await cleanupSmoke();
    // Wipe ambient claimable outbox rows (same defensive statement as
    // agent-run-drain.test.ts Test 1). The shared dev tenant carries the
    // SEED-01 demo follow-ups agent (enabled, stage_stale on
    // tech_interview) plus seeded stale applications, so the REAL scan in
    // stage-stale-scan.test.ts enqueues pending rows for that agent as a
    // side effect. This file's single drainAgentRunOutboxOnce call claims
    // the globally-oldest pending row — an ambient row would steal the
    // pass and strand this test's own row. fileParallelism=false
    // guarantees no new ambient rows appear mid-file after this wipe.
    await poolSql`DELETE FROM public.agent_run_outbox WHERE tenant_id = ${testTenantId} AND status != 'completed'`;
  });

  afterAll(async () => {
    await cleanupSmoke();
    await poolSql.end({ timeout: 10 });
  });

  it("end-to-end: create Follow-Up Agent → enqueue → drain → paused on draft_message approval", async () => {
    // 1. tRPC createFollowUpAgent.
    const createRes = await app.request("/trpc/createFollowUpAgent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        name: SMOKE_AGENT_NAME,
        description: "Vertical proof-of-life",
        days_threshold: 5,
        stage: "tech_screen",
        tone: "friendly",
        max_tokens: 200,
      }),
    });
    const createEnv = (await createRes.json()) as TRPCSuccess<{ agentId: string }> | TRPCErr;
    assert.ok(!isErr(createEnv), `create should succeed: ${JSON.stringify(createEnv)}`);
    const agentId = createEnv.result.data.agentId;

    // 2. INSERT agent_run_outbox manually — AGENT-04+ will fire this
    //    from the stage_stale scanner; for this ticket we hand-feed it.
    const [outboxRow] = await poolSql<{ id: string }[]>`
      INSERT INTO public.agent_run_outbox
        (tenant_id, agent_id, trigger_context, status)
      VALUES
        (${testTenantId}, ${agentId},
         ${JSON.stringify({ application_id: "vertical-smoke-fake-app" })}::jsonb,
         'pending')
      RETURNING id
    `;
    assert.ok(outboxRow);
    const outboxId = outboxRow.id;

    // 3. drainAgentRunOutboxOnce — Follow-Up Agent's action 1 is
    //    draft_message + human_required (FOLLOWUP-01), so the run halts
    //    at awaiting_approval on the FIRST action after one drain pass.
    const drainResult = await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    assert.equal(drainResult.claimed, 1, "drain should pick up the row");
    assert.equal(drainResult.awaiting, 1, "draft_message should halt for approval");
    assert.equal(drainResult.completed, 0);
    assert.equal(drainResult.failed, 0);

    // 4. Terminal state after this pass: paused, not completed.
    const [outbox] = await poolSql<{ status: string; completed_at: Date | null }[]>`
      SELECT status, completed_at FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outbox?.status, "awaiting_approval");
    assert.equal(outbox?.completed_at, null);

    const [run] = await poolSql<{ status: string; cost_micros: string }[]>`
      SELECT status, cost_micros::text AS cost_micros
      FROM public.agent_runs WHERE agent_id = ${agentId}
    `;
    assert.equal(run?.status, "awaiting_approval");
    assert.equal(run?.cost_micros, "500", "draft_message rolls the LLM cost onto the run");

    const runActions = await poolSql<{ status: string; output: unknown; action_order: number }[]>`
      SELECT ra.status, ra.output, ra.action_order
      FROM public.agent_run_actions ra
      WHERE ra.run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${agentId})
      ORDER BY ra.action_order
    `;
    // The drain returns at the gate, so action 2 never gets a row on
    // this pass — send_message executes for the first time on resume.
    assert.equal(runActions.length, 1, "only draft_message has run");
    assert.equal(runActions[0]?.action_order, 1);
    assert.equal(runActions[0]?.status, "awaiting_approval", "draft_message awaits approval");

    const draftOutput = runActions[0]?.output as Record<string, unknown>;
    assert.equal(
      draftOutput.draft_text,
      "Fake drafted follow-up body.",
      "the approval payload IS the draft the recruiter reviews",
    );
    assert.equal(draftOutput.candidate_email, "candidate@example.test");

    const approvals = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_approval_requests WHERE agent_id = ${agentId}
    `;
    assert.equal(approvals.length, 1, "draft_message produced an approval request");
    assert.equal(approvals[0]?.status, "pending");

    // The regression guard. Nothing may reach the notification outbox
    // before a human has approved the draft.
    assert.equal(
      execDeps.enqueued.length,
      0,
      "no email may be enqueued while the draft is still awaiting approval",
    );
  });
});
