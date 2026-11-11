import { z } from "zod";
import { applicationStageSchema, type ApplicationStage } from "./enums";
import { interviewRecommendationSchema, type InterviewRecommendation } from "./procedures";

/**
 * CFG-LITE — tenant display labels for pipeline stages and interview
 * recommendations (Plan A ST5 / TP4).
 *
 * Persisted to `tenants.settings.labels` (a SIBLING key — no migration, no new
 * table). Only DISPLAY wording is configurable: the canonical keys (the
 * `application_stage` pg enum and the strong_yes / yes / hold / no
 * recommendation enum) never change, so stage logic, analytics, governance
 * gates and every stored row are untouched by a relabel.
 *
 * Resolution rule (Plan A §14): tenant value → else platform default. The
 * stored block holds OVERRIDES only (every field optional); an empty or blank
 * override means "use the platform default". The resolver never throws: a
 * malformed block resolves to no overrides (= platform defaults), and a single
 * bad entry is dropped on its own without discarding the rest.
 *
 * Three audiences per stage, because each surface already speaks to a
 * different reader:
 *   - staff     — the internal portal (badges, filters, charts, reports, Ask
 *                 your data). Defaults = today's `applicationStageLabel`.
 *   - candidate — the candidate stage-change email. Defaults = today's email
 *                 wording.
 *   - partner   — the partner portal + partner stage emails. Defaults = today's
 *                 partner-portal wording (the emailed subset is identical).
 */

export const TENANT_LABELS_VERSION = 1 as const;

/** Longest label an admin may set. Labels render in badges and chips. */
export const TENANT_LABEL_MAX_LENGTH = 40;

export const STAGE_LABEL_AUDIENCES = ["staff", "candidate", "partner"] as const;
export type StageLabelAudience = (typeof STAGE_LABEL_AUDIENCES)[number];

export const ALL_APPLICATION_STAGES: readonly ApplicationStage[] = applicationStageSchema.options;
export const ALL_INTERVIEW_RECOMMENDATIONS: readonly InterviewRecommendation[] =
  interviewRecommendationSchema.options;

/** Platform default wording per stage per audience (= today's labels). */
export const PLATFORM_STAGE_LABELS: Record<ApplicationStage, Record<StageLabelAudience, string>> = {
  application_received: { staff: "Applied", candidate: "Applied", partner: "Submitted" },
  ai_screening: { staff: "AI screening", candidate: "Screening", partner: "Screening" },
  recruiter_review: {
    staff: "Recruiter review",
    candidate: "Under review",
    partner: "Recruiter review",
  },
  shortlisted: { staff: "Shortlisted", candidate: "Shortlisted", partner: "Shortlisted" },
  tech_interview: {
    staff: "Panel interview",
    candidate: "Panel interview",
    partner: "Panel interview",
  },
  hr_round: { staff: "HR round", candidate: "HR round", partner: "HR round" },
  offer_drafted: {
    staff: "Offer drafted",
    candidate: "Offer in preparation",
    partner: "Offer in progress",
  },
  offer_accepted: {
    staff: "Offer accepted",
    candidate: "Offer accepted",
    partner: "Offer accepted",
  },
  offer_declined: {
    staff: "Offer declined",
    candidate: "Offer declined",
    partner: "Offer declined",
  },
  withdrawn: { staff: "Withdrawn", candidate: "Withdrawn", partner: "Withdrawn" },
  recruiter_rejected: {
    staff: "Rejected",
    candidate: "Not moving forward",
    partner: "Not moving forward",
  },
};

/** Platform default wording per interview recommendation (= today's labels). */
export const PLATFORM_RECOMMENDATION_LABELS: Record<InterviewRecommendation, string> = {
  strong_yes: "Strong yes",
  yes: "Yes",
  hold: "Hold",
  no: "No",
};

/** One label override: trimmed, 1–40 chars. Blank means "no override". */
const labelOverride = z.string().trim().max(TENANT_LABEL_MAX_LENGTH);

export const stageLabelOverrideSchema = z.object({
  staff: labelOverride.optional(),
  candidate: labelOverride.optional(),
  partner: labelOverride.optional(),
});
export type StageLabelOverride = z.infer<typeof stageLabelOverrideSchema>;

/** The WRITE payload / stored shape — overrides only. */
export const tenantLabelsSchema = z.object({
  version: z.literal(TENANT_LABELS_VERSION).default(TENANT_LABELS_VERSION),
  stages: z.partialRecord(applicationStageSchema, stageLabelOverrideSchema).default({}),
  recommendations: z.partialRecord(interviewRecommendationSchema, labelOverride).default({}),
});
export type TenantLabelsInput = z.input<typeof tenantLabelsSchema>;

/** The normalised overrides block: only non-blank overrides survive. */
export interface TenantLabels {
  version: typeof TENANT_LABELS_VERSION;
  stages: Partial<Record<ApplicationStage, Partial<Record<StageLabelAudience, string>>>>;
  recommendations: Partial<Record<InterviewRecommendation, string>>;
}

export function defaultTenantLabels(): TenantLabels {
  return { version: TENANT_LABELS_VERSION, stages: {}, recommendations: {} };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t === "" || t.length > TENANT_LABEL_MAX_LENGTH) return null;
  return t;
}

