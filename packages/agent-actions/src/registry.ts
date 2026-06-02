import type { ActionConfig } from "@hireops/db";
import type { ActionExecutor } from "./types";
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

export type ActionTypeKey = keyof typeof actionExecutorRegistry;
