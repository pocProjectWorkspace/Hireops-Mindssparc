import { z } from "zod";
import { bulkCvUploadLimitsSchema } from "./bulk-cv-upload";

/**
 * C2-F7 — policy parameters (Plan A §8, PP2–PP23).
 *
 * The remaining hard-coded policy numbers, as `tenants.settings` SIBLING
 * blocks (no migration). Each block follows the platform pattern (Plan A
 * §14.2): tenant value → else code default, always CLAMPED to the platform
 * guardrail, and the resolver NEVER throws.
 *
 *   screeningPolicy    PP2 risk flags, PP3 req-health weights, PP5 parser
 *                      confidence floor, PP6 JD char cap, PP8 dedup rules,
 *                      PP10 statuses that accept applications
 *   uploadPolicy       PP9 per-file caps + allowed types (tenant may LOWER only)
 *   offerPolicy        PP13 offer expiry / probation defaults, PP17 offer-decision SLA
 *   aiInterviewPolicy  PP14 link expiry + question-count range, PP15 language
 *   notetakerPolicy    PP16 language + custom keyterm glossary
 *   reportPolicy       PP22 metric definitions, PP23 row caps + onboarding window
 *   marketIntelPolicy  PP4 market-gap rule
 *   (retentionPolicy.talentPoolRetentionMonths — PP20 — lives in retention-policy.ts)
 *
 * Two kinds of validation, on purpose:
 *   - the WRITE schemas (`*WriteSchema`) are strict: an out-of-range value is a
 *     BAD_REQUEST from updatePolicyParameters, so an admin never silently gets
 *     a different number from the one they typed;
 *   - the RESOLVERS (`resolve*`) are lenient, field by field: a number outside
 *     the guardrail is CLAMPED into it, garbage falls back to the default for
 *     that field only. A hand-edited or imported settings row can never break
 *     the hot path (apply, scoring, reports) nor escape the guardrail.
 *
 * Every default below is the literal the code used before this ticket, so an
 * unconfigured tenant behaves byte-identically.
 */

type Json = Record<string, unknown>;

function rec(raw: unknown): Json {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Json) : {};
}

/** Finite number → (rounded when `int`) and clamped into [min, max]; else `def`. */
export function clampPolicyNumber(
  raw: unknown,
  g: { min: number; max: number; default: number },
  int = true,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return g.default;
  const v = int ? Math.round(raw) : raw;
  return Math.min(g.max, Math.max(g.min, v));
}

function pickEnum<T extends string>(raw: unknown, allowed: readonly T[], def: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as T) : def;
}

/** Valid, de-duplicated members of `allowed` (in `allowed` order); empty → `def`. */
function pickSubset<T extends string>(raw: unknown, allowed: readonly T[], def: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [...def];
  const set = new Set(raw.filter((x): x is T => (allowed as readonly string[]).includes(x)));
  const out = allowed.filter((a) => set.has(a));
  return out.length > 0 ? out : [...def];
}

const guard = (min: number, max: number, def: number) => ({ min, max, default: def }) as const;

const intIn = (g: { min: number; max: number }) => z.number().int().min(g.min).max(g.max);

// ─────────────────────────── screeningPolicy ───────────────────────────

export const SCREENING_POLICY_GUARDRAILS = {
  /** PP2 — must-have % at/below this reads as a skill gap. */
  riskSkillMismatchMaxPct: guard(0, 100, 50),
  /** PP2 — expected salary over this % of the band midpoint reads as a salary gap (compa-ratio rule). */
  riskSalaryCompaRatioPct: guard(80, 200, 110),
  /** PP5 — parser confidence below this skips AI scoring. */
  parserConfidenceFloor: guard(0, 0.9, 0.5),
  /** PP6 — JD characters sent to the scoring model (cost + context ceiling 24k). */
  jdCharCap: guard(2000, 24_000, 12_000),
  /** PP8 — days after a rejection before the same person may apply again (0 = off). */
  reapplyCoolingOffDays: guard(0, 365, 0),
} as const;

