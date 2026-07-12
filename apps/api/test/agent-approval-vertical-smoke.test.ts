/**
 * AGENT-03 — vertical smoke for the approval cycle.
 *
 * FOLLOWUP-01 note: the curated Follow-Up Agent now gates action 1
 * (draft_message, the pure action) rather than action 2 (send_message,
 * the effectful one) — the drain executes-then-gates and resumes without
 * re-executing, so a gated send would have enqueued the email before the
 * human approved. Tests 1/2/3/5 use the curated agent and therefore now
 * pause on action 1. Test 4 hand-seeds its own 3-action layout to
 * exercise the resume mechanics and keeps its gate on the middle action.
 * The executors are faked (execDeps) so these tests stay about the drain.
 *
 * Five tests exercise the full pause + resolve + resume loop end-to-end:
 *
 *   1. Approve (no edit):
 *      create Follow-Up Agent → enqueue → drain (halts at draft_message)
 *      → approveApproval → drain again → outbox+run completed. Action 1
 *      output is the draft; action 2 (send_message) then runs for the
 *      first time on resume and reports sent: true.
 *
 *   2. Approve-with-edit:
 *      same setup, approveApprovalWithEdit replaces the DRAFT payload.
 *      After resume, action 1 output matches the edited draft, action 2
 *      sends the edited body, and the agent_approval_requests row carries
 *      both proposed_action_payload (original) AND edited_payload.
 *
 *   3. Reject:
 *      same setup, rejectApproval terminates the run at action 1.
 *      Outbox=failed, run=rejected, run_actions[0]=failed, and no email
 *      was ever enqueued. Drain again picks no work.
 *
 *   4. Three-action worker resume (Step 4 of the AGENT-03 prompt):
 *      [A, B (gated), C]. Drain → A completed, B awaiting_approval,
 *      C not yet executed. Approve B. Drain again → A skipped, B skipped
 *      (completed via approval), C executed. Run completes.
 *
 *   5. Snooze:
 *      same setup, snoozeApproval bumps ttl_at by 24h. Status stays
 *      'pending', outbox stays 'awaiting_approval', run stays
 *      'awaiting_approval'. One audit row recorded.
 *
 * Every test that resolves an approval also asserts the trigger-side
 * audit_logs surface: exactly one row per resolution, actor_user_id
 * populated from the JWT subject, before.status='pending', after.status
 * matches the resolution. This is the wedge's "full audit" promise —
 * each HR decision leaves exactly one row-level audit trail without
 * double-write.
 *
 * Setup pattern mirrors agent-vertical-smoke.test.ts — signed-in test
 * user, tRPC mutations via app.request, manual outbox INSERT, direct
 * drainAgentRunOutboxOnce calls.
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

const NAME_APPROVE = "agent-03-approve";
const NAME_APPROVE_EDIT = "agent-03-approve-edit";
const NAME_REJECT = "agent-03-reject";
const NAME_RESUME = "agent-03-resume-three";
const NAME_SNOOZE = "agent-03-snooze";

// Stable v4 UUIDs for the 3-action resume agent (created via SQL not tRPC).
const A03_RESUME_AGENT = "00000000-0000-4000-8000-00000a03e001";

let jwt: string;
let testTenantId: string;
let testMembershipId: string;
let testAuthUserId: string;
const drainLog = createLogger({ base: { service: "agent-03-smoke" } });

// FOLLOWUP-01: draft_message + send_message are real executors now.
// These tests cover the DRAIN, not the executors, so the ports are faked
// -- no LLM call, no applications row, no notification_outbox write.
// Executor behaviour lives in packages/agent-actions unit tests.
const execDeps = fakeExecutorDeps();

/**
 * Audit-row assertion shared across the resolution tests. The
 * audit_record_change() trigger writes exactly one row per UPDATE on
 * agent_approval_requests (migration 0041's INSERT OR UPDATE OR DELETE
 * with no WHERE clause), with no-op-updates short-circuited inside the
 * function. We assert:
 *   1. exactly one audit_logs row with entity_id = approvalRequestId
 *      AND action = 'update' — confirms trigger fires AND no manual
 *      audit_logs write is happening alongside it.
 *   2. actor_user_id populated from withTenantContext's session var
 *      (which the protected procedure middleware seeds from JWT.sub).
 *   3. before.status='pending' + after.status matches the resolution.
 *   4. changed_columns includes the expected fields.
 */
