/**
 * HROPS-02 — deterministic comp rule engine (PURE unit suite, no DB, no AI).
 *
 * Pins every branch of the rules contract in apps/api/src/lib/comp-rules.ts:
 *
 *   1. expected ≤ band mid       → proceed, suggested = expected (floored at min)
 *   2. band mid < expected ≤ max → negotiate, suggested = midpoint(mid, expected)
 *   3. expected > band max       → need_approval, suggested = band max
 *
 * Plus boundary values, the band-min floor, clamping under incoherent bands,
 * canEvaluateComp gating, and bandMidpointPaise rounding. All money INR paise.
 */

import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import {
  evaluateComp,
  canEvaluateComp,
  bandMidpointPaise,
  COMP_VERDICTS,
} from "../src/lib/comp-rules";

// A ₹20–30 LPA band: min 20L, mid 25L, max 30L (paise).
const L = 100_000 * 100; // 1 lakh in paise
const BAND = { bandMinPaise: 20 * L, bandMidPaise: 25 * L, bandMaxPaise: 30 * L };

describe("HROPS-02 comp rule engine (pure)", () => {
  it("exports the three-verdict vocabulary", () => {
    assert.deepEqual([...COMP_VERDICTS], ["proceed", "negotiate", "need_approval"]);
  });

  it("Rule 1: expected below band mid → proceed at the ask", () => {
    const r = evaluateComp({ expectedPaise: 22 * L, ...BAND });
    assert.equal(r.verdict, "proceed");
    assert.equal(r.suggestedPaise, 22 * L);
    assert.ok(r.reasons.length >= 1, "carries at least one reason");
  });

  it("Rule 1 boundary: expected EXACTLY at band mid → proceed", () => {
    const r = evaluateComp({ expectedPaise: 25 * L, ...BAND });
    assert.equal(r.verdict, "proceed");
    assert.equal(r.suggestedPaise, 25 * L);
  });

  it("Rule 1 floor: expected below band min → proceed, suggestion raised to the floor", () => {
    const r = evaluateComp({ expectedPaise: 15 * L, ...BAND });
    assert.equal(r.verdict, "proceed");
    assert.equal(r.suggestedPaise, 20 * L, "floored at band min");
    assert.equal(r.reasons.length, 2, "extra reason explains the floor");
  });

  it("Rule 2: expected in the upper half → negotiate, meet midway between mid and ask", () => {
    const r = evaluateComp({ expectedPaise: 29 * L, ...BAND });
    assert.equal(r.verdict, "negotiate");
    assert.equal(r.suggestedPaise, 27 * L, "midpoint of mid(25) and expected(29)");
    assert.equal(r.reasons.length, 2);
  });

  it("Rule 2 boundary: expected EXACTLY at band max → negotiate (not approval)", () => {
    const r = evaluateComp({ expectedPaise: 30 * L, ...BAND });
    assert.equal(r.verdict, "negotiate");
    assert.equal(r.suggestedPaise, Math.round((25 * L + 30 * L) / 2));
  });

  it("Rule 2 rounding: odd paise midpoints round to whole paise", () => {
    const r = evaluateComp({
      expectedPaise: 25 * L + 3,
      ...BAND,
    });
    assert.equal(r.verdict, "negotiate");
    assert.equal(r.suggestedPaise, Math.round((25 * L + 25 * L + 3) / 2));
    assert.ok(Number.isInteger(r.suggestedPaise));
  });

  it("Rule 3: expected above band max → need_approval, suggestion capped at band max", () => {
    const r = evaluateComp({ expectedPaise: 36 * L, ...BAND });
    assert.equal(r.verdict, "need_approval");
    assert.equal(r.suggestedPaise, 30 * L, "capped at band max");
    assert.equal(r.reasons.length, 2);
    assert.ok(
      r.reasons.some((x) => x.toLowerCase().includes("approval")),
      "reason mentions the approval requirement",
    );
  });

  it("Rule 3 boundary: one paisa over the max tips into need_approval", () => {
    const r = evaluateComp({ expectedPaise: 30 * L + 1, ...BAND });
    assert.equal(r.verdict, "need_approval");
    assert.equal(r.suggestedPaise, 30 * L);
  });

  it("clamps into the band even under an incoherent band (min > max)", () => {
    const r = evaluateComp({
      expectedPaise: 50 * L,
      bandMinPaise: 30 * L,
      bandMidPaise: 25 * L,
      bandMaxPaise: 20 * L, // incoherent: max < min
    });
    assert.ok(r.suggestedPaise >= 20 * L && r.suggestedPaise <= 30 * L, "clamped into [lo, hi]");
  });

  it("reasons cite LPA-formatted figures (human, band-anchored)", () => {
    const r = evaluateComp({ expectedPaise: 22 * L, ...BAND });
    assert.ok(
      r.reasons.some((x) => x.includes("₹") && x.includes("LPA")),
      `reasons carry ₹…LPA figures: ${JSON.stringify(r.reasons)}`,
    );
  });

  it("canEvaluateComp: true only when all numbers are present, finite and positive", () => {
    assert.equal(
      canEvaluateComp({ expectedPaise: 22 * L, bandMinPaise: 20 * L, bandMaxPaise: 30 * L }),
      true,
    );
    assert.equal(
      canEvaluateComp({ expectedPaise: null, bandMinPaise: 20 * L, bandMaxPaise: 30 * L }),
      false,
      "no expected salary → not evaluable",
    );
    assert.equal(
      canEvaluateComp({ expectedPaise: 22 * L, bandMinPaise: null, bandMaxPaise: 30 * L }),
      false,
      "no band min → not evaluable",
    );
    assert.equal(
      canEvaluateComp({ expectedPaise: 22 * L, bandMinPaise: 20 * L, bandMaxPaise: null }),
      false,
      "no band max → not evaluable",
    );
    assert.equal(
      canEvaluateComp({ expectedPaise: 0, bandMinPaise: 20 * L, bandMaxPaise: 30 * L }),
      false,
      "zero expected → not evaluable",
    );
    assert.equal(
      canEvaluateComp({ expectedPaise: 22 * L, bandMinPaise: 20 * L, bandMaxPaise: 0 }),
      false,
      "zero band max → not evaluable",
    );
  });

  it("bandMidpointPaise: (min+max)/2 rounded to whole paise", () => {
    assert.equal(bandMidpointPaise(20 * L, 30 * L), 25 * L);
    assert.equal(bandMidpointPaise(1, 2), 2, "rounds half up to whole paise");
  });

  it("is deterministic — same input, same output, no mutation", () => {
    const input = { expectedPaise: 29 * L, ...BAND };
    const a = evaluateComp(input);
    const b = evaluateComp(input);
    assert.deepEqual(a, b);
    assert.deepEqual(input, { expectedPaise: 29 * L, ...BAND }, "input not mutated");
  });
});