/** PP2 — which rule raises the salary-gap risk flag. */
export const SALARY_RISK_RULES = ["over_band_max", "over_compa_ratio"] as const;
export type SalaryRiskRule = (typeof SALARY_RISK_RULES)[number];

/**
 * PP8 — what identifies "the same person" on apply / partner submit / bulk CV.
 *   email_or_phone   either matches (the historical rule)
 *   email            email only (shared family / office phones are common)
 *   phone            phone only
 *   email_and_phone  both must match the SAME person; otherwise a new person
 */
export const DEDUP_MATCH_MODES = ["email_or_phone", "email", "phone", "email_and_phone"] as const;
export type DedupMatchMode = (typeof DEDUP_MATCH_MODES)[number];

/** PP10 — requisition statuses a tenant may open to applications (never draft / closed). */
export const APPLY_ACCEPTING_STATUS_OPTIONS = ["approved", "posted"] as const;
export type ApplyAcceptingStatus = (typeof APPLY_ACCEPTING_STATUS_OPTIONS)[number];

/** PP3 — requisition-health component weights (sum 100). The historical constants. */
export const REQ_HEALTH_WEIGHTS_DEFAULT = {
  jd: 20,
  skills: 15,
  mustHaves: 10,
  interviewPlan: 15,
  budget: 15,
  approval: 15,
  pipeline: 10,
} as const;
export type ReqHealthWeightKey = keyof typeof REQ_HEALTH_WEIGHTS_DEFAULT;
export const REQ_HEALTH_WEIGHT_KEYS = Object.keys(
  REQ_HEALTH_WEIGHTS_DEFAULT,
) as ReqHealthWeightKey[];
export type ReqHealthWeights = Record<ReqHealthWeightKey, number>;

const reqHealthWeightsWriteSchema = z
  .object({
    jd: intIn({ min: 0, max: 100 }),
    skills: intIn({ min: 0, max: 100 }),
    mustHaves: intIn({ min: 0, max: 100 }),
    interviewPlan: intIn({ min: 0, max: 100 }),
    budget: intIn({ min: 0, max: 100 }),
    approval: intIn({ min: 0, max: 100 }),
    pipeline: intIn({ min: 0, max: 100 }),
  })
  .refine((w) => Object.values(w).reduce((a, b) => a + b, 0) === 100, {
    message: "Requisition health weights must add up to 100.",
  });

const G_S = SCREENING_POLICY_GUARDRAILS;
export const screeningPolicyWriteSchema = z.object({
  riskSkillMismatchMaxPct: intIn(G_S.riskSkillMismatchMaxPct),
  riskSalaryRule: z.enum(SALARY_RISK_RULES),
  riskSalaryCompaRatioPct: intIn(G_S.riskSalaryCompaRatioPct),
  reqHealthWeights: reqHealthWeightsWriteSchema,
  parserConfidenceFloor: z
    .number()
    .min(G_S.parserConfidenceFloor.min)
    .max(G_S.parserConfidenceFloor.max),
  jdCharCap: intIn(G_S.jdCharCap),
  dedupMatchOn: z.enum(DEDUP_MATCH_MODES),
  reapplyCoolingOffDays: intIn(G_S.reapplyCoolingOffDays),
  acceptingStatuses: z.array(z.enum(APPLY_ACCEPTING_STATUS_OPTIONS)).min(1).max(2),
});
export type ScreeningPolicy = z.infer<typeof screeningPolicyWriteSchema>;

export function defaultScreeningPolicy(): ScreeningPolicy {
  return {
    riskSkillMismatchMaxPct: G_S.riskSkillMismatchMaxPct.default,
    riskSalaryRule: "over_band_max",
    riskSalaryCompaRatioPct: G_S.riskSalaryCompaRatioPct.default,
    reqHealthWeights: { ...REQ_HEALTH_WEIGHTS_DEFAULT },
    parserConfidenceFloor: G_S.parserConfidenceFloor.default,
    jdCharCap: G_S.jdCharCap.default,
    dedupMatchOn: "email_or_phone",
    reapplyCoolingOffDays: G_S.reapplyCoolingOffDays.default,
    acceptingStatuses: ["approved", "posted"],
  };
}

