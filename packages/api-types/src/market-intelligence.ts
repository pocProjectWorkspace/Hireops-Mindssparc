/**
 * Market Intelligence (honest benchmarks) + Feasibility (real AI) contracts
 * (HRHEAD-02). Pure zod, no runtime deps — the tRPC surface (`apps/api`), the
 * feasibility prompt builder (`apps/api/src/lib/req-feasibility.ts`), and the
 * portal pages all validate against these single definitions.
 *
 * Money convention: benchmark medians are MINOR units (paise for INR),
 * transported as an int `number` — JSON has no bigint and a paise median sits
 * far below MAX_SAFE_INTEGER (same choice offers make for base_salary paise).
 * The positions comp band is stored in MAJOR units (numeric rupees); the
 * feasibility builder converts between the two.
 */

import { z } from "zod";

// ─────────────────────────── Market benchmarks ───────────────────────────

/** low|medium|high — mirrors the DB CHECK constraints. */
export const benchmarkLevelSchema = z.enum(["low", "medium", "high"]);
export type BenchmarkLevel = z.infer<typeof benchmarkLevelSchema>;

/** A trending skill is a short label rendered as a chip on the per-role card. */
const trendingSkillSchema = z.string().min(1).max(60);

/** The row the Market Intelligence table + trending-skills cards render. */
export const marketBenchmarkRowSchema = z.object({
  id: z.string().uuid(),
  roleTitle: z.string().min(1).max(200),
  medianSalaryMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  ttfDays: z.number().int().nonnegative(),
  availability: benchmarkLevelSchema,
  competitorDemand: benchmarkLevelSchema,
  recommendedRounds: z.number().int().nonnegative(),
  trendingSkills: z.array(trendingSkillSchema).max(20),
  sourceNote: z.string().min(1).max(300),
  updatedAt: z.string(), // ISO
});
export type MarketBenchmarkRow = z.infer<typeof marketBenchmarkRowSchema>;

export const listMarketBenchmarksInputSchema = z.object({}).default({});
export const listMarketBenchmarksOutputSchema = z.object({
  rows: z.array(marketBenchmarkRowSchema),
});
export type ListMarketBenchmarksOutput = z.infer<typeof listMarketBenchmarksOutputSchema>;

/**
 * Admin upsert of a single benchmark row, keyed by (tenant, role_title). The
 * source_note carries a sensible default so an admin who just tweaks a number
 * still records the honesty label.
 */
export const upsertMarketBenchmarkInputSchema = z.object({
  roleTitle: z.string().min(1).max(200),
  medianSalaryMinor: z.number().int().nonnegative(),
  currency: z.string().length(3).default("INR"),
  ttfDays: z.number().int().nonnegative().max(3650),
  availability: benchmarkLevelSchema,
  competitorDemand: benchmarkLevelSchema,
  recommendedRounds: z.number().int().nonnegative().max(20),
  trendingSkills: z.array(trendingSkillSchema).max(20).default([]),
  sourceNote: z.string().min(1).max(300).default("Curated benchmark — update quarterly"),
});
export type UpsertMarketBenchmarkInput = z.infer<typeof upsertMarketBenchmarkInputSchema>;
export const upsertMarketBenchmarkOutputSchema = z.object({
  row: marketBenchmarkRowSchema,
});
export type UpsertMarketBenchmarkOutput = z.infer<typeof upsertMarketBenchmarkOutputSchema>;

// ─────────────────────────── Feasibility (real AI) ───────────────────────────

export const feasibilityDifficultySchema = z.enum(["low", "medium", "high"]);
export type FeasibilityDifficulty = z.infer<typeof feasibilityDifficultySchema>;

/**
 * The structured verdict the model must return — and, verbatim, the shape
 * stored in requisition_feasibility.assessment and rendered on the card. Bounds
 * keep a runaway generation from producing unusable output and keep the
 * structured-output JSON schema strict.
 *
 * - skillsFit / expCompFit: 0–100 percentages (the two fit bars).
 * - difficulty: the chip.
 * - recommendedSalaryAdjustmentPct: signed percent to move the budget toward
 *   the market median, or null when no adjustment is warranted / no benchmark.
 * - recommendation: the prose paragraph.
 * - supplyNote: the short talent-supply sentence under the card.
 */
export const feasibilityAssessmentSchema = z.object({
  skillsFit: z.number().int().min(0).max(100),
  expCompFit: z.number().int().min(0).max(100),
  difficulty: feasibilityDifficultySchema,
  recommendedSalaryAdjustmentPct: z.number().min(-100).max(100).nullable(),
  recommendation: z.string().min(1).max(1200),
  supplyNote: z.string().min(1).max(400),
});
export type FeasibilityAssessment = z.infer<typeof feasibilityAssessmentSchema>;

/**
 * The benchmark context a feasibility card shows alongside the AI verdict —
 * "market median vs budget". Median is minor units; comp band is major units
 * (rupees) straight off the position. Null benchmark = the honest "no
 * benchmark" mode (the card still renders the AI verdict, labelled as
 * benchmark-free).
 */
export const feasibilityBenchmarkContextSchema = z.object({
  matchedRoleTitle: z.string().nullable(),
  medianSalaryMinor: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  ttfDays: z.number().int().nonnegative().nullable(),
  availability: benchmarkLevelSchema.nullable(),
  competitorDemand: benchmarkLevelSchema.nullable(),
});
export type FeasibilityBenchmarkContext = z.infer<typeof feasibilityBenchmarkContextSchema>;

/** One card on the Feasibility page: the req, its budget, benchmark, verdict. */
export const feasibilityCardSchema = z.object({
  requisitionId: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  seniority: z.string().nullable(),
  // Comp band in MAJOR units (rupees), straight off the position — nullable.
  compBandMin: z.string().nullable(),
  compBandMax: z.string().nullable(),
  compCurrency: z.string().nullable(),
  benchmark: feasibilityBenchmarkContextSchema,
  assessment: feasibilityAssessmentSchema.nullable(), // null = "not generated yet"
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  generatedAt: z.string().nullable(),
});
export type FeasibilityCard = z.infer<typeof feasibilityCardSchema>;

export const listRequisitionFeasibilityInputSchema = z.object({}).default({});
export const listRequisitionFeasibilityOutputSchema = z.object({
  cards: z.array(feasibilityCardSchema),
});
export type ListRequisitionFeasibilityOutput = z.infer<
  typeof listRequisitionFeasibilityOutputSchema
>;

export const getRequisitionFeasibilityInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const getRequisitionFeasibilityOutputSchema = z.object({
  card: feasibilityCardSchema.nullable(),
});
export type GetRequisitionFeasibilityOutput = z.infer<typeof getRequisitionFeasibilityOutputSchema>;

export const generateRequisitionFeasibilityInputSchema = z.object({
  requisitionId: z.string().uuid(),
});
export const generateRequisitionFeasibilityOutputSchema = z.object({
  card: feasibilityCardSchema,
  /** True when no benchmark matched the req title — the honest fallback ran. */
  usedBenchmark: z.boolean(),
});
export type GenerateRequisitionFeasibilityOutput = z.infer<
  typeof generateRequisitionFeasibilityOutputSchema
>;
