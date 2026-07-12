/**
 * Drains pending agent_run_outbox rows (AGENT-02, AGENT-03 resume).
 *
 * Mirror of ai-score-drain's SKIP LOCKED batch pattern with the
 * multi-action loop layered on top.
 *
 * Per outbox row:
 *
 *   1. Claim → status='processing', set locked_until = now + 5min,
 *      attempt_count += 1.
 *   2. AGENT-03 resume probe — does an in-progress agent_runs row
 *      already exist for this (tenant_id, agent_id) whose
 *      trigger_context matches? If yes, this is a resume — reuse the
 *      existing run row and flip it to 'running'. If no, INSERT a fresh
 *      agent_runs row.
 *   3. Fetch agent_actions ordered by action_order ASC, plus
 *      agent_approval_rules keyed by action_id, plus existing
 *      agent_run_actions keyed by action_order (the resume map).
 *   4. For each action:
 *        - If a run_action already exists for (run_id, action_order):
 *          - 'completed' → carry forward its output to
 *             previousActionOutputs and skip executor dispatch.
 *          - 'awaiting_approval' → should not happen on resume because
 *             approval resolution flips it to 'completed' or 'failed'
 *             before re-queueing. Treated as failed (defensive).
 *          - 'failed' → propagate as a terminal failure.
 *        - Otherwise (no row or 'pending'): INSERT agent_run_actions
 *          ('running', input snapshot) and dispatch the executor.
 *        - bridgeActionConfig(action.action_type, action.action_config)
 *          → ActionConfigSchema.parse — ZodError is terminal (no retry).
 *        - If result.requiresApproval: atomic 4-row transition
 *          (insert approval_request + update run_action + update run +
 *          update outbox) via poolSql.begin so callers never see an
 *          inconsistent (outbox running but run awaiting) state. Return
 *          early — the approval-resolution endpoint re-queues the row.
 *        - Else: mark run_action 'completed', record output, continue.
 *   5. All actions completed → mark run + outbox 'completed'.
 *
 * Idempotent re-execution invariant: a re-queued outbox row sees the
 * same agent_actions in the same order. Completed run_actions are
 * recognised by (run_id, action_order) and skipped — the executor is
 * never invoked twice for the same action. Approved-with-edit replaces
 * agent_run_actions.output before the re-queue, so the worker reads the
 * edited version when populating previousActionOutputs for downstream
 * actions.
 *
 * Failure mode (single attempt, no retry — same shape as ZodError
 * terminal in ai-score-drain):
 *   - Any throw inside the per-row work flips outbox → 'failed' with
 *     last_error set, and (if a run row was created OR resumed) flips
 *     that run → 'failed' with the same error message. attempt_count
 *     tracks retry posture for future use; we don't actually retry.
 */

import { randomUUID } from "node:crypto";
import { sql as poolSql, type ActionConfig } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import {
  actionExecutorRegistry,
  bridgeActionConfig,
  type ExecutorDeps,
} from "@hireops/agent-actions";
import { createExecutorDeps } from "./agent-executor-deps";

export interface AgentDrainOpts {
  batchSize?: number;
  workerId?: string;
  log: Logger;
  /**
   * Ports handed to executors (DB reads, LLM calls, outbox enqueue).
   * Defaults to the real service_role-backed implementations; tests
   * inject fakes so `@hireops/agent-actions` stays unit-testable and CI
   * never burns tokens.
   */
  deps?: ExecutorDeps;
}

interface ClaimedOutbox {
  id: string;
  tenant_id: string;
  agent_id: string;
  trigger_context: Record<string, unknown>;
}

interface ActionRow {
  id: string;
  action_order: number;
  action_type: string;
  action_config: Record<string, unknown>;
}

interface ApprovalRuleRow {
  action_id: string;
  approval_mode: string;
  approver_role: string | null;
  approver_user_id: string | null;
}

// Agent runs do multiple writes per row (run + N run_actions + maybe
// approval_request); keep the batch size small so a long-running row
// doesn't hog the lock window.
const DEFAULT_BATCH = 1;

