import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * send_message — STUB.
 *
 * Real implementation (AGENT-04b+) will INSERT into notification_outbox
 * with the channel + outbox_kind discriminator + the draft body pulled
 * from the previous draft_message action's output. AGENT-02 stub
 * returns sent: false to make it unmistakable that nothing was actually
 * dispatched.
 *
 * Approval-gate semantics (resolved AGENT-04a, open-question #30):
 *   1. `requiresApproval: true` on this return is the PER-INVOCATION
 *      signal that this particular execution wants to gate. It is the
 *      executor saying "if the rule permits it, please pause here".
 *   2. The STATIC declaration that send_message can ever return that
 *      signal lives in `actionExecutorCapabilities` in ../registry.ts
 *      as `{ requiresApprovalCapable: true }`. That capability is what
 *      the rule-attachment validator (`assertRuleAttachable`) gates on
 *      — attaching a human-gate rule to an action whose capability is
 *      `false` is rejected as misconfiguration.
 *   3. The RUNTIME decision is owned by the approval rule, not by this
 *      executor. The worker bypasses `requiresApproval` entirely when
 *      the rule's mode is 'auto'; only modes 'human_required' /
 *      'human_optional' consult the executor's return.
 *
 * The `_originally_set_by: 'AGENT-02'` marker records the stub's
 * provenance so a future grep / DB query can distinguish "stub from
 * AGENT-02 era" from "real send_message executor (AGENT-04b+)".
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
