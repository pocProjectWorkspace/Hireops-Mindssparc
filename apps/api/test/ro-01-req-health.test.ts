/**
 * RO-01 — deterministic requisition health + difficulty rule engine (PURE unit
 * suite, no DB, no AI). Pins every component + boundary of
 * apps/api/src/lib/req-health.ts against the documented weights/thresholds.
 */

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import {
  computeReqHealth,
  computeReqDifficulty,
  countNicheSkills,
  REQ_HEALTH_WEIGHTS,
  REQ_APPROVAL_STATUS_POINTS,
  type ReqHealthInput,
} from "../src/lib/req-health";

/** A fully-complete, live requisition — should score at or near 100. */
function fullInput(): ReqHealthInput {
  return {
    jd: { hasText: true, hasSummary: true, sectionCount: 3 },
    skills: { count: 6, weightedCount: 6, mustHaveCount: 3 },
    interviewPlan: { configured: true, roundCount: 3 },
    budget: { hasBand: true },
    approvalStatus: "approved",
    pipeline: { candidatesInFlight: 8 },
  };
}

/** A blank draft — should score 0. */
function emptyInput(): ReqHealthInput {
  return {
    jd: { hasText: false, hasSummary: false, sectionCount: 0 },
    skills: { count: 0, weightedCount: 0, mustHaveCount: 0 },
    interviewPlan: { configured: false, roundCount: 0 },
    budget: { hasBand: false },
    approvalStatus: "draft",
    pipeline: { candidatesInFlight: 0 },
  };
}

function componentEarned(input: ReqHealthInput, key: string): number {
  const c = computeReqHealth(input).components.find((x) => x.key === key);
  assert.ok(c, `component ${key} present`);
  return c.earned;
}

describe("RO-01 health rule engine (pure)", () => {
  it("weights sum to 100", () => {
    const sum = Object.values(REQ_HEALTH_WEIGHTS).reduce((s, w) => s + w, 0);
    assert.equal(sum, 100);
  });

  it("a fully-complete live req scores 100", () => {
    const r = computeReqHealth(fullInput());
    assert.equal(r.score, 100);
    // every component maxed
    for (const c of r.components) assert.equal(c.earned, c.max, `${c.key} maxed`);
  });

  it("a blank draft scores 0", () => {
    assert.equal(computeReqHealth(emptyInput()).score, 0);
  });

  it("score is always within [0,100] and equals the component sum", () => {
    const r = computeReqHealth(fullInput());
    const sum = r.components.reduce((s, c) => s + c.earned, 0);
    assert.equal(r.score, sum);
    assert.ok(r.score >= 0 && r.score <= 100);
  });

  it("JD: text (10) + summary (4) + full sections (6) = 20; text-only = 10", () => {
    const base = emptyInput();
    assert.equal(
      componentEarned({ ...base, jd: { hasText: true, hasSummary: false, sectionCount: 0 } }, "jd"),
      10,
    );
    assert.equal(
      componentEarned({ ...base, jd: { hasText: true, hasSummary: true, sectionCount: 3 } }, "jd"),
      20,
    );
    // section count is clamped at 3
    assert.equal(
      componentEarned({ ...base, jd: { hasText: true, hasSummary: true, sectionCount: 9 } }, "jd"),
      20,
    );
  });

  it("Skills: presence up to 3 (8) + weighted share (7)", () => {
    const base = emptyInput();
    // 3 skills all weighted → 8 + 7 = 15
    assert.equal(
      componentEarned(
        { ...base, skills: { count: 3, weightedCount: 3, mustHaveCount: 0 } },
        "skills",
      ),
      15,
    );
    // 3 skills, none weighted → 8 + 0
    assert.equal(
      componentEarned(
        { ...base, skills: { count: 3, weightedCount: 0, mustHaveCount: 0 } },
        "skills",
      ),
      8,
    );
    // 1 skill weighted → round(1/3*8)=3 + 7 = 10
    assert.equal(
      componentEarned(
        { ...base, skills: { count: 1, weightedCount: 1, mustHaveCount: 0 } },
        "skills",
      ),
      10,
    );
  });

  it("Must-haves: binary 10 when ≥1 required skill, else 0", () => {
    const base = emptyInput();
    assert.equal(
      componentEarned(
        { ...base, skills: { count: 2, weightedCount: 2, mustHaveCount: 0 } },
        "mustHaves",
      ),
      0,
    );
    assert.equal(
      componentEarned(
        { ...base, skills: { count: 2, weightedCount: 2, mustHaveCount: 1 } },
        "mustHaves",
      ),
      10,
    );
  });

  it("Interview plan: 15 only when configured AND ≥1 round", () => {
    const base = emptyInput();
    assert.equal(
      componentEarned(
        { ...base, interviewPlan: { configured: true, roundCount: 0 } },
        "interviewPlan",
      ),
      0,
    );
    assert.equal(
      componentEarned(
        { ...base, interviewPlan: { configured: false, roundCount: 2 } },
        "interviewPlan",
      ),
      0,
    );
    assert.equal(
      componentEarned(
        { ...base, interviewPlan: { configured: true, roundCount: 1 } },
        "interviewPlan",
      ),
      15,
    );
  });

  it("Budget: binary 15 when a band is set", () => {
    const base = emptyInput();
    assert.equal(componentEarned({ ...base, budget: { hasBand: false } }, "budget"), 0);
    assert.equal(componentEarned({ ...base, budget: { hasBand: true } }, "budget"), 15);
  });

  it("Approval: status-mapped points; unknown/null → 0", () => {
    const base = emptyInput();
    assert.equal(
      componentEarned({ ...base, approvalStatus: "pending_approval" }, "approval"),
      REQ_APPROVAL_STATUS_POINTS.pending_approval,
    );
    assert.equal(componentEarned({ ...base, approvalStatus: "approved" }, "approval"), 15);
    assert.equal(
      componentEarned({ ...base, approvalStatus: "on_hold" }, "approval"),
      REQ_APPROVAL_STATUS_POINTS.on_hold,
    );
    assert.equal(componentEarned({ ...base, approvalStatus: "cancelled" }, "approval"), 0);
    assert.equal(componentEarned({ ...base, approvalStatus: null }, "approval"), 0);
    assert.equal(componentEarned({ ...base, approvalStatus: "nonsense" }, "approval"), 0);
  });

  it("Pipeline: banded 0 / 5 / 8 / 10 by candidates in flight", () => {
    const base = emptyInput();
    assert.equal(componentEarned({ ...base, pipeline: { candidatesInFlight: 0 } }, "pipeline"), 0);
    assert.equal(componentEarned({ ...base, pipeline: { candidatesInFlight: 1 } }, "pipeline"), 5);
    assert.equal(componentEarned({ ...base, pipeline: { candidatesInFlight: 2 } }, "pipeline"), 5);
    assert.equal(componentEarned({ ...base, pipeline: { candidatesInFlight: 3 } }, "pipeline"), 8);
    assert.equal(componentEarned({ ...base, pipeline: { candidatesInFlight: 5 } }, "pipeline"), 8);
    assert.equal(componentEarned({ ...base, pipeline: { candidatesInFlight: 6 } }, "pipeline"), 10);
  });
});

