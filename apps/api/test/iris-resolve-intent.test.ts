/**
 * IRIS-A3 — natural-language intent resolver, PURE units (no DB / no LLM).
 *
 * HONESTY focus. These cover the guarantees that keep the NL layer a PROPOSER,
 * not an executor, without a live provider call (flaky / costly):
 *   - the prompt is built from ONLY the caller's role-eligible actions, so the
 *     model can never be steered toward an action this caller may not run;
 *   - a returned actionId outside the eligible/whitelist set is nulled;
 *   - uuid-looking values and known id-typed keys are stripped from params (the
 *     resolver never carries a concrete entity id — targets are picker hints);
 *   - the graceful-degrade result is the calm "use the menu" shape.
 *
 * The live-provider path (getAIClient + completeStructured) is deliberately NOT
 * integration-tested here: it would need a seeded LocalAIClient fixture and adds
 * flake for no extra honesty guarantee over these pure units.
 */

import { describe, it, expect } from "vitest";
import {
  buildIrisIntentPrompt,
  validateResolvedActionId,
  sanitizeDraftParams,
  assembleDraftParams,
  extractHints,
  degradedResolution,
  IRIS_INTENT_DEGRADED_MESSAGE,
  IRIS_ACTION_PROMPT_HINTS,
  type IrisIntentResponse,
} from "../src/lib/iris/resolve-intent";
import { listIrisActions } from "../src/lib/iris/registry";

const ALL_ACTION_IDS = Object.keys(IRIS_ACTION_PROMPT_HINTS);
const UUID = "11111111-1111-4111-8111-111111111111";

/** The role-eligible ids for a role, mirroring the router's irisListActions filter. */
function eligibleFor(roles: string[]): string[] {
  return listIrisActions()
    .filter((a) => a.roles.some((r) => roles.includes(r)))
    .map((a) => a.id);
}

describe("IRIS-A3 prompt builder — only eligible actions appear", () => {
  it("a recruiter's prompt lists the pipeline/onboarding actions but NOT create_requisition_jd", () => {
    const eligible = eligibleFor(["recruiter"]);
    expect(eligible).toContain("advance_application");
    expect(eligible).not.toContain("create_requisition_jd");

    const { system, user } = buildIrisIntentPrompt({
      eligibleActionIds: eligible,
      text: "advance Priya to tech interview",
    });
    // Every NL-proposable eligible action id is described; ineligible ones never
    // leak in. The prompt filters to the hinted set, so message_candidate (a
    // menu-only action) is deliberately absent even though the recruiter is
    // role-eligible for it.
    for (const id of eligible.filter((i) => IRIS_ACTION_PROMPT_HINTS[i])) {
      expect(user).toContain(id);
    }
    expect(user).not.toContain("create_requisition_jd");
    expect(user).not.toContain("message_candidate");
    // The system prompt states the proposer-not-executor contract.
    expect(system.toLowerCase()).toContain("proposer");
  });

  it("a hiring_manager's prompt lists create_requisition_jd but NOT reject_application", () => {
    const eligible = eligibleFor(["hiring_manager"]);
    expect(eligible).toContain("create_requisition_jd");
    expect(eligible).not.toContain("reject_application");

    const { user } = buildIrisIntentPrompt({
      eligibleActionIds: eligible,
      text: "open a backend engineer role",
    });
    expect(user).toContain("create_requisition_jd");
    expect(user).not.toContain("reject_application");
  });

  it("drops ids that aren't in the hint map, and carries page context", () => {
    const { user } = buildIrisIntentPrompt({
      eligibleActionIds: ["advance_application", "not_a_real_action"],
      text: "do the thing",
      context: { route: "/candidates", entityType: "application", entityId: UUID },
    });
    expect(user).toContain("advance_application");
    expect(user).not.toContain("not_a_real_action");
    expect(user).toContain("/candidates");
    // The raw entity id is context only — it is never presented as a param value.
    expect(user).not.toContain(UUID);
  });

  it("includes the valid pipeline stages so the model uses real stage tokens", () => {
    const { system } = buildIrisIntentPrompt({
      eligibleActionIds: ["advance_application"],
      text: "advance",
    });
    expect(system).toContain("tech_interview");
    expect(system).toContain("shortlisted");
  });
});

describe("IRIS-A3 actionId validator — nulls hallucinated / ineligible ids", () => {
  it("keeps an eligible id, nulls anything else", () => {
    const eligible = eligibleFor(["recruiter"]);
    expect(validateResolvedActionId("advance_application", eligible)).toBe("advance_application");
    // A real whitelisted action the caller ISN'T eligible for → nulled.
    expect(validateResolvedActionId("create_requisition_jd", eligible)).toBeNull();
    // A fabricated / non-whitelisted id → nulled.
    expect(validateResolvedActionId("drop_all_requisitions", eligible)).toBeNull();
    // Empty / missing → null.
    expect(validateResolvedActionId("", eligible)).toBeNull();
    expect(validateResolvedActionId(undefined, eligible)).toBeNull();
    expect(validateResolvedActionId(null, eligible)).toBeNull();
  });

  it("a caller with no eligible actions can resolve nothing", () => {
    expect(validateResolvedActionId("advance_application", [])).toBeNull();
  });
});

