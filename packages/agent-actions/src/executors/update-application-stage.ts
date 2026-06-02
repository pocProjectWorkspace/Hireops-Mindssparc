import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * update_application_stage — STUB.
 *
 * Real implementation (AGENT-04+) will mirror the existing
 * advanceApplication / rejectApplication mutations: UPDATE
 * applications.current_stage + INSERT application_state_transitions +
 * write an api_audit_logs row tagged 'agent_update_application_stage'.
 * The reason text is rendered from reason_template_id.
 *
 * AGENT-02 stub returns updated: false so a row that flows through
 * here is obviously a stub run. The application row is not touched.
 */
export const updateApplicationStageExecutor: ActionExecutor = async ({ config }) => {
  if (config.type !== "update_application_stage") {
    throw new ActionConfigMismatchError("update_application_stage", config.type);
  }
  return {
    output: {
      _stub: true,
      _ticket: "AGENT-02",
      target_stage: config.target_stage,
      reason_template_id: config.reason_template_id,
      previous_stage: "<stub>",
      updated: false,
    },
    costMicros: 0n,
    requiresApproval: false,
  };
};
