/**
 * @hireops/agent-actions — AGENT-02, FOLLOWUP-01.
 *
 * Action executors for the agent run-time. The 7 action types locked in
 * the AGENT-01a design session each have an executor that narrows config
 * via the discriminated union and returns a uniform result shape.
 *
 * `draft_message` and `send_message` are REAL as of FOLLOWUP-01 — they
 * perform side effects (LLM call, notification_outbox enqueue) through
 * the injected `ExecutorDeps` ports. The remaining five are still
 * AGENT-02 stubs returning `_stub: true` + `_ticket: 'AGENT-02'`; the
 * calendar pair is deferred to the onboarding window per the week-7
 * contingency decision (see HANDOVER §0).
 *
 * The package stays free of `@hireops/db`'s client and of
 * `@hireops/ai-client` — behaviour arrives via ports, so this remains a
 * pure, DB-free, unit-testable package (HANDOVER #101).
 */

export {
  type ActionExecutor,
  type ActionExecutorParams,
  type ActionResult,
  type ActionExecutorCapability,
  type ExecutorDeps,
  type ApplicationContext,
  type AIDraftRequest,
  type AIDraftResult,
  type EnqueueEmailRequest,
  ActionConfigMismatchError,
  MissingTriggerContextError,
} from "./types";

export {
  PROMPT_REGISTRY,
  resolvePromptTemplate,
  UnknownPromptTemplateError,
  firstName,
  humaniseStage,
  type PromptTemplate,
  type MessageTone,
} from "./prompts";

export {
  actionExecutorRegistry,
  actionExecutorCapabilities,
  assertRuleAttachable,
  IncompatibleApprovalRuleError,
  type ActionTypeKey,
} from "./registry";

export { bridgeActionConfig } from "./bridge";
