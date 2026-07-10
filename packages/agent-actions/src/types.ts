import type { ActionConfig } from "@hireops/db";

/**
 * Snapshot of the application an agent run is about, assembled by the
 * worker and handed to executors that need candidate/req context.
 *
 * Flattened deliberately: executors compose prompt text from these
 * fields and must not need a second query. `daysInStage` is computed
 * worker-side from stage_entered_at so the prompt registry stays free
 * of date arithmetic.
 */
export interface ApplicationContext {
  applicationId: string;
  candidateId: string;
  candidateName: string;
  candidateEmail: string;
  positionTitle: string;
  companyName: string;
  stage: string;
  daysInStage: number;
  /** jd_versions.summary — null when the JD has no summary written yet. */
  jdSummary: string | null;
}

export interface AIDraftRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /** ai_usage_logs.feature discriminator, e.g. "agent_draft_message". */
  feature: string;
}

export interface AIDraftResult {
  text: string;
  costMicros: bigint;
}

export interface EnqueueEmailRequest {
  recipientEmail: string;
  recipientCandidateId: string | null;
  templateKey: string;
  templateData: Record<string, unknown>;
  subject: string | null;
  /**
   * Idempotency key. `notification_outbox` carries a partial UNIQUE on
   * (tenant_id, dedup_key); a duplicate enqueue raises 23505 which the
   * worker-side implementation swallows as "already queued". This is
   * what makes a retried drain pass safe for effectful executors.
   */
  dedupKey: string | null;
}

/**
 * Ports the worker injects into executors.
 *
 * Why injection rather than importing `@hireops/db` / `@hireops/ai-client`
 * directly: `@hireops/db`'s `./client` re-export runs a
 * `DATABASE_URL`-at-import check (HANDOVER #101, open-question #27), and
 * `@hireops/ai-client` transitively imports it. `packages/agent-actions`
 * deep-imports only `@hireops/db/src/zod/*` precisely to stay a pure,
 * DB-free, unit-testable package. Threading behaviour through ports
 * preserves that, and matches the pluggable-factory idiom already used
 * for KMS / Storage / Email / AIClient.
 *
 * Stub executors ignore `deps` entirely.
 */
export interface ExecutorDeps {
  loadApplicationContext(tenantId: string, applicationId: string): Promise<ApplicationContext>;
  draftWithAI(tenantId: string, req: AIDraftRequest): Promise<AIDraftResult>;
  enqueueEmail(tenantId: string, req: EnqueueEmailRequest): Promise<{ outboxId: string }>;
}

/**
 * Thrown when an executor needs a field the trigger context didn't
 * carry (e.g. `application_id` on a stage_stale run). Terminal — a
 * malformed trigger context will not fix itself on retry.
 */
export class MissingTriggerContextError extends Error {
  constructor(executor: string, field: string) {
    super(`${executor} executor requires triggerContext.${field}`);
    this.name = "MissingTriggerContextError";
  }
}

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
  /** Injected ports — see ExecutorDeps. Stub executors ignore this. */
  deps: ExecutorDeps;
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
