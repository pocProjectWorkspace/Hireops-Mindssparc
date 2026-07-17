/**
 * JD bias lexicon + deterministic scanner + configurable submit gate (CONF-02).
 *
 * A versioned `biasLexicon` block that lives inside `tenants.settings` jsonb
 * — a SIBLING to CONF-01's `aiSettings` and the incumbent `ai_provider` /
 * cosmetic config (never clobber those). It governs an honest, deterministic
 * inclusive-language layer over the requisition wizard's JD:
 *
 *   - a configurable lexicon of `{ term, category, severity, suggestion? }`
 *     entries, seeded with a professionally-sourced DEFAULT when the tenant
 *     has never written the block;
 *   - a pure `scanJdText` matcher (case-insensitive, whole-word / phrase,
 *     with positions) that runs IDENTICALLY client-side (wizard live
 *     highlights) and server-side (the submit gate) — this is why it lives in
 *     api-types (pure zod, no runtime deps, imported by both apps/api and the
 *     internal portal);
 *   - an `enforcement` master switch: `off` (no gate), `warn` (record matches,
 *     submission proceeds) or `block` (matches whose per-entry `severity` is
 *     `block` stop submission).
 *
 * There is deliberately NO demographic / fairness analysis here — we have no
 * data to support that honestly. This is a language-hygiene aid, not a
 * fairness claim.
 *
 * Enforcement vs per-entry severity — the two combine like this:
 *   enforcement `off`   → scanner never gates; nothing recorded.
 *   enforcement `warn`  → every match recorded as a warning; submit proceeds.
 *   enforcement `block` → matches with severity `block` block the submit
 *                         (BAD_REQUEST + suggestions); severity `warn`
 *                         matches are still only recorded, never blocking.
 * So a tenant on `block` can keep some terms advisory (`warn`) while hard-
 * gating the clearly discriminatory ones (`block`).
 *
 * Default enforcement is `warn`: honest and non-disruptive — a fresh tenant's
 * submissions always proceed, with any coded language surfaced to the HR head
 * in the approval queue. Flipping to `block` is an explicit admin choice.
 */

import { z } from "zod";

/** Bumped only when the block's SHAPE changes in a breaking way. */
export const BIAS_LEXICON_VERSION = 1 as const;

/**
 * The honest taxonomy. Each category names a well-established class of
 * exclusionary phrasing from inclusive-language guidance (gender-decoder
 * research, ableist-language guides, ageism guidance). No demographic
 * inference — these are properties of the TEXT, not of any candidate.
 */
export const BIAS_CATEGORIES = [
  "gendered",
  "age_coded",
  "exclusionary",
  "superlative_pressure",
] as const;
export const biasCategorySchema = z.enum(BIAS_CATEGORIES);
export type BiasCategory = z.infer<typeof biasCategorySchema>;

export const BIAS_CATEGORY_META: Record<BiasCategory, { label: string; description: string }> = {
  gendered: {
    label: "Gender-coded",
    description: "Masculine/feminine-coded wording that measurably skews who applies.",
  },
  age_coded: {
    label: "Age-coded",
    description: "Wording that signals a preferred age or career stage.",
  },
  exclusionary: {
    label: "Exclusionary",
    description: "Ableist, nativist or culture-fit phrasing that narrows the pool unfairly.",
  },
  superlative_pressure: {
    label: "Hype / pressure",
    description: "Rockstar-style hype and always-on pressure language that deters applicants.",
  },
};

/** Per-entry outcome. `block` can gate a submit (only under enforcement `block`). */
export const BIAS_SEVERITIES = ["warn", "block"] as const;
export const biasSeveritySchema = z.enum(BIAS_SEVERITIES);
export type BiasSeverity = z.infer<typeof biasSeveritySchema>;

/** The master switch on the whole gate. */
export const BIAS_ENFORCEMENT_MODES = ["off", "warn", "block"] as const;
export const biasEnforcementSchema = z.enum(BIAS_ENFORCEMENT_MODES);
export type BiasEnforcementMode = z.infer<typeof biasEnforcementSchema>;

export const biasLexiconEntrySchema = z.object({
  /** The word or phrase to match (case-insensitive, whole-word / phrase). */
  term: z.string().min(1).max(120),
  category: biasCategorySchema,
  severity: biasSeveritySchema.default("warn"),
  /** Optional inclusive rewrite shown to the author + HR head. */
  suggestion: z.string().max(300).optional(),
});
export type BiasLexiconEntry = z.infer<typeof biasLexiconEntrySchema>;

