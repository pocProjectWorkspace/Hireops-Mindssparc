/**
 * Focused unit test for bridgeActionConfig.
 *
 * The bridge is what reunites the DB-stored discriminator (column
 * action_type) with the Zod schema discriminator (`type` inside the
 * jsonb). If this breaks, every worker drain breaks, but the symptom
 * shows up as a downstream parse failure — this test isolates the
 * bridge so a failure here points straight at the cause.
 *
 * Coverage:
 *   1. Happy path per action type — output is the narrowed discriminated
 *      union member with the column value as `type`.
 *   2. ZodError on missing required jsonb fields (terminal failure
 *      contract — matches AI-03 ZodError-terminal pattern).
 *   3. ZodError on unknown extra fields (members are .strict()).
 *   4. ZodError on type mismatch (number where string expected, etc.).
 *   5. Wrong action_type column value with otherwise-valid jsonb for a
 *      different action — ZodError because the constructed object
 *      doesn't satisfy any union member.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { bridgeActionConfig } from "../src/bridge";

describe("bridgeActionConfig — happy path per action type", () => {
  it("draft_message", () => {
    const out = bridgeActionConfig("draft_message", {
      template_prompt_id: "follow_up_v1",
      tone: "friendly",
      max_tokens: 200,
    });
    expect(out).toEqual({
      type: "draft_message",
      template_prompt_id: "follow_up_v1",
      tone: "friendly",
      max_tokens: 200,
    });
  });

  it("send_message", () => {
    const out = bridgeActionConfig("send_message", {
      channel: "email",
      outbox_kind: "agent_followup",
      requires_approval: true,
    });
    expect(out.type).toBe("send_message");
  });

  it("propose_calendar_slots", () => {
    const out = bridgeActionConfig("propose_calendar_slots", {
      panel_id: "panel-1",
      slot_count: 3,
      window_days: 7,
      duration_minutes: 45,
    });
    expect(out.type).toBe("propose_calendar_slots");
  });

  it("create_calendar_event", () => {
    const out = bridgeActionConfig("create_calendar_event", {
      panel_id: "panel-1",
      source_action_ref: "1",
    });
    expect(out.type).toBe("create_calendar_event");
  });

  it("update_application_stage", () => {
    const out = bridgeActionConfig("update_application_stage", {
      target_stage: "tech_screen",
      reason_template_id: "stale_advance_v1",
    });
    expect(out.type).toBe("update_application_stage");
  });

  it("notify_recruiter", () => {
    const out = bridgeActionConfig("notify_recruiter", {
      template_prompt_id: "stale_alert_v1",
      channel: "in_portal",
    });
    expect(out.type).toBe("notify_recruiter");
  });

  it("create_audit_entry", () => {
    const out = bridgeActionConfig("create_audit_entry", {
      event_type: "candidate_replied",
      payload_template_id: "candidate_reply_v1",
    });
    expect(out.type).toBe("create_audit_entry");
  });
});

describe("bridgeActionConfig — terminal failure modes", () => {
  it("ZodError on missing required jsonb field", () => {
    expect(() =>
      bridgeActionConfig("draft_message", {
        // template_prompt_id missing
        tone: "friendly",
        max_tokens: 200,
      }),
    ).toThrow(z.ZodError);
  });

  it("ZodError on unknown extra field (strict mode)", () => {
    expect(() =>
      bridgeActionConfig("draft_message", {
        template_prompt_id: "x",
        tone: "friendly",
        max_tokens: 200,
        rogue_field: "no",
      }),
    ).toThrow(z.ZodError);
  });

  it("ZodError on wrong field type (number where string expected)", () => {
    expect(() =>
      bridgeActionConfig("draft_message", {
        template_prompt_id: 42 as unknown as string,
        tone: "friendly",
        max_tokens: 200,
      }),
    ).toThrow(z.ZodError);
  });

  it("ZodError on column-value/jsonb mismatch — action_type='send_message' with draft_message jsonb", () => {
    expect(() =>
      bridgeActionConfig("send_message", {
        template_prompt_id: "x",
        tone: "friendly",
        max_tokens: 200,
      }),
    ).toThrow(z.ZodError);
  });

  it("ZodError on unknown action_type value", () => {
    expect(() =>
      bridgeActionConfig("not_a_real_action_type", {
        template_prompt_id: "x",
      }),
    ).toThrow(z.ZodError);
  });
});
