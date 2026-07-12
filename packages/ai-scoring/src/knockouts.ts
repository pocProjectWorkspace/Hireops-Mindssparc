/**
 * Knockout evaluator for AI-03.
 *
 * Pure function — no DB, no AI call. Given a parsed CV
 * (resume-schema.ts shape from `@hireops/ai-client`) and an ordered
 * list of requisition knockouts, return whether the candidate passed
 * each one + the overall verdict.
 *
 * Source contract: Wave 1 only handles `source = 'parsed_cv'`. Knockouts
 * with `candidate_asserted` or `partner_asserted` are skipped silently
 * here — the apply form doesn't collect candidate-asserted answers
 * (CRS-01 scope fence), and partner channels submit via a separate path
 * not in scope.
 *
 * field_path convention: every knockout's `threshold_value` jsonb
 * carries a `field_path` string (added in AI-03 — older
 * `requisition_knockouts` rows seeded before AI-03 lacked it). The
 * path is a dot-separated walk into the `ParserOutput` shape, e.g.
 *   "total_years_experience"
 *   "personal.location_country"
 *   "skills.technical"
 *   "notice_period_days"
 *
 * Type dispatch:
 *
 *   boolean      → threshold = { field_path, required: true }
 *                  value at path is truthy (non-null, non-empty, etc.)
 *
 *   numeric_min  → threshold = { field_path, min: <number> }
 *                  value must be a number AND value ≥ min.
 *
 *   numeric_max  → threshold = { field_path, max: <number> }
 *                  value must be a number AND value ≤ max.
 *
 *   enum         → threshold = { field_path, allowed: [<string>, ...] }
 *                  EITHER value is a string in allowed,
 *                  OR value is an array of strings with non-empty
 *                     intersection with allowed.
 *
 * Per-knockout result:
 *   - true   → passed
 *   - false  → failed (will appear in `knockout_failures`)
 *   - null   → not evaluable (missing field, wrong type, malformed
 *              threshold). Treated as "no signal" — not a fail.
 *
 * Overall verdict (mirrors the ticket's locked logic):
 *   - passed = true   when every knockout returned true (or there are
 *     no knockouts at all).
 *   - passed = false  when ANY knockout returned false.
 *   - passed = null   when at least one knockout returned null AND
 *     none returned false (we lack signal to confidently pass).
 *
 * Both false-results and null-results land in `failures` so the
 * recruiter detail view can render the full evaluation. Each entry
 * carries enough context (path, threshold, actual) to debug without
 * a second query.
 */

const SOURCE_PARSED_CV = "parsed_cv" as const;

export type KnockoutType = "boolean" | "numeric_min" | "numeric_max" | "enum";

export interface KnockoutInput {
  /** The requisition_knockouts row id. */
  id: string;
  type: KnockoutType;
  /**
   * Free-text question shown to the recruiter. Carried through to the
   * failure entry so the drawer can render "you failed: <question>".
   */
  questionText?: string | null;
  /**
   * `requisition_knockouts.source`. Only 'parsed_cv' is evaluated by
   * AI-03; other sources resolve to `null` (not evaluated).
   */
  source: string;
  /**
   * `requisition_knockouts.threshold_value`. Shape varies by type
   * (see file header). Parsed defensively at evaluation time so a
   * malformed jsonb resolves to `null` rather than throwing.
   */
  thresholdValue: unknown;
}

export type KnockoutResult = true | false | null;

/**
 * Why a knockout returned non-true. `result: false` entries are real
 * fails; `result: null` entries are "not evaluable". Both appear in
 * `applications.knockout_failures` so the drawer can show the whole
 * picture without a second query.
 */
export interface KnockoutFailureEntry {
  knockout_id: string;
  type: KnockoutType;
  field_path: string | null;
  question_text: string | null;
  result: false | null;
  reason: KnockoutFailureReason;
  /** Actual value resolved at field_path. Omitted when reason makes it meaningless. */
  actual?: unknown;
  /** Threshold portion of threshold_value (min / max / allowed / required). */
  threshold?: unknown;
}

export type KnockoutFailureReason =
  | "field_missing"
  | "field_unexpected_type"
  | "value_falsy"
  | "value_below_min"
  | "value_above_max"
  | "value_not_in_allowed"
  | "malformed_threshold"
  | "source_not_parsed_cv";

export interface KnockoutEvaluation {
  /** Overall verdict for the application. true / false / null. */
  passed: KnockoutResult;
  /**
   * Every non-pass entry — both false (real fails) and null (no signal).
   * Sorted in the input order (i.e. the recruiter's listed order on the
   * requisition).
   */
  failures: KnockoutFailureEntry[];
  /** Counters for callers that want them (logging, observability). */
  evaluated_count: number;
  fail_count: number;
  null_count: number;
}

/**
 * Resolve a dot-separated path inside the parsed CV. Returns undefined
 * for any path that walks through a non-object, hits a missing key, or
 * lands on null/undefined.
 *
 * Exported for the test suite — also useful in unit tests that want to
 * verify "the path resolution is the bit that's broken, not the
 * comparator."
 */
