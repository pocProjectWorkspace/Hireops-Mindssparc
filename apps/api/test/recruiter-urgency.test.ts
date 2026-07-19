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
