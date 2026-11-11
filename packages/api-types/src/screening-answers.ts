/**
 * PC-7 — per-application screening answers + the knockout field catalogue.
 *
 * Pure zod + constants (no imports beyond zod) so the api, the internal portal
 * (apply form, wizard, triage, drawer) and the partner portal all validate
 * against ONE definition.
 *
 * SCREENING ANSWERS live on the application (0122), not the candidate: notice
 * period, current CTC, expected CTC and current location are answers in time
 * for one requisition. Money is minor units with the currency in the name —
 * the same convention as applications.expected_salary_inr_paise and
 * offers.base_salary_inr_paise. The expected-CTC field IS that existing column.
 *
 * THE KNOCKOUT FIELD CATALOGUE is the platform default list of things a
 * requisition knockout can check. A tenant chooses which to use and the
 * threshold per requisition; it does not invent fields (the wizard keeps an
 * "Other (advanced)" path for raw parsed-CV paths, unchanged).
 */

import { z } from "zod";

// ─────────────────────────── provenance ───────────────────────────

/** Who last supplied an application's screening answers. Mirrors the 0122 CHECK. */
export const SCREENING_ANSWERS_SOURCES = [
  "candidate",
  "recruiter",
  "partner",
  "import",
  "parsed_cv",
] as const;
export const screeningAnswersSourceSchema = z.enum(SCREENING_ANSWERS_SOURCES);
export type ScreeningAnswersSource = z.infer<typeof screeningAnswersSourceSchema>;

/** Upper bound on a notice period, in days (mirrors the 0122 CHECK). */
export const NOTICE_PERIOD_MAX_DAYS = 365;
/** Upper bound on an annual CTC in minor units (₹10 crore) — a typo guard. */
export const SCREENING_CTC_MAX_MINOR = 1_000_000_000_00;

// ─────────────────────────── input (write) ───────────────────────────

/**
 * Screening answers as a SUBMITTER supplies them (apply form, partner form,
 * recruiter edit, import). Every field optional: omitted = "not supplied".
 * On the recruiter edit path `null` explicitly clears a value.
 */
export const screeningAnswersInputSchema = z.object({
  noticePeriodDays: z.number().int().min(0).max(NOTICE_PERIOD_MAX_DAYS).nullable().optional(),
  /** Current annual CTC, INR paise (minor units). */
  currentSalaryInrPaise: z.number().int().min(0).max(SCREENING_CTC_MAX_MINOR).nullable().optional(),
  /** Expected annual CTC, INR paise — writes applications.expected_salary_inr_paise. */
  expectedSalaryInrPaise: z
    .number()
    .int()
    .min(0)
    .max(SCREENING_CTC_MAX_MINOR)
    .nullable()
    .optional(),
  currentLocation: z.string().trim().max(200).nullable().optional(),
});
export type ScreeningAnswersInput = z.infer<typeof screeningAnswersInputSchema>;

// ─────────────────────────── output (read) ───────────────────────────

/**
 * An application's screening answers as a READER sees them.
 *
 * `compVisible` = false → the caller's roles may not see pay; both CTC values
 * are null on the wire and the UI says "restricted" rather than "missing".
 * `noticePeriodFrom` tells the UI whether the notice figure is the stored
 * answer or a parsed-CV fallback (null when there is no figure at all).
 */
export const applicationScreeningAnswersSchema = z.object({
  noticePeriodDays: z.number().int().nullable(),
  noticePeriodFrom: z.enum(["application", "parsed_cv"]).nullable(),
  currentSalaryInrPaise: z.number().nullable(),
  expectedSalaryInrPaise: z.number().nullable(),
  currentLocation: z.string().nullable(),
  source: screeningAnswersSourceSchema.nullable(),
  updatedAt: z.string().nullable(),
  compVisible: z.boolean(),
});
export type ApplicationScreeningAnswers = z.infer<typeof applicationScreeningAnswersSchema>;

/**
 * Compact knockout verdict for a list row / drawer chip. `items` lists only the
 * non-passing knockouts (fail = the candidate's value breaks the bar; unknown =
 * no value to judge, which is NOT a fail). No actual values ride here — a
 * failed CTC knockout does not leak the figure to a role that can't see pay.
 */
export const knockoutSummaryItemSchema = z.object({
  knockoutId: z.string(),
  fieldPath: z.string().nullable(),
  label: z.string().nullable(),
  result: z.enum(["fail", "unknown"]),
  reason: z.string(),
});
export const knockoutSummarySchema = z.object({
  /** true = every knockout passed; false = at least one failed; null = no signal yet. */
  passed: z.boolean().nullable(),
  failCount: z.number().int().min(0),
  unknownCount: z.number().int().min(0),
  evaluatedAt: z.string().nullable(),
  items: z.array(knockoutSummaryItemSchema),
});
export type KnockoutSummary = z.infer<typeof knockoutSummarySchema>;

