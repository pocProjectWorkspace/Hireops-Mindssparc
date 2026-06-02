import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * notify_recruiter — STUB.
 *
 * Real implementation (AGENT-04+) will resolve the application's
 * assigned recruiter via applications.assigned_recruiter_membership_id,
 * render the body from template_prompt_id, and dispatch via either
 * notification_outbox (channel='email') or a still-to-design in-portal
 * notification path (channel='in_portal').
 *
 * AGENT-02 stub returns a placeholder recipient_user_id.
 */
export const notifyRecruiterExecutor: ActionExecutor = async ({ config }) => {
  if (config.type !== "notify_recruiter") {
    throw new ActionConfigMismatchError("notify_recruiter", config.type);
  }
  return {
    output: {
      _stub: true,
      _ticket: "AGENT-02",
      template_prompt_id: config.template_prompt_id,
      channel: config.channel,
      recipient_user_id: "<stub>",
    },
    costMicros: 0n,
    requiresApproval: false,
  };
};
