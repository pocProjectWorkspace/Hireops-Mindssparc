/**
 * PC-11 + PC-12 — the consolidated all-rounds assessment summary for one
 * application, and the explicit final selection decision recorded against it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HUMANS DECIDE
 * ─────────────────────────────────────────────────────────────────────────
 * Everything aggregated here is a COUNT of human recommendations ("3 of 4
 * panellists: Yes or Strong yes") or an AVERAGE of human per-criterion ratings.
 * Nothing is weighted, ranked or blended into a single score, and the AI
 * interview / notetaker contribute EVIDENCE only (coverage + verbatim quotes,
 * a link to the notes) — never a number. The selection decision is a separate,
 * explicit human act (`recordSelectionDecision`); the summary never proposes one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A PANELLIST SEES
 * ─────────────────────────────────────────────────────────────────────────
 * Full viewers (the requisition's hiring manager, recruiter, hr_ops, hr_head,
 * admin) see every round. A panellist sees only the rounds they sat on, and the
 * existing panel independence rule is kept: before their OWN scorecard is
 * submitted they see nobody else's feedback for that round (the panel brief
 * never shows co-panellists' feedback). After submitting, they see co-panellists'
 * SUBMITTED recommendation + strengths + concerns — the same partial disclosure
 * `fetchPriorRoundFeedback` makes — but never another panellist's per-criterion
 * scores or private notes, and no criterion averages (an average of two ratings
 * where one is yours IS the other rating). See `applyPanellistDisclosure`.
 *
 * Pure zod + pure TS so the router and the unit tests share one definition.
 */

import { z } from "zod";
import {
  applicationStageSchema,
  interviewModeSchema,
  interviewStatusSchema,
  type ApplicationStage,
} from "./enums";
import {
  aiInterviewEvidenceReadStatusSchema,
  feedbackStateSchema,
  interviewRecommendationSchema,
  type FeedbackState,
  type InterviewRecommendation,
} from "./procedures";
import { aiInterviewKnockoutStatusSchema } from "./ai-interview";

/** Any id a Postgres `uuid` column will hold (see learning.ts — zod 4's
 * `.uuid()` is RFC-strict and rejects hand-seeded ids Postgres accepts). */
const pgUuid = z.guid();

// ═══════════════════════ selection decision vocabulary ═══════════════════════

export const SELECTION_DECISIONS = ["selected", "not_selected", "on_hold"] as const;
export const selectionDecisionSchema = z.enum(SELECTION_DECISIONS);
export type SelectionDecision = z.infer<typeof selectionDecisionSchema>;

/** Display labels. `selected` reads as the hand-off it is, not as an offer. */
export const SELECTION_DECISION_LABELS: Record<SelectionDecision, string> = {
  selected: "Selected — ready for offer handoff",
  not_selected: "Not selected",
  on_hold: "On hold",
};

// ═══════════════════════ reasons: tenants.settings block ═══════════════════════
//
// `tenants.settings.selectionDecisionReasons` — a sibling block on the CONF-01
// pattern (code default + lenient resolver). A tenant that has never configured
// it, or whose block is malformed or empty, gets the platform default list
// below. A configured list REPLACES the default (it is a lookup, not a merge).

export const SELECTION_DECISION_REASONS_VERSION = 1 as const;

export const selectionDecisionReasonKeySchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, "reason key must be lowercase snake_case");

export const selectionDecisionReasonSchema = z.object({
  key: selectionDecisionReasonKeySchema,
  label: z.string().min(1).max(120),
  /** Which decisions this reason may be recorded against. */
  appliesTo: z.array(selectionDecisionSchema).min(1),
});
export type SelectionDecisionReason = z.infer<typeof selectionDecisionReasonSchema>;

export const selectionDecisionReasonsBlockSchema = z.object({
  version: z
    .literal(SELECTION_DECISION_REASONS_VERSION)
    .default(SELECTION_DECISION_REASONS_VERSION),
  reasons: z.array(selectionDecisionReasonSchema).max(50).default([]),
});
export type SelectionDecisionReasonsBlock = z.infer<typeof selectionDecisionReasonsBlockSchema>;

