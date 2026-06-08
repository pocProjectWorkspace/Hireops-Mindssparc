import type { ActionConfig } from "@hireops/db";
import type { ActionExecutor, ActionExecutorCapability } from "./types";
import { draftMessageExecutor } from "./executors/draft-message";
import { sendMessageExecutor } from "./executors/send-message";
import { proposeCalendarSlotsExecutor } from "./executors/propose-calendar-slots";
import { createCalendarEventExecutor } from "./executors/create-calendar-event";
import { updateApplicationStageExecutor } from "./executors/update-application-stage";
import { notifyRecruiterExecutor } from "./executors/notify-recruiter";
import { createAuditEntryExecutor } from "./executors/create-audit-entry";

/**
 * Action-type → executor dispatch map.
 *
 * Keys MUST exactly match the values in the agent_actions.action_type
 * CHECK constraint and the discriminator literals on ActionConfigSchema
 * — the discriminated union and this map are kept in lockstep, and
 * adding a new action_type means updating all three at once.
 *
 * The worker reads agent_actions.action_type, looks up the executor
 * here, and throws a defensive error if the lookup misses (which
 * shouldn't be possible given the CHECK constraint upstream).
 */
export const actionExecutorRegistry: Record<ActionConfig["type"], ActionExecutor> = {
  draft_message: draftMessageExecutor,
  send_message: sendMessageExecutor,
  propose_calendar_slots: proposeCalendarSlotsExecutor,
  create_calendar_event: createCalendarEventExecutor,
  update_application_stage: updateApplicationStageExecutor,
  notify_recruiter: notifyRecruiterExecutor,
  create_audit_entry: createAuditEntryExecutor,
};

/**
 * Per-action-type approval capability — the static declaration the
 * rule-attachment validator (see assertRuleAttachable) consults to
 * reject misconfigured approval rules. See ActionExecutorCapability
 * doc in ./types.ts for the full capability/rule-mode interaction
 * matrix and the open-question #30 resolution.
 *
 * Keep this map in lockstep with actionExecutorRegistry above —
 * adding a new action_type means updating both. The shared
 * `Record<ActionConfig["type"], …>` typing makes a missing entry a
 * compile error, not a silent omission.
 *
 * Today's capability assignments:
 *   - send_message: capable. Sending external comms is the
 *     paradigmatic "I should let a human see this before it goes"
 *     action and is the one AGENT-03 flipped to exercise the gate
 *     end-to-end.
 *   - everything else: not capable. Their executors never return
 *     `requiresApproval: true`; attaching a human-gate rule would
 *     produce a silent never-firing gate. Specific reasons:
 *       - draft_message: drafting is pure compute; the gate point is
 *         on the send_message that follows.
 *       - propose_calendar_slots / create_calendar_event: capability
 *         decision deferred to the scheduling-agent ticket; revisit
 *         when scheduling lands.
 *       - update_application_stage / notify_recruiter /
 *         create_audit_entry: internal-only writes; gate point lives
 *         on whichever externally-visible action precedes them.
 *
 * Changing a row from `false` to `true` is a real product decision
 * and warrants a HANDOVER entry (the gate appearing in HR's approval
 * queue changes their workflow).
 */
export const actionExecutorCapabilities: Record<ActionConfig["type"], ActionExecutorCapability> = {
  draft_message: { requiresApprovalCapable: false },
  send_message: { requiresApprovalCapable: true },
  propose_calendar_slots: { requiresApprovalCapable: false },
  create_calendar_event: { requiresApprovalCapable: false },
  update_application_stage: { requiresApprovalCapable: false },
  notify_recruiter: { requiresApprovalCapable: false },
  create_audit_entry: { requiresApprovalCapable: false },
};

export type ActionTypeKey = keyof typeof actionExecutorRegistry;

/**
 * Rule-attachment validation error. Thrown by `assertRuleAttachable`
 * when a caller tries to attach a human-gate approval rule
 * (mode='human_required' or 'human_optional') to an action whose
 * executor declares `requiresApprovalCapable: false`.
 *
 * Separate error class from ActionConfigMismatchError because the
 * call sites differ — this fires at rule-create/attach time (router
 * procedures), not at executor-dispatch time (worker).
 */
export class IncompatibleApprovalRuleError extends Error {
  constructor(actionType: string, mode: string) {
    super(
      `Approval rule mode '${mode}' cannot attach to action type '${actionType}' — its executor declares requiresApprovalCapable=false and the gate would never fire`,
    );
    this.name = "IncompatibleApprovalRuleError";
  }
}

/**
 * Asserts a (action_type, approval_mode) pair is attachable. Throws
 * IncompatibleApprovalRuleError on the misconfiguration; otherwise
 * returns void. Auto mode is always permitted (a no-op gate on a
 * non-capable action is harmless). Unknown action_type throws because
 * the registry is the source of truth — an unrecognised type means a
 * desync between the DB CHECK constraint, the discriminated union,
 * and this map.
 */
export function assertRuleAttachable(actionType: string, approvalMode: string): void {
  if (approvalMode === "auto") return;
  if (approvalMode !== "human_required" && approvalMode !== "human_optional") {
    throw new IncompatibleApprovalRuleError(actionType, approvalMode);
  }
  const capability = (actionExecutorCapabilities as Record<string, ActionExecutorCapability>)[
    actionType
  ];
  if (!capability) {
    throw new IncompatibleApprovalRuleError(actionType, approvalMode);
  }
  if (!capability.requiresApprovalCapable) {
    throw new IncompatibleApprovalRuleError(actionType, approvalMode);
  }
}
