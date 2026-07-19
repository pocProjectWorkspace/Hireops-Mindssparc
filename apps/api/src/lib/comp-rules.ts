/**
 * Deterministic compensation rule engine (HROPS-02).
 *
 * A PURE function — no DB, no AI, no side effects — that turns a candidate's
 * expected salary and the role's comp band into an authoritative verdict +
 * suggested number + human reasons. This is the load-bearing decision on the
 * Comp & offer desk: the AI (comp_recommendation) writes only PROSE around this
 * verdict; it never changes it. Deterministic-rule-engine-for-verdicts is the
 * standing HireOps discipline (mirrors the knockout evaluator + the offer
 * approval gate) — no AI theatre in a number a recruiter negotiates against.
 *
 * MONEY: everything here is INR paise (minor units, integers), the same unit
 * offers.base_salary_inr_paise + applications.expected_salary_inr_paise store.
 * Callers convert positions' MAJOR-unit comp band (rupees) → paise before
 * calling. The band mid is (min+max)/2 unless the caller supplies one.
 *
 * THE RULES (documented as the CONTRACT — the unit test pins every branch):
 *
 *   1. expected ≤ band mid      → PROCEED
 *        The ask is at or under the midpoint — no negotiation friction.
 *        suggested = expected, floored at band min (never offer below the band).
 *
 *   2. band mid < expected ≤ max → NEGOTIATE
 *        The ask is in the upper half of the band — reachable but worth a
 *        conversation. suggested = midpoint of [band mid, expected] (meet in
 *        the middle), rounded to whole paise.
 *
 *   3. expected > band max       → NEED_APPROVAL
 *        The ask exceeds the band — an out-of-band offer needs HR-head sign-off
 *        (the offer-extend gate enforces this server-side). suggested = band max
 *        (the most the band alone authorises).
 *
 * When the four numbers aren't all available (no expected salary captured, or
 * no comp band on the position) the verdict is NOT computable — callers use
 * `canEvaluateComp` and render an honest "add an expected salary / comp band"
 * empty state rather than inventing a verdict.
 */

export const COMP_VERDICTS = ["proceed", "negotiate", "need_approval"] as const;
export type CompVerdict = (typeof COMP_VERDICTS)[number];

export interface CompRuleInput {
  /** Candidate's expected salary, INR paise. */
  expectedPaise: number;
  /** Role comp band lower bound, INR paise. */
  bandMinPaise: number;
  /** Role comp band midpoint, INR paise. Usually (min+max)/2. */
  bandMidPaise: number;
  /** Role comp band upper bound, INR paise. */
  bandMaxPaise: number;
}

export interface CompRuleResult {
  verdict: CompVerdict;
  /** The number the desk pre-fills into the offer composer, INR paise. */
  suggestedPaise: number;
  /** Plain, band-anchored explanations — rendered verbatim under the verdict. */
  reasons: string[];
}

/** ₹ label for a paise amount inside a reason string (e.g. "₹24.0 LPA"). */
function lpa(paise: number): string {
  const lakhsPerAnnum = paise / 100 / 100_000;
  return `₹${lakhsPerAnnum.toFixed(1).replace(/\.0$/, "")} LPA`;
}

/**
 * Compute the deterministic comp verdict. Pure. All inputs paise; result paise.
 * Defensive: a caller that passes an incoherent band (min > max) still gets a
 * coherent result — we clamp the suggestion into [min, max] at the end.
 */
export function evaluateComp(input: CompRuleInput): CompRuleResult {
  const { expectedPaise, bandMinPaise, bandMidPaise, bandMaxPaise } = input;

  let verdict: CompVerdict;
  let suggestedPaise: number;
  const reasons: string[] = [];

  if (expectedPaise <= bandMidPaise) {
    verdict = "proceed";
    suggestedPaise = Math.max(expectedPaise, bandMinPaise);
    reasons.push(
      `Expected ${lpa(expectedPaise)} is at or below the band midpoint ${lpa(bandMidPaise)} — proceed at the ask.`,
    );
    if (expectedPaise < bandMinPaise) {
      reasons.push(
        `Ask is below the band floor ${lpa(bandMinPaise)}; suggestion raised to the floor.`,
      );
    }
  } else if (expectedPaise <= bandMaxPaise) {
    verdict = "negotiate";
    suggestedPaise = Math.round((bandMidPaise + expectedPaise) / 2);
    reasons.push(
      `Expected ${lpa(expectedPaise)} sits in the upper half of the band (mid ${lpa(bandMidPaise)} – max ${lpa(bandMaxPaise)}).`,
    );
    reasons.push(
      `Suggested ${lpa(suggestedPaise)} meets the candidate midway between the band mid and their ask.`,
    );
  } else {
    verdict = "need_approval";
    suggestedPaise = bandMaxPaise;
    reasons.push(
      `Expected ${lpa(expectedPaise)} exceeds the band ceiling ${lpa(bandMaxPaise)} — out-of-band.`,
    );
    reasons.push(
      `An out-of-band offer needs HR-head approval before it can be extended. Suggestion capped at the band max ${lpa(bandMaxPaise)}.`,
    );
  }

  // Clamp into the band so an incoherent band can't produce a nonsensical
  // suggestion. need_approval intentionally suggests exactly the ceiling.
  const lo = Math.min(bandMinPaise, bandMaxPaise);
  const hi = Math.max(bandMinPaise, bandMaxPaise);
  suggestedPaise = Math.min(Math.max(suggestedPaise, lo), hi);

  return { verdict, suggestedPaise, reasons };
}

/**
 * True when a verdict can be computed — all four numbers present and finite,
 * and the band is non-degenerate. Callers gate on this before evaluateComp so
 * the desk shows an honest "no expected salary / no comp band" state instead of
 * a fabricated verdict.
 */
export function canEvaluateComp(input: {
  expectedPaise: number | null;
  bandMinPaise: number | null;
  bandMaxPaise: number | null;
}): input is { expectedPaise: number; bandMinPaise: number; bandMaxPaise: number } {
  return (
    input.expectedPaise != null &&
    Number.isFinite(input.expectedPaise) &&
    input.expectedPaise > 0 &&
    input.bandMinPaise != null &&
    Number.isFinite(input.bandMinPaise) &&
    input.bandMaxPaise != null &&
    Number.isFinite(input.bandMaxPaise) &&
    input.bandMaxPaise > 0
  );
}

/** Band midpoint helper — (min+max)/2 rounded to whole paise. */
export function bandMidpointPaise(bandMinPaise: number, bandMaxPaise: number): number {
  return Math.round((bandMinPaise + bandMaxPaise) / 2);
}
