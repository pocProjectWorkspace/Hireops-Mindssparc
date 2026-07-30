/**
 * message_candidate drafter — PURE units (no DB / no LLM).
 *
 * HONESTY focus. These cover the guarantees that keep the drafter a PROPOSER that
 * grounds ONLY in real context, without a live provider call (flaky / costly):
 *   - the prompt is built from ONLY the real application context (candidate name,
 *     role, company) + the recruiter's intent;
 *   - the candidate's EMAIL is never a value in the prompt or the draft body (it's
 *     a routing field, never content the model may echo);
 *   - the graceful-degrade path returns a NON-EMPTY templated draft from the same
 *     context + intent, so the drawer stays usable when AI is off.
 *
 * The live-provider path (getAIClient + completeStructured) is deliberately NOT
 * integration-tested here: it would need a seeded LocalAIClient fixture and adds
 * flake for no extra honesty guarantee over these pure units.
 */

import { describe, it, expect } from "vitest";
import {
  buildCandidateMessagePrompt,
  deterministicCandidateMessageDraft,
  candidateMessageResponseSchema,
  IRIS_MESSAGE_DRAFT_FEATURE,
} from "../src/lib/iris/draft-candidate-message";

const CTX = {
  candidateName: "Priya Nair",
  positionTitle: "Backend Engineer",
  companyName: "Kyndryl",
};
const EMAIL = "priya.nair@example.com";

describe("message_candidate prompt builder — grounds only in real context + intent", () => {
  it("includes the candidate name, role, company, and intent; never the email", () => {
    const { system, user } = buildCandidateMessagePrompt({
      ...CTX,
      intent: "Let them know we're moving them to the final interview round.",
    });
    // The real context + intent are present so the model is grounded.
    expect(user).toContain("Priya Nair");
    expect(user).toContain("Backend Engineer");
    expect(user).toContain("Kyndryl");
    expect(user).toContain("final interview round");
    // The email is NEVER part of the prompt input, so it cannot leak into the draft.
    expect(user).not.toContain(EMAIL);
    expect(system).not.toContain(EMAIL);
    // The system prompt states the no-invention / grounded contract.
    expect(system.toLowerCase()).toContain("do not invent");
    expect(system.toLowerCase()).toContain("only");
  });

  it("caps a runaway intent so the prompt can't balloon", () => {
    const longIntent = "x".repeat(2000);
    const { user } = buildCandidateMessagePrompt({ ...CTX, intent: longIntent });
    // The intent is sliced to 500 chars in the prompt.
    expect(user).toContain("x".repeat(500));
    expect(user).not.toContain("x".repeat(501));
  });

  it("exposes a stable ai_usage_logs feature label", () => {
    expect(IRIS_MESSAGE_DRAFT_FEATURE).toBe("iris_message_draft");
  });
});

describe("message_candidate degrade — deterministic templated draft", () => {
  it("returns a non-empty subject + body from the context + intent, never the email", () => {
    const draft = deterministicCandidateMessageDraft({
      ...CTX,
      intent: "We'd like to invite you to a final interview next week.",
    });
    expect(draft.subject.length).toBeGreaterThan(0);
    expect(draft.body.length).toBeGreaterThan(0);
    // Grounded in the real context + intent.
    expect(draft.body).toContain("Priya Nair");
    expect(draft.body).toContain("Backend Engineer");
    expect(draft.body).toContain("Kyndryl");
    expect(draft.body).toContain("final interview next week");
    expect(draft.subject).toContain("Backend Engineer");
    // The email is never in the fallback body either.
    expect(draft.body).not.toContain(EMAIL);
    // The fallback conforms to the send contract's bounds.
    expect(candidateMessageResponseSchema.safeParse(draft).success).toBe(true);
  });

  it("stays within the send contract bounds even with an over-long intent", () => {
    const draft = deterministicCandidateMessageDraft({
      ...CTX,
      intent: "y".repeat(5000),
    });
    expect(draft.subject.length).toBeLessThanOrEqual(200);
    expect(draft.body.length).toBeLessThanOrEqual(4000);
    expect(candidateMessageResponseSchema.safeParse(draft).success).toBe(true);
  });
});
