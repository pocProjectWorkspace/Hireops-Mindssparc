/**
 * Registry smoke + per-executor shape tests for @hireops/agent-actions.
 *
 * Pure-function tests, no DB, no network, no LLM tokens — behaviour that
 * would otherwise need those arrives through the injected ExecutorDeps
 * fakes in ./fakes.ts.
 *
 * Verifies:
 *   1. All 7 expected action types are registered.
 *   2. Each entry is a function.
 *   3. The 5 still-stubbed executors return the documented stub output
 *      shape with the `_stub: true` + `_ticket: 'AGENT-02'` markers.
 *   4. Each executor throws ActionConfigMismatchError when the config
 *      discriminator doesn't match its own type.
 *
 * FOLLOWUP-01 note: `draft_message` and `send_message` are REAL and so
 * carry no stub markers — their behaviour lives in
 * ./follow-up-executors.test.ts. `draft_message` is now the executor
 * that returns `requiresApproval: true`; the gate moved off
 * `send_message` because the drain executes-then-gates and a gated send
 * would have enqueued the email before the human approved it.
 */

import { describe, expect, it } from "vitest";
import {
  actionExecutorRegistry,
  ActionConfigMismatchError,
  type ActionExecutorParams,
  type ActionResult,
} from "../src/index";
import { makeFakeDeps } from "./fakes";

const EXPECTED_TYPES = [
  "draft_message",
  "send_message",
  "propose_calendar_slots",
  "create_calendar_event",
  "update_application_stage",
  "notify_recruiter",
  "create_audit_entry",
] as const;

function baseParams(overrides: { config: ActionExecutorParams["config"] }): ActionExecutorParams {
  return {
    tenantId: "t-1",
    runId: "r-1",
    runActionId: "ra-1",
    agentId: "a-1",
    triggerContext: { application_id: "fake" },
    previousActionOutputs: {},
    deps: makeFakeDeps(),
    ...overrides,
  };
}

describe("actionExecutorRegistry", () => {
  it("registers exactly the 7 expected action types", () => {
    const keys = Object.keys(actionExecutorRegistry).sort();
    expect(keys).toEqual([...EXPECTED_TYPES].sort());
  });

  it("every entry is an async function", () => {
    for (const key of EXPECTED_TYPES) {
      const fn = actionExecutorRegistry[key];
      expect(typeof fn).toBe("function");
    }
  });
});

// draft_message / send_message behaviour lives in
// ./follow-up-executors.test.ts — they are real as of FOLLOWUP-01 and
// carry no stub markers. Only their config-mismatch guards belong here,
// alongside the other five.

describe("draft_message executor", () => {
  it("throws ActionConfigMismatchError on wrong config type", async () => {
    const wrong = baseParams({
      config: { type: "manual" } as unknown as ActionExecutorParams["config"],
    });
    await expect(actionExecutorRegistry.draft_message(wrong)).rejects.toBeInstanceOf(
      ActionConfigMismatchError,
    );
  });
});

describe("send_message executor", () => {
  it("throws ActionConfigMismatchError on wrong config type", async () => {
    const wrong = baseParams({
      config: { type: "manual" } as unknown as ActionExecutorParams["config"],
    });
    await expect(actionExecutorRegistry.send_message(wrong)).rejects.toBeInstanceOf(
      ActionConfigMismatchError,
    );
  });
});

describe("propose_calendar_slots executor", () => {
  it("returns slot_count proposed slots, each with start + end ISO strings", async () => {
    const result = await actionExecutorRegistry.propose_calendar_slots(
      baseParams({
        config: {
          type: "propose_calendar_slots",
          panel_id: "panel-1",
          slot_count: 3,
          window_days: 7,
          duration_minutes: 45,
        },
      }),
    );
    assertStubMarkers(result);
    expect(result.requiresApproval).toBe(false);
    const out = result.output as { proposed_slots: { start: string; end: string }[] };
    expect(out.proposed_slots).toHaveLength(3);
    for (const slot of out.proposed_slots) {
      expect(typeof slot.start).toBe("string");
      expect(typeof slot.end).toBe("string");
      expect(new Date(slot.start).getTime() < new Date(slot.end).getTime()).toBe(true);
    }
  });
});

describe("create_calendar_event executor", () => {
  it("returns deterministic stub event_id keyed on runId", async () => {
    const result = await actionExecutorRegistry.create_calendar_event(
      baseParams({
        config: {
          type: "create_calendar_event",
          panel_id: "panel-1",
          source_action_ref: "1",
        },
      }),
    );
    assertStubMarkers(result);
    expect(result.requiresApproval).toBe(false);
    const out = result.output as Record<string, unknown>;
    expect(out.event_id).toBe("stub-evt-r-1");
    expect(out.invitees).toEqual([]);
  });
});

describe("update_application_stage executor", () => {
  it("returns updated: false", async () => {
    const result = await actionExecutorRegistry.update_application_stage(
      baseParams({
        config: {
          type: "update_application_stage",
          target_stage: "tech_screen",
          reason_template_id: "stale_advance_v1",
        },
      }),
    );
    assertStubMarkers(result);
    expect(result.requiresApproval).toBe(false);
    const out = result.output as Record<string, unknown>;
    expect(out.updated).toBe(false);
    expect(out.target_stage).toBe("tech_screen");
  });
});

describe("notify_recruiter executor", () => {
  it("returns stub output with channel echo", async () => {
    const result = await actionExecutorRegistry.notify_recruiter(
      baseParams({
        config: {
          type: "notify_recruiter",
          template_prompt_id: "stale_alert_v1",
          channel: "in_portal",
        },
      }),
    );
    assertStubMarkers(result);
    expect(result.requiresApproval).toBe(false);
    const out = result.output as Record<string, unknown>;
    expect(out.channel).toBe("in_portal");
  });
});

describe("create_audit_entry executor", () => {
  it("returns deterministic stub audit_id keyed on runId", async () => {
    const result = await actionExecutorRegistry.create_audit_entry(
      baseParams({
        config: {
          type: "create_audit_entry",
          event_type: "candidate_replied",
          payload_template_id: "candidate_reply_v1",
        },
      }),
    );
    assertStubMarkers(result);
    expect(result.requiresApproval).toBe(false);
    const out = result.output as Record<string, unknown>;
    expect(out.audit_id).toBe("stub-aud-r-1");
  });
});

function assertStubMarkers(result: ActionResult): void {
  expect(result.costMicros).toBe(0n);
  const out = result.output as Record<string, unknown>;
  expect(out._stub).toBe(true);
  expect(out._ticket).toBe("AGENT-02");
}
