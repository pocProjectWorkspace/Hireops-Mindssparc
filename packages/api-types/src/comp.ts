/**
 * Comp & offer desk + offer-approval + HR-analytics contracts (HROPS-02). Pure
 * zod, no runtime deps — the tRPC surface (`apps/api`), the comp-rationale
 * prompt builder, and the portal pages all validate against these single
 * definitions.
 *
 * Money convention: all salary amounts are INR paise (minor units), transported
 * as int `number` — JSON has no bigint and a paise salary sits far below
 * MAX_SAFE_INTEGER (same choice offers.base_salary_inr_paise makes). Positions'
 * comp band is stored MAJOR (numeric rupees); the server converts to paise
 * before it reaches these shapes, so everything here speaks one unit.
 *
 * The deterministic verdict (proceed | negotiate | need_approval) is computed
 * by the pure rule engine in apps/api/src/lib/comp-rules.ts and is AUTHORITATIVE.
 * The AI (comp_recommendation) writes only the `rationale` prose.
 */

import { z } from "zod";
import { marketBenchmarkRowSchema } from "./market-intelligence";
import { applicationStageSchema } from "./enums";

// ─────────────────────────── verdict + benefits ───────────────────────────

export const compVerdictSchema = z.enum(["proceed", "negotiate", "need_approval"]);
export type CompVerdict = z.infer<typeof compVerdictSchema>;

/**
 * The typed benefits catalog — a small, closed set of benefit KEYS an offer can
 * carry (offers.benefits jsonb is a string[] of these). Curated, honestly
 * labelled; not free text. Rendered as checkboxes in the composer and as a
 * summary on the candidate-facing accept page.
 */
export const BENEFIT_KEYS = [
  "health_insurance",
  "provident_fund",
  "relocation_allowance",
  "education_allowance",
  "housing_allowance",
  "transport_allowance",
] as const;
export type BenefitKey = (typeof BENEFIT_KEYS)[number];
export const benefitKeySchema = z.enum(BENEFIT_KEYS);

export const BENEFIT_META: Record<BenefitKey, { label: string; description: string }> = {
  health_insurance: {
    label: "Health insurance",
    description: "Group medical cover for the employee and immediate family.",
  },
  provident_fund: {
    label: "Provident fund",
    description: "Statutory EPF contribution (employer + employee).",
  },
  relocation_allowance: {
    label: "Relocation allowance",
    description: "One-time support for moving to the work location.",
  },
  education_allowance: {
    label: "Education allowance",
    description: "Annual learning / certification / children's-education support.",
  },
  housing_allowance: {
    label: "Housing allowance",
    description: "Monthly house-rent allowance component.",
  },
  transport_allowance: {
    label: "Transport allowance",
    description: "Monthly commute / conveyance component.",
  },
};

/** Contract types an offer can carry (offers.contract_type). */
export const CONTRACT_TYPES = ["full_time", "fixed_term", "contract", "intern"] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const contractTypeSchema = z.enum(CONTRACT_TYPES);
export const CONTRACT_TYPE_LABELS: Record<ContractType, string> = {
  full_time: "Full-time",
  fixed_term: "Fixed-term",
  contract: "Contract",
  intern: "Internship",
};

// ─────────────────────────── offer-approval status ───────────────────────────

/** The approval posture of an out-of-band offer, as the desk chip reads it. */
export const offerApprovalStatusSchema = z.enum([
  "not_required", // base ≤ band max — no approval needed
  "required", // base > band max, nothing raised yet
  "pending", // an approval_request is open
  "approved", // cleared to extend
  "rejected", // HR head declined
]);
export type OfferApprovalStatus = z.infer<typeof offerApprovalStatusSchema>;

// ─────────────────────────── the desk row + list ───────────────────────────

/** One row on the Comp & offer desk. Everything the table renders + the drawer
 * seeds from. Nullable comp fields = honest "can't evaluate yet" states. */
