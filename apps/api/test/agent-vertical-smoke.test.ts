/**
 * AGENT-02 — vertical proof-of-life smoke test.
 *
 * Exercises the full AGENT-02 vertical:
 *   tRPC createFollowUpAgent
 *   → INSERT agent_run_outbox (manual)
 *   → drainAgentRunOutboxOnce
 *   → bridgeActionConfig → executor dispatch → stub returns
 *   → outbox/run/run_actions reach the expected paused state on
 *     the send_message approval gate.
 *
 * AGENT-03 update: send_message now returns requiresApproval: true, so
 * after one drain pass the Follow-Up Agent halts at
 * awaiting_approval (action 1 completed, action 2 paused). The full
 * approve + resume + completion cycle is exercised by
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
  });

  afterAll(async () => {
    await cleanupSmoke();
    await poolSql.end({ timeout: 2 });
  });

  it("end-to-end: create Follow-Up Agent → enqueue → drain → paused on send_message approval", async () => {
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

    // 3. drainAgentRunOutboxOnce — Follow-Up Agent's action 2 is
    //    send_message + human_required, so AGENT-03's executor flip
    //    halts the run at awaiting_approval after one drain pass.
    const drainResult = await drainAgentRunOutboxOnce({ log: drainLog });
    assert.equal(drainResult.claimed, 1, "drain should pick up the row");
    assert.equal(drainResult.awaiting, 1, "send_message should halt for approval");
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
    assert.equal(run?.cost_micros, "0", "stub executors charge 0");

    const runActions = await poolSql<{ status: string; output: unknown; action_order: number }[]>`
      SELECT ra.status, ra.output, ra.action_order
      FROM public.agent_run_actions ra
      WHERE ra.run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${agentId})
      ORDER BY ra.action_order
    `;
    assert.equal(runActions.length, 2, "Follow-Up Agent has 2 actions");
    assert.equal(runActions[0]?.status, "completed", "draft_message completes autonomously");
    assert.equal(runActions[1]?.status, "awaiting_approval", "send_message awaits approval");
    for (const ra of runActions) {
      const out = ra.output as Record<string, unknown>;
      assert.equal(out._stub, true, "stub honesty marker present");
      assert.equal(out._ticket, "AGENT-02", "AGENT-02 ticket marker present");
    }

    const approvals = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_approval_requests WHERE agent_id = ${agentId}
    `;
    assert.equal(approvals.length, 1, "send_message produced an approval request");
    assert.equal(approvals[0]?.status, "pending");
  });
});
