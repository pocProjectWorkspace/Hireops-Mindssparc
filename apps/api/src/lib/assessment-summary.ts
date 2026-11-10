/**
 * PC-11 — the consolidated all-rounds assessment summary for one application,
 * and (PC-12) the access + reason helpers the selection decision shares with it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHO SEES WHAT
 * ─────────────────────────────────────────────────────────────────────────
 *   full       — recruiter, hr_ops, hr_head, admin, and a hiring_manager who is
 *                THE hiring manager of this application's requisition. Every
 *                round, every panellist's full scorecard, criterion averages,
 *                the screening snapshot.
 *   panellist  — anyone else who sat on a panel for this application. ONLY the
 *                rounds they sat on, under the disclosure rule in
 *                @hireops/api-types assessment-summary.ts (their own feedback in
 *                full; nobody else's before their own is submitted; afterwards
 *                co-panellists' submitted recommendation + strengths + concerns
 *                only — never another panellist's ratings or notes).
 *   otherwise  — FORBIDDEN. A hiring_manager on a requisition they do not own
 *                is not a full viewer just by holding the role.
 *
 * The notetaker pointer follows the EXISTING notes rule
 * (interviewNotesReadPermitted from ./interview-notes-read) — it is not widened
 * to hr_ops / hr_head just because they can see the rest of the summary.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * EVIDENCE, NOT SCORES
 * ─────────────────────────────────────────────────────────────────────────
 * Aggregates are COUNTS of human recommendations and AVERAGES of human
 * per-criterion ratings. The AI interview contributes coverage counts and
 * verbatim quotes from its evidence report; nothing here turns that into a
 * number, and nothing proposes a decision.
 *
 * Reads go through the caller's RLS-bound drizzle handle (tenant-scoped by the
 * protectedProcedure transaction) with an explicit tenant predicate on the
 * entry read as well.
 */

import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql as dsql } from "drizzle-orm";
import {
  tenants,
  applications,
  applicationStateTransitions,
  candidates,
  persons,
  requisitions,
  positions,
  interviews,
  interviewPanelists,
  interviewFeedback,
  interviewPlans,
  tenantScorecardTemplate,
  tenantUserMemberships,
  users,
  aiInterviewSessions,
  aiInterviewEvidence,
  interviewTranscripts,
  interviewNotes,
  requisitionKnockouts,
  jdSkills,
  type ApplicationStage,
  type TenantBoundDb,
} from "@hireops/db";
import {
  aiInterviewEvidenceSchema,
  averageCriteria,
  coerceScorecardCriteria,
  computeSkillsMatch,
  countRecommendations,
  panellistDisclosureFor,
  resolveScorecardCriteria,
  resolveSelectionDecisionReasons,
  type AiInterviewEvidenceReadStatus,
  type AssessmentAiEvidence,
  type AssessmentFeedbackEntry,
  type AssessmentRound,
  type AssessmentRoundOutcome,
  type AssessmentScreening,
  type FeedbackState,
  type GetCandidateAssessmentSummaryOutput,
  type InterviewRecommendation,
  type RawPanelFeedback,
  type ScorecardCriterion,
  type SelectionDecisionReason,
} from "@hireops/api-types";
import { interviewNotesReadPermitted } from "./interview-notes-read";
import { parsedSkillNames } from "./skill-match";

/** Roles that see the whole summary on role alone. */
export const ASSESSMENT_FULL_ROLES: Set<string> = new Set([
  "admin",
  "recruiter",
  "hr_ops",
  "hr_head",
]);

/** Roles that may record a selection decision on role alone (HM: own req only). */
export const SELECTION_DECISION_ROLES: Set<string> = new Set(["admin", "recruiter"]);

/** The coarse persona gate in front of recordSelectionDecision (HM re-checked per req). */
export const SELECTION_DECISION_GATE_ROLES: Set<string> = new Set([
  ...SELECTION_DECISION_ROLES,
  "hiring_manager",
]);

/** The coarse persona gate in front of the summary read. */
export const ASSESSMENT_SUMMARY_ROLES: Set<string> = new Set([
  ...ASSESSMENT_FULL_ROLES,
  "hiring_manager",
  "panel_member",
]);