export function getByPath(root: unknown, path: string): unknown {
  if (root == null || typeof root !== "object") return undefined;
  const parts = path.split(".");
  let cur: unknown = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" || Array.isArray(cur)) {
      // Bail on array — the convention doesn't index arrays. A field
      // path that needs an array element should use a numeric like
      // "work_history.0.title" (not supported in v1) or use a higher-
      // level abstraction.
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Boolean-knockout truthiness: empty arrays/strings count as falsy. */
function isTruthyForBoolean(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.length > 0;
  return Boolean(v);
}

/** Read field_path off threshold_value defensively. Returns null if absent. */
function readFieldPath(thresholdValue: unknown): string | null {
  if (!thresholdValue || typeof thresholdValue !== "object") return null;
  const fp = (thresholdValue as Record<string, unknown>).field_path;
  return typeof fp === "string" && fp.length > 0 ? fp : null;
}

function makeFailure(
  k: KnockoutInput,
  fieldPath: string | null,
  result: false | null,
  reason: KnockoutFailureReason,
  extras: { actual?: unknown; threshold?: unknown } = {},
): KnockoutFailureEntry {
  return {
    knockout_id: k.id,
    type: k.type,
    field_path: fieldPath,
    question_text: k.questionText ?? null,
    result,
    reason,
    ...(Object.prototype.hasOwnProperty.call(extras, "actual") ? { actual: extras.actual } : {}),
    ...(extras.threshold !== undefined ? { threshold: extras.threshold } : {}),
  };
}

/**
 * Evaluate a single knockout against the parsed CV. Returns either
 * true (pass) or a failure entry (false-result or null-result).
 */
function evaluateOne(parsedCv: unknown, k: KnockoutInput): true | KnockoutFailureEntry {
  if (k.source !== SOURCE_PARSED_CV) {
    return makeFailure(k, readFieldPath(k.thresholdValue), null, "source_not_parsed_cv");
  }
  const fieldPath = readFieldPath(k.thresholdValue);
  if (!fieldPath) {
    return makeFailure(k, null, null, "malformed_threshold", {
      threshold: k.thresholdValue,
    });
  }
  const value = getByPath(parsedCv, fieldPath);
  if (value === undefined || value === null) {
    return makeFailure(k, fieldPath, null, "field_missing");
  }

  const tv = k.thresholdValue as Record<string, unknown>;

  if (k.type === "boolean") {
    if (isTruthyForBoolean(value)) return true;
    return makeFailure(k, fieldPath, false, "value_falsy", {
      actual: value,
      threshold: { required: true },
    });
  }

  if (k.type === "numeric_min") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return makeFailure(k, fieldPath, null, "field_unexpected_type", {
        actual: value,
        threshold: { min: tv.min },
      });
    }
    if (typeof tv.min !== "number") {
      return makeFailure(k, fieldPath, null, "malformed_threshold", {
        threshold: k.thresholdValue,
      });
    }
    if (value >= tv.min) return true;
    return makeFailure(k, fieldPath, false, "value_below_min", {
      actual: value,
      threshold: { min: tv.min },
    });
  }

  if (k.type === "numeric_max") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return makeFailure(k, fieldPath, null, "field_unexpected_type", {
        actual: value,
        threshold: { max: tv.max },
      });
    }
    if (typeof tv.max !== "number") {
      return makeFailure(k, fieldPath, null, "malformed_threshold", {
        threshold: k.thresholdValue,
      });
    }
    if (value <= tv.max) return true;
    return makeFailure(k, fieldPath, false, "value_above_max", {
      actual: value,
      threshold: { max: tv.max },
    });
  }

  if (k.type === "enum") {
    const allowed = tv.allowed;
    if (!Array.isArray(allowed) || allowed.length === 0) {
      return makeFailure(k, fieldPath, null, "malformed_threshold", {
        threshold: k.thresholdValue,
      });
    }
    const allowedSet = new Set(allowed as unknown[]);
    if (typeof value === "string") {
      if (allowedSet.has(value)) return true;
      return makeFailure(k, fieldPath, false, "value_not_in_allowed", {
        actual: value,
        threshold: { allowed },
      });
    }
    if (Array.isArray(value)) {
      const hit = value.some((v) => allowedSet.has(v));
      if (hit) return true;
      return makeFailure(k, fieldPath, false, "value_not_in_allowed", {
        actual: value,
        threshold: { allowed },
      });
    }
    return makeFailure(k, fieldPath, null, "field_unexpected_type", {
      actual: value,
      threshold: { allowed },
    });
  }

  // Exhaustiveness — adding a KnockoutType without a case breaks here.
  const _exhaustive: never = k.type;
  void _exhaustive;
  return makeFailure(k, fieldPath, null, "malformed_threshold");
}

/**
 * Run all knockouts and produce the overall verdict + failure list.
 * Pure: no DB writes, no AI calls. Caller writes the result onto
 * `applications.knockout_passed` / `knockout_failures` /
 * `knockout_evaluated_at`.
 */
export function evaluateKnockouts(
  parsedCv: unknown,
  knockouts: KnockoutInput[],
): KnockoutEvaluation {
  const failures: KnockoutFailureEntry[] = [];
  let failCount = 0;
  let nullCount = 0;
  for (const k of knockouts) {
    const r = evaluateOne(parsedCv, k);
    if (r === true) continue;
    failures.push(r);
    if (r.result === false) failCount += 1;
    else nullCount += 1;
  }
  let passed: KnockoutResult;
  if (failCount > 0) passed = false;
  else if (nullCount > 0) passed = null;
  else passed = true;
  return {
    passed,
    failures,
    evaluated_count: knockouts.length,
    fail_count: failCount,
    null_count: nullCount,
  };
}
