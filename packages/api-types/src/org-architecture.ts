/**
 * C1-F3 — organisation + job architecture contracts (Plan A F3, §15 P1/P2).
 *
 *   Organisation:     legal entity → country → business unit → location
 *   Job architecture: function → job profile → level (range) → comp band
 *
 * Pure zod + pure helpers. The tRPC surface (apps/api org-architecture
 * procedures), the admin "Organisation" / "Job architecture" pages and the
 * requisition wizard pickers share these definitions.
 *
 * Platform rule: nothing here is client-specific. Keys (job level "IN12",
 * function "finance") are tenant data; the platform supplies the shape only.
 * Every structured link on a position / requisition is nullable, and the
 * legacy free-text columns (primary_location, level, function) remain the
 * display fallback.
 */

import { z } from "zod";
import { resolvedLookupEntrySchema } from "./tenant-lookups";

// ─────────────────────────── shared field rules ───────────────────────────

export const countryCodeSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, { message: "Use a two-letter ISO-3166 country code" }));

export function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const ianaTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidIanaTimeZone, { message: "Unknown time zone (use an IANA name)" });

/** Stable architecture key: letters, digits, `_ . -`, max 40 (e.g. "IN12"). */
export const ARCHITECTURE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
export const architectureKeySchema = z.string().trim().regex(ARCHITECTURE_KEY_RE, {
  message: "Use letters, digits, '_', '.' or '-' (max 40), starting with a letter or digit",
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v == null || v === "" ? null : v));

// ─────────────────────────── rows ───────────────────────────

export const legalEntityRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  countryCode: z.string(),
  isActive: z.boolean(),
});
export type LegalEntityRow = z.infer<typeof legalEntityRowSchema>;

export const locationRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  countryCode: z.string(),
  legalEntityId: z.string().uuid().nullable(),
  timezone: z.string().nullable(),
  isActive: z.boolean(),
});
export type LocationRow = z.infer<typeof locationRowSchema>;

export const orgBusinessUnitRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  parentBusinessUnitId: z.string().uuid().nullable(),
  legalEntityId: z.string().uuid().nullable(),
  isArchived: z.boolean(),
});
export type OrgBusinessUnitRow = z.infer<typeof orgBusinessUnitRowSchema>;

export const jobFunctionRowSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});
export type JobFunctionRow = z.infer<typeof jobFunctionRowSchema>;

export const jobLevelRowSchema = z.object({
  id: z.string().uuid(),
  key: z.string(),
  label: z.string(),
  rank: z.number().int(),
  isActive: z.boolean(),
});
export type JobLevelRow = z.infer<typeof jobLevelRowSchema>;

export const jobProfileCompetencySchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_]{0,39}$/, { message: "Competency keys: lower-case, digits, '_'" }),
  label: z.string().trim().min(1).max(120),
});
export type JobProfileCompetency = z.infer<typeof jobProfileCompetencySchema>;

export const jobProfileCompetenciesSchema = z
  .array(jobProfileCompetencySchema)
  .max(30)
  .refine((c) => new Set(c.map((x) => x.key)).size === c.length, "Duplicate competency key");

export const jobProfileRowSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  jobFunctionId: z.string().uuid().nullable(),
  jobLevelMinId: z.string().uuid().nullable(),
  jobLevelMaxId: z.string().uuid().nullable(),
  defaultJdTemplateId: z.string().uuid().nullable(),
  competencies: z.array(jobProfileCompetencySchema),
  canonicalMarketTitle: z.string().nullable(),
  isActive: z.boolean(),
});
export type JobProfileRow = z.infer<typeof jobProfileRowSchema>;

// ─────────────────────────── combined read ───────────────────────────

export const getOrgAndJobArchitectureInputSchema = z
  .object({
    /** Include inactive / archived rows (admin + hr_head only). Default: active only. */
    includeInactive: z.boolean().optional(),
  })
  .default({});
export type GetOrgAndJobArchitectureInput = z.infer<typeof getOrgAndJobArchitectureInputSchema>;

export const getOrgAndJobArchitectureOutputSchema = z.object({
  legalEntities: z.array(legalEntityRowSchema),
  locations: z.array(locationRowSchema),
  businessUnits: z.array(orgBusinessUnitRowSchema),
  jobFunctions: z.array(jobFunctionRowSchema),
  /** Ordered by rank (then key). */
  jobLevels: z.array(jobLevelRowSchema),
  jobProfiles: z.array(jobProfileRowSchema),
  /** Requisition pickers: platform default + tenant value, active only. */
  lookups: z.object({
    employmentType: z.array(resolvedLookupEntrySchema),
    requisitionType: z.array(resolvedLookupEntrySchema),
  }),
});
export type GetOrgAndJobArchitectureOutput = z.infer<typeof getOrgAndJobArchitectureOutputSchema>;

