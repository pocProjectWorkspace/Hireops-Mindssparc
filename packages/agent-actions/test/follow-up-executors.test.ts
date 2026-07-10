/**
 * FOLLOWUP-01 — behaviour of the two real executors, plus the prompt
 * registry. Pure: every port is faked (see ./fakes.ts), so there is no
 * DB, no network, and no LLM spend.
 *
 * The load-bearing assertions here are the ordering ones. The drain
 * executes an action and only THEN evaluates the approval gate, resuming
 * afterwards without re-executing. That means:
 *
 *   - draft_message must be the gated action (it is pure), and
 *   - send_message must read whatever text ended up in the preceding
 *     action's output — which, after approveApprovalWithEdit, is the
 *     recruiter's edited replacement, not the model's original.
 *
 * "reads the recruiter's edited draft, not the model's original" is the
 * test that would have caught the bug this ticket fixed.
 */

import { describe, expect, it } from "vitest";
import {
  actionExecutorRegistry,
  MissingTriggerContextError,
  UnknownPromptTemplateError,
  resolvePromptTemplate,
  firstName,
  humaniseStage,
  type ActionExecutorParams,
} from "../src/index";
import { makeFakeDeps, FAKE_CONTEXT } from "./fakes";

const DRAFT_CONFIG = {
  type: "draft_message",
  template_prompt_id: "follow_up_v1",
  tone: "friendly",
  max_tokens: 200,
} as const;

const SEND_CONFIG = {
  type: "send_message",
  channel: "email",
  outbox_kind: "agent_followup",
  requires_approval: false,
} as const;

function params(
  overrides: Partial<ActionExecutorParams> & { config: ActionExecutorParams["config"] },
): ActionExecutorParams {
  return {
    tenantId: "t-1",
    runId: "r-1",
    runActionId: "ra-1",
    agentId: "a-1",
    triggerContext: { application_id: "app-1" },
    previousActionOutputs: {},
    deps: makeFakeDeps(),
    ...overrides,
  };
}

describe("draft_message executor (real)", () => {
  it("loads context, calls the LLM, and returns the trimmed draft as the approval payload", async () => {
    const deps = makeFakeDeps({ draftText: "  Hi Anika,\n\nStill with us.  ", costMicros: 900n });
    const result = await actionExecutorRegistry.draft_message(
      params({ config: DRAFT_CONFIG, deps }),
    );

    expect(deps.calls.loadApplicationContext).toEqual([
      { tenantId: "t-1", applicationId: "app-1" },
    ]);

    const out = result.output as Record<string, unknown>;
    expect(out.draft_text).toBe("Hi Anika,\n\nStill with us.");
    expect(out.candidate_email).toBe(FAKE_CONTEXT.candidateEmail);
    expect(out.position_title).toBe(FAKE_CONTEXT.positionTitle);
    expect(out.prompt_version).toBe("followup-v1");
    // Subject is executor-owned, never model-owned.
    expect(out.subject).toBe(`Update on your application — ${FAKE_CONTEXT.positionTitle}`);
    expect(result.costMicros).toBe(900n);
  });

  it("is the gated action — returns requiresApproval: true", async () => {
    const result = await actionExecutorRegistry.draft_message(params({ config: DRAFT_CONFIG }));
    expect(result.requiresApproval).toBe(true);
  });

  it("passes tone and max_tokens through to the LLM call", async () => {
    const deps = makeFakeDeps();
    await actionExecutorRegistry.draft_message(
      params({ config: { ...DRAFT_CONFIG, tone: "formal", max_tokens: 512 }, deps }),
    );
    const call = deps.calls.draftWithAI[0];
    expect(call?.req.maxTokens).toBe(512);
    expect(call?.req.feature).toBe("agent_draft_message");
    expect(call?.req.system).toContain("formal");
    // Context must reach the prompt, otherwise the model drafts blind.
    expect(call?.req.prompt).toContain(FAKE_CONTEXT.positionTitle);
    expect(call?.req.prompt).toContain("6");
  });

  it("throws MissingTriggerContextError when application_id is absent", async () => {
    await expect(
      actionExecutorRegistry.draft_message(params({ config: DRAFT_CONFIG, triggerContext: {} })),
    ).rejects.toBeInstanceOf(MissingTriggerContextError);
  });

  it("rejects an unknown template_prompt_id before spending a token", async () => {
    const deps = makeFakeDeps();
    await expect(
      actionExecutorRegistry.draft_message(
        params({ config: { ...DRAFT_CONFIG, template_prompt_id: "nope_v9" }, deps }),
      ),
    ).rejects.toBeInstanceOf(UnknownPromptTemplateError);
    expect(deps.calls.draftWithAI).toHaveLength(0);
    expect(deps.calls.loadApplicationContext).toHaveLength(0);
  });
});

