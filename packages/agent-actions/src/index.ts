/**
 * @hireops/agent-actions — AGENT-02.
 *
 * Stub action executors for the agent run-time. The 7 action types
 * locked in the AGENT-01a design session each have an executor that
 * narrows config via the discriminated union, returns a typed stub
 * output marked `_stub: true` + `_ticket: 'AGENT-02'`, and never
 * actually does its real-world side effect (no LLM calls, no calendar
 * writes, no email sends, no DB writes). The worker contract (uniform
 * params + return shape) is what's load-bearing in this ticket; the
 * real implementations land in AGENT-04+.
 */

export {
  type ActionExecutor,
  type ActionExecutorParams,
  type ActionResult,
  ActionConfigMismatchError,
} from "./types";

export { actionExecutorRegistry, type ActionTypeKey } from "./registry";

export { bridgeActionConfig } from "./bridge";
