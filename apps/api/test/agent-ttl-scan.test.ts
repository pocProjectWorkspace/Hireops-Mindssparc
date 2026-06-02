/**
 * AGENT-03 — TTL scan tests.
 *
 * Exercises the piggyback scan in apps/workers/src/jobs/sla-imminent-scan.ts
 * (exported as agentApprovalTtlScan for direct test invocation):
 *
 *   1. human_optional past ttl_at → auto-approve (status='auto_approved',
 *      decided_by_user_id=NULL, run_action='completed', outbox re-queued).
 *
 *   2. human_required past ttl_at → ttl_at cleared, status stays
 *      'pending' (snooze expiry, not auto-decide). Outbox does NOT
 *      get re-queued.
 *
 * Both branches must leave exactly one audit_logs row from the
 * audit_record_change() trigger, with actor_user_id NULL (the worker
 * doesn't run inside withTenantContext, so the session-var path
 * documented on the trigger function deliberately stamps NULL for
 * system actions). This proves the trigger fires AND no manual audit
 * write happens alongside it on the worker path either.
 *
 * Single scan invocation covers both rows. Both are seeded directly via
 * SQL (no tRPC) so the test doesn't depend on the resolution-procedure
 * path under test elsewhere.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { sql as poolSql } from "@hireops/db";
import { agentApprovalTtlScan } from "../../../apps/workers/src/jobs/sla-imminent-scan.js";
import { createLogger } from "@hireops/observability";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY");
}

// Stable v4 UUIDs scoped to TTL tests.
const A03T_OPTIONAL_AGENT = "00000000-0000-4000-8000-00000a03f001";
const A03T_REQUIRED_AGENT = "00000000-0000-4000-8000-00000a03f002";

let testTenantId: string;
let testMembershipId: string;
const scanLog = createLogger({ base: { service: "agent-03-ttl-test" } });

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

interface SeededApproval {
  agentId: string;
  approvalRequestId: string;
  runId: string;
  outboxId: string;
}

/**
 * Seeds a complete "paused on approval" state directly via SQL:
 *   - automation_agents (1 row)
 *   - agent_triggers (1)
 *   - agent_actions (1 — send_message)
 *   - agent_approval_rules (1, with mode passed in)
 *   - agent_run_outbox (1, status='awaiting_approval')
 *   - agent_runs (1, status='awaiting_approval')
 *   - agent_run_actions (1, status='awaiting_approval', output set)
 *   - agent_approval_requests (1, status='pending', ttl_at one minute in the past)
 *
 * Returns the IDs the tests need to assert against.
 */