describe("RO-01 difficulty rule engine (pure)", () => {
  it("no signals → low", () => {
    assert.equal(
      computeReqDifficulty({ mustHaveCount: 1, nicheSkillCount: 0, budgetVsBenchmarkPct: 110 }),
      "low",
    );
  });

  it("all signals maxed → high", () => {
    assert.equal(
      computeReqDifficulty({ mustHaveCount: 8, nicheSkillCount: 5, budgetVsBenchmarkPct: 70 }),
      "high",
    );
  });

  it("a single strong signal → medium", () => {
    assert.equal(
      computeReqDifficulty({ mustHaveCount: 8, nicheSkillCount: 0, budgetVsBenchmarkPct: 120 }),
      "medium",
    );
  });

  it("must-have banding: >5 = 2pts, 3-5 = 1pt, <3 = 0", () => {
    // 6 must-haves alone = 2pts → medium
    assert.equal(
      computeReqDifficulty({ mustHaveCount: 6, nicheSkillCount: 0, budgetVsBenchmarkPct: null }),
      "medium",
    );
    // 4 must-haves alone = 1pt → low
    assert.equal(
      computeReqDifficulty({ mustHaveCount: 4, nicheSkillCount: 0, budgetVsBenchmarkPct: null }),
      "low",
    );
  });

  it("budget banding: below 85% of median pushes hardest", () => {
    // budget at 80% = 2pts + 3 niche = 2pts → high
    assert.equal(
      computeReqDifficulty({ mustHaveCount: 0, nicheSkillCount: 3, budgetVsBenchmarkPct: 80 }),
      "high",
    );
    // at/above median = 0 budget pts; 3 niche alone = 2pts → medium
    assert.equal(
      computeReqDifficulty({ mustHaveCount: 0, nicheSkillCount: 3, budgetVsBenchmarkPct: 100 }),
      "medium",
    );
  });

  it("null budget contributes no points (honest neutral)", () => {
    assert.equal(
      computeReqDifficulty({ mustHaveCount: 1, nicheSkillCount: 0, budgetVsBenchmarkPct: null }),
      "low",
    );
  });
});

describe("RO-01 countNicheSkills (pure)", () => {
  it("common skills are never niche", () => {
    assert.equal(countNicheSkills(["JavaScript", "SQL", "React"], []), 0);
  });

  it("skills in the benchmark's trending list are not niche", () => {
    assert.equal(countNicheSkills(["Rust", "Kubernetes"], ["rust", "kubernetes"]), 0);
  });

  it("skills absent from both common + benchmark are niche", () => {
    // COBOL + Fortran unknown → 2 niche; SQL is common → not counted
    assert.equal(countNicheSkills(["COBOL", "Fortran", "SQL"], ["python"]), 2);
  });

  it("normalisation ignores case/punctuation and blanks", () => {
    assert.equal(countNicheSkills(["  react.js ", "", "Node.js"], []), 1); // react.js not in list, node.js is common
  });
});