// ─────────────────────────── legal entities ───────────────────────────

export const createLegalEntityInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  countryCode: countryCodeSchema,
});
export type CreateLegalEntityInput = z.infer<typeof createLegalEntityInputSchema>;

export const updateLegalEntityInputSchema = createLegalEntityInputSchema.extend({
  id: z.string().uuid(),
  isActive: z.boolean(),
});
export type UpdateLegalEntityInput = z.infer<typeof updateLegalEntityInputSchema>;

export const legalEntityMutationOutputSchema = z.object({ row: legalEntityRowSchema });
export type LegalEntityMutationOutput = z.infer<typeof legalEntityMutationOutputSchema>;

// ─────────────────────────── locations ───────────────────────────

export const createLocationInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  city: optionalText(120),
  region: optionalText(120),
  countryCode: countryCodeSchema,
  legalEntityId: z.string().uuid().nullable().optional(),
  timezone: ianaTimeZoneSchema.nullable().optional(),
});
export type CreateLocationInput = z.infer<typeof createLocationInputSchema>;

export const updateLocationInputSchema = createLocationInputSchema.extend({
  id: z.string().uuid(),
  isActive: z.boolean(),
});
export type UpdateLocationInput = z.infer<typeof updateLocationInputSchema>;

export const locationMutationOutputSchema = z.object({ row: locationRowSchema });
export type LocationMutationOutput = z.infer<typeof locationMutationOutputSchema>;

// ─────────────────────────── business unit ↔ entity ───────────────────────────

export const setBusinessUnitLegalEntityInputSchema = z.object({
  businessUnitId: z.string().uuid(),
  /** null = detach. */
  legalEntityId: z.string().uuid().nullable(),
});
export type SetBusinessUnitLegalEntityInput = z.infer<typeof setBusinessUnitLegalEntityInputSchema>;
export const setBusinessUnitLegalEntityOutputSchema = z.object({ row: orgBusinessUnitRowSchema });
export type SetBusinessUnitLegalEntityOutput = z.infer<
  typeof setBusinessUnitLegalEntityOutputSchema
>;

// ─────────────────────────── job functions ───────────────────────────

export const createJobFunctionInputSchema = z.object({
  key: architectureKeySchema,
  label: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(10000).default(0),
});
export type CreateJobFunctionInput = z.infer<typeof createJobFunctionInputSchema>;

/** The key is immutable (records and analytics hold it); label / order / active change. */
export const updateJobFunctionInputSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(10000),
  isActive: z.boolean(),
});
export type UpdateJobFunctionInput = z.infer<typeof updateJobFunctionInputSchema>;

export const jobFunctionMutationOutputSchema = z.object({ row: jobFunctionRowSchema });
export type JobFunctionMutationOutput = z.infer<typeof jobFunctionMutationOutputSchema>;

// ─────────────────────────── job levels ───────────────────────────

export const createJobLevelInputSchema = z.object({
  key: architectureKeySchema,
  label: z.string().trim().min(1).max(120),
  rank: z.number().int().min(0).max(10000),
});
export type CreateJobLevelInput = z.infer<typeof createJobLevelInputSchema>;

export const updateJobLevelInputSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(120),
  rank: z.number().int().min(0).max(10000),
  isActive: z.boolean(),
});
export type UpdateJobLevelInput = z.infer<typeof updateJobLevelInputSchema>;

export const jobLevelMutationOutputSchema = z.object({ row: jobLevelRowSchema });
export type JobLevelMutationOutput = z.infer<typeof jobLevelMutationOutputSchema>;

// ─────────────────────────── job profiles ───────────────────────────

export const createJobProfileInputSchema = z.object({
  title: z.string().trim().min(2).max(200),
  jobFunctionId: z.string().uuid().nullable().optional(),
  jobLevelMinId: z.string().uuid().nullable().optional(),
  jobLevelMaxId: z.string().uuid().nullable().optional(),
  defaultJdTemplateId: z.string().uuid().nullable().optional(),
  competencies: jobProfileCompetenciesSchema.default([]),
  canonicalMarketTitle: optionalText(200),
});
export type CreateJobProfileInput = z.infer<typeof createJobProfileInputSchema>;

export const updateJobProfileInputSchema = createJobProfileInputSchema.extend({
  id: z.string().uuid(),
  isActive: z.boolean(),
});
export type UpdateJobProfileInput = z.infer<typeof updateJobProfileInputSchema>;

export const jobProfileMutationOutputSchema = z.object({ row: jobProfileRowSchema });
export type JobProfileMutationOutput = z.infer<typeof jobProfileMutationOutputSchema>;

// ─────────────────────────── pure helpers ───────────────────────────