async function seedPausedApproval(
  agentId: string,
  approvalMode: "human_optional" | "human_required",
  name: string,
): Promise<SeededApproval> {
  await poolSql`
    INSERT INTO public.automation_agents
      (id, tenant_id, agent_type, name, description, enabled, version, created_by)
    VALUES
      (${agentId}, ${testTenantId}, 'follow_up', ${name}, 'AGENT-03 ttl test',
       true, 1, ${testMembershipId})
  `;
  await poolSql`
    INSERT INTO public.agent_triggers
      (tenant_id, agent_id, trigger_type, trigger_config)
    VALUES (${testTenantId}, ${agentId}, 'manual', ${JSON.stringify({})}::jsonb)
  `;
  const actionRows = await poolSql<{ id: string }[]>`
    INSERT INTO public.agent_actions
      (tenant_id, agent_id, action_order, action_type, action_config)
    VALUES (${testTenantId}, ${agentId}, 1, 'send_message',
            ${JSON.stringify({ channel: "email", outbox_kind: "agent_followup", requires_approval: true })}::jsonb)
    RETURNING id
  `;
  const actionId = actionRows[0]?.id;
  if (!actionId) throw new Error("seed: action insert returned no row");
  await poolSql`
    INSERT INTO public.agent_approval_rules
      (tenant_id, agent_id, action_id, approval_mode, approver_role)
    VALUES (${testTenantId}, ${agentId}, ${actionId}, ${approvalMode}, 'any_recruiter')
  `;
  const triggerCtx = JSON.stringify({ application_id: `ttl-${approvalMode}` });
  const outboxRows = await poolSql<{ id: string }[]>`
    INSERT INTO public.agent_run_outbox
      (tenant_id, agent_id, trigger_context, status)
    VALUES (${testTenantId}, ${agentId}, ${triggerCtx}::jsonb, 'awaiting_approval')
    RETURNING id
  `;
  const runRows = await poolSql<{ id: string }[]>`
    INSERT INTO public.agent_runs
      (tenant_id, agent_id, triggered_by, trigger_context, status)
    VALUES (${testTenantId}, ${agentId}, 'system', ${triggerCtx}::jsonb, 'awaiting_approval')
    RETURNING id
  `;
  if (!outboxRows[0] || !runRows[0]) throw new Error("seed: outbox/run insert returned no row");
  const stubOutput = JSON.stringify({
    _stub: true,
    _ticket: "AGENT-02",
    _originally_set_by: "AGENT-02",
    channel: "email",
    sent: false,
  });
  const runActionRows = await poolSql<{ id: string }[]>`
    INSERT INTO public.agent_run_actions
      (tenant_id, run_id, action_id, action_order, status, started_at, output, input)
    VALUES (${testTenantId}, ${runRows[0]!.id}, ${actionId}, 1, 'awaiting_approval', now(),
            ${stubOutput}::jsonb,
            ${JSON.stringify({ config: { channel: "email" }, triggerContext: {} })}::jsonb)
    RETURNING id
  `;
  if (!runActionRows[0]) throw new Error("seed: run_action insert returned no row");
  // ttl_at one minute in the past so the scan picks it up immediately.
  const approvalRows = await poolSql<{ id: string }[]>`
    INSERT INTO public.agent_approval_requests
      (tenant_id, run_id, run_action_id, agent_id,
       proposed_action_summary, proposed_action_payload, approver_role,
       status, ttl_at)
    VALUES (${testTenantId}, ${runRows[0]!.id}, ${runActionRows[0]!.id}, ${agentId},
            'send_message requires approval', ${stubOutput}::jsonb, 'any_recruiter',
            'pending', now() - interval '1 minute')
    RETURNING id
  `;
  if (!approvalRows[0]) throw new Error("seed: approval insert returned no row");
  return {
    agentId,
    approvalRequestId: approvalRows[0]!.id,
    runId: runRows[0]!.id,
    outboxId: outboxRows[0]!.id,
  };
}

