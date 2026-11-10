import { describe, expect, it } from "vitest";
import {
  PLATFORM_RECOMMENDATION_LABELS,
  PLATFORM_STAGE_LABELS,
  defaultTenantLabels,
  resolveRecommendationLabel,
  resolveRecommendationLabelMap,
  resolveStageLabel,
  resolveStageLabelMap,
  resolveTenantLabels,
  updateTenantLabelsInputSchema,
} from "../src/tenant-labels";
import {
  SCREENING_SCORE_BANDS_DEFAULT,
  resolveAiSettings,
  screeningScoreTier,
  updateTenantAiSettingsInputSchema,
} from "../src/ai-settings";
import { resolveEffectiveShortlistDefaults } from "../src/admin-ops";

/**
 * CFG-LITE — the display-label resolver (tenants.settings.labels) and the one
 * score cut-off setting (aiSettings.screeningScoreBands). Resolution rule:
 * tenant value → else platform default; the resolver never throws.
 */

describe("resolveTenantLabels", () => {
  it("absent / garbage → no overrides (platform defaults)", () => {
    for (const raw of [undefined, null, "x", 42, [], { stages: "nope" }, { stages: [1, 2] }]) {
      expect(resolveTenantLabels(raw)).toEqual(defaultTenantLabels());
    }
  });

  it("keeps a partial override and drops bad entries one at a time", () => {
    const out = resolveTenantLabels({
      stages: {
        shortlisted: { staff: "  Longlist  ", candidate: "", partner: 7 },
        not_a_stage: { staff: "Ignored" },
        hr_round: { staff: "x".repeat(41) }, // over 40 chars → dropped
        tech_interview: "not an object",
      },
      recommendations: { strong_yes: "Accept", maybe: "Ignored", hold: "   " },
    });
    expect(out.stages).toEqual({ shortlisted: { staff: "Longlist" } });
    expect(out.recommendations).toEqual({ strong_yes: "Accept" });
  });
});

describe("resolveStageLabel", () => {
  const labels = resolveTenantLabels({
    stages: { shortlisted: { candidate: "Next step" } },
  });

  it("platform defaults equal today's wording per audience", () => {
    expect(resolveStageLabel(null, "tech_interview", "staff")).toBe("Panel interview");
    expect(resolveStageLabel(null, "recruiter_rejected", "staff")).toBe("Rejected");
    expect(resolveStageLabel(null, "recruiter_rejected", "candidate")).toBe("Not moving forward");
    expect(resolveStageLabel(null, "offer_drafted", "candidate")).toBe("Offer in preparation");
    expect(resolveStageLabel(null, "application_received", "partner")).toBe("Submitted");
    expect(resolveStageLabel(null, "offer_drafted", "partner")).toBe("Offer in progress");
  });

  it("an override applies to its audience only", () => {
    expect(resolveStageLabel(labels, "shortlisted", "candidate")).toBe("Next step");
    expect(resolveStageLabel(labels, "shortlisted", "staff")).toBe("Shortlisted");
    expect(resolveStageLabel(labels, "shortlisted", "partner")).toBe("Shortlisted");
  });

  it("an override beats a call-site fallback; the fallback beats the platform default", () => {
    expect(resolveStageLabel(labels, "shortlisted", "candidate", "Historic")).toBe("Next step");
    expect(resolveStageLabel(labels, "hr_round", "staff", "HR Round")).toBe("HR Round");
  });

  it("an unknown key degrades to itself, de-snaked — never throws", () => {
    expect(resolveStageLabel(null, "background_check", "staff")).toBe("Background check");
  });

  it("the map covers every stage", () => {
    const map = resolveStageLabelMap(labels, "candidate");
    expect(Object.keys(map).sort()).toEqual(Object.keys(PLATFORM_STAGE_LABELS).sort());
    expect(map.shortlisted).toBe("Next step");
  });
});

