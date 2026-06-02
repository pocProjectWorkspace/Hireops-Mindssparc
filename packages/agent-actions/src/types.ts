import type { ActionConfig } from "@hireops/db";

/**
 * Parameters passed to every action executor.
 *
 * `config` is the discriminated-union ActionConfig from
 * @hireops/db/zod/agent-configs — each executor narrows by checking
 * `config.type` and throws on mismatch (defensive — the worker
 * dispatches via action_type so a mismatch indicates a registry bug).
 *
 * `previousActionOutputs` is keyed by `action_order` (integer) so an
 * executor that consumes a prior step's output (e.g.
 * create_calendar_event reading propose_calendar_slots' proposed_slots)
 * can do so without re-reading from the DB. Values are whatever the
 * prior executor wrote to ActionResult.output.
 *
 * `triggerContext` is the same jsonb the worker reads from
 * agent_run_outbox.trigger_context — the snapshot of "what fired this".
 */
export interface ActionExecutorParams {
  tenantId: string;
  runId: string;
  runActionId: string;
  agentId: string;
  config: ActionConfig;
  triggerContext: Record<string, unknown>;
  previousActionOutputs: Record<number, unknown>;
}

/**
 * Uniform executor return shape.
 *
 * `output` is persisted to agent_run_actions.output and is what
 * downstream actions read via previousActionOutputs[action_order].
 * Shape is executor-specific; AGENT-02 stubs include `_stub: true` and
 * `_ticket: 'AGENT-02'` honesty markers so a quick grep / DB query
 * can distinguish stub runs from real runs once the real executors land.
 *
 * `costMicros` accumulates onto agent_runs.cost_micros. Defaults to 0n
 * when omitted. Real AI executors populate this from the matching
 * ai_usage_logs row.
 *
 * `requiresApproval` toggles the awaiting_approval path in the worker.
 * AGENT-02 stubs always return false so the smoke runs end-to-end
 * without AGENT-03's approval-resolution loop. The code path exists
 * and is type-checked; the stubs just never hit it.
 */
export interface ActionResult {
  output: unknown;
  costMicros?: bigint;
  requiresApproval?: boolean;
}

export type ActionExecutor = (params: ActionExecutorParams) => Promise<ActionResult>;

/**
 * Thrown by an executor when the config discriminator doesn't match.
 * The worker treats this as terminal (no retry) — same shape as a
 * ZodError parse failure on the action_config jsonb.
 */
export class ActionConfigMismatchError extends Error {
  constructor(executor: string, gotType: string) {
    super(`${executor} executor received config of type=${gotType}`);
    this.name = "ActionConfigMismatchError";
  }
}
