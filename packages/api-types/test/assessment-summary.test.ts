/**
 * PC-11 / PC-12 pure helpers: recommendation counts, human-rating averages, the
 * panellist disclosure rule, the reason resolver and the decision → stage plan.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELECTION_DECISION_REASONS,
  averageCriteria,
  countRecommendations,
  findSelectionDecisionReason,
  panellistDisclosureFor,
  planSelectionDecision,
  resolveSelectionDecisionReasons,
  type RawPanelFeedback,
} from "../src/assessment-summary";

function fb(p: Partial<RawPanelFeedback> & { membershipId: string }): RawPanelFeedback {
  return {
    name: null,
    isLead: false,
    feedbackState: "submitted",
    recommendation: null,
    scores: {},
    strengths: null,
    concerns: null,
    notes: null,
    submittedAt: null,
    ...p,
  };
}

describe("countRecommendations", () => {
  it("counts submitted scorecards only; drafts never count", () => {
    const r = countRecommendations([
      fb({ membershipId: "a", recommendation: "strong_yes" }),
      fb({ membershipId: "b", recommendation: "yes" }),
      fb({ membershipId: "c", recommendation: "no" }),
      fb({ membershipId: "d", recommendation: "yes", feedbackState: "draft" }),
      fb({ membershipId: "e", feedbackState: "none" }),
    ]);
    expect(r.counts).toEqual({ strong_yes: 1, yes: 1, hold: 0, no: 1 });
    expect(r.submittedCount).toBe(3);
    expect(r.positiveCount).toBe(2);
  });
});

describe("averageCriteria", () => {
  const criteria = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
  ];
  it("averages submitted human ratings to 1 dp; unrated → null", () => {
    const out = averageCriteria(criteria, [
      fb({ membershipId: "x", scores: { a: 4 } }),
      fb({ membershipId: "y", scores: { a: 3 } }),
      fb({ membershipId: "z", scores: { a: 1, b: 5 }, feedbackState: "draft" }),
    ]);
    expect(out).toEqual([
      { key: "a", label: "A", average: 3.5, ratingCount: 2 },
      { key: "b", label: "B", average: null, ratingCount: 0 },
    ]);
  });
});

describe("panellistDisclosureFor", () => {
  it("own entry is always full", () => {
    expect(panellistDisclosureFor(fb({ membershipId: "me" }), "me", false)).toBe("full");
  });
  it("others hidden until the viewer has submitted", () => {
    expect(panellistDisclosureFor(fb({ membershipId: "o" }), "me", false)).toBe("hidden");
  });
  it("after submitting: others' submitted feedback in summary form, drafts stay hidden", () => {
    expect(panellistDisclosureFor(fb({ membershipId: "o" }), "me", true)).toBe("summary");
    expect(
      panellistDisclosureFor(fb({ membershipId: "o", feedbackState: "draft" }), "me", true),
    ).toBe("hidden");
  });
});

describe("resolveSelectionDecisionReasons", () => {
  it("absent / malformed / empty → platform default", () => {
    const n = DEFAULT_SELECTION_DECISION_REASONS.length;
    expect(resolveSelectionDecisionReasons(undefined)).toHaveLength(n);
    expect(resolveSelectionDecisionReasons({ reasons: "nope" })).toHaveLength(n);
    expect(resolveSelectionDecisionReasons({ reasons: [] })).toHaveLength(n);
  });
  it("a configured list replaces the default; duplicate keys keep the first", () => {
    const out = resolveSelectionDecisionReasons({
      reasons: [
        { key: "budget", label: "Budget", appliesTo: ["on_hold"] },
        { key: "budget", label: "Dup", appliesTo: ["selected"] },
      ],
    });
    expect(out).toEqual([{ key: "budget", label: "Budget", appliesTo: ["on_hold"] }]);
  });
  it("findSelectionDecisionReason enforces appliesTo", () => {
    const r = resolveSelectionDecisionReasons(undefined);
    expect(findSelectionDecisionReason(r, "not_selected", "skills_gap")?.key).toBe("skills_gap");
    expect(findSelectionDecisionReason(r, "selected", "skills_gap")).toBeNull();
    expect(findSelectionDecisionReason(r, "selected", "missing")).toBeNull();
  });
});

describe("planSelectionDecision", () => {
  it("selected → offer_drafted (record-only when already there)", () => {
    expect(planSelectionDecision("selected", "tech_interview")).toEqual({
      ok: true,
      targetStage: "offer_drafted",
    });
    expect(planSelectionDecision("selected", "hr_round")).toEqual({
      ok: true,
      targetStage: "offer_drafted",
    });
    expect(planSelectionDecision("selected", "offer_drafted")).toEqual({
      ok: true,
      targetStage: null,
    });
  });
  it("not_selected → recruiter_rejected; on_hold records only", () => {
    expect(planSelectionDecision("not_selected", "hr_round")).toEqual({
      ok: true,
      targetStage: "recruiter_rejected",
    });
    expect(planSelectionDecision("on_hold", "tech_interview")).toEqual({
      ok: true,
      targetStage: null,
    });
  });
  it("refused before interviews and on closed applications", () => {
    for (const s of ["shortlisted", "recruiter_rejected", "offer_accepted", "withdrawn"] as const) {
      expect(planSelectionDecision("on_hold", s).ok).toBe(false);
    }
  });
});