/**
 * INTERVIEW_MANAGE_ROLES (router) — the role half of BOTH existing read rules
 * this summary must not widen: the notetaker notes rule (getInterviewNotes) and
 * the AI interview evidence rule (getAiInterviewEvidence). hr_ops / hr_head see
 * the human scorecards here, but not the AI evidence digest or the notes link.
 */
const INTERVIEW_MANAGE_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "hiring_manager",
  "recruiter",
]);

const VALID_RECS: ReadonlySet<string> = new Set(["strong_yes", "yes", "hold", "no"]);
const EVIDENCE_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "processing",
  "done",
  "failed",
  "skipped",
]);
const MAX_QUOTES_PER_ROUND = 6;

export interface AssessmentViewer {
  tenantId: string;
  roles: readonly string[];
  /** The caller's tenant_user_memberships.id, or null. */
  membershipId: string | null;
}

function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function deriveState(feedbackId: string | null, submittedAt: Date | string | null): FeedbackState {
  if (!feedbackId) return "none";
  return submittedAt ? "submitted" : "draft";
}

function toRec(v: string | null): InterviewRecommendation | null {
  return v && VALID_RECS.has(v) ? (v as InterviewRecommendation) : null;
}

function toScores(v: unknown): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

// ═══════════════════════ access ═══════════════════════

export interface ApplicationAccessFacts {
  applicationId: string;
  tenantId: string;
  candidateId: string;
  requisitionId: string;
  currentStage: ApplicationStage;
  hiringManagerId: string | null;
}

