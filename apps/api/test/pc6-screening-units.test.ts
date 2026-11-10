/**
 * PC-6 / PC-4 — the PURE half of the screening drain + read policy. NO
 * DATABASE: nothing here imports bootstrap or @hireops/db, so it runs anywhere
 * (`npx vitest run test/pc6-screening-units.test.ts` from apps/api). It lives
 * here because apps/workers has no test runner of its own.
 *
 * The evidence engine itself (criteria, quote verification, verdict downgrade,
 * sort key, prompt) is unit-tested in packages/ai-scoring/test/
 * screening-evidence.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_SCORE_CONCURRENCY,
  resolveAiScoreConcurrency,
  runWithConcurrency,
} from "../../../apps/workers/src/lib/concurrency.js";

describe("PC-4 — bounded concurrency", () => {
  it("never exceeds the limit, keeps input order, and reaches the limit when work allows", async () => {
    let inFlight = 0;
    let observedMax = 0;
    let peak = -1;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await runWithConcurrency(
      items,
      4,
      async (i) => {
        inFlight += 1;
        observedMax = Math.max(observedMax, inFlight);
        await new Promise((r) => setTimeout(r, 5 + (i % 3) * 3));
        inFlight -= 1;
        return i * 2;
      },
      (p) => {
        peak = p;
      },
    );
    expect(out).toEqual(items.map((i) => i * 2));
    expect(observedMax).toBe(4);
    expect(peak).toBe(4);
  });

  it("a rejected item rejects the run (the drain's per-row function never throws)", async () => {
    await expect(
      runWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });

  it("handles an empty list and a limit larger than the list", async () => {
    expect(await runWithConcurrency([], 8, async (i: number) => i)).toEqual([]);
    let peak = 0;
    await runWithConcurrency(
      [1, 2],
      8,
      async (i) => i,
      (p) => {
        peak = p;
      },
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("AI_SCORE_DRAIN_CONCURRENCY overrides the default within 1–32", () => {
    expect(DEFAULT_AI_SCORE_CONCURRENCY).toBe(8);
    expect(resolveAiScoreConcurrency({})).toBe(8);
    expect(resolveAiScoreConcurrency({ AI_SCORE_DRAIN_CONCURRENCY: "12" })).toBe(12);
    expect(resolveAiScoreConcurrency({ AI_SCORE_DRAIN_CONCURRENCY: "0" })).toBe(8);
    expect(resolveAiScoreConcurrency({ AI_SCORE_DRAIN_CONCURRENCY: "abc" })).toBe(8);
    expect(resolveAiScoreConcurrency({ AI_SCORE_DRAIN_CONCURRENCY: "500" })).toBe(32);
  });
});
