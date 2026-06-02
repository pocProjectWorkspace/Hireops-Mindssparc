import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * send_message — STUB.
 *
 * Real implementation (AGENT-04+) will INSERT into notification_outbox
 * with the channel + outbox_kind discriminator + the draft body pulled
 * from the previous draft_message action's output. AGENT-02 stub
 * returns sent: false to make it unmistakable that nothing was actually
 * dispatched.
 *
 * AGENT-03 flipped `requiresApproval: true` so the awaiting_approval
 * worker branch + approval-resolution + resume cycle can be exercised
 * end-to-end. The output is still the AGENT-02 stub shape — the
 * `_originally_set_by` marker records that the stub itself dates from
 * AGENT-02 and the approval-requiring flip happened in AGENT-03.
 *
 * Note: `requires_approval` in the config is HR-set on agent setup,
 * distinct from this `requiresApproval: true` on the executor return,
 * which is the executor-side signal that the action shouldn't proceed
 * without a resolved agent_approval_request. The per-action
 * approval_mode (auto / human_required / human_optional) on
 * agent_approval_rules is yet a third layer — combined, the worker
 * gates on the rule's mode (`auto` short-circuits the executor signal).
 */
export const sendMessageExecutor: ActionExecutor = async ({ config }) => {
  if (config.type !== "send_message") {
    throw new ActionConfigMismatchError("send_message", config.type);
  }
  return {
    output: {
      _stub: true,
      _ticket: "AGENT-02",
      _originally_set_by: "AGENT-02",
      channel: config.channel,
      recipient_email: "<stub>",
      outbox_kind: config.outbox_kind,
      sent: false,
      would_send_to: "<stub>",
    },
    costMicros: 0n,
    requiresApproval: true,
  };
};