/** The application + its requisition's hiring manager, or NOT_FOUND. */
export async function loadApplicationAccessFacts(
  db: TenantBoundDb,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationAccessFacts> {
  const [row] = await db
    .select({
      applicationId: applications.id,
      tenantId: applications.tenantId,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      currentStage: applications.currentStage,
      hiringManagerId: requisitions.hiringManagerId,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .where(and(eq(applications.tenantId, tenantId), eq(applications.id, applicationId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
  return { ...row, hiringManagerId: row.hiringManagerId ?? null };
}

/** Is the viewer THE hiring manager of this application's requisition? */
export function isRequisitionHiringManager(
  viewer: AssessmentViewer,
  facts: Pick<ApplicationAccessFacts, "hiringManagerId">,
): boolean {
  return (
    viewer.roles.includes("hiring_manager") &&
    viewer.membershipId !== null &&
    facts.hiringManagerId !== null &&
    viewer.membershipId === facts.hiringManagerId
  );
}

export function isFullAssessmentViewer(
  viewer: AssessmentViewer,
  facts: Pick<ApplicationAccessFacts, "hiringManagerId">,
): boolean {
  return (
    viewer.roles.some((r) => ASSESSMENT_FULL_ROLES.has(r)) ||
    isRequisitionHiringManager(viewer, facts)
  );
}

/** May the viewer record a selection decision on this application? */
export function canRecordSelectionDecision(
  viewer: AssessmentViewer,
  facts: Pick<ApplicationAccessFacts, "hiringManagerId">,
): boolean {
  return (
    viewer.roles.some((r) => SELECTION_DECISION_ROLES.has(r)) ||
    isRequisitionHiringManager(viewer, facts)
  );
}

// ═══════════════════════ reasons ═══════════════════════

/**
 * The tenant's selection-decision reason list: `tenants.settings
 * .selectionDecisionReasons`, falling back to the platform default list (the
 * CONF-01 pattern: code default + lenient resolver, never throws). Read on the
 * caller's tenant-bound handle (tenants has a tenant-scoped SELECT policy).
 */
export async function resolveTenantSelectionDecisionReasons(
  db: TenantBoundDb,
  tenantId: string,
): Promise<SelectionDecisionReason[]> {
  const [row] = await db
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  return resolveSelectionDecisionReasons(settings["selectionDecisionReasons"]);
}

// ═══════════════════════ the summary read ═══════════════════════

export interface BuildAssessmentSummaryResult {
  output: GetCandidateAssessmentSummaryOutput;
  candidateId: string;
  /** True when verbatim candidate quotes (AI evidence) were returned. */
  quotesReturned: boolean;
}

interface PanelRow {
  interviewId: string;
  membershipId: string;
  isLead: boolean;
  name: string | null;
  feedbackId: string | null;
  scorecard: unknown;
  strengths: string | null;
  concerns: string | null;
  notes: string | null;
  recommendation: string | null;
  submittedAt: Date | string | null;
}

export async function buildCandidateAssessmentSummary(
  db: TenantBoundDb,
  viewer: AssessmentViewer,
  applicationId: string,
): Promise<BuildAssessmentSummaryResult> {
  const { tenantId } = viewer;

  const [app] = await db
    .select({
      applicationId: applications.id,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      currentStage: applications.currentStage,
      knockoutPassed: applications.knockoutPassed,
      knockoutFailures: applications.knockoutFailures,
      knockoutEvaluatedAt: applications.knockoutEvaluatedAt,
      hiringManagerId: requisitions.hiringManagerId,
      jdVersionId: requisitions.jdVersionId,
      candidateName: persons.fullName,
      parsedSkills: candidates.parsedSkills,
      positionTitle: positions.title,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .where(and(eq(applications.tenantId, tenantId), eq(applications.id, applicationId)))
    .limit(1);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

  const facts = { hiringManagerId: app.hiringManagerId ?? null };
  const full = isFullAssessmentViewer(viewer, facts);
  const canDecide = canRecordSelectionDecision(viewer, facts);
  const hasManageRole = viewer.roles.some((r) => INTERVIEW_MANAGE_ROLES.has(r));

  // Every round of this application, in order. Cancelled rounds carry no
  // assessment and are left out.
  const allRounds = await db
    .select({
      id: interviews.id,
      roundNumber: interviews.roundNumber,
      roundName: interviews.roundName,
      status: interviews.status,
      mode: interviews.mode,
      scheduledStart: interviews.scheduledStart,
      completedAt: interviews.completedAt,
      scorecardTemplate: interviews.scorecardTemplate,
      scorecardCriteriaSnapshot: interviews.scorecardCriteriaSnapshot,
    })
    .from(interviews)
    .where(
      and(
        eq(interviews.tenantId, tenantId),
        eq(interviews.applicationId, applicationId),
        dsql`${interviews.status} <> 'cancelled'`,
      ),
    )
    .orderBy(asc(interviews.roundNumber), asc(interviews.scheduledStart));

  const allIds = allRounds.map((r) => r.id);
  const panelRows: PanelRow[] =
    allIds.length === 0
      ? []
      : await db
          .select({
            interviewId: interviewPanelists.interviewId,
            membershipId: interviewPanelists.membershipId,
            isLead: interviewPanelists.isLead,
            name: users.displayName,
            feedbackId: interviewFeedback.id,
            scorecard: interviewFeedback.scorecard,
            strengths: interviewFeedback.strengths,
            concerns: interviewFeedback.concerns,
            notes: interviewFeedback.notes,
            recommendation: interviewFeedback.recommendation,
            submittedAt: interviewFeedback.submittedAt,
          })
          .from(interviewPanelists)
          .leftJoin(
            tenantUserMemberships,
            eq(tenantUserMemberships.id, interviewPanelists.membershipId),
          )
          .leftJoin(users, eq(users.id, tenantUserMemberships.userId))
          .leftJoin(
            interviewFeedback,
            and(
              eq(interviewFeedback.interviewId, interviewPanelists.interviewId),
              eq(interviewFeedback.membershipId, interviewPanelists.membershipId),
            ),
          )
          .where(inArray(interviewPanelists.interviewId, allIds));

  const panelByInterview = new Map<string, PanelRow[]>();
  for (const r of panelRows) {
    const list = panelByInterview.get(r.interviewId) ?? [];
    list.push(r);
    panelByInterview.set(r.interviewId, list);
  }
  const sitOn = (interviewId: string): boolean =>
    viewer.membershipId !== null &&
    (panelByInterview.get(interviewId) ?? []).some((p) => p.membershipId === viewer.membershipId);

  const rounds = full ? allRounds : allRounds.filter((r) => sitOn(r.id));
  if (!full && rounds.length === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "You can view this candidate's assessment summary only as their requisition's hiring manager, a recruiter, HR, or a panellist on one of their rounds.",
    });
  }
  const roundIds = rounds.map((r) => r.id);

  // Criteria: the interview's frozen snapshot, else its template resolved
  // against the tenant's custom rubrics (plan round as the template fallback).
  const needsResolve = rounds.some(
    (r) => coerceScorecardCriteria(r.scorecardCriteriaSnapshot).length === 0,
  );
  let tenantCriteria: Map<string, readonly ScorecardCriterion[]> | null = null;
  let planTemplates = new Map<number, string>();
  if (needsResolve) {
    const [rubrics, plans] = await Promise.all([
      db
        .select({
          scorecardKey: tenantScorecardTemplate.scorecardKey,
          criteria: tenantScorecardTemplate.criteria,
        })
        .from(tenantScorecardTemplate)
        .where(eq(tenantScorecardTemplate.tenantId, tenantId)),
      db
        .select({
          roundNumber: interviewPlans.roundNumber,
          scorecardTemplate: interviewPlans.scorecardTemplate,
        })
        .from(interviewPlans)
        .where(eq(interviewPlans.requisitionId, app.requisitionId)),
    ]);
    tenantCriteria = new Map();
    for (const r of rubrics) {
      const c = coerceScorecardCriteria(r.criteria);
      if (c.length > 0) tenantCriteria.set(r.scorecardKey, c);
    }
    planTemplates = new Map(plans.map((p) => [p.roundNumber, p.scorecardTemplate]));
  }

  // Round outcome: the INT-04 advance transition that names this interview.
  const advances =
    roundIds.length === 0
      ? []
      : await db
          .select({
            toStage: applicationStateTransitions.toStage,
            transitionedAt: applicationStateTransitions.transitionedAt,
            interviewId: dsql<
              string | null
            >`${applicationStateTransitions.metadata} ->> 'interviewId'`,
          })
          .from(applicationStateTransitions)
          .where(
            and(
              eq(applicationStateTransitions.tenantId, tenantId),
              eq(applicationStateTransitions.applicationId, applicationId),
              dsql`${applicationStateTransitions.metadata} ->> 'source' = 'advance_application_after_interview'`,
            ),
          )
          .orderBy(asc(applicationStateTransitions.transitionedAt));
  const advanceByInterview = new Map<string, { toStage: ApplicationStage; at: string | null }>();
  for (const a of advances) {
    if (a.interviewId) {
      advanceByInterview.set(a.interviewId, { toStage: a.toStage, at: toIso(a.transitionedAt) });
    }
  }

  // AI interview evidence (ai_async rounds only). The digest (summary,
  // coverage, verbatim quotes) is read only for viewers who pass the existing
  // getAiInterviewEvidence rule; everyone else gets the status alone.
  const aiRoundIds = hasManageRole
    ? rounds.filter((r) => r.mode === "ai_async").map((r) => r.id)
    : [];
  const evidenceRows =
    aiRoundIds.length === 0
      ? []
      : await db
          .select({
            interviewId: aiInterviewSessions.interviewId,
            status: aiInterviewEvidence.status,
            evidence: aiInterviewEvidence.evidence,
          })
          .from(aiInterviewSessions)
          .leftJoin(
            aiInterviewEvidence,
            and(
              eq(aiInterviewEvidence.tenantId, aiInterviewSessions.tenantId),
              eq(aiInterviewEvidence.sessionId, aiInterviewSessions.id),
            ),
          )
          .where(
            and(
              eq(aiInterviewSessions.tenantId, tenantId),
              inArray(aiInterviewSessions.interviewId, aiRoundIds),
            ),
          );
  const evidenceByInterview = new Map(evidenceRows.map((e) => [e.interviewId, e]));

  // Notetaker presence — only for rounds where the EXISTING notes rule passes.
  const notesRoundIds = rounds
    .filter((r) => interviewNotesReadPermitted(hasManageRole, sitOn(r.id)))
    .map((r) => r.id);
  const [transcriptRows, notesRows] =
    notesRoundIds.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({ interviewId: interviewTranscripts.interviewId })
            .from(interviewTranscripts)
            .where(
              and(
                eq(interviewTranscripts.tenantId, tenantId),
                inArray(interviewTranscripts.interviewId, notesRoundIds),
              ),
            ),
          db
            .select({ interviewId: interviewNotes.interviewId })
            .from(interviewNotes)
            .where(
              and(
                eq(interviewNotes.tenantId, tenantId),
                inArray(interviewNotes.interviewId, notesRoundIds),
              ),
            ),
        ]);
  const withTranscript = new Set(transcriptRows.map((r) => r.interviewId));
  const withNotes = new Set(notesRows.map((r) => r.interviewId));
  const notesAllowed = new Set(notesRoundIds);

  let quotesReturned = false;
  const nowMs = Date.now();
  const overallCounts = { strong_yes: 0, yes: 0, hold: 0, no: 0 };
  let overallSubmitted = 0;

  const outRounds: AssessmentRound[] = rounds.map((r) => {
    const snapshot = coerceScorecardCriteria(r.scorecardCriteriaSnapshot);
    const template = r.scorecardTemplate ?? planTemplates.get(r.roundNumber) ?? "general";
    const criteria: readonly ScorecardCriterion[] =
      snapshot.length > 0 ? snapshot : resolveScorecardCriteria(template, tenantCriteria);
    const labelOf = new Map(criteria.map((c) => [c.key, c.label]));

    const raw: RawPanelFeedback[] = (panelByInterview.get(r.id) ?? []).map((p) => ({
      membershipId: p.membershipId,
      name: p.name ?? null,
      isLead: p.isLead,
      feedbackState: deriveState(p.feedbackId, p.submittedAt),
      recommendation: toRec(p.recommendation),
      scores: toScores(p.scorecard),
      strengths: p.strengths ?? null,
      concerns: p.concerns ?? null,
      notes: p.notes ?? null,
      submittedAt: toIso(p.submittedAt),
    }));
    // Lead first, then by name — a stable reading order.
    raw.sort(
      (a, b) => Number(b.isLead) - Number(a.isLead) || (a.name ?? "").localeCompare(b.name ?? ""),
    );

    const mine = viewer.membershipId
      ? raw.find((p) => p.membershipId === viewer.membershipId)
      : undefined;
    const viewerSubmitted = mine?.feedbackState === "submitted";
    const peerVisible = full || viewerSubmitted;

    const feedback: AssessmentFeedbackEntry[] = raw.map((p) => {
      const disclosure = full
        ? "full"
        : panellistDisclosureFor(p, viewer.membershipId ?? "", viewerSubmitted);
      const isMe = viewer.membershipId !== null && p.membershipId === viewer.membershipId;
      if (disclosure === "hidden") {
        return {
          membershipId: p.membershipId,
          name: p.name,
          isLead: p.isLead,
          isMe,
          feedbackState: p.feedbackState,
          disclosure,
          recommendation: null,
          ratings: [],
          strengths: null,
          concerns: null,
          notes: null,
          submittedAt: null,
        };
      }
      const showRec = p.feedbackState === "submitted" || isMe;
      return {
        membershipId: p.membershipId,
        name: p.name,
        isLead: p.isLead,
        isMe,
        feedbackState: p.feedbackState,
        disclosure,
        recommendation: showRec ? p.recommendation : null,
        ratings:
          disclosure === "full"
            ? criteria.map((c) => {
                const s = p.scores[c.key];
                return { key: c.key, label: c.label, score: typeof s === "number" ? s : null };
              })
            : [],
        strengths: p.strengths,
        concerns: p.concerns,
        notes: disclosure === "full" ? p.notes : null,
        submittedAt: p.submittedAt,
      };
    });

    // Counts only over what the viewer may see.
    const countable = peerVisible ? raw : raw.filter((p) => p.membershipId === viewer.membershipId);
    const { counts, submittedCount, positiveCount } = countRecommendations(countable);
    overallSubmitted += submittedCount;
    for (const k of Object.keys(overallCounts) as (keyof typeof overallCounts)[]) {
      overallCounts[k] += counts[k];
    }
    const lead = raw.find((p) => p.isLead && p.feedbackState === "submitted");
    const leadVisible = lead && (peerVisible || lead.membershipId === viewer.membershipId);

    // Outcome.
    const adv = advanceByInterview.get(r.id);
    let outcome: AssessmentRoundOutcome;
    if (r.status === "no_show") {
      outcome = { kind: "no_show", advancedToStage: null, advancedAt: null };
    } else if (r.status === "completed") {
      outcome = adv
        ? { kind: "advanced", advancedToStage: adv.toStage, advancedAt: adv.at }
        : { kind: "completed", advancedToStage: null, advancedAt: null };
    } else {
      const start = r.scheduledStart ? new Date(r.scheduledStart).getTime() : NaN;
      outcome = {
        kind: Number.isFinite(start) && start < nowMs ? "awaiting_feedback" : "scheduled",
        advancedToStage: null,
        advancedAt: null,
      };
    }

    // AI evidence digest.
    let aiEvidence: AssessmentAiEvidence | null = null;
    if (r.mode === "ai_async" && !hasManageRole) {
      aiEvidence = {
        status: "none",
        restricted: true,
        summary: null,
        answeredCount: null,
        questionCount: null,
        coverage: [],
        quotes: [],
        knockouts: [],
      };
    } else if (r.mode === "ai_async") {
      const ev = evidenceByInterview.get(r.id);
      const status: AiInterviewEvidenceReadStatus =
        ev?.status && EVIDENCE_STATUSES.has(ev.status)
          ? (ev.status as AiInterviewEvidenceReadStatus)
          : "none";
      const parsed =
        status === "done" && ev?.evidence != null
          ? aiInterviewEvidenceSchema.safeParse(ev.evidence)
          : null;
      if (parsed?.success) {
        const e = parsed.data;
        const cov = new Map<string, { covered: number; partial: number; notCovered: number }>();
        const quotes: AssessmentAiEvidence["quotes"] = [];
        for (const q of e.questions) {
          for (const rb of q.rubric) {
            const c = cov.get(rb.rubricKey) ?? { covered: 0, partial: 0, notCovered: 0 };
            if (rb.coverage === "covered") c.covered += 1;
            else if (rb.coverage === "partial") c.partial += 1;
            else c.notCovered += 1;
            cov.set(rb.rubricKey, c);
            for (const quote of rb.quotes) {
              if (quotes.length < MAX_QUOTES_PER_ROUND) {
                quotes.push({
                  rubricKey: rb.rubricKey,
                  label: labelOf.get(rb.rubricKey) ?? rb.rubricKey,
                  quote,
                });
              }
            }
          }
        }
        const knockouts = e.knockouts.map((k) => ({
          question: k.question,
          status: k.status,
          quote: k.quote,
        }));
        if (quotes.length > 0 || knockouts.some((k) => k.quote)) quotesReturned = true;
        aiEvidence = {
          status,
          restricted: false,
          summary: e.summary || null,
          answeredCount: e.meta.answeredCount,
          questionCount: e.meta.questionCount,
          coverage: [...cov.entries()].map(([rubricKey, c]) => ({
            rubricKey,
            label: labelOf.get(rubricKey) ?? rubricKey,
            ...c,
          })),
          quotes,
          knockouts,
        };
      } else {
        aiEvidence = {
          status,
          restricted: false,
          summary: null,
          answeredCount: null,
          questionCount: null,
          coverage: [],
          quotes: [],
          knockouts: [],
        };
      }
    }

    return {
      interviewId: r.id,
      roundNumber: r.roundNumber,
      roundName: r.roundName,
      mode: r.mode as AssessmentRound["mode"],
      status: r.status as AssessmentRound["status"],
      scheduledStart: toIso(r.scheduledStart),
      completedAt: toIso(r.completedAt),
      scorecardTemplate: template,
      peerFeedbackVisible: peerVisible,
      feedback,
      rollup: {
        panelistCount: raw.length,
        submittedCount: peerVisible
          ? submittedCount
          : raw.filter((p) => p.feedbackState === "submitted").length,
        counts: peerVisible ? counts : null,
        positiveCount: peerVisible ? positiveCount : null,
        leadRecommendation: leadVisible ? lead.recommendation : null,
      },
      // Human ratings only, and never for a panellist: an average over a panel
      // that includes the viewer leaks the others' ratings.
      criterionAverages: full ? averageCriteria(criteria, raw) : [],
      outcome,
      aiEvidence,
      notetaker: notesAllowed.has(r.id)
        ? { hasTranscript: withTranscript.has(r.id), hasNotes: withNotes.has(r.id) }
        : null,
    };
  });

  const screening = full
    ? await buildScreening(db, tenantId, {
        requisitionId: app.requisitionId,
        jdVersionId: app.jdVersionId,
        knockoutPassed: app.knockoutPassed,
        knockoutFailures: app.knockoutFailures,
        knockoutEvaluatedAt: app.knockoutEvaluatedAt,
        parsedSkills: app.parsedSkills,
      })
    : null;

  const decisionReasons = canDecide
    ? await resolveTenantSelectionDecisionReasons(db, tenantId)
    : [];

  return {
    candidateId: app.candidateId,
    quotesReturned,
    output: {
      application: {
        applicationId: app.applicationId,
        candidateId: app.candidateId,
        requisitionId: app.requisitionId,
        candidateName: app.candidateName ?? null,
        positionTitle: app.positionTitle ?? null,
        currentStage: app.currentStage,
      },
      viewer: { mode: full ? "full" : "panellist", canDecide },
      rounds: outRounds,
      overall: {
        roundCount: outRounds.length,
        completedRoundCount: outRounds.filter((r) => r.status === "completed").length,
        submittedScorecards: overallSubmitted,
        positiveScorecards: overallCounts.strong_yes + overallCounts.yes,
        counts: overallCounts,
      },
      screening,
      decisionReasons,
    },
  };
}

/**
 * Screening snapshot — READ ONLY over what screening already stored: the
 * knockout verdict on the application, and the required JD skills against the
 * parsed résumé (the same deterministic overlap the panel brief shows).
 * Degrades to null when there is nothing to show.
 */
async function buildScreening(
  db: TenantBoundDb,
  tenantId: string,
  a: {
    requisitionId: string;
    jdVersionId: string;
    knockoutPassed: boolean | null;
    knockoutFailures: unknown;
    knockoutEvaluatedAt: Date | string | null;
    parsedSkills: unknown;
  },
): Promise<AssessmentScreening | null> {
  const [[configured], required] = await Promise.all([
    db
      .select({ n: dsql<number>`count(*)::int` })
      .from(requisitionKnockouts)
      .where(
        and(
          eq(requisitionKnockouts.tenantId, tenantId),
          eq(requisitionKnockouts.requisitionId, a.requisitionId),
        ),
      ),
    db
      .select({ skillName: jdSkills.skillName, weight: jdSkills.weight })
      .from(jdSkills)
      .where(and(eq(jdSkills.jdVersionId, a.jdVersionId), eq(jdSkills.isRequired, true))),
  ]);
  const configuredCount = configured?.n ?? 0;

  const failures: AssessmentScreening["knockout"]["failures"] = [];
  if (Array.isArray(a.knockoutFailures)) {
    for (const f of a.knockoutFailures as unknown[]) {
      if (!f || typeof f !== "object") continue;
      const o = f as { question_text?: unknown; result?: unknown };
      failures.push({
        question: typeof o.question_text === "string" ? o.question_text : "Knockout requirement",
        result: o.result === false ? "failed" : "unverified",
      });
    }
  }
  const status: AssessmentScreening["knockout"]["status"] =
    a.knockoutPassed === true
      ? "passed"
      : a.knockoutPassed === false
        ? "failed"
        : a.knockoutEvaluatedAt
          ? "unverified"
          : "not_evaluated";

  let mustHaves: AssessmentScreening["mustHaves"] = null;
  if (required.length > 0) {
    const match = computeSkillsMatch(
      parsedSkillNames(a.parsedSkills),
      required.map((s) => ({ skillName: s.skillName, weight: Number(s.weight), isRequired: true })),
    );
    mustHaves = {
      matched: match.items.filter((i) => i.matched).map((i) => i.skill),
      missing: match.items.filter((i) => !i.matched).map((i) => i.skill),
    };
  }

  if (status === "not_evaluated" && configuredCount === 0 && mustHaves === null) return null;
  return {
    knockout: { status, evaluatedAt: toIso(a.knockoutEvaluatedAt), configuredCount, failures },
    mustHaves,
  };
}
