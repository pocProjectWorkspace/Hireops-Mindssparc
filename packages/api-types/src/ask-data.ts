/**
 * "Ask your data" — the natural-language analytics contract (ASK-DATA).
 *
 * THE PRODUCT STANCE this contract encodes: the AI never writes SQL and
 * never produces a number. A question is mapped to ONE intent from the fixed
 * catalog below plus validated parameters; every figure, every row and the
 * summary sentence are computed by deterministic server code over the
 * reporting semantic layer (apps/api/src/lib/reports). The caller always gets
 * the interpretation back ("How I read your question") so a human can see
 * and correct it — and a chip click / chip edit re-runs with
 * `intent` + `params` and skips the AI entirely.
 *
 * Pure zod + constants, no runtime deps: the catalog is shared by the API
 * (prompt, pre-matcher, executors) and the portal (chips, grouping, inline
 * editors), so the two cannot drift.
 */

import { z } from "zod";

// ─────────────────────────────── intents ───────────────────────────────

/** The fixed whitelist. Order is the portal's chip order within each group. */
export const ASK_DATA_INTENT_IDS = [
  "open_reqs_by_bu",
  "oldest_open_reqs",
  "time_to_fill",
  "time_to_fill_trend",
  "hires_by_source",
  "partner_performance",
  "pipeline_funnel",
  "stage_bottlenecks",
  "offer_acceptance",
  "declined_offers",
  "joiners_next_30_days",
  "pending_feedback",
  "pending_approvals",
  "recruiter_activity",
] as const;
export const askDataIntentIdSchema = z.enum(ASK_DATA_INTENT_IDS);
export type AskDataIntentId = z.infer<typeof askDataIntentIdSchema>;

/** Relative reporting windows. Calendar months / quarters, UTC. */
export const ASK_DATA_PERIODS = [
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "last_90_days",
  "this_year",
  "all_time",
] as const;
export const askDataPeriodSchema = z.enum(ASK_DATA_PERIODS);
export type AskDataPeriod = z.infer<typeof askDataPeriodSchema>;

export const ASK_DATA_PERIOD_LABELS: Record<AskDataPeriod, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  last_90_days: "Last 90 days",
  this_year: "This year",
  all_time: "All time",
};

/** Trend window bounds (months), inclusive. */
export const ASK_DATA_MONTHS_MIN = 3;
export const ASK_DATA_MONTHS_MAX = 24;

/** The parameters an intent may take. */
export const ASK_DATA_PARAM_KEYS = ["period", "businessUnit", "requisition", "months"] as const;
export type AskDataParamKey = (typeof ASK_DATA_PARAM_KEYS)[number];

/**
 * Parameters as the human reads them: a business unit / requisition by NAME,
 * never by id (the server resolves names against the tenant's real data and
 * drops anything that does not resolve).
 */
export const askDataParamsSchema = z.object({
  period: askDataPeriodSchema.optional(),
  businessUnit: z.string().trim().min(1).max(160).optional(),
  requisition: z.string().trim().min(1).max(200).optional(),
  months: z.number().int().min(ASK_DATA_MONTHS_MIN).max(ASK_DATA_MONTHS_MAX).optional(),
});
export type AskDataParams = z.infer<typeof askDataParamsSchema>;

export const ASK_DATA_GROUPS = [
  "requisitions",
  "pipeline",
  "offers_joiners",
  "partners_team",
] as const;
export type AskDataGroup = (typeof ASK_DATA_GROUPS)[number];
export const ASK_DATA_GROUP_LABELS: Record<AskDataGroup, string> = {
  requisitions: "Requisitions",
  pipeline: "Pipeline",
  offers_joiners: "Offers & joiners",
  partners_team: "Partners & team",
};

export interface AskDataCatalogEntry {
  id: AskDataIntentId;
  /** Short name shown as the first "How I read your question" chip. */
  label: string;
  /** The suggested question (chip text; also the pre-matcher's target). */
  question: string;
  /** One line the model sees when choosing an intent. */
  description: string;
  group: AskDataGroup;
  /** The parameters this intent honours; anything else is dropped. */
  params: readonly AskDataParamKey[];
  /** Window applied when the question names none (only when `period` is honoured). */
  defaultPeriod?: AskDataPeriod;
  /** Trend length applied when the question names none (only when `months` is honoured). */
  defaultMonths?: number;
}