describe("send_message executor (real)", () => {
  const draftOutput = {
    draft_text: "Hi Anika, checking in.",
    subject: "Update on your application — Senior Backend Engineer",
    candidate_email: "anika@example.com",
    candidate_id: "cand-1",
    candidate_name: "Anika Sharma",
    position_title: "Senior Backend Engineer",
    company_name: "Kyndryl GCC",
  };

  it("enqueues the draft to the notification outbox", async () => {
    const deps = makeFakeDeps();
    const result = await actionExecutorRegistry.send_message(
      params({ config: SEND_CONFIG, previousActionOutputs: { 1: draftOutput }, deps }),
    );

    const call = deps.calls.enqueueEmail[0];
    expect(call?.tenantId).toBe("t-1");
    expect(call?.req.recipientEmail).toBe("anika@example.com");
    expect(call?.req.recipientCandidateId).toBe("cand-1");
    expect(call?.req.templateKey).toBe("candidate.agent_message");
    expect(call?.req.templateData.body).toBe("Hi Anika, checking in.");
    // The dispatcher renders from templateData and ignores the outbox
    // column, so the subject has to travel in both.
    expect(call?.req.templateData.subject).toBe(draftOutput.subject);
    expect(call?.req.subject).toBe(draftOutput.subject);

    const out = result.output as Record<string, unknown>;
    expect(out.sent).toBe(true);
    expect(out.notification_outbox_id).toBe("outbox-1");
  });

  it("is idempotent by run-action id, so a retried drain pass cannot double-send", async () => {
    const deps = makeFakeDeps();
    await actionExecutorRegistry.send_message(
      params({
        config: SEND_CONFIG,
        runActionId: "ra-42",
        previousActionOutputs: { 1: draftOutput },
        deps,
      }),
    );
    expect(deps.calls.enqueueEmail[0]?.req.dedupKey).toBe("agent_run_action:ra-42");
  });

  it("reads the recruiter's edited draft, not the model's original", async () => {
    // approveApprovalWithEdit overwrites agent_run_actions.output wholesale,
    // and the drain feeds that column forward as previousActionOutputs.
    // This is the ordering guarantee the whole gate placement rests on.
    const deps = makeFakeDeps();
    const edited = { ...draftOutput, draft_text: "Recruiter rewrote this entirely." };
    await actionExecutorRegistry.send_message(
      params({ config: SEND_CONFIG, previousActionOutputs: { 1: edited }, deps }),
    );
    expect(deps.calls.enqueueEmail[0]?.req.templateData.body).toBe(
      "Recruiter rewrote this entirely.",
    );
  });

  it("prefers the highest-ordered draft when several precede it", async () => {
    const deps = makeFakeDeps();
    await actionExecutorRegistry.send_message(
      params({
        config: SEND_CONFIG,
        previousActionOutputs: {
          1: { ...draftOutput, draft_text: "stale first draft" },
          3: { ...draftOutput, draft_text: "latest draft" },
        },
        deps,
      }),
    );
    expect(deps.calls.enqueueEmail[0]?.req.templateData.body).toBe("latest draft");
  });

  it("ignores non-draft prior outputs, e.g. a preceding stub action", async () => {
    const deps = makeFakeDeps();
    await actionExecutorRegistry.send_message(
      params({
        config: SEND_CONFIG,
        previousActionOutputs: { 1: draftOutput, 2: { _stub: true, sent: false } },
        deps,
      }),
    );
    expect(deps.calls.enqueueEmail[0]?.req.templateData.body).toBe("Hi Anika, checking in.");
  });

  it("throws when no preceding action produced a draft", async () => {
    await expect(
      actionExecutorRegistry.send_message(params({ config: SEND_CONFIG })),
    ).rejects.toThrow(/must follow a draft_message action/);
  });

  it("throws when the approved draft is missing a required field", async () => {
    const noEmail = { ...draftOutput, candidate_email: "" };
    await expect(
      actionExecutorRegistry.send_message(
        params({ config: SEND_CONFIG, previousActionOutputs: { 1: noEmail } }),
      ),
    ).rejects.toThrow(/missing 'candidate_email'/);
  });

  it("mirrors config.requires_approval so a deliberate gate is not silently ignored", async () => {
    const result = await actionExecutorRegistry.send_message(
      params({
        config: { ...SEND_CONFIG, requires_approval: true },
        previousActionOutputs: { 1: draftOutput },
      }),
    );
    expect(result.requiresApproval).toBe(true);
  });
});

describe("prompt registry", () => {
  it("resolves follow_up_v1 and stamps a version", () => {
    const template = resolvePromptTemplate("follow_up_v1");
    expect(template.version).toBe("followup-v1");
  });

  it("throws UnknownPromptTemplateError listing the known ids", () => {
    expect(() => resolvePromptTemplate("ghost")).toThrow(UnknownPromptTemplateError);
    expect(() => resolvePromptTemplate("ghost")).toThrow(/follow_up_v1/);
  });

  it("guardrails forbid inventing salary, dates, and outcomes", () => {
    const system = resolvePromptTemplate("follow_up_v1").system("neutral");
    expect(system).toMatch(/Never invent facts/);
    expect(system).toMatch(/salary/);
    expect(system).toMatch(/Plain text only/);
  });

  it("humanises stage names and degrades gracefully on unknown values", () => {
    expect(humaniseStage("tech_interview")).toBe("technical interview");
    expect(humaniseStage("some_future_stage")).toBe("some future stage");
  });

  it("takes a first name, falling back to the whole string for single tokens", () => {
    expect(firstName("Anika Sharma")).toBe("Anika");
    expect(firstName("Prince")).toBe("Prince");
  });
});