// ─────────────────────────── recruiter edit ───────────────────────────

export const updateApplicationScreeningAnswersInputSchema = z.object({
  applicationId: z.string().uuid(),
  answers: screeningAnswersInputSchema,
});
export type UpdateApplicationScreeningAnswersInput = z.infer<
  typeof updateApplicationScreeningAnswersInputSchema
>;
export const updateApplicationScreeningAnswersOutputSchema = z.object({
  applicationId: z.string().uuid(),
  screening: applicationScreeningAnswersSchema,
  knockout: knockoutSummarySchema,
});
export type UpdateApplicationScreeningAnswersOutput = z.infer<
  typeof updateApplicationScreeningAnswersOutputSchema
>;

// ─────────────────────────── public apply form policy ───────────────────────────

/**
 * Which screening questions the public apply form shows as required. Driven by
 * the tenant's candidate-field policy (candidate_field_policy): a question is
 * required only when the tenant SAVED a policy row marking its catalog key
 * required. Platform default = optional. Current CTC has no catalog key yet,
 * so it is always optional.
 */
export const applyScreeningPolicySchema = z.object({
  noticePeriodRequired: z.boolean(),
  expectedSalaryRequired: z.boolean(),
  currentLocationRequired: z.boolean(),
});
export type ApplyScreeningPolicy = z.infer<typeof applyScreeningPolicySchema>;
export const DEFAULT_APPLY_SCREENING_POLICY: ApplyScreeningPolicy = {
  noticePeriodRequired: false,
  expectedSalaryRequired: false,
  currentLocationRequired: false,
};

// ─────────────────────────── knockout field catalogue ───────────────────────────

export type KnockoutFieldType = "boolean" | "numeric_min" | "numeric_max" | "enum";

/**
 * One checkable field.
 *  - `fieldPath` is what threshold_value.field_path stores.
 *  - `source` is the requisition_knockouts.source the row gets: parsed_cv
 *    fields walk the parsed CV; candidate_asserted fields read the
 *    application's screening answers.
 *  - `types` the rules that make sense for the field (first = default).
 *  - `valueKind` how the wizard renders/converts the threshold: `money` is
 *    entered and stored in MAJOR units per year (the screening view the
 *    evaluator sees exposes CTC in major units too).
 *  - `cvFallbackPath` (asserted fields only) — when the answer is missing, the
 *    evaluator falls back to this parsed-CV path before declaring "unknown".
 */
export interface KnockoutFieldDef {
  fieldPath: string;
  label: string;
  source: "parsed_cv" | "candidate_asserted";
  types: readonly KnockoutFieldType[];
  valueKind: "number" | "money" | "list";
  unitHint?: string;
  cvFallbackPath?: string;
}

/** Screening-answer field paths (the keys of the evaluator's screening view). */
export const SCREENING_KNOCKOUT_FIELD_PATHS = {
  noticePeriodDays: "notice_period_days",
  expectedCtc: "expected_ctc",
  currentLocation: "current_location",
} as const;

/** THE platform default knockout field list. Order = the wizard's picker order. */
export const KNOCKOUT_FIELD_CATALOGUE: readonly KnockoutFieldDef[] = [
  {
    fieldPath: "total_years_experience",
    label: "Total years of experience",
    source: "parsed_cv",
    types: ["numeric_min", "numeric_max"],
    valueKind: "number",
    unitHint: "years",
  },
  {
    fieldPath: "personal.location_country",
    label: "Location (country, from CV)",
    source: "parsed_cv",
    types: ["enum"],
    valueKind: "list",
  },
  {
    fieldPath: "skills.technical",
    label: "Technical skills",
    source: "parsed_cv",
    types: ["enum", "boolean"],
    valueKind: "list",
  },
  {
    fieldPath: SCREENING_KNOCKOUT_FIELD_PATHS.noticePeriodDays,
    label: "Notice period",
    source: "candidate_asserted",
    types: ["numeric_max"],
    valueKind: "number",
    unitHint: "days",
    cvFallbackPath: "notice_period_days",
  },
  {
    fieldPath: SCREENING_KNOCKOUT_FIELD_PATHS.expectedCtc,
    label: "Expected CTC (annual)",
    source: "candidate_asserted",
    types: ["numeric_max"],
    valueKind: "money",
    unitHint: "₹ per year",
  },
  {
    fieldPath: SCREENING_KNOCKOUT_FIELD_PATHS.currentLocation,
    label: "Current location",
    source: "candidate_asserted",
    types: ["enum"],
    valueKind: "list",
  },
] as const;

/** Catalogue lookup by field path (undefined for "Other (advanced)" paths). */
export function knockoutFieldDef(fieldPath: string): KnockoutFieldDef | undefined {
  return KNOCKOUT_FIELD_CATALOGUE.find((f) => f.fieldPath === fieldPath);
}