describe("resolveRecommendationLabel", () => {
  it("defaults, partial override, unknown value", () => {
    expect(resolveRecommendationLabelMap(null)).toEqual(PLATFORM_RECOMMENDATION_LABELS);
    const labels = resolveTenantLabels({ recommendations: { no: "Reject" } });
    expect(resolveRecommendationLabel(labels, "no")).toBe("Reject");
    expect(resolveRecommendationLabel(labels, "strong_yes")).toBe("Strong yes");
    expect(resolveRecommendationLabel(labels, "weird")).toBe("weird");
  });
});

describe("updateTenantLabelsInputSchema", () => {
  it("rejects an over-long label and an unknown stage on write", () => {
    expect(
      updateTenantLabelsInputSchema.safeParse({
        stages: { shortlisted: { staff: "x".repeat(41) } },
      }).success,
    ).toBe(false);
    expect(
      updateTenantLabelsInputSchema.safeParse({ stages: { not_a_stage: { staff: "X" } } }).success,
    ).toBe(false);
    expect(updateTenantLabelsInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("screeningScoreBands (BUG-11)", () => {
  it("platform default is 90 / 75 / 60 and resolves for an unconfigured tenant", () => {
    expect(SCREENING_SCORE_BANDS_DEFAULT).toEqual({ strong: 90, good: 75, partial: 60 });
    expect(resolveAiSettings(undefined).screeningScoreBands).toEqual({
      strong: 90,
      good: 75,
      partial: 60,
    });
  });

  it("partial override fills the rest from defaults", () => {
    expect(resolveAiSettings({ screeningScoreBands: { strong: 85 } }).screeningScoreBands).toEqual({
      strong: 85,
      good: 75,
      partial: 60,
    });
  });

  it("an out-of-order or garbage stored block resolves to defaults without breaking other keys", () => {
    const s = resolveAiSettings({
      piiMasking: false,
      screeningScoreBands: { strong: 50, good: 70, partial: 90 },
    });
    expect(s.screeningScoreBands).toEqual({ strong: 90, good: 75, partial: 60 });
    expect(s.piiMasking).toBe(false);
    expect(resolveAiSettings({ screeningScoreBands: "x" }).screeningScoreBands).toEqual(
      SCREENING_SCORE_BANDS_DEFAULT,
    );
  });

  it("the write schema rejects an out-of-order set", () => {
    expect(
      updateTenantAiSettingsInputSchema.safeParse({
        screeningScoreBands: { strong: 50, good: 70, partial: 90 },
      }).success,
    ).toBe(false);
  });

  it("screeningScoreTier buckets at inclusive floors", () => {
    const b = { strong: 80, good: 65, partial: 50 };
    expect(screeningScoreTier(80, b)).toBe("strong");
    expect(screeningScoreTier(79, b)).toBe("good");
    expect(screeningScoreTier(65, b)).toBe("good");
    expect(screeningScoreTier(50, b)).toBe("partial");
    expect(screeningScoreTier(49, b)).toBe("below");
  });

  it("the shortlist follows the bands unless it has its own saved cut-offs", () => {
    const bands = { strong: 80, good: 65, partial: 50 };
    const followed = resolveEffectiveShortlistDefaults(undefined, bands);
    expect(followed.threshold).toBe(65);
    expect(followed.tierCutoffs).toEqual({ excellent: 80, good: 65, partial: 50 });

    const own = resolveEffectiveShortlistDefaults(
      { threshold: 70, tierCutoffs: { excellent: 95, good: 85, partial: 70 } },
      bands,
    );
    expect(own.threshold).toBe(70);
    expect(own.tierCutoffs).toEqual({ excellent: 95, good: 85, partial: 70 });

    // No stored blocks at all → byte-identical to the historic 75 / 90 / 75 / 60.
    const historic = resolveEffectiveShortlistDefaults(undefined, SCREENING_SCORE_BANDS_DEFAULT);
    expect(historic.threshold).toBe(75);
    expect(historic.tierCutoffs).toEqual({ excellent: 90, good: 75, partial: 60 });
  });
});
