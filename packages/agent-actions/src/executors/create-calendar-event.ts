import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * create_calendar_event — STUB.
 *
 * Real implementation (AGENT-04+) will read the slot chosen by the
 * approver from the approval_request, call Google Calendar to create
 * the event, and write the event_id back. AGENT-02 stub fabricates a
 * deterministic event_id keyed on runId so consumers can correlate.
 *
 * source_action_ref points at the earlier propose_calendar_slots
 * action; AGENT-02 stub doesn't actually look up the proposed slots
 * because no slot has been chosen yet — that's the approval surface.
 */
export const createCalendarEventExecutor: ActionExecutor = async ({ runId, config }) => {
  if (config.type !== "create_calendar_event") {
    throw new ActionConfigMismatchError("create_calendar_event", config.type);
  }
  return {
    output: {
      _stub: true,
      _ticket: "AGENT-02",
      panel_id: config.panel_id,
      source_action_ref: config.source_action_ref,
      event_id: `stub-evt-${runId}`,
      invitees: [],
    },
    costMicros: 0n,
    requiresApproval: false,
  };
};
