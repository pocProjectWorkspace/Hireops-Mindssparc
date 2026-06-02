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
 * Note: `requires_approval` is a config-level flag (HR-set), distinct
 * from the per-action approval_mode in agent_approval_rules. AGENT-02
 * always returns requiresApproval: false regardless — the
 * awaiting_approval path is exercised by AGENT-03 once the resolution
 * endpoint exists.
 */
export const sendMessageExecutor: ActionExecutor = async ({ config }) => {
  if (config.type !== "send_message") {
    throw new ActionConfigMismatchError("send_message", config.type);
  }
  return {
    output: {
      _stub: true,
      _ticket: "AGENT-02",
      channel: config.channel,
      recipient_email: "<stub>",
      outbox_kind: config.outbox_kind,
      sent: false,
      would_send_to: "<stub>",
    },
    costMicros: 0n,
    requiresApproval: false,
  };
};