function resolveReqHealthWeights(raw: unknown): ReqHealthWeights {
  const r = rec(raw);
  const out = {} as ReqHealthWeights;
  for (const k of REQ_HEALTH_WEIGHT_KEYS) {
    out[k] = clampPolicyNumber(r[k], guard(0, 100, REQ_HEALTH_WEIGHTS_DEFAULT[k]));
  }
  // The composite is a 0–100 scale only when the weights total 100.
  const sum = REQ_HEALTH_WEIGHT_KEYS.reduce((a, k) => a + out[k], 0);
  return sum === 100 ? out : { ...REQ_HEALTH_WEIGHTS_DEFAULT };
}

export function resolveScreeningPolicy(raw: unknown): ScreeningPolicy {
  const r = rec(raw);
  const d = defaultScreeningPolicy();
  return {
    riskSkillMismatchMaxPct: clampPolicyNumber(
      r.riskSkillMismatchMaxPct,
      G_S.riskSkillMismatchMaxPct,
    ),
    riskSalaryRule: pickEnum(r.riskSalaryRule, SALARY_RISK_RULES, d.riskSalaryRule),
    riskSalaryCompaRatioPct: clampPolicyNumber(
      r.riskSalaryCompaRatioPct,
      G_S.riskSalaryCompaRatioPct,
    ),
    reqHealthWeights: resolveReqHealthWeights(r.reqHealthWeights),
    parserConfidenceFloor: clampPolicyNumber(
      r.parserConfidenceFloor,
      G_S.parserConfidenceFloor,
      false,
    ),
    jdCharCap: clampPolicyNumber(r.jdCharCap, G_S.jdCharCap),
    dedupMatchOn: pickEnum(r.dedupMatchOn, DEDUP_MATCH_MODES, d.dedupMatchOn),
    reapplyCoolingOffDays: clampPolicyNumber(r.reapplyCoolingOffDays, G_S.reapplyCoolingOffDays),
    acceptingStatuses: pickSubset(
      r.acceptingStatuses,
      APPLY_ACCEPTING_STATUS_OPTIONS,
      d.acceptingStatuses,
    ),
  };
}

// ─────────────────────────── uploadPolicy ───────────────────────────

const MB = 1024 * 1024;

/**
 * PP9 — the PLATFORM ceilings. The document ceiling is the platform constant
 * (`MAX_DOCUMENT_BYTES`, apps/api upload-limits.ts — 10 MB); the media ceiling
 * is the deployment's `MEDIA_MAX_UPLOAD_BYTES` (default 250 MB), applied by the
 * api at use time because only the api reads env. A tenant may LOWER either,
 * never raise it.
 */
export const UPLOAD_DOCUMENT_BYTES_CEILING = 10 * MB;
export const UPLOAD_POLICY_GUARDRAILS = {
  maxDocumentBytes: guard(1 * MB, UPLOAD_DOCUMENT_BYTES_CEILING, UPLOAD_DOCUMENT_BYTES_CEILING),
  /** Static bound only; the effective ceiling is min(this, env MEDIA_MAX_UPLOAD_BYTES). */
  maxMediaBytes: guard(10 * MB, 2048 * MB, 2048 * MB),
} as const;

export const RESUME_FILE_KINDS = ["pdf", "docx"] as const;
export const DOCUMENT_FILE_KINDS = ["pdf", "docx", "jpeg", "png"] as const;
export type UploadFileKind = (typeof DOCUMENT_FILE_KINDS)[number];

export const UPLOAD_FILE_KIND_MIME: Record<UploadFileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpeg: "image/jpeg",
  png: "image/png",
};

const G_U = UPLOAD_POLICY_GUARDRAILS;
export const uploadPolicyWriteSchema = z.object({
  maxDocumentBytes: intIn(G_U.maxDocumentBytes),
  /** null = the deployment's media ceiling. */
  maxMediaBytes: intIn(G_U.maxMediaBytes).nullable(),
  resumeTypes: z.array(z.enum(RESUME_FILE_KINDS)).min(1),
  documentTypes: z.array(z.enum(DOCUMENT_FILE_KINDS)).min(1),
});
export type UploadPolicy = z.infer<typeof uploadPolicyWriteSchema>;

