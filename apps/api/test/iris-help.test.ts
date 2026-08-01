import { describe, it, expect } from "vitest";
import {
  buildIrisHelpPrompt,
  validateSuggestedAction,
  citedTitlesFor,
  degradedHelp,
  IRIS_HELP_DEGRADED_MESSAGE,
  type IrisHelpEligibleAction,
} from "../src/lib/iris/iris-help";
import {
  capabilityEntriesForRoles,
  CAPABILITY_MAP,
  type CapabilityEntry,
} from "../src/lib/iris/capability-map";

/**
 * IRIS-HELP pure units. The help resolver's honesty guarantees are enforced by
 * these pure helpers (grounding, eligible-only handoff, honest citations), so
 * they're testable without a live model or DB.
 */

const entries: CapabilityEntry[] = [
  {
    id: "e1",
    title: "Reject a candidate",
    roles: ["recruiter"],
    route: "/candidates",
    summary: "End one candidate's application.",
    steps: ["Open the candidate.", "Enter a reason and confirm."],
    relatedActionId: "reject_application",
  },
  {
    id: "e2",
    title: "What Iris can do",
    roles: [],
    summary: "Iris runs actions you confirm.",
    steps: ["Click Ask Iris."],
  },
];

const eligibleActions: IrisHelpEligibleAction[] = [
  { id: "reject_application", label: "Reject candidate" },
  { id: "advance_application", label: "Advance candidate" },
];

describe("capabilityEntriesForRoles", () => {
  it("includes universal (empty-roles) entries for everyone", () => {
    const ids = capabilityEntriesForRoles([]).map((e) => e.id);
    expect(ids).toContain("ask-iris");
  });

  it("gates role-specific entries to the matching role", () => {
    const recruiter = capabilityEntriesForRoles(["recruiter"]).map((e) => e.id);
    const panel = capabilityEntriesForRoles(["panel_member"]).map((e) => e.id);
    expect(recruiter).toContain("reject-candidate");
    expect(panel).not.toContain("reject-candidate");
  });

  it("every relatedActionId in the map is a non-empty string (real registry id)", () => {
    for (const e of CAPABILITY_MAP) {
      if (e.relatedActionId !== undefined) {
        expect(typeof e.relatedActionId).toBe("string");
        expect(e.relatedActionId.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("buildIrisHelpPrompt", () => {
  it("grounds the prompt in the given entries + eligible action ids, and instructs strict answering", () => {
    const { system, user } = buildIrisHelpPrompt({
      entries,
      eligibleActions,
      question: "How do I reject someone?",
      context: { route: "/candidates" },
    });
    expect(system).toMatch(/ONLY the/i);
    expect(system).toMatch(/NEVER invent/i);
    expect(user).toContain("e1");
    expect(user).toContain("reject_application (Reject candidate)");
    expect(user).toContain("How do I reject someone?");
    expect(user).toContain("/candidates");
  });
});

describe("validateSuggestedAction", () => {
  it("returns the action when eligible", () => {
    expect(validateSuggestedAction("reject_application", eligibleActions)).toEqual({
      id: "reject_application",
      label: "Reject candidate",
    });
  });

  it("drops an ineligible or hallucinated id", () => {
    expect(validateSuggestedAction("delete_everything", eligibleActions)).toBeNull();
    expect(validateSuggestedAction(undefined, eligibleActions)).toBeNull();
  });
});

describe("citedTitlesFor", () => {
  it("maps ids to titles, drops unknowns, and dedupes", () => {
    expect(citedTitlesFor(["e1", "nope", "e1", "e2"], entries)).toEqual([
      "Reject a candidate",
      "What Iris can do",
    ]);
    expect(citedTitlesFor(undefined, entries)).toEqual([]);
  });
});

describe("degradedHelp", () => {
  it("returns a calm answer with no action handoff", () => {
    expect(degradedHelp()).toEqual({
      answer: IRIS_HELP_DEGRADED_MESSAGE,
      suggestedActionId: null,
      suggestedActionLabel: null,
      citedTitles: [],
    });
  });
});