export const compDeskRowSchema = z.object({
  applicationId: z.string().uuid(),
  candidateName: z.string(),
  roleTitle: z.string(),
  currentStage: applicationStageSchema,

  // Comp analysis inputs (paise; null when uncaptured).
  expectedSalaryInrPaise: z.number().int().nonnegative().nullable(),
  bandMinPaise: z.number().int().nonnegative().nullable(),
  bandMidPaise: z.number().int().nonnegative().nullable(),
  bandMaxPaise: z.number().int().nonnegative().nullable(),
  compCurrency: z.string().nullable(),

  // Deterministic verdict (null when not evaluable).
  verdict: compVerdictSchema.nullable(),
  suggestedPaise: z.number().int().nonnegative().nullable(),
  reasons: z.array(z.string()),

  // Offer facet (latest non-terminal-or-most-recent offer for the app).
  offerId: z.string().uuid().nullable(),
  offerStatus: z
    .enum(["drafted", "extended", "accepted", "declined", "expired", "cancelled"])
    .nullable(),
  offerBaseInrPaise: z.number().int().nonnegative().nullable(),

  // Out-of-band approval posture.
  approvalStatus: offerApprovalStatusSchema,
  approvalRequestId: z.string().uuid().nullable(),

  // Whether a cached AI rationale exists for this application.
  hasRationale: z.boolean(),
});
export type CompDeskRow = z.infer<typeof compDeskRowSchema>;

export const compDeskStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  proceed: z.number().int().nonnegative(),
  negotiate: z.number().int().nonnegative(),
  needApproval: z.number().int().nonnegative(),
});
export type CompDeskStats = z.infer<typeof compDeskStatsSchema>;

export const listCompDeskInputSchema = z.object({}).default({});
export const listCompDeskOutputSchema = z.object({
  rows: z.array(compDeskRowSchema),
  stats: compDeskStatsSchema,
});
export type ListCompDeskOutput = z.infer<typeof listCompDeskOutputSchema>;

// ─────────────────────────── the analysis panel (drawer) ───────────────────────────

/** The cached AI rationale (comp_recommendations row), wire shape. Prose only —
 * the verdict snapshot is for provenance/staleness, never authoritative. */
export const compRationaleSchema = z.object({
  rationale: z.string(),
  verdictSnapshot: compVerdictSchema,
  suggestedPaiseSnapshot: z.number().int().nonnegative(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  generatedAt: z.string().nullable(),
});
export type CompRationale = z.infer<typeof compRationaleSchema>;

/** The full per-application comp analysis the Rec drawer / case-detail tab
 * renders: the row + curated benchmark context + interview signal + rationale. */
export const compAnalysisSchema = z.object({
  row: compDeskRowSchema,
  currentSalaryInrPaise: z.number().int().nonnegative().nullable(),
  // Curated benchmarks for the role family, LABELLED as such (source_note).
  benchmarks: z.array(marketBenchmarkRowSchema),
  matchedBenchmarkRoleTitle: z.string().nullable(),
  // Interview recommendation vocabulary summary (strong_yes|yes|hold|no counts).
  interviewSignal: z.array(z.object({ recommendation: z.string(), count: z.number().int() })),
  benefitsSuggested: z.array(benefitKeySchema),
  rationale: compRationaleSchema.nullable(),
});
export type CompAnalysis = z.infer<typeof compAnalysisSchema>;

export const getCompAnalysisInputSchema = z.object({ applicationId: z.string().uuid() });
export const getCompAnalysisOutputSchema = z.object({ analysis: compAnalysisSchema.nullable() });
export type GetCompAnalysisOutput = z.infer<typeof getCompAnalysisOutputSchema>;

// ─────────────────────────── generate rationale (real AI) ───────────────────────────

export const generateCompRationaleInputSchema = z.object({ applicationId: z.string().uuid() });
export const generateCompRationaleOutputSchema = z.object({
  rationale: compRationaleSchema,
});
export type GenerateCompRationaleOutput = z.infer<typeof generateCompRationaleOutputSchema>;

/** The structured shape the model returns — just the prose. Bounds keep a
 * runaway generation strict. */
export const compRationaleAiSchema = z.object({
  rationale: z.string().min(1).max(1500),
});
export type CompRationaleAi = z.infer<typeof compRationaleAiSchema>;

// ─────────────────────────── offer composer (draft with comp) ───────────────────────────

export const draftCompOfferInputSchema = z.object({
  applicationId: z.string().uuid(),
  baseSalaryInrPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  variableTargetInrPaise: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  joiningBonusInrPaise: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  joiningDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  location: z.string().min(1).max(200),
  contractType: contractTypeSchema.default("full_time"),
  probationMonths: z.number().int().min(0).max(24).default(3),
  benefits: z.array(benefitKeySchema).default([]),
  expiryDays: z.number().int().min(1).max(60).default(7),
  termsHtml: z.string().max(50_000).optional(),
});
export type DraftCompOfferInput = z.infer<typeof draftCompOfferInputSchema>;
export const draftCompOfferOutputSchema = z.object({
  offerId: z.string().uuid(),
  /** True when base > band max — the desk must route through approval to extend. */
  needsApproval: z.boolean(),
});
export type DraftCompOfferOutput = z.infer<typeof draftCompOfferOutputSchema>;

// ─────────────────────────── offer approval (governance) ───────────────────────────

export const requestOfferApprovalInputSchema = z.object({ offerId: z.string().uuid() });
export const requestOfferApprovalOutputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  status: z.enum(["pending", "approved", "rejected"]),
  alreadyRequested: z.boolean(),
});
export type RequestOfferApprovalOutput = z.infer<typeof requestOfferApprovalOutputSchema>;

