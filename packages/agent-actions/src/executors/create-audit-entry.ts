import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * create_audit_entry — STUB.
 *
 * Real implementation (AGENT-04+) will INSERT into audit_logs with
 * action='agent_<event_type>' and a payload rendered from
 * payload_template_id. Used by agents whose only meaningful step is
 * "record that this happened" — e.g. a candidate-qa agent that observed
 * an inbound message and tagged it with no downstream side effect.
 *
 * AGENT-02 stub returns a fabricated audit_id keyed on runId.
 */
export const createAuditEntryExecutor: ActionExecutor = async ({ runId, config }) => {
  if (config.type !== "create_audit_entry") {
    throw new ActionConfigMismatchError("create_audit_entry", config.type);
  }
  return {
    output: {
      _stub: true,
      _ticket: "AGENT-02",
      event_type: config.event_type,
      payload_template_id: config.payload_template_id,
      audit_id: `stub-aud-${runId}`,
    },
    costMicros: 0n,
    requiresApproval: false,
  };
};