describe("AGENT-03 — TTL scan", () => {
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

    await cleanupAgent(A03T_OPTIONAL_AGENT);
    await cleanupAgent(A03T_REQUIRED_AGENT);
  });

  afterAll(async () => {
    await cleanupAgent(A03T_OPTIONAL_AGENT);
    await cleanupAgent(A03T_REQUIRED_AGENT);
    await poolSql.end({ timeout: 2 });
  });

  it("human_optional past ttl_at → auto-approved + outbox re-queued; human_required past ttl_at → ttl_at cleared, status pending", async () => {
    const optional = await seedPausedApproval(
      A03T_OPTIONAL_AGENT,
      "human_optional",
      "agent-03-ttl-optional",
    );
    const required = await seedPausedApproval(
      A03T_REQUIRED_AGENT,
      "human_required",
      "agent-03-ttl-required",
    );

    // Audit baseline — wipe any straggling rows for these approval ids
    // so the post-scan count assertion isolates the scan's effect.
    await poolSql`
      DELETE FROM public.audit_logs
      WHERE entity_id IN (${optional.approvalRequestId}, ${required.approvalRequestId})
    `;

    const result = await agentApprovalTtlScan(scanLog);
    // Scope assertions to OUR seeded rows — there may be unrelated
    // expired approvals from other test runs leaking. We assert that
    // the scan made these two rows do the right thing, not that the
    // global counts match.
    assert.ok(result.autoApproved >= 1, "at least one optional auto-approved");
    assert.ok(result.snoozeExpired >= 1, "at least one required snooze-expired");

    // human_optional row: should be auto_approved + outbox re-queued.
    const [opt] = await poolSql<{ status: string; decided_by_user_id: string | null }[]>`
      SELECT status, decided_by_user_id::text
      FROM public.agent_approval_requests WHERE id = ${optional.approvalRequestId}
    `;
    assert.equal(opt?.status, "auto_approved");
    assert.equal(opt?.decided_by_user_id, null, "system auto-approve has no user");

    const [optOutbox] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_outbox WHERE id = ${optional.outboxId}
    `;
    assert.equal(optOutbox?.status, "pending", "auto-approve re-queues the outbox");

    const [optRun] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_runs WHERE id = ${optional.runId}
    `;
    assert.equal(optRun?.status, "running");

    const [optRA] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_actions WHERE run_id = ${optional.runId}
    `;
    assert.equal(optRA?.status, "completed");

    // human_required row: status still pending, ttl_at cleared, outbox
    // untouched (still awaiting_approval).
    const [req] = await poolSql<{ status: string; ttl_at: Date | string | null }[]>`
      SELECT status, ttl_at FROM public.agent_approval_requests
      WHERE id = ${required.approvalRequestId}
    `;
    assert.equal(req?.status, "pending");
    assert.equal(req?.ttl_at, null, "snooze TTL cleared on human_required");

    const [reqOutbox] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_outbox WHERE id = ${required.outboxId}
    `;
    assert.equal(
      reqOutbox?.status,
      "awaiting_approval",
      "human_required outbox stays paused, no re-queue",
    );

    const [reqRun] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_runs WHERE id = ${required.runId}
    `;
    assert.equal(reqRun?.status, "awaiting_approval");

    // ─── Audit assertions ───
    // Worker is not wrapped in withTenantContext, so actor_user_id is
    // NULL by design (per the audit_record_change function docstring).
    // tenant_id, however, is sourced from NEW.tenant_id on the
    // agent_approval_requests row itself (not from a session var) — so
    // worker-path audit rows ARE tenant-attributed, not NULL-tenant
    // orphans. Exactly one audit_logs row per UPDATE — no double-write.
    interface AuditRow {
      tenant_id: string;
      actor_user_id: string | null;
      source: string;
      before_data: Record<string, unknown>;
      after_data: Record<string, unknown>;
      changed_columns: string[];
    }
    const optAuditRows = await poolSql<AuditRow[]>`
      SELECT tenant_id::text, actor_user_id::text, source, before_data, after_data, changed_columns
      FROM public.audit_logs
      WHERE entity_id = ${optional.approvalRequestId}
        AND entity_type = 'agent_approval_requests'
        AND action = 'update'
    `;
    assert.equal(
      optAuditRows.length,
      1,
      `human_optional auto-approve: expected 1 audit row, saw ${optAuditRows.length}`,
    );
    const optAudit = optAuditRows[0]!;
    assert.equal(
      optAudit.tenant_id,
      testTenantId,
      "auto-approve audit row is tenant-attributed (sourced from NEW.tenant_id, not session var)",
    );
    assert.equal(optAudit.actor_user_id, null, "system auto-approve: actor_user_id NULL");
    assert.equal(
      (optAudit.before_data as { status?: string }).status,
      "pending",
      "before.status was pending",
    );
    assert.equal(
      (optAudit.after_data as { status?: string }).status,
      "auto_approved",
      "after.status is auto_approved",
    );
    assert.ok(
      optAudit.changed_columns.includes("status"),
      `changed_columns should include status, got: ${optAudit.changed_columns.join(", ")}`,
    );

    const reqAuditRows = await poolSql<AuditRow[]>`
      SELECT tenant_id::text, actor_user_id::text, source, before_data, after_data, changed_columns
      FROM public.audit_logs
      WHERE entity_id = ${required.approvalRequestId}
        AND entity_type = 'agent_approval_requests'
        AND action = 'update'
    `;
    assert.equal(
      reqAuditRows.length,
      1,
      `human_required snooze-expire: expected 1 audit row, saw ${reqAuditRows.length}`,
    );
    const reqAudit = reqAuditRows[0]!;
    assert.equal(
      reqAudit.tenant_id,
      testTenantId,
      "snooze-expire audit row is tenant-attributed (sourced from NEW.tenant_id, not session var)",
    );
    assert.equal(reqAudit.actor_user_id, null, "system snooze-clear: actor_user_id NULL");
    assert.equal(
      (reqAudit.before_data as { status?: string; ttl_at?: string | null }).status,
      "pending",
      "before.status was pending",
    );
    assert.equal(
      (reqAudit.after_data as { status?: string }).status,
      "pending",
      "after.status stays pending — only ttl_at moved",
    );
    assert.ok(
      reqAudit.changed_columns.includes("ttl_at"),
      `changed_columns should include ttl_at, got: ${reqAudit.changed_columns.join(", ")}`,
    );
  });
});