/**
 * The seeded DEFAULT lexicon (~50 entries), drawn from established
 * inclusive-language guidance (gender-decoder research, ableist- and
 * ageist-language guides). Used verbatim when the tenant has never written a
 * `biasLexicon` block. Curated, not placeholder junk: the clearly
 * discriminatory terms are `block`-severity, the coded-language nudges are
 * `warn`. A factory returns a fresh array so no caller mutates the seed.
 */
export function defaultBiasEntries(): BiasLexiconEntry[] {
  return [
    // ── superlative_pressure ──
    {
      term: "rockstar",
      category: "superlative_pressure",
      severity: "block",
      suggestion: "Describe the real responsibilities and the impact of the role.",
    },
    {
      term: "rock star",
      category: "superlative_pressure",
      severity: "block",
      suggestion: "Describe the real responsibilities and the impact of the role.",
    },
    {
      term: "ninja",
      category: "superlative_pressure",
      severity: "block",
      suggestion: "Name the actual skills the role needs.",
    },
    {
      term: "guru",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "State the level of expertise required.",
    },
    {
      term: "superstar",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Describe the outcomes you expect instead.",
    },
    {
      term: "wizard",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Name the specific expertise required.",
    },
    {
      term: "unicorn",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Describe the role honestly rather than as an impossible ideal.",
    },
    {
      term: "hero",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Describe the contribution you need, not heroics.",
    },
    {
      term: "world-class",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Be specific about the standard expected.",
    },
    {
      term: "hustle",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Describe the pace and expectations plainly.",
    },
    {
      term: "work hard play hard",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Describe the working culture concretely.",
    },
    {
      term: "whatever it takes",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Set clear, healthy expectations.",
    },
    {
      term: "grind",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Describe the workload honestly.",
    },
    {
      term: "crush it",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "State the goals you want met.",
    },
    {
      term: "no drama",
      category: "superlative_pressure",
      severity: "warn",
      suggestion: "Describe the collaboration style you value.",
    },
    // ── age_coded ──
    {
      term: "young",
      category: "age_coded",
      severity: "block",
      suggestion: "Focus on skills and experience, not age.",
    },
    {
      term: "youthful",
      category: "age_coded",
      severity: "block",
      suggestion: "Focus on skills and experience, not age.",
    },
    {
      term: "young and energetic",
      category: "age_coded",
      severity: "block",
      suggestion: "Describe the pace and drive the role needs, not an age.",
    },
    {
      term: "energetic",
      category: "age_coded",
      severity: "warn",
      suggestion: "Describe the pace or output expected instead.",
    },
    {
      term: "high-energy",
      category: "age_coded",
      severity: "warn",
      suggestion: "Describe the pace expected instead.",
    },
    {
      term: "recent graduate",
      category: "age_coded",
      severity: "block",
      suggestion: "Specify the experience level, e.g. 0–2 years.",
    },
    {
      term: "new grad",
      category: "age_coded",
      severity: "block",
      suggestion: "Specify the experience level, e.g. 0–2 years.",
    },
    {
      term: "digital native",
      category: "age_coded",
      severity: "block",
      suggestion: "Name the specific tools or skills required.",
    },
    {
      term: "fresh",
      category: "age_coded",
      severity: "warn",
      suggestion: "Describe the experience level directly.",
    },
    {
      term: "vibrant",
      category: "age_coded",
      severity: "warn",
      suggestion: "Describe the team or work concretely.",
    },
    {
      term: "mature",
      category: "age_coded",
      severity: "warn",
      suggestion: "Describe the experience level directly.",
    },
    {
      term: "seasoned",
      category: "age_coded",
      severity: "warn",
      suggestion: "State the years or depth of experience required.",
    },
    // ── gendered ──
    {
      term: "aggressive",
      category: "gendered",
      severity: "warn",
      suggestion: "Try 'focused' or 'proactive'.",
    },
    {
      term: "dominant",
      category: "gendered",
      severity: "warn",
      suggestion: "Try 'leading' or 'influential'.",
    },
    {
      term: "competitive",
      category: "gendered",
      severity: "warn",
      suggestion: "Try 'goal-oriented'.",
    },
    {
      term: "determined",
      category: "gendered",
      severity: "warn",
      suggestion: "Try 'committed' or 'persistent'.",
    },
    {
      term: "assertive",
      category: "gendered",
      severity: "warn",
      suggestion: "Describe the communication style you need.",
    },
    {
      term: "fearless",
      category: "gendered",
      severity: "warn",
      suggestion: "Describe the willingness to take on hard problems.",
    },
    {
      term: "manpower",
      category: "gendered",
      severity: "block",
      suggestion: "Use 'workforce', 'staff' or 'personnel'.",
    },
    {
      term: "man-hours",
      category: "gendered",
      severity: "warn",
      suggestion: "Use 'person-hours' or 'work hours'.",
    },
    {
      term: "chairman",
      category: "gendered",
      severity: "warn",
      suggestion: "Use 'chair' or 'chairperson'.",
    },
    { term: "salesman", category: "gendered", severity: "warn", suggestion: "Use 'salesperson'." },
    { term: "foreman", category: "gendered", severity: "warn", suggestion: "Use 'supervisor'." },
    {
      term: "workmanship",
      category: "gendered",
      severity: "warn",
      suggestion: "Use 'quality of work'.",
    },
    {
      term: "guys",
      category: "gendered",
      severity: "warn",
      suggestion: "Use 'everyone', 'team' or 'folks'.",
    },
    // ── exclusionary ──
    {
      term: "native English speaker",
      category: "exclusionary",
      severity: "block",
      suggestion: "Say 'fluent in English' or 'strong written and spoken English'.",
    },
    {
      term: "native speaker",
      category: "exclusionary",
      severity: "block",
      suggestion: "Describe the fluency level required, e.g. 'business-level English'.",
    },
    {
      term: "able-bodied",
      category: "exclusionary",
      severity: "block",
      suggestion: "State the actual physical requirements of the job, if any.",
    },
    {
      term: "clean-shaven",
      category: "exclusionary",
      severity: "block",
      suggestion: "Remove appearance requirements unrelated to the job.",
    },
    {
      term: "cultural fit",
      category: "exclusionary",
      severity: "warn",
      suggestion: "Try 'values alignment' or name the specific behaviours.",
    },
    {
      term: "culture fit",
      category: "exclusionary",
      severity: "warn",
      suggestion: "Try 'values alignment' or name the specific behaviours.",
    },
    {
      term: "no accent",
      category: "exclusionary",
      severity: "block",
      suggestion: "Remove accent requirements — they are discriminatory.",
    },
  ];
}