describe("IRIS-A3 param sanitizer — strips ids, keeps draft scalars", () => {
  it("drops known id-typed keys and any uuid-looking value", () => {
    const clean = sanitizeDraftParams({
      applicationId: UUID,
      requisitionId: UUID,
      candidateId: UUID,
      targetStage: "tech_interview",
      reason: "strong hire",
      // A uuid smuggled under a non-id key is still stripped.
      note: UUID,
      numberOfOpenings: 2,
    });
    expect(clean).toEqual({
      targetStage: "tech_interview",
      reason: "strong hire",
      numberOfOpenings: 2,
    });
    expect(clean.applicationId).toBeUndefined();
    expect(clean.requisitionId).toBeUndefined();
    expect(clean.note).toBeUndefined();
  });

  it("drops empty / null / undefined values", () => {
    const clean = sanitizeDraftParams({ reason: "", title: null, seniority: undefined, ok: "yes" });
    expect(clean).toEqual({ ok: "yes" });
  });
});

describe("IRIS-A3 assembleDraftParams — only the action's own fields, sanitized", () => {
  it("keeps only advance_application's draft fields and strips a smuggled id", () => {
    const raw: IrisIntentResponse = {
      actionId: "advance_application",
      targetStage: "tech_interview",
      reason: "strong",
      // Fields that belong to OTHER actions must not leak into this action's params.
      fromStage: "recruiter_review",
      title: "Backend Engineer",
    };
    const params = assembleDraftParams("advance_application", raw);
    expect(params).toEqual({ targetStage: "tech_interview", reason: "strong" });
  });

  it("returns {} when no action resolved", () => {
    expect(assembleDraftParams(null, { actionId: "" })).toEqual({});
  });

  it("carries create_requisition_jd's scalar fields", () => {
    const params = assembleDraftParams("create_requisition_jd", {
      title: "Backend Engineer",
      locationType: "hybrid",
      numberOfOpenings: 3,
      seniority: "Senior",
    });
    expect(params).toEqual({
      title: "Backend Engineer",
      locationType: "hybrid",
      numberOfOpenings: 3,
      seniority: "Senior",
    });
  });
});

describe("IRIS-A3 hints + degrade", () => {
  it("extracts trimmed, capped candidate/requisition query seeds (never ids)", () => {
    const hints = extractHints({
      candidateQuery: "  Priya Nair  ",
      requisitionQuery: "Backend Engineer",
    });
    expect(hints).toEqual({ candidateQuery: "Priya Nair", requisitionQuery: "Backend Engineer" });
    // Absent seeds are omitted (no empty strings).
    expect(extractHints({ candidateQuery: "   " })).toEqual({});
  });

  it("degradedResolution is the calm no-action 'use the menu' shape", () => {
    const d = degradedResolution();
    expect(d.actionId).toBeNull();
    expect(d.params).toEqual({});
    expect(d.hints).toEqual({});
    expect(d.message).toBe(IRIS_INTENT_DEGRADED_MESSAGE);
  });
});

describe("IRIS-A3 hint map covers the NL-proposable actions", () => {
  it("every prompt-hint id is a real registry action, and message_candidate is intentionally menu-only", () => {
    const registryIds = new Set(listIrisActions().map((a) => a.id));
    // No STRAY hint that isn't a whitelisted action — the NL resolver can never
    // propose something outside the registry.
    for (const id of ALL_ACTION_IDS) {
      expect(registryIds.has(id), `${id} is a registry action`).toBe(true);
    }
    // Every registry action EXCEPT the MENU-ONLY ones is NL-proposable. Those
    // menu-only actions are deliberately excluded from the natural-language
    // resolver (buildIrisIntentPrompt filters to hinted ids, so the model never
    // sees them and validateResolvedActionId would null them):
    //   - message_candidate drafts + sends a real candidate email behind an
    //     explicit human Confirm;
    //   - hold_requisition / resume_requisition are reversible lifecycle changes
    //     driven from the menu's requisition picker, not free text.
    //   - the Tier-A contextual actions (request_documents / request_offer_approval
    //     / cancel_interview) are driven from menu pickers (doc-type multi-select,
    //     offer picker, interview picker), not natural language.
    const registryWithoutHint = [...registryIds].filter((id) => !ALL_ACTION_IDS.includes(id));
    expect(registryWithoutHint.sort()).toEqual(
      [
        "message_candidate",
        "hold_requisition",
        "resume_requisition",
        "request_documents",
        "request_offer_approval",
        "cancel_interview",
      ].sort(),
    );
  });
});
