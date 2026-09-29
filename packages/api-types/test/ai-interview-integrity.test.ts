import { describe, expect, it } from "vitest";
import {
  aiInterviewIntegritySummarySchema,
  coerceIntegrityEvents,
  isAiInterviewIntegrityEventType,
  summariseIntegrity,
  type AiInterviewIntegrityEvent,
} from "../src/ai-interview";

/**
 * AI-INT-1 — the integrity log summary the recruiter card shows.
 *
 * The properties pinned here are the ones a reviewer relies on when reading
 * one line of text about a candidate: a tab switch is counted ONCE whichever
 * of the two browser signals it arrived as, away-time comes only from the
 * RETURN events (so an exit with no return adds nothing rather than a guess),
 * and a malformed stored entry is dropped on read rather than throwing on the
 * recruiter's screen.
 */

const AT = "2026-09-29T10:00:00.000Z";

function ev(
  type: AiInterviewIntegrityEvent["type"],
  awayMs: number | null = null,
): AiInterviewIntegrityEvent {
  return { type, at: AT, clientAt: AT, awayMs, questionKey: "q1" };
}

describe("summariseIntegrity", () => {
  it("an empty log is all zeros", () => {
    expect(summariseIntegrity([])).toEqual({
      fullscreenExits: 0,
      tabSwitches: 0,
      totalAwayMs: 0,
      events: 0,
    });
  });

  it("counts full-screen exits, tab switches and away time from return events", () => {
    const summary = summariseIntegrity([
      ev("fullscreen_exit"),
      ev("fullscreen_enter", 4_000),
      ev("tab_hidden"),
      ev("tab_visible", 30_000),
      ev("window_blur"),
      ev("window_focus", 7_000),
    ]);
    expect(summary).toEqual({
      fullscreenExits: 1,
      tabSwitches: 2,
      totalAwayMs: 41_000,
      events: 6,
    });
    // The shape is exactly what the card schema promises.
    expect(aiInterviewIntegritySummarySchema.parse(summary)).toEqual(summary);
  });

  it("ignores awayMs on the LEAVING events and never goes negative", () => {
    const summary = summariseIntegrity([
      ev("tab_hidden", 99_999),
      ev("tab_visible", -5),
      ev("fullscreen_exit", 12_000),
    ]);
    expect(summary.totalAwayMs).toBe(0);
    expect(summary.tabSwitches).toBe(1);
    expect(summary.fullscreenExits).toBe(1);
  });

  it("an exit with no return contributes no away time", () => {
    expect(summariseIntegrity([ev("tab_hidden")]).totalAwayMs).toBe(0);
  });

  it("rounds fractional away time to whole milliseconds", () => {
    expect(summariseIntegrity([ev("window_focus", 1_000.6)]).totalAwayMs).toBe(1_001);
  });
});

describe("coerceIntegrityEvents", () => {
  it("returns [] for anything that is not an array", () => {
    expect(coerceIntegrityEvents(null)).toEqual([]);
    expect(coerceIntegrityEvents({})).toEqual([]);
    expect(coerceIntegrityEvents("[]")).toEqual([]);
  });

  it("drops entries with an unknown type or no server timestamp, keeps the rest", () => {
    const out = coerceIntegrityEvents([
      { type: "tab_hidden", at: AT },
      { type: "screenshot", at: AT },
      { type: "tab_visible" },
      "tab_hidden",
      { type: "tab_visible", at: AT, awayMs: 2_500, questionKey: "q2", clientAt: AT },
    ]);
    expect(out).toEqual([
      { type: "tab_hidden", at: AT, clientAt: null, awayMs: null, questionKey: null },
      { type: "tab_visible", at: AT, clientAt: AT, awayMs: 2_500, questionKey: "q2" },
    ]);
  });

  it("treats a non-finite awayMs as absent", () => {
    const [e] = coerceIntegrityEvents([{ type: "window_focus", at: AT, awayMs: "12" }]);
    expect(e?.awayMs).toBeNull();
  });
});

describe("isAiInterviewIntegrityEventType", () => {
  it("accepts exactly the six recorded signals", () => {
    for (const t of [
      "fullscreen_exit",
      "fullscreen_enter",
      "tab_hidden",
      "tab_visible",
      "window_blur",
      "window_focus",
    ]) {
      expect(isAiInterviewIntegrityEventType(t)).toBe(true);
    }
    expect(isAiInterviewIntegrityEventType("copy")).toBe(false);
    expect(isAiInterviewIntegrityEventType(undefined)).toBe(false);
  });
});