export const biasLexiconSchema = z.object({
  version: z.literal(BIAS_LEXICON_VERSION).default(BIAS_LEXICON_VERSION),
  enforcement: biasEnforcementSchema.default("warn"),
  /**
   * Absent → the seeded DEFAULT lexicon. A tenant who saves an explicit list
   * (even an empty one) has it honoured — the default only fills `undefined`.
   */
  entries: z.array(biasLexiconEntrySchema).max(500).default(defaultBiasEntries),
});
export type BiasLexicon = z.infer<typeof biasLexiconSchema>;

/** The effective lexicon when a tenant has never written the block. */
export function defaultBiasLexicon(): BiasLexicon {
  return biasLexiconSchema.parse({});
}

/**
 * Merge a raw stored `biasLexicon` block (partial / unknown / absent) with
 * defaults, returning a complete, validated lexicon. Malformed or
 * future-versioned blocks fall back to defaults rather than throwing — the
 * submit path must never break because a settings blob went stale (same
 * discipline as `resolveAiSettings`).
 */
export function resolveBiasLexicon(rawBlock: unknown): BiasLexicon {
  const parsed = biasLexiconSchema.safeParse(rawBlock ?? {});
  return parsed.success ? parsed.data : defaultBiasLexicon();
}

// ─────────────── the scanner (isomorphic: wizard + gate) ───────────────

