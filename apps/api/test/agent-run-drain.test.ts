/**
 * AGENT-02 — integration tests for the agent_run_outbox drain worker.
 *
 * Mirrors apps/api/test/ai-03-scoring.test.ts setup pattern: signs in
 * the existing test user against the kyndryl-poc tenant, seeds rows via
 * poolSql (service_role), runs the drain, asserts terminal state.
 *
 * Coverage (5 cases):
 *   1. Empty outbox → drain returns {claimed:0, completed:0, awaiting:0, failed:0}.
 *   2. Single-action agent (draft_message) with valid jsonb → run completes,
 *      outbox completes, run_action carries the _stub/_ticket honesty markers,
 *      cost_micros = 0.
 *   3. Multi-action agent (draft_message → send_message) → both actions
 *      complete in action_order; outbox + run + both run_actions all
 *      'completed'; send_message's input.triggerContext echoes the seed.
 *   4. Invalid action_config jsonb (missing required field) → ZodError
 *      bubbles as terminal failure. outbox.status='failed', last_error set,
 *      run.status='failed' (run row was created before the parse failure).
 *      attempt_count = 1 (no retry — single-attempt model per AGENT-02).
 *   5. Defensive: dispatch with action_type matching a different jsonb
 *      shape (column says draft_message but jsonb has send_message fields)
 *      → also ZodError-terminal via the bridge.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
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

// Stable UUIDs (hex-only suffix, v4 structure). AGENT-02 prefix.
const A02_AGENT_SINGLE = "00000000-0000-4000-8000-00000a02a001";
const A02_AGENT_MULTI = "00000000-0000-4000-8000-00000a02a002";
const A02_AGENT_BAD = "00000000-0000-4000-8000-00000a02a003";
const A02_AGENT_MISMATCH = "00000000-0000-4000-8000-00000a02a004";

let testTenantId: string;
let testMembershipId: string;

const drainLog = createLogger({ base: { service: "agent-02-test" } });

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) throw new Error(`signin: ${error?.message}`);
  return data.session.access_token;
}

async function cleanupAgent(agentId: string): Promise<void> {
  // Order matters — children before parents. agent_approval_requests
  // → agent_run_actions → agent_runs → agent_run_outbox → agent_actions
  // → agent_triggers → agent_approval_rules → automation_agents.
  await poolSql`DELETE FROM public.agent_approval_requests WHERE agent_id = ${agentId}`;
  await poolSql`DELETE FROM public.agent_run_actions WHERE run_id IN (
    SELECT id FROM public.agent_runs WHERE agent_id = ${agentId}
  )`;
  await poolSql`DELETE FROM public.agent_runs WHERE agent_id = ${agentId}`;
  await poolSql`DELETE FROM public.agent_run_outbox WHERE agent_id = ${agentId}`;
  await poolSql`DELETE FROM public.agent_approval_rules WHERE agent_id = ${agentId}`;
  await poolSql`DELETE FROM public.agent_actions WHERE agent_id = ${agentId}`;
  await poolSql`DELETE FROM public.agent_triggers WHERE agent_id = ${agentId}`;
  await poolSql`DELETE FROM public.automation_agents WHERE id = ${agentId}`;
}

interface SeededAgent {
  agentId: string;
}

async function seedAgent(
  agentId: string,
  name: string,
  actions: Array<{ order: number; type: string; config: Record<string, unknown> }>,
): Promise<SeededAgent> {
  await poolSql`
    INSERT INTO public.automation_agents
      (id, tenant_id, agent_type, name, description, enabled, version, created_by)
    VALUES
      (${agentId}, ${testTenantId}, 'follow_up', ${name}, 'AGENT-02 test', true, 1, ${testMembershipId})
  `;
  await poolSql`
    INSERT INTO public.agent_triggers
      (tenant_id, agent_id, trigger_type, trigger_config)
    VALUES
      (${testTenantId}, ${agentId}, 'manual', ${JSON.stringify({})}::jsonb)
  `;
  for (const action of actions) {
    await poolSql`
      INSERT INTO public.agent_actions
        (tenant_id, agent_id, action_order, action_type, action_config)
      VALUES
        (${testTenantId}, ${agentId}, ${action.order}, ${action.type}, ${JSON.stringify(action.config)}::jsonb)
    `;
  }
  return { agentId };
}

async function enqueueRun(agentId: string, triggerContext: Record<string, unknown>): Promise<string> {
  const [row] = await poolSql<{ id: string }[]>`
    INSERT INTO public.agent_run_outbox
      (tenant_id, agent_id, trigger_context, status)
    VALUES
      (${testTenantId}, ${agentId}, ${JSON.stringify(triggerContext)}::jsonb, 'pending')
    RETURNING id
  `;
  if (!row) throw new Error("outbox insert returned no row");
  return row.id;
}

describe("AGENT-02 — agent_run_outbox drain", () => {
  beforeAll(async () => {
    const jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testTenantId = (claims as { tid?: string }).tid as string;
    const userId = claims.sub as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${userId} AND tenant_id = ${testTenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing in kyndryl-poc");
    testMembershipId = m.id;

    // Defensive — wipe any leftovers from a prior failed run.
    for (const id of [A02_AGENT_SINGLE, A02_AGENT_MULTI, A02_AGENT_BAD, A02_AGENT_MISMATCH]) {
      await cleanupAgent(id);
    }
  });

  afterAll(async () => {
    for (const id of [A02_AGENT_SINGLE, A02_AGENT_MULTI, A02_AGENT_BAD, A02_AGENT_MISMATCH]) {
      await cleanupAgent(id);
    }
    await poolSql.end({ timeout: 2 });
  });

  it("Test 1: drain returns all-zero when no pending outbox rows", async () => {
    // Wipe any stragglers from other tests.
    await poolSql`DELETE FROM public.agent_run_outbox WHERE tenant_id = ${testTenantId} AND status != 'completed'`;
    const r = await drainAgentRunOutboxOnce({ log: drainLog });
    assert.equal(r.claimed, 0);
    assert.equal(r.completed, 0);
    assert.equal(r.awaiting, 0);
    assert.equal(r.failed, 0);
  });

  it("Test 2: single-action agent completes end-to-end with stub markers + cost_micros=0", async () => {
    await seedAgent(A02_AGENT_SINGLE, "agent-02-single", [
      {
        order: 1,
        type: "draft_message",
        config: { template_prompt_id: "follow_up_v1", tone: "friendly", max_tokens: 200 },
      },
    ]);
    const outboxId = await enqueueRun(A02_AGENT_SINGLE, { application_id: "fake-app-1" });

    const r = await drainAgentRunOutboxOnce({ log: drainLog });
    assert.equal(r.claimed, 1);
    assert.equal(r.completed, 1);
    assert.equal(r.awaiting, 0);
    assert.equal(r.failed, 0);

    const [outbox] = await poolSql<{ status: string; completed_at: Date | null }[]>`
      SELECT status, completed_at FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outbox?.status, "completed");
    assert.ok(outbox?.completed_at);

    const [run] = await poolSql<{ status: string; cost_micros: string }[]>`
      SELECT status, cost_micros::text AS cost_micros FROM public.agent_runs WHERE agent_id = ${A02_AGENT_SINGLE}
    `;
    assert.equal(run?.status, "completed");
    assert.equal(run?.cost_micros, "0");

    const runActions = await poolSql<{ status: string; output: unknown }[]>`
      SELECT status, output FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${A02_AGENT_SINGLE})
      ORDER BY action_order
    `;
    assert.equal(runActions.length, 1);
    assert.equal(runActions[0]?.status, "completed");
    const out = runActions[0]?.output as Record<string, unknown>;
    assert.equal(out._stub, true);
    assert.equal(out._ticket, "AGENT-02");
    assert.equal(out.template_prompt_id, "follow_up_v1");
  });

  it("Test 3: multi-action agent halts at send_message awaiting_approval (AGENT-03 flipped the executor)", async () => {
    // AGENT-03 flipped send_message to requiresApproval: true. The drain
    // now executes draft_message → halts at send_message in
    // awaiting_approval. End-to-end completion via approve + resume is
    // covered by agent-approval-vertical-smoke.test.ts.
    await seedAgent(A02_AGENT_MULTI, "agent-02-multi", [
      {
        order: 1,
        type: "draft_message",
        config: { template_prompt_id: "follow_up_v1", tone: "friendly", max_tokens: 200 },
      },
      {
        order: 2,
        type: "send_message",
        config: { channel: "email", outbox_kind: "agent_followup", requires_approval: true },
      },
    ]);
    // The drain reads agent_approval_rules to set approver_role on the
    // approval_request row. Seed one for send_message.
    const [sendActionRow] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.agent_actions
      WHERE agent_id = ${A02_AGENT_MULTI} AND action_order = 2
    `;
    if (!sendActionRow) throw new Error("send action seed missing");
    await poolSql`
      INSERT INTO public.agent_approval_rules
        (tenant_id, agent_id, action_id, approval_mode, approver_role)
      VALUES (${testTenantId}, ${A02_AGENT_MULTI}, ${sendActionRow.id},
              'human_required', 'any_recruiter')
    `;

    const outboxId = await enqueueRun(A02_AGENT_MULTI, { application_id: "fake-app-2" });

    const r = await drainAgentRunOutboxOnce({ log: drainLog });
    assert.equal(r.claimed, 1);
    assert.equal(r.awaiting, 1, "send_message now halts the run for approval");
    assert.equal(r.completed, 0);
    assert.equal(r.failed, 0);

    const [outbox] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outbox?.status, "awaiting_approval");

    const runActions = await poolSql<
      { action_order: number; action_type: string; status: string; input: unknown }[]
    >`
      SELECT ar.action_order, ar.status, ar.input, aa.action_type
      FROM public.agent_run_actions ar
      JOIN public.agent_actions aa ON aa.id = ar.action_id AND aa.tenant_id = ar.tenant_id
      WHERE ar.run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${A02_AGENT_MULTI})
      ORDER BY ar.action_order
    `;
    assert.equal(runActions.length, 2);
    assert.equal(runActions[0]?.status, "completed");
    assert.equal(runActions[0]?.action_type, "draft_message");
    assert.equal(runActions[1]?.status, "awaiting_approval");
    assert.equal(runActions[1]?.action_type, "send_message");

    // Both run_actions persist the trigger_context snapshot — same shape as
    // what the executor sees via previousActionOutputs (worker-internal).
    const sendInput = runActions[1]?.input as { triggerContext: { application_id: string } };
    assert.equal(sendInput.triggerContext.application_id, "fake-app-2");

    // The atomic 4-row transition created an approval_request row.
    const approvals = await poolSql<{ status: string; approver_role: string }[]>`
      SELECT status, approver_role FROM public.agent_approval_requests
      WHERE agent_id = ${A02_AGENT_MULTI}
    `;
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.status, "pending");
    assert.equal(approvals[0]?.approver_role, "any_recruiter");
  });

  it("Test 4: invalid action_config jsonb → bridge ZodError → outbox failed, run failed, no retry", async () => {
    await seedAgent(A02_AGENT_BAD, "agent-02-bad-config", [
      {
        order: 1,
        type: "draft_message",
        // Missing template_prompt_id + tone — ZodError at bridgeActionConfig.
        config: { max_tokens: 200 },
      },
    ]);
    const outboxId = await enqueueRun(A02_AGENT_BAD, { application_id: "fake-app-3" });

    const r = await drainAgentRunOutboxOnce({ log: drainLog });
    assert.equal(r.claimed, 1);
    assert.equal(r.completed, 0);
    assert.equal(r.failed, 1);

    const [outbox] = await poolSql<{ status: string; last_error: string | null; attempt_count: number }[]>`
      SELECT status, last_error, attempt_count
      FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outbox?.status, "failed");
    assert.ok(outbox?.last_error && outbox.last_error.length > 0);
    assert.equal(outbox?.attempt_count, 1, "single-attempt model — no retry");

    const [run] = await poolSql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM public.agent_runs WHERE agent_id = ${A02_AGENT_BAD}
    `;
    assert.equal(run?.status, "failed");
    assert.ok(run?.error && run.error.length > 0);
  });

  it("Test 5: action_type column mismatch with jsonb shape → bridge ZodError → terminal failure", async () => {
    await seedAgent(A02_AGENT_MISMATCH, "agent-02-mismatch", [
      {
        order: 1,
        type: "send_message",
        // Valid draft_message jsonb, but the column says send_message →
        // discriminated-union members don't match → ZodError.
        config: { template_prompt_id: "x", tone: "neutral", max_tokens: 100 },
      },
    ]);
    const outboxId = await enqueueRun(A02_AGENT_MISMATCH, { application_id: "fake-app-4" });

    const r = await drainAgentRunOutboxOnce({ log: drainLog });
    assert.equal(r.failed, 1);

    const [outbox] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outbox?.status, "failed");
  });
});