/** The platform default list — used whenever a tenant has not configured one. */
export const DEFAULT_SELECTION_DECISION_REASONS: readonly SelectionDecisionReason[] = [
  { key: "panel_consensus", label: "Panel consensus to proceed", appliesTo: ["selected"] },
  { key: "best_fit", label: "Best fit among the finalists", appliesTo: ["selected"] },
  { key: "skills_gap", label: "Skills or experience gap", appliesTo: ["not_selected"] },
  { key: "role_fit", label: "Role or team fit concerns", appliesTo: ["not_selected"] },
  {
    key: "stronger_candidate",
    label: "Another candidate was preferred",
    appliesTo: ["not_selected"],
  },
  {
    key: "compensation_mismatch",
    label: "Compensation expectations not aligned",
    appliesTo: ["not_selected", "on_hold"],
  },
  {
    key: "notice_period",
    label: "Notice period or availability",
    appliesTo: ["not_selected", "on_hold"],
  },
  {
    key: "comparing_candidates",
    label: "Comparing with other candidates",
    appliesTo: ["on_hold"],
  },
  {
    key: "additional_round",
    label: "Additional round or reference needed",
    appliesTo: ["on_hold"],
  },
  {
    key: "requisition_review",
    label: "Requisition under review (budget / headcount)",
    appliesTo: ["on_hold"],
  },
  { key: "other", label: "Other (see notes)", appliesTo: ["selected", "not_selected", "on_hold"] },
];

/**
 * Resolve a tenant's reason list from the raw `selectionDecisionReasons` block.
 * Never throws: absent / malformed / empty → the platform default. Duplicate
 * keys in a tenant block keep the FIRST occurrence.
 */
export function resolveSelectionDecisionReasons(rawBlock: unknown): SelectionDecisionReason[] {
  const parsed = selectionDecisionReasonsBlockSchema.safeParse(rawBlock ?? {});
  if (!parsed.success || parsed.data.reasons.length === 0) {
    return DEFAULT_SELECTION_DECISION_REASONS.map((r) => ({ ...r, appliesTo: [...r.appliesTo] }));
  }
  const seen = new Set<string>();
  const out: SelectionDecisionReason[] = [];
  for (const r of parsed.data.reasons) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r);
  }
  return out;
}

/** The reason with this key, if it exists AND may be used for this decision. */
export function findSelectionDecisionReason(
  reasons: readonly SelectionDecisionReason[],
  decision: SelectionDecision,
  key: string,
): SelectionDecisionReason | null {
  const r = reasons.find((x) => x.key === key);
  return r && r.appliesTo.includes(decision) ? r : null;
}

// ═══════════════════════ decision → stage plan ═══════════════════════

/**
 * Stages a selection decision may be recorded at: the interview stages, plus
 * offer_drafted (so a selection can be re-affirmed, put on hold or reversed to
 * not-selected before the offer goes out). Earlier stages have no interview
 * outcome to decide on; terminal stages are closed (use the existing undo /
 * reopen paths instead).
 */
export const SELECTION_DECISION_OPEN_STAGES: ReadonlySet<ApplicationStage> =
  new Set<ApplicationStage>(["tech_interview", "hr_round", "offer_drafted"]);

/**
 * Where `selected` lands: offer_drafted — the stage advanceApplicationAfterInterview
 * moves an application to after its final (HR) round, and one of the two
 * OFFER_DRAFTABLE_STAGES, i.e. the offer-ready stage. No new enum value.
 */
export const SELECTED_TARGET_STAGE: ApplicationStage = "offer_drafted";

/** `not_selected` follows the existing reject path (rejectApplication). */
export const NOT_SELECTED_TARGET_STAGE: ApplicationStage = "recruiter_rejected";

export type SelectionDecisionPlan =
  | { ok: true; targetStage: ApplicationStage | null }
  | { ok: false; message: string };

/**
 * Pure: what a decision does to the stage. `targetStage: null` = record only.
 * The api performs the move through transitionApplicationStage, so the
 * HROPS-01 HR-assessment gate and the T2.1 candidate-field gate still apply.
 */
export function planSelectionDecision(
  decision: SelectionDecision,
  currentStage: ApplicationStage,
): SelectionDecisionPlan {
  if (!SELECTION_DECISION_OPEN_STAGES.has(currentStage)) {
    return {
      ok: false,
      message: `A selection decision can be recorded once the candidate is interviewing (tech interview, HR round or offer drafted); this application is at ${currentStage}.`,
    };
  }
  if (decision === "on_hold") return { ok: true, targetStage: null };
  if (decision === "not_selected") return { ok: true, targetStage: NOT_SELECTED_TARGET_STAGE };
  return {
    ok: true,
    targetStage: currentStage === SELECTED_TARGET_STAGE ? null : SELECTED_TARGET_STAGE,
  };
}