export async function drainAgentRunOutboxOnce(opts: AgentDrainOpts): Promise<{
  claimed: number;
  completed: number;
  awaiting: number;
  failed: number;
}> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const workerId = opts.workerId ?? `agent-run-${randomUUID().slice(0, 8)}`;
  const log = opts.log;
  const deps = opts.deps ?? createExecutorDeps();

  const rows = await poolSql<ClaimedOutbox[]>`
    UPDATE public.agent_run_outbox
    SET status = 'processing',
        started_at = now(),
        locked_until = now() + INTERVAL '5 minutes',
        attempt_count = attempt_count + 1
    WHERE id IN (
      SELECT id FROM public.agent_run_outbox
      WHERE status = 'pending'
        AND (locked_until IS NULL OR locked_until < now())
      ORDER BY enqueued_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, agent_id, trigger_context
  `;

  if (rows.length === 0) {
    return { claimed: 0, completed: 0, awaiting: 0, failed: 0 };
  }

  let completed = 0;
  let awaiting = 0;
  let failed = 0;

  for (const outbox of rows) {
    const child = log.child({
      agent_run_outbox_id: outbox.id,
      tenant_id: outbox.tenant_id,
      agent_id: outbox.agent_id,
      worker_id: workerId,
    });

    let createdRunId: string | null = null;
    try {
      const outcome = await processOutboxRow(outbox, child, deps, (id) => {
        createdRunId = id;
      });
      if (outcome.terminal === "completed") completed += 1;
      else awaiting += 1;
    } catch (err) {
      failed += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      await poolSql`
        UPDATE public.agent_run_outbox
        SET status = 'failed', last_error = ${errMsg}, completed_at = now()
        WHERE id = ${outbox.id}
      `;
      if (createdRunId !== null) {
        await poolSql`
          UPDATE public.agent_runs
          SET status = 'failed', error = ${errMsg}, completed_at = now()
          WHERE id = ${createdRunId}
        `;
      }
      child.error({ err: errMsg }, "agent_run.failed");
    }
  }

  return { claimed: rows.length, completed, awaiting, failed };
}

interface ProcessOutcome {
  runId: string;
  terminal: "completed" | "awaiting_approval";
}