export const ASK_DATA_CATALOG: readonly AskDataCatalogEntry[] = [
  {
    id: "open_reqs_by_bu",
    label: "Open requisitions by business unit",
    question: "How many open requisitions do we have, by business unit and status?",
    description:
      "Count of currently open requisitions (not draft, filled, cancelled or closed), broken down by business unit and status.",
    group: "requisitions",
    params: ["businessUnit"],
  },
  {
    id: "oldest_open_reqs",
    label: "Longest-open requisitions",
    question: "Which requisitions have been open the longest?",
    description: "The ten currently open requisitions with the most days open.",
    group: "requisitions",
    params: ["businessUnit"],
  },
  {
    id: "time_to_fill",
    label: "Time to fill",
    question: "What is our average time to fill?",
    description:
      "Typical days from application to accepted offer (median and 90th percentile) and the number of hires, for a period.",
    group: "requisitions",
    params: ["period", "businessUnit", "requisition"],
    defaultPeriod: "this_year",
  },
  {
    id: "time_to_fill_trend",
    label: "Time-to-fill trend",
    question: "How has time to fill trended over the last 6 months?",
    description: "Month-by-month median days to fill and hires, over the last N months.",
    group: "requisitions",
    params: ["months", "businessUnit", "requisition"],
    defaultMonths: 6,
  },
  {
    id: "pipeline_funnel",
    label: "Hiring funnel",
    question: "What does our hiring funnel look like?",
    description: "How many candidates currently sit at each pipeline stage.",
    group: "pipeline",
    params: ["period", "businessUnit", "requisition"],
    defaultPeriod: "all_time",
  },
  {
    id: "stage_bottlenecks",
    label: "Stage bottlenecks",
    question: "Where are candidates getting stuck?",
    description: "Median days candidates spend in each pipeline stage before moving on.",
    group: "pipeline",
    params: ["period", "businessUnit", "requisition"],
    defaultPeriod: "all_time",
  },
  {
    id: "hires_by_source",
    label: "Hires by source",
    question: "Where are our hires coming from?",
    description:
      "Applications and hires per sourcing channel (career site, referral, partner, job board…).",
    group: "pipeline",
    params: ["period", "businessUnit", "requisition"],
    defaultPeriod: "this_year",
  },
  {
    id: "pending_feedback",
    label: "Pending panel feedback",
    question: "Which interviews are still waiting for panel feedback?",
    description:
      "Completed interviews whose panel scorecards have not been submitted, by panelist.",
    group: "pipeline",
    params: ["period", "businessUnit", "requisition"],
    defaultPeriod: "all_time",
  },
  {
    id: "offer_acceptance",
    label: "Offer acceptance rate",
    question: "What is our offer acceptance rate?",
    description:
      "Share of answered offers that were accepted, with offers extended, accepted and declined.",
    group: "offers_joiners",
    params: ["period", "businessUnit", "requisition"],
    defaultPeriod: "this_year",
  },
  {
    id: "declined_offers",
    label: "Declined offers",
    question: "Which offers were declined, and why?",
    description: "List of declined offers with role, decline date and the recorded reason.",
    group: "offers_joiners",
    params: ["period", "businessUnit"],
    defaultPeriod: "this_year",
  },
  {
    id: "joiners_next_30_days",
    label: "Joiners in the next 30 days",
    question: "Who is joining in the next 30 days?",
    description:
      "New hires with a start date in the next 30 days and how ready their onboarding is (tasks, documents, background check, IT).",
    group: "offers_joiners",
    params: ["businessUnit"],
  },
  {
    id: "pending_approvals",
    label: "Pending approvals",
    question: "Which requisitions or offers are waiting for approval, and for how long?",
    description:
      "Approval requests still pending, what they are for, and how long they have waited.",
    group: "offers_joiners",
    params: [],
  },
  {
    id: "partner_performance",
    label: "Partner performance",
    question: "How is each recruitment partner performing?",
    description:
      "Per recruitment partner (agency): submissions, shortlist rate, hires and hire rate.",
    group: "partners_team",
    params: ["period", "businessUnit", "requisition"],
    defaultPeriod: "this_year",
  },
  {
    id: "recruiter_activity",
    label: "Recruiter activity",
    question: "How many candidates did each recruiter move forward?",
    description:
      "Per recruiter: requisitions owned, candidates handled, interviews booked, offers extended and hires.",
    group: "partners_team",
    params: ["period", "businessUnit"],
    defaultPeriod: "this_year",
  },
];

/** Catalog lookup by id. */
export function askDataCatalogEntry(id: AskDataIntentId): AskDataCatalogEntry {
  const entry = ASK_DATA_CATALOG.find((e) => e.id === id);
  if (!entry) throw new Error(`unknown ask-data intent: ${id}`);
  return entry;
}

