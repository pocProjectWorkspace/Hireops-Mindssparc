/**
 * AGENT-04a — #30 close: rule-attachment guard.
 *
 * `assertRuleAttachable(actionType, approvalMode)` is the validator
 * called at every point where an agent_approval_rules row is
 * created or updated. It enforces the capability-declaration model
 * resolved in open-question #30:
 *
 *   - Auto mode is always permitted (a no-op gate on a non-capable
 *     action is harmless).
 *   - human_required / human_optional are only permitted on action
 *     types whose executor declares requiresApprovalCapable=true.
 *   - Anything else (unknown action type, unknown mode) throws.
 *
 * AGENT-04b update: propose_calendar_slots + create_calendar_event
 * flipped from false → true in the capability map. The two named-test
 * blocks below assert the new behaviour explicitly (was rejected;
 * now permitted) so any future regression of the flip surfaces here,
 * not silently in the agent surface.
 *
 * Pure-function tests, no DB. Mirrors the registry.test.ts pattern.
 */

import { describe, expect, it } from "vitest";
import {
  actionExecutorCapabilities,
  assertRuleAttachable,
  IncompatibleApprovalRuleError,
} from "../src/index";

describe("assertRuleAttachable — auto mode (always permitted)", () => {
  for (const actionType of Object.keys(actionExecutorCapabilities)) {
    it(`permits auto on ${actionType} regardless of capability`, () => {
      expect(() => assertRuleAttachable(actionType, "auto")).not.toThrow();
    });
  }
});

describe("assertRuleAttachable — capable actions accept human-gate modes", () => {
  // AGENT-04a shipped with send_message as the only capable type;
  // AGENT-04b flipped propose_calendar_slots + create_calendar_event
  // to capable too.
  const capableTypes = Object.entries(actionExecutorCapabilities)
    .filter(([, cap]) => cap.requiresApprovalCapable)
    .map(([type]) => type);

  it("at least one action type is capable (sanity check on the registry)", () => {
    expect(capableTypes.length).toBeGreaterThan(0);
  });

  for (const actionType of capableTypes) {
    it(`permits human_required on ${actionType}`, () => {
      expect(() => assertRuleAttachable(actionType, "human_required")).not.toThrow();
    });
    it(`permits human_optional on ${actionType}`, () => {
      expect(() => assertRuleAttachable(actionType, "human_optional")).not.toThrow();
    });
  }
});

describe("assertRuleAttachable — non-capable actions reject human-gate modes", () => {
  const incapableTypes = Object.entries(actionExecutorCapabilities)
    .filter(([, cap]) => !cap.requiresApprovalCapable)
    .map(([type]) => type);

  it("at least one action type is not capable (sanity check)", () => {
    expect(incapableTypes.length).toBeGreaterThan(0);
  });

  for (const actionType of incapableTypes) {
    it(`rejects human_required on ${actionType}`, () => {
      expect(() => assertRuleAttachable(actionType, "human_required")).toThrow(
        IncompatibleApprovalRuleError,
      );
    });
    it(`rejects human_optional on ${actionType}`, () => {
      expect(() => assertRuleAttachable(actionType, "human_optional")).toThrow(
        IncompatibleApprovalRuleError,
      );
    });
  }
});

describe("AGENT-04b capability flips — calendar actions now permitted", () => {
  // Both flipped from false → true in the registry. Behaviour MUST be
  // "human-gate rules permitted" not "human-gate rules rejected".
  // These are the load-bearing assertions of the AGENT-04b flip — any
  // future regression of the flip surfaces here, not silently in the
  // Scheduling agent surface.
  it("propose_calendar_slots is requiresApprovalCapable=true (was false pre-AGENT-04b)", () => {
    expect(actionExecutorCapabilities.propose_calendar_slots.requiresApprovalCapable).toBe(true);
  });

  it("create_calendar_event is requiresApprovalCapable=true (was false pre-AGENT-04b)", () => {
    expect(actionExecutorCapabilities.create_calendar_event.requiresApprovalCapable).toBe(true);
  });

  it("propose_calendar_slots NOW accepts human_required (was rejected pre-AGENT-04b)", () => {
    expect(() => assertRuleAttachable("propose_calendar_slots", "human_required")).not.toThrow();
  });

  it("propose_calendar_slots NOW accepts human_optional (was rejected pre-AGENT-04b)", () => {
    expect(() => assertRuleAttachable("propose_calendar_slots", "human_optional")).not.toThrow();
  });

  it("create_calendar_event NOW accepts human_required (was rejected pre-AGENT-04b)", () => {
    expect(() => assertRuleAttachable("create_calendar_event", "human_required")).not.toThrow();
  });

  it("create_calendar_event NOW accepts human_optional (was rejected pre-AGENT-04b)", () => {
    expect(() => assertRuleAttachable("create_calendar_event", "human_optional")).not.toThrow();
  });

  // The non-flipped rows stay rejected — defensive guardrail that the
  // flip didn't leak across the wider map.
  it("update_application_stage still rejects human_required (unchanged by AGENT-04b)", () => {
    expect(() => assertRuleAttachable("update_application_stage", "human_required")).toThrow(
      IncompatibleApprovalRuleError,
    );
  });

  it("notify_recruiter still rejects human_required (unchanged by AGENT-04b)", () => {
    expect(() => assertRuleAttachable("notify_recruiter", "human_required")).toThrow(
      IncompatibleApprovalRuleError,
    );
  });
});

describe("assertRuleAttachable — defensive paths", () => {
  it("throws IncompatibleApprovalRuleError on unknown action type with a human-gate mode", () => {
    expect(() => assertRuleAttachable("definitely_not_a_real_action", "human_required")).toThrow(
      IncompatibleApprovalRuleError,
    );
  });

  it("permits auto on unknown action type (auto is unconditional)", () => {
    // Defensible because the DB CHECK constraint catches unknown
    // action types upstream; auto on an unknown type can't fire a
    // gate so isn't a misconfiguration the guard needs to surface.
    expect(() => assertRuleAttachable("definitely_not_a_real_action", "auto")).not.toThrow();
  });

  it("throws on an unknown approval mode regardless of action type", () => {
    expect(() => assertRuleAttachable("send_message", "approval_via_committee")).toThrow(
      IncompatibleApprovalRuleError,
    );
  });

  it("error message names both the action type and the mode for diagnosability", () => {
    try {
      assertRuleAttachable("draft_message", "human_required");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IncompatibleApprovalRuleError);
      expect((err as Error).message).toContain("draft_message");
      expect((err as Error).message).toContain("human_required");
    }
  });
});