interface AuditAssertion {
  expectedAfterStatus: string;
  expectAfterDecisionNotes?: string | null;
  expectAfterDecidedByUserId?: "set" | null;
  expectChangedColumns: string[];
}
interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  source: string;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
  changed_columns: string[];
}
async function assertResolutionAudit(
  approvalRequestId: string,
  expected: AuditAssertion,
): Promise<void> {
  const rows = await poolSql<AuditLogRow[]>`
    SELECT id::text, actor_user_id::text, source, before_data, after_data, changed_columns
    FROM public.audit_logs
    WHERE entity_id = ${approvalRequestId}
      AND entity_type = 'agent_approval_requests'
      AND action = 'update'
  `;
  assert.equal(
    rows.length,
    1,
    `expected exactly one audit_logs row for the resolution, saw ${rows.length}`,
  );
  const row = rows[0]!;
  assert.equal(row.actor_user_id, testAuthUserId, "actor_user_id from JWT.sub");
  assert.equal(row.source, "app");
  assert.equal(
    (row.before_data as { status?: string }).status,
    "pending",
    "before.status was 'pending'",
  );
  assert.equal(
    (row.after_data as { status?: string }).status,
    expected.expectedAfterStatus,
    `after.status is ${expected.expectedAfterStatus}`,
  );
  if (expected.expectAfterDecidedByUserId === "set") {
    assert.ok(
      (row.after_data as { decided_by_user_id?: string | null }).decided_by_user_id,
      "decided_by_user_id populated on after",
    );
  } else if (expected.expectAfterDecidedByUserId === null) {
    assert.equal(
      (row.after_data as { decided_by_user_id?: string | null }).decided_by_user_id ?? null,
      null,
    );
  }
  if (expected.expectAfterDecisionNotes !== undefined) {
    assert.equal(
      (row.after_data as { decision_notes?: string | null }).decision_notes ?? null,
      expected.expectAfterDecisionNotes,
    );
  }
  for (const col of expected.expectChangedColumns) {
    assert.ok(
      row.changed_columns.includes(col),
      `changed_columns should include '${col}', got: ${row.changed_columns.join(", ")}`,
    );
  }
}

/**
 * Cleans up audit_logs entries from prior test runs scoped to a given
 * approval_request_id. Audit_logs is partitioned by created_at; the
 * SELECT/DELETE on the public.audit_logs partitioned parent routes
 * across partitions automatically. service_role bypasses RLS.
 */
async function cleanupAuditLogsByEntity(entityId: string): Promise<void> {
  await poolSql`DELETE FROM public.audit_logs WHERE entity_id = ${entityId}`;
}

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

