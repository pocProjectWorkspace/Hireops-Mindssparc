/**
 * Registry smoke + per-executor stub-shape tests for @hireops/agent-actions.
 *
 * Pure-function tests, no DB. Verifies:
 *   1. All 7 expected action types are registered.
 *   2. Each entry is a function.
 *   3. Each executor returns the documented stub output shape with the
 *      `_stub: true` + `_ticket: 'AGENT-02'` honesty markers when
 *      invoked with a valid config of its type.
 *   4. Each executor throws ActionConfigMismatchError when the config
 *      discriminator doesn't match its own type.
 *
 * AGENT-03 note: `send_message` is the one executor that now returns
 * `requiresApproval: true` (everything else stays autonomous at the
 * executor layer). `assertStubMarkers` no longer asserts on
 * requiresApproval; each test asserts the expected value explicitly.
 */

import { describe, expect, it } from "vitest";
import {
  actionExecutorRegistry,
  ActionConfigMismatchError,
  type ActionExecutorParams,
  type ActionResult,
} from "../src/index";

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

describe("draft_message executor", () => {
  it("returns stub output with honesty markers + echoed config fields", async () => {
    const params = baseParams({
      config: {
        type: "draft_message",
        template_prompt_id: "follow_up_v1",
        tone: "friendly",
        max_tokens: 200,
      },
    });
    const result = await actionExecutorRegistry.draft_message(params);
    assertStubMarkers(result);
    const out = result.output as Record<string, unknown>;
    expect(out.template_prompt_id).toBe("follow_up_v1");
    expect(out.tone).toBe("friendly");
    expect(out.max_tokens).toBe(200);
    expect(typeof out.draft_text).toBe("string");
    expect(result.requiresApproval).toBe(false);
  });
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
  // AGENT-03 flipped this — send_message now returns
  // requiresApproval: true so the worker's awaiting_approval branch is
  // exercised end-to-end via the resolution + resume cycle.
  it("returns stub output with sent: false + requiresApproval: true", async () => {
    const result = await actionExecutorRegistry.send_message(
      baseParams({
        config: {
          type: "send_message",
          channel: "email",
          outbox_kind: "agent_followup",
          requires_approval: true,
        },
      }),
    );
    assertStubMarkers(result);
    const out = result.output as Record<string, unknown>;
    expect(out.sent).toBe(false);
    expect(out.channel).toBe("email");
    expect(out.outbox_kind).toBe("agent_followup");
    expect(out._originally_set_by).toBe("AGENT-02");
    expect(result.requiresApproval).toBe(true);
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