// ═══════════════════════ pure aggregation ═══════════════════════

export interface RecommendationCounts {
  strong_yes: number;
  yes: number;
  hold: number;
  no: number;
}

/** One panellist's feedback as read from the DB (before any disclosure rule). */
export interface RawPanelFeedback {
  membershipId: string;
  name: string | null;
  isLead: boolean;
  feedbackState: FeedbackState;
  recommendation: InterviewRecommendation | null;
  /** Saved ratings keyed by criterion key (only integers are kept). */
  scores: Record<string, number>;
  strengths: string | null;
  concerns: string | null;
  notes: string | null;
  submittedAt: string | null;
}

export interface CriterionDef {
  key: string;
  label: string;
}

export interface CriterionAverage {
  key: string;
  label: string;
  /** Mean of SUBMITTED human ratings, 1 dp; null when nobody rated it. */
  average: number | null;
  ratingCount: number;
}

/** Counts of recommendations across SUBMITTED scorecards only. */
export function countRecommendations(
  entries: readonly Pick<RawPanelFeedback, "feedbackState" | "recommendation">[],
): { counts: RecommendationCounts; submittedCount: number; positiveCount: number } {
  const counts: RecommendationCounts = { strong_yes: 0, yes: 0, hold: 0, no: 0 };
  let submittedCount = 0;
  for (const e of entries) {
    if (e.feedbackState !== "submitted") continue;
    submittedCount += 1;
    if (e.recommendation) counts[e.recommendation] += 1;
  }
  return { counts, submittedCount, positiveCount: counts.strong_yes + counts.yes };
}

/**
 * Per-criterion averages from SUBMITTED human ratings only. Drafts never count
 * (a half-filled scorecard is not an assessment yet). Rounded to 1 dp.
 */