/**
 * Normalise a raw stored `labels` block (partial / unknown / absent / garbage)
 * into the overrides block. Per-entry leniency: an unknown stage, an unknown
 * audience, a non-string or an over-long label is dropped on its own; every
 * other override survives. Never throws.
 */
export function resolveTenantLabels(raw: unknown): TenantLabels {
  const out = defaultTenantLabels();
  if (!isRecord(raw)) return out;

  if (isRecord(raw.stages)) {
    for (const stage of ALL_APPLICATION_STAGES) {
      const entry = raw.stages[stage];
      if (!isRecord(entry)) continue;
      const clean: Partial<Record<StageLabelAudience, string>> = {};
      for (const audience of STAGE_LABEL_AUDIENCES) {
        const label = cleanLabel(entry[audience]);
        if (label) clean[audience] = label;
      }
      if (Object.keys(clean).length > 0) out.stages[stage] = clean;
    }
  }

  if (isRecord(raw.recommendations)) {
    for (const rec of ALL_INTERVIEW_RECOMMENDATIONS) {
      const label = cleanLabel(raw.recommendations[rec]);
      if (label) out.recommendations[rec] = label;
    }
  }
  return out;
}

/** The tenant's override for one stage + audience, or null when unset. */
export function tenantStageLabelOverride(
  labels: TenantLabels | null | undefined,
  stage: string,
  audience: StageLabelAudience,
): string | null {
  if (!labels) return null;
  return labels.stages[stage as ApplicationStage]?.[audience] ?? null;
}

/**
 * THE stage-label resolver. Tenant override → else `fallback` (a call site
 * whose historic wording differs from the platform default, e.g. a Title-Case
 * chart axis, passes its own) → else platform default for the audience → else
 * the key itself, de-snaked. Never throws.
 */
export function resolveStageLabel(
  labels: TenantLabels | null | undefined,
  stage: string,
  audience: StageLabelAudience,
  fallback?: string,
): string {
  const override = tenantStageLabelOverride(labels, stage, audience);
  if (override) return override;
  if (fallback) return fallback;
  const platform = PLATFORM_STAGE_LABELS[stage as ApplicationStage]?.[audience];
  if (platform) return platform;
  const spaced = String(stage).replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Every stage's effective label for one audience — the shape the portals consume. */
export function resolveStageLabelMap(
  labels: TenantLabels | null | undefined,
  audience: StageLabelAudience,
): Record<ApplicationStage, string> {
  const out = {} as Record<ApplicationStage, string>;
  for (const stage of ALL_APPLICATION_STAGES) {
    out[stage] = resolveStageLabel(labels, stage, audience);
  }
  return out;
}

/** Recommendation label: tenant override → platform default. Never throws. */
export function resolveRecommendationLabel(
  labels: TenantLabels | null | undefined,
  rec: string,
): string {
  const override = labels?.recommendations[rec as InterviewRecommendation];
  if (override) return override;
  return PLATFORM_RECOMMENDATION_LABELS[rec as InterviewRecommendation] ?? rec;
}

export function resolveRecommendationLabelMap(
  labels: TenantLabels | null | undefined,
): Record<InterviewRecommendation, string> {
  const out = {} as Record<InterviewRecommendation, string>;
  for (const rec of ALL_INTERVIEW_RECOMMENDATIONS) {
    out[rec] = resolveRecommendationLabel(labels, rec);
  }
  return out;
}

// ─────────────── getTenantLabels / updateTenantLabels (admin) ───────────────

const tenantLabelsWireSchema = z.object({
  version: z.literal(TENANT_LABELS_VERSION),
  stages: z.partialRecord(
    applicationStageSchema,
    z.object({
      staff: z.string().optional(),
      candidate: z.string().optional(),
      partner: z.string().optional(),
    }),
  ),
  recommendations: z.partialRecord(interviewRecommendationSchema, z.string()),
});

export const getTenantLabelsInputSchema = z.object({});
export const getTenantLabelsOutputSchema = z.object({
  /** The tenant's overrides (only what differs from the platform default). */
  labels: tenantLabelsWireSchema,
});
export type GetTenantLabelsOutput = z.infer<typeof getTenantLabelsOutputSchema>;

/** The full overrides block the admin page writes. Blank = reset to default. */
export const updateTenantLabelsInputSchema = tenantLabelsSchema;
export type UpdateTenantLabelsInput = z.input<typeof updateTenantLabelsInputSchema>;
export const updateTenantLabelsOutputSchema = z.object({
  ok: z.literal(true),
  labels: tenantLabelsWireSchema,
});
export type UpdateTenantLabelsOutput = z.infer<typeof updateTenantLabelsOutputSchema>;

// ─────────────── partnerGetStageLabels (partner portal) ───────────────

/**
 * The resolved PARTNER-audience stage wording for the partner's tenant (every
 * stage key → label; platform default where the tenant set nothing). Read by
 * the partner portal's server components so badges, filters and the timeline
 * use the tenant's wording.
 */
export const partnerGetStageLabelsOutputSchema = z.object({
  labels: z.record(z.string(), z.string()),
});
export type PartnerGetStageLabelsOutput = z.infer<typeof partnerGetStageLabelsOutputSchema>;