export function defaultUploadPolicy(): UploadPolicy {
  return {
    maxDocumentBytes: UPLOAD_DOCUMENT_BYTES_CEILING,
    maxMediaBytes: null,
    resumeTypes: [...RESUME_FILE_KINDS],
    documentTypes: [...DOCUMENT_FILE_KINDS],
  };
}

export function resolveUploadPolicy(raw: unknown): UploadPolicy {
  const r = rec(raw);
  return {
    maxDocumentBytes: clampPolicyNumber(r.maxDocumentBytes, G_U.maxDocumentBytes),
    maxMediaBytes:
      typeof r.maxMediaBytes === "number" && Number.isFinite(r.maxMediaBytes)
        ? clampPolicyNumber(r.maxMediaBytes, G_U.maxMediaBytes)
        : null,
    resumeTypes: pickSubset(r.resumeTypes, RESUME_FILE_KINDS, RESUME_FILE_KINDS),
    documentTypes: pickSubset(r.documentTypes, DOCUMENT_FILE_KINDS, DOCUMENT_FILE_KINDS),
  };
}

/** The MIME types a resolved kind list allows. */
export function uploadMimeTypes(kinds: readonly UploadFileKind[]): Set<string> {
  return new Set(kinds.map((k) => UPLOAD_FILE_KIND_MIME[k]));
}

// ─────────────────────────── offerPolicy ───────────────────────────

export const OFFER_POLICY_GUARDRAILS = {
  /** PP13 — the expiry the offer form pre-fills and draftOffer uses when none is sent. */
  defaultExpiryDays: guard(1, 60, 7),
  /** PP13 — probation pre-filled on the comp-desk offer composer. */
  defaultProbationMonths: guard(0, 24, 3),
  /** PP17 — governance SLA target for an offer decision (extend → accept/decline). */
  decisionSlaHours: guard(1, 720, 24),
} as const;

const G_O = OFFER_POLICY_GUARDRAILS;
export const offerPolicyWriteSchema = z.object({
  defaultExpiryDays: intIn(G_O.defaultExpiryDays),
  defaultProbationMonths: intIn(G_O.defaultProbationMonths),
  decisionSlaHours: intIn(G_O.decisionSlaHours),
});
export type OfferPolicy = z.infer<typeof offerPolicyWriteSchema>;

export function defaultOfferPolicy(): OfferPolicy {
  return resolveOfferPolicy({});
}

export function resolveOfferPolicy(raw: unknown): OfferPolicy {
  const r = rec(raw);
  return {
    defaultExpiryDays: clampPolicyNumber(r.defaultExpiryDays, G_O.defaultExpiryDays),
    defaultProbationMonths: clampPolicyNumber(r.defaultProbationMonths, G_O.defaultProbationMonths),
    decisionSlaHours: clampPolicyNumber(r.decisionSlaHours, G_O.decisionSlaHours),
  };
}

// ─────────────────────────── aiInterviewPolicy ───────────────────────────

/**
 * PP14 / PP15. The 5–10 question range is the PLATFORM guardrail (rubric of
 * five criteria; ~30 minutes of unattended recording) — a tenant may narrow it,
 * never widen it. Language: the question prompt layer is English-only today,
 * so `language` is the key with a one-value allow-list (read-only in the UI).
 */
export const AI_INTERVIEW_POLICY_GUARDRAILS = {
  linkExpiryDays: guard(1, 30, 7),
  questionCountMin: guard(5, 10, 5),
  questionCountMax: guard(5, 10, 10),
} as const;
export const AI_INTERVIEW_LANGUAGES = ["en"] as const;

const G_A = AI_INTERVIEW_POLICY_GUARDRAILS;
export const aiInterviewPolicyWriteSchema = z
  .object({
    linkExpiryDays: intIn(G_A.linkExpiryDays),
    questionCountMin: intIn(G_A.questionCountMin),
    questionCountMax: intIn(G_A.questionCountMax),
    language: z.enum(AI_INTERVIEW_LANGUAGES),
  })
  .refine((p) => p.questionCountMin <= p.questionCountMax, {
    message: "The minimum question count cannot exceed the maximum.",
  });