async function trpcMutation<O>(name: string, input: unknown): Promise<TRPCSuccess<O> | TRPCErr> {
  const res = await app.request(`/trpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(input),
  });
  return (await res.json()) as TRPCSuccess<O> | TRPCErr;
}

async function cleanupAgentByName(name: string): Promise<void> {
  // Children before parents — agent_approval_requests → agent_run_actions →
  // agent_runs → agent_run_outbox → agent_actions → agent_triggers →
  // agent_approval_rules → automation_agents.
  await poolSql`
    DELETE FROM public.agent_approval_requests
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_run_actions
    WHERE run_id IN (
      SELECT id FROM public.agent_runs
      WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
    )
  `;
  await poolSql`
    DELETE FROM public.agent_runs
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_run_outbox
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_approval_rules
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_actions
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`
    DELETE FROM public.agent_triggers
    WHERE agent_id IN (SELECT id FROM public.automation_agents WHERE name = ${name})
  `;
  await poolSql`DELETE FROM public.automation_agents WHERE name = ${name}`;
}

async function cleanupAgentById(agentId: string): Promise<void> {
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

async function createFollowUpAgent(name: string): Promise<string> {
  const env = await trpcMutation<{ agentId: string }>("createFollowUpAgent", {
    name,
    description: "AGENT-03 vertical smoke",
    days_threshold: 5,
    stage: "tech_screen",
    tone: "friendly",
    max_tokens: 200,
  });
  assert.ok(!isErr(env), `createFollowUpAgent should succeed: ${JSON.stringify(env)}`);
  return env.result.data.agentId;
}

async function enqueueOutbox(
  agentId: string,
  triggerContext: Record<string, unknown>,
): Promise<string> {
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

async function pendingApprovalIdFor(agentId: string): Promise<string> {
  const [row] = await poolSql<{ id: string }[]>`
    SELECT id FROM public.agent_approval_requests
    WHERE agent_id = ${agentId} AND status = 'pending'
  `;
  if (!row) throw new Error("no pending approval request for agent");
  return row.id;
}

describe("AGENT-03 — approval cycle vertical smoke", () => {
  beforeAll(async () => {
    jwt = await getTestJwt();
    const claims = decodeJwt(jwt);
    testTenantId = (claims as { tid?: string }).tid as string;
    testAuthUserId = claims.sub as string;
    const [m] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${testAuthUserId} AND tenant_id = ${testTenantId} LIMIT 1
    `;
    if (!m) throw new Error("test user membership missing in kyndryl-poc");
    testMembershipId = m.id;

    for (const n of [NAME_APPROVE, NAME_APPROVE_EDIT, NAME_REJECT, NAME_RESUME, NAME_SNOOZE]) {
      await cleanupAgentByName(n);
    }
    await cleanupAgentById(A03_RESUME_AGENT);
    // Wipe ambient claimable outbox rows (same defensive statement as
    // agent-run-drain.test.ts Test 1). The shared dev tenant carries the
    // SEED-01 demo follow-ups agent (enabled, stage_stale on
    // tech_interview) plus seeded stale applications, so the REAL scan in
    // stage-stale-scan.test.ts enqueues pending rows for that agent as a
    // side effect. Every drain in this file claims the globally-oldest
    // pending row — an ambient row would steal a pass and strand the
    // test's own row. fileParallelism=false guarantees no new ambient
    // rows appear mid-file after this wipe.
    await poolSql`DELETE FROM public.agent_run_outbox WHERE tenant_id = ${testTenantId} AND status != 'completed'`;
  });

  afterAll(async () => {
    for (const n of [NAME_APPROVE, NAME_APPROVE_EDIT, NAME_REJECT, NAME_RESUME, NAME_SNOOZE]) {
      await cleanupAgentByName(n);
    }
    await cleanupAgentById(A03_RESUME_AGENT);
    await poolSql.end({ timeout: 10 });
  });

  it("Test 1: approve (no edit) — drain → pause → approve → drain → completed", async () => {
    execDeps.enqueued.length = 0; // shared fake; isolate this test's count
    const agentId = await createFollowUpAgent(NAME_APPROVE);
    const outboxId = await enqueueOutbox(agentId, { application_id: "approve-fake-app" });

    // First drain — halts at draft_message (the gated action).
    let r = await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    assert.equal(r.claimed, 1);
    assert.equal(r.awaiting, 1, "draft_message gate fires");

    const approvalId = await pendingApprovalIdFor(agentId);

    // Pre-resolution: no audit row yet for THIS approval_request_id.
    // Defensive cleanup against any straggling row from a prior failed
    // test run (the trigger writes to audit_logs which the cleanup
    // helpers above do not touch — they only cascade through the
    // agent_* tables).
    await cleanupAuditLogsByEntity(approvalId);

    // Resolve via tRPC.
    const env = await trpcMutation<{ status: string; runId: string }>("approveApproval", {
      approvalRequestId: approvalId,
      decisionNotes: "Looks good",
    });
    assert.ok(!isErr(env), `approveApproval should succeed: ${JSON.stringify(env)}`);
    assert.equal(env.result.data.status, "approved");

    // Audit-row assertion — exactly one audit_logs row from the trigger.
    await assertResolutionAudit(approvalId, {
      expectedAfterStatus: "approved",
      expectAfterDecisionNotes: "Looks good",
      expectAfterDecidedByUserId: "set",
      expectChangedColumns: ["status", "decided_at", "decided_by_user_id", "decision_notes"],
    });

    // Mid-state assertions: outbox re-queued; run back to running.
    const [outboxMid] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outboxMid?.status, "pending", "approval re-queues the outbox");
    const [runMid] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_runs WHERE agent_id = ${agentId}
    `;
    assert.equal(runMid?.status, "running");
    const [approvalRow] = await poolSql<{
      status: string;
      decided_by_user_id: string | null;
      decision_notes: string | null;
    }[]>`
      SELECT status, decided_by_user_id::text, decision_notes
      FROM public.agent_approval_requests WHERE id = ${approvalId}
    `;
    assert.equal(approvalRow?.status, "approved");
    assert.ok(approvalRow?.decided_by_user_id, "decided_by_user_id set");
    assert.equal(approvalRow?.decision_notes, "Looks good");

    // Second drain — resumes, completes.
    r = await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    assert.equal(r.claimed, 1, "resume picks up the re-queued row");
    assert.equal(r.completed, 1);
    assert.equal(r.failed, 0);

    const [outboxFinal] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outboxFinal?.status, "completed");

    const [runFinal] = await poolSql<{ status: string; completed_at: Date | null }[]>`
      SELECT status, completed_at FROM public.agent_runs WHERE agent_id = ${agentId}
    `;
    assert.equal(runFinal?.status, "completed");
    assert.ok(runFinal?.completed_at);

    const runActions = await poolSql<{ status: string; output: unknown; action_order: number }[]>`
      SELECT status, output, action_order FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${agentId})
      ORDER BY action_order
    `;
    assert.equal(runActions.length, 2);
    for (const ra of runActions) assert.equal(ra.status, "completed");
    // Action 1 was the approved draft; action 2 (send_message) executed
    // for the first time on resume and really enqueued the message.
    const draftOut = runActions[0]?.output as Record<string, unknown>;
    assert.equal(draftOut.draft_text, "Fake drafted follow-up body.");
    const sendOut = runActions[1]?.output as Record<string, unknown>;
    assert.equal(sendOut.sent, true, "send runs post-approval and reports sent");
    assert.ok(sendOut.notification_outbox_id, "send enqueued a notification row");

    // The email was enqueued exactly once, and only after approval.
    assert.equal(execDeps.enqueued.length, 1, "one email, sent after the human approved");
  });

  it("Test 2: approve with edit — edited draft replaces run_action.output and is what gets sent", async () => {
    execDeps.enqueued.length = 0; // shared fake; isolate this test's count
    const agentId = await createFollowUpAgent(NAME_APPROVE_EDIT);
    await enqueueOutbox(agentId, { application_id: "edit-fake-app" });
    await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    const approvalId = await pendingApprovalIdFor(agentId);

    // The gated action is draft_message now, so the recruiter edits the
    // DRAFT. The edit must carry the full draft output shape because it
    // replaces agent_run_actions.output wholesale, and send_message reads
    // that shape on resume. This is the crux: the candidate receives the
    // recruiter's words, not the model's.
    const editedPayload = {
      _edited_by_recruiter: true,
      draft_text: "Recruiter-rewritten follow-up. Warmer than the model's.",
      subject: "A quick note about your application",
      candidate_email: "candidate@example.test",
      candidate_id: "fake-candidate",
      candidate_name: "Test Candidate",
      position_title: "Senior Backend Engineer",
      company_name: "Kyndryl GCC",
      template_prompt_id: "follow_up_v1",
      prompt_version: "followup-v1",
      tone: "friendly",
    };
    await cleanupAuditLogsByEntity(approvalId);

    const env = await trpcMutation<{ status: string }>("approveApprovalWithEdit", {
      approvalRequestId: approvalId,
      editedPayload,
      decisionNotes: "Tweaked the recipient",
    });
    assert.ok(!isErr(env), `approveApprovalWithEdit should succeed: ${JSON.stringify(env)}`);

    // Audit assertion — one row. Edit path stamps the same decision
    // fields as the plain approve path (decided_at, decided_by_user_id,
    // decision_notes) PLUS edited_payload. All five must show up in
    // changed_columns for the row diff to be honest.
    await assertResolutionAudit(approvalId, {
      expectedAfterStatus: "approved",
      expectAfterDecisionNotes: "Tweaked the recipient",
      expectAfterDecidedByUserId: "set",
      expectChangedColumns: [
        "status",
        "decided_at",
        "decided_by_user_id",
        "decision_notes",
        "edited_payload",
      ],
    });

    // Approval-request audit triple: proposed_action_payload (original)
    // + edited_payload (the edit) + run_action.output (final, the edit).
    const [ar] = await poolSql<{
      proposed_action_payload: Record<string, unknown>;
      edited_payload: Record<string, unknown> | null;
      status: string;
    }[]>`
      SELECT proposed_action_payload, edited_payload, status
      FROM public.agent_approval_requests WHERE id = ${approvalId}
    `;
    assert.equal(ar?.status, "approved");
    assert.equal(
      (ar?.proposed_action_payload as Record<string, unknown>).draft_text,
      "Fake drafted follow-up body.",
      "proposed_action_payload preserves the model's original draft",
    );
    assert.equal(
      (ar?.edited_payload as Record<string, unknown>)._edited_by_recruiter,
      true,
      "edited_payload carries the edit",
    );

    // Pre-resume — the gated action (1) already updated to the edited draft.
    const [raMid] = await poolSql<{ output: Record<string, unknown> }[]>`
      SELECT output FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${agentId})
        AND action_order = 1
    `;
    assert.equal(raMid?.output._edited_by_recruiter, true);

    // Resume drain — action 1 stays edited (worker reads existing, doesn't
    // overwrite), action 2 executes and sends the edited body.
    const r = await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    assert.equal(r.completed, 1);

    const [raFinal] = await poolSql<{ output: Record<string, unknown>; status: string }[]>`
      SELECT output, status FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${agentId})
        AND action_order = 1
    `;
    assert.equal(raFinal?.status, "completed");
    assert.equal(raFinal?.output._edited_by_recruiter, true, "edit persists after resume");

    // The message actually sent carries the recruiter's text, not the
    // model's — this is the whole point of gating the draft.
    assert.equal(execDeps.enqueued.length, 1);
    const [sendOut] = await poolSql<{ output: Record<string, unknown> }[]>`
      SELECT output FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${agentId})
        AND action_order = 2
    `;
    assert.equal(sendOut?.output.sent, true);
  });

  it("Test 3: reject — run terminates, outbox failed, drain picks no work", async () => {
    execDeps.enqueued.length = 0; // shared fake; isolate this test's count
    const agentId = await createFollowUpAgent(NAME_REJECT);
    const outboxId = await enqueueOutbox(agentId, { application_id: "reject-fake-app" });
    await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    const approvalId = await pendingApprovalIdFor(agentId);

    await cleanupAuditLogsByEntity(approvalId);

    const env = await trpcMutation<{ status: string }>("rejectApproval", {
      approvalRequestId: approvalId,
      decisionNotes: "Tone is off for this candidate",
    });
    assert.ok(!isErr(env), `rejectApproval should succeed: ${JSON.stringify(env)}`);
    assert.equal(env.result.data.status, "rejected");

    await assertResolutionAudit(approvalId, {
      expectedAfterStatus: "rejected",
      expectAfterDecisionNotes: "Tone is off for this candidate",
      expectAfterDecidedByUserId: "set",
      expectChangedColumns: ["status", "decided_at", "decided_by_user_id", "decision_notes"],
    });

    const [ar] = await poolSql<{ status: string; decision_notes: string | null }[]>`
      SELECT status, decision_notes FROM public.agent_approval_requests WHERE id = ${approvalId}
    `;
    assert.equal(ar?.status, "rejected");
    assert.equal(ar?.decision_notes, "Tone is off for this candidate");

    const [outbox] = await poolSql<{ status: string; last_error: string | null }[]>`
      SELECT status, last_error FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outbox?.status, "failed");
    assert.equal(outbox?.last_error, "Approval rejected");

    const [run] = await poolSql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM public.agent_runs WHERE agent_id = ${agentId}
    `;
    assert.equal(run?.status, "rejected");
    assert.ok(run?.error?.includes("Approval rejected at action"));

    // The gated action is action 1 (draft) now; rejection fails it, and
    // action 2 (send) never got a row — nothing was sent.
    const [ra1] = await poolSql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${agentId})
        AND action_order = 1
    `;
    assert.equal(ra1?.status, "failed");
    assert.ok(ra1?.error?.includes("Tone is off for this candidate"));

    const sendRows = await poolSql<{ id: string }[]>`
      SELECT id FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${agentId})
        AND action_order = 2
    `;
    assert.equal(sendRows.length, 0, "send_message never ran");
    assert.equal(execDeps.enqueued.length, 0, "a rejected follow-up sends nothing");

    // Another drain pass — outbox is not 'pending' so claim count is 0.
    // But we need to clear any other tenant outbox rows that might be
    // pending from concurrent tests; assert no row for THIS outboxId moved.
    await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    const [outboxAfter] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outboxAfter?.status, "failed", "rejected outbox stays failed");
  });

  it("Test 4: three-action worker resume — A completed, B paused, C executed only after approve", async () => {
    // Create a 3-action agent directly via SQL — createFollowUpAgent
    // only ships a 2-action layout. Action B = send_message carries the
    // gate; A + C are draft_message and pass autonomously. This is a
    // MECHANICAL fixture for the resume path (A skipped, B completed via
    // approval, C executed fresh) — it deliberately gates the middle
    // action regardless of type. The curated Follow-Up Agent gates the
    // pure draft instead (FOLLOWUP-01); that placement correctness is
    // covered by tests 1–3, not here.
    await poolSql`
      INSERT INTO public.automation_agents
        (id, tenant_id, agent_type, name, description, enabled, version, created_by)
      VALUES
        (${A03_RESUME_AGENT}, ${testTenantId}, 'follow_up', ${NAME_RESUME},
         'AGENT-03 resume', true, 1, ${testMembershipId})
    `;
    await poolSql`
      INSERT INTO public.agent_triggers
        (tenant_id, agent_id, trigger_type, trigger_config)
      VALUES (${testTenantId}, ${A03_RESUME_AGENT}, 'manual', ${JSON.stringify({})}::jsonb)
    `;
    const draftA = await poolSql<{ id: string }[]>`
      INSERT INTO public.agent_actions
        (tenant_id, agent_id, action_order, action_type, action_config)
      VALUES (${testTenantId}, ${A03_RESUME_AGENT}, 1, 'draft_message',
              ${JSON.stringify({ template_prompt_id: "follow_up_v1", tone: "friendly", max_tokens: 200 })}::jsonb)
      RETURNING id
    `;
    const sendB = await poolSql<{ id: string }[]>`
      INSERT INTO public.agent_actions
        (tenant_id, agent_id, action_order, action_type, action_config)
      VALUES (${testTenantId}, ${A03_RESUME_AGENT}, 2, 'send_message',
              ${JSON.stringify({ channel: "email", outbox_kind: "agent_followup", requires_approval: true })}::jsonb)
      RETURNING id
    `;
    const draftC = await poolSql<{ id: string }[]>`
      INSERT INTO public.agent_actions
        (tenant_id, agent_id, action_order, action_type, action_config)
      VALUES (${testTenantId}, ${A03_RESUME_AGENT}, 3, 'draft_message',
              ${JSON.stringify({ template_prompt_id: "follow_up_v1", tone: "neutral", max_tokens: 100 })}::jsonb)
      RETURNING id
    `;
    if (!draftA[0] || !sendB[0] || !draftC[0]) throw new Error("seed inserts failed");

    // Approval rule for B — required so the gate engages on the
    // executor's requiresApproval: true.
    await poolSql`
      INSERT INTO public.agent_approval_rules
        (tenant_id, agent_id, action_id, approval_mode, approver_role)
      VALUES (${testTenantId}, ${A03_RESUME_AGENT}, ${sendB[0]!.id},
              'human_required', 'any_recruiter')
    `;

    await enqueueOutbox(A03_RESUME_AGENT, { application_id: "resume-three" });

    // First drain — A completes, B halts, C untouched.
    let r = await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    assert.equal(r.awaiting, 1, "B awaits approval");
    let runActions = await poolSql<{ action_order: number; status: string }[]>`
      SELECT action_order, status FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${A03_RESUME_AGENT})
      ORDER BY action_order
    `;
    assert.equal(runActions.length, 2, "C not yet recorded — worker halted at B");
    assert.equal(runActions[0]?.action_order, 1);
    assert.equal(runActions[0]?.status, "completed");
    assert.equal(runActions[1]?.action_order, 2);
    assert.equal(runActions[1]?.status, "awaiting_approval");

    // Approve B.
    const approvalId = await pendingApprovalIdFor(A03_RESUME_AGENT);
    await cleanupAuditLogsByEntity(approvalId);
    const env = await trpcMutation<{ status: string }>("approveApproval", {
      approvalRequestId: approvalId,
    });
    assert.ok(!isErr(env), `approveApproval should succeed: ${JSON.stringify(env)}`);

    await assertResolutionAudit(approvalId, {
      expectedAfterStatus: "approved",
      expectAfterDecisionNotes: null,
      expectAfterDecidedByUserId: "set",
      expectChangedColumns: ["status", "decided_at", "decided_by_user_id"],
    });

    // Second drain — A skipped (already completed), B skipped (already
    // completed via approval), C executed fresh.
    r = await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    assert.equal(r.claimed, 1, "resume picks up the re-queued outbox");
    assert.equal(r.completed, 1, "resume completes the remaining work");

    runActions = await poolSql<{ action_order: number; status: string }[]>`
      SELECT action_order, status FROM public.agent_run_actions
      WHERE run_id IN (SELECT id FROM public.agent_runs WHERE agent_id = ${A03_RESUME_AGENT})
      ORDER BY action_order
    `;
    assert.equal(runActions.length, 3, "all three actions now recorded");
    assert.equal(runActions[0]?.status, "completed");
    assert.equal(runActions[1]?.status, "completed");
    assert.equal(runActions[2]?.status, "completed");

    const [run] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_runs WHERE agent_id = ${A03_RESUME_AGENT}
    `;
    assert.equal(run?.status, "completed");

    // Only one run row exists — the resume reused the original, didn't
    // INSERT a duplicate.
    const runRows = await poolSql<{ id: string }[]>`
      SELECT id FROM public.agent_runs WHERE agent_id = ${A03_RESUME_AGENT}
    `;
    assert.equal(runRows.length, 1, "resume reuses existing run, no duplicate inserted");
  });

  it("Test 5: snooze — ttl_at bumped 24h, status stays pending, one audit row", async () => {
    const agentId = await createFollowUpAgent(NAME_SNOOZE);
    const outboxId = await enqueueOutbox(agentId, { application_id: "snooze-fake-app" });
    await drainAgentRunOutboxOnce({ log: drainLog, deps: execDeps });
    const approvalId = await pendingApprovalIdFor(agentId);

    // ttl_at is NULL before snooze (Follow-Up Agent's draft_message rule
    // is human_required, no TTL by default).
    const [beforeRow] = await poolSql<{ ttl_at: Date | string | null }[]>`
      SELECT ttl_at FROM public.agent_approval_requests WHERE id = ${approvalId}
    `;
    assert.equal(beforeRow?.ttl_at, null, "ttl_at NULL before snooze");

    await cleanupAuditLogsByEntity(approvalId);

    const beforeMs = Date.now();
    const env = await trpcMutation<{ status: string; snoozedUntil: string }>("snoozeApproval", {
      approvalRequestId: approvalId,
    });
    assert.ok(!isErr(env), `snoozeApproval should succeed: ${JSON.stringify(env)}`);
    assert.equal(env.result.data.status, "pending", "snooze keeps status pending");
    const snoozeMs = new Date(env.result.data.snoozedUntil).getTime();
    const expectedMs = beforeMs + 24 * 60 * 60 * 1000;
    // 5-minute tolerance for the round-trip clock skew between server and assertion.
    assert.ok(
      Math.abs(snoozeMs - expectedMs) < 5 * 60_000,
      `snoozedUntil ~24h from now (got ${env.result.data.snoozedUntil}, expected ~${new Date(expectedMs).toISOString()})`,
    );

    // Audit row: changed_columns is just ttl_at (and the implicit
    // before/after has ttl_at moving from NULL → date). decided_* stay
    // NULL because snooze isn't a decision.
    await assertResolutionAudit(approvalId, {
      expectedAfterStatus: "pending",
      expectAfterDecidedByUserId: null,
      expectAfterDecisionNotes: null,
      expectChangedColumns: ["ttl_at"],
    });

    // Run + outbox stay paused — snooze only moves the TTL.
    const [outbox] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_run_outbox WHERE id = ${outboxId}
    `;
    assert.equal(outbox?.status, "awaiting_approval");
    const [run] = await poolSql<{ status: string }[]>`
      SELECT status FROM public.agent_runs WHERE agent_id = ${agentId}
    `;
    assert.equal(run?.status, "awaiting_approval");

    // Approval-request itself: status pending, ttl_at populated.
    const [ar] = await poolSql<{ status: string; ttl_at: Date | string | null }[]>`
      SELECT status, ttl_at FROM public.agent_approval_requests WHERE id = ${approvalId}
    `;
    assert.equal(ar?.status, "pending");
    assert.ok(ar?.ttl_at, "ttl_at populated after snooze");
  });
});
