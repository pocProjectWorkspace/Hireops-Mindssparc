import {
  ActionConfigMismatchError,
  MissingTriggerContextError,
  type ActionExecutor,
} from "../types";

/**
 * propose_calendar_slots — REAL (PC-8).
 *
 * Asks the injected `proposeInterviewSlots` port for the panel's common free
 * slots. The worker answers it from HireOps' own availability (panellist
 * weekly windows − exceptions − existing interviews, inside the tenant's
 * scheduling settings) — the SAME function the recruiter's "Find common
 * slots" button calls, so an agent and a human can never disagree about when
 * a panel is free. No external calendar is read (M365 / Google need client IT
 * and are out of scope); the output says so in `source`.
 *
 * The output CONTRACT is unchanged for downstream consumers
 * (create_calendar_event reads `proposed_slots[]` of {start, end} ISO
 * strings, plus `panel_id` and `duration_minutes`); the `_stub` / `_ticket`
 * honesty markers are gone because nothing here is fabricated any more. An
 * empty `proposed_slots` is an honest answer, not a failure — `empty_reason`
 * says why, and the recruiter is the one to act on it.
 */
export const proposeCalendarSlotsExecutor: ActionExecutor = async ({
  tenantId,
  config,
  triggerContext,
  deps,
}) => {
  if (config.type !== "propose_calendar_slots") {
    throw new ActionConfigMismatchError("propose_calendar_slots", config.type);
  }
  const applicationId = triggerContext.application_id;
  if (typeof applicationId !== "string" || applicationId.length === 0) {
    throw new MissingTriggerContextError("propose_calendar_slots", "application_id");
  }
  const rawRound = triggerContext.round_number;
  const roundNumber =
    typeof rawRound === "number" && Number.isInteger(rawRound) && rawRound > 0 ? rawRound : null;

  const result = await deps.proposeInterviewSlots(tenantId, {
    applicationId,
    roundNumber,
    panelRef: config.panel_id,
    slotCount: config.slot_count,
    windowDays: config.window_days,
    durationMinutes: config.duration_minutes,
  });

  return {
    output: {
      source: "hireops_availability",
      panel_id: config.panel_id,
      round_number: result.roundNumber,
      proposed_slots: result.slots.slice(0, config.slot_count),
      duration_minutes: config.duration_minutes,
      timezone: result.timezone,
      empty_reason: result.emptyReason,
    },
    costMicros: 0n,
    requiresApproval: false,
  };
};
