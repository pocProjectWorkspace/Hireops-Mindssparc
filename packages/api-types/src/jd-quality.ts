/**
 * JD quality heuristics (RO-02, wizard v2 JD editor "quality strip").
 *
 * Three deterministic, dependency-light scores computed over the structured
 * JD sections. Pure functions with NO AI call and NO randomness — the same
 * input always yields the same output — so they are unit-testable and honest
 * (they measure the text, they do not fabricate a "quality" number).
 *
 *   1. Completeness — the share of editor sections that carry content.
 *   2. Readability  — a documented sentence-length + word-complexity heuristic.
 *   3. Bias         — derived ENTIRELY from the REAL tenant bias-lexicon scan
 *      (summarizeScan); this module does not invent its own bias detection.
 *
 * Lives in @hireops/api-types (pure zod-free helpers) so both the portal JD
 * editor and the api test import one implementation.
 */

import { JD_SECTION_META, type JdSectionKey, type JdSections } from "./procedures";
import type { JdBiasScan } from "./bias-lexicon";

export interface JdQualityScore {
  /** 0–100, rounded. */
  pct: number;
}

// ─────────────────────────── Completeness ───────────────────────────

export interface JdCompleteness extends JdQualityScore {
  filled: number;
  total: number;
  /** Which sections are still empty (for the "what's missing" hint). */
  emptyKeys: JdSectionKey[];
}

/** True when a section holds usable content (non-blank text / ≥1 non-blank item). */
export function isSectionFilled(sections: JdSections, key: JdSectionKey): boolean {
  const v = sections[key];
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.some((s) => typeof s === "string" && s.trim().length > 0);
  return false;
}

/**
 * Completeness = filled sections / total sections, as a percentage.
 *
 * "Total" is the full JD_SECTION_META set (7 sections). Every non-empty
 * section counts once; a list section counts as filled if it has ≥1 non-blank
 * item. Deterministic and trivially explainable in the UI ("5 of 7 sections").
 */
export function computeJdCompleteness(sections: JdSections): JdCompleteness {
  const keys = JD_SECTION_META.map((m) => m.key);
  const emptyKeys: JdSectionKey[] = [];
  let filled = 0;
  for (const key of keys) {
    if (isSectionFilled(sections, key)) filled += 1;
    else emptyKeys.push(key);
  }
  const total = keys.length;
  return { filled, total, emptyKeys, pct: total === 0 ? 0 : Math.round((filled / total) * 100) };
}

// ─────────────────────────── Readability ───────────────────────────

/** Flatten all section text into one corpus + a per-"sentence" list. Each
 * list item is treated as its own sentence; the summary is split on
 * sentence-ending punctuation. */
function collectSentences(sections: JdSections): string[] {
  const out: string[] = [];
  const summary = sections.summary?.trim();
  if (summary) {
    for (const s of summary.split(/(?<=[.!?])\s+/)) {
      const t = s.trim();
      if (t.length > 0) out.push(t);
    }
  }
  for (const m of JD_SECTION_META) {
    if (m.kind !== "list") continue;
    const arr = sections[m.key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const t = typeof item === "string" ? item.trim() : "";
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.replace(/[^A-Za-z0-9]/g, "").length > 0);
}

export interface JdReadability extends JdQualityScore {
  avgSentenceLength: number;
  complexWordRatio: number;
  sentenceCount: number;
  wordCount: number;
}

/**
 * Readability heuristic (deterministic). Two ingredients, both cheap and
 * language-agnostic enough for JD prose:
 *
 *   avgSentenceLength = totalWords / sentenceCount
 *   complexWordRatio  = (# words ≥ 12 characters) / totalWords
 *
 * (A ≥12-character word is our proxy for "complex" — it avoids a full
 * syllable counter while tracking dense, jargon-heavy phrasing.)
 *
 * Score, clamped to 0–100 and rounded:
 *
 *   pct = 100
 *       − 3 × max(0, avgSentenceLength − 14)   // long sentences read worse;
 *                                              //   14 words is the "free" band
 *       − 120 × complexWordRatio               // dense vocabulary penalised
 *
 * Empty JD → 0. A short, plain JD (≤14-word sentences, few long words) scores
 * near 100; a wall of 30-word sentences full of long compound terms drops fast.
 * The constants (3 per over-long word, 120 for full jargon) are tuned so a
 * typical clean JD lands ~80–95 and an obviously dense one lands ~40–60.
 */
export function computeJdReadability(sections: JdSections): JdReadability {
  const sentences = collectSentences(sections);
  const allWords = sentences.flatMap((s) => words(s));
  const wordCount = allWords.length;
  const sentenceCount = sentences.length;
  if (wordCount === 0 || sentenceCount === 0) {
    return { pct: 0, avgSentenceLength: 0, complexWordRatio: 0, sentenceCount: 0, wordCount: 0 };
  }
  const avgSentenceLength = wordCount / sentenceCount;
  const complexWords = allWords.filter((w) => w.replace(/[^A-Za-z0-9]/g, "").length >= 12).length;
  const complexWordRatio = complexWords / wordCount;
  const raw = 100 - 3 * Math.max(0, avgSentenceLength - 14) - 120 * complexWordRatio;
  const pct = Math.round(Math.max(0, Math.min(100, raw)));
  return {
    pct,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    complexWordRatio: Math.round(complexWordRatio * 1000) / 1000,
    sentenceCount,
    wordCount,
  };
}

// ─────────────────────────── Bias (real scan) ───────────────────────────

export interface JdBiasScoreResult extends JdQualityScore {
  blockingCount: number;
  warnCount: number;
  /** True when the lexicon is disabled for this tenant (score is N/A). */
  disabled: boolean;
}

/**
 * Bias score derived from the REAL tenant lexicon scan (summarizeScan) — this
 * module never invents its own detection. Distinct flagged terms each subtract
 * from a perfect 100:
 *
 *   pct = clamp(100 − 20 × distinctBlockingTerms − 8 × distinctWarnTerms, 0, 100)
 *
 * A clean JD (or an `off` lexicon) scores 100. When enforcement is `off` the
 * score is reported as 100 with `disabled: true` so the UI can label it "not
 * enforced" rather than implying a real pass.
 */
export function computeJdBiasScore(scan: JdBiasScan | null): JdBiasScoreResult {
  if (!scan || scan.enforcement === "off") {
    return { pct: 100, blockingCount: 0, warnCount: 0, disabled: true };
  }
  // Distinct terms by term+category (mirrors the wizard's distinctMatches).
  const seen = new Set<string>();
  let blockingCount = 0;
  let warnCount = 0;
  for (const m of scan.matches) {
    const key = `${m.term.toLowerCase()}|${m.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.severity === "block") blockingCount += 1;
    else warnCount += 1;
  }
  const raw = 100 - 20 * blockingCount - 8 * warnCount;
  return {
    pct: Math.round(Math.max(0, Math.min(100, raw))),
    blockingCount,
    warnCount,
    disabled: false,
  };
}
