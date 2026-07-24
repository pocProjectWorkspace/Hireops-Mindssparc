import { z } from "zod";

/**
 * T4.1 / compliance-cluster — tenant-configurable per-stage SLA thresholds.
 *
 * Persisted to `tenants.settings.slaThresholds` (a SIBLING of systemSetup /
 * shortlistDefaults — no migration, no new table). The zod schemas here own
 * the WRITE validation + the resolved-map output shape; the actual default-
 * merge lives in `@hireops/sla-thresholds` (`resolveSlaThresholds`), a plain-TS
 * resolver with no zod dependency so the workers imminent-alert scan can import
 * it too. `SLA_THRESHOLDS_HOURS` stays the fallback for unconfigured tenants.
 *
 * Stage names come from the `application_stage` pgEnum. Only the seven
 * NON-terminal stages carry a real SLA and are overridable; the four terminal
 * stages have no SLA (they resolve to null and are never editable).
 */

/** The seven non-terminal application stages that carry an editable SLA. */
export const SLA_NON_TERMINAL_STAGES = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
] as const;
export type SlaNonTerminalStage = (typeof SLA_NON_TERMINAL_STAGES)[number];

/** The four terminal stages — no SLA, always resolve to null. */
export const SLA_TERMINAL_STAGES = [
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
] as const;

/** A single stage override: whole hours, 1 hour … 1 year. */
const stageOverride = z.number().int().min(1).max(8760);

/**
 * The WRITE payload — a PARTIAL override map. Every non-terminal stage is
 * optional; an omitted stage falls back to the code default at resolve time.
 * Terminal stages are not accepted (they have no SLA). Unknown keys are
 * stripped by zod's default object parse.
 */
export const slaThresholdsSchema = z.object({
  application_received: stageOverride.optional(),
  ai_screening: stageOverride.optional(),
  recruiter_review: stageOverride.optional(),
  shortlisted: stageOverride.optional(),
  tech_interview: stageOverride.optional(),
  hr_round: stageOverride.optional(),
  offer_drafted: stageOverride.optional(),
});
export type SlaThresholdsInput = z.infer<typeof slaThresholdsSchema>;

/** A non-terminal stage in the resolved map: an hours number, or null when the
 * stage's SLA has been explicitly disabled. */
const resolvedStageHours = z.number().int().min(1).max(8760).nullable();

/**
 * The full RESOLVED map — every stage present. Non-terminal stages carry their
 * resolved hours (or null if disabled); terminal stages are always null. This
 * is the shape `resolveSlaThresholds` returns and both procedures echo.
 */
export const resolvedSlaThresholdsSchema = z.object({
  application_received: resolvedStageHours,
  ai_screening: resolvedStageHours,
  recruiter_review: resolvedStageHours,
  shortlisted: resolvedStageHours,
  tech_interview: resolvedStageHours,
  hr_round: resolvedStageHours,
  offer_drafted: resolvedStageHours,
  offer_accepted: z.null(),
  offer_declined: z.null(),
  withdrawn: z.null(),
  recruiter_rejected: z.null(),
});
export type ResolvedSlaThresholds = z.infer<typeof resolvedSlaThresholdsSchema>;

export const getSlaThresholdsInputSchema = z.object({});
export const getSlaThresholdsOutputSchema = resolvedSlaThresholdsSchema;
export type GetSlaThresholdsOutput = z.infer<typeof getSlaThresholdsOutputSchema>;

export const updateSlaThresholdsInputSchema = slaThresholdsSchema;
export type UpdateSlaThresholdsInput = z.infer<typeof updateSlaThresholdsInputSchema>;
export const updateSlaThresholdsOutputSchema = z.object({
  ok: z.literal(true),
  slaThresholds: resolvedSlaThresholdsSchema,
});
export type UpdateSlaThresholdsOutput = z.infer<typeof updateSlaThresholdsOutputSchema>;