export interface JdBiasMatch {
  /** The lexicon term that matched. */
  term: string;
  /** The exact substring matched in the text (preserves the author's case). */
  matchedText: string;
  category: BiasCategory;
  severity: BiasSeverity;
  suggestion: string | null;
  /** Character offsets into the scanned text. */
  start: number;
  end: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a lexicon term into a case-insensitive, global regex with
 * whole-word boundaries. Internal whitespace becomes `\s+` so a phrase
 * matches across any run of spaces/newlines. Word boundaries (`\b`) are only
 * added on edges that are word characters, so terms that begin/end with
 * punctuation still match. Returns null for a blank term.
 */
function termToRegex(term: string): RegExp | null {
  const t = term.trim();
  if (!t) return null;
  const escaped = escapeRegex(t).replace(/\s+/g, "\\s+");
  const left = /^[A-Za-z0-9]/.test(t) ? "\\b" : "";
  const right = /[A-Za-z0-9]$/.test(t) ? "\\b" : "";
  return new RegExp(`${left}${escaped}${right}`, "gi");
}

/**
 * Scan `text` for every lexicon entry. Case-insensitive, whole-word / whole-
 * phrase, returning every occurrence with its category, severity, suggestion
 * and character offsets. Overlapping matches from different entries are all
 * returned (e.g. both "energetic" and "young and energetic"). Deterministic:
 * results are sorted by start offset, then by longer match first. Pure — no
 * I/O, no shared state — so client and server produce identical results.
 */
export function scanJdText(text: string, entries: BiasLexiconEntry[]): JdBiasMatch[] {
  if (!text) return [];
  const matches: JdBiasMatch[] = [];
  for (const entry of entries) {
    const re = termToRegex(entry.term);
    if (!re) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push({
        term: entry.term,
        matchedText: m[0],
        category: entry.category,
        severity: entry.severity,
        suggestion: entry.suggestion ?? null,
        start: m.index,
        end: m.index + m[0].length,
      });
      // Guard against a pathological zero-length match looping forever.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  return matches;
}

// ─────────────── scan result shape (shared by gate + wizard + queue) ───────────────

export const jdBiasMatchSchema = z.object({
  term: z.string(),
  matchedText: z.string(),
  category: biasCategorySchema,
  severity: biasSeveritySchema,
  suggestion: z.string().nullable(),
  start: z.number().int(),
  end: z.number().int(),
});

export const jdBiasScanSchema = z.object({
  enforcement: biasEnforcementSchema,
  matches: z.array(jdBiasMatchSchema),
  /** Count of `block`-severity matches (what would block under enforcement `block`). */
  blockingCount: z.number().int(),
  /** Count of `warn`-severity matches. */
  warningCount: z.number().int(),
});
export type JdBiasScan = z.infer<typeof jdBiasScanSchema>;

/**
 * Run the lexicon over `text` and roll the matches up into the shared scan
 * shape. The single place gate + wizard + queue derive counts, so the
 * "blocking" definition can never drift between them.
 */
export function summarizeScan(text: string, lexicon: BiasLexicon): JdBiasScan {
  const matches = scanJdText(text, lexicon.entries);
  let blockingCount = 0;
  let warningCount = 0;
  for (const m of matches) {
    if (m.severity === "block") blockingCount += 1;
    else warningCount += 1;
  }
  return { enforcement: lexicon.enforcement, matches, blockingCount, warningCount };
}

/**
 * Would this scan block a submit? Only under enforcement `block`, and only
 * when at least one `block`-severity match exists. The single predicate the
 * server gate and the wizard's review-step status both call.
 */
export function scanBlocksSubmit(scan: JdBiasScan): boolean {
  return scan.enforcement === "block" && scan.blockingCount > 0;
}

// ─────────────── getBiasLexicon / updateTenantBiasLexicon (CONF-02) ───────────────

export const getBiasLexiconInputSchema = z.object({});
export const getBiasLexiconOutputSchema = biasLexiconSchema;
export type GetBiasLexiconOutput = z.infer<typeof getBiasLexiconOutputSchema>;

/** The full block the admin surface writes. Lenient (defaults fill gaps). */
export const updateTenantBiasLexiconInputSchema = biasLexiconSchema;
export type UpdateTenantBiasLexiconInput = z.infer<typeof updateTenantBiasLexiconInputSchema>;
export const updateTenantBiasLexiconOutputSchema = z.object({
  ok: z.literal(true),
  lexicon: biasLexiconSchema,
});
export type UpdateTenantBiasLexiconOutput = z.infer<typeof updateTenantBiasLexiconOutputSchema>;

// ─────────────── reviewJdWithAi (CONF-02) ───────────────

export const jdAiObservationSchema = z.object({
  /** A short quote from the JD the observation is about. */
  excerpt: z.string(),
  /** What the reviewer flags about it. */
  issue: z.string(),
  /** A concrete, inclusive rewrite. */
  suggestion: z.string(),
});
export type JdAiObservation = z.infer<typeof jdAiObservationSchema>;

export const reviewJdWithAiInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const reviewJdWithAiOutputSchema = z.object({
  observations: z.array(jdAiObservationSchema),
  /** The provider that produced the review (for the "AI-assisted" label). */
  model: z.string(),
});
export type ReviewJdWithAiInput = z.infer<typeof reviewJdWithAiInputSchema>;
export type ReviewJdWithAiOutput = z.infer<typeof reviewJdWithAiOutputSchema>;
