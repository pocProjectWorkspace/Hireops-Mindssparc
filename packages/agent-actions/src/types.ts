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
 * `requiresApproval` is the per-invocation signal that THIS particular
 * execution needs to pause for human approval. AGENT-04a resolved the
 * three-layer ambiguity (open-question #30): the field is consulted ONLY
 * when the action's agent_approval_rules row carries mode
 * 'human_required' or 'human_optional'. Rule mode 'auto' bypasses the
 * field entirely. The runtime gating decision is owned by the rule;
 * `requiresApproval` is the executor's per-call signal that the gate
 * should engage if the rule permits it.
 *
 * Each action TYPE'S overall ability to ever return `requiresApproval:
 * true` is declared statically in `actionExecutorCapabilities` (see
 * registry.ts). That static capability is what the rule-attachment
 * validator gates on: a rule of mode 'human_required' or
 * 'human_optional' is only valid when the action type's capability says
 * `requiresApprovalCapable: true`.
 */
export interface ActionResult {
  output: unknown;
  costMicros?: bigint;
  requiresApproval?: boolean;
}

export type ActionExecutor = (params: ActionExecutorParams) => Promise<ActionResult>;

/**
 * Static, per-action-type declaration of approval capability.
 *
 * `requiresApprovalCapable` answers "can an executor of this action
 * type ever return `requiresApproval: true` at runtime?" It is the
 * source of truth that the rule-attachment validator consults when HR
 * (or a curated-create procedure) tries to bind an approval rule to
 * an action.
 *
 * Capability and rule mode interact like this:
 *   - capable=true  + rule mode 'auto'                 → no gate (rule wins)
 *   - capable=true  + rule mode 'human_required'/'_optional' → gate engages on runtime signal
 *   - capable=false + rule mode 'auto'                 → no gate; legal no-op
 *   - capable=false + rule mode 'human_required'/'_optional' → REJECTED at rule-attach time
 *
 * The fourth row is what the guard protects: attaching a human-gate
 * rule to an action whose executor never gates is misconfiguration —
 * the gate would never fire and the rule would mislead the audit.
 */
export interface ActionExecutorCapability {
  requiresApprovalCapable: boolean;
}

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