export function averageCriteria(
  criteria: readonly CriterionDef[],
  entries: readonly Pick<RawPanelFeedback, "feedbackState" | "scores">[],
): CriterionAverage[] {
  return criteria.map((c) => {
    let sum = 0;
    let n = 0;
    for (const e of entries) {
      if (e.feedbackState !== "submitted") continue;
      const v = e.scores[c.key];
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    return {
      key: c.key,
      label: c.label,
      average: n > 0 ? Math.round((sum / n) * 10) / 10 : null,
      ratingCount: n,
    };
  });
}

/** What of one panellist's feedback the viewer is shown. */
export const feedbackDisclosureSchema = z.enum(["full", "summary", "hidden"]);
export type FeedbackDisclosure = z.infer<typeof feedbackDisclosureSchema>;

/**
 * The panellist disclosure rule (see the file header). `viewerMembershipId` is
 * the viewing panellist; their own entry is always `full`. Others are `hidden`
 * until the viewer's own scorecard is submitted, then `summary` (recommendation
 * + strengths + concerns of SUBMITTED feedback only).
 */
export function panellistDisclosureFor(
  entry: Pick<RawPanelFeedback, "membershipId" | "feedbackState">,
  viewerMembershipId: string,
  viewerSubmitted: boolean,
): FeedbackDisclosure {
  if (entry.membershipId === viewerMembershipId) return "full";
  if (!viewerSubmitted) return "hidden";
  return entry.feedbackState === "submitted" ? "summary" : "hidden";
}

// ═══════════════════════ wire schemas: summary ═══════════════════════

export const recommendationCountsSchema = z.object({
  strong_yes: z.number().int(),
  yes: z.number().int(),
  hold: z.number().int(),
  no: z.number().int(),
});

export const assessmentRatingSchema = z.object({
  key: z.string(),
  label: z.string(),
  score: z.number().int().nullable(),
});

export const assessmentFeedbackEntrySchema = z.object({
  membershipId: pgUuid,
  name: z.string().nullable(),
  isLead: z.boolean(),
  isMe: z.boolean(),
  feedbackState: feedbackStateSchema,
  disclosure: feedbackDisclosureSchema,
  recommendation: interviewRecommendationSchema.nullable(),
  /** Per-criterion ratings; [] unless disclosure is `full`. */
  ratings: z.array(assessmentRatingSchema),
  strengths: z.string().nullable(),
  concerns: z.string().nullable(),
  /** Detailed notes; null unless disclosure is `full`. */
  notes: z.string().nullable(),
  submittedAt: z.string().nullable(),
});
export type AssessmentFeedbackEntry = z.infer<typeof assessmentFeedbackEntrySchema>;

export const assessmentRoundRollupSchema = z.object({
  panelistCount: z.number().int(),
  submittedCount: z.number().int(),
  /** Null when the viewer may not see co-panellists' recommendations yet. */
  counts: recommendationCountsSchema.nullable(),
  /** strong_yes + yes among submitted; null alongside `counts`. */
  positiveCount: z.number().int().nullable(),
  leadRecommendation: interviewRecommendationSchema.nullable(),
});

export const assessmentCriterionAverageSchema = z.object({
  key: z.string(),
  label: z.string(),
  average: z.number().nullable(),
  ratingCount: z.number().int(),
});

export const assessmentRoundOutcomeSchema = z.object({
  kind: z.enum(["scheduled", "awaiting_feedback", "completed", "advanced", "cancelled", "no_show"]),
  /** Set when the round's completion advanced the application (INT-04). */
  advancedToStage: applicationStageSchema.nullable(),
  advancedAt: z.string().nullable(),
});
export type AssessmentRoundOutcome = z.infer<typeof assessmentRoundOutcomeSchema>;

/** AI interview EVIDENCE digest — coverage counts + verbatim quotes. No score. */
export const assessmentAiEvidenceSchema = z.object({
  status: aiInterviewEvidenceReadStatusSchema,
  /**
   * True when the viewer passes the summary's access rule but NOT the existing
   * getAiInterviewEvidence rule (admin / hiring_manager / recruiter): only the
   * status is returned — no summary, coverage, quotes or knockout quotes.
   */
  restricted: z.boolean(),
  summary: z.string().nullable(),
  answeredCount: z.number().int().nullable(),
  questionCount: z.number().int().nullable(),
  coverage: z.array(
    z.object({
      rubricKey: z.string(),
      label: z.string(),
      covered: z.number().int(),
      partial: z.number().int(),
      notCovered: z.number().int(),
    }),
  ),
  quotes: z.array(z.object({ rubricKey: z.string(), label: z.string(), quote: z.string() })),
  knockouts: z.array(
    z.object({
      question: z.string(),
      status: aiInterviewKnockoutStatusSchema,
      quote: z.string().nullable(),
    }),
  ),
});
export type AssessmentAiEvidence = z.infer<typeof assessmentAiEvidenceSchema>;

/**
 * Notetaker pointer. Present ONLY when the viewer passes the existing
 * interview-notes read rule for this round; the notes themselves are read
 * through getInterviewNotes (which re-enforces that rule and logs the access).
 */
export const assessmentNotetakerSchema = z.object({
  hasTranscript: z.boolean(),
  hasNotes: z.boolean(),
});

export const assessmentRoundSchema = z.object({
  interviewId: pgUuid,
  roundNumber: z.number().int(),
  roundName: z.string(),
  mode: interviewModeSchema,
  status: interviewStatusSchema,
  scheduledStart: z.string().nullable(),
  completedAt: z.string().nullable(),
  scorecardTemplate: z.string(),
  /** False for a panellist who has not submitted their own scorecard yet. */
  peerFeedbackVisible: z.boolean(),
  feedback: z.array(assessmentFeedbackEntrySchema),
  rollup: assessmentRoundRollupSchema,
  /** Human ratings only; [] when withheld from a panellist. */
  criterionAverages: z.array(assessmentCriterionAverageSchema),
  outcome: assessmentRoundOutcomeSchema,
  aiEvidence: assessmentAiEvidenceSchema.nullable(),
  notetaker: assessmentNotetakerSchema.nullable(),
});
export type AssessmentRound = z.infer<typeof assessmentRoundSchema>;

export const assessmentScreeningSchema = z.object({
  knockout: z.object({
    status: z.enum(["passed", "failed", "unverified", "not_evaluated"]),
    evaluatedAt: z.string().nullable(),
    configuredCount: z.number().int(),
    failures: z.array(
      z.object({
        question: z.string(),
        result: z.enum(["failed", "unverified"]),
      }),
    ),
  }),
  /** Required JD skills vs parsed résumé skills (deterministic). Null when the
   * requisition's JD has no required skills. */
  mustHaves: z
    .object({
      matched: z.array(z.string()),
      missing: z.array(z.string()),
    })
    .nullable(),
});
export type AssessmentScreening = z.infer<typeof assessmentScreeningSchema>;

export const getCandidateAssessmentSummaryInputSchema = z.object({
  applicationId: pgUuid,
});
export type GetCandidateAssessmentSummaryInput = z.infer<
  typeof getCandidateAssessmentSummaryInputSchema
>;

export const getCandidateAssessmentSummaryOutputSchema = z.object({
  application: z.object({
    applicationId: pgUuid,
    candidateId: pgUuid,
    requisitionId: pgUuid,
    candidateName: z.string().nullable(),
    positionTitle: z.string().nullable(),
    currentStage: applicationStageSchema,
  }),
  viewer: z.object({
    mode: z.enum(["full", "panellist"]),
    canDecide: z.boolean(),
  }),
  rounds: z.array(assessmentRoundSchema),
  /** Across every round the viewer can see, counting only what is disclosed. */
  overall: z.object({
    roundCount: z.number().int(),
    completedRoundCount: z.number().int(),
    submittedScorecards: z.number().int(),
    positiveScorecards: z.number().int(),
    counts: recommendationCountsSchema,
  }),
  /** Null for panellists, and when nothing was evaluated at screening. */
  screening: assessmentScreeningSchema.nullable(),
  /** The tenant's reason lookup; [] unless the viewer can decide. */
  decisionReasons: z.array(selectionDecisionReasonSchema),
});
export type GetCandidateAssessmentSummaryOutput = z.infer<
  typeof getCandidateAssessmentSummaryOutputSchema
>;

// ═══════════════════════ wire schemas: decision ═══════════════════════

export const recordSelectionDecisionInputSchema = z.object({
  applicationId: pgUuid,
  decision: selectionDecisionSchema,
  reasonKey: selectionDecisionReasonKeySchema.optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type RecordSelectionDecisionInput = z.infer<typeof recordSelectionDecisionInputSchema>;

export const recordSelectionDecisionOutputSchema = z.object({
  decisionId: pgUuid,
  applicationId: pgUuid,
  decision: selectionDecisionSchema,
  fromStage: applicationStageSchema,
  /** The stage the decision moved the application to; null when it did not move. */
  toStage: applicationStageSchema.nullable(),
  transitionId: pgUuid.nullable(),
  decidedAt: z.string(),
});
export type RecordSelectionDecisionOutput = z.infer<typeof recordSelectionDecisionOutputSchema>;

export const selectionDecisionRowSchema = z.object({
  id: pgUuid,
  applicationId: pgUuid,
  decision: selectionDecisionSchema,
  reasonKey: z.string().nullable(),
  /** The label as it read when the decision was made (snapshotted). */
  reasonLabel: z.string().nullable(),
  notes: z.string().nullable(),
  decidedByName: z.string().nullable(),
  fromStage: applicationStageSchema,
  toStage: applicationStageSchema.nullable(),
  decidedAt: z.string(),
});
export type SelectionDecisionRow = z.infer<typeof selectionDecisionRowSchema>;

export const listSelectionDecisionsInputSchema = z.object({
  applicationId: pgUuid,
});
export const listSelectionDecisionsOutputSchema = z.object({
  latest: selectionDecisionRowSchema.nullable(),
  /** Newest first. */
  history: z.array(selectionDecisionRowSchema),
});
export type ListSelectionDecisionsOutput = z.infer<typeof listSelectionDecisionsOutputSchema>;

export const listLatestSelectionDecisionsInputSchema = z.object({
  applicationIds: z.array(pgUuid).min(1).max(500),
});
export const latestSelectionDecisionSchema = z.object({
  applicationId: pgUuid,
  decision: selectionDecisionSchema,
  reasonLabel: z.string().nullable(),
  decidedAt: z.string(),
});
export type LatestSelectionDecision = z.infer<typeof latestSelectionDecisionSchema>;
export const listLatestSelectionDecisionsOutputSchema = z.object({
  rows: z.array(latestSelectionDecisionSchema),
});
export type ListLatestSelectionDecisionsOutput = z.infer<
  typeof listLatestSelectionDecisionsOutputSchema
>;
