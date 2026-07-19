/**
 * PANEL-02 — panel brief enrichment + real-AI interview prep contracts.
 *
 * Two concerns live here, both shared across the wire (server computes /
 * validates, the panel brief UI renders):
 *
 *  1. `computeSkillsMatch` — a PURE, DETERMINISTIC overlap of the candidate's
 *     parsed resume skills against the requisition's JD skills. NO AI, no fuzzy
 *     scoring theatre: a JD skill is either present in the parsed resume
 *     (normalised token/substring match) or it is not. The section is labelled
 *     "Resume vs JD skills — parsed match" and makes no AI claim. The overall
 *     figure is a WEIGHTED coverage percentage (matched JD-skill weight over
 *     total JD-skill weight) so a must-have carries more than a nice-to-have.
 *     Exported pure so panel-02.test.ts can assert the metric directly.
 *
 *  2. `interview_prep` — the real-AI feature contracts (feasibility pattern):
 *     the structured AI output shape (`interviewPrepAiSchema`) and the cached
 *     wire card the brief renders (`interviewPrepCardSchema`). Grounded ONLY in
 *     JD + skills, parsed resume, prior-round recommendations + qualitative
 *     text (NEVER scores), and the round objective. The AI never sees numeric
 *     scores and is forbidden (in the system prompt) from inventing facts or
 *     inferring any protected/demographic attribute or sentiment/psychometric
 *     claim.
 */

import { z } from "zod";

// ─────────────────────────── skills match (deterministic) ───────────────────────────

/** A JD skill and whether the parsed resume covers it. */
export const skillMatchItemSchema = z.object({
  skill: z.string(),
  isRequired: z.boolean(),
  weight: z.number(),
  matched: z.boolean(),
});
export type SkillMatchItem = z.infer<typeof skillMatchItemSchema>;

export const skillsMatchResultSchema = z.object({
  items: z.array(skillMatchItemSchema),
  matchedCount: z.number().int(),
  totalCount: z.number().int(),
  /** Weighted coverage 0–100 (matched JD-skill weight / total JD-skill weight). */
  coveragePct: z.number().int(),
});
export type SkillsMatchResult = z.infer<typeof skillsMatchResultSchema>;

/** Below this weighted-coverage percentage the section reads amber. */
export const SKILLS_MATCH_AMBER_THRESHOLD = 60;

export interface JdSkillInput {
  skillName: string;
  weight: number;
  isRequired: boolean;
}

function normaliseSkill(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic overlap of parsed resume skills vs JD skills. A JD skill counts
 * as matched when its normalised form equals a parsed skill, or one contains
 * the other as a whole token-ish substring (so "Kubernetes" matches "Kubernetes
 * (CKA)" and "AWS" matches "AWS Lambda"). Pure — no I/O, no AI. Order of `items`
 * follows the JD-skill input order.
 */
export function computeSkillsMatch(
  parsedSkills: readonly string[],
  jdSkills: readonly JdSkillInput[],
): SkillsMatchResult {
  const parsed = parsedSkills.map(normaliseSkill).filter(Boolean);

  const items: SkillMatchItem[] = jdSkills.map((jd) => {
    const target = normaliseSkill(jd.skillName);
    const matched =
      target.length > 0 &&
      parsed.some((p) => p === target || p.includes(target) || target.includes(p));
    return {
      skill: jd.skillName,
      isRequired: jd.isRequired,
      weight: jd.weight,
      matched,
    };
  });

  const totalWeight = items.reduce((sum, i) => sum + (i.weight > 0 ? i.weight : 0), 0);
  const matchedWeight = items.reduce(
    (sum, i) => sum + (i.matched && i.weight > 0 ? i.weight : 0),
    0,
  );
  const coveragePct = totalWeight > 0 ? Math.round((matchedWeight / totalWeight) * 100) : 0;

  return {
    items,
    matchedCount: items.filter((i) => i.matched).length,
    totalCount: items.length,
    coveragePct,
  };
}

// ─────────────────────────── interview_prep (real AI) ───────────────────────────

/** One "area to probe": a title + why it matters for THIS round. */
export const interviewPrepFocusAreaSchema = z.object({
  title: z.string().min(1).max(160),
  why: z.string().min(1).max(600),
});
export type InterviewPrepFocusArea = z.infer<typeof interviewPrepFocusAreaSchema>;

/**
 * The structured shape the model returns: 3–5 focus areas and 6–8 suggested
 * probing questions. Bounds keep a runaway generation strict; the router
 * re-parses the provider output against this before caching.
 */
export const interviewPrepAiSchema = z.object({
  focusAreas: z.array(interviewPrepFocusAreaSchema).min(1).max(5),
  probingQuestions: z.array(z.string().min(1).max(400)).min(1).max(8),
});
export type InterviewPrepAi = z.infer<typeof interviewPrepAiSchema>;

/** The cached prep card the brief renders (interview_prep row, wire shape). */
export const interviewPrepCardSchema = z.object({
  focusAreas: z.array(interviewPrepFocusAreaSchema),
  probingQuestions: z.array(z.string()),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  generatedAt: z.string().nullable(),
});
export type InterviewPrepCard = z.infer<typeof interviewPrepCardSchema>;

export const getInterviewPrepInputSchema = z.object({ interviewId: z.string().uuid() });
export const getInterviewPrepOutputSchema = z.object({
  prep: interviewPrepCardSchema.nullable(),
  /** false → the per-tenant kill-switch is off; the UI hides Generate + says so. */
  aiEnabled: z.boolean(),
});
export type GetInterviewPrepOutput = z.infer<typeof getInterviewPrepOutputSchema>;

export const generateInterviewPrepInputSchema = z.object({ interviewId: z.string().uuid() });
export const generateInterviewPrepOutputSchema = z.object({ prep: interviewPrepCardSchema });
export type GenerateInterviewPrepOutput = z.infer<typeof generateInterviewPrepOutputSchema>;