export const decideOfferApprovalInputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(500).optional(),
});
export const decideOfferApprovalOutputSchema = z.object({
  approvalRequestId: z.string().uuid(),
  offerId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  status: z.enum(["approved", "rejected"]),
});
export type DecideOfferApprovalOutput = z.infer<typeof decideOfferApprovalOutputSchema>;

/** The HR-head / admin offer-approval queue row. */
export const offerApprovalQueueRowSchema = z.object({
  approvalRequestId: z.string().uuid(),
  offerId: z.string().uuid(),
  applicationId: z.string().uuid(),
  candidateName: z.string(),
  roleTitle: z.string(),
  baseInrPaise: z.number().int().nonnegative(),
  bandMaxPaise: z.number().int().nonnegative().nullable(),
  overBandPct: z.number().nullable(),
  requestedAt: z.string(),
});
export type OfferApprovalQueueRow = z.infer<typeof offerApprovalQueueRowSchema>;
export const listOfferApprovalsInputSchema = z.object({}).default({});
export const listOfferApprovalsOutputSchema = z.object({
  rows: z.array(offerApprovalQueueRowSchema),
});
export type ListOfferApprovalsOutput = z.infer<typeof listOfferApprovalsOutputSchema>;

// ─────────────────────────── HR analytics (5 charts) ───────────────────────────

export const getHrAnalyticsOutputSchema = z.object({
  // 1. Time-to-hire by department (created → offer_accepted, days).
  timeToHireByDept: z.array(z.object({ department: z.string(), avgDays: z.number().nullable() })),
  // 2. Candidate drop-off by stage (count currently/ever at each stage).
  dropOffByStage: z.array(z.object({ stage: applicationStageSchema, count: z.number().int() })),
  // 3. Offer acceptance (accepted / declined / pending).
  offerAcceptance: z.object({
    accepted: z.number().int(),
    declined: z.number().int(),
    pending: z.number().int(),
  }),
  // 4. Hiring demand by department (open vs filled requisitions).
  demandByDept: z.array(
    z.object({ department: z.string(), open: z.number().int(), filled: z.number().int() }),
  ),
  // 5. Average offer vs band midpoint by role (paise).
  offerVsBandByRole: z.array(
    z.object({
      role: z.string(),
      avgOfferPaise: z.number().nullable(),
      bandMidPaise: z.number().nullable(),
    }),
  ),
  // A tiny KPI header the page shows above the charts.
  kpis: z.object({
    onDesk: z.number().int(),
    offersOut: z.number().int(),
    needApproval: z.number().int(),
    acceptanceRatePct: z.number().nullable(),
  }),
});
export type GetHrAnalyticsOutput = z.infer<typeof getHrAnalyticsOutputSchema>;
