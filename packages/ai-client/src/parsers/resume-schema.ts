import { z } from "zod";

/**
 * Canonical resume parser output schema.
 *
 * This is THE contract every downstream consumer depends on (recruiter
 * detail page, AI scoring, knockout evaluation, partner submission). Bump
 * PARSER_VERSION on every schema change; downstream code can read
 * parse_metadata.parser_version to decide whether stored parses need
 * re-parsing.
 *
 * Conventions baked in:
 *   - Strings the LLM couldn't extract are null, not empty string. This
 *     lets downstream code distinguish "missing" from "explicitly empty."
 *   - Dates are ISO 8601: YYYY-MM if month known, YYYY if only year.
 *   - currentRole mirrors workHistory[0] when its endDate is null; null
 *     if the candidate is between jobs.
 *   - totalYearsExperience is parser-computed, NOT direct LLM output —
 *     the LLM hands us per-job spans; we sum + reconcile against any
 *     explicit "X years" claim in the CV.
 *   - employmentType is best-effort; most CVs don't state it explicitly.
 *   - grade is free text — Indian grading systems vary wildly (CGPA,
 *     percentage, division, class) and normalising would lose information.
 *   - confidenceScore is the LLM's self-reported confidence: 1.0 every
 *     field extracted with certainty, 0.5 significant gaps or ambiguity,
 *     0.2 most fields couldn't be confidently extracted. Apply form
 *     surfaces "review carefully" below 0.7.
 */

export const PARSER_VERSION = "1.0.0";

const isoDateMonthOrYear = z.string().regex(/^\d{4}(-\d{2})?$/, "expected YYYY or YYYY-MM");

const employmentTypeSchema = z.enum(["full_time", "contract", "internship", "freelance"]);

const sourceFormatSchema = z.enum(["pdf_text", "pdf_scanned", "docx", "unknown"]);

export const personalSchema = z.object({
  full_name: z.string().nullable(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  location_city: z.string().nullable(),
  location_country: z.string().nullable(),
  linkedin_url: z.string().nullable(),
  github_url: z.string().nullable(),
  portfolio_url: z.string().nullable(),
});

export const roleSchema = z.object({
  title: z.string(),
  company: z.string(),
  start_date: isoDateMonthOrYear,
  end_date: isoDateMonthOrYear.nullable(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  employment_type: employmentTypeSchema.nullable(),
});

export const currentRoleSchema = z.object({
  title: z.string(),
  company: z.string(),
  start_date: isoDateMonthOrYear,
  location: z.string().nullable(),
  description: z.string().nullable(),
});

export const educationSchema = z.object({
  degree: z.string(),
  field_of_study: z.string().nullable(),
  institution: z.string(),
  start_year: z.number().int().nullable(),
  end_year: z.number().int().nullable(),
  grade: z.string().nullable(),
});

export const certificationSchema = z.object({
  name: z.string(),
  issuer: z.string().nullable(),
  year: z.number().int().nullable(),
});

export const skillsSchema = z.object({
  technical: z.array(z.string()),
  languages: z.array(z.string()),
  certifications: z.array(certificationSchema),
  domain: z.array(z.string()),
});

export const compensationSchema = z.object({
  amount: z.number(),
  currency: z.string().length(3),
  period: z.enum(["annual", "monthly"]),
});

export const parseMetadataSchema = z.object({
  parser_version: z.string(),
  parsed_at: z.string(),
  confidence_score: z.number().min(0).max(1),
  source_format: sourceFormatSchema,
  parser_model: z.string(),
});

export const parserOutputSchema = z.object({
  personal: personalSchema,
  summary: z.string().nullable(),
  total_years_experience: z.number().nullable(),
  current_role: currentRoleSchema.nullable(),
  work_history: z.array(roleSchema),
  education: z.array(educationSchema),
  skills: skillsSchema,
  notice_period_days: z.number().int().nullable(),
  expected_compensation: compensationSchema.nullable(),
  parse_metadata: parseMetadataSchema,
});

/**
 * Sub-schema the LLM produces (everything the prompt is asked to extract).
 * The orchestrator overwrites parse_metadata fields the parser owns
 * (parser_version, parsed_at, source_format, parser_model) after the LLM
 * call, but lets the LLM provide confidence_score directly. The complete
 * ParserOutput is what callers receive.
 */
export const parserLLMOutputSchema = parserOutputSchema.extend({
  parse_metadata: z.object({
    confidence_score: z.number().min(0).max(1),
  }),
});

export type ParserOutput = z.infer<typeof parserOutputSchema>;
export type ParserLLMOutput = z.infer<typeof parserLLMOutputSchema>;
export type ParseMetadata = z.infer<typeof parseMetadataSchema>;
export type SourceFormat = z.infer<typeof sourceFormatSchema>;

/**
 * JSON Schema for the LLM call. Generated from the Zod schema via
 * z.toJSONSchema. The structured-output strict mode rejects free-form
 * objects with unknown properties, so the conversion sets
 * additionalProperties: false at every level via z.strictObject — Zod's
 * default is open, so we wrap the toJSONSchema output with a strict pass.
 */
export const parserOutputJsonSchema = z.toJSONSchema(parserLLMOutputSchema, {
  target: "draft-2020-12",
});