// ─────────────────────────────── askDataCatalog ───────────────────────────────

export const askDataCatalogInputSchema = z.object({});

export const askDataCatalogOutputSchema = z.object({
  entries: z.array(
    z.object({
      id: askDataIntentIdSchema,
      label: z.string(),
      question: z.string(),
      group: z.enum(ASK_DATA_GROUPS),
      params: z.array(z.enum(ASK_DATA_PARAM_KEYS)),
      /** False when the caller's role cannot run this intent (hiring-manager scoping). */
      available: z.boolean(),
    }),
  ),
  /** The tenant's active business unit names — the inline BU editor's options. */
  businessUnits: z.array(z.string()),
  /** Whether free-text interpretation (the `ask_data` AI feature) is switched on. */
  aiEnabled: z.boolean(),
});
export type AskDataCatalogOutput = z.infer<typeof askDataCatalogOutputSchema>;

// ─────────────────────────────── askData ───────────────────────────────

export const askDataPreviousSchema = z.object({
  intent: askDataIntentIdSchema,
  params: askDataParamsSchema,
});
export type AskDataPrevious = z.infer<typeof askDataPreviousSchema>;

export const askDataInputSchema = z
  .object({
    question: z.string().trim().min(1).max(500).optional(),
    /** When present the AI is skipped entirely: execute this intent directly. */
    intent: askDataIntentIdSchema.optional(),
    params: askDataParamsSchema.optional(),
    /** The answer being followed up ("now only Finance", "same for last quarter"). */
    previous: askDataPreviousSchema.optional(),
  })
  .refine((v) => v.question !== undefined || v.intent !== undefined, {
    message: "Provide a question or an intent",
  });
export type AskDataInput = z.infer<typeof askDataInputSchema>;

/** How a column's values are typed — drives formatting in the portal and CSV. */
export const ASK_DATA_COLUMN_FORMATS = ["text", "number", "percent", "days", "date"] as const;

export const askDataColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  format: z.enum(ASK_DATA_COLUMN_FORMATS),
});
export type AskDataColumn = z.infer<typeof askDataColumnSchema>;

export const askDataResultSchema = z.object({
  title: z.string(),
  kind: z.enum(["kpi", "table", "bar", "line"]),
  columns: z.array(askDataColumnSchema),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  /** For bar / line: the category key and the plotted series keys. */
  chart: z.object({ x: z.string(), y: z.array(z.string()) }).optional(),
  /** One sentence built by code from the numbers above — never by the model. */
  summary: z.string(),
  /** Data source + definition. */
  footnote: z.string(),
  /** True when there is nothing to show for this scope ("No data for this period"). */
  empty: z.boolean(),
});
export type AskDataResult = z.infer<typeof askDataResultSchema>;

export const askDataChipSchema = z.object({
  key: z.enum(["intent", ...ASK_DATA_PARAM_KEYS]),
  label: z.string(),
  value: z.string(),
});
export type AskDataChip = z.infer<typeof askDataChipSchema>;

export const askDataInterpretationSchema = z.object({
  intent: askDataIntentIdSchema,
  intentLabel: z.string(),
  /** chip = clicked/edited chip; matched = deterministic match; ai = model interpretation. */
  source: z.enum(["chip", "matched", "ai"]),
  /** The EFFECTIVE params (defaults filled, unresolvable values dropped). */
  params: askDataParamsSchema,
  chips: z.array(askDataChipSchema),
  /** Human notes about anything dropped, defaulted or narrowed. */
  notes: z.array(z.string()),
});
export type AskDataInterpretation = z.infer<typeof askDataInterpretationSchema>;

export const askDataSuggestionSchema = z.object({
  intent: askDataIntentIdSchema,
  question: z.string(),
});

export const askDataOutputSchema = z.object({
  /**
   * answered — `result` present.
   * unsupported — the question maps to nothing in the catalog (honest "can't answer yet").
   * unavailable — the intent exists but not for this caller's role/scope.
   * ai_unavailable — free text could not be interpreted (feature off / AI error).
   */
  status: z.enum(["answered", "unsupported", "unavailable", "ai_unavailable"]),
  interpretation: askDataInterpretationSchema.optional(),
  result: askDataResultSchema.optional(),
  message: z.string().optional(),
  suggestions: z.array(askDataSuggestionSchema),
});
export type AskDataOutput = z.infer<typeof askDataOutputSchema>;
