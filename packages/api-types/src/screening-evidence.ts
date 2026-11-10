import { z } from "zod";

/**
 * PC-6 — evidence-based CV screening (read shapes).
 *
 * Screening shows EVIDENCE, not a score (decision D2): for every requisition
 * criterion (its must-have skills + the JD's required qualifications) the
 * screener states whether the CV shows it — met / partially met / not met /
 * unclear — with a short reason and up to two VERBATIM quotes from the CV.
 * Every quote is verified against the CV text before it is stored; a positive
 * verdict whose quotes could not be verified is stored as `unclear`.
 *
 * Stored per application in `application_screening_evidence` (migration 0124),
 * written by the ai-score drain in the same model call as the legacy 0–100
 * score. `status = 'stale'` means the requisition's criteria changed after the
 * evidence was produced; the application has been re-queued and the old
 * evidence is shown until the new one lands.
 */

export const screeningVerdictSchema = z.enum(["met", "partially_met", "not_met", "unclear"]);
export type ScreeningVerdictValue = z.infer<typeof screeningVerdictSchema>;

export const screeningCriterionKindSchema = z.enum(["must_have", "requirement"]);

export const screeningEvidenceStatusSchema = z.enum(["done", "stale"]);
export type ScreeningEvidenceStatus = z.infer<typeof screeningEvidenceStatusSchema>;

export const screeningCriterionEvidenceSchema = z.object({
  key: z.string(),
  kind: screeningCriterionKindSchema,
  label: z.string(),
  verdict: screeningVerdictSchema,
  reason: z.string(),
  quotes: z.array(z.string()),
});
export type ScreeningCriterionEvidenceView = z.infer<typeof screeningCriterionEvidenceSchema>;

/** The compact facet list rows carry — enough for the "Must-haves 4/5 met" chip. */
export const screeningEvidenceSummarySchema = z.object({
  status: screeningEvidenceStatusSchema,
  criteriaCount: z.number().int().min(0),
  met: z.number().int().min(0),
  partiallyMet: z.number().int().min(0),
  notMet: z.number().int().min(0),
  unclear: z.number().int().min(0),
});
export type ScreeningEvidenceSummary = z.infer<typeof screeningEvidenceSummarySchema>;

/** The full evidence (detail drawer, list-row expander). */
export const screeningEvidenceSchema = screeningEvidenceSummarySchema.extend({
  criteria: z.array(screeningCriterionEvidenceSchema),
  quotesDropped: z.number().int().min(0),
  model: z.string().nullable(),
  promptVersion: z.string(),
  generatedAt: z.string(),
});
export type ScreeningEvidenceView = z.infer<typeof screeningEvidenceSchema>;

/**
 * Per-requisition scoring queue depth, for "Screening 312 of 400…". `total` is
 * every application on the requisition that was ever queued for screening;
 * `pending` is the part still waiting or in flight.
 */
export const screeningQueueSchema = z.object({
  pending: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type ScreeningQueue = z.infer<typeof screeningQueueSchema>;

// ─────────────── getApplicationScreeningEvidence ───────────────

export const getApplicationScreeningEvidenceInputSchema = z.object({
  applicationId: z.string().uuid(),
});
export const getApplicationScreeningEvidenceOutputSchema = z.object({
  evidence: screeningEvidenceSchema.nullable(),
});
export type GetApplicationScreeningEvidenceOutput = z.infer<
  typeof getApplicationScreeningEvidenceOutputSchema
>;