export type AiInterviewPolicy = z.infer<typeof aiInterviewPolicyWriteSchema>;

export function defaultAiInterviewPolicy(): AiInterviewPolicy {
  return resolveAiInterviewPolicy({});
}

export function resolveAiInterviewPolicy(raw: unknown): AiInterviewPolicy {
  const r = rec(raw);
  const min = clampPolicyNumber(r.questionCountMin, G_A.questionCountMin);
  const max = clampPolicyNumber(r.questionCountMax, G_A.questionCountMax);
  return {
    linkExpiryDays: clampPolicyNumber(r.linkExpiryDays, G_A.linkExpiryDays),
    // An inverted pair collapses to the max rather than throwing.
    questionCountMin: Math.min(min, max),
    questionCountMax: max,
    language: pickEnum(r.language, AI_INTERVIEW_LANGUAGES, "en"),
  };
}

// ─────────────────────────── notetakerPolicy ───────────────────────────

/**
 * PP16. ASR provider, model and data region stay PLATFORM (deployment env:
 * ASR_PROVIDER, ASSEMBLYAI_REGION) — they are residency + commercial choices,
 * not tenant preferences. The tenant owns the transcription language (one
 * value until a non-English model is verified) and a glossary of domain terms
 * (P2P, R2R, SAP module names…) sent with every recording as ASR keyterms,
 * after the interview's own names.
 */
export const NOTETAKER_LANGUAGES = ["en"] as const;
export const NOTETAKER_KEYTERMS_MAX = 50;
/** AssemblyAI refuses a keyterm over six words; 60 chars matches the client's cap. */
export const NOTETAKER_KEYTERM_MAX_CHARS = 60;
export const NOTETAKER_KEYTERM_MAX_WORDS = 6;

function isUsableKeyterm(t: string): boolean {
  return (
    t.length > 0 &&
    t.length <= NOTETAKER_KEYTERM_MAX_CHARS &&
    t.split(/\s+/).length <= NOTETAKER_KEYTERM_MAX_WORDS
  );
}

export const notetakerPolicyWriteSchema = z.object({
  language: z.enum(NOTETAKER_LANGUAGES),
  keyterms: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(NOTETAKER_KEYTERM_MAX_CHARS)
        .refine(isUsableKeyterm, { message: "A keyterm may have at most six words." }),
    )
    .max(NOTETAKER_KEYTERMS_MAX),
});
export type NotetakerPolicy = z.infer<typeof notetakerPolicyWriteSchema>;

export function defaultNotetakerPolicy(): NotetakerPolicy {
  return { language: "en", keyterms: [] };
}

