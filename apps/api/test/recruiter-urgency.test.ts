import { describe, it, expect } from "vitest";
import {
  computeRecruiterUrgency,
  noticePeriodLabel,
  matchTier,
  computeMustHavePct,
  computeRiskFlags,
  RECRUITER_URGENCY_WEIGHTS,
  URGENCY_SLA_POINTS,
  URGENCY_RANK_HIGH,
  URGENCY_RANK_MEDIUM,
  MATCH_TIER_EXCELLENT_MIN,
  MATCH_TIER_GOOD_MIN,
  MATCH_TIER_PARTIAL_MIN,
  RISK_SKILL_MISMATCH_MAX_PCT,
} from "../src/lib/recruiter-urgency";
import { defaultUrgencySettings, resolveUrgencySettings } from "@hireops/api-types";

describe("computeRecruiterUrgency", () => {
  it("weights sum to 100", () => {
    const total = Object.values(RECRUITER_URGENCY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it("caps the index at 100 for a maximally-urgent candidate", () => {
    const r = computeRecruiterUrgency({
      slaState: "breached",
      daysInStage: 30,
      noticePeriodDays: 0,
    });
    expect(r.index).toBe(100);
    expect(r.rank).toBe("high");
  });

  it("floors near zero for a fresh, unclocked, long-notice candidate", () => {
    const r = computeRecruiterUrgency({
      slaState: "none",
      daysInStage: 0,
      noticePeriodDays: 120,
    });
    expect(r.index).toBe(0);
    expect(r.rank).toBe("low");
  });

  it("returns an index equal to the sum of component earned points", () => {
    const r = computeRecruiterUrgency({
      slaState: "at_risk",
      daysInStage: 8,
      noticePeriodDays: 45,
    });
    const sum = r.components.reduce((a, c) => a + c.earned, 0);
    expect(r.index).toBe(sum);
    // at_risk(25) + 8d band(25) + 45d notice(8) = 58 → medium
    expect(r.index).toBe(58);
    expect(r.rank).toBe("medium");
  });

  it("maps every SLA state to its documented points", () => {
    for (const state of ["breached", "at_risk", "ok", "none"] as const) {
      const r = computeRecruiterUrgency({
        slaState: state,
        daysInStage: 0,
        noticePeriodDays: null,
      });
      const sla = r.components.find((c) => c.key === "sla");
      expect(sla?.earned).toBe(URGENCY_SLA_POINTS[state]);
    }
  });

  it("treats uncaptured notice as neutral (no points), not a guess", () => {
    const withNull = computeRecruiterUrgency({
      slaState: "ok",
      daysInStage: 2,
      noticePeriodDays: null,
    });
    const notice = withNull.components.find((c) => c.key === "notice");
    expect(notice?.earned).toBe(0);
    expect(notice?.note).toMatch(/not captured/i);
  });

  it("gives shorter notice strictly more urgency than longer notice", () => {
    const base = { slaState: "ok" as const, daysInStage: 2 };
    const immediate = computeRecruiterUrgency({ ...base, noticePeriodDays: 0 }).index;
    const short = computeRecruiterUrgency({ ...base, noticePeriodDays: 15 }).index;
    const long = computeRecruiterUrgency({ ...base, noticePeriodDays: 90 }).index;
    expect(immediate).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(long);
  });

  it("uses documented rank thresholds", () => {
    // Construct an index exactly at each boundary via SLA + days.
    const high = computeRecruiterUrgency({
      slaState: "breached",
      daysInStage: 7,
      noticePeriodDays: null,
    });
    expect(high.index).toBeGreaterThanOrEqual(URGENCY_RANK_HIGH);
    expect(high.rank).toBe("high");

    const medium = computeRecruiterUrgency({
      slaState: "at_risk",
      daysInStage: 5,
      noticePeriodDays: null,
    });
    expect(medium.index).toBeGreaterThanOrEqual(URGENCY_RANK_MEDIUM);
    expect(medium.index).toBeLessThan(URGENCY_RANK_HIGH);
    expect(medium.rank).toBe("medium");
  });

  it("clamps negative days-in-stage to zero", () => {
    const r = computeRecruiterUrgency({
      slaState: "none",
      daysInStage: -5,
      noticePeriodDays: 200,
    });
    expect(r.index).toBe(0);
  });
});

describe("noticePeriodLabel", () => {
  it("labels null / immediate / n days honestly", () => {
    expect(noticePeriodLabel(null)).toBe("Not captured");
    expect(noticePeriodLabel(0)).toBe("Immediate");
    expect(noticePeriodLabel(30)).toBe("30 days");
  });
});

describe("matchTier", () => {
  it("buckets scores at the documented boundaries", () => {
    expect(matchTier(MATCH_TIER_EXCELLENT_MIN)).toBe("excellent");
    expect(matchTier(MATCH_TIER_EXCELLENT_MIN - 1)).toBe("good");
    expect(matchTier(MATCH_TIER_GOOD_MIN)).toBe("good");
    expect(matchTier(MATCH_TIER_GOOD_MIN - 1)).toBe("partial");
    expect(matchTier(MATCH_TIER_PARTIAL_MIN)).toBe("partial");
    expect(matchTier(MATCH_TIER_PARTIAL_MIN - 1)).toBe("below");
  });

  it("returns null for an unscored application", () => {
    expect(matchTier(null)).toBeNull();
  });
});

describe("computeMustHavePct", () => {
  it("computes the share of must-have skills the candidate has", () => {
    expect(
      computeMustHavePct(["React", "TypeScript", "Node.js", "GraphQL"], ["react", "node.js"]),
    ).toBe(50);
  });

  it("is case- and spacing-insensitive", () => {
    expect(computeMustHavePct(["Project Management"], ["  project   management "])).toBe(100);
  });

  it("returns null when there are no must-have skills or no candidate skills", () => {
    expect(computeMustHavePct([], ["react"])).toBeNull();
    expect(computeMustHavePct(["react"], [])).toBeNull();
  });
});

describe("computeRiskFlags", () => {
  it("flags a skill mismatch at/below the threshold", () => {
    expect(
      computeRiskFlags({
        mustHavePct: RISK_SKILL_MISMATCH_MAX_PCT,
        expectedSalaryInrPaise: null,
        compBandMaxInrPaise: null,
      }),
    ).toContain("skill_mismatch");
    expect(
      computeRiskFlags({
        mustHavePct: RISK_SKILL_MISMATCH_MAX_PCT + 1,
        expectedSalaryInrPaise: null,
        compBandMaxInrPaise: null,
      }),
    ).not.toContain("skill_mismatch");
  });

  it("flags a salary gap when the ask exceeds the band ceiling", () => {
    expect(
      computeRiskFlags({
        mustHavePct: 100,
        expectedSalaryInrPaise: 5_000_000n,
        compBandMaxInrPaise: 4_000_000n,
      }),
    ).toEqual(["salary_gap"]);
  });

  it("does not fire flags when inputs are unknown (silence, not 'clear')", () => {
    expect(
      computeRiskFlags({
        mustHavePct: null,
        expectedSalaryInrPaise: null,
        compBandMaxInrPaise: null,
      }),
    ).toEqual([]);
  });

  it("can return both flags together", () => {
    expect(
      computeRiskFlags({
        mustHavePct: 20,
        expectedSalaryInrPaise: 9_000_000n,
        compBandMaxInrPaise: 6_000_000n,
      }),
    ).toEqual(["skill_mismatch", "salary_gap"]);
  });
});

// CFG-LITE / Plan A PP1 — the urgency policy (weights + notice bands) is a
// tenant setting; the platform default must reproduce the historic numbers.
describe("computeRecruiterUrgency — tenant urgency settings (CFG-LITE / PP1)", () => {
  const base = { slaState: "none" as const, daysInStage: 0 };

  it("pins the platform default: weights 40/35/25 and notice bands 0/15/30/60/90", () => {
    const d = defaultUrgencySettings();
    expect(d.weights).toEqual({ sla: 40, daysInStage: 35, notice: 25 });
    expect(d.noticeBands).toEqual([0, 15, 30, 60, 90]);
    expect(RECRUITER_URGENCY_WEIGHTS).toEqual({ sla: 40, daysInStage: 35, notice: 25 });
    // Historic notice points per band: 25 / 20 / 15 / 8 / 4 / 0.
    const pts = [0, 15, 30, 60, 90, 91].map(
      (n) =>
        computeRecruiterUrgency({ ...base, noticePeriodDays: n }).components.find(
          (c) => c.key === "notice",
        )?.earned,
    );
    expect(pts).toEqual([25, 20, 15, 8, 4, 0]);
  });

  it("omitting settings is identical to passing the platform default", () => {
    const input = { slaState: "at_risk" as const, daysInStage: 8, noticePeriodDays: 45 };
    expect(computeRecruiterUrgency(input, defaultUrgencySettings())).toEqual(
      computeRecruiterUrgency(input),
    );
    expect(computeRecruiterUrgency(input).index).toBe(58);
  });

  it("an override moves the notice bands: a 90-day notice earns points it did not before", () => {
    const longNoticeMarket = resolveUrgencySettings({
      weights: { sla: 40, daysInStage: 35, notice: 25 },
      noticeBands: [0, 30, 60, 90, 120],
    });
    const atDefault = computeRecruiterUrgency({ ...base, noticePeriodDays: 90 });
    const atOverride = computeRecruiterUrgency({ ...base, noticePeriodDays: 90 }, longNoticeMarket);
    const notice = (r: typeof atDefault) => r.components.find((c) => c.key === "notice");
    expect(notice(atDefault)?.earned).toBe(4);
    expect(notice(atOverride)?.earned).toBe(8); // band 4 of the override (32 % of 25)
  });

  it("an override re-weights the components and the max each component shows", () => {
    const s = resolveUrgencySettings({
      weights: { sla: 20, daysInStage: 30, notice: 50 },
      noticeBands: [0, 15, 30, 60, 90],
    });
    const r = computeRecruiterUrgency(
      { slaState: "breached", daysInStage: 30, noticePeriodDays: 0 },
      s,
    );
    const by = Object.fromEntries(r.components.map((c) => [c.key, c]));
    expect(by.sla?.max).toBe(20);
    expect(by.daysInStage?.max).toBe(30);
    expect(by.notice?.max).toBe(50);
    expect(by.sla?.earned).toBe(20);
    expect(by.notice?.earned).toBe(50);
    expect(r.index).toBe(r.components.reduce((a, c) => a + c.earned, 0));
    expect(r.index).toBeLessThanOrEqual(100);
  });

  it("resolveUrgencySettings: garbage → defaults; each field falls back on its own", () => {
    expect(resolveUrgencySettings(undefined)).toEqual(defaultUrgencySettings());
    expect(resolveUrgencySettings("nope")).toEqual(defaultUrgencySettings());
    expect(resolveUrgencySettings([1, 2])).toEqual(defaultUrgencySettings());
    const partial = resolveUrgencySettings({
      weights: { sla: 50, daysInStage: 50, notice: 50 }, // sums to 150 → default
      noticeBands: [0, 30, 60, 90, 120], // valid → kept
    });
    expect(partial.weights).toEqual({ sla: 40, daysInStage: 35, notice: 25 });
    expect(partial.noticeBands).toEqual([0, 30, 60, 90, 120]);
    const badBands = resolveUrgencySettings({
      weights: { sla: 30, daysInStage: 30, notice: 40 },
      noticeBands: [90, 60, 30, 15, 0], // descending → default
    });
    expect(badBands.weights).toEqual({ sla: 30, daysInStage: 30, notice: 40 });
    expect(badBands.noticeBands).toEqual([0, 15, 30, 60, 90]);
  });
});