async function processOutboxRow(
  outbox: ClaimedOutbox,
  log: Logger,
  deps: ExecutorDeps,
  notifyRunCreated: (runId: string) => void,
): Promise<ProcessOutcome> {
  // AGENT-03 resume probe — does an in-progress run already exist for
  // this outbox row? Approval-resolution flips the run from
  // 'awaiting_approval' → 'running' before re-queueing the outbox, so
  // we look for either status. Match on trigger_context to disambiguate
  // when an agent has multiple concurrent runs. JSONB equality is fine
  // here — the trigger_context on agent_runs was written from the same
  // outbox row's jsonb, so byte-for-byte equality holds.
  const triggerCtxJson = JSON.stringify(outbox.trigger_context);
  const existingRuns = await poolSql<{ id: string; status: string; cost_micros: string }[]>`
    SELECT id, status, cost_micros::text AS cost_micros
    FROM public.agent_runs
    WHERE tenant_id = ${outbox.tenant_id}
      AND agent_id = ${outbox.agent_id}
      AND status IN ('running', 'awaiting_approval')
      AND trigger_context = ${triggerCtxJson}::jsonb
    ORDER BY triggered_at DESC
    LIMIT 1
  `;

  // ROBUST-01 Fix 1 — poisoned-resume guard.
  //
  // A resume is re-queued by approval-resolution, which flips the run
  // 'awaiting_approval' → 'running' BEFORE it sets the outbox back to
  // 'pending'. So a genuine resume candidate is 'running' here. If we
  // instead match a candidate that is still 'awaiting_approval' with a
  // still-pending approval request, this claimed outbox row is NOT a
  // resume — it's a duplicate re-enqueue for the same (agent, trigger
  // context) whose original run is legitimately paused (this happens when
  // the stage_stale scanner re-fires after a dedup marker was wiped).
  //
  // The old behaviour flipped the paused run to 'running', walked its
  // actions, hit the run_action still in 'awaiting_approval', threw
  // "resolution path inconsistent", and FAILED both the outbox row and
  // the paused run — destroying a legitimately pending approval (incl.
  // the seeded demo run). Instead: terminate THIS outbox row as a
  // duplicate and leave the paused run + its approval untouched.
  const matched = existingRuns.length > 0 ? existingRuns[0] : undefined;
  if (matched && matched.status === "awaiting_approval") {
    const pendingApprovals = await poolSql<{ id: string }[]>`
      SELECT id FROM public.agent_approval_requests
      WHERE tenant_id = ${outbox.tenant_id}
        AND run_id = ${matched.id}
        AND status = 'pending'
      LIMIT 1
    `;
    if (pendingApprovals.length > 0 && pendingApprovals[0]) {
      // No dedicated 'skipped' status exists in the CHECK constraint
      // (pending/processing/awaiting_approval/completed/failed) and this
      // is not a failure, so the least-invasive terminal representation
      // without a migration is 'completed' plus a duplicate_of marker on
      // last_error. The run + approval are deliberately not touched.
      await poolSql`
        UPDATE public.agent_run_outbox
        SET status = 'completed',
            completed_at = now(),
            last_error = ${`duplicate_of run ${matched.id} (awaiting_approval; approval pending)`}
        WHERE id = ${outbox.id}
      `;
      log.info(
        {
          run_id: matched.id,
          duplicate_outbox_id: outbox.id,
          approval_request_id: pendingApprovals[0].id,
        },
        "agent_run_drain.duplicate_pending_skipped",
      );
      return { runId: matched.id, terminal: "completed" };
    }
  }

  let runId: string;
  let totalCostMicros: bigint;
  if (existingRuns.length > 0 && existingRuns[0]) {
    runId = existingRuns[0].id;
    totalCostMicros = BigInt(existingRuns[0].cost_micros);
    // Defensive: ensure the run is in 'running' (approval-resolution
    // already does this, but a worker that loses + regains a lock would
    // benefit from idempotent state).
    await poolSql`
      UPDATE public.agent_runs SET status = 'running' WHERE id = ${runId}
    `;
    notifyRunCreated(runId);
    log.info({ run_id: runId }, "agent_run.resumed");
  } else {
    const [runRow] = await poolSql<{ id: string }[]>`
      INSERT INTO public.agent_runs (
        tenant_id, agent_id, triggered_by, triggered_at,
        trigger_context, status
      ) VALUES (
        ${outbox.tenant_id}, ${outbox.agent_id}, 'system', now(),
        ${triggerCtxJson}::jsonb, 'running'
      )
      RETURNING id
    `;
    if (!runRow) throw new Error("agent_runs insert returned no row");
    runId = runRow.id;
    totalCostMicros = 0n;
    notifyRunCreated(runId);
  }

  const actions = await poolSql<ActionRow[]>`
    SELECT id, action_order, action_type, action_config
    FROM public.agent_actions
    WHERE tenant_id = ${outbox.tenant_id} AND agent_id = ${outbox.agent_id}
    ORDER BY action_order ASC
  `;

  const rules = await poolSql<ApprovalRuleRow[]>`
    SELECT action_id, approval_mode, approver_role, approver_user_id
    FROM public.agent_approval_rules
    WHERE tenant_id = ${outbox.tenant_id} AND agent_id = ${outbox.agent_id}
  `;
  const ruleByAction = new Map(rules.map((r) => [r.action_id, r]));

  // AGENT-03 resume map — which run_actions already exist for this run?
  // Keyed by action_order so the per-action loop can look up by the
  // position it's iterating. Output is the already-recorded payload
  // (either the original or the approved-with-edit replacement).
  interface ExistingRunActionRow {
    id: string;
    action_order: number;
    status: string;
    output: unknown;
    error: string | null;
  }
  const existingRunActions = await poolSql<ExistingRunActionRow[]>`
    SELECT id, action_order, status, output, error
    FROM public.agent_run_actions
    WHERE tenant_id = ${outbox.tenant_id} AND run_id = ${runId}
  `;
  const runActionByOrder = new Map<number, ExistingRunActionRow>(
    existingRunActions.map((r) => [r.action_order, r]),
  );

  const previousActionOutputs: Record<number, unknown> = {};

  for (const action of actions) {
    const existing = runActionByOrder.get(action.action_order);

    if (existing && existing.status === "completed") {
      // Resume — already done in a prior worker pass (either originally
      // executed, or approved-with-edit replaced the output). Carry
      // forward without re-executing.
      previousActionOutputs[action.action_order] = existing.output;
      continue;
    }
    if (existing && existing.status === "failed") {
      // A prior pass failed this action — propagate. Should not happen
      // in practice because failures terminate the outbox row too, but
      // defensive.
      throw new Error(
        `Run-action ${existing.id} previously failed: ${existing.error ?? "unknown"}`,
      );
    }
    if (existing && existing.status === "awaiting_approval") {
      // Approval-resolution should have flipped this to 'completed' or
      // 'failed' before re-queueing the outbox. Reaching here means the
      // resolution path missed an update — treat as terminal so the
      // run doesn't quietly re-execute the awaiting action.
      throw new Error(
        `Run-action ${existing.id} still awaiting_approval after resume — resolution path inconsistent`,
      );
    }
    // existing && existing.status === 'pending' OR no row at all → execute fresh.

    let runActionId: string;
    if (existing) {
      // Pending row (e.g. left over from an abandoned attempt). Flip to
      // running rather than INSERT — keeps the (run_id, action_order)
      // surface stable for downstream joins.
      await poolSql`
        UPDATE public.agent_run_actions
        SET status = 'running', started_at = now()
        WHERE id = ${existing.id}
      `;
      runActionId = existing.id;
    } else {
      const inputSnapshot = JSON.stringify({
        config: action.action_config,
        triggerContext: outbox.trigger_context,
      });
      const [runActionRow] = await poolSql<{ id: string }[]>`
        INSERT INTO public.agent_run_actions (
          tenant_id, run_id, action_id, action_order, status, started_at, input
        ) VALUES (
          ${outbox.tenant_id}, ${runId}, ${action.id}, ${action.action_order},
          'running', now(), ${inputSnapshot}::jsonb
        )
        RETURNING id
      `;
      if (!runActionRow) throw new Error("agent_run_actions insert returned no row");
      runActionId = runActionRow.id;
    }

    // Bridge DB column → Zod discriminator. ZodError + ActionConfigMismatchError
    // both bubble up as terminal failures via the outer catch.
    const validated: ActionConfig = bridgeActionConfig(action.action_type, action.action_config);

    const executor = actionExecutorRegistry[validated.type];
    if (!executor) {
      // Unreachable in practice — CHECK constraint upstream + registry's
      // exhaustive Record<ActionConfig["type"], ...> typing. Defensive.
      throw new Error(`No executor registered for action_type ${action.action_type}`);
    }

    const result = await executor({
      tenantId: outbox.tenant_id,
      runId,
      runActionId,
      agentId: outbox.agent_id,
      config: validated,
      triggerContext: outbox.trigger_context,
      previousActionOutputs,
      deps,
    });

    totalCostMicros += result.costMicros ?? 0n;

    // Approval-mode short-circuit: even if the executor wants approval,
    // a rule of approval_mode='auto' on this action means HR explicitly
    // configured it to bypass the gate. Three-layer model documented on
    // the send_message executor.
    const rule = ruleByAction.get(action.id);
    const ruleMode = rule?.approval_mode ?? "auto";
    const gateOpen = result.requiresApproval === true && ruleMode !== "auto";

    if (gateOpen) {
      const approverRole = rule?.approver_role ?? "any_recruiter";
      const outputJson = JSON.stringify(result.output);
      // Atomic 4-row transition. poolSql.begin returns when the BEGIN/COMMIT
      // bracket closes; on throw inside, the bracket ROLLBACKs and the
      // outer catch handles outbox→'failed'.
      await poolSql.begin(async (tx) => {
        const [approvalRow] = await tx<{ id: string }[]>`
          INSERT INTO public.agent_approval_requests (
            tenant_id, run_id, run_action_id, agent_id,
            proposed_action_summary, proposed_action_payload,
            approver_role, status
          ) VALUES (
            ${outbox.tenant_id}, ${runId}, ${runActionId}, ${outbox.agent_id},
            ${`${action.action_type} requires approval`},
            ${outputJson}::jsonb, ${approverRole}, 'pending'
          )
          RETURNING id
        `;
        if (!approvalRow) throw new Error("agent_approval_requests insert returned no row");
        await tx`
          UPDATE public.agent_run_actions
          SET status = 'awaiting_approval',
              output = ${outputJson}::jsonb,
              approval_request_id = ${approvalRow.id}
          WHERE id = ${runActionId}
        `;
        await tx`
          UPDATE public.agent_runs
          SET status = 'awaiting_approval', cost_micros = ${totalCostMicros.toString()}
          WHERE id = ${runId}
        `;
        await tx`
          UPDATE public.agent_run_outbox
          SET status = 'awaiting_approval'
          WHERE id = ${outbox.id}
        `;
      });

      log.info(
        { run_id: runId, action_order: action.action_order, approver_role: approverRole },
        "agent_run.awaiting_approval",
      );
      return { runId, terminal: "awaiting_approval" };
    }

    // Action completed; record output, continue.
    await poolSql`
      UPDATE public.agent_run_actions
      SET status = 'completed', completed_at = now(),
          output = ${JSON.stringify(result.output)}::jsonb
      WHERE id = ${runActionId}
    `;
    previousActionOutputs[action.action_order] = result.output;
  }

  // All actions completed.
  await poolSql`
    UPDATE public.agent_runs
    SET status = 'completed', completed_at = now(),
        cost_micros = ${totalCostMicros.toString()}
    WHERE id = ${runId}
  `;
  await poolSql`
    UPDATE public.agent_run_outbox
    SET status = 'completed', completed_at = now()
    WHERE id = ${outbox.id}
  `;
  log.info({ run_id: runId, actions: actions.length }, "agent_run.completed");
  return { runId, terminal: "completed" };
}