/** Turn a label into a competency / lookup key ("Month-end close" → "month_end_close"). */
export function slugKey(label: string): string {
  const k = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return k || "item";
}

/**
 * Is `levelId` inside the profile's level range? No range = any level. A
 * single bound is open on the other side. Unknown ids are "not in range".
 */
export function levelWithinProfileRange(
  profile: Pick<JobProfileRow, "jobLevelMinId" | "jobLevelMaxId">,
  levelId: string,
  levels: readonly Pick<JobLevelRow, "id" | "rank">[],
): boolean {
  const rank = (id: string | null) => (id ? levels.find((l) => l.id === id)?.rank : undefined);
  const r = rank(levelId);
  if (r === undefined) return false;
  const min = rank(profile.jobLevelMinId);
  const max = rank(profile.jobLevelMaxId);
  if (profile.jobLevelMinId && min === undefined) return false;
  if (profile.jobLevelMaxId && max === undefined) return false;
  return (min === undefined || r >= min) && (max === undefined || r <= max);
}

export interface JobProfilePrefill {
  jobProfileId: string;
  title: string;
  jobFunctionId: string | null;
  /** The profile's lowest level (or its single level); null when it has none. */
  jobLevelId: string | null;
  /** Levels the requisition may pick (the profile's range, active, by rank). */
  allowedLevelIds: string[];
  competencies: JobProfileCompetency[];
  /** Back-compat free-text values (positions.level / positions.function). */
  seniorityLabel: string | null;
  functionLabel: string | null;
}

/**
 * What picking a job profile pre-fills on a requisition: title, function,
 * level (the range's lower bound) and competencies, plus the free-text
 * fallbacks the legacy columns carry. Everything stays editable.
 */
export function jobProfilePrefill(
  profile: JobProfileRow,
  arch: { jobFunctions: readonly JobFunctionRow[]; jobLevels: readonly JobLevelRow[] },
): JobProfilePrefill {
  const levels = [...arch.jobLevels].sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  const allowed = levels.filter(
    (l) => l.isActive && levelWithinProfileRange(profile, l.id, levels),
  );
  const ranged = profile.jobLevelMinId != null || profile.jobLevelMaxId != null;
  const minLevel = profile.jobLevelMinId
    ? levels.find((l) => l.id === profile.jobLevelMinId)
    : profile.jobLevelMaxId
      ? levels.find((l) => l.id === profile.jobLevelMaxId)
      : undefined;
  const level = minLevel ?? null;
  const fn = profile.jobFunctionId
    ? (arch.jobFunctions.find((f) => f.id === profile.jobFunctionId) ?? null)
    : null;
  return {
    jobProfileId: profile.id,
    title: profile.title,
    jobFunctionId: fn?.id ?? null,
    jobLevelId: level?.id ?? null,
    allowedLevelIds: ranged
      ? allowed.map((l) => l.id)
      : levels.filter((l) => l.isActive).map((l) => l.id),
    competencies: profile.competencies.map((c) => ({ ...c })),
    seniorityLabel: level?.label ?? null,
    functionLabel: fn?.label ?? null,
  };
}

/** The scope dimensions a comp band may be pinned to (NULL = any value). */
export interface CompBandScope {
  jobLevelId: string | null;
  jobFunctionId: string | null;
  locationId: string | null;
}

/**
 * Comp bands that apply to a (level, function, location) context, most
 * specific first. A band applies when each of its scope columns is NULL or
 * equals the context value; a context value of null only matches an unscoped
 * band on that dimension. Specificity = number of pinned dimensions; ties keep
 * the input order.
 */
export function compBandsForScope<T extends CompBandScope>(
  bands: readonly T[],
  ctx: Partial<CompBandScope>,
): T[] {
  const fits = (pin: string | null, want: string | null | undefined) =>
    pin === null || (want != null && pin === want);
  return bands
    .map((b, i) => ({ b, i }))
    .filter(
      ({ b }) =>
        fits(b.jobLevelId, ctx.jobLevelId) &&
        fits(b.jobFunctionId, ctx.jobFunctionId) &&
        fits(b.locationId, ctx.locationId),
    )
    .map(({ b, i }) => ({
      b,
      i,
      s: (b.jobLevelId ? 1 : 0) + (b.jobFunctionId ? 1 : 0) + (b.locationId ? 1 : 0),
    }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map(({ b }) => b);
}

/** "Hyderabad · Telangana · IN" — the display line for a location. */
export function locationDisplay(
  loc: Pick<LocationRow, "name" | "city" | "region" | "countryCode">,
): string {
  const parts = [loc.name];
  if (loc.city && loc.city !== loc.name) parts.push(loc.city);
  if (loc.region) parts.push(loc.region);
  parts.push(loc.countryCode);
  return parts.join(" · ");
}