export function resolveNotetakerPolicy(raw: unknown): NotetakerPolicy {
  const r = rec(raw);
  const seen = new Set<string>();
  const keyterms: string[] = [];
  for (const t of Array.isArray(r.keyterms) ? r.keyterms : []) {
    if (typeof t !== "string") continue;
    const v = t.trim().replace(/\s+/g, " ");
    if (!isUsableKeyterm(v) || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    keyterms.push(v);
    if (keyterms.length >= NOTETAKER_KEYTERMS_MAX) break;
  }
  return { language: pickEnum(r.language, NOTETAKER_LANGUAGES, "en"), keyterms };
}

// ─────────────────────────── reportPolicy ───────────────────────────

/**
 * PP22 — metric definitions. Defaults are the definitions the semantic layer
 * has always used, so published numbers do not move until a tenant chooses.
 *   hireEvent  what counts as a hire in hire counts (source mix, totals):
 *              offer_accepted | joined (onboarding case has an actual start date)
 *   ttfStart   time-to-fill clock start: application created | requisition approved
 *   ttfEnd     time-to-fill clock end: offer accepted | joined
 * PP23 — detail-list row caps and the onboarding "starting soon" window.
 */
export const REPORT_HIRE_EVENTS = ["offer_accepted", "joined"] as const;
export const REPORT_TTF_STARTS = ["application_created", "requisition_approved"] as const;
export const REPORT_TTF_ENDS = ["offer_accepted", "joined"] as const;
export type ReportHireEvent = (typeof REPORT_HIRE_EVENTS)[number];
export type ReportTtfStart = (typeof REPORT_TTF_STARTS)[number];
export type ReportTtfEnd = (typeof REPORT_TTF_ENDS)[number];

export const REPORT_POLICY_GUARDRAILS = {
  requisitionAgingRowCap: guard(50, 5000, 500),
  onboardingRowCap: guard(50, 5000, 200),
  onboardingWindowDays: guard(1, 90, 14),
} as const;

const G_R = REPORT_POLICY_GUARDRAILS;
export const reportPolicyWriteSchema = z.object({
  hireEvent: z.enum(REPORT_HIRE_EVENTS),
  ttfStart: z.enum(REPORT_TTF_STARTS),
  ttfEnd: z.enum(REPORT_TTF_ENDS),
  requisitionAgingRowCap: intIn(G_R.requisitionAgingRowCap),
  onboardingRowCap: intIn(G_R.onboardingRowCap),
  onboardingWindowDays: intIn(G_R.onboardingWindowDays),
});
export type ReportPolicy = z.infer<typeof reportPolicyWriteSchema>;

export function defaultReportPolicy(): ReportPolicy {
  return resolveReportPolicy({});
}

export function resolveReportPolicy(raw: unknown): ReportPolicy {
  const r = rec(raw);
  return {
    hireEvent: pickEnum(r.hireEvent, REPORT_HIRE_EVENTS, "offer_accepted"),
    ttfStart: pickEnum(r.ttfStart, REPORT_TTF_STARTS, "application_created"),
    ttfEnd: pickEnum(r.ttfEnd, REPORT_TTF_ENDS, "offer_accepted"),
    requisitionAgingRowCap: clampPolicyNumber(r.requisitionAgingRowCap, G_R.requisitionAgingRowCap),
    onboardingRowCap: clampPolicyNumber(r.onboardingRowCap, G_R.onboardingRowCap),
    onboardingWindowDays: clampPolicyNumber(r.onboardingWindowDays, G_R.onboardingWindowDays),
  };
}

/** Plain-English time-to-fill definition for report footnotes / Ask-your-data. */
export function describeTimeToFill(p: Pick<ReportPolicy, "ttfStart" | "ttfEnd">): string {
  const start = p.ttfStart === "requisition_approved" ? "requisition approval" : "application";
  const end = p.ttfEnd === "joined" ? "the hire's joining date" : "its accepted offer";
  return `days from ${start} to ${end}`;
}

// ─────────────────────────── marketIntelPolicy ───────────────────────────

/**
 * PP4 — a requisition's budget reads "below market" when its band maximum is
 * under `gapThreshold` × the benchmark median (0.9 = more than 10 % below).
 */
export const MARKET_INTEL_POLICY_GUARDRAILS = {
  gapThreshold: guard(0.5, 1, 0.9),
} as const;

export const marketIntelPolicyWriteSchema = z.object({
  gapThreshold: z
    .number()
    .min(MARKET_INTEL_POLICY_GUARDRAILS.gapThreshold.min)
    .max(MARKET_INTEL_POLICY_GUARDRAILS.gapThreshold.max),
});
export type MarketIntelPolicy = z.infer<typeof marketIntelPolicyWriteSchema>;

export function defaultMarketIntelPolicy(): MarketIntelPolicy {
  return resolveMarketIntelPolicy({});
}

export function resolveMarketIntelPolicy(raw: unknown): MarketIntelPolicy {
  const r = rec(raw);
  return {
    gapThreshold: clampPolicyNumber(
      r.gapThreshold,
      MARKET_INTEL_POLICY_GUARDRAILS.gapThreshold,
      false,
    ),
  };
}

/** "more than 10% below" — the copy that must follow the configured threshold. */
export function marketGapPercentLabel(gapThreshold: number): string {
  return `${Math.round((1 - gapThreshold) * 100)}%`;
}

// ─────────────────────────── whole-settings helpers ───────────────────────────

/** Resolve one block out of a WHOLE tenants.settings jsonb. Never throws. */
export function policyBlock<T>(settings: unknown, key: string, resolve: (raw: unknown) => T): T {
  return resolve(rec(settings)[key]);
}

// ─────────────────────────── get / update ───────────────────────────

export const POLICY_PARAMETER_BLOCK_KEYS = [
  "screeningPolicy",
  "uploadPolicy",
  "offerPolicy",
  "aiInterviewPolicy",
  "notetakerPolicy",
  "reportPolicy",
  "marketIntelPolicy",
  "bulkCvUpload",
] as const;
export type PolicyParameterBlockKey = (typeof POLICY_PARAMETER_BLOCK_KEYS)[number];

export const getPolicyParametersInputSchema = z.object({});
export const getPolicyParametersOutputSchema = z.object({
  screeningPolicy: screeningPolicyWriteSchema,
  uploadPolicy: uploadPolicyWriteSchema,
  offerPolicy: offerPolicyWriteSchema,
  aiInterviewPolicy: aiInterviewPolicyWriteSchema,
  notetakerPolicy: notetakerPolicyWriteSchema,
  reportPolicy: reportPolicyWriteSchema,
  marketIntelPolicy: marketIntelPolicyWriteSchema,
  bulkCvUpload: bulkCvUploadLimitsSchema,
  /** Platform-controlled values shown read-only next to the tenant's choices. */
  platform: z.object({
    /** The deployment's media ceiling (env MEDIA_MAX_UPLOAD_BYTES). */
    mediaCeilingBytes: z.number().int().positive(),
    documentCeilingBytes: z.number().int().positive(),
    /** PP18 — tenants.settings.ai_provider; platform-controlled, no tenant UI. */
    aiProvider: z.string(),
  }),
});
export type GetPolicyParametersOutput = z.infer<typeof getPolicyParametersOutputSchema>;

export const updatePolicyParametersInputSchema = z.discriminatedUnion("block", [
  z.object({ block: z.literal("screeningPolicy"), value: screeningPolicyWriteSchema }),
  z.object({ block: z.literal("uploadPolicy"), value: uploadPolicyWriteSchema }),
  z.object({ block: z.literal("offerPolicy"), value: offerPolicyWriteSchema }),
  z.object({ block: z.literal("aiInterviewPolicy"), value: aiInterviewPolicyWriteSchema }),
  z.object({ block: z.literal("notetakerPolicy"), value: notetakerPolicyWriteSchema }),
  z.object({ block: z.literal("reportPolicy"), value: reportPolicyWriteSchema }),
  z.object({ block: z.literal("marketIntelPolicy"), value: marketIntelPolicyWriteSchema }),
  z.object({ block: z.literal("bulkCvUpload"), value: bulkCvUploadLimitsSchema }),
]);
export type UpdatePolicyParametersInput = z.infer<typeof updatePolicyParametersInputSchema>;
export const updatePolicyParametersOutputSchema = z.object({
  ok: z.literal(true),
  block: z.enum(POLICY_PARAMETER_BLOCK_KEYS),
});
export type UpdatePolicyParametersOutput = z.infer<typeof updatePolicyParametersOutputSchema>;

/** Offer-form defaults, readable by any staff role that drafts offers. */
export const getOfferPolicyDefaultsInputSchema = z.object({});
export const getOfferPolicyDefaultsOutputSchema = offerPolicyWriteSchema;

// ─────────────────────────── CV retention register (PP20) ───────────────────────────

export const cvRetentionRowSchema = z.object({
  candidateId: z.string(),
  fullName: z.string().nullable(),
  lastActivityAt: z.string(),
  ageMonths: z.number().int(),
  applicationCount: z.number().int(),
});
export type CvRetentionRow = z.infer<typeof cvRetentionRowSchema>;
export const listCvsPastRetentionInputSchema = z.object({});
export const listCvsPastRetentionOutputSchema = z.object({
  retentionMonths: z.number().int(),
  total: z.number().int(),
  items: z.array(cvRetentionRowSchema),
});
export type ListCvsPastRetentionOutput = z.infer<typeof listCvsPastRetentionOutputSchema>;
