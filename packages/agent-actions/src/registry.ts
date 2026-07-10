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
 *   - draft_message: CAPABLE (FOLLOWUP-01 flip; was false). The drain
 *     executes an action and THEN evaluates the gate, and on approval
 *     resumes without re-executing. That ordering is only sound for a
 *     PURE action. draft_message computes text and writes nothing but
 *     ai_usage_logs, so it is the correct gate point: the recruiter
 *     approves (or edits) the draft, and the effectful send_message
 *     that follows has not run yet. See the doc-block on
 *     ./executors/draft-message.ts. Logged as HANDOVER #111.
 *   - send_message: capable, but no longer the curated gate point.
 *     Sending external comms reads like the paradigmatic "let a human
 *     see this first" action, and AGENT-03 flipped it for that reason —
 *     but gating it meant the email was enqueued BEFORE the approval
 *     was granted (the executor runs, then the gate opens). The
 *     capability stays `true` so an operator who understands the
 *     execute-then-gate ordering can still attach a rule, and so
 *     existing agents keep validating; the curated Follow-Up agent now
 *     pins this action to 'auto' and gates the draft instead.
 *   - propose_calendar_slots: CAPABLE (AGENT-04b flip). The slots a
 *     Scheduling agent proposes are surfaced to the candidate; gating
 *     them is a coherent product choice and a Scheduling agent's HR
 *     configuration is the natural place for that gate. Stays
 *     attachable on `auto` if HR wants the agent to propose autonomously.
 *   - create_calendar_event: CAPABLE (AGENT-04b flip). Creating an event
 *     fires invites to candidates and panel members; same gate-point
 *     logic as send_message — the action has a real-world side effect
 *     visible outside the platform.
 *   - everything else: not capable. Their executors never return
 *     `requiresApproval: true`; attaching a human-gate rule would
 *     produce a silent never-firing gate. Specific reasons:
 *       - update_application_stage / notify_recruiter /
 *         create_audit_entry: internal-only writes; gate point lives
 *         on whichever externally-visible action precedes them.
 *
 * Capability is permissive: capable=true ALLOWS gating, doesn't force
 * it (auto mode stays valid). capable=false forecloses gating
 * entirely (assertRuleAttachable rejects human_required/optional rules
 * at attach time).
 *
 * Changing a row from `false` to `true` is a real product decision
 * and warrants a HANDOVER entry (the gate appearing in HR's approval
 * queue changes their workflow). The two AGENT-04b flips above are
 * logged as HANDOVER #108.
 */
export const actionExecutorCapabilities: Record<ActionConfig["type"], ActionExecutorCapability> = {
  draft_message: { requiresApprovalCapable: true },
  send_message: { requiresApprovalCapable: true },
  propose_calendar_slots: { requiresApprovalCapable: true },
  create_calendar_event: { requiresApprovalCapable: true },
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
