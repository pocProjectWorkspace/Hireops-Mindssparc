import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * propose_calendar_slots — STUB.
 *
 * Real implementation (AGENT-04+) will query Google Calendar for free
 * slots within the next window_days, filtering by panel availability.
 * AGENT-02 stub fabricates `slot_count` evenly-spaced ISO windows
 * starting tomorrow so downstream create_calendar_event has a
 * realistic-shaped previousActionOutputs entry to read from.
 */
export const proposeCalendarSlotsExecutor: ActionExecutor = async ({ config }) => {
  if (config.type !== "propose_calendar_slots") {
    throw new ActionConfigMismatchError("propose_calendar_slots", config.type);
  }
  // Tomorrow 09:00 UTC + N evenly-spaced slots across window_days.
  const baseMs = Date.now() + 24 * 60 * 60 * 1000;
  const intervalMs = Math.floor((config.window_days * 24 * 60 * 60 * 1000) / config.slot_count);
  const durationMs = config.duration_minutes * 60 * 1000;
  const proposed_slots = Array.from({ length: config.slot_count }, (_, i) => {
    const start = new Date(baseMs + i * intervalMs);
    const end = new Date(start.getTime() + durationMs);
    return { start: start.toISOString(), end: end.toISOString() };
  });
  return {
    output: {
      _stub: true,
      _ticket: "AGENT-02",
      panel_id: config.panel_id,
      proposed_slots,
      duration_minutes: config.duration_minutes,
    },
    costMicros: 0n,
    requiresApproval: false,
  };
};
