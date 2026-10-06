/**
 * Skill matching — does a person's parsed skills COVER a named JD skill?
 * PURE + DETERMINISTIC: no DB, no AI, no clock.
 *
 * This is a VERBATIM EXTRACTION (LD-2A) of the comparison that has lived inside
 * `buildRequisitionInsights` since RO-03 and drives the live Insights skill-gap
 * chart. It moved here for one reason only: `getSuggestedLearningForCase`
 * (LD-2A) needs the SAME answer for a single hire that the chart gives for a
 * requisition's whole candidate pool, and two copies of a fuzzy matcher would
 * drift the moment either was touched.
 *
 * The semantics are therefore FROZEN, not improved. In particular:
 *
 *   - tokens are `String.trim().toLowerCase()`, nothing else — no stemming, no
 *     punctuation stripping, no synonym table, no fuzzy distance;
 *   - only string entries of `parsed_skills.skills` count, and a non-array /
 *     non-object / null `parsed_skills` yields an EMPTY set rather than
 *     throwing;
 *   - the match is TWO-WAY containment (`t === needle || t.includes(needle) ||
 *     needle.includes(t)`), so "kubernetes" covers a JD skill "Kubernetes
 *     (K8s)"… and equally "java" covers "javascript". That looseness is
 *     deliberate in a % gap chart and is preserved here on purpose. Do not
 *     tighten it without re-baselining test/ro-03.test.ts (Test 4) and the
 *     demo the chart appears in.
 *
 * NOTE for callers that reason about ONE person: an empty token set matches
 * NOTHING, so every JD skill reads as "missing". For the pool chart that is
 * correct (Insights filters out candidates with a null `parsed_skills` before
 * counting). For a single hire it is NOT — an unparsed CV must degrade to "no
 * gaps identified", never to a false 100%-gap wall. Guard on `tokens.size === 0`
 * at the call site; that is a caller's policy decision, not this module's.
 */

/**
 * The display skill names from a candidate's `parsed_skills`, in their stored
 * case. Accepts every shape in use: a bare string array (early parser output),
 * `{ skills: string[] }` (seeds and imports), and the AI parser's
 * `{ skills: { technical, domain, ... } }`. Anything else yields [].
 */
export function parsedSkillNames(parsed: unknown): string[] {
  const strings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];
  if (Array.isArray(parsed)) return strings(parsed);
  if (!parsed || typeof parsed !== "object") return [];
  const skills = (parsed as Record<string, unknown>).skills;
  if (Array.isArray(skills)) return strings(skills);
  if (skills && typeof skills === "object") {
    const s = skills as Record<string, unknown>;
    return [...strings(s.technical), ...strings(s.domain)];
  }
  return [];
}

/**
 * Case-insensitive skill tokens from a candidate's `parsed_skills.skills`
 * array. Defensive by design — `parsed_skills` is AI-written jsonb and may be
 * null, a bare object, or carry non-string entries.
 */
export function parsedSkillTokens(parsed: unknown): Set<string> {
  const out = new Set<string>();
  if (parsed && typeof parsed === "object") {
    const skills = (parsed as Record<string, unknown>).skills;
    if (Array.isArray(skills)) {
      for (const s of skills) {
        if (typeof s === "string") out.add(s.trim().toLowerCase());
      }
    }
  }
  return out;
}

/** A JD skill name reduced to the comparable form used against the tokens. */
export function skillNeedle(skillName: string): string {
  return skillName.trim().toLowerCase();
}

/**
 * The frozen two-way containment test: does any token cover this needle?
 * `needle` must already be normalised (see `skillNeedle`).
 */
export function tokensMatchNeedle(tokens: Set<string>, needle: string): boolean {
  return Array.from(tokens).some((t) => t === needle || t.includes(needle) || needle.includes(t));
}

/** Convenience: `tokensMatchNeedle(tokens, skillNeedle(skillName))`. */
export function tokensCoverSkill(tokens: Set<string>, skillName: string): boolean {
  return tokensMatchNeedle(tokens, skillNeedle(skillName));
}
