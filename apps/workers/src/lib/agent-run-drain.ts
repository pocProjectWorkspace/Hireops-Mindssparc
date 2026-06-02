/**
 * Drains pending agent_run_outbox rows (AGENT-02).
 *
 * Mirror of ai-score-drain's SKIP LOCKED batch pattern with the
 * multi-action loop layered on top.
 *
 * Per outbox row:
 *
 *   1. Claim → status='processing', set locked_until = now + 5min,
 *      attempt_count += 1.
 *   2. INSERT agent_runs (status='running', triggered_by='system',
 *      trigger_context = outbox.trigger_context).
 *   3. Fetch agent_actions ordered by action_order ASC, plus
 *      agent_approval_rules keyed by action_id.
 *   4. For each action:
 *        - INSERT agent_run_actions (status='running', input snapshot).
 *        - bridgeActionConfig(action.action_type, action.action_config)
 *          → ActionConfigSchema.parse — ZodError is terminal (no retry).
 *        - executor = actionExecutorRegistry[validated.type]; dispatch
 *          with the uniform params. ActionConfigMismatchError is
 *          terminal (no retry; defensive only — DB CHECK + registry
 *          typing make it unreachable in practice).
 *        - If result.requiresApproval: atomic 4-row transition
 *          (insert approval_request + update run_action + update run +
 *          update outbox) via poolSql.begin so callers never see an
 *          inconsistent (outbox running but run awaiting) state. Return
 *          early — AGENT-03 closes the resume loop.
 *        - Else: mark run_action 'completed', record output, continue.
 *   5. All actions completed → mark run + outbox 'completed'.
 *
 * AGENT-02 stub executors all return requiresApproval: false so the
 * awaiting_approval path exists, is type-checked, and writes the right
 * state if it ever fires — but no test in this ticket exercises a
 * green path through it. AGENT-03 covers that loop end-to-end.
 *
 * Failure mode (single attempt, no retry — same shape as ZodError
 * terminal in ai-score-drain):
 *   - Any throw inside the per-row work flips outbox → 'failed' with
 *     last_error set, and (if a run row was created) flips that run
 *     → 'failed' with the same error message. attempt_count tracks
 *     retry posture for future use; AGENT-02 doesn't actually retry.
 */

import { randomUUID } from "node:crypto";
import { sql as poolSql, type ActionConfig } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { actionExecutorRegistry, bridgeActionConfig } from "@hireops/agent-actions";

export interface AgentDrainOpts {
  batchSize?: number;
  workerId?: string;
  log: Logger;
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
      const outcome = await processOutboxRow(outbox, child, (id) => {
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
  notifyRunCreated: (runId: string) => void,
): Promise<ProcessOutcome> {
  // INSERT agent_runs.
  const [runRow] = await poolSql<{ id: string }[]>`
    INSERT INTO public.agent_runs (
      tenant_id, agent_id, triggered_by, triggered_at,
      trigger_context, status
    ) VALUES (
      ${outbox.tenant_id}, ${outbox.agent_id}, 'system', now(),
      ${JSON.stringify(outbox.trigger_context)}::jsonb, 'running'
    )
    RETURNING id
  `;
  if (!runRow) throw new Error("agent_runs insert returned no row");
  const runId = runRow.id;
  notifyRunCreated(runId);

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

  const previousActionOutputs: Record<number, unknown> = {};
  let totalCostMicros = 0n;

  for (const action of actions) {
    // INSERT agent_run_actions (running).
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
    const runActionId = runActionRow.id;

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
    });

    totalCostMicros += result.costMicros ?? 0n;

    if (result.requiresApproval === true) {
      const rule = ruleByAction.get(action.id);
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

      // TODO(AGENT-03): approval-resolution endpoint will re-queue this
      // outbox row by `UPDATE agent_run_outbox SET status='pending'
      // WHERE id=...`. At that point this worker picks it up again. To
      // resume correctly, the worker would need to detect that some
      // actions are already completed and skip them — that resumption
      // logic is also AGENT-03. AGENT-02 stub executors always set
      // requiresApproval: false so this branch is type-checked but never
      // exercised by tests in this ticket.

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
