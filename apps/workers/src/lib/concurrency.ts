/**
 * PC-4 — bounded-concurrency helpers for the ai-score drain. PURE: no db, no
 * io, so apps/api/test/pc6-screening-evidence-units.test.ts can exercise them
 * without a database.
 */

/**
 * PC-4 — rows scored in parallel per pass. Each row is one model call of
 * ~15–30 s, so throughput is roughly concurrency × 120–240 rows/hour; 8 keeps
 * well inside a standard Anthropic rate tier and the default pg pool (10).
 */
export const DEFAULT_AI_SCORE_CONCURRENCY = 8;
const MAX_AI_SCORE_CONCURRENCY = 32;

/** AI_SCORE_DRAIN_CONCURRENCY (1–32), else DEFAULT_AI_SCORE_CONCURRENCY. */
export function resolveAiScoreConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AI_SCORE_DRAIN_CONCURRENCY;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_AI_SCORE_CONCURRENCY;
  return Math.min(n, MAX_AI_SCORE_CONCURRENCY);
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Results keep input
 * order. `onPeak` reports the highest in-flight count observed (tests).
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onPeak?: (peak: number) => void,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let inFlight = 0;
  let peak = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        results[i] = await fn(items[i] as T);
      } finally {
        inFlight -= 1;
      }
    }
  });
  await Promise.all(lanes);
  onPeak?.(peak);
  return results;
}
