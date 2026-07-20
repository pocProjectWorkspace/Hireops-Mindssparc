/**
 * Phase 2 tRPC router — six procedures spanning the apply flow end-to-end
 * to validate the patterns API-01 establishes:
 *
 *   submitApplication       (public,    mutation, audited)
 *   getCandidateById        (protected, query,    audited)
 *   listCandidates          (protected, query)
 *   getRequisitionById      (protected, query)
 *   listRequisitions        (protected, query)
 *   listApplications        (protected, query)
 *
 * Audit-on-opt-in policy: state changes + PII access opt in via
 * `withAudit`. Routine reads do not — DB-AUDIT trigger already captures
 * row changes; api_audit_logs records intent that drove those changes.
 *
 * Public procedures (only submitApplication today) reach the DB via
 * ctx.sql (service-role pool) with explicit tenant_id on every write.
 * Protected procedures inherit a per-call withTenantContext tx via the
 * tRPC middleware in trpc-core.ts.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql as dsql,
  type SQL,
} from "drizzle-orm";
import {
  db as poolDb,
  tenants,
  persons,
  candidates,
  candidateDedupAttempts,
  applications,
  applicationStateTransitions,
  requisitions,
  requisitionKnockouts,
  requisitionStateTransitions,
  positions,
  businessUnits,
  jdVersions,
  jdSkills,
  approvalChains,
  approvalMatrices,
  partnerAssignments,
  candidateOwnershipClaims,
  tenantUserMemberships,
  users,
  offers,
  interviewPlans,
  interviews,
  interviewPanelists,
  interviewFeedback,
  interviewPrep,
  workdaySyncOutbox,
  notificationOutbox,
  aiScoreOutbox,
  automationAgents,
  agentTriggers,
  agentActions,
  agentApprovalRules,
  agentApprovalRequests,
  agentRuns,
  agentRunActions,
  agentRunOutbox,
  auditLogs,
  onboardingCases,
  onboardingTasks,
  onboardingDocuments,
  offboardingCases,
  offboardingTasks,
  assetReturns,
  exitInterviews,
  finalSettlements,
  documentTypes,
  marketBenchmarks,
  tenantApplicationSources,
  requisitionFeasibility,
  hrRoundAssessments,
  compRecommendations,
  reqRevisionSuggestions,
  applicationDocuments,
  hrCaseNotes,
  hrPolicyDocuments,
  approvalRequests,
  approvalDecisions,
  recordPiiAccess,
  applicationStageEnum,
  missingInfoRequests,
  recruiterBrief,
  type ApplicationStage,
  type TenantBoundDb,
} from "@hireops/db";
import { evaluateKnockouts, type KnockoutInput } from "@hireops/ai-scoring";
import { SLA_THRESHOLDS_HOURS } from "../lib/sla-thresholds";
import { computeGovernanceRiskFlags, computeExecutiveAudit } from "../lib/governance";
import {
  submitApplicationInputSchema,
  submitApplicationOutputSchema,
  resolvePublicRequisitionInputSchema,
  resolvePublicRequisitionOutputSchema,
  getCandidateByIdInputSchema,
  getCandidateByIdOutputSchema,
  listCandidatesInputSchema,
  listCandidatesOutputSchema,
  listCandidatesByRequisitionInputSchema,
  listCandidatesByRequisitionOutputSchema,
  listShortlistInputSchema,
  listShortlistOutputSchema,
  getRequisitionByIdInputSchema,
  getRequisitionByIdOutputSchema,
  listRequisitionsInputSchema,
  listRequisitionsOutputSchema,
  listRequisitionSummariesInputSchema,
  listRequisitionSummariesOutputSchema,
  listRequisitionApprovalsInputSchema,
  listRequisitionApprovalsOutputSchema,
  createRequisitionDraftInputSchema,
  createRequisitionDraftOutputSchema,
  generateJdDraftInputSchema,
  generateJdDraftOutputSchema,
  updateRequisitionDraftInputSchema,
  updateRequisitionDraftOutputSchema,
  submitRequisitionForApprovalInputSchema,
  submitRequisitionForApprovalOutputSchema,
  getRequisitionDetailInputSchema,
  getRequisitionDetailOutputSchema,
  listRequisitionsForSkillWeightingInputSchema,
  listRequisitionsForSkillWeightingOutputSchema,
  decideRequisitionApprovalInputSchema,
  decideRequisitionApprovalOutputSchema,
  postRequisitionInputSchema,
  postRequisitionOutputSchema,
  jdSectionsSchema,
  type RequisitionKnockoutInput,
  listApplicationsInputSchema,
  listApplicationsOutputSchema,
  advanceApplicationInputSchema,
  advanceApplicationOutputSchema,
  rejectApplicationInputSchema,
  rejectApplicationOutputSchema,
  revertApplicationStageInputSchema,
  revertApplicationStageOutputSchema,
  draftOfferInputSchema,
  draftOfferOutputSchema,
  extendOfferInputSchema,
  extendOfferOutputSchema,
  cancelOfferInputSchema,
  cancelOfferOutputSchema,
  listOffersByApplicationInputSchema,
  listOffersByApplicationOutputSchema,
  listWorkdaySyncsInputSchema,
  listWorkdaySyncsOutputSchema,
  upsertInterviewPlanInputSchema,
  upsertInterviewPlanOutputSchema,
  getInterviewPlanInputSchema,
  getInterviewPlanOutputSchema,
  listInterviewsByApplicationInputSchema,
  listInterviewsByApplicationOutputSchema,
  scheduleInterviewInputSchema,
  scheduleInterviewOutputSchema,
  rescheduleInterviewInputSchema,
  rescheduleInterviewOutputSchema,
  cancelInterviewInputSchema,
  cancelInterviewOutputSchema,
  listUpcomingInterviewsInputSchema,
  listUpcomingInterviewsOutputSchema,
  type InterviewRow,
  listMyPanelInterviewsInputSchema,
  listMyPanelInterviewsOutputSchema,
  getPanelInterviewBriefInputSchema,
  getPanelInterviewBriefOutputSchema,
  saveInterviewFeedbackInputSchema,
  saveInterviewFeedbackOutputSchema,
  scorecardCriteriaFor,
  type FeedbackState,
  type GetPanelInterviewBriefOutput,
  type SaveInterviewFeedbackOutput,
  type PriorRoundFeedback,
  getPanelDashboardOutputSchema,
  type GetPanelDashboardOutput,
  type PanelPendingFeedbackItem,
  type PanelSubmittedFeedbackItem,
  summarizeMyFeedbackNotesInputSchema,
  summarizeMyFeedbackNotesOutputSchema,
  feedbackSummarySchema,
  type FeedbackSummary,
  type SummarizeMyFeedbackNotesOutput,
  // PANEL-02 — panel brief skills match + real-AI interview prep.
  computeSkillsMatch,
  getInterviewPrepInputSchema,
  getInterviewPrepOutputSchema,
  generateInterviewPrepInputSchema,
  generateInterviewPrepOutputSchema,
  interviewPrepAiSchema,
  type InterviewPrepAi,
  type InterviewPrepCard,
  completeInterviewInputSchema,
  completeInterviewOutputSchema,
  markInterviewNoShowInputSchema,
  markInterviewNoShowOutputSchema,
  advanceApplicationAfterInterviewInputSchema,
  advanceApplicationAfterInterviewOutputSchema,
  getInterviewDecisionSummaryInputSchema,
  getInterviewDecisionSummaryOutputSchema,
  reopenInterviewFeedbackInputSchema,
  reopenInterviewFeedbackOutputSchema,
  type GetInterviewDecisionSummaryOutput,
  type DecisionPanelist,
  type InterviewRecommendation,
  createFollowUpAgentInputSchema,
  createFollowUpAgentOutputSchema,
  updateFollowUpAgentInputSchema,
  updateFollowUpAgentOutputSchema,
  retireFollowUpAgentInputSchema,
  retireFollowUpAgentOutputSchema,
  toggleFollowUpAgentInputSchema,
  toggleFollowUpAgentOutputSchema,
  createSchedulingAgentInputSchema,
  createSchedulingAgentOutputSchema,
  updateSchedulingAgentInputSchema,
  updateSchedulingAgentOutputSchema,
  retireSchedulingAgentInputSchema,
  retireSchedulingAgentOutputSchema,
  toggleSchedulingAgentInputSchema,
  toggleSchedulingAgentOutputSchema,
  createCandidateQaAgentInputSchema,
  createCandidateQaAgentOutputSchema,
  updateCandidateQaAgentInputSchema,
  updateCandidateQaAgentOutputSchema,
  retireCandidateQaAgentInputSchema,
  retireCandidateQaAgentOutputSchema,
  toggleCandidateQaAgentInputSchema,
  toggleCandidateQaAgentOutputSchema,
  listAgentsInputSchema,
  listAgentsOutputSchema,
  getAgentDetailInputSchema,
  getAgentDetailOutputSchema,
  listAuditEventsInputSchema,
  listAuditEventsOutputSchema,
  // AD-03 admin-ops
  exportAuditEventsInputSchema,
  exportAuditEventsOutputSchema,
  listNotificationLogInputSchema,
  listNotificationLogOutputSchema,
  getSystemSetupInputSchema,
  getSystemSetupOutputSchema,
  updateSystemSetupInputSchema,
  updateSystemSetupOutputSchema,
  resolveSystemSetup,
  type SystemSetup,
  type NotificationStatus,
  getAiUsageSummaryInputSchema,
  getAiUsageSummaryOutputSchema,
  getTenantAiSettingsInputSchema,
  getTenantAiSettingsOutputSchema,
  updateTenantAiSettingsInputSchema,
  updateTenantAiSettingsOutputSchema,
  resolveAiSettings,
  getTenantBrandingInputSchema,
  getTenantBrandingOutputSchema,
  updateTenantBrandingInputSchema,
  updateTenantBrandingOutputSchema,
  resolveBrandingSettings,
  getBiasLexiconInputSchema,
  getBiasLexiconOutputSchema,
  updateTenantBiasLexiconInputSchema,
  updateTenantBiasLexiconOutputSchema,
  reviewJdWithAiInputSchema,
  reviewJdWithAiOutputSchema,
  resolveBiasLexicon,
  summarizeScan,
  scanBlocksSubmit,
  type BiasLexicon,
  type JdBiasScan,
  type RequisitionApprovalBiasFlag,
  getRecruitmentReportInputSchema,
  getRecruitmentReportOutputSchema,
  getHrMetricsOutputSchema,
  listJdLibraryInputSchema,
  listJdLibraryOutputSchema,
  getJdVersionHistoryInputSchema,
  getJdVersionHistoryOutputSchema,
  listPanelSetupRequisitionsInputSchema,
  listPanelSetupRequisitionsOutputSchema,
  getPanelSetupInputSchema,
  getPanelSetupOutputSchema,
  getRequisitionInsightsInputSchema,
  getRequisitionInsightsOutputSchema,
  type GetRequisitionInsightsOutput,
  approveApprovalInputSchema,
  approveApprovalOutputSchema,
  approveApprovalWithEditInputSchema,
  approveApprovalWithEditOutputSchema,
  rejectApprovalInputSchema,
  rejectApprovalOutputSchema,
  snoozeApprovalInputSchema,
  snoozeApprovalOutputSchema,
  listPendingApprovalsInputSchema,
  listPendingApprovalsOutputSchema,
  getApprovalRequestInputSchema,
  getApprovalRequestOutputSchema,
  listOnboardingCasesInputSchema,
  listOnboardingCasesOutputSchema,
  getOnboardingCaseDetailInputSchema,
  getOnboardingCaseDetailOutputSchema,
  updateOnboardingTaskStatusInputSchema,
  updateOnboardingTaskStatusOutputSchema,
  updateOnboardingCaseInputSchema,
  updateOnboardingCaseOutputSchema,
  createOnboardingCaseForApplicationInputSchema,
  createOnboardingCaseForApplicationOutputSchema,
  initiateOffboardingInputSchema,
  initiateOffboardingOutputSchema,
  updateOffboardingTaskStatusInputSchema,
  updateOffboardingTaskStatusOutputSchema,
  advanceOffboardingCaseInputSchema,
  advanceOffboardingCaseOutputSchema,
  recordAssetReturnInputSchema,
  updateAssetReturnInputSchema,
  assetReturnMutationOutputSchema,
  recordExitInterviewInputSchema,
  recordExitInterviewOutputSchema,
  updateFinalSettlementInputSchema,
  updateFinalSettlementOutputSchema,
  getOffboardingCaseDetailInputSchema,
  getOffboardingCaseDetailOutputSchema,
  listOffboardingCasesInputSchema,
  listOffboardingCasesOutputSchema,
  listHiredCandidatesInputSchema,
  listHiredCandidatesOutputSchema,
  attachOnboardingDocumentInputSchema,
  attachOnboardingDocumentOutputSchema,
  verifyOnboardingDocumentInputSchema,
  verifyOnboardingDocumentOutputSchema,
  rejectOnboardingDocumentInputSchema,
  rejectOnboardingDocumentOutputSchema,
  listTenantMembershipsInputSchema,
  listTenantMembershipsOutputSchema,
  getScoringWeightsInputSchema,
  getScoringWeightsOutputSchema,
  updateScoringWeightsInputSchema,
  updateScoringWeightsOutputSchema,
  resolveScoringWeights,
  getScreeningPrivacyInputSchema,
  getScreeningPrivacyOutputSchema,
  updateScreeningPrivacyInputSchema,
  updateScreeningPrivacyOutputSchema,
  resolveScreeningPrivacy,
  getFeedbackSharingInputSchema,
  getFeedbackSharingOutputSchema,
  updateFeedbackSharingInputSchema,
  updateFeedbackSharingOutputSchema,
  resolveFeedbackSharing,
  resolveCandidateMasking,
  candidateMaskLabel,
  getGovernanceRiskFlagsOutputSchema,
  getExecutiveAuditOutputSchema,
  type ScreeningPrivacy,
  type GetExecutiveAuditOutput,
  type GetGovernanceRiskFlagsOutput,
  listTenantUsersAdminInputSchema,
  listTenantUsersAdminOutputSchema,
  inviteTenantUserInputSchema,
  inviteTenantUserOutputSchema,
  updateMembershipRolesInputSchema,
  updateMembershipRolesOutputSchema,
  setMembershipStatusInputSchema,
  setMembershipStatusOutputSchema,
  getDocumentRetentionInputSchema,
  getDocumentRetentionOutputSchema,
  INTERNAL_TENANT_ROLES,
  type ScoringWeights,
  type TenantUserAdminRow,
  type DocumentRetentionRow,
  partnerGetMeOutputSchema,
  partnerListAssignedRequisitionsInputSchema,
  partnerListAssignedRequisitionsOutputSchema,
  partnerListMySubmissionsInputSchema,
  partnerListMySubmissionsOutputSchema,
  partnerSubmitCandidateInputSchema,
  partnerSubmitCandidateOutputSchema,
  requestCandidateActivationInputSchema,
  requestCandidateActivationOutputSchema,
  completeCandidateActivationInputSchema,
  completeCandidateActivationOutputSchema,
  candidateGetMeOutputSchema,
  candidateListMyApplicationsOutputSchema,
  candidateListMyInterviewsOutputSchema,
  candidateConfirmInterviewInputSchema,
  candidateConfirmInterviewOutputSchema,
  candidateGetMyOfferOutputSchema,
  candidateAcceptOfferInputSchema,
  candidateAcceptOfferOutputSchema,
  candidateGetMyOnboardingOutputSchema,
  candidateGetProfileOutputSchema,
  candidateUpdateProfileInputSchema,
  candidateUpdateProfileOutputSchema,
  candidateListMyNotificationsOutputSchema,
  candidateMarkNotificationsReadInputSchema,
  candidateMarkNotificationsReadOutputSchema,
  type CandidateProfile,
  type CandidateNotificationRow,
  getMyDashboardOutputSchema,
  getHrHeadDashboardExtrasOutputSchema,
  partnerGetDashboardStatsOutputSchema,
  CANDIDATE_STAGE_STEPS,
  type DashboardKpi,
  type DashboardAction,
  type DashboardActivity,
  type GetMyDashboardOutput,
  type GetHrHeadDashboardExtrasOutput,
  type RequisitionApprovalPriority,
  type RequisitionApprovalOutcome,
  type RequisitionApprovalRow,
  type HrHeadKpi,
  type HrHeadApprovalItem,
  type PartnerStageCount,
  type CandidateApplicationRow,
  type CandidateInterviewRow,
  type PartnerAssignedRequisitionRow,
  type PartnerSubmissionRow,
  type PartnerSubmitCandidateOutput,
  type OnboardingCaseListRow,
  type OnboardingTaskRow,
  type OnboardingDocumentRow,
  type OnboardingCaseStatus,
  type OffboardingCaseListRow,
  type OffboardingTaskRow,
  type OffboardingCaseStatus,
  type OffboardingInitiationType,
  type OffboardingTaskType,
  type AssetReturnRow,
  type AssetReturnStatus,
  type ExitInterviewRow,
  type FinalSettlementRow,
  type FinalSettlementStatus,
  type TenantMembershipRow,
  type SubmitApplicationOutput,
  type GetCandidateByIdOutput,
  type AgentListRow,
  type AuditEventRow,
  type PendingApprovalItem,
  type GetApprovalRequestOutput,
  // T1.1 / G04 sourcing-channel registry
  listTenantSourcesInputSchema,
  listTenantSourcesOutputSchema,
  upsertTenantSourceInputSchema,
  upsertTenantSourceOutputSchema,
  setTenantSourceEnabledInputSchema,
  setTenantSourceEnabledOutputSchema,
  type TenantSourceRow,
  // HRHEAD-02 market intelligence + feasibility
  listMarketBenchmarksInputSchema,
  listMarketBenchmarksOutputSchema,
  upsertMarketBenchmarkInputSchema,
  upsertMarketBenchmarkOutputSchema,
  listRequisitionFeasibilityInputSchema,
  listRequisitionFeasibilityOutputSchema,
  getRequisitionFeasibilityInputSchema,
  getRequisitionFeasibilityOutputSchema,
  generateRequisitionFeasibilityInputSchema,
  generateRequisitionFeasibilityOutputSchema,
  feasibilityAssessmentSchema,
  type MarketBenchmarkRow,
  type FeasibilityCard,
  type FeasibilityAssessment,
  // HROPS-01 HR Ops cases workspace + HR round
  listHrCasesInputSchema,
  listHrCasesOutputSchema,
  getHrCaseDetailInputSchema,
  getHrCaseDetailOutputSchema,
  saveHrRoundAssessmentInputSchema,
  saveHrRoundAssessmentOutputSchema,
  listHrRoundsInputSchema,
  listHrRoundsOutputSchema,
  type HrCaseListRow,
  type HrRoundResult,
  type HrCaseStage,
  type HrRoundAssessment,
  type HrCaseFeedbackCard,
  type HrRoundRow,
  type ListHrCasesOutput,
  type GetHrCaseDetailOutput,
  type ListHrRoundsOutput,
  // HROPS-02 comp & offer desk + offer approval + HR analytics
  listCompDeskInputSchema,
  listCompDeskOutputSchema,
  getCompAnalysisInputSchema,
  getCompAnalysisOutputSchema,
  generateCompRationaleInputSchema,
  generateCompRationaleOutputSchema,
  compRationaleAiSchema,
  draftCompOfferInputSchema,
  draftCompOfferOutputSchema,
  requestOfferApprovalInputSchema,
  requestOfferApprovalOutputSchema,
  decideOfferApprovalInputSchema,
  decideOfferApprovalOutputSchema,
  listOfferApprovalsInputSchema,
  listOfferApprovalsOutputSchema,
  getHrAnalyticsOutputSchema,
  type CompVerdict,
  type CompDeskRow,
  type CompRationale,
  type CompRationaleAi,
  type OfferApprovalStatus,
  type BenefitKey,
  // HROPS-03 documents & verification, case audit, policies
  listApplicationDocumentCandidatesInputSchema,
  listApplicationDocumentCandidatesOutputSchema,
  listRequestableDocumentTypesOutputSchema,
  requestApplicationDocumentsInputSchema,
  requestApplicationDocumentsOutputSchema,
  verifyApplicationDocumentInputSchema,
  verifyApplicationDocumentOutputSchema,
  rejectApplicationDocumentInputSchema,
  rejectApplicationDocumentOutputSchema,
  candidateListMyApplicationDocumentsOutputSchema,
  candidateAttachApplicationDocumentInputSchema,
  candidateAttachApplicationDocumentOutputSchema,
  listCaseAuditCasesInputSchema,
  listCaseAuditCasesOutputSchema,
  getCaseAuditTimelineInputSchema,
  getCaseAuditTimelineOutputSchema,
  addCaseAuditNoteInputSchema,
  addCaseAuditNoteOutputSchema,
  listHrPoliciesOutputSchema,
  type ApplicationDocumentRow,
  type ApplicationDocumentCandidateRow,
  type ApplicationDocumentOverall,
  type CandidateApplicationDocumentGroup,
  type CandidateApplicationDocumentSlot,
  type CaseAuditEvent,
  // RO-01 requirement-owner: AI revision suggestions + dashboard/list/tracker
  getReqRevisionSuggestionsInputSchema,
  getReqRevisionSuggestionsOutputSchema,
  generateReqRevisionSuggestionsInputSchema,
  generateReqRevisionSuggestionsOutputSchema,
  reqRevisionAiSchema,
  listMyRequisitionsV2InputSchema,
  listMyRequisitionsV2OutputSchema,
  getRecruiterDashboardExtrasOutputSchema,
  type GetRecruiterDashboardExtrasOutput,
  getAdminDashboardExtrasOutputSchema,
  type GetAdminDashboardExtrasOutput,
  type RecruiterTask,
  type RecruiterFollowUp,
  type RecruiterInsight,
  type RecruiterFunnelStage,
  getRequirementOwnerDashboardOutputSchema,
  getApprovalTrackerOutputSchema,
  REQUISITION_APPROVAL_SLA_DAYS,
  type ReqRevisionAi,
  type ReqRevisionItem,
  type RequirementOwnerReqRow,
  type ReqHealthWire,
  type RoDashboardStat,
  type RoHealthRow,
  type RoApprovalSlaItem,
  type RoActionItem,
  type RoActionKind,
  type RoMarketInsight,
  type ApprovalTrackerHistoryRow,
  // RECR-03 recruiter: AI brief drawer + missing info tracker
  getRecruiterBriefInputSchema,
  getRecruiterBriefOutputSchema,
  generateRecruiterBriefInputSchema,
  generateRecruiterBriefOutputSchema,
  listMissingInfoInputSchema,
  listMissingInfoOutputSchema,
  requestMissingInfoInputSchema,
  requestMissingInfoOutputSchema,
  resolveMissingInfoInputSchema,
  resolveMissingInfoOutputSchema,
  strengthsRisksAiSchema,
  screenScriptAiSchema,
  availabilityDraftAiSchema,
  type GetRecruiterBriefOutput,
  type GenerateRecruiterBriefOutput,
  type ListMissingInfoOutput,
  type MissingInfoRow,
  type MissingInfoStatus,
  type RecruiterBriefKind,
  type RecruiterBriefCard,
  type RecruiterBriefContent,
  type RecruiterBriefGap,
  type StrengthsRisksAi,
  type ScreenScriptAi,
  type AvailabilityDraftAi,
} from "@hireops/api-types";
import { createClient } from "@supabase/supabase-js";
import {
  parseResume,
  getAIClient,
  resolveTenantAiSettingsDb,
  resolveTenantBiasLexiconDb,
  resolveTenantScoringWeightsDb,
  resolveTenantScreeningPrivacyDb,
  resolveTenantFeedbackSharingDb,
} from "@hireops/ai-client";
import {
  buildJdGenerationPrompt,
  jdGenerationResponseJsonSchema,
  jdGenerationResponseSchema,
  composeJdText,
  JD_GENERATION_PROMPT_VERSION,
  JD_GENERATION_SCHEMA_NAME,
  JD_GENERATION_FEATURE,
  type JdGenerationResponse,
} from "../lib/jd-generation";
import {
  buildJdBiasReviewPrompt,
  jdBiasReviewResponseJsonSchema,
  jdBiasReviewResponseSchema,
  JD_BIAS_REVIEW_SCHEMA_NAME,
  JD_BIAS_REVIEW_FEATURE,
  type JdBiasReviewResponse,
} from "../lib/jd-bias-review";
import {
  buildRequisitionFeasibilityPrompt,
  feasibilityAssessmentJsonSchema,
  matchBenchmarkTitle,
  REQ_FEASIBILITY_PROMPT_VERSION,
  REQ_FEASIBILITY_SCHEMA_NAME,
  REQ_FEASIBILITY_FEATURE,
} from "../lib/req-feasibility";
import {
  evaluateComp,
  canEvaluateComp,
  bandMidpointPaise,
  type CompRuleResult,
} from "../lib/comp-rules";
import {
  buildCompRationalePrompt,
  compRationaleJsonSchema,
  COMP_RATIONALE_PROMPT_VERSION,
  COMP_RATIONALE_SCHEMA_NAME,
  COMP_RATIONALE_FEATURE,
} from "../lib/comp-recommendation";
import {
  buildFeedbackSummaryPrompt,
  feedbackSummaryJsonSchema,
  FEEDBACK_SUMMARY_SCHEMA_NAME,
  FEEDBACK_SUMMARY_FEATURE,
} from "../lib/feedback-summary";
import {
  buildInterviewPrepPrompt,
  interviewPrepAiJsonSchema,
  INTERVIEW_PREP_PROMPT_VERSION,
  INTERVIEW_PREP_SCHEMA_NAME,
  INTERVIEW_PREP_FEATURE,
} from "../lib/interview-prep";
import {
  buildReqRevisionPrompt,
  reqRevisionJsonSchema,
  REQ_REVISION_PROMPT_VERSION,
  REQ_REVISION_SCHEMA_NAME,
  REQ_REVISION_FEATURE,
} from "../lib/req-revision";
import {
  computeMissingInfo,
  blocksAdvanceLabelFor,
  fieldDef as missingInfoFieldDef,
  isMissingInfoFieldKey,
  type FieldPresence,
  type MissingInfoFieldKey,
} from "../lib/missing-info";
import {
  buildRecruiterBriefPrompt,
  recruiterBriefJsonSchema,
  RECRUITER_BRIEF_PROMPT_VERSION,
  RECRUITER_BRIEF_SCHEMA_NAME,
  RECRUITER_BRIEF_FEATURE,
  type RecruiterBriefSkillContext,
} from "../lib/recruiter-brief";
import {
  computeReqHealth,
  computeReqDifficulty,
  countNicheSkills,
  type ReqDifficulty,
} from "../lib/req-health";
import { displayForCandidateNotification } from "../lib/candidate-notifications";
import {
  computeRecruiterUrgency,
  computeMustHavePct,
  computeRiskFlags,
  matchTier,
  type UrgencySlaState,
  type MatchTier,
} from "../lib/recruiter-urgency";
import { enqueueNotification, signLink, hashToken, verifyLink } from "@hireops/notifications";
import { assertRuleAttachable, IncompatibleApprovalRuleError } from "@hireops/agent-actions";
import {
  router,
  publicProcedure,
  protectedProcedure,
  partnerProcedure,
  candidateProcedure,
  type HonoTRPCContext,
} from "./trpc-core";
import { withAudit } from "./with-audit";
import {
  createOnboardingCaseForApplication as createOnboardingCase,
  ensureDocumentCollectionTasks,
  enqueueDayZeroWorkdayHire,
  resolveGeographyCode,
} from "../lib/onboarding-case";
import {
  createOffboardingCase,
  enqueueTerminateWorkday,
  NotHiredError,
  ActiveCaseExistsError,
} from "../lib/offboarding-case";
import { getStorageClient } from "../lib/storage";
import { attachDocumentToCase, matchDocumentCollectionTask } from "../lib/onboarding-document";
import { attachApplicationDocumentBlob } from "../lib/application-document";
import { acceptOfferAtomically, runOfferAcceptSideEffects } from "../lib/offer-accept";

/**
 * Lowercase, drop +suffix in the local part. Gmail dot-stripping is
 * deferred — see persons.emailNormalised comment in @hireops/db.
 */
function normaliseEmail(email: string): string {
  const lowered = email.toLowerCase();
  const atIndex = lowered.indexOf("@");
  if (atIndex < 0) return lowered;
  const local = lowered.slice(0, atIndex);
  const domain = lowered.slice(atIndex + 1);
  const plusIndex = local.indexOf("+");
  const trimmedLocal = plusIndex < 0 ? local : local.slice(0, plusIndex);
  return `${trimmedLocal}@${domain}`;
}

/**
 * Create (or resolve, if it already exists) a Supabase auth user via the
 * service-role admin API, email pre-confirmed. Mirrors the seed scripts'
 * createUser → "already registered" → listUsers fallback. Used by
 * completeCandidateActivation to mint the candidate's login identity.
 *
 * Returns the auth user id. `alreadyExisted` is true when we reused an
 * existing auth.users row (e.g. a re-run, or an email that already had an
 * auth identity) — the caller flags/logs it.
 */
/**
 * Generate a strong one-time password for an invited user (CONF-03). No email
 * is sent this ticket — the admin reads this once off the screen and hands it
 * over out-of-band. Mixed case + digits + a symbol so it satisfies any
 * reasonable password policy; base64url of 18 random bytes gives ~144 bits.
 */
function generateTempPassword(): string {
  const core = randomBytes(18).toString("base64url");
  return `Hq7!${core}`;
}

async function createOrResolveAuthUser(
  email: string,
  password: string,
): Promise<{ userId: string; alreadyExisted: boolean }> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "auth admin not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)",
    });
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.data?.user?.id) {
    return { userId: created.data.user.id, alreadyExisted: false };
  }
  // "already registered" → look it up (dev volumes stay under one page).
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list.data?.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
  if (existing) {
    // The candidate is setting a password on an email that already has an auth
    // identity — set it so the credential they just chose works.
    await admin.auth.admin.updateUserById(existing.id, { password });
    return { userId: existing.id, alreadyExisted: true };
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: `failed to create or resolve auth user: ${created.error?.message ?? "unknown"}`,
  });
}

function normalisePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

/**
 * protectedProcedure guarantees ctx.db is set, but the HonoTRPCContext
 * type declares it as `TenantBoundDb | undefined`. requireDb narrows
 * without an ! assertion (which the lint forbids); the throw is
 * defensive and should never fire in practice.
 */
function requireDb(ctx: HonoTRPCContext) {
  if (!ctx.db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "protected procedure invoked without tenant-bound db",
    });
  }
  return ctx.db;
}

// ─────────── CAND-02 — candidate self-service profile read ───────────

interface CandidateProfileSqlRow {
  full_name: string | null;
  email_primary: string | null;
  phone_primary: string | null;
  location_city: string | null;
  location_country: string | null;
  experience_summary: string | null;
  education_summary: string | null;
  skills: unknown;
  notice_period_days: string | null;
  expected_salary_inr_paise: string | number | null;
}

/**
 * The candidate's own editable profile, read from the CANONICAL sources the
 * profile page edits (persons contact/location, candidates summaries +
 * parsed_skills.skills/notice_period_days, and the most-recent application's
 * captured salary expectation). Person-scoped by the caller. Nothing internal
 * (no AI score / scorecard) is selected. Shared by candidateGetProfile and the
 * echo on candidateUpdateProfile so both see identical shape.
 */
async function readCandidateProfile(
  db: ReturnType<typeof requireDb>,
  tenantId: string,
  personId: string,
): Promise<CandidateProfile> {
  const result = await db.execute(dsql`
    SELECT
      p.full_name,
      p.email_primary,
      p.phone_primary,
      p.location_city,
      p.location_country,
      c.experience_summary,
      c.education_summary,
      c.parsed_skills->'skills' AS skills,
      c.parsed_skills->>'notice_period_days' AS notice_period_days,
      (
        SELECT a.expected_salary_inr_paise
        FROM public.applications a
        WHERE a.tenant_id = c.tenant_id
          AND a.candidate_id = c.id
          AND a.expected_salary_inr_paise IS NOT NULL
        ORDER BY a.created_at DESC
        LIMIT 1
      ) AS expected_salary_inr_paise
    FROM public.persons p
    LEFT JOIN public.candidates c
      ON c.person_id = p.id AND c.tenant_id = p.tenant_id
    WHERE p.tenant_id = ${tenantId}
      AND p.id = ${personId}
    LIMIT 1
  `);
  const rows =
    (result as unknown as { rows?: CandidateProfileSqlRow[] }).rows ??
    (result as unknown as CandidateProfileSqlRow[]);
  const row = rows[0];

  const rawSkills = row?.skills;
  const skills = Array.isArray(rawSkills)
    ? rawSkills.filter((s): s is string => typeof s === "string")
    : [];
  const noticeRaw = row?.notice_period_days;
  const notice = noticeRaw != null && noticeRaw !== "" ? Number(noticeRaw) : null;
  const salaryRaw = row?.expected_salary_inr_paise;
  const salary = salaryRaw != null ? Number(salaryRaw) : null;

  return {
    fullName: row?.full_name ?? null,
    email: row?.email_primary ?? null,
    phone: row?.phone_primary ?? null,
    locationCity: row?.location_city ?? null,
    locationCountry: row?.location_country ?? null,
    experienceSummary: row?.experience_summary ?? null,
    educationSummary: row?.education_summary ?? null,
    skills,
    noticePeriodDays: notice != null && Number.isFinite(notice) ? notice : null,
    expectedSalaryInrPaise: salary != null && Number.isFinite(salary) ? salary : null,
  };
}

// REQ-01 (Wave A) role gates. admin is the super-role everywhere in this
// codebase (mirrors RECRUITER_RESOLVE_ROLES / HR_TEAM_RESOLVE_ROLES below).
// The requisition list is the requirement-owner surface (hiring_manager)
// shared with recruiters; the requisition-approval queue is the HR-head
// surface. RLS still scopes rows to the tenant regardless — these gates
// are the persona-visibility layer on top.
// REQ-03 added hr_head: the HR head reviews the full requisition (summary,
// JD, skills) on the shared /requisitions/[id] detail view to make an approval
// decision, so they need the read. RLS still scopes rows to the tenant.
const REQUISITION_READ_ROLES = new Set(["admin", "hiring_manager", "recruiter", "hr_head"]);
const REQUISITION_APPROVAL_READ_ROLES = new Set(["admin", "hr_head"]);
// METRICS-01 — the HR analytics surface (/metrics, getHrMetrics) is an
// HR-leadership view: hr_head (the people-metrics owner) + admin. recruiter /
// hiring_manager / panel_member get FORBIDDEN. RLS still scopes every read.
const HR_METRICS_READ_ROLES = new Set(["admin", "hr_head"]);
// HRHEAD-03 — the Governance + Executive Audit surfaces (policy blocks, risk
// flags, compliance score). hr_head (the governance owner) + admin. The
// "changes require admin approval" copy on the settings blocks is COPY ONLY
// for the POC — hr_head edits take effect immediately (flagged in the UI).
const GOVERNANCE_READ_ROLES = new Set(["admin", "hr_head"]);
// REQ-03 decision mutation. hr_head (the approver) + admin. recruiter /
// hiring_manager get FORBIDDEN.
const REQUISITION_APPROVAL_DECIDE_ROLES = new Set(["admin", "hr_head"]);
// REQ-03 posting mutation. The recruiter/hiring-manager side takes an approved
// req live. recruiter is included here (unlike the creation gate) because
// posting is a recruiter action.
const REQUISITION_POST_ROLES = new Set(["admin", "hiring_manager", "recruiter"]);
// REQ-02 creation mutations. hiring_manager (the requirement owner) + admin.
// NOT recruiter: recruiters request reqs via a different flow later (Wave A
// note in the ticket); a recruiter hitting a mutation gets FORBIDDEN. RLS
// still scopes rows to the tenant on top of this persona gate.
const REQUISITION_WRITE_ROLES = new Set(["admin", "hiring_manager"]);

// RO-03 — the hiring-manager persona surfaces (/jd-library, /panel-setup,
// /insights). hiring_manager (the requirement owner) + admin (super-role).
// recruiter / hr_head / panel_member get FORBIDDEN. Every read is additionally
// scoped to the caller's OWN requisitions (hiring_manager_id = the caller's
// membership); admin, the super-role, sees every requisition in the tenant.
// RLS still scopes every row to the tenant on top.
const HM_INSIGHTS_ROLES = new Set(["admin", "hiring_manager"]);

// INT-02 interview scheduling. Plan editing + scheduling is the
// recruiter/hiring-manager surface (admin super-role always). Plan READ
// piggybacks on REQUISITION_READ_ROLES (the plan lives on the req detail
// view, which hr_head also reads). A partner/candidate-less identity is
// FORBIDDEN. RLS still scopes rows to the tenant on top of these gates.
const INTERVIEW_MANAGE_ROLES = new Set(["admin", "hiring_manager", "recruiter"]);

// RECR-01 recruiter dashboard extras. The elevated recruiter landing read
// (funnel, tasks, follow-ups, insights) is the recruiter's; admin is the
// super-role. RLS scopes rows to the tenant on top.
const RECRUITER_DASHBOARD_ROLES = new Set(["admin", "recruiter"]);

// INT-03 panel persona. The "my interviews" + brief + scorecard surface is the
// interviewer's. panel_member is the role; admin is the super-role. NOTE this
// is only the coarse persona gate — every panel procedure ADDITIONALLY enforces
// that the caller is a panelist ON that specific interview (a panel_member who
// is not on the interview gets FORBIDDEN), so the role set alone is not the
// authorisation boundary. RLS still scopes rows to the tenant on top.
const PANEL_SURFACE_ROLES = new Set(["admin", "panel_member"]);

// RECR-03 — the recruiter's own surfaces (AI brief drawer, Missing Info
// Tracker). recruiter (the persona) + admin (super-role). RLS still scopes
// every row to the tenant on top.
const RECRUITER_SURFACE_ROLES = new Set(["admin", "recruiter"]);

// CONF-01 per-tenant AI settings. Admin-only on both read and write —
// unlike the /admin/costs read (page-gated only), these procedures enforce
// the gate themselves because the write changes real AI call behaviour and
// the read exposes config an admin owns.
const AI_SETTINGS_ADMIN_ROLES = new Set(["admin"]);

// CONF-03 users & roles admin. Admin-only on every read and write — the
// listing exposes every member's email + roles + status, and the mutations
// change who can access the tenant. The service-role membership writes
// (tenant_user_memberships has no authenticated write policy) are authorised
// by this explicit gate + the ctx.tenantId predicate.
const USERS_ADMIN_ROLES = new Set(["admin"]);

// OFFBOARD-02 — departures are an HR operation. hr_ops + people_ops run them;
// admin is the super-role. recruiter / hiring_manager / panel get FORBIDDEN.
// Flagged: if the demo persona map later says a manager initiates a
// resignation, add hiring_manager here — the requirements (§8.1) frame
// initiation as HR/manager, but the CLEARANCE spine (settlement, access,
// HR-clearance) is unambiguously HR, so the whole surface is HR-gated for now.
// RLS still scopes rows to the tenant on top of this persona gate.
const OFFBOARD_MANAGE_ROLES = new Set(["admin", "hr_ops", "people_ops"]);

// RBAC-01 — onboarding is worked by the recruiter (day-0 handoff) and HR ops.
// Matches the /onboarding nav gate; RLS still scopes rows to the tenant.
const ONBOARDING_MANAGE_ROLES = new Set(["admin", "recruiter", "hr_ops", "people_ops"]);

// HRHEAD-02 — Market Intelligence + Feasibility (HR-head persona).
// Market benchmarks READ is a planning surface for anyone who owns or approves
// reqs: hr_head (the persona), admin (super-role), and hiring_manager (reads the
// benchmark when shaping a req). WRITE (upsert) is admin-only — the benchmarks
// are curated governance data an admin maintains. Feasibility generation +
// read is the HR-head decision surface (hr_head + admin); a real AI call is
// gated tighter than the benchmark read. RLS still scopes rows to the tenant.
const MARKET_INTEL_READ_ROLES = new Set(["admin", "hr_head", "hiring_manager"]);
const MARKET_BENCHMARK_ADMIN_ROLES = new Set(["admin"]);

// T1.1 / G04 — the sourcing-channel registry. Reads flow to the recruiter
// surfaces that render source labels (recruiter + admin); writes (declare /
// enable / label a channel) are admin-only config, like every other admin
// config surface.
const TENANT_SOURCE_READ_ROLES = new Set(["admin", "recruiter"]);
const TENANT_SOURCE_ADMIN_ROLES = new Set(["admin"]);

/** DB row → API row for the sourcing-channel registry. `config` is a jsonb
 * string→string bag; coerce defensively (an older row could be null). */
function tenantSourceRowToApi(row: typeof tenantApplicationSources.$inferSelect): TenantSourceRow {
  const rawConfig = (row.config ?? {}) as Record<string, unknown>;
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawConfig)) {
    if (typeof v === "string") config[k] = v;
  }
  return {
    id: row.id,
    sourceEnum: row.sourceEnum,
    label: row.label,
    enabled: row.enabled,
    ingestionMode: row.ingestionMode === "connector_pending" ? "connector_pending" : "manual",
    config,
    notes: row.notes ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
const FEASIBILITY_ROLES = new Set(["admin", "hr_head"]);

// HROPS-01 — the HR-Ops cases workspace + HR round is the post-technical-rounds
// offer-desk persona: hr_ops (the persona) + admin (super-role). recruiter /
// hiring_manager / hr_head / panel_member get FORBIDDEN. Same set gates the
// case list, case detail, the HR-round scheduler view, and the assessment save.
// RLS still scopes every row to the tenant on top of this persona gate.
const HR_OPS_CASE_ROLES = new Set(["admin", "hr_ops"]);

// HROPS-02 — Comp & offer desk + HR analytics. The desk + analytics are the
// hr_ops persona surface (the comp/offer operator); admin is the super-role.
// recruiter drafts offers elsewhere (triage drawer) but the dedicated comp desk
// is hr_ops. OUT-OF-BAND offer approval decisions route to hr_head (mirrors the
// requisition approval decider) — hr_ops REQUESTS approval + sees status only.
// RLS still scopes rows to the tenant on top of every gate.
const COMP_DESK_ROLES = new Set(["admin", "hr_ops"]);
const OFFER_APPROVAL_DECIDE_ROLES = new Set(["admin", "hr_head"]);
// HROPS-03 — Documents & verification, Case audit, Policies. The hr_ops
// persona owns pre-offer document verification, the per-case audit trail, and
// the policies library; admin is the super-role. recruiter / hiring_manager /
// hr_head / panel get FORBIDDEN on these surfaces (matches the AppShell nav
// gate). RLS still scopes every read/write to the tenant on top of this gate.
const HR_OPS_DOC_ROLES = new Set(["admin", "hr_ops"]);

// The application stages that make up the pre-offer / HR-ops window: a
// candidate deep enough in the pipeline to collect documents on, up to and
// including offer-accept. Shared by /hr-documents and /case-audit.
const HR_OPS_WINDOW_STAGES: ApplicationStage[] = [
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
];

// The set of internal roles an admin may assign (mirror of api-types'
// INTERNAL_TENANT_ROLES). A submitted role outside this set is rejected by the
// zod .input(); this Set is the server-side backstop + the self-demotion guard
// key ("admin").
const ASSIGNABLE_INTERNAL_ROLES = new Set<string>(INTERNAL_TENANT_ROLES);

// DASH-01 — the internal-persona gate on getMyDashboard. Any internal tenant
// role earns a landing dashboard (the payload is honestly empty for a role with
// nothing pending). A candidate/partner JWT carries no `tid` and is rejected
// UNAUTHORIZED by protectedProcedure before this gate runs — so the practical
// effect is "internal identities only". RLS still scopes every row to the tenant.
const DASHBOARD_PERSONA_ROLES = new Set<string>(INTERNAL_TENANT_ROLES);

/**
 * CONF-02 bias-gate helpers.
 *
 * `distinctBiasFlags` collapses a scan's raw matches (which can repeat a term)
 * into distinct {term, category, severity, suggestion} flags in first-seen
 * order — what the HR head and the block error need. `biasScanContext`
 * produces the fragment merged into an approval request's `context` jsonb at
 * submit time (empty when enforcement is `off` or there's nothing to record,
 * so clean submissions carry no bias noise). `readBiasFlagsFromContext` is the
 * inverse: it reads that fragment back for the queue.
 */
function distinctBiasFlags(scan: JdBiasScan): RequisitionApprovalBiasFlag[] {
  const seen = new Set<string>();
  const flags: RequisitionApprovalBiasFlag[] = [];
  for (const m of scan.matches) {
    const key = `${m.term.toLowerCase()}|${m.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push({
      term: m.term,
      category: m.category,
      severity: m.severity,
      suggestion: m.suggestion,
    });
  }
  return flags;
}

function biasScanContext(scan: JdBiasScan): Record<string, unknown> {
  if (scan.enforcement === "off" || scan.matches.length === 0) return {};
  return {
    bias_scan: {
      enforcement: scan.enforcement,
      blockingCount: scan.blockingCount,
      warningCount: scan.warningCount,
      flags: distinctBiasFlags(scan),
    },
  };
}

function readBiasFlagsFromContext(context: unknown): RequisitionApprovalBiasFlag[] {
  if (!context || typeof context !== "object") return [];
  const scan = (context as Record<string, unknown>)["bias_scan"];
  if (!scan || typeof scan !== "object") return [];
  const flags = (scan as Record<string, unknown>)["flags"];
  if (!Array.isArray(flags)) return [];
  const out: RequisitionApprovalBiasFlag[] = [];
  for (const f of flags) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    if (typeof r["term"] === "string" && typeof r["category"] === "string") {
      out.push({
        term: r["term"] as string,
        category: r["category"] as RequisitionApprovalBiasFlag["category"],
        severity:
          r["severity"] === "block" ? "block" : ("warn" as RequisitionApprovalBiasFlag["severity"]),
        suggestion: typeof r["suggestion"] === "string" ? (r["suggestion"] as string) : null,
      });
    }
  }
  return out;
}

/**
 * HRHEAD-01 — the shared age→priority derivation for requisition approvals.
 * FLAG: there is no stored priority on the approval; this is a pure heuristic
 * off request age so the HR head can triage the queue at a glance.
 *   age > 7d → high · age > 3d → medium · else → low.
 * Reused by both listRequisitionApprovals and getHrHeadDashboardExtras so the
 * two surfaces never disagree.
 */
function deriveApprovalPriority(ageDays: number): RequisitionApprovalPriority {
  if (ageDays > 7) return "high";
  if (ageDays > 3) return "medium";
  return "low";
}

/** HRHEAD-01 — normalise the raw approval_request status into the queue's
 *  filter/label vocabulary. send_back lands the request on `cancelled`
 *  (REQ-03), so the queue reads it as "sent back". */
function approvalOutcomeFromStatus(status: string): RequisitionApprovalOutcome {
  switch (status) {
    case "approved":
      return "approved";
    case "cancelled":
      return "sent_back";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    default:
      return "pending";
  }
}

/** HRHEAD-01 — a human comp band from a position's min/max/currency, or null
 *  when neither bound is set. "18000–24000 USD" / "120000– USD" style. */
function formatBudgetBand(
  min: string | null,
  max: string | null,
  currency: string | null,
): string | null {
  if (!min && !max) return null;
  // numeric(…) columns arrive as "6500000.00"; drop the trailing cents.
  const clean = (v: string | null) => (v ? v.replace(/\.0+$/, "") : "?");
  const cur = currency ? ` ${currency}` : "";
  return `${clean(min)}–${clean(max)}${cur}`;
}

/**
 * HRHEAD-01 — resolve display names for a set of membership ids via the
 * service-role connection (public.users is self-only under RLS, so an RLS-tx
 * join would return only the caller's own name). Explicit tenant predicate is
 * load-bearing — the same idiom listTenantMemberships / onboarding detail use.
 * Falls back display_name → email-local-part → null.
 */
async function resolveMembershipNames(
  ctx: HonoTRPCContext,
  tenantId: string,
  membershipIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(membershipIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return out;
  const rows = await ctx.sql<{ id: string; display_name: string | null; email: string | null }[]>`
    SELECT tum.id::text AS id, u.display_name AS display_name, au.email AS email
    FROM public.tenant_user_memberships tum
    JOIN auth.users au ON au.id = tum.user_id
    LEFT JOIN public.users u ON u.id = tum.user_id
    WHERE tum.tenant_id = ${tenantId} AND tum.id::text = ANY(${ids})
  `;
  for (const r of rows) {
    const name = r.display_name ?? (r.email ? (r.email.split("@")[0] ?? null) : null);
    out.set(r.id, name);
  }
  return out;
}

/**
 * Throws FORBIDDEN unless the caller holds any role in `allowed`. Same
 * explicit-set idiom the approval-resolution gates use — kept a tiny local
 * helper rather than a framework so each call site reads plainly.
 */
function requireAnyRole(ctx: HonoTRPCContext, allowed: Set<string>, message: string): void {
  if (!ctx.roles.some((r) => allowed.has(r))) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
}

// ─────────────── HRHEAD-02 feasibility / benchmark helpers ───────────────

/** paise (minor) → rupees (major). Benchmarks store minor; positions comp
 * band + the prompt speak major. */
function minorToMajor(minor: bigint): number {
  return Number(minor) / 100;
}

interface TenantBenchmark {
  id: string;
  roleTitle: string;
  medianSalaryMinor: bigint;
  currency: string;
  ttfDays: number;
  availability: "low" | "medium" | "high";
  competitorDemand: "low" | "medium" | "high";
  recommendedRounds: number;
  trendingSkills: string[];
  sourceNote: string;
  updatedAt: Date;
}

/** Map a market_benchmarks DB row → the wire shape (minor as int number). */
function benchmarkRowToApi(row: typeof marketBenchmarks.$inferSelect): MarketBenchmarkRow {
  return {
    id: row.id,
    roleTitle: row.roleTitle,
    medianSalaryMinor: Number(row.medianSalaryMinor),
    currency: row.currency,
    ttfDays: row.ttfDays,
    availability: row.availability as "low" | "medium" | "high",
    competitorDemand: row.competitorDemand as "low" | "medium" | "high",
    recommendedRounds: row.recommendedRounds,
    trendingSkills: normalizeTrendingSkills(row.trendingSkills),
    sourceNote: row.sourceNote,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeTrendingSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string").slice(0, 20);
}

async function loadTenantBenchmarks(
  db: TenantBoundDb,
  tenantId: string,
): Promise<TenantBenchmark[]> {
  const rows = await db
    .select()
    .from(marketBenchmarks)
    .where(eq(marketBenchmarks.tenantId, tenantId));
  return rows.map((r) => ({
    id: r.id,
    roleTitle: r.roleTitle,
    medianSalaryMinor: r.medianSalaryMinor,
    currency: r.currency,
    ttfDays: r.ttfDays,
    availability: r.availability as "low" | "medium" | "high",
    competitorDemand: r.competitorDemand as "low" | "medium" | "high",
    recommendedRounds: r.recommendedRounds,
    trendingSkills: normalizeTrendingSkills(r.trendingSkills),
    sourceNote: r.sourceNote,
    updatedAt: r.updatedAt,
  }));
}

interface ReqFeasibilityFacet {
  id: string;
  status: string;
  title: string;
  seniority: string | null;
  locationType: string;
  primaryLocation: string | null;
  compBandMin: string | null;
  compBandMax: string | null;
  compCurrency: string | null;
  jdVersionId: string;
}

async function loadReqFeasibilityFacet(
  db: TenantBoundDb,
  tenantId: string,
  requisitionId: string,
): Promise<ReqFeasibilityFacet | null> {
  const [row] = await db
    .select({
      id: requisitions.id,
      status: requisitions.status,
      jdVersionId: requisitions.jdVersionId,
      title: positions.title,
      seniority: positions.level,
      locationType: positions.locationType,
      primaryLocation: positions.primaryLocation,
      compBandMin: positions.compBandMin,
      compBandMax: positions.compBandMax,
      compCurrency: positions.compCurrency,
    })
    .from(requisitions)
    .innerJoin(
      positions,
      and(eq(requisitions.tenantId, positions.tenantId), eq(requisitions.positionId, positions.id)),
    )
    .where(and(eq(requisitions.tenantId, tenantId), eq(requisitions.id, requisitionId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    seniority: row.seniority ?? null,
    locationType: row.locationType,
    primaryLocation: row.primaryLocation ?? null,
    compBandMin: row.compBandMin ?? null,
    compBandMax: row.compBandMax ?? null,
    compCurrency: row.compCurrency ?? null,
    jdVersionId: row.jdVersionId,
  };
}

// ═══════════════════ RO-01 — requirement-owner data assembly ═══════════════════
//
// Shared loader for the requirement-owner dashboard, My Requisitions v2, and the
// Approval Tracker. Assembles one facet per requisition (JD completeness, skill
// aggregates, interview-plan presence, pipeline counts, and the latest approval
// state + decision), then the deterministic rule engine (lib/req-health.ts)
// derives health + difficulty. A handful of grouped queries + JS stitching keeps
// it to O(tables), not O(reqs). Curated benchmarks (loaded once) drive difficulty
// (budget-vs-median + niche skills) and the market-insights TTF reference.

const TERMINAL_APP_STAGES = new Set(["offer_declined", "withdrawn", "recruiter_rejected"]);
const INTERVIEW_APP_STAGES = new Set(["tech_interview", "hr_round"]);
const OFFER_APP_STAGES = new Set(["offer_drafted", "offer_accepted"]);

interface RoReqFacet {
  id: string;
  status: string;
  title: string | null;
  department: string | null;
  seniority: string | null;
  locationType: string;
  primaryLocation: string | null;
  compBandMin: string | null;
  compBandMax: string | null;
  compCurrency: string | null;
  openings: number;
  createdAt: Date;
  jdVersionId: string;
  jdHasText: boolean;
  jdHasSummary: boolean;
  jdSectionCount: number;
  skillCount: number;
  weightedSkillCount: number;
  mustHaveCount: number;
  skillNames: string[];
  /** RECR-01 — weighted skill chips for the recruiter card grid. */
  skills: { name: string; weight: number; required: boolean }[];
  interviewRounds: number;
  candidatesInFlight: number;
  interviewingCount: number;
  offerStageCount: number;
  approvalRequestId: string | null;
  approvalStatus: string | null;
  approvalRequestedAt: Date | null;
  approvalDecidedAt: Date | null;
  latestDecisionOutcome: string | null;
  latestDecisionReason: string | null;
  latestDecisionAt: Date | null;
  /** Days from first application to offer_accepted, for accepted apps only. */
  timeToHireDays: number[];
}

function countJdSections(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object") return 0;
  const sections = (metadata as Record<string, unknown>).sections;
  if (Array.isArray(sections)) return sections.filter(Boolean).length;
  if (sections && typeof sections === "object") {
    return Object.values(sections as Record<string, unknown>).filter(
      (v) => v != null && String(v).trim().length > 0,
    ).length;
  }
  return 0;
}

async function loadRequirementOwnerFacets(
  db: TenantBoundDb,
  tenantId: string,
  limit: number,
): Promise<RoReqFacet[]> {
  const reqRows = await db
    .select({
      id: requisitions.id,
      status: requisitions.status,
      openings: requisitions.numberOfOpenings,
      createdAt: requisitions.createdAt,
      jdVersionId: jdVersions.id,
      jdText: jdVersions.jdText,
      jdSummary: jdVersions.summary,
      jdMetadata: jdVersions.aiMetadata,
      title: positions.title,
      department: businessUnits.name,
      seniority: positions.level,
      locationType: positions.locationType,
      primaryLocation: positions.primaryLocation,
      compBandMin: positions.compBandMin,
      compBandMax: positions.compBandMax,
      compCurrency: positions.compCurrency,
    })
    .from(requisitions)
    .innerJoin(
      positions,
      and(eq(requisitions.tenantId, positions.tenantId), eq(requisitions.positionId, positions.id)),
    )
    .leftJoin(
      businessUnits,
      and(
        eq(positions.tenantId, businessUnits.tenantId),
        eq(positions.businessUnitId, businessUnits.id),
      ),
    )
    .innerJoin(
      jdVersions,
      and(
        eq(requisitions.tenantId, jdVersions.tenantId),
        eq(requisitions.jdVersionId, jdVersions.id),
      ),
    )
    .where(eq(requisitions.tenantId, tenantId))
    .orderBy(desc(requisitions.createdAt))
    .limit(limit);

  const facets: RoReqFacet[] = reqRows.map((r) => ({
    id: r.id,
    status: r.status,
    title: r.title ?? null,
    department: r.department ?? null,
    seniority: r.seniority ?? null,
    locationType: r.locationType,
    primaryLocation: r.primaryLocation ?? null,
    compBandMin: r.compBandMin ?? null,
    compBandMax: r.compBandMax ?? null,
    compCurrency: r.compCurrency ?? null,
    openings: r.openings,
    createdAt: r.createdAt,
    jdVersionId: r.jdVersionId,
    jdHasText: !!r.jdText && r.jdText.trim().length > 0,
    jdHasSummary: !!r.jdSummary && r.jdSummary.trim().length > 0,
    jdSectionCount: countJdSections(r.jdMetadata),
    skillCount: 0,
    weightedSkillCount: 0,
    mustHaveCount: 0,
    skillNames: [],
    skills: [],
    interviewRounds: 0,
    candidatesInFlight: 0,
    interviewingCount: 0,
    offerStageCount: 0,
    approvalRequestId: null,
    approvalStatus: null,
    approvalRequestedAt: null,
    approvalDecidedAt: null,
    latestDecisionOutcome: null,
    latestDecisionReason: null,
    latestDecisionAt: null,
    timeToHireDays: [],
  }));

  if (facets.length === 0) return facets;
  const byId = new Map(facets.map((f) => [f.id, f]));
  const byJd = new Map(facets.map((f) => [f.jdVersionId, f]));
  const reqIds = facets.map((f) => f.id);
  const jdIds = facets.map((f) => f.jdVersionId);

  // Skills aggregate (per jd version).
  const skillRows = await db
    .select({
      jdVersionId: jdSkills.jdVersionId,
      skillName: jdSkills.skillName,
      weight: jdSkills.weight,
      isRequired: jdSkills.isRequired,
    })
    .from(jdSkills)
    .where(and(eq(jdSkills.tenantId, tenantId), inArray(jdSkills.jdVersionId, jdIds)));
  for (const s of skillRows) {
    const f = byJd.get(s.jdVersionId);
    if (!f) continue;
    f.skillCount += 1;
    if (Number(s.weight) > 0) f.weightedSkillCount += 1;
    if (s.isRequired) f.mustHaveCount += 1;
    f.skillNames.push(s.skillName);
    f.skills.push({
      name: s.skillName,
      weight: Math.round(Number(s.weight) || 0),
      required: !!s.isRequired,
    });
  }

  // Interview-plan rounds (per requisition).
  const planRows = await db
    .select({ requisitionId: interviewPlans.requisitionId })
    .from(interviewPlans)
    .where(
      and(eq(interviewPlans.tenantId, tenantId), inArray(interviewPlans.requisitionId, reqIds)),
    );
  for (const p of planRows) {
    const f = byId.get(p.requisitionId);
    if (f) f.interviewRounds += 1;
  }

  // Pipeline (per requisition) + time-to-hire samples.
  const appRows = await db
    .select({
      requisitionId: applications.requisitionId,
      currentStage: applications.currentStage,
      createdAt: applications.createdAt,
      stageEnteredAt: applications.stageEnteredAt,
    })
    .from(applications)
    .where(and(eq(applications.tenantId, tenantId), inArray(applications.requisitionId, reqIds)));
  for (const a of appRows) {
    const f = byId.get(a.requisitionId);
    if (!f) continue;
    const stage = a.currentStage as string;
    if (!TERMINAL_APP_STAGES.has(stage)) f.candidatesInFlight += 1;
    if (INTERVIEW_APP_STAGES.has(stage)) f.interviewingCount += 1;
    if (OFFER_APP_STAGES.has(stage)) f.offerStageCount += 1;
    if (stage === "offer_accepted") {
      const days = (a.stageEnteredAt.getTime() - a.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      if (Number.isFinite(days) && days >= 0) f.timeToHireDays.push(days);
    }
  }

  // Latest approval request per requisition (subject_id).
  const apprRows = await db
    .select({
      id: approvalRequests.id,
      subjectId: approvalRequests.subjectId,
      status: approvalRequests.status,
      requestedAt: approvalRequests.requestedAt,
      decidedAt: approvalRequests.decidedAt,
      createdAt: approvalRequests.createdAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.subjectType, "requisition"),
        inArray(approvalRequests.subjectId, reqIds),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt));
  for (const ar of apprRows) {
    const f = byId.get(ar.subjectId);
    if (!f || f.approvalRequestId) continue; // first = latest (desc order)
    f.approvalRequestId = ar.id;
    f.approvalStatus = ar.status;
    f.approvalRequestedAt = ar.requestedAt;
    f.approvalDecidedAt = ar.decidedAt;
  }

  // Latest HR-head decision per requisition (across all its requests).
  const decRows = await db
    .select({
      subjectId: approvalRequests.subjectId,
      outcome: approvalDecisions.outcome,
      comment: approvalDecisions.comment,
      decidedAt: approvalDecisions.decidedAt,
    })
    .from(approvalDecisions)
    .innerJoin(
      approvalRequests,
      and(
        eq(approvalDecisions.tenantId, approvalRequests.tenantId),
        eq(approvalDecisions.requestId, approvalRequests.id),
      ),
    )
    .where(
      and(
        eq(approvalDecisions.tenantId, tenantId),
        eq(approvalRequests.subjectType, "requisition"),
        inArray(approvalRequests.subjectId, reqIds),
      ),
    )
    .orderBy(desc(approvalDecisions.decidedAt));
  for (const d of decRows) {
    const f = byId.get(d.subjectId);
    if (!f || f.latestDecisionOutcome) continue; // first = latest
    f.latestDecisionOutcome = d.outcome;
    f.latestDecisionReason = d.comment ?? null;
    f.latestDecisionAt = d.decidedAt;
  }

  return facets;
}

/** Budget midpoint in MAJOR rupees, or null when no band. */
function facetBudgetMidMajor(f: RoReqFacet): number | null {
  if (f.compBandMin == null || f.compBandMax == null) return null;
  const min = Number(f.compBandMin);
  const max = Number(f.compBandMax);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return (min + max) / 2;
}

function facetDifficulty(f: RoReqFacet, benchmark: TenantBenchmark | null): ReqDifficulty {
  const midMajor = facetBudgetMidMajor(f);
  const budgetVsBenchmarkPct =
    midMajor != null && benchmark
      ? Math.round((midMajor / minorToMajor(benchmark.medianSalaryMinor)) * 100)
      : null;
  return computeReqDifficulty({
    mustHaveCount: f.mustHaveCount,
    nicheSkillCount: countNicheSkills(f.skillNames, benchmark?.trendingSkills ?? []),
    budgetVsBenchmarkPct,
  });
}

function facetHealth(f: RoReqFacet): ReqHealthWire {
  const { score, components } = computeReqHealth({
    jd: { hasText: f.jdHasText, hasSummary: f.jdHasSummary, sectionCount: f.jdSectionCount },
    skills: {
      count: f.skillCount,
      weightedCount: f.weightedSkillCount,
      mustHaveCount: f.mustHaveCount,
    },
    interviewPlan: { configured: f.interviewRounds > 0, roundCount: f.interviewRounds },
    budget: { hasBand: f.compBandMin != null && f.compBandMax != null },
    // A never-submitted draft has no approval row; status still reflects lifecycle.
    approvalStatus: f.status,
    pipeline: { candidatesInFlight: f.candidatesInFlight },
  });
  return { score, components };
}

/** A rejected requisition = cancelled with a reject decision on record. */
function facetIsRejected(f: RoReqFacet): boolean {
  return f.status === "cancelled" && f.latestDecisionOutcome === "rejected";
}

function facetCanSubmit(f: RoReqFacet): boolean {
  return (
    f.status === "draft" &&
    f.jdHasText &&
    f.skillCount > 0 &&
    f.mustHaveCount > 0 &&
    f.compBandMin != null &&
    f.compBandMax != null
  );
}

function matchFacetBenchmark(f: RoReqFacet, benchmarks: TenantBenchmark[]): TenantBenchmark | null {
  if (!f.title) return null;
  const title = matchBenchmarkTitle(
    f.title,
    benchmarks.map((b) => b.roleTitle),
  );
  return title ? (benchmarks.find((b) => b.roleTitle === title) ?? null) : null;
}

/** Format a comp band as INR with Indian digit grouping (₹65,00,000 – ₹85,00,000)
 * when the currency is INR; otherwise fall back to the plain band. Values are
 * MAJOR rupees (same units the difficulty maths already assumes). */
function formatInrBand(
  min: string | null,
  max: string | null,
  currency: string | null,
): string | null {
  if (!min && !max) return null;
  if ((currency ?? "INR").toUpperCase() !== "INR") {
    return formatBudgetBand(min, max, currency);
  }
  const fmt = (v: string | null): string => {
    const n = v == null ? NaN : Number(v);
    if (!Number.isFinite(n)) return "?";
    return `₹${Math.round(n).toLocaleString("en-IN")}`;
  };
  return `${fmt(min)} – ${fmt(max)}`;
}

function facetToOwnerRow(f: RoReqFacet, benchmarks: TenantBenchmark[]): RequirementOwnerReqRow {
  const benchmark = matchFacetBenchmark(f, benchmarks);
  const skills = [...f.skills]
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, 4);
  return {
    id: f.id,
    title: f.title,
    department: f.department,
    status: f.status,
    health: facetHealth(f),
    difficulty: facetDifficulty(f, benchmark),
    budgetBand: formatBudgetBand(f.compBandMin, f.compBandMax, f.compCurrency),
    openings: f.openings,
    createdAt: f.createdAt.toISOString(),
    canSubmit: facetCanSubmit(f),
    skills,
    candidateCount: f.candidatesInFlight,
    interviewRounds: f.interviewRounds,
    salaryInr: formatInrBand(f.compBandMin, f.compBandMax, f.compCurrency),
  };
}

/** Deterministic action-required rules for a single requisition facet. */
function facetActions(f: RoReqFacet): RoActionItem[] {
  const out: RoActionItem[] = [];
  const href = `/requisitions/${f.id}`;
  const roleName = f.title ?? "Untitled requisition";
  const isTerminal = f.status === "filled" || f.status === "closed";
  const push = (
    kind: RoActionKind,
    title: string,
    detail: string,
    severity: RoActionItem["severity"],
    to = href,
  ) =>
    out.push({
      key: `${f.id}:${kind}`,
      kind,
      requisitionId: f.id,
      title,
      detail,
      href: to,
      severity,
    });

  // Rejected → surface the reason + revision path first.
  if (facetIsRejected(f)) {
    push(
      "rejected_with_reason",
      `${roleName} was rejected`,
      f.latestDecisionReason
        ? `HR head: "${f.latestDecisionReason}". Open to review AI revision suggestions.`
        : "Open to review AI revision suggestions and resubmit.",
      "urgent",
    );
    return out; // a rejected req's other gaps are moot until revised
  }

  // Stalled approval.
  if (f.status === "pending_approval" && f.approvalRequestedAt) {
    const hours = Math.floor((Date.now() - f.approvalRequestedAt.getTime()) / (1000 * 60 * 60));
    if (hours >= REQUISITION_APPROVAL_SLA_DAYS * 24) {
      push(
        "stalled_approval",
        `${roleName} approval is overdue`,
        `Pending ${Math.floor(hours / 24)}d — past the ${REQUISITION_APPROVAL_SLA_DAYS}-day SLA. Nudge the HR head.`,
        "urgent",
        "/approval-tracker",
      );
    }
    return out; // in-flight approval: don't nag about draft gaps
  }

  if (isTerminal) return out;

  // Draft-completeness gaps (only meaningful before submission).
  if (f.status === "draft") {
    if (!f.jdHasText)
      push(
        "jd_not_generated",
        `${roleName} has no job description`,
        "Generate the JD before submitting.",
        "attention",
      );
    if (f.compBandMin == null || f.compBandMax == null)
      push(
        "budget_missing",
        `${roleName} has no budget band`,
        "Set a comp band on the role.",
        "attention",
      );
    if (f.skillCount > 0 && f.weightedSkillCount < f.skillCount)
      push(
        "skills_not_weighted",
        `${roleName} skills aren't fully weighted`,
        "Weight every skill so screening ranks candidates correctly.",
        "info",
      );
    if (f.interviewRounds === 0)
      push(
        "panel_not_configured",
        `${roleName} has no interview plan`,
        "Configure the interview rounds and panel.",
        "info",
      );
    if (facetCanSubmit(f))
      push(
        "ready_to_submit",
        `${roleName} is ready to submit`,
        "The draft is complete — submit it for approval.",
        "info",
      );
  } else if (f.interviewRounds === 0) {
    // Live req without a panel is still worth flagging.
    push(
      "panel_not_configured",
      `${roleName} has no interview plan`,
      "Configure the interview rounds and panel.",
      "info",
    );
  }
  return out;
}

// Role gates for the requirement-owner surfaces.
const RO_DASHBOARD_ROLES = new Set(["admin", "hiring_manager"]);
const RO_REVISION_ROLES = new Set(["admin", "hiring_manager"]);

interface ReqRevisionMeta {
  hiringManagerId: string | null;
  isRejected: boolean;
  rejectionReason: string | null;
}

/**
 * Load the minimal metadata the revision-suggestions procedures need: the req's
 * owner (for the owner-or-admin gate), whether it is in a rejected state
 * (cancelled + a reject decision on record), and the HR-head rejection reason.
 */
async function loadReqRevisionMeta(
  db: TenantBoundDb,
  tenantId: string,
  requisitionId: string,
): Promise<ReqRevisionMeta | null> {
  const [req] = await db
    .select({ status: requisitions.status, hiringManagerId: requisitions.hiringManagerId })
    .from(requisitions)
    .where(and(eq(requisitions.tenantId, tenantId), eq(requisitions.id, requisitionId)))
    .limit(1);
  if (!req) return null;

  const [decision] = await db
    .select({ outcome: approvalDecisions.outcome, comment: approvalDecisions.comment })
    .from(approvalDecisions)
    .innerJoin(
      approvalRequests,
      and(
        eq(approvalDecisions.tenantId, approvalRequests.tenantId),
        eq(approvalDecisions.requestId, approvalRequests.id),
      ),
    )
    .where(
      and(
        eq(approvalDecisions.tenantId, tenantId),
        eq(approvalRequests.subjectType, "requisition"),
        eq(approvalRequests.subjectId, requisitionId),
        eq(approvalDecisions.outcome, "rejected"),
      ),
    )
    .orderBy(desc(approvalDecisions.decidedAt))
    .limit(1);

  const isRejected = req.status === "cancelled" && !!decision;
  return {
    hiringManagerId: req.hiringManagerId ?? null,
    isRejected,
    rejectionReason: decision?.comment ?? null,
  };
}

/** Owner-or-admin gate: admin passes; otherwise the caller's membership must be
 * the requisition's hiring manager. */
async function ensureReqOwnerOrAdmin(
  db: TenantBoundDb,
  ctx: HonoTRPCContext,
  hiringManagerId: string | null,
): Promise<void> {
  if (ctx.roles.includes("admin")) return;
  const membershipId = await resolveActorMembership(db, ctx);
  if (!membershipId || membershipId !== hiringManagerId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the requisition's owner or an admin can access its revision suggestions.",
    });
  }
}

/** Map a req_revision_suggestions DB row → the wire shape. */
function reqRevisionRowToApi(row: typeof reqRevisionSuggestions.$inferSelect) {
  const parsed = reqRevisionAiSchema.safeParse({ suggestions: row.suggestions });
  return {
    requisitionId: row.requisitionId,
    suggestions: parsed.success ? parsed.data.suggestions : [],
    rejectionReason: row.rejectionReason ?? null,
    model: row.model ?? null,
    promptVersion: row.promptVersion ?? null,
    generatedAt: row.createdAt.toISOString(),
  };
}

interface BuildCardInput {
  requisitionId: string;
  title: string;
  status: string;
  seniority: string | null;
  compBandMin: string | null;
  compBandMax: string | null;
  compCurrency: string | null;
  benchmarks: TenantBenchmark[];
  storedAssessment: unknown;
  model: string | null;
  promptVersion: string | null;
  generatedAt: string | null;
}

/** Assemble a FeasibilityCard: req + budget + matched benchmark context +
 * (safely-parsed) cached assessment. Pure over the loaded benchmark list. */
function buildFeasibilityCard(input: BuildCardInput): FeasibilityCard {
  const matchedTitle = matchBenchmarkTitle(
    input.title,
    input.benchmarks.map((b) => b.roleTitle),
  );
  const matched = matchedTitle
    ? (input.benchmarks.find((b) => b.roleTitle === matchedTitle) ?? null)
    : null;

  const parsed = input.storedAssessment
    ? feasibilityAssessmentSchema.safeParse(input.storedAssessment)
    : null;

  return {
    requisitionId: input.requisitionId,
    title: input.title,
    status: input.status,
    seniority: input.seniority,
    compBandMin: input.compBandMin,
    compBandMax: input.compBandMax,
    compCurrency: input.compCurrency,
    benchmark: {
      matchedRoleTitle: matched?.roleTitle ?? null,
      medianSalaryMinor: matched ? Number(matched.medianSalaryMinor) : null,
      currency: matched?.currency ?? null,
      ttfDays: matched?.ttfDays ?? null,
      availability: matched?.availability ?? null,
      competitorDemand: matched?.competitorDemand ?? null,
    },
    assessment: parsed && parsed.success ? parsed.data : null,
    model: input.model,
    promptVersion: input.promptVersion,
    generatedAt: input.generatedAt,
  };
}

function firstOrThrow<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `expected at least one row from ${label}`,
    });
  }
  return row;
}

function lastCursor<T extends { createdAt: Date }>(rows: T[]): string | null {
  const last = rows[rows.length - 1];
  return last ? last.createdAt.toISOString() : null;
}

/**
 * Composite keyset cursor for the audit list (ADMIN-02). Encodes the
 * (created_at, id) of the last row of a page so the next page walks
 * strictly past it under ORDER BY created_at DESC, id DESC. base64url so
 * the opaque token survives a query-string round-trip. decode tolerates a
 * malformed/absent token by returning null (paging restarts).
 */
function encodeAuditCursor(createdAt: Date | string, id: string): string {
  const iso = toIsoString(createdAt) ?? new Date(0).toISOString();
  return Buffer.from(`${iso}|${id}`, "utf8").toString("base64url");
}
function decodeAuditCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep === -1) return null;
    const iso = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Requisition statuses that an unauthenticated apply form may submit
 * against. Shared by `submitApplication` (rejects 400) and
 * `resolvePublicRequisition` (returns 404 — keeps slug existence
 * private from passers-by). Keep this single source of truth.
 */
const PUBLIC_APPLY_ACCEPTING_STATUSES = new Set<string>(["approved", "posted"]);

/**
 * Parser confidence (`parse_metadata.confidence_score`) below this
 * floor skips AI scoring at submit time — the LLM input would be too
 * unreliable to score against. Logged on the application as
 * `ai_score_explanation = { scored_by: 'skipped', reason:
 * 'parser_confidence_below_threshold', confidence: <value> }`. 0.5 is
 * the AI-03 v1 threshold; tunable here, not per-tenant.
 */
const PARSER_CONFIDENCE_SCORING_FLOOR = 0.5;

/**
 * Partner ownership-claim exclusivity window. 90 days per partner-msa's
 * `exclusivity_window_days` default for empanelled partners
 * (partner-data-model.md) and the wireflows' consent copy ("The 90-day
 * exclusivity window starts now"). Reading the real per-org window from
 * partner_msa is a commercials concern (out of PARTNER-02 scope) — the
 * Wave-1 empanelled default is the honest stand-in.
 */
const PARTNER_CLAIM_WINDOW_DAYS = 90;

/**
 * Decide the scoring fields an application row should carry at insert time,
 * shared by the public apply path (submitApplication) and the partner
 * submission path (partnerSubmitCandidate) so both get IDENTICAL downstream
 * treatment. Returns the synchronous ai_score_explanation for the skipped
 * cases (knockouts failed, parser confidence below floor) and whether an
 * ai_score_outbox row should be enqueued (only when eligible). Pure — no DB.
 */
function computeInitialScoringState(
  knockoutPassed: boolean | null,
  parserConfidence: number | null,
  evaluatedAt: Date,
): { initialAiScoreExplanation: Record<string, unknown> | null; outboxEligible: boolean } {
  if (knockoutPassed === false) {
    return {
      initialAiScoreExplanation: {
        scored_by: "skipped",
        reason: "knockouts_failed",
        skipped_at: evaluatedAt.toISOString(),
      },
      outboxEligible: false,
    };
  }
  if (parserConfidence !== null && parserConfidence < PARSER_CONFIDENCE_SCORING_FLOOR) {
    return {
      initialAiScoreExplanation: {
        scored_by: "skipped",
        reason: "parser_confidence_below_threshold",
        confidence: parserConfidence,
        skipped_at: evaluatedAt.toISOString(),
      },
      outboxEligible: false,
    };
  }
  return { initialAiScoreExplanation: null, outboxEligible: true };
}

/**
 * Materialise a partner-sourced candidate into the recruitment pipeline:
 * parse the CV, evaluate knockouts, upsert the candidate (one per person per
 * tenant), upsert the application for this req, and enqueue AI scoring when
 * eligible — the same downstream steps submitApplication runs, so a
 * partner-sourced candidate is indistinguishable from a direct applicant to
 * the recruiter (triage, scoring, knockouts all apply). Runs on the partner
 * procedure's tenant-bound tx (ctx.db) so it commits/rolls back atomically
 * with the ownership-claim decision the caller wraps around it.
 *
 * Attribution: application.source = 'partner_empanelled', plus the
 * source_partner_id / submitted_by_partner_user_id / partner_submission_metadata
 * columns the schema pre-wired for exactly this.
 */
async function ingestPartnerApplication(
  db: TenantBoundDb,
  args: {
    tenantId: string;
    requisitionId: string;
    personId: string;
    resumeUploadKey: string;
    consentVersion: string;
    partnerOrgId: string;
    partnerUserId: string;
    partnerSubmissionMetadata: Record<string, unknown>;
    log: HonoTRPCContext["log"];
    requestId: string;
  },
): Promise<{
  candidateId: string;
  applicationId: string;
  wasNewApplication: boolean;
  parseStatus: "received" | "parse_failed";
}> {
  const { tenantId, requisitionId, personId } = args;

  // Parse the CV (same parser the apply path uses).
  const storage = getStorageClient();
  let parseStatus: "received" | "parse_failed" = "received";
  let parsedSkills: unknown = null;
  let parserConfidence: number | null = null;
  let yearsOfExperience: number | null = null;
  try {
    const obj = await storage.get(args.resumeUploadKey);
    const parsed = await parseResume(obj.buffer, obj.contentType, { tenantId });
    parsedSkills = parsed;
    yearsOfExperience = parsed.total_years_experience;
    parserConfidence = parsed.parse_metadata.confidence_score;
    if (parsed.parse_metadata.confidence_score === 0) parseStatus = "parse_failed";
  } catch (err) {
    args.log.error({ err, request_id: args.requestId }, "partnerSubmit: parseResume threw");
    parseStatus = "parse_failed";
  }

  // Knockout evaluation (deterministic, no AI call) — identical to apply.
  const knockoutRows = await db
    .select({
      id: requisitionKnockouts.id,
      type: requisitionKnockouts.type,
      source: requisitionKnockouts.source,
      questionText: requisitionKnockouts.questionText,
      thresholdValue: requisitionKnockouts.thresholdValue,
    })
    .from(requisitionKnockouts)
    .where(
      and(
        eq(requisitionKnockouts.tenantId, tenantId),
        eq(requisitionKnockouts.requisitionId, requisitionId),
      ),
    )
    .orderBy(requisitionKnockouts.orderIndex);
  const knockoutInputs: KnockoutInput[] = knockoutRows.map((r) => ({
    id: r.id,
    type: r.type,
    source: r.source,
    questionText: r.questionText,
    thresholdValue: r.thresholdValue,
  }));
  const knockoutEval = evaluateKnockouts(parsedSkills, knockoutInputs);
  const knockoutEvaluatedAt = new Date();

  // Upsert candidate by (tenant, person).
  const [existingCandidate] = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.tenantId, tenantId), eq(candidates.personId, personId)))
    .limit(1);
  const candidateId = existingCandidate?.id
    ? existingCandidate.id
    : await db
        .insert(candidates)
        .values({
          tenantId,
          personId,
          source: "partner_empanelled",
          consentGrantedAt: new Date(),
          consentVersion: args.consentVersion,
          currentResumeUrl: args.resumeUploadKey,
          parsedSkills,
          yearsOfExperience: yearsOfExperience !== null ? yearsOfExperience.toFixed(1) : null,
        })
        .returning({ id: candidates.id })
        .then((rows) => firstOrThrow(rows, "partner candidate insert").id);

  // Upsert application by (tenant, candidate, req).
  const [existingApp] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.tenantId, tenantId),
        eq(applications.candidateId, candidateId),
        eq(applications.requisitionId, requisitionId),
      ),
    )
    .limit(1);

  const { initialAiScoreExplanation, outboxEligible } = computeInitialScoringState(
    knockoutEval.passed,
    parserConfidence,
    knockoutEvaluatedAt,
  );

  const wasNewApplication = !existingApp?.id;
  const applicationId = existingApp?.id
    ? existingApp.id
    : await db
        .insert(applications)
        .values({
          tenantId,
          candidateId,
          requisitionId,
          source: "partner_empanelled",
          knockoutPassed: knockoutEval.passed,
          knockoutFailures: knockoutEval.failures.length > 0 ? knockoutEval.failures : null,
          knockoutEvaluatedAt,
          aiScoreExplanation: initialAiScoreExplanation,
          sourcePartnerId: args.partnerOrgId,
          submittedByPartnerUserId: args.partnerUserId,
          partnerSubmissionMetadata: args.partnerSubmissionMetadata,
        })
        .returning({ id: applications.id })
        .then((rows) => firstOrThrow(rows, "partner application insert").id);

  // Enqueue AI scoring only on first apply + eligibility — same rule as apply.
  if (wasNewApplication && outboxEligible) {
    try {
      await db.insert(aiScoreOutbox).values({ tenantId, applicationId });
    } catch (err) {
      args.log.warn(
        { err, request_id: args.requestId, application_id: applicationId },
        "partnerSubmit: ai_score_outbox enqueue failed",
      );
    }
  }

  return { candidateId, applicationId, wasNewApplication, parseStatus };
}

// ─────────────── CAND-02 raw-SQL row shapes (ctx.db.execute reads) ───────────────
interface CandidateOfferSqlRow {
  offer_id: string;
  application_id: string;
  status: string;
  base_salary_inr_paise: string;
  variable_target_inr_paise: string | null;
  joining_bonus_inr_paise: string | null;
  joining_date: string;
  location: string;
  expiry_at: Date | string;
  terms_html: string | null;
  position_title: string;
  company_name: string;
  contract_type: string | null;
  probation_months: number | null;
  benefits: unknown;
}
interface CandidateOnbCaseSqlRow {
  id: string;
  status: string;
  expected_start_date: string | null;
  position_title: string | null;
}
interface CandidateOnbDocSqlRow {
  document_type_id: string | null;
  document_type_name: string | null;
  task_status: string;
  document_id: string | null;
  verification_status: string | null;
  file_name: string | null;
  rejection_reason: string | null;
  uploaded_at: Date | string | null;
}

// ─────────────── HROPS-02 comp & offer desk helpers ───────────────
//
// The desk covers applications in the three late stages where a comp decision
// is live. Each row carries the DETERMINISTIC verdict (rule engine) + the latest
// offer + the out-of-band approval posture. Assembly is set-based (three
// batched reads, joined in JS) so the table is one round-trip regardless of size.

const COMP_DESK_STAGES: ApplicationStage[] = ["hr_round", "offer_drafted", "offer_accepted"];

/** A sensible default benefit suggestion for the composer — honest, not derived
 * from anything sensitive; the recruiter edits freely. */
const DEFAULT_SUGGESTED_BENEFITS: BenefitKey[] = ["health_insurance", "provident_fund"];

/** MAJOR rupees (positions comp band; numeric string) → INR paise. */
function majorRupeesToPaise(major: string | number | null): number | null {
  if (major == null) return null;
  const n = typeof major === "string" ? Number(major) : major;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** The out-of-band approval posture for one offer. base ≤ band max → not
 * required. Over band → posture follows the latest approval_request status. */
function computeOfferApprovalStatus(
  offerBasePaise: number | null,
  bandMaxPaise: number | null,
  latestApprovalStatus: string | null,
): OfferApprovalStatus {
  if (offerBasePaise == null || bandMaxPaise == null) return "not_required";
  if (offerBasePaise <= bandMaxPaise) return "not_required";
  if (latestApprovalStatus === "approved") return "approved";
  if (latestApprovalStatus === "pending") return "pending";
  if (latestApprovalStatus === "rejected") return "rejected";
  return "required";
}

interface CompDeskAssembled {
  row: CompDeskRow;
  positionTitle: string;
  ruleResult: CompRuleResult | null;
}

/**
 * Assemble the Comp & offer desk rows (all, or one application). Pure reads —
 * no AI, no writes. RLS scopes every read to the tenant on top of the explicit
 * tenant predicate.
 */
async function loadCompDeskAssembled(
  db: TenantBoundDb,
  tenantId: string,
  applicationId?: string,
): Promise<CompDeskAssembled[]> {
  const conds = [
    eq(applications.tenantId, tenantId),
    inArray(applications.currentStage, COMP_DESK_STAGES),
  ];
  if (applicationId) conds.push(eq(applications.id, applicationId));

  const facets = await db
    .select({
      applicationId: applications.id,
      currentStage: applications.currentStage,
      expectedSalary: applications.expectedSalaryInrPaise,
      candidateName: persons.fullName,
      roleTitle: positions.title,
      bandMin: positions.compBandMin,
      bandMax: positions.compBandMax,
      compCurrency: positions.compCurrency,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .where(and(...conds))
    .orderBy(desc(applications.stageEnteredAt));

  if (facets.length === 0) return [];
  const appIds = facets.map((f) => f.applicationId);

  // Latest offer per application (most recent by createdAt).
  const offerRows = await db
    .select({
      id: offers.id,
      applicationId: offers.applicationId,
      status: offers.status,
      baseSalaryInrPaise: offers.baseSalaryInrPaise,
      createdAt: offers.createdAt,
    })
    .from(offers)
    .where(and(eq(offers.tenantId, tenantId), inArray(offers.applicationId, appIds)))
    .orderBy(desc(offers.createdAt));
  const latestOfferByApp = new Map<string, (typeof offerRows)[number]>();
  for (const o of offerRows) {
    if (!latestOfferByApp.has(o.applicationId)) latestOfferByApp.set(o.applicationId, o);
  }

  // Latest offer approval_request per offer.
  const offerIds = [...latestOfferByApp.values()].map((o) => o.id);
  const approvalByOffer = new Map<string, { id: string; status: string; requestedAt: Date }>();
  if (offerIds.length > 0) {
    const apprRows = await db
      .select({
        id: approvalRequests.id,
        subjectId: approvalRequests.subjectId,
        status: approvalRequests.status,
        requestedAt: approvalRequests.requestedAt,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, tenantId),
          eq(approvalRequests.subjectType, "offer"),
          inArray(approvalRequests.subjectId, offerIds),
        ),
      )
      .orderBy(desc(approvalRequests.requestedAt));
    for (const a of apprRows) {
      if (!approvalByOffer.has(a.subjectId)) {
        approvalByOffer.set(a.subjectId, {
          id: a.id,
          status: a.status,
          requestedAt: a.requestedAt,
        });
      }
    }
  }

  // Which applications already have a cached AI rationale.
  const recRows = await db
    .select({ applicationId: compRecommendations.applicationId })
    .from(compRecommendations)
    .where(
      and(
        eq(compRecommendations.tenantId, tenantId),
        inArray(compRecommendations.applicationId, appIds),
      ),
    );
  const hasRationale = new Set(recRows.map((r) => r.applicationId));

  return facets.map((f) => {
    const expectedPaise = f.expectedSalary != null ? Number(f.expectedSalary) : null;
    const bandMinPaise = majorRupeesToPaise(f.bandMin);
    const bandMaxPaise = majorRupeesToPaise(f.bandMax);
    const bandMidPaise =
      bandMinPaise != null && bandMaxPaise != null
        ? bandMidpointPaise(bandMinPaise, bandMaxPaise)
        : null;

    const evalInput = { expectedPaise, bandMinPaise, bandMaxPaise };
    let ruleResult: CompRuleResult | null = null;
    if (canEvaluateComp(evalInput) && bandMidPaise != null) {
      ruleResult = evaluateComp({
        expectedPaise: evalInput.expectedPaise,
        bandMinPaise: evalInput.bandMinPaise,
        bandMidPaise,
        bandMaxPaise: evalInput.bandMaxPaise,
      });
    }

    const offer = latestOfferByApp.get(f.applicationId) ?? null;
    const offerBasePaise = offer ? Number(offer.baseSalaryInrPaise) : null;
    const appr = offer ? (approvalByOffer.get(offer.id) ?? null) : null;
    const approvalStatus = computeOfferApprovalStatus(
      offerBasePaise,
      bandMaxPaise,
      appr?.status ?? null,
    );

    const row: CompDeskRow = {
      applicationId: f.applicationId,
      candidateName: f.candidateName ?? "Candidate",
      roleTitle: f.roleTitle,
      currentStage: f.currentStage,
      expectedSalaryInrPaise: expectedPaise,
      bandMinPaise,
      bandMidPaise,
      bandMaxPaise,
      compCurrency: f.compCurrency ?? null,
      verdict: ruleResult ? (ruleResult.verdict as CompVerdict) : null,
      suggestedPaise: ruleResult ? ruleResult.suggestedPaise : null,
      reasons: ruleResult ? ruleResult.reasons : [],
      offerId: offer?.id ?? null,
      offerStatus: offer
        ? (offer.status as
            | "drafted"
            | "extended"
            | "accepted"
            | "declined"
            | "expired"
            | "cancelled")
        : null,
      offerBaseInrPaise: offerBasePaise,
      approvalStatus,
      approvalRequestId: appr?.id ?? null,
      hasRationale: hasRationale.has(f.applicationId),
    };
    return { row, positionTitle: f.roleTitle, ruleResult };
  });
}

/**
 * Resolve-or-create the tenant's single-step "HR Head approval" matrix for
 * OFFERS, then a fresh immutable chain from it (mirror of the requisition chain
 * resolver — offers route out-of-band approval to the HR head). Returns chain id.
 */
async function resolveOfferApprovalChain(
  db: NonNullable<HonoTRPCContext["db"]>,
  tenantId: string,
  createdByMembershipId: string | null,
): Promise<string> {
  const RULES = {
    version: 1,
    steps: [{ approver_kind: "role", approver_ref: "hr_head", required: true }],
  };
  const RESOLVED_STEPS = [
    {
      step_index: 0,
      approver_kind: "role",
      approver_ref: "hr_head",
      required: true,
      order_index: 0,
    },
  ];

  const [existing] = await db
    .select({ id: approvalMatrices.id, rules: approvalMatrices.rules })
    .from(approvalMatrices)
    .where(and(eq(approvalMatrices.tenantId, tenantId), eq(approvalMatrices.subjectType, "offer")))
    .orderBy(desc(approvalMatrices.effectiveFrom))
    .limit(1);

  let matrixId = existing?.id;
  let matrixRules: unknown = existing?.rules;
  if (!matrixId) {
    const [created] = await db
      .insert(approvalMatrices)
      .values({
        tenantId,
        subjectType: "offer",
        name: "Out-of-band offer approval — HR Head",
        rules: RULES,
        effectiveFrom: new Date(),
        createdByMembershipId,
      })
      .returning({ id: approvalMatrices.id, rules: approvalMatrices.rules });
    matrixId = created?.id;
    matrixRules = created?.rules;
  }
  if (!matrixId) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "offer approval_matrix resolution returned no row",
    });
  }

  const [chain] = await db
    .insert(approvalChains)
    .values({
      tenantId,
      matrixId,
      matrixVersionSnapshot: matrixRules ?? RULES,
      resolvedSteps: RESOLVED_STEPS,
    })
    .returning({ id: approvalChains.id });
  if (!chain) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "offer approval_chain insert returned no row",
    });
  }
  return chain.id;
}

/**
 * The out-of-band gate, shared by extendOffer + the desk. Returns null when the
 * offer may be extended, or a human message when it is blocked pending approval.
 * An offer whose base exceeds the role's band max may only be extended once an
 * approval_request (subject_type offer) for it has reached `approved`.
 */
async function offerExtendBlockReason(
  db: NonNullable<HonoTRPCContext["db"]>,
  tenantId: string,
  offerId: string,
  offerBasePaise: bigint | number,
  applicationId: string,
): Promise<string | null> {
  const [pos] = await db
    .select({ bandMax: positions.compBandMax })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .where(eq(applications.id, applicationId))
    .limit(1);
  const bandMaxPaise = pos ? majorRupeesToPaise(pos.bandMax) : null;
  if (bandMaxPaise == null) return null; // no band → nothing to gate against
  if (Number(offerBasePaise) <= bandMaxPaise) return null; // within band
  // Over band — require an approved approval_request for this offer.
  const [appr] = await db
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.subjectType, "offer"),
        eq(approvalRequests.subjectId, offerId),
      ),
    )
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(1);
  if (appr?.status === "approved") return null;
  return "This offer's base salary exceeds the role's comp band. It needs HR-head approval before it can be extended.";
}

// ═══════════ RECR-03 — recruiter brief + missing-info shared helpers ═══════════

/** Narrowed view of the parsed-resume jsonb (parsed_skills). Every field is
 * optional + defensively read — a partial or absent parse must never throw. */
interface ParsedResumeView {
  skills?: unknown;
  work_history?: unknown;
  notice_period_days?: unknown;
  availability_date?: unknown;
  work_authorization?: unknown;
  achievements?: unknown;
  education?: unknown;
  personal?: Record<string, unknown>;
}
function narrowParsedResume(value: unknown): ParsedResumeView {
  if (!value || typeof value !== "object") return {};
  return value as ParsedResumeView;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Deterministic field-presence for the Missing Info Tracker. `true` = the value
 * is on the application / parsed resume; `false` = genuinely missing (drives a
 * pending row). Reads only real fields — no inference.
 */
function computeFieldPresence(args: {
  expectedSalaryInrPaise: bigint | null;
  parsed: ParsedResumeView;
  personLocationCountry: string | null;
}): FieldPresence {
  const { parsed } = args;
  const personal = parsed.personal ?? {};
  const noticePresent =
    typeof parsed.notice_period_days === "number" ||
    typeof personal.notice_period_days === "number";
  const availabilityPresent =
    asString(parsed.availability_date) != null || asString(personal.availability_date) != null;
  const workAuthPresent =
    asString(parsed.work_authorization) != null || asString(personal.work_authorization) != null;
  const locationPresent =
    asString(args.personLocationCountry) != null || asString(personal.location_country) != null;
  const skillsPresent = asStringArray(parsed.skills).length > 0;
  const educationYearPresent =
    Array.isArray(parsed.education) &&
    parsed.education.some(
      (e) => e && typeof e === "object" && (e as Record<string, unknown>).year != null,
    );

  return {
    expected_salary: args.expectedSalaryInrPaise != null,
    notice_period: noticePresent,
    availability_date: availabilityPresent,
    work_authorization: workAuthPresent,
    current_location: locationPresent,
    skills_confirmation: skillsPresent,
    education_year: educationYearPresent,
  };
}

/** Parsed resume highlights (deterministic — flattened from work_history +
 * any explicit achievements). Bounded so a huge parse can't balloon the wire. */
function extractResumeHighlights(parsed: ParsedResumeView): {
  keyProjects: string[];
  achievements: string[];
} {
  const work = Array.isArray(parsed.work_history) ? parsed.work_history : [];
  const keyProjects: string[] = [];
  for (const w of work) {
    if (!w || typeof w !== "object") continue;
    for (const h of asStringArray((w as Record<string, unknown>).highlights)) {
      keyProjects.push(h);
      if (keyProjects.length >= 6) break;
    }
    if (keyProjects.length >= 6) break;
  }
  return {
    keyProjects,
    achievements: asStringArray(parsed.achievements).slice(0, 6),
  };
}

interface RecruiterBriefContextRow {
  applicationId: string;
  candidateId: string;
  candidateName: string | null;
  candidateRef: string | null;
  candidateEmail: string | null;
  source: string | null;
  currentStage: ApplicationStage;
  aiScore: number | null;
  expectedSalaryInrPaise: bigint | null;
  personLocationCountry: string | null;
  parsedSkills: unknown;
  yearsOfExperience: number | null;
  positionTitle: string;
  companyName: string;
  jdVersionId: string;
  jdText: string | null;
}

/** One read that assembles everything the recruiter brief / missing-info rows
 * need for an application. RLS scopes it to the tenant. Null when not found. */
async function loadRecruiterBriefContext(
  db: NonNullable<HonoTRPCContext["db"]>,
  applicationId: string,
): Promise<{
  row: RecruiterBriefContextRow;
  jdSkills: RecruiterBriefSkillContext[];
  skillsMatch: ReturnType<typeof computeSkillsMatch>;
} | null> {
  const [row] = await db
    .select({
      applicationId: applications.id,
      candidateId: candidates.id,
      candidateName: persons.fullName,
      candidateEmail: persons.emailPrimary,
      source: candidates.source,
      currentStage: applications.currentStage,
      aiScore: applications.aiScore,
      expectedSalaryInrPaise: applications.expectedSalaryInrPaise,
      personLocationCountry: persons.locationCountry,
      parsedSkills: candidates.parsedSkills,
      yearsOfExperience: candidates.yearsOfExperience,
      positionTitle: positions.title,
      companyName: tenants.displayName,
      jdVersionId: requisitions.jdVersionId,
      jdText: jdVersions.jdText,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .innerJoin(tenants, eq(tenants.id, applications.tenantId))
    .innerJoin(jdVersions, eq(jdVersions.id, requisitions.jdVersionId))
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!row) return null;

  const jdSkillRows = await db
    .select({
      skillName: jdSkills.skillName,
      weight: jdSkills.weight,
      isRequired: jdSkills.isRequired,
    })
    .from(jdSkills)
    .where(eq(jdSkills.jdVersionId, row.jdVersionId));

  const parsed = narrowParsedResume(row.parsedSkills);
  const parsedSkillNames = asStringArray(parsed.skills);
  const match = computeSkillsMatch(
    parsedSkillNames,
    jdSkillRows.map((s) => ({
      skillName: s.skillName,
      weight: Number(s.weight),
      isRequired: s.isRequired,
    })),
  );
  const skills: RecruiterBriefSkillContext[] = match.items.map((it) => ({
    skillName: it.skill,
    isRequired: it.isRequired,
    matched: it.matched,
  }));

  return {
    row: {
      applicationId: row.applicationId,
      candidateId: row.candidateId,
      candidateName: row.candidateName,
      // A short candidate reference — first 8 of the id, upper (stable, opaque).
      candidateRef: `RC-${row.candidateId.slice(0, 6).toUpperCase()}`,
      candidateEmail: row.candidateEmail,
      source: row.source,
      currentStage: row.currentStage as ApplicationStage,
      aiScore: row.aiScore != null ? Number(row.aiScore) : null,
      expectedSalaryInrPaise: row.expectedSalaryInrPaise,
      personLocationCountry: row.personLocationCountry,
      parsedSkills: row.parsedSkills,
      yearsOfExperience: row.yearsOfExperience != null ? Number(row.yearsOfExperience) : null,
      positionTitle: row.positionTitle,
      companyName: row.companyName,
      jdVersionId: row.jdVersionId,
      jdText: row.jdText,
    },
    jdSkills: skills,
    skillsMatch: match,
  };
}

/** Deterministic must-have coverage — weighted match over REQUIRED JD skills
 * only, 0–100. Null when the JD has no required skills. */
function mustHaveCoveragePct(match: ReturnType<typeof computeSkillsMatch>): number | null {
  const required = match.items.filter((i) => i.isRequired && i.weight > 0);
  const total = required.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;
  const matched = required.reduce((s, i) => s + (i.matched ? i.weight : 0), 0);
  return Math.round((matched / total) * 100);
}

const RECRUITER_BRIEF_KIND_SET = new Set<string>([
  "strengths_risks",
  "screen_script",
  "availability_draft",
]);
function isRecruiterBriefKind(kind: string): kind is RecruiterBriefKind {
  return RECRUITER_BRIEF_KIND_SET.has(kind);
}

/** The stored recruiter_brief content is validated per-kind before it reaches
 * the wire (a stale row from an older prompt shape falls back to null). */
function parseRecruiterBriefContent(
  kind: RecruiterBriefKind,
  raw: unknown,
): RecruiterBriefContent | null {
  const schema =
    kind === "strengths_risks"
      ? strengthsRisksAiSchema
      : kind === "screen_script"
        ? screenScriptAiSchema
        : availabilityDraftAiSchema;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const appRouter = router({
  // ─────────── public: apply form ───────────
  submitApplication: publicProcedure
    .input(submitApplicationInputSchema)
    .output(submitApplicationOutputSchema)
    .mutation(async ({ ctx, input }): Promise<SubmitApplicationOutput> => {
      // 1. Resolve the requisition (tells us the tenant + accepting status).
      const [req] = await poolDb
        .select({
          id: requisitions.id,
          tenantId: requisitions.tenantId,
          status: requisitions.status,
        })
        .from(requisitions)
        .where(eq(requisitions.id, input.requisitionId))
        .limit(1);
      if (!req) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      }
      // Accepting-applications states — Wave 1 list. Tightening this is a
      // workflow concern; "draft" and "cancelled" obviously reject; the
      // others are open game for an apply form. Shared with the public
      // resolver below so the page-level 404 and the procedure-level
      // 400 cannot disagree about which slugs are "live".
      if (!PUBLIC_APPLY_ACCEPTING_STATUSES.has(req.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Requisition not accepting applications (status=${req.status})`,
        });
      }

      return withAudit(
        "submit_application",
        ctx,
        input,
        async () => {
          // 2. Fetch resume from storage, parse it.
          const storage = getStorageClient();
          const obj = await storage.get(input.resumeUploadKey);
          let parseStatus: "received" | "parse_failed" = "received";
          let parsedSkills: unknown = null;
          let parserConfidence: number | null = null;
          let yearsOfExperience: number | null = null;
          try {
            const parsed = await parseResume(obj.buffer, obj.contentType, {
              tenantId: req.tenantId,
            });
            parsedSkills = parsed;
            yearsOfExperience = parsed.total_years_experience;
            parserConfidence = parsed.parse_metadata.confidence_score;
            if (parsed.parse_metadata.confidence_score === 0) parseStatus = "parse_failed";
          } catch (err) {
            ctx.log.error({ err, request_id: ctx.requestId }, "parseResume threw");
            parseStatus = "parse_failed";
          }

          // 2a. Knockout evaluation (AI-03). Synchronous, deterministic,
          // no AI call. Skipped at submit time only — recruiter-side
          // re-evaluation (jd_skills change, recruiter rescoring) is a
          // separate ticket. Results are written onto the application
          // row in step 5; we evaluate here so the column values can
          // land atomically with the insert.
          const knockoutRows = await poolDb
            .select({
              id: requisitionKnockouts.id,
              type: requisitionKnockouts.type,
              source: requisitionKnockouts.source,
              questionText: requisitionKnockouts.questionText,
              thresholdValue: requisitionKnockouts.thresholdValue,
            })
            .from(requisitionKnockouts)
            .where(
              and(
                eq(requisitionKnockouts.tenantId, req.tenantId),
                eq(requisitionKnockouts.requisitionId, req.id),
              ),
            )
            .orderBy(requisitionKnockouts.orderIndex);
          const knockoutInputs: KnockoutInput[] = knockoutRows.map((r) => ({
            id: r.id,
            type: r.type,
            source: r.source,
            questionText: r.questionText,
            thresholdValue: r.thresholdValue,
          }));
          const knockoutEval = evaluateKnockouts(parsedSkills, knockoutInputs);
          const knockoutEvaluatedAt = new Date();

          // 3. Dedup person by normalised email OR phone within tenant.
          // Two indexed lookups (one per identifier) rather than a single
          // OR query — the OR-with-limit pattern picks an arbitrary row
          // when many phone-only matches exist and can miss the
          // just-created row (no ORDER BY → planner picks any
          // tuple-order). Two lookups also let us collapse the
          // "same row matches both" case cleanly: if email and phone
          // resolve to the same person id, that's the canonical merge
          // target.
          //
          // Preference order:
          //   (a) email and phone both resolve to the same person →
          //       silent merge (best-quality match).
          //   (b) one of the two matches a person → silent merge.
          //   (c) email matches person A and phone matches person B
          //       (A != B) → ambiguous collision, create new person
          //       (ticket: "let the partner dedup audit surface it").
          //   (d) no matches → create new person.
          const emailNorm = normaliseEmail(input.applicant.email);
          const phoneNorm = normalisePhone(input.applicant.phone);
          const [emailMatch] = await poolDb
            .select({
              id: persons.id,
              emailNorm: persons.emailNormalised,
              phoneNorm: persons.phoneNormalised,
              linkedinUrl: persons.linkedinUrl,
            })
            .from(persons)
            .where(and(eq(persons.tenantId, req.tenantId), eq(persons.emailNormalised, emailNorm)))
            .limit(1);
          const [phoneMatch] = await poolDb
            .select({
              id: persons.id,
              emailNorm: persons.emailNormalised,
              phoneNorm: persons.phoneNormalised,
              linkedinUrl: persons.linkedinUrl,
            })
            .from(persons)
            .where(and(eq(persons.tenantId, req.tenantId), eq(persons.phoneNormalised, phoneNorm)))
            .limit(1);

          let personId: string;
          let dedupDecision: "allow_new" | "link_existing";
          let dedupReason: string | null = null;

          const sameMatch = emailMatch && phoneMatch && emailMatch.id === phoneMatch.id;
          const winner = sameMatch ? emailMatch : (emailMatch ?? phoneMatch);
          const isCollision = !!emailMatch && !!phoneMatch && emailMatch.id !== phoneMatch.id;

          if (winner && !isCollision) {
            personId = winner.id;
            dedupDecision = "link_existing";
            dedupReason = sameMatch
              ? "email_and_phone_match"
              : emailMatch
                ? "email_match"
                : "phone_match";
            // Best-effort linkedin enrichment when the existing person
            // doesn't have one and the applicant supplied one.
            if (!winner.linkedinUrl && input.applicant.linkedinUrl) {
              await poolDb
                .update(persons)
                .set({ linkedinUrl: input.applicant.linkedinUrl, updatedAt: new Date() })
                .where(eq(persons.id, personId));
            }
          } else {
            // 0 matches OR 2+ rows where no single row matches both
            // criteria (collision: email matches one person, phone
            // matches another). Both branches create a new person; the
            // collision branch is audited with a distinct reason so
            // an analyst can find the collisions later.
            personId = await poolDb
              .insert(persons)
              .values({
                tenantId: req.tenantId,
                fullName: input.applicant.fullName,
                emailPrimary: input.applicant.email,
                emailNormalised: emailNorm,
                phonePrimary: input.applicant.phone,
                phoneNormalised: phoneNorm,
                locationCountry: input.applicant.locationCountry ?? null,
                linkedinUrl: input.applicant.linkedinUrl ?? null,
              })
              .returning({ id: persons.id })
              .then((rows) => firstOrThrow(rows, "persons insert").id);
            dedupDecision = "allow_new";
            dedupReason = isCollision ? "ambiguous_email_phone_collision" : "no_match";
          }

          // Audit the dedup decision. Fire-and-forget on failure — the
          // application is the contract, the audit row is observability.
          try {
            await poolDb.insert(candidateDedupAttempts).values({
              tenantId: req.tenantId,
              submittedEmail: input.applicant.email,
              submittedPhone: input.applicant.phone,
              matchedPersonId: dedupDecision === "link_existing" ? personId : null,
              decision: dedupDecision,
              decisionReason: dedupReason,
              submissionMetadata: {
                source: "public_apply_form",
                requisitionId: req.id,
                sourceText: input.applicant.sourceText ?? null,
              },
            });
          } catch (err) {
            ctx.log.warn(
              { err, request_id: ctx.requestId, person_id: personId },
              "submitApplication: dedup attempt insert failed",
            );
          }

          // 4. Dedup candidate by (tenant_id, person_id).
          const [existingCandidate] = await poolDb
            .select({ id: candidates.id })
            .from(candidates)
            .where(and(eq(candidates.tenantId, req.tenantId), eq(candidates.personId, personId)))
            .limit(1);

          const candidateId = existingCandidate?.id
            ? existingCandidate.id
            : await poolDb
                .insert(candidates)
                .values({
                  tenantId: req.tenantId,
                  personId,
                  source: input.source,
                  consentGrantedAt: new Date(),
                  consentVersion: input.consentVersion,
                  currentResumeUrl: input.resumeUploadKey,
                  parsedSkills,
                  yearsOfExperience:
                    yearsOfExperience !== null ? yearsOfExperience.toFixed(1) : null,
                })
                .returning({ id: candidates.id })
                .then((rows) => firstOrThrow(rows, "candidates insert").id);

          // 5. Create the application row. Unique (tenant, candidate, req)
          // means double-apply attempts return the existing row.
          const [existingApp] = await poolDb
            .select({ id: applications.id })
            .from(applications)
            .where(
              and(
                eq(applications.tenantId, req.tenantId),
                eq(applications.candidateId, candidateId),
                eq(applications.requisitionId, req.id),
              ),
            )
            .limit(1);

          // Decide what the application row should carry for the
          // scoring fields. NULL ai_score + ai_scored_at on a fresh
          // application — those land later from the worker if scoring
          // is eligible, or stay NULL forever if scoring is skipped.
          // ai_score_explanation IS populated synchronously here for
          // the skipped cases so the recruiter drawer can render the
          // reason without a second query.
          const { initialAiScoreExplanation, outboxEligible } = computeInitialScoringState(
            knockoutEval.passed,
            parserConfidence,
            knockoutEvaluatedAt,
          );

          const wasNewApplication = !existingApp?.id;
          const applicationId = existingApp?.id
            ? existingApp.id
            : await poolDb
                .insert(applications)
                .values({
                  tenantId: req.tenantId,
                  candidateId,
                  requisitionId: req.id,
                  source: input.source,
                  knockoutPassed: knockoutEval.passed,
                  knockoutFailures: knockoutEval.failures.length > 0 ? knockoutEval.failures : null,
                  knockoutEvaluatedAt,
                  aiScoreExplanation: initialAiScoreExplanation,
                })
                .returning({ id: applications.id })
                .then((rows) => firstOrThrow(rows, "applications insert").id);

          // Enqueue the AI scoring outbox row only on first apply +
          // eligibility (knockouts not failed, parser confidence above
          // floor). The compound unique on (tenant_id, application_id)
          // is belt-and-braces — wasNewApplication already guarantees
          // one enqueue per application.
          if (wasNewApplication && outboxEligible) {
            try {
              await poolDb.insert(aiScoreOutbox).values({
                tenantId: req.tenantId,
                applicationId,
              });
            } catch (err) {
              ctx.log.warn(
                { err, request_id: ctx.requestId, application_id: applicationId },
                "submitApplication: ai_score_outbox enqueue failed",
              );
            }
          }

          // Enqueue the "application received" candidate email only on
          // first apply — re-submits of the same (candidate, req) pair
          // hit the dedup branch and should NOT spam the candidate.
          if (wasNewApplication) {
            try {
              const positionTitle = await fetchPositionTitleForRequisition(req.id);
              const companyName = await fetchTenantDisplayName(req.tenantId);
              await enqueueNotification(poolDb, {
                tenantId: req.tenantId,
                recipientType: "candidate",
                recipientEmail: input.applicant.email,
                recipientCandidateId: candidateId,
                templateKey: "candidate.application_received",
                templateData: {
                  candidateName: input.applicant.fullName,
                  positionTitle,
                  companyName,
                  applicationReference: applicationId.slice(0, 8),
                },
                dedupKey: `application_received:${applicationId}`,
              });
            } catch (err) {
              // Don't fail submission on notification enqueue errors —
              // the application row is the contract, the email is a
              // nice-to-have. Logged for ops.
              ctx.log.warn(
                { err, request_id: ctx.requestId, application_id: applicationId },
                "submitApplication: enqueueNotification failed",
              );
            }
          }

          return { applicationId, candidateId, status: parseStatus };
        },
        { tenantIdOverride: req.tenantId },
      );
    }),

  /**
   * Resolves (tenantSlug, reqSlug) → the data the public apply page
   * needs. NOT_FOUND on any of: tenant missing, requisition missing,
   * tenant-mismatch (req lives under a different tenant), requisition
   * not in a publishable state. The publishable predicate matches
   * submitApplication's ACCEPTING set so the apply page and the
   * mutation agree on whether a slug is "live".
   */
  resolvePublicRequisition: publicProcedure
    .input(resolvePublicRequisitionInputSchema)
    .output(resolvePublicRequisitionOutputSchema)
    .query(async ({ input }) => {
      const [row] = await poolDb
        .select({
          tenantId: tenants.id,
          tenantDisplayName: tenants.displayName,
          requisitionId: requisitions.id,
          status: requisitions.status,
          positionTitle: positions.title,
        })
        .from(requisitions)
        .innerJoin(tenants, eq(tenants.id, requisitions.tenantId))
        .innerJoin(
          positions,
          and(
            eq(positions.id, requisitions.positionId),
            eq(positions.tenantId, requisitions.tenantId),
          ),
        )
        .where(and(eq(tenants.slug, input.tenantSlug), eq(requisitions.publicSlug, input.reqSlug)))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      }
      if (!PUBLIC_APPLY_ACCEPTING_STATUSES.has(row.status)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Requisition not accepting applications",
        });
      }
      return {
        tenantId: row.tenantId,
        tenantDisplayName: row.tenantDisplayName,
        requisitionId: row.requisitionId,
        positionTitle: row.positionTitle,
      };
    }),

  // ─────────── protected: candidate reads ───────────
  getCandidateById: protectedProcedure
    .input(getCandidateByIdInputSchema)
    .output(getCandidateByIdOutputSchema)
    .query(async ({ ctx, input }): Promise<GetCandidateByIdOutput> => {
      return withAudit("get_candidate_by_id", ctx, input, async () => {
        const db = requireDb(ctx);
        const [row] = await db
          .select({
            candidate: {
              id: candidates.id,
              tenantId: candidates.tenantId,
              personId: candidates.personId,
              source: candidates.source,
              parsedSkills: candidates.parsedSkills,
              createdAt: candidates.createdAt,
            },
            person: {
              id: persons.id,
              fullName: persons.fullName,
              email: persons.emailPrimary,
              phone: persons.phonePrimary,
              locationCountry: persons.locationCountry,
            },
          })
          .from(candidates)
          .innerJoin(
            persons,
            and(eq(candidates.personId, persons.id), eq(candidates.tenantId, persons.tenantId)),
          )
          .where(eq(candidates.id, input.id))
          .limit(1);
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Candidate not found" });
        }

        // POLISH-01 (Item A) — the drawer's AI-score hero. The score lives on
        // the application, not the candidate, so we read it in its own facet.
        // Prefer the applicationId the drawer passes (it's application-centric);
        // otherwise fall back to the candidate's most recent application. RLS
        // already scopes to the tenant; the candidateId predicate scopes to
        // this candidate so a passed applicationId can't cross candidates.
        const appConds = [eq(applications.candidateId, input.id)];
        if (input.applicationId) appConds.push(eq(applications.id, input.applicationId));
        const [appRow] = await db
          .select({
            id: applications.id,
            aiScore: applications.aiScore,
            aiScoreExplanation: applications.aiScoreExplanation,
            aiScoredAt: applications.aiScoredAt,
            currentStage: applications.currentStage,
          })
          .from(applications)
          .where(and(...appConds))
          .orderBy(desc(applications.createdAt))
          .limit(1);

        // HRHEAD-03 screeningPrivacy — presentation-level masking. When the
        // tenant enables anonymisation and the caller is a masked-role user
        // (recruiter without an accountable role), a candidate still below the
        // tech_interview gate renders as "Candidate #SHORT-ID" and/or with
        // contact fields nulled. Purely a read transform: the PII-access log
        // above is unaffected (the recruiter DID access the row; the policy
        // only shapes what the UI shows). Missing application → most-restrictive
        // (treat as earliest stage) so a policy-on tenant never leaks by gap.
        const maskStage = appRow?.currentStage ?? "application_received";
        const privacy = ctx.tenantId
          ? await resolveTenantScreeningPrivacyDb(ctx.tenantId)
          : resolveScreeningPrivacy({});
        const mask = resolveCandidateMasking({
          roles: ctx.roles,
          stage: maskStage,
          privacy,
        });
        const presentedPerson = {
          ...row.person,
          fullName: mask.maskName ? candidateMaskLabel(row.candidate.id) : row.person.fullName,
          email: mask.maskContact ? null : row.person.email,
          phone: mask.maskContact ? null : row.person.phone,
        };

        // ADR-002 §7 — record the PII read (fire-and-forget, like withAudit).
        // ctx carries no membership id (not in JWT claims), so we log the
        // human actor via actor_user_id + actor_label 'user'. fields_accessed
        // enumerates the PII columns this procedure actually selects.
        if (ctx.tenantId) {
          recordPiiAccess({
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorLabel: "user",
            entityType: "candidate",
            entityId: input.id,
            fieldsAccessed: [
              "persons.full_name",
              "persons.email_primary",
              "persons.phone_primary",
              "persons.location_country",
              "candidates.parsed_skills",
            ],
            reason: "get_candidate_by_id",
            requestId: ctx.requestId,
          });
        }
        return {
          candidate: { ...row.candidate, createdAt: row.candidate.createdAt.toISOString() },
          person: presentedPerson,
          application: appRow
            ? {
                id: appRow.id,
                aiScore: appRow.aiScore === null ? null : Number(appRow.aiScore),
                aiScoreExplanation: appRow.aiScoreExplanation ?? null,
                aiScoredAt: toIsoString(appRow.aiScoredAt),
              }
            : null,
        };
      });
    }),

  listCandidates: protectedProcedure
    .input(listCandidatesInputSchema)
    .output(listCandidatesOutputSchema)
    .query(async ({ ctx, input }) => {
      // RBAC-01 — the triage/candidate feed reads pipeline data. Broad read set
      // (recruiter triages; hr_head/HM read for governance/masking); the page
      // nav is recruiter-only but the procedure serves those reads too.
      requireAnyRole(
        ctx,
        REQUISITION_READ_ROLES,
        "Candidate triage is not available for your role",
      );
      const db = requireDb(ctx);
      const limit = input.pagination.limit;
      const cursor = input.pagination.cursor ? new Date(input.pagination.cursor) : null;
      const filters = input.filters ?? {};

      // SLA-breach predicate, composed as a SQL fragment from the
      // hardcoded SLA_THRESHOLDS_HOURS map. A CASE expression returns
      // hours-in-stage > threshold for each stage that has one; rows in
      // terminal stages (threshold = null) drop out via the ELSE branch.
      const slaBreachClauses = (
        Object.entries(SLA_THRESHOLDS_HOURS) as [ApplicationStage, number | null][]
      )
        .filter(([, hours]) => hours !== null)
        .map(
          ([stage, hours]) =>
            dsql`WHEN ${applications.currentStage} = ${stage} THEN extract(epoch FROM (now() - ${applications.stageEnteredAt})) / 3600.0 > ${hours}`,
        );
      const slaBreachExpr = dsql`(CASE ${dsql.join(slaBreachClauses, dsql.raw(" "))} ELSE false END)`;

      const conds = [
        ...(filters.requisitionId ? [eq(applications.requisitionId, filters.requisitionId)] : []),
        ...(filters.stage ? [eq(applications.currentStage, filters.stage)] : []),
        ...(filters.source ? [eq(applications.source, filters.source)] : []),
        ...(filters.minAiScore !== undefined
          ? [dsql`${applications.aiScore} >= ${filters.minAiScore}`]
          : []),
        ...(filters.slaBreachOnly ? [slaBreachExpr] : []),
      ];

      // Sort + cursor. For Wave 1 we keep the cursor field locked to the
      // primary sort field; cross-sort cursor reuse isn't perfect, but
      // first-page volume covers ~all real traffic (Hot Zone capped at
      // 20, Momentum capped at 50). Document if pagination quirks
      // surface in practice.
      let orderClause;
      if (input.sort === "ai_score_desc") {
        orderClause = dsql`${applications.aiScore} DESC NULLS LAST, ${applications.id} DESC`;
        if (cursor) {
          // Cursor encodes createdAt fallback; not strictly correct for
          // ai_score_desc but stable enough for Wave 1.
          conds.push(lt(applications.createdAt, cursor));
        }
      } else if (input.sort === "sla_breach") {
        // Oldest-in-stage first — recruiter sees most overdue at the top.
        orderClause = dsql`${applications.stageEnteredAt} ASC`;
        if (cursor) {
          conds.push(dsql`${applications.stageEnteredAt} > ${cursor.toISOString()}`);
        }
      } else {
        orderClause = desc(applications.createdAt);
        if (cursor) conds.push(lt(applications.createdAt, cursor));
      }

      const rows = await db
        .select({
          candidateId: candidates.id,
          applicationId: applications.id,
          fullName: persons.fullName,
          email: persons.emailPrimary,
          source: applications.source,
          stage: applications.currentStage,
          stageEnteredAt: applications.stageEnteredAt,
          aiScore: applications.aiScore,
          aiScoreExplanation: applications.aiScoreExplanation,
          createdAt: applications.createdAt,
        })
        .from(applications)
        .innerJoin(
          candidates,
          and(
            eq(applications.candidateId, candidates.id),
            eq(applications.tenantId, candidates.tenantId),
          ),
        )
        .innerJoin(
          persons,
          and(eq(candidates.personId, persons.id), eq(candidates.tenantId, persons.tenantId)),
        )
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(orderClause)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const out = rows.slice(0, limit);

      // HRHEAD-03 screeningPrivacy — same presentation-level mask the drawer
      // applies, here per triage row. Resolve the policy once, then decide
      // per-row from that row's stage (masking lifts at tech_interview). The
      // recruiter still sees the row (and its score); only the identity is
      // anonymised while the candidate is in early screening.
      const privacy = ctx.tenantId
        ? await resolveTenantScreeningPrivacyDb(ctx.tenantId)
        : resolveScreeningPrivacy({});
      return {
        rows: out.map((r) => {
          const mask = resolveCandidateMasking({ roles: ctx.roles, stage: r.stage, privacy });
          return {
            candidateId: r.candidateId,
            applicationId: r.applicationId,
            fullName: mask.maskName ? candidateMaskLabel(r.candidateId) : r.fullName,
            email: mask.maskContact ? null : r.email,
            source: r.source,
            stage: r.stage,
            stageEnteredAt: r.stageEnteredAt.toISOString(),
            aiScore: r.aiScore === null ? null : Number(r.aiScore),
            aiScoreExplanation: r.aiScoreExplanation,
            createdAt: r.createdAt.toISOString(),
          };
        }),
        nextCursor: hasMore ? lastCursor(out) : null,
      };
    }),

  // ─────────── protected: requisition reads ───────────
  getRequisitionById: protectedProcedure
    .input(getRequisitionByIdInputSchema)
    .output(getRequisitionByIdOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = requireDb(ctx);
      const [row] = await db
        .select()
        .from(requisitions)
        .where(eq(requisitions.id, input.id))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      }
      return {
        id: row.id,
        tenantId: row.tenantId,
        positionId: row.positionId,
        jdVersionId: row.jdVersionId,
        status: row.status,
        publicSlug: row.publicSlug ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    }),

  listRequisitions: protectedProcedure
    .input(listRequisitionsInputSchema)
    .output(listRequisitionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = requireDb(ctx);
      const limit = input.pagination.limit;
      const cursorDate = input.pagination.cursor ? new Date(input.pagination.cursor) : null;
      const conds = [
        ...(input.filters?.status ? [eq(requisitions.status, input.filters.status)] : []),
        ...(input.filters?.primaryRecruiterId
          ? [eq(requisitions.primaryRecruiterId, input.filters.primaryRecruiterId)]
          : []),
        ...(cursorDate ? [lt(requisitions.createdAt, cursorDate)] : []),
      ];
      const rows = await db
        .select()
        .from(requisitions)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(requisitions.createdAt))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const out = rows.slice(0, limit);
      return {
        rows: out.map((r) => ({
          id: r.id,
          tenantId: r.tenantId,
          positionId: r.positionId,
          jdVersionId: r.jdVersionId,
          status: r.status,
          publicSlug: r.publicSlug ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor: hasMore ? lastCursor(out) : null,
      };
    }),

  // ─────────── REQ-01: requirement-owner + HR-head reads ───────────

  /**
   * Requirement-owner requisition list (/requisitions). Role-gated to
   * hiring_manager / recruiter / admin. Joins positions for the human
   * title + location; RLS scopes rows to the caller's tenant. Read-only
   * skeleton — creation + detail arrive with REQ-02.
   */
  listRequisitionSummaries: protectedProcedure
    .input(listRequisitionSummariesInputSchema)
    .output(listRequisitionSummariesOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        REQUISITION_READ_ROLES,
        "Requisition access requires the hiring_manager, recruiter, or admin role",
      );
      const db = requireDb(ctx);
      const rows = await db
        .select({
          id: requisitions.id,
          status: requisitions.status,
          openings: requisitions.numberOfOpenings,
          createdAt: requisitions.createdAt,
          title: positions.title,
          primaryLocation: positions.primaryLocation,
          locationType: positions.locationType,
        })
        .from(requisitions)
        .leftJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .orderBy(desc(requisitions.createdAt))
        .limit(input.limit);
      return {
        rows: rows.map((r) => ({
          id: r.id,
          title: r.title ?? null,
          status: r.status,
          // Prefer the concrete location; fall back to the location type
          // (remote/hybrid/onsite/multi) so a row is never blank.
          location: r.primaryLocation ?? r.locationType ?? null,
          openings: r.openings,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }),

  /**
   * HR-head requisition-approval queue (/requisition-approvals). Role-gated
   * to hr_head / admin — recruiter/hiring_manager get FORBIDDEN. Reads
   * approval_requests rows with subject_type='requisition'. The table is
   * real but empty until REQ-02/03 wire submission; the UI owns the empty
   * state. Read-only skeleton — decisions arrive with REQ-03.
   */
  listRequisitionApprovals: protectedProcedure
    .input(listRequisitionApprovalsInputSchema)
    .output(listRequisitionApprovalsOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        REQUISITION_APPROVAL_READ_ROLES,
        "Requisition-approval access requires the hr_head or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      // REQ-02: enrich the skeleton with the requisition title via an
      // app-layer join subject_id → requisitions → positions. subject_id is
      // deliberately not FK'd, so this is a left join keyed on (tenant, id);
      // RLS scopes every table to the caller's tenant. HRHEAD-01 widens the
      // join to the department (business_unit) + comp band and derives the
      // requester name, age, priority and outcome for the full-table queue.
      const rows = await db
        .select({
          id: approvalRequests.id,
          subjectId: approvalRequests.subjectId,
          title: positions.title,
          department: businessUnits.name,
          compBandMin: positions.compBandMin,
          compBandMax: positions.compBandMax,
          compCurrency: positions.compCurrency,
          requestedByMembershipId: approvalRequests.requestedByMembershipId,
          status: approvalRequests.status,
          currentStepIndex: approvalRequests.currentStepIndex,
          requestedAt: approvalRequests.requestedAt,
          createdAt: approvalRequests.createdAt,
          context: approvalRequests.context,
        })
        .from(approvalRequests)
        .leftJoin(
          requisitions,
          and(
            eq(approvalRequests.tenantId, requisitions.tenantId),
            eq(approvalRequests.subjectId, requisitions.id),
          ),
        )
        .leftJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .leftJoin(
          businessUnits,
          and(
            eq(positions.tenantId, businessUnits.tenantId),
            eq(positions.businessUnitId, businessUnits.id),
          ),
        )
        .where(eq(approvalRequests.subjectType, "requisition"))
        .orderBy(desc(approvalRequests.createdAt))
        .limit(input.limit);

      const nameById = await resolveMembershipNames(
        ctx,
        ctx.tenantId,
        rows.map((r) => r.requestedByMembershipId).filter((id): id is string => !!id),
      );

      return {
        rows: rows.map((r): RequisitionApprovalRow => {
          const ageDays = daysSince(r.requestedAt);
          return {
            id: r.id,
            subjectId: r.subjectId,
            title: r.title ?? null,
            status: r.status,
            currentStepIndex: r.currentStepIndex,
            requestedAt: r.requestedAt.toISOString(),
            createdAt: r.createdAt.toISOString(),
            biasFlags: readBiasFlagsFromContext(r.context),
            department: r.department ?? null,
            budgetBand: formatBudgetBand(r.compBandMin, r.compBandMax, r.compCurrency),
            requestedByName: r.requestedByMembershipId
              ? (nameById.get(r.requestedByMembershipId) ?? null)
              : null,
            ageDays,
            priority: deriveApprovalPriority(ageDays),
            outcome: approvalOutcomeFromStatus(r.status),
          };
        }),
      };
    }),

  // ═══════════ REQ-02: requisition creation (draft → JD → skills → submit) ═══════════

  /**
   * createRequisitionDraft — the wizard "Basics" step. Creates the
   * position (resolving-or-creating the department business_unit), a draft
   * jd_version placeholder (the JD step fills it), the requisition (status
   * draft, self-assigned to the creating hiring manager as the placeholder
   * recruiter — recruiter reassignment is a later flow), and the first
   * requisition_state_transition (→ draft). Transactional: any throw rolls
   * back the whole chain (protectedProcedure's per-call tx). hiring_manager
   * + admin only.
   */
  createRequisitionDraft: protectedProcedure
    .input(createRequisitionDraftInputSchema)
    .output(createRequisitionDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("create_requisition_draft", ctx, input, async () => {
        requireAnyRole(
          ctx,
          REQUISITION_WRITE_ROLES,
          "Creating a requisition requires the hiring_manager or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Creating membership not found for this tenant",
          });
        }

        // Resolve-or-create the department business_unit by slug.
        const buSlug = slugifyDepartment(input.department);
        const [existingBu] = await db
          .select({ id: businessUnits.id })
          .from(businessUnits)
          .where(and(eq(businessUnits.tenantId, tenantId), eq(businessUnits.slug, buSlug)))
          .limit(1);
        let businessUnitId = existingBu?.id;
        if (!businessUnitId) {
          const [createdBu] = await db
            .insert(businessUnits)
            .values({ tenantId, name: input.department.trim(), slug: buSlug })
            .returning({ id: businessUnits.id });
          businessUnitId = createdBu?.id;
        }
        if (!businessUnitId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "business_unit resolution returned no row",
          });
        }

        // Create the position. An active position can't share a title in
        // the same BU (partial unique) — surface a clean 400 rather than a
        // raw 23505 so the hiring manager can pick a more specific title.
        let positionId: string;
        try {
          const [pos] = await db
            .insert(positions)
            .values({
              tenantId,
              businessUnitId,
              title: input.title.trim(),
              level: input.seniority ?? null,
              locationType: input.locationType,
              primaryLocation: input.primaryLocation ?? null,
              compBandMin: input.compBandMin !== undefined ? String(input.compBandMin) : null,
              compBandMax: input.compBandMax !== undefined ? String(input.compBandMax) : null,
              compCurrency: input.compCurrency ?? null,
              hiringManagerId: membershipId,
              createdBy: membershipId,
            })
            .returning({ id: positions.id });
          if (!pos) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "position insert returned no row",
            });
          }
          positionId = pos.id;
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `An active position titled "${input.title.trim()}" already exists in ${input.department.trim()}. Pick a more specific title.`,
            });
          }
          throw err;
        }

        // Draft JD version — placeholder body; the JD step fills it. jd_text
        // is NOT NULL, so seed a sentinel we can detect as "not yet drafted".
        const [jd] = await db
          .insert(jdVersions)
          .values({
            tenantId,
            positionId,
            versionNumber: 1,
            status: "draft",
            jdText: JD_DRAFT_PLACEHOLDER,
            summary: null,
            aiMetadata: {},
            createdBy: membershipId,
          })
          .returning({ id: jdVersions.id });
        if (!jd) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "jd_version insert returned no row",
          });
        }

        // The requisition — status draft, self-assigned to the creating
        // hiring manager. headcount_envelope_id stays NULL (envelope/budget
        // governance is out of REQ-02 scope; the FK is nullable). public_slug
        // uses the DB default (uuid-keyed) — a human slug is set at posting.
        const [req] = await db
          .insert(requisitions)
          .values({
            tenantId,
            positionId,
            jdVersionId: jd.id,
            primaryRecruiterId: membershipId,
            hiringManagerId: membershipId,
            status: "draft",
            numberOfOpenings: input.numberOfOpenings,
            targetStartDate: input.targetStartDate ?? null,
            isPublic: false,
            createdBy: membershipId,
          })
          .returning({ id: requisitions.id });
        if (!req) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "requisition insert returned no row",
          });
        }

        await db.insert(requisitionStateTransitions).values({
          tenantId,
          requisitionId: req.id,
          fromStatus: null,
          toStatus: "draft",
          transitionedBy: membershipId,
          reason: "Requisition draft created",
        });

        return { requisitionId: req.id };
      });
    }),

  /**
   * generateJdDraft — the wizard "JD" step. Calls the tenant's configured
   * LLM through @hireops/ai-client (the same pluggable path AI scoring uses;
   * NODE_ENV=test / AI_CLIENT_MODE=local → LocalAIClient fixtures) to produce
   * structured JD sections, renders them into jd_text, and updates the
   * requisition's draft jd_version. The AI client writes the ai_usage_logs
   * row itself (success + failure). Regeneration allowed while draft — it
   * overwrites the same version row. hiring_manager + admin only.
   */
  generateJdDraft: protectedProcedure
    .input(generateJdDraftInputSchema)
    .output(generateJdDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("generate_jd_draft", ctx, input, async () => {
        requireAnyRole(
          ctx,
          REQUISITION_WRITE_ROLES,
          "Generating a JD requires the hiring_manager or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);

        const facet = await loadDraftRequisitionFacet(db, input.requisitionId);
        if (facet.status !== "draft") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "JD can only be generated while the requisition is a draft",
          });
        }

        // CONF-01: honour the per-tenant jd_generation switch. Disabled →
        // a clean, honest error the wizard shows (no model call, no
        // ai_usage_logs row). Re-enable in Admin → AI settings.
        const aiSettings = await resolveTenantAiSettingsDb(tenantId);
        const jdSettings = aiSettings.jd_generation;
        if (!jdSettings.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "JD generation is disabled for this tenant. An admin can re-enable it in Admin → AI settings.",
          });
        }

        const skillRows = await db
          .select({
            skillName: jdSkills.skillName,
            weight: jdSkills.weight,
            isRequired: jdSkills.isRequired,
          })
          .from(jdSkills)
          .where(and(eq(jdSkills.tenantId, tenantId), eq(jdSkills.jdVersionId, facet.jdVersionId)));

        const companyName = await resolveTenantDisplayName(tenantId);
        const { system, user } = buildJdGenerationPrompt({
          positionTitle: facet.title,
          locationType: facet.locationType,
          primaryLocation: facet.primaryLocation,
          seniority: facet.level,
          employmentType: null,
          companyName,
          skills: skillRows.map((s) => ({
            skillName: s.skillName,
            weight: Number(s.weight),
            isRequired: s.isRequired,
          })),
          extraContext: input.extraContext ?? null,
        });

        // JD generation carries NO candidate PII (the prompt is built from
        // position title, skills, and company only), so piiMasking does not
        // apply here — verified against buildJdGenerationPrompt.
        const client = await getAIClient(tenantId);
        const raw = await client.completeStructured<JdGenerationResponse>({
          prompt: user,
          system,
          model: jdSettings.model,
          temperature: jdSettings.temperature,
          maxTokens: jdSettings.maxTokens,
          schema: jdGenerationResponseJsonSchema,
          schemaName: JD_GENERATION_SCHEMA_NAME,
          feature: JD_GENERATION_FEATURE,
          requestId: ctx.requestId,
          actorMembershipId: membershipId,
        });
        // Trust-but-verify: the AI client guarantees schema-shaped output,
        // but we re-parse so a provider quirk can't smuggle a bad shape into
        // the DB.
        const sections = jdGenerationResponseSchema.parse(raw);
        const jdText = composeJdText(sections, facet.title);

        await db
          .update(jdVersions)
          .set({
            jdText,
            summary: sections.summary,
            aiMetadata: {
              sections,
              prompt_version: JD_GENERATION_PROMPT_VERSION,
              model: client.provider,
              generated_at: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(and(eq(jdVersions.tenantId, tenantId), eq(jdVersions.id, facet.jdVersionId)));

        // CONF-02: scan the freshly-composed JD so the wizard can highlight
        // coded language the instant generation returns (the SAME scanner the
        // submit gate runs — the composed jd_text is exactly what the gate
        // scans, so client + server agree).
        const lexicon = await resolveTenantBiasLexiconDb(tenantId);
        const scan = summarizeScan(jdText, lexicon);

        return {
          jdVersionId: facet.jdVersionId,
          sections,
          promptVersion: JD_GENERATION_PROMPT_VERSION,
          model: client.provider,
          scan,
        };
      });
    }),

  /**
   * updateRequisitionDraft — the wizard "JD edits + Skills & knockouts"
   * step. Replace-set semantics while draft: supplied sections overwrite the
   * JD version's text/summary; supplied skills / knockouts are
   * delete-all-then-insert. Omitted fields are untouched. Rejects non-draft
   * requisitions (edit-after-submit is out of scope). hiring_manager + admin.
   */
  updateRequisitionDraft: protectedProcedure
    .input(updateRequisitionDraftInputSchema)
    .output(updateRequisitionDraftOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_requisition_draft", ctx, input, async () => {
        requireAnyRole(
          ctx,
          REQUISITION_WRITE_ROLES,
          "Editing a requisition draft requires the hiring_manager or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;

        const facet = await loadDraftRequisitionFacet(db, input.requisitionId);
        if (facet.status !== "draft") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A requisition can only be edited while it is a draft",
          });
        }

        // JD section edits → recompose jd_text, keep sections in ai_metadata.
        if (input.sections) {
          const jdText = composeJdText(input.sections, facet.title);
          await db
            .update(jdVersions)
            .set({
              jdText,
              summary: input.sections.summary,
              aiMetadata: {
                sections: input.sections,
                edited_at: new Date().toISOString(),
              },
              updatedAt: new Date(),
            })
            .where(and(eq(jdVersions.tenantId, tenantId), eq(jdVersions.id, facet.jdVersionId)));
        }

        // Skills → replace-set on the JD version.
        if (input.skills) {
          await db
            .delete(jdSkills)
            .where(
              and(eq(jdSkills.tenantId, tenantId), eq(jdSkills.jdVersionId, facet.jdVersionId)),
            );
          if (input.skills.length > 0) {
            await db.insert(jdSkills).values(
              input.skills.map((s) => ({
                tenantId,
                jdVersionId: facet.jdVersionId,
                skillName: s.skillName.trim(),
                weight: String(s.weight),
                isRequired: s.isRequired,
                // RO-02 (migration 0080): additive per-skill metadata. Coerce
                // empty/blank to NULL so old callers (no fields) and cleared
                // fields both persist as NULL.
                category: s.category && s.category.trim().length > 0 ? s.category.trim() : null,
                minYearsExperience: s.minYears ?? null,
                notes: s.notes && s.notes.trim().length > 0 ? s.notes.trim() : null,
              })),
            );
          }
        }

        // Knockouts → replace-set on the requisition. threshold_value carries
        // the field_path the apply-flow evaluator walks, plus the typed
        // threshold — so these rows are directly consumable by
        // evaluateKnockouts (@hireops/ai-scoring).
        if (input.knockouts) {
          await db
            .delete(requisitionKnockouts)
            .where(
              and(
                eq(requisitionKnockouts.tenantId, tenantId),
                eq(requisitionKnockouts.requisitionId, input.requisitionId),
              ),
            );
          if (input.knockouts.length > 0) {
            await db.insert(requisitionKnockouts).values(
              input.knockouts.map((k, i) => ({
                tenantId,
                requisitionId: input.requisitionId,
                questionText: k.questionText.trim(),
                type: k.type,
                thresholdValue: buildKnockoutThreshold(k),
                source: k.source,
                orderIndex: i,
              })),
            );
          }
        }

        const [{ value: skillCount } = { value: 0 }] = await db
          .select({ value: dsql<number>`count(*)::int` })
          .from(jdSkills)
          .where(and(eq(jdSkills.tenantId, tenantId), eq(jdSkills.jdVersionId, facet.jdVersionId)));
        const [{ value: knockoutCount } = { value: 0 }] = await db
          .select({ value: dsql<number>`count(*)::int` })
          .from(requisitionKnockouts)
          .where(
            and(
              eq(requisitionKnockouts.tenantId, tenantId),
              eq(requisitionKnockouts.requisitionId, input.requisitionId),
            ),
          );

        return { ok: true as const, skillCount, knockoutCount };
      });
    }),

  /**
   * submitRequisitionForApproval — the wizard "Review & submit" step.
   * Validates a small honest checklist (title, a generated/edited JD, ≥1
   * skill), resolves-or-creates the single-step "HR Head approval" chain,
   * raises the approval_request (idempotent via the partial unique — a
   * second submit returns a clean alreadySubmitted), and transitions the
   * requisition draft → pending_approval with a state-transition row. After
   * this the req appears in the HR-head queue. hiring_manager + admin only.
   */
  submitRequisitionForApproval: protectedProcedure
    .input(submitRequisitionForApprovalInputSchema)
    .output(submitRequisitionForApprovalOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("submit_requisition_for_approval", ctx, input, async () => {
        requireAnyRole(
          ctx,
          REQUISITION_WRITE_ROLES,
          "Submitting a requisition requires the hiring_manager or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);

        const facet = await loadDraftRequisitionFacet(db, input.requisitionId);

        // Idempotency: if it's already left draft and a pending request
        // exists, that's a clean re-submit — surface it, don't error.
        if (facet.status !== "draft") {
          const [pending] = await db
            .select({
              id: approvalRequests.id,
              status: approvalRequests.status,
            })
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.tenantId, tenantId),
                eq(approvalRequests.subjectType, "requisition"),
                eq(approvalRequests.subjectId, input.requisitionId),
                eq(approvalRequests.status, "pending"),
              ),
            )
            .limit(1);
          if (pending) {
            return {
              approvalRequestId: pending.id,
              status: pending.status,
              alreadySubmitted: true,
            };
          }
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Requisition is ${facet.status}, not a draft — nothing to submit`,
          });
        }

        // Completeness checklist — small + honest.
        const problems: string[] = [];
        if (!facet.title || facet.title.trim().length === 0) problems.push("a title");
        if (facet.jdText === JD_DRAFT_PLACEHOLDER || !facet.jdSummary) {
          problems.push("a job description (generate or write one)");
        }
        const [{ value: skillCount } = { value: 0 }] = await db
          .select({ value: dsql<number>`count(*)::int` })
          .from(jdSkills)
          .where(and(eq(jdSkills.tenantId, tenantId), eq(jdSkills.jdVersionId, facet.jdVersionId)));
        if (skillCount < 1) problems.push("at least one skill");
        if (problems.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot submit — the requisition still needs ${problems.join(", ")}.`,
          });
        }

        // CONF-02: the configurable JD bias gate. Scan the SAME composed
        // jd_text the wizard sees. enforcement `off` → nothing recorded;
        // `block` → refuse when any block-severity term is present (with
        // inclusive-rewrite suggestions the wizard renders inline); `warn`
        // (and non-blocking `block`) → record the flags into the approval
        // request context so the HR head sees them in the queue.
        const lexicon = await resolveTenantBiasLexiconDb(tenantId);
        const scan = summarizeScan(facet.jdText, lexicon);
        if (scanBlocksSubmit(scan)) {
          const blocking = distinctBiasFlags(scan).filter((f) => f.severity === "block");
          const detail = blocking
            .map((f) => (f.suggestion ? `"${f.term}" → ${f.suggestion}` : `"${f.term}"`))
            .join("; ");
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot submit — the job description contains language that must be revised: ${detail}`,
          });
        }
        const biasContext = biasScanContext(scan);

        // Resolve-or-create the single-step requisition approval matrix,
        // then a fresh immutable chain per submission.
        const chainId = await resolveRequisitionApprovalChain(db, tenantId, membershipId);

        // Raise the approval request idempotently: the partial unique
        // (tenant, subject_type, subject_id) WHERE status='pending' is the
        // backstop. ON CONFLICT DO NOTHING → empty result means a pending
        // request already exists (race with a concurrent submit).
        const inserted = await db
          .insert(approvalRequests)
          .values({
            tenantId,
            chainId,
            subjectType: "requisition",
            subjectId: input.requisitionId,
            status: "pending",
            currentStepIndex: 0,
            requestedByMembershipId: membershipId,
            context: { requisition_title: facet.title, ...biasContext },
          })
          .onConflictDoNothing()
          .returning({ id: approvalRequests.id });

        if (inserted.length === 0) {
          const [pending] = await db
            .select({ id: approvalRequests.id, status: approvalRequests.status })
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.tenantId, tenantId),
                eq(approvalRequests.subjectType, "requisition"),
                eq(approvalRequests.subjectId, input.requisitionId),
                eq(approvalRequests.status, "pending"),
              ),
            )
            .limit(1);
          if (!pending) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "approval_request conflict but no pending row found",
            });
          }
          return {
            approvalRequestId: pending.id,
            status: pending.status,
            alreadySubmitted: true,
          };
        }
        const approvalRow = inserted[0];
        if (!approvalRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "approval_request insert returned no row",
          });
        }

        // Transition the requisition draft → pending_approval.
        await db
          .update(requisitions)
          .set({ status: "pending_approval", updatedAt: new Date() })
          .where(
            and(eq(requisitions.tenantId, tenantId), eq(requisitions.id, input.requisitionId)),
          );
        await db.insert(requisitionStateTransitions).values({
          tenantId,
          requisitionId: input.requisitionId,
          fromStatus: "draft",
          toStatus: "pending_approval",
          transitionedBy: membershipId,
          reason: "Submitted for HR-head approval",
          metadata: { approval_request_id: approvalRow.id },
        });

        return {
          approvalRequestId: approvalRow.id,
          status: "pending",
          alreadySubmitted: false,
        };
      });
    }),

  /**
   * getRequisitionDetail — the full read for the /requisitions/[id] detail
   * page: requisition + position + current JD (text/summary/sections) +
   * skills + knockouts + latest approval state. REQUISITION_READ_ROLES.
   */
  getRequisitionDetail: protectedProcedure
    .input(getRequisitionDetailInputSchema)
    .output(getRequisitionDetailOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        REQUISITION_READ_ROLES,
        "Requisition access requires the hiring_manager, recruiter, or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;

      const [row] = await db
        .select({
          id: requisitions.id,
          status: requisitions.status,
          numberOfOpenings: requisitions.numberOfOpenings,
          targetStartDate: requisitions.targetStartDate,
          publicSlug: requisitions.publicSlug,
          tenantSlug: tenants.slug,
          createdAt: requisitions.createdAt,
          positionId: positions.id,
          title: positions.title,
          department: businessUnits.name,
          locationType: positions.locationType,
          primaryLocation: positions.primaryLocation,
          seniority: positions.level,
          compBandMin: positions.compBandMin,
          compBandMax: positions.compBandMax,
          compCurrency: positions.compCurrency,
          jdVersionId: jdVersions.id,
          jdText: jdVersions.jdText,
          jdSummary: jdVersions.summary,
          jdMetadata: jdVersions.aiMetadata,
          jdStatus: jdVersions.status,
        })
        .from(requisitions)
        .innerJoin(tenants, eq(tenants.id, requisitions.tenantId))
        .innerJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .leftJoin(
          businessUnits,
          and(
            eq(positions.tenantId, businessUnits.tenantId),
            eq(positions.businessUnitId, businessUnits.id),
          ),
        )
        .innerJoin(
          jdVersions,
          and(
            eq(requisitions.tenantId, jdVersions.tenantId),
            eq(requisitions.jdVersionId, jdVersions.id),
          ),
        )
        .where(and(eq(requisitions.tenantId, tenantId), eq(requisitions.id, input.requisitionId)))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      }

      const skills = await db
        .select({
          id: jdSkills.id,
          skillName: jdSkills.skillName,
          weight: jdSkills.weight,
          isRequired: jdSkills.isRequired,
          category: jdSkills.category,
          minYearsExperience: jdSkills.minYearsExperience,
          notes: jdSkills.notes,
        })
        .from(jdSkills)
        .where(and(eq(jdSkills.tenantId, tenantId), eq(jdSkills.jdVersionId, row.jdVersionId)))
        .orderBy(desc(jdSkills.isRequired));

      const knockouts = await db
        .select({
          id: requisitionKnockouts.id,
          questionText: requisitionKnockouts.questionText,
          type: requisitionKnockouts.type,
          source: requisitionKnockouts.source,
          thresholdValue: requisitionKnockouts.thresholdValue,
          orderIndex: requisitionKnockouts.orderIndex,
        })
        .from(requisitionKnockouts)
        .where(
          and(
            eq(requisitionKnockouts.tenantId, tenantId),
            eq(requisitionKnockouts.requisitionId, row.id),
          ),
        )
        .orderBy(requisitionKnockouts.orderIndex);

      const [approval] = await db
        .select({
          id: approvalRequests.id,
          status: approvalRequests.status,
          currentStepIndex: approvalRequests.currentStepIndex,
          requestedAt: approvalRequests.requestedAt,
          decidedAt: approvalRequests.decidedAt,
        })
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.tenantId, tenantId),
            eq(approvalRequests.subjectType, "requisition"),
            eq(approvalRequests.subjectId, row.id),
          ),
        )
        .orderBy(desc(approvalRequests.createdAt))
        .limit(1);

      // Latest HR-head decision across ALL of this requisition's approval
      // requests (REQ-03). A send_back's decision lives on the now-cancelled
      // prior request, so we join through subject_id rather than the latest
      // request. Powers the "Sent back / Rejected by HR Head: <reason>" banner.
      const [decisionRow] = await db
        .select({
          outcome: approvalDecisions.outcome,
          comment: approvalDecisions.comment,
          decidedAt: approvalDecisions.decidedAt,
        })
        .from(approvalDecisions)
        .innerJoin(
          approvalRequests,
          and(
            eq(approvalDecisions.tenantId, approvalRequests.tenantId),
            eq(approvalDecisions.requestId, approvalRequests.id),
          ),
        )
        .where(
          and(
            eq(approvalDecisions.tenantId, tenantId),
            eq(approvalRequests.subjectType, "requisition"),
            eq(approvalRequests.subjectId, row.id),
          ),
        )
        .orderBy(desc(approvalDecisions.decidedAt))
        .limit(1);
      const latestDecision = decisionRow
        ? {
            kind: decisionOutcomeToKind(decisionRow.outcome),
            outcome: decisionRow.outcome,
            reason: decisionRow.comment ?? null,
            decidedAt: toIsoString(decisionRow.decidedAt) ?? new Date(0).toISOString(),
          }
        : null;

      const meta = (row.jdMetadata ?? {}) as Record<string, unknown>;
      const rawSections = meta.sections;
      const parsedSections = jdSectionsSchema.safeParse(rawSections);

      return {
        id: row.id,
        status: row.status,
        numberOfOpenings: row.numberOfOpenings,
        targetStartDate: row.targetStartDate ?? null,
        publicSlug: row.publicSlug ?? null,
        tenantSlug: row.tenantSlug,
        createdAt: row.createdAt.toISOString(),
        positionId: row.positionId,
        title: row.title,
        department: row.department ?? null,
        locationType: row.locationType,
        primaryLocation: row.primaryLocation ?? null,
        seniority: row.seniority ?? null,
        compBandMin: row.compBandMin ?? null,
        compBandMax: row.compBandMax ?? null,
        compCurrency: row.compCurrency ?? null,
        jdVersionId: row.jdVersionId,
        jdText: row.jdText,
        jdSummary: row.jdSummary ?? null,
        jdSections: parsedSections.success ? parsedSections.data : null,
        jdStatus: row.jdStatus,
        skills: skills.map((s) => ({
          id: s.id,
          skillName: s.skillName,
          weight: Number(s.weight),
          isRequired: s.isRequired,
          category: s.category ?? null,
          minYears: s.minYearsExperience ?? null,
          notes: s.notes ?? null,
        })),
        knockouts: knockouts.map((k) => ({
          id: k.id,
          questionText: k.questionText,
          type: k.type,
          source: k.source,
          thresholdValue: k.thresholdValue,
          orderIndex: k.orderIndex,
        })),
        approval: approval
          ? {
              id: approval.id,
              status: approval.status,
              currentStepIndex: approval.currentStepIndex,
              requestedAt: approval.requestedAt.toISOString(),
              decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
            }
          : null,
        latestDecision,
        isDraft: row.status === "draft",
      };
    }),

  /**
   * listRequisitionsForSkillWeighting — the standalone /skill-weighting
   * picker (RO-02). Lists the tenant's requisitions with a per-req skill
   * coverage summary (count, must-have count, total weight) so the requirement
   * owner can jump straight to the reqs whose weighting still needs work.
   * hiring_manager + admin (the personas that own skill weighting). Weights
   * are only editable while a req is a draft; the row carries `editable` so the
   * picker can label locked reqs honestly rather than dangling a dead editor.
   */
  listRequisitionsForSkillWeighting: protectedProcedure
    .input(listRequisitionsForSkillWeightingInputSchema)
    .output(listRequisitionsForSkillWeightingOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        REQUISITION_WRITE_ROLES,
        "Skill weighting requires the hiring_manager or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;

      const rows = await db
        .select({
          id: requisitions.id,
          status: requisitions.status,
          createdAt: requisitions.createdAt,
          jdVersionId: requisitions.jdVersionId,
          title: positions.title,
          department: businessUnits.name,
          skillCount: dsql<number>`count(${jdSkills.id})::int`,
          mustHaveCount: dsql<number>`count(${jdSkills.id}) filter (where ${jdSkills.isRequired})::int`,
          totalWeight: dsql<string>`coalesce(sum(${jdSkills.weight}), 0)::text`,
        })
        .from(requisitions)
        .innerJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .leftJoin(
          businessUnits,
          and(
            eq(positions.tenantId, businessUnits.tenantId),
            eq(positions.businessUnitId, businessUnits.id),
          ),
        )
        .leftJoin(
          jdSkills,
          and(
            eq(requisitions.tenantId, jdSkills.tenantId),
            eq(requisitions.jdVersionId, jdSkills.jdVersionId),
          ),
        )
        .where(eq(requisitions.tenantId, tenantId))
        .groupBy(
          requisitions.id,
          requisitions.status,
          requisitions.createdAt,
          requisitions.jdVersionId,
          positions.title,
          businessUnits.name,
        )
        .orderBy(desc(requisitions.createdAt))
        .limit(input.limit);

      return {
        rows: rows.map((r) => ({
          id: r.id,
          title: r.title ?? null,
          status: r.status,
          department: r.department ?? null,
          jdVersionId: r.jdVersionId,
          skillCount: Number(r.skillCount),
          mustHaveCount: Number(r.mustHaveCount),
          totalWeight: Math.round(Number(r.totalWeight) * 10) / 10,
          editable: r.status === "draft",
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }),

  /**
   * decideRequisitionApproval — the HR head's verdict on a pending
   * requisition approval (REQ-03). This makes real the "Submit Decision"
   * button the prototype left dead. hr_head + admin only, audited, and
   * transactional (the whole procedure runs in one tenant-bound tx —
   * HANDOVER: withTenantContext wraps each request).
   *
   * Records an append-only approval_decisions row against step 0, moves the
   * approval_request off `pending`, and drives the requisition state machine:
   *   - approve   → request approved  · requisition pending_approval→approved
   *   - send_back → request cancelled · requisition pending_approval→draft
   *                 (frees the one-pending-per-subject partial unique so the
   *                  hiring manager can revise + resubmit a fresh request)
   *   - reject    → request rejected  · requisition pending_approval→cancelled
   *                 (no 'rejected' value in the requisition vocabulary; the
   *                  error-toned terminal is 'cancelled')
   * reason is REQUIRED for send_back and reject (clean 400 without). A
   * non-pending request is a clean CONFLICT (already decided / withdrawn).
   */
  decideRequisitionApproval: protectedProcedure
    .input(decideRequisitionApprovalInputSchema)
    .output(decideRequisitionApprovalOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("decide_requisition_approval", ctx, input, async () => {
        requireAnyRole(
          ctx,
          REQUISITION_APPROVAL_DECIDE_ROLES,
          "Deciding a requisition approval requires the hr_head or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Deciding membership not found for this tenant",
          });
        }

        const reason = input.reason?.trim() ?? "";
        if (
          (input.decision === "send_back" || input.decision === "reject") &&
          reason.length === 0
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              input.decision === "reject"
                ? "A reason is required to reject a requisition."
                : "A reason is required to send a requisition back.",
          });
        }

        // Load the pending request. subject_type guard keeps this endpoint to
        // requisition approvals only (agent approvals live elsewhere).
        const [request] = await db
          .select({
            id: approvalRequests.id,
            status: approvalRequests.status,
            subjectId: approvalRequests.subjectId,
            currentStepIndex: approvalRequests.currentStepIndex,
          })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.tenantId, tenantId),
              eq(approvalRequests.id, input.approvalRequestId),
              eq(approvalRequests.subjectType, "requisition"),
            ),
          )
          .limit(1);
        if (!request) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
        }
        if (request.status !== "pending") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `This approval is already ${request.status} — nothing to decide.`,
          });
        }

        const requisitionId = request.subjectId;
        // The requisition should be pending_approval; guard defensively so a
        // stray state doesn't get silently overwritten.
        const [req] = await db
          .select({ status: requisitions.status })
          .from(requisitions)
          .where(and(eq(requisitions.tenantId, tenantId), eq(requisitions.id, requisitionId)))
          .limit(1);
        if (!req) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
        }
        if (req.status !== "pending_approval") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Requisition is ${req.status}, not awaiting approval.`,
          });
        }

        const stepIndex = request.currentStepIndex;
        const outcome = DECISION_TO_OUTCOME[input.decision];
        const requestStatus = DECISION_TO_REQUEST_STATUS[input.decision];
        const requisitionStatus = DECISION_TO_REQUISITION_STATUS[input.decision];
        const decidedAt = new Date();

        // 1) Append-only decision row (step 0, this decider).
        const [decision] = await db
          .insert(approvalDecisions)
          .values({
            tenantId,
            requestId: request.id,
            stepIndex,
            outcome,
            approverMembershipId: membershipId,
            decidedAt,
            comment: reason.length > 0 ? reason : null,
            metadata: { decision: input.decision },
          })
          .returning({ id: approvalDecisions.id });
        if (!decision) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "approval_decision insert returned no row",
          });
        }

        // 2) Move the request off pending + stamp decided_at.
        await db
          .update(approvalRequests)
          .set({ status: requestStatus, decidedAt, updatedAt: decidedAt })
          .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, request.id)));

        // 3) Drive the requisition state machine + record the transition.
        await db
          .update(requisitions)
          .set({ status: requisitionStatus, updatedAt: decidedAt })
          .where(and(eq(requisitions.tenantId, tenantId), eq(requisitions.id, requisitionId)));
        await db.insert(requisitionStateTransitions).values({
          tenantId,
          requisitionId,
          fromStatus: "pending_approval",
          toStatus: requisitionStatus,
          transitionedBy: membershipId,
          reason:
            reason.length > 0
              ? `HR-head ${input.decision}: ${reason}`
              : `HR-head ${input.decision}`,
          metadata: { approval_request_id: request.id, decision_id: decision.id },
        });

        return {
          approvalRequestId: request.id,
          requisitionId,
          decision: input.decision,
          requestStatus,
          requisitionStatus,
          decisionId: decision.id,
        };
      });
    }),

  /**
   * postRequisition — take an APPROVED requisition live (REQ-03).
   * hiring_manager + recruiter + admin, audited. Sets a human, collision-safe
   * public_slug (slugified title + short suffix) so the public apply URL
   * `/t/<tenant>/apply/<slug>` is presentable, flips approved→posted, stamps
   * posted_at + is_public, and records the transition. Only from `approved`
   * (a clean CONFLICT otherwise). The apply page (resolvePublicRequisition)
   * accepts approved|posted, so the URL is live the moment posting completes.
   */
  postRequisition: protectedProcedure
    .input(postRequisitionInputSchema)
    .output(postRequisitionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("post_requisition", ctx, input, async () => {
        requireAnyRole(
          ctx,
          REQUISITION_POST_ROLES,
          "Posting a requisition requires the recruiter, hiring_manager, or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);

        const [row] = await db
          .select({
            status: requisitions.status,
            publicSlug: requisitions.publicSlug,
            title: positions.title,
          })
          .from(requisitions)
          .innerJoin(
            positions,
            and(
              eq(requisitions.tenantId, positions.tenantId),
              eq(requisitions.positionId, positions.id),
            ),
          )
          .where(and(eq(requisitions.tenantId, tenantId), eq(requisitions.id, input.requisitionId)))
          .limit(1);
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
        }
        if (row.status === "posted") {
          // Idempotent: already live — hand back the existing slug.
          return {
            requisitionId: input.requisitionId,
            status: "posted",
            publicSlug: row.publicSlug,
          };
        }
        if (row.status !== "approved") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Requisition is ${row.status}, not approved — only approved requisitions can be posted.`,
          });
        }

        // Human, collision-safe slug: slugified title + short suffix, retried
        // on the (tenant, public_slug) unique. Bounded attempts; the uuid
        // default already guarantees a working URL if we somehow exhaust them.
        const postedAt = new Date();
        let publicSlug = row.publicSlug;
        let posted = false;
        for (let attempt = 0; attempt < 5 && !posted; attempt++) {
          const candidateSlug = buildRequisitionSlug(row.title);
          try {
            const updated = await db
              .update(requisitions)
              .set({
                status: "posted",
                publicSlug: candidateSlug,
                postedAt,
                isPublic: true,
                updatedAt: postedAt,
              })
              .where(
                and(
                  eq(requisitions.tenantId, tenantId),
                  eq(requisitions.id, input.requisitionId),
                  eq(requisitions.status, "approved"),
                ),
              )
              .returning({ id: requisitions.id, publicSlug: requisitions.publicSlug });
            const updatedRow = updated[0];
            if (!updatedRow) {
              // Lost the approved→posted race (concurrent post). Re-read.
              const [now] = await db
                .select({ status: requisitions.status, publicSlug: requisitions.publicSlug })
                .from(requisitions)
                .where(
                  and(
                    eq(requisitions.tenantId, tenantId),
                    eq(requisitions.id, input.requisitionId),
                  ),
                )
                .limit(1);
              if (now?.status === "posted") {
                return {
                  requisitionId: input.requisitionId,
                  status: "posted",
                  publicSlug: now.publicSlug,
                };
              }
              throw new TRPCError({
                code: "CONFLICT",
                message: "Requisition is no longer approved.",
              });
            }
            publicSlug = updatedRow.publicSlug;
            posted = true;
          } catch (err) {
            if (isUniqueViolation(err)) {
              continue; // slug collision — try a fresh suffix
            }
            throw err;
          }
        }
        if (!posted) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not allocate a unique public slug for the requisition.",
          });
        }

        await db.insert(requisitionStateTransitions).values({
          tenantId,
          requisitionId: input.requisitionId,
          fromStatus: "approved",
          toStatus: "posted",
          transitionedBy: membershipId,
          reason: "Requisition posted — public apply page live",
          metadata: { public_slug: publicSlug },
        });

        return { requisitionId: input.requisitionId, status: "posted", publicSlug };
      });
    }),

  // ─────────── protected: application reads ───────────
  listApplications: protectedProcedure
    .input(listApplicationsInputSchema)
    .output(listApplicationsOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = requireDb(ctx);
      const limit = input.pagination.limit;
      const cursorDate = input.pagination.cursor ? new Date(input.pagination.cursor) : null;
      const conds = [
        ...(input.filters?.requisitionId
          ? [eq(applications.requisitionId, input.filters.requisitionId)]
          : []),
        ...(input.filters?.candidateId
          ? [eq(applications.candidateId, input.filters.candidateId)]
          : []),
        ...(input.filters?.stage ? [eq(applications.currentStage, input.filters.stage)] : []),
        ...(cursorDate ? [lt(applications.createdAt, cursorDate)] : []),
      ];
      const rows = await db
        .select()
        .from(applications)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(applications.createdAt))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const out = rows.slice(0, limit);
      return {
        rows: out.map((r) => ({
          id: r.id,
          requisitionId: r.requisitionId,
          candidateId: r.candidateId,
          stage: r.currentStage,
          source: r.source,
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor: hasMore ? lastCursor(out) : null,
      };
    }),

  // ─────────── protected: triage mutations (Module 1b) ───────────

  /**
   * Move an application forward. Caller-supplied targetStage so the UI
   * can advance to any legal next state (skipping intermediate states
   * isn't blocked at the DB; we'd add a state-machine validator if a
   * recruiter walked us through breaking it). Inserts a transition row;
   * returns the transitionId so the UI can store it for undo.
   */
  advanceApplication: protectedProcedure
    .input(advanceApplicationInputSchema)
    .output(advanceApplicationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("advance_application", ctx, input, async () => {
        const db = requireDb(ctx);
        return transitionApplicationStage(
          db,
          ctx,
          input.applicationId,
          input.targetStage,
          input.reason ?? null,
        );
      });
    }),

  /**
   * Reject an application — equivalent to advance(recruiter_rejected)
   * but with a separate audit action name so reports/dashboards can
   * distinguish "moved forward" from "ended".
   */
  rejectApplication: protectedProcedure
    .input(rejectApplicationInputSchema)
    .output(rejectApplicationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("reject_application", ctx, input, async () => {
        const db = requireDb(ctx);
        return transitionApplicationStage(
          db,
          ctx,
          input.applicationId,
          "recruiter_rejected",
          input.reason ?? null,
        );
      });
    }),

  /**
   * Undo for the most recent transition. Validates:
   *   - the named transition exists for this application
   *   - it's the MOST RECENT transition for the application
   *   - it happened within the last 30 seconds (toast is 5s; 30s
   *     allows network slack + paused-tab handling). Defensive — the
   *     UI never offers undo on older transitions, but the procedure
   *     refuses anyway so a curl from a stale window can't rewrite
   *     yesterday's history.
   *
   * Implementation: writes a NEW transition recording the revert
   * (from = original.to, to = original.from), then updates
   * applications.current_stage. The original transition row stays put
   * — audit honesty means we keep the forward step AND the revert
   * step, not pretend the forward never happened.
   */
  revertApplicationStage: protectedProcedure
    .input(revertApplicationStageInputSchema)
    .output(revertApplicationStageOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("revert_application_stage", ctx, input, async () => {
        const db = requireDb(ctx);

        const [original] = await db
          .select()
          .from(applicationStateTransitions)
          .where(eq(applicationStateTransitions.id, input.transitionId))
          .limit(1);
        if (!original || original.applicationId !== input.applicationId) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Transition not found" });
        }

        // Must be within the 30s undo window.
        const ageMs = Date.now() - original.transitionedAt.getTime();
        if (ageMs > 30_000) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Undo window expired (transition older than 30s)",
          });
        }

        // Must be the latest transition for this application — refuse
        // to "undo" a non-tail move (would corrupt the history).
        const [latest] = await db
          .select({ id: applicationStateTransitions.id })
          .from(applicationStateTransitions)
          .where(eq(applicationStateTransitions.applicationId, input.applicationId))
          .orderBy(desc(applicationStateTransitions.transitionedAt))
          .limit(1);
        if (!latest || latest.id !== input.transitionId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cannot undo — a newer transition has been recorded",
          });
        }

        if (original.fromStage === null) {
          // First-ever transition (application_received → ...). Reverting
          // would leave current_stage = null which the column rejects.
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cannot undo the first transition (no previous stage)",
          });
        }

        const membershipId = await resolveActorMembership(db, ctx);

        const [revertTx] = await db
          .insert(applicationStateTransitions)
          .values({
            tenantId: ctx.tenantId ?? "",
            applicationId: input.applicationId,
            fromStage: original.toStage,
            toStage: original.fromStage,
            actorMembershipId: membershipId,
            reason: `revert of ${input.transitionId}`,
            metadata: { revertedTransitionId: input.transitionId },
          })
          .returning({ id: applicationStateTransitions.id });

        await db
          .update(applications)
          .set({ currentStage: original.fromStage, stageEnteredAt: new Date() })
          .where(eq(applications.id, input.applicationId));

        if (!revertTx) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "revert insert returned no row",
          });
        }
        return {
          applicationId: input.applicationId,
          currentStage: original.fromStage,
          revertTransitionId: revertTx.id,
        };
      });
    }),

  // ─────────── protected: offers (Module 4) ───────────

  /**
   * Create a new offer row in 'drafted' state. Doesn't transition the
   * application — drafting is a recruiter-side action; the candidate
   * only learns about it on extendOffer.
   */
  draftOffer: protectedProcedure
    .input(draftOfferInputSchema)
    .output(draftOfferOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("draft_offer", ctx, input, async () => {
        const db = requireDb(ctx);

        const [app] = await db
          .select({ tenantId: applications.tenantId, currentStage: applications.currentStage })
          .from(applications)
          .where(eq(applications.id, input.applicationId))
          .limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        if (!OFFER_DRAFTABLE_STAGES.has(app.currentStage)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot draft offer from stage ${app.currentStage}`,
          });
        }

        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Drafting recruiter membership not found for this tenant",
          });
        }

        const expiryAt = new Date(Date.now() + input.expiryDays * 24 * 60 * 60 * 1000);

        const [created] = await db
          .insert(offers)
          .values({
            tenantId: app.tenantId,
            applicationId: input.applicationId,
            draftedByMembershipId: membershipId,
            baseSalaryInrPaise: BigInt(input.baseSalaryInrPaise),
            variableTargetInrPaise:
              input.variableTargetInrPaise !== undefined
                ? BigInt(input.variableTargetInrPaise)
                : null,
            joiningBonusInrPaise:
              input.joiningBonusInrPaise !== undefined ? BigInt(input.joiningBonusInrPaise) : null,
            joiningDate: input.joiningDate,
            location: input.location,
            termsHtml: input.termsHtml ?? null,
            expiryAt,
          })
          .returning({ id: offers.id });

        if (!created) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "offer insert returned no row",
          });
        }
        return { offerId: created.id };
      });
    }),

  /**
   * Move a drafted offer to 'extended' — generates the signed-link
   * token, stores its hash, transitions the application to
   * offer_drafted (the "we have an offer out" enum slot), and
   * enqueues the candidate.offer_extended email. Partial unique on
   * (tenant, application_id) WHERE status='extended' rejects a second
   * concurrent extend with 23505.
   */
  extendOffer: protectedProcedure
    .input(extendOfferInputSchema)
    .output(extendOfferOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("extend_offer", ctx, input, async () => {
        const db = requireDb(ctx);

        const [offer] = await db
          .select({
            id: offers.id,
            tenantId: offers.tenantId,
            applicationId: offers.applicationId,
            status: offers.status,
            expiryAt: offers.expiryAt,
            baseSalaryInrPaise: offers.baseSalaryInrPaise,
            joiningDate: offers.joiningDate,
            location: offers.location,
          })
          .from(offers)
          .where(eq(offers.id, input.offerId))
          .limit(1);
        if (!offer) throw new TRPCError({ code: "NOT_FOUND", message: "Offer not found" });
        if (offer.status !== "drafted") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Offer must be in 'drafted' status to extend (currently ${offer.status})`,
          });
        }

        // HROPS-02 — out-of-band governance gate. An offer whose base salary
        // exceeds the role's comp band max cannot be extended until an HR-head
        // approval_request (subject_type offer) for it is `approved`. This is a
        // deterministic server-side gate, not UI-only.
        const blockReason = await offerExtendBlockReason(
          db,
          offer.tenantId,
          offer.id,
          offer.baseSalaryInrPaise,
          offer.applicationId,
        );
        if (blockReason) {
          throw new TRPCError({ code: "BAD_REQUEST", message: blockReason });
        }

        const meta = await fetchOfferEmailContext(db, offer.applicationId);
        if (!meta) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "candidate email missing — cannot extend offer",
          });
        }

        const token = signLink({
          action: "candidate.accept_offer",
          subjectId: offer.id,
          expiresAt: offer.expiryAt,
        });
        const tokenHash = hashToken(token);
        const portalBase = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
        const acceptUrl = `${portalBase}/offer/${token}`;

        await db
          .update(offers)
          .set({
            status: "extended",
            extendedAt: new Date(),
            acceptSignedLinkTokenHash: tokenHash,
            updatedAt: new Date(),
          })
          .where(eq(offers.id, offer.id));

        // Transition the application to offer_drafted (the enum value
        // closest to "we have an outstanding offer"). When the candidate
        // accepts/declines, the accept route advances further.
        if (meta.currentStage !== "offer_drafted") {
          const membershipId = await resolveActorMembership(db, ctx);
          await db.insert(applicationStateTransitions).values({
            tenantId: offer.tenantId,
            applicationId: offer.applicationId,
            fromStage: meta.currentStage,
            toStage: "offer_drafted",
            actorMembershipId: membershipId,
            reason: `offer extended (offer_id=${offer.id})`,
          });
          await db
            .update(applications)
            .set({ currentStage: "offer_drafted", stageEnteredAt: new Date() })
            .where(eq(applications.id, offer.applicationId));
        }

        try {
          await enqueueNotification(db, {
            tenantId: offer.tenantId,
            recipientType: "candidate",
            recipientEmail: meta.candidateEmail,
            recipientCandidateId: meta.candidateId,
            templateKey: "candidate.offer_extended",
            templateData: {
              candidateName: meta.candidateName,
              companyName: meta.companyName,
              positionTitle: meta.positionTitle,
              joiningDate: offer.joiningDate,
              baseSalaryInrFormatted: formatPaiseAsInr(offer.baseSalaryInrPaise),
              location: offer.location,
              expiryAtFormatted: offer.expiryAt.toISOString().slice(0, 10),
              acceptUrl,
            },
            dedupKey: `offer_extended:${offer.id}`,
          });
        } catch (err) {
          ctx.log.warn(
            { err, request_id: ctx.requestId, offer_id: offer.id },
            "extendOffer: enqueueNotification failed",
          );
        }

        return { offerId: offer.id, signedLinkSentTo: meta.candidateEmail };
      });
    }),

  /**
   * Cancel a drafted or extended offer. The signed-link token is NOT
   * deleted (signed_link_uses is append-only); the protection is that
   * /api/offers/accept/:token checks the offer status before honouring
   * the click. If the offer was already extended, we transition the
   * application back to hr_round (the typical pre-offer stage). If the
   * recruiter wants to re-draft, they can.
   */
  cancelOffer: protectedProcedure
    .input(cancelOfferInputSchema)
    .output(cancelOfferOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("cancel_offer", ctx, input, async () => {
        const db = requireDb(ctx);

        const [offer] = await db
          .select({
            id: offers.id,
            tenantId: offers.tenantId,
            applicationId: offers.applicationId,
            status: offers.status,
          })
          .from(offers)
          .where(eq(offers.id, input.offerId))
          .limit(1);
        if (!offer) throw new TRPCError({ code: "NOT_FOUND", message: "Offer not found" });
        if (!["drafted", "extended"].includes(offer.status)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot cancel offer in status ${offer.status}`,
          });
        }

        const wasExtended = offer.status === "extended";

        await db
          .update(offers)
          .set({
            status: "cancelled",
            cancelledAt: new Date(),
            cancelledReason: input.reason,
            updatedAt: new Date(),
          })
          .where(eq(offers.id, offer.id));

        if (wasExtended) {
          const membershipId = await resolveActorMembership(db, ctx);
          await db.insert(applicationStateTransitions).values({
            tenantId: offer.tenantId,
            applicationId: offer.applicationId,
            fromStage: "offer_drafted",
            toStage: "hr_round",
            actorMembershipId: membershipId,
            reason: `offer cancelled (offer_id=${offer.id}): ${input.reason}`,
          });
          await db
            .update(applications)
            .set({ currentStage: "hr_round", stageEnteredAt: new Date() })
            .where(eq(applications.id, offer.applicationId));
        }

        return { offerId: offer.id };
      });
    }),

  listOffersByApplication: protectedProcedure
    .input(listOffersByApplicationInputSchema)
    .output(listOffersByApplicationOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = requireDb(ctx);
      const [app] = await db
        .select({ currentStage: applications.currentStage })
        .from(applications)
        .where(eq(applications.id, input.applicationId))
        .limit(1);
      if (!app) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
      }
      const rows = await db
        .select()
        .from(offers)
        .where(eq(offers.applicationId, input.applicationId))
        .orderBy(desc(offers.createdAt));
      return {
        applicationCurrentStage: app.currentStage,
        rows: rows.map((r) => ({
          id: r.id,
          applicationId: r.applicationId,
          status: r.status as
            | "drafted"
            | "extended"
            | "accepted"
            | "declined"
            | "expired"
            | "cancelled",
          baseSalaryInrPaise: Number(r.baseSalaryInrPaise),
          variableTargetInrPaise:
            r.variableTargetInrPaise !== null ? Number(r.variableTargetInrPaise) : null,
          joiningBonusInrPaise:
            r.joiningBonusInrPaise !== null ? Number(r.joiningBonusInrPaise) : null,
          joiningDate: r.joiningDate,
          location: r.location,
          expiryAt: r.expiryAt.toISOString(),
          extendedAt: r.extendedAt?.toISOString() ?? null,
          acceptedAt: r.acceptedAt?.toISOString() ?? null,
          declinedAt: r.declinedAt?.toISOString() ?? null,
          cancelledAt: r.cancelledAt?.toISOString() ?? null,
          declinedReason: r.declinedReason,
          termsHtml: r.termsHtml,
          contractType: r.contractType ?? null,
          probationMonths: r.probationMonths ?? null,
          benefits: Array.isArray(r.benefits)
            ? (r.benefits as unknown[]).filter((b): b is string => typeof b === "string")
            : [],
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }),

  // ─────────────────────── interviews (INT-02) ───────────────────────
  //
  // Interview scheduling: plan rounds on a requisition, schedule a
  // candidate's round with a panel, mint a candidate confirm signed link,
  // and enqueue the invitation email. Panel-side surfaces + scorecards are
  // INT-03/04. Flat naming per HANDOVER #31.

  upsertInterviewPlan: protectedProcedure
    .input(upsertInterviewPlanInputSchema)
    .output(upsertInterviewPlanOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only hiring managers, recruiters and admins can edit an interview plan.",
      );
      return withAudit("upsert_interview_plan", ctx, input, async () => {
        const db = requireDb(ctx);

        // Round numbers must be unique within the replace-set.
        const seen = new Set<number>();
        for (const r of input.rounds) {
          if (seen.has(r.roundNumber)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Duplicate round_number ${r.roundNumber} in the plan.`,
            });
          }
          seen.add(r.roundNumber);
        }

        const [req] = await db
          .select({ tenantId: requisitions.tenantId })
          .from(requisitions)
          .where(eq(requisitions.id, input.requisitionId))
          .limit(1);
        if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });

        // Validate every advisory default-panel membership is a real active
        // membership in this tenant before persisting the plan.
        const defaultPanelIds = [
          ...new Set(input.rounds.flatMap((r) => r.defaultPanelMembershipIds)),
        ];
        await assertActiveMemberships(ctx.sql, req.tenantId, defaultPanelIds);

        // Replace-set: drop the requisition's existing rounds, insert these.
        await db
          .delete(interviewPlans)
          .where(eq(interviewPlans.requisitionId, input.requisitionId));

        if (input.rounds.length > 0) {
          await db.insert(interviewPlans).values(
            input.rounds.map((r) => ({
              tenantId: req.tenantId,
              requisitionId: input.requisitionId,
              roundNumber: r.roundNumber,
              roundName: r.roundName,
              durationMinutes: r.durationMinutes,
              mode: r.mode,
              scorecardTemplate: r.scorecardTemplate,
              competencyFocus: r.competencyFocus,
              defaultPanelMembershipIds: r.defaultPanelMembershipIds,
            })),
          );
        }

        return { requisitionId: input.requisitionId, roundCount: input.rounds.length };
      });
    }),

  getInterviewPlan: protectedProcedure
    .input(getInterviewPlanInputSchema)
    .output(getInterviewPlanOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, REQUISITION_READ_ROLES, "You don't have access to interview plans.");
      const db = requireDb(ctx);
      const requisitionId = await resolveRequisitionId(db, input);
      const rows = await db
        .select()
        .from(interviewPlans)
        .where(eq(interviewPlans.requisitionId, requisitionId))
        .orderBy(interviewPlans.roundNumber);
      return {
        requisitionId,
        rounds: rows.map((r) => ({
          id: r.id,
          roundNumber: r.roundNumber,
          roundName: r.roundName,
          durationMinutes: r.durationMinutes,
          mode: r.mode as "video" | "onsite" | "phone",
          scorecardTemplate: r.scorecardTemplate as "technical" | "manager" | "hr" | "general",
          competencyFocus: Array.isArray(r.competencyFocus) ? (r.competencyFocus as string[]) : [],
          defaultPanelMembershipIds: r.defaultPanelMembershipIds ?? [],
        })),
      };
    }),

  listInterviewsByApplication: protectedProcedure
    .input(listInterviewsByApplicationInputSchema)
    .output(listInterviewsByApplicationOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, INTERVIEW_MANAGE_ROLES, "You don't have access to interviews.");
      const db = requireDb(ctx);
      const [app] = await db
        .select({ requisitionId: applications.requisitionId })
        .from(applications)
        .where(eq(applications.id, input.applicationId))
        .limit(1);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

      const rows = await selectInterviewRows(db, [
        eq(interviews.applicationId, input.applicationId),
      ]);
      return { requisitionId: app.requisitionId, rows };
    }),

  scheduleInterview: protectedProcedure
    .input(scheduleInterviewInputSchema)
    .output(scheduleInterviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only hiring managers, recruiters and admins can schedule interviews.",
      );
      return withAudit("schedule_interview", ctx, input, async () => {
        const db = requireDb(ctx);
        return doScheduleRound(db, ctx, input);
      });
    }),

  rescheduleInterview: protectedProcedure
    .input(rescheduleInterviewInputSchema)
    .output(rescheduleInterviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only hiring managers, recruiters and admins can reschedule interviews.",
      );
      return withAudit("reschedule_interview", ctx, input, async () => {
        const db = requireDb(ctx);

        const [app] = await db
          .select({ id: applications.id })
          .from(applications)
          .where(eq(applications.id, input.applicationId))
          .limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

        // Cancel the existing non-cancelled round first so the replacement
        // insert clears the partial-unique (one non-cancelled per round).
        const [existing] = await db
          .select({ id: interviews.id })
          .from(interviews)
          .where(
            and(
              eq(interviews.applicationId, input.applicationId),
              eq(interviews.roundNumber, input.roundNumber),
              dsql`${interviews.status} <> 'cancelled'`,
            ),
          )
          .limit(1);

        let cancelledInterviewId: string | null = null;
        if (existing) {
          await db
            .update(interviews)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(eq(interviews.id, existing.id));
          cancelledInterviewId = existing.id;
        }

        const created = await doScheduleRound(db, ctx, input);
        return { ...created, cancelledInterviewId };
      });
    }),

  cancelInterview: protectedProcedure
    .input(cancelInterviewInputSchema)
    .output(cancelInterviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only hiring managers, recruiters and admins can cancel interviews.",
      );
      return withAudit("cancel_interview", ctx, input, async () => {
        const db = requireDb(ctx);
        const [row] = await db
          .select({
            id: interviews.id,
            tenantId: interviews.tenantId,
            status: interviews.status,
            applicationId: interviews.applicationId,
            roundName: interviews.roundName,
          })
          .from(interviews)
          .where(eq(interviews.id, input.interviewId))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
        if (row.status === "cancelled") {
          return { interviewId: row.id };
        }
        await db
          .update(interviews)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(interviews.id, row.id));

        // POLISH-01 (Item B) — candidate-facing cancellation email (warm, no
        // meeting link, no CTA). Best-effort: an enqueue failure is logged, not
        // fatal — the cancel already committed. dedupKey keys on the interview
        // so a double-cancel doesn't double-send. NOTE: rescheduleInterview
        // does NOT reach here — its replacement round sends a fresh invitation
        // that already tells the candidate the new time, so a cancellation
        // notice there would contradict it.
        try {
          const meta = await fetchOfferEmailContext(db, row.applicationId);
          if (meta) {
            await enqueueNotification(db, {
              tenantId: row.tenantId,
              recipientType: "candidate",
              recipientEmail: meta.candidateEmail,
              recipientCandidateId: meta.candidateId,
              templateKey: "candidate.interview_cancelled",
              templateData: {
                candidateName: meta.candidateName,
                companyName: meta.companyName,
                positionTitle: meta.positionTitle,
                roundName: row.roundName,
              },
              dedupKey: `interview_cancelled:${row.id}`,
            });
          }
        } catch (err) {
          ctx.log.warn(
            { err, request_id: ctx.requestId, interview_id: row.id },
            "cancelInterview: enqueueNotification failed",
          );
        }
        return { interviewId: row.id };
      });
    }),

  listUpcomingInterviews: protectedProcedure
    .input(listUpcomingInterviewsInputSchema)
    .output(listUpcomingInterviewsOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, INTERVIEW_MANAGE_ROLES, "You don't have access to interviews.");
      const db = requireDb(ctx);
      const limit = input.limit;
      const decoded = decodeInterviewCursor(input.cursor);

      const conds = [
        ...(input.status ? [eq(interviews.status, input.status)] : []),
        ...(decoded
          ? [
              dsql`(${interviews.scheduledStart}, ${interviews.id}) < (${decoded.scheduledStart}::timestamptz, ${decoded.id}::uuid)`,
            ]
          : []),
      ];

      const rows = await selectInterviewRows(db, conds, limit + 1);
      const hasMore = rows.length > limit;
      const out = rows.slice(0, limit);
      const last = out[out.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeInterviewCursor(last.scheduledStart ?? new Date(0).toISOString(), last.id)
          : null;
      return { rows: out, nextCursor };
    }),

  // ─────────────────────── panel persona (INT-03) ───────────────────────
  //
  // The interviewer's surface: the interviews I'm on, a candidate brief per
  // interview, and ONE scorecard per interview (draft-capable, immutable once
  // submitted). Every procedure enforces panelist-membership on the specific
  // interview beyond the coarse persona gate. Completion / stage transitions
  // are INT-04 — nothing here flips interview status or application stage.

  listMyPanelInterviews: protectedProcedure
    .input(listMyPanelInterviewsInputSchema)
    .output(listMyPanelInterviewsOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, PANEL_SURFACE_ROLES, "This surface is for interview panellists.");
      const db = requireDb(ctx);
      const membershipId = await resolveActorMembership(db, ctx);
      // No membership in this tenant → no interviews (not an error). An admin
      // with no membership legitimately sees an empty panel list.
      if (!membershipId) return { rows: [] };

      const conds = [
        dsql`EXISTS (SELECT 1 FROM public.interview_panelists ip
             WHERE ip.interview_id = ${interviews.id}
               AND ip.membership_id = ${membershipId})`,
        ...(input.status ? [eq(interviews.status, input.status)] : []),
      ];
      const rows = await selectInterviewRows(db, conds, input.limit);

      // Decorate each row with MY feedback state (the panel chip is per-panelist;
      // here we want the caller's own state, not the whole panel's).
      const myStates = await fetchMyFeedbackStates(
        db,
        membershipId,
        rows.map((r) => r.id),
      );
      return {
        rows: rows.map((r) => ({
          ...r,
          myFeedbackState: myStates.get(r.id) ?? "none",
        })),
      };
    }),

  getPanelInterviewBrief: protectedProcedure
    .input(getPanelInterviewBriefInputSchema)
    .output(getPanelInterviewBriefOutputSchema)
    .query(async ({ ctx, input }): Promise<GetPanelInterviewBriefOutput> => {
      requireAnyRole(ctx, PANEL_SURFACE_ROLES, "This surface is for interview panellists.");
      return withAudit("get_panel_interview_brief", ctx, input, async () => {
        const db = requireDb(ctx);
        const membershipId = await resolveActorMembership(db, ctx);
        const isAdmin = ctx.roles.includes("admin");

        // The interview + candidate facet + role/plan, in one read.
        const [iv] = await db
          .select({
            id: interviews.id,
            applicationId: interviews.applicationId,
            requisitionId: interviews.requisitionId,
            roundNumber: interviews.roundNumber,
            roundName: interviews.roundName,
            status: interviews.status,
            mode: interviews.mode,
            scheduledStart: interviews.scheduledStart,
            scheduledEnd: interviews.scheduledEnd,
            durationMinutes: interviews.durationMinutes,
            meetingUrl: interviews.meetingUrl,
            candidateConfirmedAt: interviews.candidateConfirmedAt,
            // INT-04: prefer this snapshot over the live plan round below.
            scorecardTemplateSnapshot: interviews.scorecardTemplate,
            candidateId: applications.candidateId,
            currentStage: applications.currentStage,
            positionTitle: positions.title,
            candidateName: persons.fullName,
            locationCountry: persons.locationCountry,
            parsedSkills: candidates.parsedSkills,
            // PANEL-02: parsed YoE (experience card) + jd version (skills match).
            yearsOfExperience: candidates.yearsOfExperience,
            jdVersionId: requisitions.jdVersionId,
          })
          .from(interviews)
          .innerJoin(applications, eq(applications.id, interviews.applicationId))
          .innerJoin(candidates, eq(candidates.id, applications.candidateId))
          .innerJoin(persons, eq(persons.id, candidates.personId))
          .innerJoin(requisitions, eq(requisitions.id, interviews.requisitionId))
          .innerJoin(positions, eq(positions.id, requisitions.positionId))
          .where(eq(interviews.id, input.interviewId))
          .limit(1);
        if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });

        // ENFORCED: a panel_member who is not on THIS interview gets FORBIDDEN.
        // admin bypasses (super-role). This is the real authorisation boundary.
        const myPanelist = membershipId
          ? await findPanelistRow(db, input.interviewId, membershipId)
          : null;
        if (!isAdmin && !myPanelist) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a panellist on this interview.",
          });
        }

        // ADR-002 §7 — the brief reads candidate PII (name/location) + the
        // resume-derived skills, exactly the fields getCandidateById logs.
        // Mirror that record so the panel read is accountable too.
        if (ctx.tenantId) {
          recordPiiAccess({
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorMembershipId: membershipId,
            actorLabel: "user",
            entityType: "candidate",
            entityId: iv.candidateId,
            fieldsAccessed: [
              "persons.full_name",
              "persons.location_country",
              "candidates.parsed_skills",
            ],
            reason: "get_panel_interview_brief",
            requestId: ctx.requestId,
          });
        }

        // Plan round → competency focus (advisory display) is looked up live.
        // The scorecard TEMPLATE prefers the interview's snapshot (INT-04,
        // migration 0055) so a plan edit after scheduling can't drift the
        // criteria this panelist is scored against; the live plan round is the
        // fallback only for pre-snapshot rows.
        const [planRound] = await db
          .select({
            scorecardTemplate: interviewPlans.scorecardTemplate,
            competencyFocus: interviewPlans.competencyFocus,
          })
          .from(interviewPlans)
          .where(
            and(
              eq(interviewPlans.requisitionId, iv.requisitionId),
              eq(interviewPlans.roundNumber, iv.roundNumber),
            ),
          )
          .limit(1);
        const scorecardTemplate = (iv.scorecardTemplateSnapshot ??
          planRound?.scorecardTemplate ??
          "general") as "technical" | "manager" | "hr" | "general";
        const competencyFocus = Array.isArray(planRound?.competencyFocus)
          ? (planRound.competencyFocus as string[])
          : [];

        // Co-panelists (whole panel, self flagged).
        const panel = await fetchInterviewPanels(db, [input.interviewId]);
        const coPanelists = (panel.get(input.interviewId) ?? []).map((p) => ({
          membershipId: p.membershipId,
          name: p.name,
          isLead: p.isLead,
          isMe: membershipId != null && p.membershipId === membershipId,
        }));

        // Prior-round SUBMITTED feedback across OTHER interviews of the same
        // application — recommendation + strengths + concerns only. NO scores.
        const priorRoundFeedback = await fetchPriorRoundFeedback(
          db,
          iv.applicationId,
          input.interviewId,
        );

        // PANEL-02 — DETERMINISTIC Resume-vs-JD skills overlap (no AI). Pull
        // the requisition's JD skills and diff them against the parsed resume
        // skills with the pure helper (unit-tested in api-types).
        const parsedSkills = Array.isArray(iv.parsedSkills) ? (iv.parsedSkills as string[]) : [];
        const jdSkillRows = await db
          .select({
            skillName: jdSkills.skillName,
            weight: jdSkills.weight,
            isRequired: jdSkills.isRequired,
          })
          .from(jdSkills)
          .where(eq(jdSkills.jdVersionId, iv.jdVersionId));
        const skillsMatch = computeSkillsMatch(
          parsedSkills,
          jdSkillRows.map((s) => ({
            skillName: s.skillName,
            weight: Number(s.weight),
            isRequired: s.isRequired,
          })),
        );

        // My own feedback (hydrates the form). Criteria are always the full
        // template set; saved scores fill in where present.
        const myFeedbackRow = membershipId
          ? await findMyFeedbackRow(db, input.interviewId, membershipId)
          : null;
        const savedScores: Record<string, number> =
          myFeedbackRow && myFeedbackRow.scorecard && typeof myFeedbackRow.scorecard === "object"
            ? (myFeedbackRow.scorecard as Record<string, number>)
            : {};
        const criteria = scorecardCriteriaFor(scorecardTemplate).map((c) => {
          const saved = savedScores[c.key];
          return {
            key: c.key,
            label: c.label,
            score: typeof saved === "number" ? saved : null,
          };
        });

        return {
          interview: {
            id: iv.id,
            applicationId: iv.applicationId,
            roundNumber: iv.roundNumber,
            roundName: iv.roundName,
            status: iv.status as "scheduled" | "completed" | "cancelled" | "no_show",
            mode: iv.mode as "video" | "onsite" | "phone",
            scheduledStart: toIsoString(iv.scheduledStart),
            scheduledEnd: toIsoString(iv.scheduledEnd),
            durationMinutes: iv.durationMinutes,
            meetingUrl: iv.meetingUrl,
            candidateConfirmedAt: toIsoString(iv.candidateConfirmedAt),
            positionTitle: iv.positionTitle,
          },
          candidate: {
            candidateId: iv.candidateId,
            name: iv.candidateName,
            currentStage: iv.currentStage,
            locationCountry: iv.locationCountry,
            parsedSkills,
            yearsOfExperience: iv.yearsOfExperience != null ? Number(iv.yearsOfExperience) : null,
          },
          round: { scorecardTemplate, competencyFocus },
          skillsMatch,
          coPanelists,
          priorRoundFeedback,
          myFeedback: {
            state: deriveFeedbackState(
              myFeedbackRow?.id ?? null,
              myFeedbackRow?.submittedAt ?? null,
            ),
            criteria,
            strengths: myFeedbackRow?.strengths ?? null,
            concerns: myFeedbackRow?.concerns ?? null,
            notes: myFeedbackRow?.notes ?? null,
            recommendation:
              (myFeedbackRow?.recommendation as "strong_yes" | "yes" | "hold" | "no" | null) ??
              null,
            submittedAt: toIsoString(myFeedbackRow?.submittedAt ?? null),
          },
        };
      });
    }),

  saveInterviewFeedback: protectedProcedure
    .input(saveInterviewFeedbackInputSchema)
    .output(saveInterviewFeedbackOutputSchema)
    .mutation(async ({ ctx, input }): Promise<SaveInterviewFeedbackOutput> => {
      requireAnyRole(ctx, PANEL_SURFACE_ROLES, "This surface is for interview panellists.");
      return withAudit("save_interview_feedback", ctx, input, async () => {
        const db = requireDb(ctx);
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a panellist on this interview.",
          });
        }

        // The interview + its tenant + plan round (for the template).
        const [iv] = await db
          .select({
            tenantId: interviews.tenantId,
            requisitionId: interviews.requisitionId,
            roundNumber: interviews.roundNumber,
            scorecardTemplateSnapshot: interviews.scorecardTemplate,
          })
          .from(interviews)
          .where(eq(interviews.id, input.interviewId))
          .limit(1);
        if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });

        // ENFORCED: caller must be a panelist on THIS interview (writes are
        // never admin-on-behalf — only the interviewer authors their scorecard).
        const myPanelist = await findPanelistRow(db, input.interviewId, membershipId);
        if (!myPanelist) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a panellist on this interview.",
          });
        }

        // Validate the scorecard against the round template's criteria set:
        // every key must be known, every value an integer 1..5 (zod already
        // enforced the range; here we reject unknown/extra keys). Prefer the
        // interview's SNAPSHOT template (INT-04, migration 0055) so a plan edit
        // after scheduling can't change the criteria a panelist is validated
        // against mid-loop; the live plan round is only a pre-snapshot fallback.
        const [planRound] = await db
          .select({ scorecardTemplate: interviewPlans.scorecardTemplate })
          .from(interviewPlans)
          .where(
            and(
              eq(interviewPlans.requisitionId, iv.requisitionId),
              eq(interviewPlans.roundNumber, iv.roundNumber),
            ),
          )
          .limit(1);
        const template = iv.scorecardTemplateSnapshot ?? planRound?.scorecardTemplate ?? "general";
        const validKeys = new Set(scorecardCriteriaFor(template).map((c) => c.key));
        const badKeys = Object.keys(input.scorecard).filter((k) => !validKeys.has(k));
        if (badKeys.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Unknown scorecard criteria for the '${template}' template: ${badKeys.join(", ")}`,
          });
        }

        // Immutability: once submitted, the row is frozen. Any further save —
        // draft or submit — is a CONFLICT.
        const existing = await findMyFeedbackRow(db, input.interviewId, membershipId);
        if (existing?.submittedAt) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Your feedback has been submitted and can no longer be edited.",
          });
        }

        const isSubmit = input.action === "submit";
        if (isSubmit && !input.recommendation) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A recommendation is required to submit your scorecard.",
          });
        }
        // PANEL-01: detailed notes are mandatory on submit (additive to the
        // existing recommendation gate). Draft saves are unaffected.
        if (isSubmit && !input.notes?.trim()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Add detailed notes before submitting your scorecard.",
          });
        }

        const now = new Date();
        const values = {
          scorecard: input.scorecard,
          strengths: input.strengths ?? null,
          concerns: input.concerns ?? null,
          notes: input.notes ?? null,
          recommendation: input.recommendation ?? null,
          submittedAt: isSubmit ? now : null,
          updatedAt: now,
        };

        if (existing) {
          await db
            .update(interviewFeedback)
            .set(values)
            .where(eq(interviewFeedback.id, existing.id));
        } else {
          await db.insert(interviewFeedback).values({
            tenantId: iv.tenantId,
            interviewId: input.interviewId,
            membershipId,
            ...values,
          });
        }

        return {
          interviewId: input.interviewId,
          state: isSubmit ? ("submitted" as const) : ("draft" as const),
          submittedAt: isSubmit ? now.toISOString() : null,
        };
      });
    }),

  // ─────────────────── PANEL-01 — panel-member workboard ───────────────────
  //
  // getPanelDashboard powers the panel dashboard (hero stat strip + urgent
  // banner + overdue nudge), the /panel/feedback queue, and the /panel/history
  // table in one aggregate read. Every number is computed from the caller's OWN
  // interviews + submitted scorecards, RLS + membership scoped to "me".
  getPanelDashboard: protectedProcedure
    .output(getPanelDashboardOutputSchema)
    .query(async ({ ctx }): Promise<GetPanelDashboardOutput> => {
      requireAnyRole(ctx, PANEL_SURFACE_ROLES, "This surface is for interview panellists.");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const membershipId = await resolveActorMembership(db, ctx);
      // No membership (e.g. an admin with none) → an empty, honest board.
      if (!membershipId) {
        return {
          stats: {
            todayInterviews: 0,
            pendingFeedback: 0,
            avgScoreGiven: null,
            completedToday: 0,
            inWindowNow: 0,
          },
          pending: [],
          submitted: [],
        };
      }
      return buildPanelDashboard(db, ctx.tenantId, membershipId);
    }),

  // summarizeMyFeedbackNotes — the "Summarise my notes" AI assist (feature
  // feedback_summary). Tidies the panellist's OWN draft text and returns it
  // into the editable fields; nothing is persisted or submitted here. Kill-
  // switchable, cost-logged, audited. panel_member + admin (panellist-on-this-
  // interview enforced, exactly like saveInterviewFeedback).
  summarizeMyFeedbackNotes: protectedProcedure
    .input(summarizeMyFeedbackNotesInputSchema)
    .output(summarizeMyFeedbackNotesOutputSchema)
    .mutation(async ({ ctx, input }): Promise<SummarizeMyFeedbackNotesOutput> => {
      requireAnyRole(ctx, PANEL_SURFACE_ROLES, "This surface is for interview panellists.");
      return withAudit(
        "summarize_my_feedback_notes",
        ctx,
        { interviewId: input.interviewId },
        async () => {
          const db = requireDb(ctx);
          if (!ctx.tenantId) {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
          }
          const tenantId = ctx.tenantId;
          const membershipId = await resolveActorMembership(db, ctx);
          if (!membershipId) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You are not a panellist on this interview.",
            });
          }
          // Enforce panellist-on-this-interview (writes/assists are never
          // admin-on-behalf — only the interviewer's own notes are summarised).
          const myPanelist = await findPanelistRow(db, input.interviewId, membershipId);
          if (!myPanelist) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "You are not a panellist on this interview.",
            });
          }

          // Kill-switch — disabled → clean error, no model call, no usage log.
          const aiSettings = await resolveTenantAiSettingsDb(tenantId);
          const featureSettings = aiSettings.feedback_summary;
          if (!featureSettings.enabled) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Note summarising is disabled for this tenant. An admin can re-enable it in Admin → AI settings.",
            });
          }

          const { system, user } = buildFeedbackSummaryPrompt({
            strengths: input.strengths ?? null,
            concerns: input.concerns ?? null,
            notes: input.notes ?? null,
          });
          const client = await getAIClient(tenantId);
          const raw = await client.completeStructured<FeedbackSummary>({
            prompt: user,
            system,
            model: featureSettings.model,
            temperature: featureSettings.temperature,
            maxTokens: featureSettings.maxTokens,
            schema: feedbackSummaryJsonSchema,
            schemaName: FEEDBACK_SUMMARY_SCHEMA_NAME,
            feature: FEEDBACK_SUMMARY_FEATURE,
            requestId: ctx.requestId,
            actorMembershipId: membershipId,
          });
          const parsed = feedbackSummarySchema.parse(raw);
          return { summary: parsed };
        },
      );
    }),

  // ─────────────────── real-AI interview prep (PANEL-02) ───────────────────
  //
  // Suggested "areas to probe" + probing questions for one interview, grounded
  // ONLY in the JD + skills, the parsed resume, prior-round recommendations +
  // qualitative text (NEVER scores), and the round objective. Same feasibility
  // pattern as req_feasibility / comp_recommendation: cached per interview,
  // regenerate replaces, cost-logged, kill-switchable. Access is the panel
  // boundary — a panelist ON this interview, or an admin.

  /** getInterviewPrep — the cached prep card (read after a generate, or a deep
   * link). Panelist-on-this-interview + admin. No AI call. Also reports whether
   * the per-tenant kill-switch is on so the UI can render an honest state. */
  getInterviewPrep: protectedProcedure
    .input(getInterviewPrepInputSchema)
    .output(getInterviewPrepOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, PANEL_SURFACE_ROLES, "This surface is for interview panellists.");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const membershipId = await resolveActorMembership(db, ctx);
      const isAdmin = ctx.roles.includes("admin");

      // Interview must exist (RLS scopes to tenant) + caller must be on it.
      const [iv] = await db
        .select({ id: interviews.id })
        .from(interviews)
        .where(eq(interviews.id, input.interviewId))
        .limit(1);
      if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
      const myPanelist = membershipId
        ? await findPanelistRow(db, input.interviewId, membershipId)
        : null;
      if (!isAdmin && !myPanelist) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not a panellist on this interview.",
        });
      }

      const aiSettings = await resolveTenantAiSettingsDb(ctx.tenantId);
      const [stored] = await db
        .select()
        .from(interviewPrep)
        .where(
          and(
            eq(interviewPrep.tenantId, ctx.tenantId),
            eq(interviewPrep.interviewId, input.interviewId),
          ),
        )
        .limit(1);

      return {
        prep: stored ? storedInterviewPrepToCard(stored) : null,
        aiEnabled: aiSettings.interview_prep.enabled,
      };
    }),

  /** generateInterviewPrep — the ONE real AI call per click. Builds a grounded
   * prompt (JD + skills, parsed resume, prior-round recommendations +
   * qualitative text — NO scores, round objective), calls Claude via
   * completeStructured (feature interview_prep, cost-logged), and upserts the
   * prep (regenerate replaces). Panelist-on-this-interview + admin, audited.
   * Honours the CONF-01 per-tenant interview_prep kill-switch. */
  generateInterviewPrep: protectedProcedure
    .input(generateInterviewPrepInputSchema)
    .output(generateInterviewPrepOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("generate_interview_prep", ctx, input, async () => {
        requireAnyRole(ctx, PANEL_SURFACE_ROLES, "This surface is for interview panellists.");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a panellist on this interview.",
          });
        }
        const isAdmin = ctx.roles.includes("admin");

        // The interview + candidate facet + jd version, in one read.
        const [iv] = await db
          .select({
            id: interviews.id,
            applicationId: interviews.applicationId,
            requisitionId: interviews.requisitionId,
            roundNumber: interviews.roundNumber,
            roundName: interviews.roundName,
            scorecardTemplateSnapshot: interviews.scorecardTemplate,
            positionTitle: positions.title,
            candidateName: persons.fullName,
            parsedSkills: candidates.parsedSkills,
            yearsOfExperience: candidates.yearsOfExperience,
            jdVersionId: requisitions.jdVersionId,
            jdText: jdVersions.jdText,
          })
          .from(interviews)
          .innerJoin(applications, eq(applications.id, interviews.applicationId))
          .innerJoin(candidates, eq(candidates.id, applications.candidateId))
          .innerJoin(persons, eq(persons.id, candidates.personId))
          .innerJoin(requisitions, eq(requisitions.id, interviews.requisitionId))
          .innerJoin(positions, eq(positions.id, requisitions.positionId))
          .innerJoin(jdVersions, eq(jdVersions.id, requisitions.jdVersionId))
          .where(eq(interviews.id, input.interviewId))
          .limit(1);
        if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });

        // ENFORCED: caller must be a panelist on THIS interview (or admin).
        const myPanelist = await findPanelistRow(db, input.interviewId, membershipId);
        if (!isAdmin && !myPanelist) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a panellist on this interview.",
          });
        }

        // CONF-01 kill-switch — disabled → clean error, no model call, no log.
        const aiSettings = await resolveTenantAiSettingsDb(tenantId);
        const prepSettings = aiSettings.interview_prep;
        if (!prepSettings.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Interview prep is disabled for this tenant. An admin can re-enable it in Admin → AI settings.",
          });
        }

        // Round objective (competency focus) from the plan round; JD skills.
        const [planRound] = await db
          .select({ competencyFocus: interviewPlans.competencyFocus })
          .from(interviewPlans)
          .where(
            and(
              eq(interviewPlans.requisitionId, iv.requisitionId),
              eq(interviewPlans.roundNumber, iv.roundNumber),
            ),
          )
          .limit(1);
        const competencyFocus = Array.isArray(planRound?.competencyFocus)
          ? (planRound.competencyFocus as string[])
          : [];

        const jdSkillRows = await db
          .select({ skillName: jdSkills.skillName, isRequired: jdSkills.isRequired })
          .from(jdSkills)
          .where(eq(jdSkills.jdVersionId, iv.jdVersionId));

        // Prior-round qualitative signal — recommendation + text, NO scores.
        const priorRounds = await fetchPriorRoundFeedback(db, iv.applicationId, input.interviewId);

        const { system, user } = buildInterviewPrepPrompt({
          candidateName: iv.candidateName,
          roleTitle: iv.positionTitle,
          roundName: iv.roundName,
          competencyFocus,
          jdText: iv.jdText,
          skills: jdSkillRows.map((s) => ({ skillName: s.skillName, isRequired: s.isRequired })),
          parsedResumeSkills: Array.isArray(iv.parsedSkills) ? (iv.parsedSkills as string[]) : [],
          yearsOfExperience: iv.yearsOfExperience != null ? Number(iv.yearsOfExperience) : null,
          priorRounds: priorRounds.map((p) => ({
            roundNumber: p.roundNumber,
            roundName: p.roundName,
            recommendation: p.recommendation,
            strengths: p.strengths,
            concerns: p.concerns,
          })),
        });

        const client = await getAIClient(tenantId);
        const raw = await client.completeStructured<InterviewPrepAi>({
          prompt: user,
          system,
          model: prepSettings.model,
          temperature: prepSettings.temperature,
          maxTokens: prepSettings.maxTokens,
          schema: interviewPrepAiJsonSchema,
          schemaName: INTERVIEW_PREP_SCHEMA_NAME,
          feature: INTERVIEW_PREP_FEATURE,
          requestId: ctx.requestId,
          actorMembershipId: membershipId,
        });
        // Trust-but-verify: re-parse so a provider quirk can't smuggle a bad
        // shape into the DB.
        const prep = interviewPrepAiSchema.parse(raw);

        const now = new Date();
        await db
          .insert(interviewPrep)
          .values({
            tenantId,
            interviewId: input.interviewId,
            focusAreas: prep.focusAreas,
            probingQuestions: prep.probingQuestions,
            model: client.provider,
            promptVersion: INTERVIEW_PREP_PROMPT_VERSION,
            generatedByMembershipId: membershipId,
          })
          .onConflictDoUpdate({
            target: [interviewPrep.tenantId, interviewPrep.interviewId],
            set: {
              focusAreas: prep.focusAreas,
              probingQuestions: prep.probingQuestions,
              model: client.provider,
              promptVersion: INTERVIEW_PREP_PROMPT_VERSION,
              generatedByMembershipId: membershipId,
              updatedAt: now,
            },
          });

        return {
          prep: {
            focusAreas: prep.focusAreas,
            probingQuestions: prep.probingQuestions,
            model: client.provider,
            promptVersion: INTERVIEW_PREP_PROMPT_VERSION,
            generatedAt: now.toISOString(),
          },
        };
      });
    }),

  // ─────────────────── interview completion (INT-04) ───────────────────
  //
  // Closes the loop: complete an interview (default gate = every panelist
  // submitted; force+reason is the no-show escape hatch), advance the
  // application via the EXISTING stage-transition discipline (human-in-the-loop,
  // never silent), and give recruiters the full decision picture the panel
  // brief hides. Recruiter / hiring_manager / admin — NOT the panel.

  completeInterview: protectedProcedure
    .input(completeInterviewInputSchema)
    .output(completeInterviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only recruiters, hiring managers and admins can complete an interview.",
      );
      return withAudit("complete_interview", ctx, input, async () => {
        const db = requireDb(ctx);

        const [iv] = await db
          .select({
            id: interviews.id,
            status: interviews.status,
            scorecardTemplate: interviews.scorecardTemplate,
          })
          .from(interviews)
          .where(eq(interviews.id, input.interviewId))
          .limit(1);
        if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
        if (iv.status !== "scheduled") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Interview is ${iv.status} and can't be completed.`,
          });
        }

        // Full-submission is the default gate: every panelist must have
        // submitted their scorecard. A no-panel interview (count 0) also fails
        // the gate — completing it needs the explicit force path.
        const [counts] = await db
          .select({
            panelistCount: dsql<number>`count(*)::int`,
            submittedCount: dsql<number>`count(${interviewFeedback.submittedAt})::int`,
          })
          .from(interviewPanelists)
          .leftJoin(
            interviewFeedback,
            and(
              eq(interviewFeedback.interviewId, interviewPanelists.interviewId),
              eq(interviewFeedback.membershipId, interviewPanelists.membershipId),
            ),
          )
          .where(eq(interviewPanelists.interviewId, input.interviewId));
        const panelistCount = counts?.panelistCount ?? 0;
        const submittedCount = counts?.submittedCount ?? 0;
        const allSubmitted = panelistCount > 0 && submittedCount === panelistCount;

        if (!allSubmitted) {
          if (!input.force) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `Not every panelist has submitted (${submittedCount}/${panelistCount}). Pass force + a reason to complete anyway.`,
            });
          }
          if (!input.reason || input.reason.trim().length === 0) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "A reason is required to force-complete before all panelists have submitted.",
            });
          }
        }

        await db
          .update(interviews)
          .set({ status: "completed", updatedAt: new Date() })
          .where(eq(interviews.id, input.interviewId));

        const stageCtx = interviewStageContext(iv.scorecardTemplate);
        return {
          interviewId: input.interviewId,
          status: "completed" as const,
          forced: !allSubmitted,
          panelistCount,
          submittedCount,
          belongsToStage: stageCtx.belongsToStage,
          suggestedNextStage: stageCtx.suggestedNextStage,
        };
      });
    }),

  markInterviewNoShow: protectedProcedure
    .input(markInterviewNoShowInputSchema)
    .output(markInterviewNoShowOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only recruiters, hiring managers and admins can mark an interview no-show.",
      );
      return withAudit("mark_interview_no_show", ctx, input, async () => {
        const db = requireDb(ctx);
        const [iv] = await db
          .select({ id: interviews.id, status: interviews.status })
          .from(interviews)
          .where(eq(interviews.id, input.interviewId))
          .limit(1);
        if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
        if (iv.status !== "scheduled") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Interview is ${iv.status} and can't be marked no-show.`,
          });
        }
        await db
          .update(interviews)
          .set({ status: "no_show", updatedAt: new Date() })
          .where(eq(interviews.id, input.interviewId));
        return { interviewId: input.interviewId, status: "no_show" as const };
      });
    }),

  // POLISH-01 (Item C) — reopen a submitted panelist scorecard. Recruiter /
  // hiring_manager / admin only (the coarse INTERVIEW_MANAGE_ROLES gate already
  // excludes panel_member); an extra guard forbids reopening YOUR OWN scorecard
  // even if you also hold a manage role — un-submitting your own to re-edit it
  // must be someone else's deliberate act, for audit integrity. Clearing
  // submitted_at returns the feedback to `draft`: the panel scorecard becomes
  // editable again (PanelInterviewBrief keys read-only off state === 'submitted')
  // and saveInterviewFeedback's immutability guard (submittedAt truthy) passes,
  // so the panelist can resubmit. CONFLICT if the interview is already completed
  // — reopening after the completion decision would corrupt its basis. Notifies
  // nobody this ticket. Reason is required and rides into the audit row.
  reopenInterviewFeedback: protectedProcedure
    .input(reopenInterviewFeedbackInputSchema)
    .output(reopenInterviewFeedbackOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only recruiters, hiring managers and admins can reopen a scorecard.",
      );
      return withAudit("reopen_interview_feedback", ctx, input, async () => {
        const db = requireDb(ctx);

        const [iv] = await db
          .select({ id: interviews.id, status: interviews.status })
          .from(interviews)
          .where(eq(interviews.id, input.interviewId))
          .limit(1);
        if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
        if (iv.status === "completed") {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This interview is completed. Reopening a scorecard now would corrupt the decision it was based on.",
          });
        }

        // The panelist may not reopen their OWN scorecard (see header). An admin
        // with no membership in this tenant resolves to null and is fine — they
        // can never match the target membership.
        const actorMembershipId = await resolveActorMembership(db, ctx);
        if (actorMembershipId && actorMembershipId === input.membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can't reopen your own scorecard — ask another recruiter or an admin.",
          });
        }

        const [fb] = await db
          .select({ id: interviewFeedback.id, submittedAt: interviewFeedback.submittedAt })
          .from(interviewFeedback)
          .where(
            and(
              eq(interviewFeedback.interviewId, input.interviewId),
              eq(interviewFeedback.membershipId, input.membershipId),
            ),
          )
          .limit(1);
        if (!fb) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "No scorecard for that panelist on this interview.",
          });
        }
        if (!fb.submittedAt) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "That scorecard isn't submitted, so there's nothing to reopen.",
          });
        }

        // Clear submitted_at only — the scores / recommendation stay as draft
        // data so the panelist edits rather than re-enters from scratch.
        await db
          .update(interviewFeedback)
          .set({ submittedAt: null, updatedAt: new Date() })
          .where(eq(interviewFeedback.id, fb.id));

        return {
          interviewId: input.interviewId,
          membershipId: input.membershipId,
          state: "draft" as const,
        };
      });
    }),

  advanceApplicationAfterInterview: protectedProcedure
    .input(advanceApplicationAfterInterviewInputSchema)
    .output(advanceApplicationAfterInterviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only recruiters, hiring managers and admins can advance the application.",
      );
      return withAudit("advance_application_after_interview", ctx, input, async () => {
        const db = requireDb(ctx);

        const [iv] = await db
          .select({
            id: interviews.id,
            status: interviews.status,
            applicationId: interviews.applicationId,
            scorecardTemplate: interviews.scorecardTemplate,
          })
          .from(interviews)
          .where(eq(interviews.id, input.interviewId))
          .limit(1);
        if (!iv) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
        if (iv.status !== "completed") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Complete the interview before advancing the application.",
          });
        }

        const stageCtx = interviewStageContext(iv.scorecardTemplate);
        if (!stageCtx.suggestedNextStage) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `No forward stage defined for an interview in ${stageCtx.belongsToStage}.`,
          });
        }

        const [app] = await db
          .select({ currentStage: applications.currentStage })
          .from(applications)
          .where(eq(applications.id, iv.applicationId))
          .limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        // Only advance FROM the stage this interview belongs to — never skip a
        // stage or double-advance a candidate already moved on.
        if (app.currentStage !== stageCtx.belongsToStage) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `This interview belongs to the ${stageCtx.belongsToStage} stage but the application is at ${app.currentStage}.`,
          });
        }

        // Roll-up (counts + lead rec) written into the transition metadata so
        // the append-only history records WHY the stage advanced.
        const summary = await fetchInterviewDecisionSummary(db, input.interviewId);
        const metadata = {
          source: "advance_application_after_interview",
          interviewId: input.interviewId,
          roundNumber: summary?.roundNumber ?? null,
          rollup: summary?.rollup ?? null,
        };

        return transitionApplicationStage(
          db,
          ctx,
          iv.applicationId,
          stageCtx.suggestedNextStage,
          input.reason ?? null,
          metadata,
        );
      });
    }),

  getInterviewDecisionSummary: protectedProcedure
    .input(getInterviewDecisionSummaryInputSchema)
    .output(getInterviewDecisionSummaryOutputSchema)
    .query(async ({ ctx, input }): Promise<GetInterviewDecisionSummaryOutput> => {
      requireAnyRole(
        ctx,
        INTERVIEW_MANAGE_ROLES,
        "Only recruiters, hiring managers and admins can view the decision summary.",
      );
      const db = requireDb(ctx);
      const summary = await fetchInterviewDecisionSummary(db, input.interviewId);
      if (!summary) throw new TRPCError({ code: "NOT_FOUND", message: "Interview not found" });
      return summary;
    }),

  // ─────────── protected: integration health (admin) ───────────

  listWorkdaySyncs: protectedProcedure
    .input(listWorkdaySyncsInputSchema)
    .output(listWorkdaySyncsOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "Integration health is admin-only");
      const db = requireDb(ctx);
      const limit = input.pagination.limit;
      const cursorDate = input.pagination.cursor ? new Date(input.pagination.cursor) : null;
      const conds = [
        ...(input.filters?.status ? [eq(workdaySyncOutbox.status, input.filters.status)] : []),
        ...(input.filters?.eventType
          ? [eq(workdaySyncOutbox.eventType, input.filters.eventType)]
          : []),
        ...(cursorDate ? [lt(workdaySyncOutbox.createdAt, cursorDate)] : []),
      ];
      const rows = await db
        .select()
        .from(workdaySyncOutbox)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(workdaySyncOutbox.createdAt))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const out = rows.slice(0, limit);
      return {
        rows: out.map((r) => ({
          id: r.id,
          eventType: r.eventType,
          businessKey: r.businessKey,
          status: r.status,
          subjectApplicationId: r.subjectApplicationId,
          attemptCount: r.attemptCount,
          lastError: r.lastError,
          simulatedAt: r.simulatedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          payload: r.payload,
          simulatedResponse: r.simulatedResponse,
        })),
        nextCursor: hasMore ? lastCursor(out) : null,
      };
    }),

  // ─────────────────────── agents (AGENT-02) ───────────────────────
  //
  // Follow-Up Agent CRUD. AGENT-02 ships create + list only; update /
  // retire / toggle land in AGENT-04. Scheduling + Candidate-Q&A get
  // their own procedures (also AGENT-04). Flat naming per HANDOVER #31.

  createFollowUpAgent: protectedProcedure
    .input(createFollowUpAgentInputSchema)
    .output(createFollowUpAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("create_follow_up_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId || !ctx.userId) {
          // protectedProcedure guarantees this, but the types don't narrow.
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId/userId",
          });
        }
        const tenantId = ctx.tenantId;

        // Resolve actor's membership for created_by FK.
        const [membership] = await db
          .select({ id: tenantUserMemberships.id })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.userId, ctx.userId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!membership) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "actor membership not resolved",
          });
        }

        // All inserts run inside protectedProcedure's tenant-scoped tx —
        // any throw rolls back the partial agent. Sequential is fine.

        // AGENT-04a #102 retrofit: INSERT ... ON CONFLICT DO NOTHING
        // RETURNING id, infer against the partial-unique index
        // `(tenant_id, name) WHERE retired_at IS NULL`. Empty result
        // means a concurrent active agent already holds this name —
        // map to BAD_REQUEST. This replaces the prior SELECT-pre-check
        // which had a race window (HANDOVER #102 canonical pattern).
        const agentInsert = await db
          .insert(automationAgents)
          .values({
            tenantId,
            agentType: "follow_up",
            name: input.name,
            description: input.description ?? null,
            enabled: true,
            version: 1,
            createdBy: membership.id,
          })
          .onConflictDoNothing({
            target: [automationAgents.tenantId, automationAgents.name],
            // Drizzle 0.45's `where` here is the partial-index inference
            // clause (matches the partial UNIQUE INDEX predicate
            // `WHERE retired_at IS NULL`). Renamed to `targetWhere` in
            // newer Drizzle versions.
            where: dsql`retired_at IS NULL`,
          })
          .returning({ id: automationAgents.id });
        if (agentInsert.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `An active agent named "${input.name}" already exists`,
          });
        }
        const agentRow = agentInsert[0];
        if (!agentRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "automation_agents insert returned no row",
          });
        }
        const agentId = agentRow.id;

        // Trigger: stage_stale, days_threshold + stage from input.
        await db.insert(agentTriggers).values({
          tenantId,
          agentId,
          triggerType: "stage_stale",
          // jsonb stored WITHOUT the `type` field — column action_type
          // is the source of truth; bridgeActionConfig prepends type at
          // read time. Same convention for trigger_config.
          triggerConfig: {
            stage: input.stage,
            days_threshold: input.days_threshold,
          },
        });

        // Curated defaults: action 1 drafts, action 2 sends.
        const [draftAction] = await db
          .insert(agentActions)
          .values({
            tenantId,
            agentId,
            actionOrder: 1,
            actionType: "draft_message",
            actionConfig: {
              template_prompt_id: "follow_up_v1",
              tone: input.tone,
              max_tokens: input.max_tokens,
            },
          })
          .returning({ id: agentActions.id });
        const [sendAction] = await db
          .insert(agentActions)
          .values({
            tenantId,
            agentId,
            actionOrder: 2,
            actionType: "send_message",
            actionConfig: {
              channel: "email",
              outbox_kind: "agent_followup",
              // False since FOLLOWUP-01 — the gate lives on draft_message.
              requires_approval: false,
            },
          })
          .returning({ id: agentActions.id });
        if (!draftAction || !sendAction) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "agent_actions insert returned no row",
          });
        }

        // Approval rules — the recruiter approves the DRAFT, and the send
        // that follows is autonomous. FOLLOWUP-01 swapped this: the gate
        // used to sit on send_message, but the drain executes an action
        // and only THEN evaluates the gate, resuming without re-executing
        // once approved. A gated send would therefore have enqueued the
        // email before the human ever saw it. draft_message is pure, so
        // gating it is sound: on approval the recruiter's edited text
        // lands in agent_run_actions.output and send_message — which has
        // not run yet — reads it on resume.
        //
        // CHECK constraint enforces (approval_mode='auto') = (approver_role
        // IS NULL). The #30 guard (assertRuleAttachable) rejects attaching
        // a human gate to an action whose executor declares
        // requiresApprovalCapable=false; draft_message was flipped to
        // capable in the same ticket.
        ensureRuleAttachable("draft_message", "human_required");
        await db.insert(agentApprovalRules).values({
          tenantId,
          agentId,
          actionId: draftAction.id,
          approvalMode: "human_required",
          approverRole: "owning_recruiter",
        });
        ensureRuleAttachable("send_message", "auto");
        await db.insert(agentApprovalRules).values({
          tenantId,
          agentId,
          actionId: sendAction.id,
          approvalMode: "auto",
          approverRole: null,
        });

        return { agentId };
      });
    }),

  listAgents: protectedProcedure
    .input(listAgentsInputSchema)
    .output(listAgentsOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "Agent workflows are admin-only");
      const db = requireDb(ctx);
      // Join four sources via raw SQL — clean than separate Drizzle queries
      // stitched in JS. tenant_isolation RLS scopes everything.
      //
      // AD8: trigger_type + last_run_status + succeeded/failed counts are all
      // REAL — the trigger is the agent's primary configured trigger row, the
      // run aggregates come straight off agent_runs.status ('completed' =
      // success, 'failed' = failure). No synthetic success percentage.
      const result = await db.execute(dsql`
        SELECT
          aa.id::text AS id,
          aa.agent_type,
          aa.name,
          aa.description,
          aa.enabled,
          aa.version,
          aa.created_at,
          aa.retired_at,
          COALESCE(approval_counts.pending_approval_count, 0)::int AS pending_approval_count,
          COALESCE(run_counts.total_runs, 0)::int AS total_runs,
          run_counts.last_run_at,
          run_counts.last_run_status,
          COALESCE(run_counts.succeeded_runs, 0)::int AS succeeded_runs,
          COALESCE(run_counts.failed_runs, 0)::int AS failed_runs,
          trig.trigger_type
        FROM public.automation_agents aa
        LEFT JOIN (
          SELECT agent_id, COUNT(*)::int AS pending_approval_count
          FROM public.agent_approval_requests
          WHERE status = 'pending'
          GROUP BY agent_id
        ) AS approval_counts ON approval_counts.agent_id = aa.id
        LEFT JOIN (
          SELECT
            r.agent_id,
            COUNT(*)::int AS total_runs,
            MAX(r.triggered_at) AS last_run_at,
            COUNT(*) FILTER (WHERE r.status = 'completed')::int AS succeeded_runs,
            COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed_runs,
            (ARRAY_AGG(r.status ORDER BY r.triggered_at DESC))[1] AS last_run_status
          FROM public.agent_runs r
          GROUP BY r.agent_id
        ) AS run_counts ON run_counts.agent_id = aa.id
        LEFT JOIN LATERAL (
          SELECT t.trigger_type
          FROM public.agent_triggers t
          WHERE t.agent_id = aa.id
          ORDER BY t.created_at ASC
          LIMIT 1
        ) AS trig ON true
        WHERE aa.retired_at IS NULL
        ORDER BY aa.created_at DESC
      `);
      // Drizzle's db.execute returns a {rows: …} shape under
      // postgres-js. postgres-js returns timestamp columns as either
      // Date or string depending on driver mode (HANDOVER #79/#96);
      // coerce via toIsoString defensively.
      interface Row {
        id: string;
        agent_type: string;
        name: string;
        description: string | null;
        enabled: boolean;
        version: number;
        created_at: Date | string;
        retired_at: Date | string | null;
        pending_approval_count: number;
        total_runs: number;
        last_run_at: Date | string | null;
        last_run_status: string | null;
        succeeded_runs: number;
        failed_runs: number;
        trigger_type: string | null;
      }
      const rows = (result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[]);
      const agents: AgentListRow[] = rows.map((r) => ({
        id: r.id,
        agent_type: r.agent_type,
        name: r.name,
        description: r.description,
        enabled: r.enabled,
        version: r.version,
        created_at: toIsoString(r.created_at) ?? new Date(0).toISOString(),
        retired_at: toIsoString(r.retired_at),
        pending_approval_count: r.pending_approval_count,
        total_runs: r.total_runs,
        last_run_at: toIsoString(r.last_run_at),
        last_run_status: r.last_run_status,
        succeeded_runs: r.succeeded_runs,
        failed_runs: r.failed_runs,
        trigger_type: r.trigger_type,
      }));
      return { agents };
    }),

  // ─────────────────────── getAgentDetail (ADMIN-01) ───────────────────────
  //
  // The admin drill-in read for /admin/workflows. Reads only — no
  // withAudit (matches listAgents; the DB-AUDIT trigger already captures
  // row changes and reads make none). Every select is scoped by
  // ctx.tenantId (same explicit filter toggleFollowUpAgent uses) on top
  // of the tenant_isolation RLS the protectedProcedure tx applies. The
  // agent row is NOT filtered on retired_at — a just-retired agent is
  // still viewable, with its retired_at surfaced. A missing agent (or one
  // in another tenant) is NOT_FOUND.
  getAgentDetail: protectedProcedure
    .input(getAgentDetailInputSchema)
    .output(getAgentDetailOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "Agent workflows are admin-only");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;

      const [agent] = await db
        .select({
          id: automationAgents.id,
          agentType: automationAgents.agentType,
          name: automationAgents.name,
          description: automationAgents.description,
          enabled: automationAgents.enabled,
          version: automationAgents.version,
          createdAt: automationAgents.createdAt,
          retiredAt: automationAgents.retiredAt,
        })
        .from(automationAgents)
        .where(and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)))
        .limit(1);
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }

      const triggerRows = await db
        .select({
          id: agentTriggers.id,
          triggerType: agentTriggers.triggerType,
          triggerConfig: agentTriggers.triggerConfig,
        })
        .from(agentTriggers)
        .where(and(eq(agentTriggers.agentId, input.agentId), eq(agentTriggers.tenantId, tenantId)));

      const actionRows = await db
        .select({
          id: agentActions.id,
          actionOrder: agentActions.actionOrder,
          actionType: agentActions.actionType,
          actionConfig: agentActions.actionConfig,
        })
        .from(agentActions)
        .where(and(eq(agentActions.agentId, input.agentId), eq(agentActions.tenantId, tenantId)))
        .orderBy(agentActions.actionOrder);

      const ruleRows = await db
        .select({
          id: agentApprovalRules.id,
          actionId: agentApprovalRules.actionId,
          approvalMode: agentApprovalRules.approvalMode,
          approverRole: agentApprovalRules.approverRole,
          approverUserId: agentApprovalRules.approverUserId,
          conditions: agentApprovalRules.conditions,
        })
        .from(agentApprovalRules)
        .where(
          and(
            eq(agentApprovalRules.agentId, input.agentId),
            eq(agentApprovalRules.tenantId, tenantId),
          ),
        );

      const runRows = await db
        .select({
          id: agentRuns.id,
          triggeredBy: agentRuns.triggeredBy,
          triggeredAt: agentRuns.triggeredAt,
          status: agentRuns.status,
          completedAt: agentRuns.completedAt,
          error: agentRuns.error,
        })
        .from(agentRuns)
        .where(and(eq(agentRuns.agentId, input.agentId), eq(agentRuns.tenantId, tenantId)))
        .orderBy(desc(agentRuns.triggeredAt))
        .limit(20);

      return {
        agent: {
          id: agent.id,
          agent_type: agent.agentType,
          name: agent.name,
          description: agent.description,
          enabled: agent.enabled,
          version: agent.version,
          created_at: toIsoString(agent.createdAt) ?? new Date(0).toISOString(),
          retired_at: toIsoString(agent.retiredAt),
        },
        triggers: triggerRows.map((t) => ({
          id: t.id,
          trigger_type: t.triggerType,
          trigger_config: t.triggerConfig,
        })),
        actions: actionRows.map((a) => ({
          id: a.id,
          action_order: a.actionOrder,
          action_type: a.actionType,
          action_config: a.actionConfig,
        })),
        approvalRules: ruleRows.map((r) => ({
          id: r.id,
          action_id: r.actionId,
          approval_mode: r.approvalMode,
          approver_role: r.approverRole,
          approver_user_id: r.approverUserId,
          conditions: r.conditions,
        })),
        recentRuns: runRows.map((run) => ({
          id: run.id,
          triggered_by: run.triggeredBy,
          triggered_at: toIsoString(run.triggeredAt) ?? new Date(0).toISOString(),
          status: run.status,
          completed_at: toIsoString(run.completedAt),
          error: run.error,
        })),
      };
    }),

  // ─────────────────────── listAuditEvents (ADMIN-02) ───────────────────────
  //
  // The admin audit-trail read for /admin/audit — "every agent action,
  // logged" (demo Act 3, step 15). Reads only — no withAudit (matches
  // listAgents; the DB-AUDIT trigger captures row changes and reads make
  // none, and this reads the audit log itself). Every predicate is ANDed
  // with an explicit eq(tenantId, ctx.tenantId) on top of the RLS the
  // protectedProcedure tx applies. Ordered created_at DESC, id DESC and
  // keyset-paginated on that composite so rows sharing a timestamp within
  // one transaction still page deterministically. audit_logs is monthly
  // RANGE-partitioned by created_at, but a plain tenant-scoped SELECT needs
  // no partition-aware handling.
  listAuditEvents: protectedProcedure
    .input(listAuditEventsInputSchema)
    .output(listAuditEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      // AD-03 / AD18 — server-side admin gate. The /admin/audit page is admin-
      // gated, but this procedure was page-gated ONLY; enforce the role here so
      // the audit ledger can never be read by a non-admin caller directly.
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "The audit log is admin-only");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      const limit = input.limit;
      const decoded = decodeAuditCursor(input.cursor);

      const conditions = [eq(auditLogs.tenantId, tenantId)];
      if (input.entityTypes && input.entityTypes.length > 0) {
        conditions.push(inArray(auditLogs.entityType, input.entityTypes));
      }
      if (input.action) {
        conditions.push(eq(auditLogs.action, input.action));
      }
      if (input.entityId) {
        conditions.push(eq(auditLogs.entityId, input.entityId));
      }
      if (input.from) {
        conditions.push(gte(auditLogs.createdAt, new Date(input.from)));
      }
      if (input.to) {
        conditions.push(lte(auditLogs.createdAt, new Date(input.to)));
      }
      if (decoded) {
        // Keyset row-value comparison: (created_at, id) < (cursor.created_at,
        // cursor.id) is exactly the "strictly past the last row" predicate for
        // ORDER BY created_at DESC, id DESC. Casts pin the param types so
        // Postgres picks timestamptz/uuid operators.
        conditions.push(
          // ISO string, not the Date — raw sql params bypass Drizzle's column
          // mapping and postgres.js can't serialize a Date as a text param.
          dsql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${decoded.createdAt.toISOString()}::timestamptz, ${decoded.id}::uuid)`,
        );
      }

      const rows = await db
        .select({
          id: auditLogs.id,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          actorUserId: auditLogs.actorUserId,
          actorMembershipId: auditLogs.actorMembershipId,
          requestId: auditLogs.requestId,
          source: auditLogs.source,
          changedColumns: auditLogs.changedColumns,
          beforeData: auditLogs.beforeData,
          afterData: auditLogs.afterData,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items: AuditEventRow[] = pageRows.map((r) => ({
        id: r.id,
        entity_type: r.entityType,
        entity_id: r.entityId,
        action: r.action,
        actor_user_id: r.actorUserId,
        actor_membership_id: r.actorMembershipId,
        request_id: r.requestId,
        source: r.source,
        changed_columns: r.changedColumns ?? null,
        before_data: r.beforeData ?? null,
        after_data: r.afterData ?? null,
        created_at: toIsoString(r.createdAt) ?? new Date(0).toISOString(),
      }));

      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && lastRow ? encodeAuditCursor(lastRow.createdAt, lastRow.id) : null;

      return { items, nextCursor };
    }),

  // ─────────────────────── exportAuditEvents (AD10) ───────────────────────
  //
  // Deterministic CSV-source read for /admin/audit → Export CSV. Same tenant-
  // scoped predicate + ordering as listAuditEvents (minus the keyset cursor),
  // capped at input.limit (≤5000) so an export never scans the whole monthly-
  // partitioned log. Admin-gated (AD18) exactly like listAuditEvents. Reads
  // only — no withAudit (this reads the audit ledger itself; matches
  // listAuditEvents). The client turns these rows into a CSV blob and derives
  // the severity column via the shared auditEventSeverity() classifier.
  exportAuditEvents: protectedProcedure
    .input(exportAuditEventsInputSchema)
    .output(exportAuditEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "The audit log is admin-only");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      const cap = input.limit;

      const conditions = [eq(auditLogs.tenantId, tenantId)];
      if (input.entityTypes && input.entityTypes.length > 0) {
        conditions.push(inArray(auditLogs.entityType, input.entityTypes));
      }
      if (input.action) conditions.push(eq(auditLogs.action, input.action));
      if (input.entityId) conditions.push(eq(auditLogs.entityId, input.entityId));
      if (input.from) conditions.push(gte(auditLogs.createdAt, new Date(input.from)));
      if (input.to) conditions.push(lte(auditLogs.createdAt, new Date(input.to)));

      const rows = await db
        .select({
          id: auditLogs.id,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          actorUserId: auditLogs.actorUserId,
          actorMembershipId: auditLogs.actorMembershipId,
          requestId: auditLogs.requestId,
          source: auditLogs.source,
          changedColumns: auditLogs.changedColumns,
          beforeData: auditLogs.beforeData,
          afterData: auditLogs.afterData,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(and(...conditions))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(cap + 1);

      const truncated = rows.length > cap;
      const pageRows = truncated ? rows.slice(0, cap) : rows;
      const items: AuditEventRow[] = pageRows.map((r) => ({
        id: r.id,
        entity_type: r.entityType,
        entity_id: r.entityId,
        action: r.action,
        actor_user_id: r.actorUserId,
        actor_membership_id: r.actorMembershipId,
        request_id: r.requestId,
        source: r.source,
        changed_columns: r.changedColumns ?? null,
        before_data: r.beforeData ?? null,
        after_data: r.afterData ?? null,
        created_at: toIsoString(r.createdAt) ?? new Date(0).toISOString(),
      }));

      return { items, truncated, generatedAt: new Date().toISOString() };
    }),

  // ─────────────────────── listNotificationLog (AD12) ───────────────────────
  //
  // Read-only, admin-gated, tenant-scoped email delivery log for /admin/messaging
  // over the REAL notification_outbox. No WhatsApp/SMS (we have none) and no
  // delivery/read receipts (the outbox only tracks send status). Reads only —
  // no withAudit (the DB-AUDIT trigger already records outbox writes; reads make
  // none). statusCounts + total roll up the whole tenant outbox so the header
  // tiles are accurate regardless of the page window.
  listNotificationLog: protectedProcedure
    .input(listNotificationLogInputSchema)
    .output(listNotificationLogOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "The notification log is admin-only");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;

      const rowConditions = [eq(notificationOutbox.tenantId, tenantId)];
      if (input.status) rowConditions.push(eq(notificationOutbox.status, input.status));
      if (input.templateKey) {
        rowConditions.push(eq(notificationOutbox.templateKey, input.templateKey));
      }

      const rows = await db
        .select({
          id: notificationOutbox.id,
          recipientEmail: notificationOutbox.recipientEmail,
          recipientType: notificationOutbox.recipientType,
          templateKey: notificationOutbox.templateKey,
          subject: notificationOutbox.subject,
          status: notificationOutbox.status,
          priority: notificationOutbox.priority,
          attemptCount: notificationOutbox.attemptCount,
          scheduledFor: notificationOutbox.scheduledFor,
          sentAt: notificationOutbox.sentAt,
          lastError: notificationOutbox.lastError,
          providerMessageId: notificationOutbox.providerMessageId,
          createdAt: notificationOutbox.createdAt,
        })
        .from(notificationOutbox)
        .where(and(...rowConditions))
        .orderBy(desc(notificationOutbox.createdAt), desc(notificationOutbox.id))
        .limit(input.limit);

      // Whole-tenant status rollup (independent of the row filter above).
      const countRows = await db
        .select({ status: notificationOutbox.status, n: dsql<number>`count(*)::int` })
        .from(notificationOutbox)
        .where(eq(notificationOutbox.tenantId, tenantId))
        .groupBy(notificationOutbox.status);

      const statusCounts: Partial<Record<NotificationStatus, number>> = {};
      let total = 0;
      for (const c of countRows) {
        total += c.n;
        if (
          c.status === "pending" ||
          c.status === "processing" ||
          c.status === "sent" ||
          c.status === "failed" ||
          c.status === "cancelled"
        ) {
          statusCounts[c.status] = c.n;
        }
      }

      return {
        items: rows.map((r) => ({
          id: r.id,
          recipient_email: r.recipientEmail,
          recipient_type: r.recipientType,
          template_key: r.templateKey,
          subject: r.subject,
          status: r.status,
          priority: r.priority,
          attempt_count: r.attemptCount,
          scheduled_for: toIsoString(r.scheduledFor),
          sent_at: toIsoString(r.sentAt),
          last_error: r.lastError,
          provider_message_id: r.providerMessageId,
          created_at: toIsoString(r.createdAt) ?? new Date(0).toISOString(),
        })),
        statusCounts: statusCounts as Record<NotificationStatus, number>,
        total,
      };
    }),

  // ─────────────────────── getSystemSetup (AD14/AD15) ───────────────────────
  //
  // Admin read of the per-tenant system-setup block (email alerts + simple
  // escalation rules) from tenants.settings.systemSetup, merged over defaults.
  // Admin-gated on the procedure. Read-only, no withAudit (matches the other
  // settings reads). The SLA hours themselves stay hardcoded in
  // @hireops/sla-thresholds — this block only configures WHO gets alerted, not
  // the thresholds (that stays Phase-3 deferred).
  getSystemSetup: protectedProcedure
    .input(getSystemSetupInputSchema)
    .output(getSystemSetupOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "System setup is admin-only");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const [row] = await db
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId))
        .limit(1);
      const settings = (row?.settings ?? {}) as Record<string, unknown>;
      return resolveSystemSetup(settings.systemSetup);
    }),

  // ─────────────────────── updateSystemSetup (AD14/AD15) ───────────────────────
  //
  // Admin write of the system-setup block. Admin-gated + audited. Merges the
  // validated block into tenants.settings under `systemSetup` via the same
  // atomic top-level jsonb `||` merge (service-role; tenants is FORCE RLS
  // SELECT-only) that updateTenantBiasLexicon / updateScoringWeights use —
  // preserving aiSettings, biasLexicon, scoringWeights and cosmetic config
  // verbatim. A SIBLING mutation; system setup saves independently.
  updateSystemSetup: protectedProcedure
    .input(updateSystemSetupInputSchema)
    .output(updateSystemSetupOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_system_setup", ctx, input, async () => {
        requireAnyRole(ctx, USERS_ADMIN_ROLES, "System setup is admin-only");
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        const nextBlock: SystemSetup = resolveSystemSetup(input);

        const res = await poolDb.execute(dsql`
          UPDATE public.tenants
          SET settings = COALESCE(settings, '{}'::jsonb)
              || jsonb_build_object('systemSetup', ${JSON.stringify(nextBlock)}::jsonb)
          WHERE id = ${tenantId}::uuid
          RETURNING id
        `);
        const updated = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
        if (updated.length !== 1) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant settings update affected an unexpected number of rows",
          });
        }

        return { ok: true as const, systemSetup: nextBlock };
      });
    }),

  // ─────────────────────── getAiUsageSummary (ADMIN-03) ───────────────────────
  //
  // Admin AI-cost rollup for /admin/costs — "every Anthropic call logged with
  // tokens and cost, per feature, per model; procurement gets a real TCO
  // number" (demo Act 3, step 16). Reads only — no withAudit (ai_usage_logs
  // carries no audit trigger and this only reads it), matching listAgents /
  // listAuditEvents. Four grouped aggregates over ai_usage_logs; each is
  // explicitly ANDed with tenant_id = ctx.tenantId on top of the
  // tenant_isolation RLS the protectedProcedure tx applies. cost_micros is a
  // bigint — summed as ::text so it crosses the wire as a decimal string
  // (JSON can't carry a bigint). from/to bound created_at as ISO strings
  // interpolated with ::timestamptz casts — never a JS Date, which
  // postgres.js can't serialize as a raw text param (learned in ADMIN-02).
  getAiUsageSummary: protectedProcedure
    .input(getAiUsageSummaryInputSchema)
    .output(getAiUsageSummaryOutputSchema)
    .query(async ({ ctx, input }) => {
      // AD18 — server-side admin gate (page redirect alone left the procedure open).
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "AI cost usage is admin-only");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      const fromClause = input.from ? dsql`AND created_at >= ${input.from}::timestamptz` : dsql``;
      const toClause = input.to ? dsql`AND created_at <= ${input.to}::timestamptz` : dsql``;

      const totalsRes = await db.execute(dsql`
        SELECT
          COUNT(*)::int AS calls,
          COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
          COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
          COALESCE(SUM(cost_micros), 0)::text AS cost_micros,
          COUNT(*) FILTER (WHERE NOT succeeded)::int AS failures,
          COALESCE(ROUND(AVG(latency_ms)), 0)::int AS avg_latency_ms
        FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
      `);

      const featureRes = await db.execute(dsql`
        SELECT
          feature,
          COUNT(*)::int AS calls,
          COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
          COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
          COALESCE(SUM(cost_micros), 0)::text AS cost_micros,
          COUNT(*) FILTER (WHERE NOT succeeded)::int AS failures
        FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
        GROUP BY feature
        ORDER BY SUM(cost_micros) DESC, feature ASC
      `);

      const modelRes = await db.execute(dsql`
        SELECT
          provider,
          model,
          COUNT(*)::int AS calls,
          COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
          COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
          COALESCE(SUM(cost_micros), 0)::text AS cost_micros,
          COUNT(*) FILTER (WHERE NOT succeeded)::int AS failures
        FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
        GROUP BY provider, model
        ORDER BY SUM(cost_micros) DESC, provider ASC, model ASC
      `);

      // Last 14 days within range — the range filter ANDed with a fixed
      // 14-day floor, one row per calendar day (session tz), ascending.
      const dayRes = await db.execute(dsql`
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          COUNT(*)::int AS calls,
          COALESCE(SUM(cost_micros), 0)::text AS cost_micros
        FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
          AND created_at >= (now() - interval '14 days')
        GROUP BY date_trunc('day', created_at)
        ORDER BY date_trunc('day', created_at) ASC
      `);

      // Drizzle's db.execute returns a {rows: …} shape under postgres-js;
      // fall back to the array form defensively (matches listAgents).
      const asRows = <T>(res: unknown): T[] => (res as { rows?: T[] }).rows ?? (res as T[]);

      interface TotalsRow {
        calls: number;
        input_tokens: number;
        output_tokens: number;
        cost_micros: string;
        failures: number;
        avg_latency_ms: number;
      }
      interface FeatureRow {
        feature: string;
        calls: number;
        input_tokens: number;
        output_tokens: number;
        cost_micros: string;
        failures: number;
      }
      interface ModelRow extends FeatureRow {
        provider: string;
        model: string;
      }
      interface DayRow {
        day: string;
        calls: number;
        cost_micros: string;
      }

      // COUNT(*) always yields exactly one totals row (zeros on an empty
      // table); the fallback is belt-and-braces.
      const t = asRows<TotalsRow>(totalsRes)[0] ?? {
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cost_micros: "0",
        failures: 0,
        avg_latency_ms: 0,
      };

      return {
        totals: {
          calls: t.calls,
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          cost_micros: t.cost_micros,
          failures: t.failures,
          avg_latency_ms: t.avg_latency_ms,
        },
        byFeature: asRows<FeatureRow>(featureRes).map((r) => ({
          feature: r.feature,
          calls: r.calls,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cost_micros: r.cost_micros,
          failures: r.failures,
        })),
        byModel: asRows<ModelRow>(modelRes).map((r) => ({
          provider: r.provider,
          model: r.model,
          calls: r.calls,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cost_micros: r.cost_micros,
          failures: r.failures,
        })),
        byDay: asRows<DayRow>(dayRes).map((r) => ({
          day: r.day,
          calls: r.calls,
          cost_micros: r.cost_micros,
        })),
      };
    }),

  // ─────────────────────── getTenantAiSettings (CONF-01) ───────────────────────
  //
  // Admin read of the effective per-tenant AI settings (defaults merged over
  // whatever is stored in tenants.settings.aiSettings). Admin-gated on the
  // procedure itself. Read-only, no withAudit (matches getAiUsageSummary).
  getTenantAiSettings: protectedProcedure
    .input(getTenantAiSettingsInputSchema)
    .output(getTenantAiSettingsOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, AI_SETTINGS_ADMIN_ROLES, "AI settings are admin-only");
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      return resolveTenantAiSettingsDb(ctx.tenantId);
    }),

  // ─────────────────────── updateTenantAiSettings (CONF-01) ───────────────────────
  //
  // Admin write of the per-tenant AI settings block. Admin-gated + audited.
  // Merges the validated block into tenants.settings under the `aiSettings`
  // key, preserving every OTHER key (ai_provider, cosmetic config) verbatim:
  // a single atomic top-level jsonb `||` merge — never a clobber and never a
  // read-modify-write race. The write goes through the unscoped pool
  // (service_role): `tenants` is FORCE RLS with SELECT-only policies, so the
  // tenant-scoped client cannot update it (same precedent as
  // storeIntegrationCredential / the ai-client usage-log writes). The
  // explicit admin gate + the ctx.tenantId predicate are the authorisation.
  updateTenantAiSettings: protectedProcedure
    .input(updateTenantAiSettingsInputSchema)
    .output(updateTenantAiSettingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_tenant_ai_settings", ctx, input, async () => {
        requireAnyRole(ctx, AI_SETTINGS_ADMIN_ROLES, "AI settings are admin-only");
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        // input is already validated + defaulted by the zod .input(); parse
        // again through resolveAiSettings only to normalise the stored shape.
        const nextBlock = resolveAiSettings(input);

        const res = await poolDb.execute(dsql`
          UPDATE public.tenants
          SET settings = COALESCE(settings, '{}'::jsonb)
              || jsonb_build_object('aiSettings', ${JSON.stringify(nextBlock)}::jsonb)
          WHERE id = ${tenantId}::uuid
          RETURNING id
        `);
        const updated = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
        if (updated.length !== 1) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant settings update affected an unexpected number of rows",
          });
        }

        return { ok: true as const, settings: nextBlock };
      });
    }),

  // ─────────────────────── getTenantBranding (AD2) ───────────────────────
  //
  // Admin read of the effective tenant branding: the `display_name` COLUMN
  // (the company name that actually rebrands the product) merged with the
  // resolved cosmetic block from `settings.branding` (primary colour, logo
  // URL, dark-mode default). Admin-gated on the procedure itself. Read-only,
  // no withAudit (matches getTenantAiSettings). Reads through the unscoped
  // pool with an explicit id predicate (same pattern as the AI-settings
  // resolver) — `tenants` is FORCE RLS with SELECT-only policies.
  getTenantBranding: protectedProcedure
    .input(getTenantBrandingInputSchema)
    .output(getTenantBrandingOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "Branding is admin-only");
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const [row] = await poolDb
        .select({ displayName: tenants.displayName, settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId))
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      }
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      const branding = resolveBrandingSettings(settings["branding"]);
      return {
        displayName: row.displayName,
        primaryColor: branding.primaryColor,
        logoUrl: branding.logoUrl,
        darkModeDefault: branding.darkModeDefault,
      };
    }),

  // ─────────────────────── updateTenantBranding (AD2) ───────────────────────
  //
  // Admin write of the tenant's branding. Admin-gated + audited. The company
  // name lands on the `display_name` COLUMN (this is what actually rebrands
  // the product — the NovaChem rebrand was a raw UPDATE of exactly this
  // column; this procedure turns that into a real, demoable feature). The
  // cosmetic trio (primaryColor / logoUrl / darkModeDefault) merges into
  // `settings.branding` via the same atomic top-level jsonb `||` merge
  // updateTenantAiSettings uses, preserving every OTHER settings key
  // (aiSettings, biasLexicon, …) verbatim. Both writes are ONE UPDATE — no
  // read-modify-write race, no partial rebrand. The write goes through the
  // unscoped pool (service_role): `tenants` is FORCE RLS with SELECT-only
  // policies, so the tenant-scoped client cannot update it (same precedent as
  // updateTenantAiSettings). The explicit admin gate + the ctx.tenantId
  // predicate are the authorisation.
  updateTenantBranding: protectedProcedure
    .input(updateTenantBrandingInputSchema)
    .output(updateTenantBrandingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_tenant_branding", ctx, input, async () => {
        requireAnyRole(ctx, USERS_ADMIN_ROLES, "Branding is admin-only");
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        const displayName = input.displayName.trim();
        const brandingBlock = {
          primaryColor: input.primaryColor,
          logoUrl: input.logoUrl,
          darkModeDefault: input.darkModeDefault,
        };

        const res = await poolDb.execute(dsql`
          UPDATE public.tenants
          SET display_name = ${displayName},
              settings = COALESCE(settings, '{}'::jsonb)
                || jsonb_build_object('branding', ${JSON.stringify(brandingBlock)}::jsonb)
          WHERE id = ${tenantId}::uuid
          RETURNING id
        `);
        const updated = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
        if (updated.length !== 1) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant branding update affected an unexpected number of rows",
          });
        }

        return {
          ok: true as const,
          branding: {
            displayName,
            primaryColor: brandingBlock.primaryColor,
            logoUrl: brandingBlock.logoUrl,
            darkModeDefault: brandingBlock.darkModeDefault,
          },
        };
      });
    }),

  // ─────────────────────── getBiasLexicon (CONF-02) ───────────────────────
  //
  // The effective per-tenant JD bias lexicon (enforcement + entries), defaults
  // merged. Readable by REQUISITION_READ_ROLES — the wizard (hiring_manager)
  // scans against the SAME lexicon the server gate uses, and the admin surface
  // (admin) reads it to edit. Read-only, no withAudit (matches
  // getTenantAiSettings). WRITE is admin-only (updateTenantBiasLexicon).
  getBiasLexicon: protectedProcedure
    .input(getBiasLexiconInputSchema)
    .output(getBiasLexiconOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        REQUISITION_READ_ROLES,
        "Bias lexicon access requires the hiring_manager, recruiter, hr_head or admin role",
      );
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      return resolveTenantBiasLexiconDb(ctx.tenantId);
    }),

  // ─────────────────────── updateTenantBiasLexicon (CONF-02) ───────────────────────
  //
  // Admin write of the per-tenant bias lexicon block. Admin-gated + audited.
  // Merges the validated block into tenants.settings under the `biasLexicon`
  // key, preserving every OTHER key (aiSettings, ai_provider, cosmetic config)
  // verbatim via a single atomic top-level jsonb `||` merge — the same
  // service-role discipline updateTenantAiSettings uses (tenants is FORCE RLS
  // SELECT-only). A SIBLING mutation rather than an extension of
  // updateTenantAiSettings because the lexicon is a sibling block, not an AI
  // feature — the two surfaces save independently.
  updateTenantBiasLexicon: protectedProcedure
    .input(updateTenantBiasLexiconInputSchema)
    .output(updateTenantBiasLexiconOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_tenant_bias_lexicon", ctx, input, async () => {
        requireAnyRole(ctx, AI_SETTINGS_ADMIN_ROLES, "The bias lexicon is admin-only");
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        const nextBlock: BiasLexicon = resolveBiasLexicon(input);

        const res = await poolDb.execute(dsql`
          UPDATE public.tenants
          SET settings = COALESCE(settings, '{}'::jsonb)
              || jsonb_build_object('biasLexicon', ${JSON.stringify(nextBlock)}::jsonb)
          WHERE id = ${tenantId}::uuid
          RETURNING id
        `);
        const updated = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
        if (updated.length !== 1) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant settings update affected an unexpected number of rows",
          });
        }

        return { ok: true as const, lexicon: nextBlock };
      });
    }),

  // ─────────────────────── getScoringWeights (CONF-03) ───────────────────────
  //
  // Admin read of the effective per-tenant scoring weight profile (defaults
  // merged over tenants.settings.scoringWeights). Admin-gated on the procedure
  // itself. Read-only, no withAudit (matches getTenantAiSettings). The four
  // categories mirror the scoring response's top_factors factor enum.
  getScoringWeights: protectedProcedure
    .input(getScoringWeightsInputSchema)
    .output(getScoringWeightsOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, AI_SETTINGS_ADMIN_ROLES, "Scoring weights are admin-only");
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      return resolveTenantScoringWeightsDb(ctx.tenantId);
    }),

  // ─────────────────────── updateScoringWeights (CONF-03) ───────────────────────
  //
  // Admin write of the per-tenant scoring weight profile. Admin-gated +
  // audited. The zod .input() already enforces sum-to-100 (a refine); we
  // normalise through resolveScoringWeights and merge the block into
  // tenants.settings under the `scoringWeights` key via the same atomic
  // service-role jsonb `||` merge updateTenantAiSettings uses (tenants is
  // FORCE RLS SELECT-only). A SIBLING mutation — the weight profile saves
  // independently of aiSettings + biasLexicon.
  updateScoringWeights: protectedProcedure
    .input(updateScoringWeightsInputSchema)
    .output(updateScoringWeightsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_scoring_weights", ctx, input, async () => {
        requireAnyRole(ctx, AI_SETTINGS_ADMIN_ROLES, "Scoring weights are admin-only");
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        const nextBlock: ScoringWeights = resolveScoringWeights(input);

        const res = await poolDb.execute(dsql`
          UPDATE public.tenants
          SET settings = COALESCE(settings, '{}'::jsonb)
              || jsonb_build_object('scoringWeights', ${JSON.stringify(nextBlock)}::jsonb)
          WHERE id = ${tenantId}::uuid
          RETURNING id
        `);
        const updated = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
        if (updated.length !== 1) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant settings update affected an unexpected number of rows",
          });
        }

        return { ok: true as const, weights: nextBlock };
      });
    }),

  // ═════════════════════════ HRHEAD-03 — Governance & Executive Audit ═════════════════════════
  //
  // Two settings blocks (screeningPrivacy + feedbackSharing) on the CONF-01
  // sibling-block pattern, plus two read-only derivations (risk flags +
  // executive audit). hr_head + admin throughout. NOTE: the settings surfaces
  // carry a "changes require admin approval" note in the UI that is COPY ONLY
  // for the POC — an hr_head edit here takes effect immediately (no approval
  // workflow was built; flagged in the hand-back).

  // ─────────────────────── getScreeningPrivacy (HRHEAD-03) ───────────────────────
  getScreeningPrivacy: protectedProcedure
    .input(getScreeningPrivacyInputSchema)
    .output(getScreeningPrivacyOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        GOVERNANCE_READ_ROLES,
        "Governance settings require the hr_head or admin role",
      );
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      return resolveTenantScreeningPrivacyDb(ctx.tenantId);
    }),

  // ─────────────────────── updateScreeningPrivacy (HRHEAD-03) ───────────────────────
  // Merges the validated block into tenants.settings under `screeningPrivacy`
  // via the same atomic service-role jsonb `||` merge updateTenantAiSettings
  // uses (tenants is FORCE RLS SELECT-only). A SIBLING mutation — saves
  // independently of aiSettings / biasLexicon / scoringWeights / feedbackSharing.
  updateScreeningPrivacy: protectedProcedure
    .input(updateScreeningPrivacyInputSchema)
    .output(updateScreeningPrivacyOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_screening_privacy", ctx, input, async () => {
        requireAnyRole(
          ctx,
          GOVERNANCE_READ_ROLES,
          "Governance settings require the hr_head or admin role",
        );
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        const nextBlock: ScreeningPrivacy = resolveScreeningPrivacy(input);
        const res = await poolDb.execute(dsql`
          UPDATE public.tenants
          SET settings = COALESCE(settings, '{}'::jsonb)
              || jsonb_build_object('screeningPrivacy', ${JSON.stringify(nextBlock)}::jsonb)
          WHERE id = ${tenantId}::uuid
          RETURNING id
        `);
        const updated = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
        if (updated.length !== 1) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant settings update affected an unexpected number of rows",
          });
        }
        return { ok: true as const, screeningPrivacy: nextBlock };
      });
    }),

  // ─────────────────────── getFeedbackSharing (HRHEAD-03) ───────────────────────
  getFeedbackSharing: protectedProcedure
    .input(getFeedbackSharingInputSchema)
    .output(getFeedbackSharingOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        GOVERNANCE_READ_ROLES,
        "Governance settings require the hr_head or admin role",
      );
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      return resolveTenantFeedbackSharingDb(ctx.tenantId);
    }),

  // ─────────────────────── updateFeedbackSharing (HRHEAD-03) ───────────────────────
  updateFeedbackSharing: protectedProcedure
    .input(updateFeedbackSharingInputSchema)
    .output(updateFeedbackSharingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_feedback_sharing", ctx, input, async () => {
        requireAnyRole(
          ctx,
          GOVERNANCE_READ_ROLES,
          "Governance settings require the hr_head or admin role",
        );
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        const nextBlock = resolveFeedbackSharing(input);
        const res = await poolDb.execute(dsql`
          UPDATE public.tenants
          SET settings = COALESCE(settings, '{}'::jsonb)
              || jsonb_build_object('feedbackSharing', ${JSON.stringify(nextBlock)}::jsonb)
          WHERE id = ${tenantId}::uuid
          RETURNING id
        `);
        const updated = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
        if (updated.length !== 1) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant settings update affected an unexpected number of rows",
          });
        }
        return { ok: true as const, feedbackSharing: nextBlock };
      });
    }),

  // ─────────────────────── getGovernanceRiskFlags (HRHEAD-03) ───────────────────────
  // The deterministic rule engine over live data — five rules, each yielding a
  // severity + entity deep-link + one-line consequence. Rule (a) probes for the
  // concurrently-built market_benchmarks table and omits itself when absent.
  // Read-only, no withAudit (matches getHrMetrics). RLS scopes every read.
  getGovernanceRiskFlags: protectedProcedure
    .output(getGovernanceRiskFlagsOutputSchema)
    .query(async ({ ctx }): Promise<GetGovernanceRiskFlagsOutput> => {
      requireAnyRole(
        ctx,
        GOVERNANCE_READ_ROLES,
        "Governance access requires the hr_head or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      return computeGovernanceRiskFlags(db, ctx.tenantId);
    }),

  // ─────────────────────── getExecutiveAudit (HRHEAD-03) ───────────────────────
  // The composite behind /exec-audit: compliance score (four weighted real
  // ratios), the KPI row, the risk-flag feed, the per-stage SLA table, and top
  // drop-off reasons — all from live tables in ONE call. hr_head + admin.
  getExecutiveAudit: protectedProcedure
    .output(getExecutiveAuditOutputSchema)
    .query(async ({ ctx }): Promise<GetExecutiveAuditOutput> => {
      requireAnyRole(
        ctx,
        GOVERNANCE_READ_ROLES,
        "Governance access requires the hr_head or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      return computeExecutiveAudit(db, ctx.tenantId);
    }),

  // ─────────────────────── reviewJdWithAi (CONF-02) ───────────────────────
  //
  // Optional, advisory AI inclusive-language review of a DRAFT requisition's
  // JD — beyond the deterministic lexicon. hiring_manager + admin, draft-only.
  // Honours the per-tenant jd_bias_review AI switch (disabled → clean
  // BAD_REQUEST, no model call, no usage row). NEVER blocks anything; the
  // wizard renders the observations as labelled "AI-assisted" cards. The JD
  // text carries no candidate PII, so masking does not apply (same as
  // generateJdDraft). The AI client writes the ai_usage_logs row itself
  // (feature=jd_bias_review).
  reviewJdWithAi: protectedProcedure
    .input(reviewJdWithAiInputSchema)
    .output(reviewJdWithAiOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("review_jd_with_ai", ctx, input, async () => {
        requireAnyRole(
          ctx,
          REQUISITION_WRITE_ROLES,
          "Reviewing a JD with AI requires the hiring_manager or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);

        const facet = await loadDraftRequisitionFacet(db, input.requisitionId);
        if (facet.status !== "draft") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "A JD can only be reviewed while the requisition is a draft",
          });
        }
        if (facet.jdText === JD_DRAFT_PLACEHOLDER || !facet.jdSummary) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Generate or write the JD before requesting an AI review",
          });
        }

        const aiSettings = await resolveTenantAiSettingsDb(tenantId);
        const reviewSettings = aiSettings.jd_bias_review;
        if (!reviewSettings.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "AI JD review is disabled for this tenant. An admin can re-enable it in Admin → AI settings.",
          });
        }

        const { system, user } = buildJdBiasReviewPrompt({
          positionTitle: facet.title,
          jdText: facet.jdText,
        });

        const client = await getAIClient(tenantId);
        const raw = await client.completeStructured<JdBiasReviewResponse>({
          prompt: user,
          system,
          model: reviewSettings.model,
          temperature: reviewSettings.temperature,
          maxTokens: reviewSettings.maxTokens,
          schema: jdBiasReviewResponseJsonSchema,
          schemaName: JD_BIAS_REVIEW_SCHEMA_NAME,
          feature: JD_BIAS_REVIEW_FEATURE,
          requestId: ctx.requestId,
          actorMembershipId: membershipId,
        });
        const parsed = jdBiasReviewResponseSchema.parse(raw);

        return { observations: parsed.observations, model: client.provider };
      });
    }),

  // ─────────────────────── getRecruitmentReport (REPORT-01) ───────────────────────
  //
  // First reporting surface for /admin/reports — funnel + source mix +
  // time-to-hire + per-stage durations + headline totals (requirements
  // §9.8, a deliberate Wave-2 pull-forward for the demo). Reads only, no
  // withAudit (matches getAiUsageSummary / listAuditEvents — this only
  // reads tenant-scoped tables). Every WHERE carries an explicit
  // `tenant_id = ctx.tenantId` on top of the tenant_isolation RLS the
  // protectedProcedure tx applies. from/to bound applications.created_at
  // as ISO strings interpolated with ::timestamptz casts — never a JS
  // Date, which postgres-js can't serialize as a raw text param (the same
  // rule getAiUsageSummary follows). Medians/percentiles use Postgres-
  // native percentile_cont; an empty input set yields NULL, surfaced as a
  // null median rather than a NOT_FOUND. Applications are aliased `a`
  // throughout so a single created_at clause works across the joined
  // queries. Funnel + stageDurations are zero-filled to the full 11-stage
  // enum in enum order, in JS, so the UI always renders the whole funnel.
  getRecruitmentReport: protectedProcedure
    .input(getRecruitmentReportInputSchema)
    .output(getRecruitmentReportOutputSchema)
    .query(async ({ ctx, input }) => {
      // AD18 — server-side admin gate (page redirect alone left the procedure open).
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "Recruitment reports are admin-only");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      // Bind against a.created_at so the same fragment slots into the
      // single-table and joined queries alike.
      const fromClause = input.from ? dsql`AND a.created_at >= ${input.from}::timestamptz` : dsql``;
      const toClause = input.to ? dsql`AND a.created_at <= ${input.to}::timestamptz` : dsql``;

      // Drizzle's db.execute returns a {rows: …} shape under postgres-js;
      // fall back to the array form defensively (matches getAiUsageSummary).
      const asRows = <T>(res: unknown): T[] => (res as { rows?: T[] }).rows ?? (res as T[]);

      // Funnel — current count per stage, present stages only; zero-filled
      // to the full enum below.
      const funnelRes = await db.execute(dsql`
        SELECT a.current_stage AS stage, COUNT(*)::int AS current_count
        FROM public.applications a
        WHERE a.tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
        GROUP BY a.current_stage
      `);

      // Source mix — applications + hires (offer_accepted) per channel.
      const sourceRes = await db.execute(dsql`
        SELECT
          a.source AS source,
          COUNT(*)::int AS applications,
          COUNT(*) FILTER (WHERE a.current_stage = 'offer_accepted')::int AS hires
        FROM public.applications a
        WHERE a.tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
        GROUP BY a.source
        ORDER BY COUNT(*) DESC, a.source ASC
      `);

      // Totals — one row; active = non-terminal, hired = offer_accepted,
      // rejected_or_withdrawn = the other three terminals.
      const totalsRes = await db.execute(dsql`
        SELECT
          COUNT(*)::int AS applications,
          COUNT(*) FILTER (
            WHERE a.current_stage NOT IN
              ('offer_accepted', 'offer_declined', 'withdrawn', 'recruiter_rejected')
          )::int AS active,
          COUNT(*) FILTER (WHERE a.current_stage = 'offer_accepted')::int AS hired,
          COUNT(*) FILTER (
            WHERE a.current_stage IN ('offer_declined', 'withdrawn', 'recruiter_rejected')
          )::int AS rejected_or_withdrawn
        FROM public.applications a
        WHERE a.tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
      `);

      // Time-to-hire — days from created_at to the earliest offer_accepted
      // transition, per hired application. percentile_cont over an empty
      // set yields NULL → null medians when hires_count = 0.
      const timeToHireRes = await db.execute(dsql`
        WITH hired AS (
          SELECT
            a.id,
            EXTRACT(EPOCH FROM (MIN(t.transitioned_at) - a.created_at)) / 86400.0 AS days_to_hire
          FROM public.applications a
          JOIN public.application_state_transitions t
            ON t.tenant_id = a.tenant_id
           AND t.application_id = a.id
           AND t.to_stage = 'offer_accepted'
          WHERE a.tenant_id = ${tenantId}::uuid
            AND a.current_stage = 'offer_accepted'
            ${fromClause} ${toClause}
          GROUP BY a.id, a.created_at
        )
        SELECT
          COUNT(*)::int AS hires_count,
          ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_to_hire)::numeric, 2)::float8
            AS median_days,
          ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY days_to_hire)::numeric, 2)::float8
            AS p90_days
        FROM hired
      `);

      // Stage durations — median days spent in each stage, from consecutive
      // transition pairs. LEAD over (application ORDER BY transitioned_at)
      // gives the next transition's timestamp (when the app left the stage
      // it entered); the last transition per app has a NULL LEAD (still in
      // that stage) and is excluded.
      const stageDurationRes = await db.execute(dsql`
        WITH ordered AS (
          SELECT
            t.to_stage AS stage,
            t.transitioned_at AS entered_at,
            LEAD(t.transitioned_at) OVER (
              PARTITION BY t.application_id ORDER BY t.transitioned_at
            ) AS left_at
          FROM public.application_state_transitions t
          JOIN public.applications a
            ON a.tenant_id = t.tenant_id
           AND a.id = t.application_id
          WHERE t.tenant_id = ${tenantId}::uuid ${fromClause} ${toClause}
        ),
        durations AS (
          SELECT stage, EXTRACT(EPOCH FROM (left_at - entered_at)) / 86400.0 AS days
          FROM ordered
          WHERE left_at IS NOT NULL
        )
        SELECT
          stage,
          ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY days)::numeric, 2)::float8
            AS median_days
        FROM durations
        GROUP BY stage
      `);

      interface FunnelRow {
        stage: ApplicationStage;
        current_count: number;
      }
      interface SourceRow {
        source: string;
        applications: number;
        hires: number;
      }
      interface TotalsRow {
        applications: number;
        active: number;
        hired: number;
        rejected_or_withdrawn: number;
      }
      interface TimeToHireRow {
        hires_count: number;
        median_days: number | null;
        p90_days: number | null;
      }
      interface StageDurationRow {
        stage: ApplicationStage;
        median_days: number | null;
      }

      // Zero-fill the funnel + stage durations to the full enum, in enum
      // order, so the UI renders every stage regardless of data.
      const funnelByStage = new Map(
        asRows<FunnelRow>(funnelRes).map((r) => [r.stage, r.current_count]),
      );
      const durationByStage = new Map(
        asRows<StageDurationRow>(stageDurationRes).map((r) => [r.stage, r.median_days]),
      );

      const t = asRows<TimeToHireRow>(timeToHireRes)[0] ?? {
        hires_count: 0,
        median_days: null,
        p90_days: null,
      };
      const totalsRow = asRows<TotalsRow>(totalsRes)[0] ?? {
        applications: 0,
        active: 0,
        hired: 0,
        rejected_or_withdrawn: 0,
      };

      return {
        funnel: applicationStageEnum.enumValues.map((stage) => ({
          stage,
          current_count: funnelByStage.get(stage) ?? 0,
        })),
        sourceMix: asRows<SourceRow>(sourceRes).map((r) => ({
          source: r.source,
          applications: r.applications,
          hires: r.hires,
        })),
        timeToHire: {
          median_days: t.median_days,
          p90_days: t.p90_days,
          hires_count: t.hires_count,
        },
        stageDurations: applicationStageEnum.enumValues.map((stage) => ({
          stage,
          median_days: durationByStage.get(stage) ?? null,
        })),
        totals: {
          applications: totalsRow.applications,
          active: totalsRow.active,
          hired: totalsRow.hired,
          rejected_or_withdrawn: totalsRow.rejected_or_withdrawn,
        },
      };
    }),

  // ─────────────────────── getHrMetrics (METRICS-01) ───────────────────────
  //
  // The single aggregate read behind the /metrics analytics surface — the
  // KPI header + the six-chart grid, all from ONE call (client-side
  // recharts, server-side numbers). hr_head + admin only (requireAnyRole →
  // FORBIDDEN for recruiter/hiring_manager/panel_member); RLS scopes every
  // read on top of the explicit tenant_id filter. Reads only, no withAudit
  // (matches getRecruitmentReport / getAiUsageSummary).
  //
  // Windows: the pipeline/source/offer/score panels are a current-state
  // snapshot (all-time, tenant-scoped) — consistent with /admin/reports and
  // demo-stable; AI spend is a fixed last-14-days series (matches
  // /admin/costs). No date input — the window is fixed by scope. Money +
  // percentile idioms follow the house rules: cost_micros as ::text,
  // percentile/avg native to Postgres, funnel + stage + score buckets
  // zero-filled in JS so the grid always renders every band.
  getHrMetrics: protectedProcedure.output(getHrMetricsOutputSchema).query(async ({ ctx }) => {
    requireAnyRole(
      ctx,
      HR_METRICS_READ_ROLES,
      "HR metrics access requires the hr_head or admin role",
    );
    const db = requireDb(ctx);
    if (!ctx.tenantId) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "protected procedure missing tenantId",
      });
    }
    const tenantId = ctx.tenantId;
    const asRows = <T>(res: unknown): T[] => (res as { rows?: T[] }).rows ?? (res as T[]);

    // Funnel — current count per stage (zero-filled to the enum below).
    const funnelRes = await db.execute(dsql`
        SELECT current_stage AS stage, COUNT(*)::int AS count
        FROM public.applications
        WHERE tenant_id = ${tenantId}::uuid
        GROUP BY current_stage
      `);

    // KPI header + avg score, one row.
    const kpiRes = await db.execute(dsql`
        SELECT
          COUNT(*)::int AS applications,
          COUNT(*) FILTER (
            WHERE current_stage NOT IN
              ('offer_accepted', 'offer_declined', 'withdrawn', 'recruiter_rejected')
          )::int AS active,
          COUNT(*) FILTER (WHERE current_stage = 'offer_accepted')::int AS hired,
          ROUND(AVG(ai_score), 1)::float8 AS avg_ai_score
        FROM public.applications
        WHERE tenant_id = ${tenantId}::uuid
      `);

    // Source mix — applications per channel, present sources only.
    const sourceRes = await db.execute(dsql`
        SELECT source AS source, COUNT(*)::int AS applications
        FROM public.applications
        WHERE tenant_id = ${tenantId}::uuid
        GROUP BY source
        ORDER BY COUNT(*) DESC, source ASC
      `);

    // Time in stage — AVG days per stage from consecutive transition pairs
    // (LEAD gives when the app left the stage it entered; the last
    // transition per app has a NULL LEAD and is excluded).
    const stageDurationRes = await db.execute(dsql`
        WITH ordered AS (
          SELECT
            t.to_stage AS stage,
            t.transitioned_at AS entered_at,
            LEAD(t.transitioned_at) OVER (
              PARTITION BY t.application_id ORDER BY t.transitioned_at
            ) AS left_at
          FROM public.application_state_transitions t
          WHERE t.tenant_id = ${tenantId}::uuid
        ),
        durations AS (
          SELECT stage, EXTRACT(EPOCH FROM (left_at - entered_at)) / 86400.0 AS days
          FROM ordered
          WHERE left_at IS NOT NULL
        )
        SELECT stage, ROUND(AVG(days)::numeric, 2)::float8 AS avg_days
        FROM durations
        GROUP BY stage
      `);

    // Offer funnel — extended (reached the extended state or beyond), then
    // its two terminals. An accepted/declined/expired offer necessarily
    // passed through 'extended', so those terminals count toward `extended`
    // even where the seed left extended_at unstamped — guaranteeing
    // extended >= accepted + declined (the funnel invariant).
    const offerRes = await db.execute(dsql`
        SELECT
          COUNT(*) FILTER (
            WHERE extended_at IS NOT NULL
               OR status IN ('extended', 'accepted', 'declined', 'expired')
          )::int AS extended,
          COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
          COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
        FROM public.offers
        WHERE tenant_id = ${tenantId}::uuid
      `);

    // AI spend — last 14 calendar days, one row per day (session tz),
    // ascending. Same shape as getAiUsageSummary.byDay.
    const aiSpendRes = await db.execute(dsql`
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          COALESCE(SUM(cost_micros), 0)::text AS cost_micros,
          COUNT(*)::int AS calls
        FROM public.ai_usage_logs
        WHERE tenant_id = ${tenantId}::uuid
          AND created_at >= (now() - interval '14 days')
        GROUP BY date_trunc('day', created_at)
        ORDER BY date_trunc('day', created_at) ASC
      `);

    // Score distribution — width-10 histogram, bucket 0..9 (100 folds into
    // the 90–100 bucket via LEAST). Zero-filled to all 10 buckets in JS.
    const scoreRes = await db.execute(dsql`
        SELECT
          LEAST(FLOOR(ai_score / 10)::int, 9) AS bucket,
          COUNT(*)::int AS count
        FROM public.applications
        WHERE tenant_id = ${tenantId}::uuid AND ai_score IS NOT NULL
        GROUP BY LEAST(FLOOR(ai_score / 10)::int, 9)
      `);

    interface FunnelRow {
      stage: ApplicationStage;
      count: number;
    }
    interface KpiRow {
      applications: number;
      active: number;
      hired: number;
      avg_ai_score: number | null;
    }
    interface SourceRow {
      source: string;
      applications: number;
    }
    interface StageDurationRow {
      stage: ApplicationStage;
      avg_days: number | null;
    }
    interface OfferRow {
      extended: number;
      accepted: number;
      declined: number;
    }
    interface AiSpendRow {
      day: string;
      cost_micros: string;
      calls: number;
    }
    interface ScoreRow {
      bucket: number;
      count: number;
    }

    const funnelByStage = new Map(asRows<FunnelRow>(funnelRes).map((r) => [r.stage, r.count]));
    const durationByStage = new Map(
      asRows<StageDurationRow>(stageDurationRes).map((r) => [r.stage, r.avg_days]),
    );
    const countByBucket = new Map(asRows<ScoreRow>(scoreRes).map((r) => [r.bucket, r.count]));

    const kpi = asRows<KpiRow>(kpiRes)[0] ?? {
      applications: 0,
      active: 0,
      hired: 0,
      avg_ai_score: null,
    };
    const offer = asRows<OfferRow>(offerRes)[0] ?? { extended: 0, accepted: 0, declined: 0 };

    const scoreTier = (min: number): "platinum" | "gold" | "silver" | "neutral" => {
      if (min >= 90) return "platinum";
      if (min >= 70) return "gold";
      if (min >= 50) return "silver";
      return "neutral";
    };

    return {
      kpis: {
        applications: kpi.applications,
        active: kpi.active,
        hired: kpi.hired,
        offers_extended: offer.extended,
        avg_ai_score: kpi.avg_ai_score,
      },
      funnel: applicationStageEnum.enumValues.map((stage) => ({
        stage,
        count: funnelByStage.get(stage) ?? 0,
      })),
      timeInStage: applicationStageEnum.enumValues.map((stage) => ({
        stage,
        avg_days: durationByStage.get(stage) ?? null,
      })),
      sourceMix: asRows<SourceRow>(sourceRes).map((r) => ({
        source: r.source,
        applications: r.applications,
      })),
      offerFunnel: {
        extended: offer.extended,
        accepted: offer.accepted,
        declined: offer.declined,
      },
      aiSpend: asRows<AiSpendRow>(aiSpendRes).map((r) => ({
        day: r.day,
        cost_micros: r.cost_micros,
        calls: r.calls,
      })),
      scoreDistribution: Array.from({ length: 10 }, (_, i) => {
        const min = i * 10;
        const max = i === 9 ? 100 : min + 9;
        return {
          label: `${min}–${max}`,
          min,
          max,
          count: countByBucket.get(i) ?? 0,
          tier: scoreTier(min),
        };
      }),
    };
  }),

  // ─────────────────────── update / retire / toggle (AGENT-04a) ───────────────────────
  //
  // Versioning model (locked): edit = retire current row (retired_at =
  // now()) + insert a new row as the next version + copy
  // triggers/actions/approval_rules to the new row (new ids, FK'd to
  // the new agent). Historical agent_runs / agent_run_actions stay
  // frozen against the retired row via their existing agent_id FK.
  //
  // The copy path trusts prior validation — copied approval_rules do
  // NOT route through assertRuleAttachable. The guard is for new
  // attachments only. If a future change to actionExecutorCapabilities
  // flips a row from `true` to `false`, the historical rules attached
  // when the row was `true` keep working but no NEW rules of the same
  // shape can be attached. That's the intentional shape.
  //
  // Lineage is name-anchored: "all versions of this agent" is the
  // query `WHERE tenant_id = ? AND name = ?` (active + retired). No
  // version-group / parent_id column today (see HANDOVER note for
  // AGENT-04a). Names are NOT editable in this surface — making them
  // editable later requires revisiting the lineage proxy.

  updateFollowUpAgent: protectedProcedure
    .input(updateFollowUpAgentInputSchema)
    .output(updateFollowUpAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_follow_up_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId || !ctx.userId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId/userId",
          });
        }
        const tenantId = ctx.tenantId;

        // Resolve actor's membership for the new row's created_by FK.
        // The edit's author replaces the prior version's author on the
        // new row — "who created this version" semantics.
        const [actor] = await db
          .select({ id: tenantUserMemberships.id })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.userId, ctx.userId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!actor) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "actor membership not resolved",
          });
        }

        // 1. Load the current active row. updateFollowUpAgent only
        //    operates on active versions — retired rows are immutable.
        const [current] = await db
          .select()
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot edit a retired agent — create a new one with the same name",
          });
        }
        if (current.agentType !== "follow_up") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `updateFollowUpAgent only edits agents of type 'follow_up' (got '${current.agentType}')`,
          });
        }

        // 2. Load children for the copy. Ordered for determinism on
        //    the action copies (the rewire map depends on stable order).
        const currentTriggers = await db
          .select()
          .from(agentTriggers)
          .where(eq(agentTriggers.agentId, current.id));
        const currentActions = await db
          .select()
          .from(agentActions)
          .where(eq(agentActions.agentId, current.id))
          .orderBy(agentActions.actionOrder);
        const currentRules = await db
          .select()
          .from(agentApprovalRules)
          .where(eq(agentApprovalRules.agentId, current.id));

        // 3. Retire the old row FIRST. The partial-unique index on
        //    `(tenant_id, name) WHERE retired_at IS NULL` blocks
        //    inserting the new row with the same name until the old
        //    row's slot is freed. Order matters; all inside the
        //    protectedProcedure tx so atomic.
        const now = new Date();
        await db
          .update(automationAgents)
          .set({ retiredAt: now, updatedAt: now })
          .where(eq(automationAgents.id, current.id));

        // 4. Insert the new row at version + 1. Same name, same
        //    agent_type, current user as created_by, merged
        //    description from input (input.description=undefined →
        //    carry forward; input.description=null → explicit clear).
        const mergedDescription =
          input.description === undefined ? current.description : input.description;
        const [newAgentRow] = await db
          .insert(automationAgents)
          .values({
            tenantId,
            agentType: "follow_up",
            name: current.name,
            description: mergedDescription,
            enabled: current.enabled,
            version: current.version + 1,
            createdBy: actor.id,
          })
          .returning({ id: automationAgents.id });
        if (!newAgentRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "automation_agents new-version insert returned no row",
          });
        }
        const newAgentId = newAgentRow.id;

        // 5. Copy triggers. Follow-Up Agent has exactly one trigger of
        //    type stage_stale; merge input overrides into its config.
        for (const trig of currentTriggers) {
          const prevConfig = trig.triggerConfig as { stage?: string; days_threshold?: number };
          const mergedConfig = {
            stage: input.stage ?? prevConfig.stage,
            days_threshold: input.days_threshold ?? prevConfig.days_threshold,
          };
          await db.insert(agentTriggers).values({
            tenantId,
            agentId: newAgentId,
            triggerType: trig.triggerType,
            triggerConfig: mergedConfig,
          });
        }

        // 6. Copy actions. action_id changes per row → keep a map
        //    from old id → new id so the rule copies can rewire. Merge
        //    input.tone / input.max_tokens into the draft_message
        //    action's config; other action types carry forward
        //    unchanged.
        const actionIdMap = new Map<string, string>();
        for (const act of currentActions) {
          const prevConfig = act.actionConfig as Record<string, unknown>;
          let mergedActionConfig: Record<string, unknown> = prevConfig;
          if (act.actionType === "draft_message") {
            mergedActionConfig = {
              ...prevConfig,
              ...(input.tone !== undefined ? { tone: input.tone } : {}),
              ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
            };
          }
          const [newAct] = await db
            .insert(agentActions)
            .values({
              tenantId,
              agentId: newAgentId,
              actionOrder: act.actionOrder,
              actionType: act.actionType,
              actionConfig: mergedActionConfig,
            })
            .returning({ id: agentActions.id });
          if (!newAct) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "agent_actions copy returned no row",
            });
          }
          actionIdMap.set(act.id, newAct.id);
        }

        // 7. Copy approval rules. action_id rewires via actionIdMap;
        //    other fields carry forward verbatim. DOES NOT route
        //    through assertRuleAttachable — copies trust prior
        //    validation (locked decision).
        for (const rule of currentRules) {
          const newActionId = actionIdMap.get(rule.actionId);
          if (!newActionId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `approval_rule references action_id ${rule.actionId} not in copy map`,
            });
          }
          await db.insert(agentApprovalRules).values({
            tenantId,
            agentId: newAgentId,
            actionId: newActionId,
            approvalMode: rule.approvalMode,
            approverRole: rule.approverRole,
            approverUserId: rule.approverUserId,
            conditions: rule.conditions,
          });
        }

        return {
          agentId: newAgentId,
          previousAgentId: current.id,
          version: current.version + 1,
        };
      });
    }),

  retireFollowUpAgent: protectedProcedure
    .input(retireFollowUpAgentInputSchema)
    .output(retireFollowUpAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("retire_follow_up_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [current] = await db
          .select({
            id: automationAgents.id,
            retiredAt: automationAgents.retiredAt,
            agentType: automationAgents.agentType,
          })
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Agent is already retired",
          });
        }
        if (current.agentType !== "follow_up") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `retireFollowUpAgent only retires agents of type 'follow_up' (got '${current.agentType}')`,
          });
        }

        const now = new Date();
        await db
          .update(automationAgents)
          .set({ retiredAt: now, updatedAt: now })
          .where(eq(automationAgents.id, current.id));

        return { agentId: current.id, retiredAt: now.toISOString() };
      });
    }),

  toggleFollowUpAgent: protectedProcedure
    .input(toggleFollowUpAgentInputSchema)
    .output(toggleFollowUpAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("toggle_follow_up_agent", ctx, input, async () => {
        requireAnyRole(ctx, USERS_ADMIN_ROLES, "Agent workflows are admin-only");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [current] = await db
          .select({
            id: automationAgents.id,
            enabled: automationAgents.enabled,
            retiredAt: automationAgents.retiredAt,
            agentType: automationAgents.agentType,
          })
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot toggle a retired agent",
          });
        }
        if (current.agentType !== "follow_up") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `toggleFollowUpAgent only toggles agents of type 'follow_up' (got '${current.agentType}')`,
          });
        }

        // No-op if already in the requested state — still write so
        // updated_at moves and the audit trail records the request,
        // even when state doesn't change. Actually: skip the write
        // when state matches, because the audit trigger short-circuits
        // no-op UPDATEs anyway (v_before = v_after RETURN NULL). The
        // explicit early return makes intent clearer.
        if (current.enabled === input.enabled) {
          return { agentId: current.id, enabled: current.enabled };
        }

        await db
          .update(automationAgents)
          .set({ enabled: input.enabled, updatedAt: new Date() })
          .where(eq(automationAgents.id, current.id));

        return { agentId: current.id, enabled: input.enabled };
      });
    }),

  // ─────────────────────── Scheduling agent CRUD (AGENT-04b) ───────────────────────
  //
  // Replicates the AGENT-04a Follow-Up lifecycle (create / update-versioned /
  // retire / toggle) for the Scheduling agent type. Versioning model identical
  // to 04a's locked retire-and-insert + child-copy + action_id rewire pattern;
  // the only differences are the curated trigger/action subset and the
  // input-config merge shape. Copies bypass assertRuleAttachable (copy trusts
  // prior validation — locked decision). Create path runs the guard (the
  // human_optional rule on propose_calendar_slots is permitted by the
  // AGENT-04b capability flip; that's the flip paying off end-to-end here).
  //
  // listAgents is type-agnostic (no agent_type filter — confirmed via the
  // existing SELECT at the listAgents procedure above; `WHERE aa.retired_at
  // IS NULL` is the only filter), so Scheduling agents appear in the list
  // automatically once their automation_agents row is inserted.

  createSchedulingAgent: protectedProcedure
    .input(createSchedulingAgentInputSchema)
    .output(createSchedulingAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("create_scheduling_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId || !ctx.userId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId/userId",
          });
        }
        const tenantId = ctx.tenantId;

        const [membership] = await db
          .select({ id: tenantUserMemberships.id })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.userId, ctx.userId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!membership) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "actor membership not resolved",
          });
        }

        // #102 retrofit pattern from AGENT-04a — INSERT ... ON CONFLICT
        // DO NOTHING RETURNING id against the partial-unique active-name
        // index. Empty result means a concurrent active agent already
        // holds this name → clean BAD_REQUEST, no SELECT pre-check.
        const agentInsert = await db
          .insert(automationAgents)
          .values({
            tenantId,
            agentType: "scheduling",
            name: input.name,
            description: input.description ?? null,
            enabled: true,
            version: 1,
            createdBy: membership.id,
          })
          .onConflictDoNothing({
            target: [automationAgents.tenantId, automationAgents.name],
            where: dsql`retired_at IS NULL`,
          })
          .returning({ id: automationAgents.id });
        if (agentInsert.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `An active agent named "${input.name}" already exists`,
          });
        }
        const agentRow = agentInsert[0];
        if (!agentRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "automation_agents insert returned no row",
          });
        }
        const agentId = agentRow.id;

        // Trigger: stage_entered on `shortlisted` (or the override).
        // Per the agent-configs Zod discriminator, stage_entered
        // config is { type, stage }; the `type` field is stored
        // implicitly via the row's `trigger_type` column.
        await db.insert(agentTriggers).values({
          tenantId,
          agentId,
          triggerType: "stage_entered",
          triggerConfig: { stage: input.stage },
        });

        // Action 1: propose_calendar_slots — config carries HR's panel
        // + slot-shape knobs. action_order=1 so the create_calendar_event
        // that follows can reference it via source_action_ref="1".
        const [proposeAction] = await db
          .insert(agentActions)
          .values({
            tenantId,
            agentId,
            actionOrder: 1,
            actionType: "propose_calendar_slots",
            actionConfig: {
              panel_id: input.panel_id,
              slot_count: input.slot_count,
              window_days: input.window_days,
              duration_minutes: input.duration_minutes,
            },
          })
          .returning({ id: agentActions.id });
        const [bookAction] = await db
          .insert(agentActions)
          .values({
            tenantId,
            agentId,
            actionOrder: 2,
            actionType: "create_calendar_event",
            actionConfig: {
              panel_id: input.panel_id,
              source_action_ref: "1",
            },
          })
          .returning({ id: agentActions.id });
        if (!proposeAction || !bookAction) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "agent_actions insert returned no row",
          });
        }

        // Approval rule for propose_calendar_slots ONLY. The
        // AGENT-04b capability flip makes propose_calendar_slots
        // requiresApprovalCapable=true; ensureRuleAttachable accepts
        // the human_optional rule below where pre-flip it would have
        // rejected with BAD_REQUEST. create_calendar_event gets NO
        // rule — the worker drain treats missing-rule as auto-mode
        // (`rule?.approval_mode ?? "auto"`), so the event books
        // autonomously once slots are settled. Deliberate omission.
        ensureRuleAttachable("propose_calendar_slots", "human_optional");
        await db.insert(agentApprovalRules).values({
          tenantId,
          agentId,
          actionId: proposeAction.id,
          approvalMode: "human_optional",
          approverRole: "owning_recruiter",
        });

        return { agentId };
      });
    }),

  updateSchedulingAgent: protectedProcedure
    .input(updateSchedulingAgentInputSchema)
    .output(updateSchedulingAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_scheduling_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId || !ctx.userId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId/userId",
          });
        }
        const tenantId = ctx.tenantId;

        const [actor] = await db
          .select({ id: tenantUserMemberships.id })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.userId, ctx.userId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!actor) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "actor membership not resolved",
          });
        }

        const [current] = await db
          .select()
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot edit a retired agent — create a new one with the same name",
          });
        }
        if (current.agentType !== "scheduling") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `updateSchedulingAgent only edits agents of type 'scheduling' (got '${current.agentType}')`,
          });
        }

        const currentTriggers = await db
          .select()
          .from(agentTriggers)
          .where(eq(agentTriggers.agentId, current.id));
        const currentActions = await db
          .select()
          .from(agentActions)
          .where(eq(agentActions.agentId, current.id))
          .orderBy(agentActions.actionOrder);
        const currentRules = await db
          .select()
          .from(agentApprovalRules)
          .where(eq(agentApprovalRules.agentId, current.id));

        // Retire current row FIRST — partial-unique active-name slot
        // must be freed before the new-version INSERT (same as 04a).
        const now = new Date();
        await db
          .update(automationAgents)
          .set({ retiredAt: now, updatedAt: now })
          .where(eq(automationAgents.id, current.id));

        const mergedDescription =
          input.description === undefined ? current.description : input.description;
        const [newAgentRow] = await db
          .insert(automationAgents)
          .values({
            tenantId,
            agentType: "scheduling",
            name: current.name,
            description: mergedDescription,
            enabled: current.enabled,
            version: current.version + 1,
            createdBy: actor.id,
          })
          .returning({ id: automationAgents.id });
        if (!newAgentRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "automation_agents new-version insert returned no row",
          });
        }
        const newAgentId = newAgentRow.id;

        // 5. Copy triggers. Scheduling has one trigger of type
        //    stage_entered; merge input.stage into its config.
        for (const trig of currentTriggers) {
          const prevConfig = trig.triggerConfig as { stage?: string };
          const mergedConfig = {
            stage: input.stage ?? prevConfig.stage,
          };
          await db.insert(agentTriggers).values({
            tenantId,
            agentId: newAgentId,
            triggerType: trig.triggerType,
            triggerConfig: mergedConfig,
          });
        }

        // 6. Copy actions. action_id changes per row → actionIdMap
        //    rewires the rule copies. Merge input deltas into
        //    propose_calendar_slots (the HR-configurable knobs);
        //    create_calendar_event picks up panel_id if HR changed
        //    it, source_action_ref carries forward unchanged.
        const actionIdMap = new Map<string, string>();
        for (const act of currentActions) {
          const prevConfig = act.actionConfig as Record<string, unknown>;
          let mergedActionConfig: Record<string, unknown> = prevConfig;
          if (act.actionType === "propose_calendar_slots") {
            mergedActionConfig = {
              ...prevConfig,
              ...(input.panel_id !== undefined ? { panel_id: input.panel_id } : {}),
              ...(input.slot_count !== undefined ? { slot_count: input.slot_count } : {}),
              ...(input.window_days !== undefined ? { window_days: input.window_days } : {}),
              ...(input.duration_minutes !== undefined
                ? { duration_minutes: input.duration_minutes }
                : {}),
            };
          } else if (act.actionType === "create_calendar_event") {
            mergedActionConfig = {
              ...prevConfig,
              ...(input.panel_id !== undefined ? { panel_id: input.panel_id } : {}),
            };
          }
          const [newAct] = await db
            .insert(agentActions)
            .values({
              tenantId,
              agentId: newAgentId,
              actionOrder: act.actionOrder,
              actionType: act.actionType,
              actionConfig: mergedActionConfig,
            })
            .returning({ id: agentActions.id });
          if (!newAct) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "agent_actions copy returned no row",
            });
          }
          actionIdMap.set(act.id, newAct.id);
        }

        // 7. Copy approval rules. action_id rewires via actionIdMap;
        //    other fields carry forward verbatim. DOES NOT route
        //    through assertRuleAttachable — copies trust prior
        //    validation (locked decision; byte-identical to 04a).
        for (const rule of currentRules) {
          const newActionId = actionIdMap.get(rule.actionId);
          if (!newActionId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `approval_rule references action_id ${rule.actionId} not in copy map`,
            });
          }
          await db.insert(agentApprovalRules).values({
            tenantId,
            agentId: newAgentId,
            actionId: newActionId,
            approvalMode: rule.approvalMode,
            approverRole: rule.approverRole,
            approverUserId: rule.approverUserId,
            conditions: rule.conditions,
          });
        }

        return {
          agentId: newAgentId,
          previousAgentId: current.id,
          version: current.version + 1,
        };
      });
    }),

  retireSchedulingAgent: protectedProcedure
    .input(retireSchedulingAgentInputSchema)
    .output(retireSchedulingAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("retire_scheduling_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [current] = await db
          .select({
            id: automationAgents.id,
            retiredAt: automationAgents.retiredAt,
            agentType: automationAgents.agentType,
          })
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Agent is already retired" });
        }
        if (current.agentType !== "scheduling") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `retireSchedulingAgent only retires agents of type 'scheduling' (got '${current.agentType}')`,
          });
        }

        const now = new Date();
        await db
          .update(automationAgents)
          .set({ retiredAt: now, updatedAt: now })
          .where(eq(automationAgents.id, current.id));

        return { agentId: current.id, retiredAt: now.toISOString() };
      });
    }),

  toggleSchedulingAgent: protectedProcedure
    .input(toggleSchedulingAgentInputSchema)
    .output(toggleSchedulingAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("toggle_scheduling_agent", ctx, input, async () => {
        requireAnyRole(ctx, USERS_ADMIN_ROLES, "Agent workflows are admin-only");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [current] = await db
          .select({
            id: automationAgents.id,
            enabled: automationAgents.enabled,
            retiredAt: automationAgents.retiredAt,
            agentType: automationAgents.agentType,
          })
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot toggle a retired agent" });
        }
        if (current.agentType !== "scheduling") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `toggleSchedulingAgent only toggles agents of type 'scheduling' (got '${current.agentType}')`,
          });
        }

        if (current.enabled === input.enabled) {
          return { agentId: current.id, enabled: current.enabled };
        }

        await db
          .update(automationAgents)
          .set({ enabled: input.enabled, updatedAt: new Date() })
          .where(eq(automationAgents.id, current.id));

        return { agentId: current.id, enabled: input.enabled };
      });
    }),

  // ─────────────────────── Candidate Q&A agent CRUD (AGENT-04b) ───────────────────────
  //
  // Mirrors the confirmed Scheduling template structurally. No
  // capability-map changes — both action types (draft_message,
  // send_message) already carry their AGENT-04a / AGENT-03
  // capability declarations. The create-path guard accepts the
  // human_required rule on send_message because send_message is
  // requiresApprovalCapable=true (set in AGENT-03 when the executor
  // was flipped for the approval cycle).
  //
  // Trigger shape differs from the other types: message_received's
  // config is fully locked at AGENT-01a (`channel='email'`,
  // `from='candidate'` are both literal-typed in
  // MessageReceivedTriggerConfigSchema), so the updateCandidateQaAgent
  // triggers loop carries the trigger config forward verbatim — there
  // are no HR-overridable trigger fields to merge from input. The
  // empty-merge clause keeps structural symmetry with the other
  // update procedures.

  createCandidateQaAgent: protectedProcedure
    .input(createCandidateQaAgentInputSchema)
    .output(createCandidateQaAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("create_candidate_qa_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId || !ctx.userId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId/userId",
          });
        }
        const tenantId = ctx.tenantId;

        const [membership] = await db
          .select({ id: tenantUserMemberships.id })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.userId, ctx.userId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!membership) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "actor membership not resolved",
          });
        }

        // #102 retrofit pattern from AGENT-04a — INSERT ... ON CONFLICT
        // DO NOTHING RETURNING id, empty-result → BAD_REQUEST.
        const agentInsert = await db
          .insert(automationAgents)
          .values({
            tenantId,
            agentType: "candidate_qa",
            name: input.name,
            description: input.description ?? null,
            enabled: true,
            version: 1,
            createdBy: membership.id,
          })
          .onConflictDoNothing({
            target: [automationAgents.tenantId, automationAgents.name],
            where: dsql`retired_at IS NULL`,
          })
          .returning({ id: automationAgents.id });
        if (agentInsert.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `An active agent named "${input.name}" already exists`,
          });
        }
        const agentRow = agentInsert[0];
        if (!agentRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "automation_agents insert returned no row",
          });
        }
        const agentId = agentRow.id;

        // Trigger: message_received. AGENT-01a locks channel='email'
        // and from='candidate' as Zod literals; later tickets relax to
        // other channels and senders.
        await db.insert(agentTriggers).values({
          tenantId,
          agentId,
          triggerType: "message_received",
          triggerConfig: { channel: "email", from: "candidate" },
        });

        // Action 1: draft_message — HR's tone + max_tokens knobs;
        // curated template_prompt_id = "candidate_qa_v1".
        const [draftAction] = await db
          .insert(agentActions)
          .values({
            tenantId,
            agentId,
            actionOrder: 1,
            actionType: "draft_message",
            actionConfig: {
              template_prompt_id: "candidate_qa_v1",
              tone: input.tone,
              max_tokens: input.max_tokens,
            },
          })
          .returning({ id: agentActions.id });
        // Action 2: send_message — curated channel/outbox_kind defaults.
        // requires_approval flag stays in the config (HR-visible field
        // per the schema's ConfigSchema), even though the runtime gate
        // is owned by the approval_rule below.
        const [sendAction] = await db
          .insert(agentActions)
          .values({
            tenantId,
            agentId,
            actionOrder: 2,
            actionType: "send_message",
            actionConfig: {
              channel: "email",
              outbox_kind: "candidate_qa_reply",
              requires_approval: true,
            },
          })
          .returning({ id: agentActions.id });
        if (!draftAction || !sendAction) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "agent_actions insert returned no row",
          });
        }

        // Approval rule on send_message ONLY. draft_message has no
        // rule (worker treats missing-rule as auto-mode). send_message
        // is requiresApprovalCapable=true since AGENT-03's executor
        // flip; the guard accepts the human_required attachment here.
        // The pattern is symmetric with the Follow-Up agent's send
        // rule (same approver_role convention).
        ensureRuleAttachable("send_message", "human_required");
        await db.insert(agentApprovalRules).values({
          tenantId,
          agentId,
          actionId: sendAction.id,
          approvalMode: "human_required",
          approverRole: "owning_recruiter",
        });

        return { agentId };
      });
    }),

  updateCandidateQaAgent: protectedProcedure
    .input(updateCandidateQaAgentInputSchema)
    .output(updateCandidateQaAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_candidate_qa_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId || !ctx.userId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId/userId",
          });
        }
        const tenantId = ctx.tenantId;

        const [actor] = await db
          .select({ id: tenantUserMemberships.id })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.userId, ctx.userId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!actor) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "actor membership not resolved",
          });
        }

        const [current] = await db
          .select()
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot edit a retired agent — create a new one with the same name",
          });
        }
        if (current.agentType !== "candidate_qa") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `updateCandidateQaAgent only edits agents of type 'candidate_qa' (got '${current.agentType}')`,
          });
        }

        const currentTriggers = await db
          .select()
          .from(agentTriggers)
          .where(eq(agentTriggers.agentId, current.id));
        const currentActions = await db
          .select()
          .from(agentActions)
          .where(eq(agentActions.agentId, current.id))
          .orderBy(agentActions.actionOrder);
        const currentRules = await db
          .select()
          .from(agentApprovalRules)
          .where(eq(agentApprovalRules.agentId, current.id));

        // Retire current row FIRST — free the partial-unique active-
        // name slot before the new-version INSERT (locked 04a order).
        const now = new Date();
        await db
          .update(automationAgents)
          .set({ retiredAt: now, updatedAt: now })
          .where(eq(automationAgents.id, current.id));

        const mergedDescription =
          input.description === undefined ? current.description : input.description;
        const [newAgentRow] = await db
          .insert(automationAgents)
          .values({
            tenantId,
            agentType: "candidate_qa",
            name: current.name,
            description: mergedDescription,
            enabled: current.enabled,
            version: current.version + 1,
            createdBy: actor.id,
          })
          .returning({ id: automationAgents.id });
        if (!newAgentRow) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "automation_agents new-version insert returned no row",
          });
        }
        const newAgentId = newAgentRow.id;

        // 5. Copy triggers. Candidate Q&A's message_received trigger
        //    has no HR-overridable fields (channel + from are literal-
        //    typed in MessageReceivedTriggerConfigSchema), so the
        //    config carries forward verbatim. The empty-merge clause
        //    preserves the structural pattern of the other update
        //    procedures (Follow-Up merges stage/days_threshold;
        //    Scheduling merges stage; Candidate Q&A merges nothing).
        for (const trig of currentTriggers) {
          const prevConfig = trig.triggerConfig as Record<string, unknown>;
          const mergedConfig = prevConfig;
          await db.insert(agentTriggers).values({
            tenantId,
            agentId: newAgentId,
            triggerType: trig.triggerType,
            triggerConfig: mergedConfig,
          });
        }

        // 6. Copy actions. action_id changes per row → actionIdMap
        //    rewires the rule copies. Merge input deltas into
        //    draft_message's tone/max_tokens (the HR-configurable
        //    knobs); send_message carries forward unchanged.
        const actionIdMap = new Map<string, string>();
        for (const act of currentActions) {
          const prevConfig = act.actionConfig as Record<string, unknown>;
          let mergedActionConfig: Record<string, unknown> = prevConfig;
          if (act.actionType === "draft_message") {
            mergedActionConfig = {
              ...prevConfig,
              ...(input.tone !== undefined ? { tone: input.tone } : {}),
              ...(input.max_tokens !== undefined ? { max_tokens: input.max_tokens } : {}),
            };
          }
          const [newAct] = await db
            .insert(agentActions)
            .values({
              tenantId,
              agentId: newAgentId,
              actionOrder: act.actionOrder,
              actionType: act.actionType,
              actionConfig: mergedActionConfig,
            })
            .returning({ id: agentActions.id });
          if (!newAct) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "agent_actions copy returned no row",
            });
          }
          actionIdMap.set(act.id, newAct.id);
        }

        // 7. Copy approval rules. action_id rewires via actionIdMap;
        //    other fields carry forward verbatim. DOES NOT route
        //    through assertRuleAttachable — copies trust prior
        //    validation (locked decision; byte-identical to 04a /
        //    Scheduling).
        for (const rule of currentRules) {
          const newActionId = actionIdMap.get(rule.actionId);
          if (!newActionId) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `approval_rule references action_id ${rule.actionId} not in copy map`,
            });
          }
          await db.insert(agentApprovalRules).values({
            tenantId,
            agentId: newAgentId,
            actionId: newActionId,
            approvalMode: rule.approvalMode,
            approverRole: rule.approverRole,
            approverUserId: rule.approverUserId,
            conditions: rule.conditions,
          });
        }

        return {
          agentId: newAgentId,
          previousAgentId: current.id,
          version: current.version + 1,
        };
      });
    }),

  retireCandidateQaAgent: protectedProcedure
    .input(retireCandidateQaAgentInputSchema)
    .output(retireCandidateQaAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("retire_candidate_qa_agent", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [current] = await db
          .select({
            id: automationAgents.id,
            retiredAt: automationAgents.retiredAt,
            agentType: automationAgents.agentType,
          })
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Agent is already retired" });
        }
        if (current.agentType !== "candidate_qa") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `retireCandidateQaAgent only retires agents of type 'candidate_qa' (got '${current.agentType}')`,
          });
        }

        const now = new Date();
        await db
          .update(automationAgents)
          .set({ retiredAt: now, updatedAt: now })
          .where(eq(automationAgents.id, current.id));

        return { agentId: current.id, retiredAt: now.toISOString() };
      });
    }),

  toggleCandidateQaAgent: protectedProcedure
    .input(toggleCandidateQaAgentInputSchema)
    .output(toggleCandidateQaAgentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("toggle_candidate_qa_agent", ctx, input, async () => {
        requireAnyRole(ctx, USERS_ADMIN_ROLES, "Agent workflows are admin-only");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [current] = await db
          .select({
            id: automationAgents.id,
            enabled: automationAgents.enabled,
            retiredAt: automationAgents.retiredAt,
            agentType: automationAgents.agentType,
          })
          .from(automationAgents)
          .where(
            and(eq(automationAgents.id, input.agentId), eq(automationAgents.tenantId, tenantId)),
          )
          .limit(1);
        if (!current) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        }
        if (current.retiredAt !== null) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot toggle a retired agent" });
        }
        if (current.agentType !== "candidate_qa") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `toggleCandidateQaAgent only toggles agents of type 'candidate_qa' (got '${current.agentType}')`,
          });
        }

        if (current.enabled === input.enabled) {
          return { agentId: current.id, enabled: current.enabled };
        }

        await db
          .update(automationAgents)
          .set({ enabled: input.enabled, updatedAt: new Date() })
          .where(eq(automationAgents.id, current.id));

        return { agentId: current.id, enabled: input.enabled };
      });
    }),

  // ─────────────────────── approval-resolution (AGENT-03) ───────────────────────
  //
  // Four mutation procedures that resolve a pending agent_approval_request:
  //   approveApproval         — accept the proposed payload as-is
  //   approveApprovalWithEdit — accept after editing the payload
  //   rejectApproval          — terminal failure
  //   snoozeApproval          — defer 24h, keeps status='pending'
  //
  // Atomicity: protectedProcedure opens a single withTenantContext tx, so
  // the 4-row state writes (approval_request + run_action + run + outbox)
  // either all commit together or all roll back. No poolSql.begin needed
  // here — db is already the tx-bound Drizzle client.
  //
  // Audit: the audit_record_change() trigger fires on the approval_request
  // UPDATE (see migration 0041 — INSERT OR UPDATE OR DELETE, no WHERE
  // clause). api_audit_logs (intent-level) is written by withAudit.

  approveApproval: protectedProcedure
    .input(approveApprovalInputSchema)
    .output(approveApprovalOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("approve_approval", ctx, input, async () => {
        const db = requireDb(ctx);
        const ar = await loadPendingApprovalForResolution(db, input.approvalRequestId);
        await ensureCanResolveApproval(db, ctx, ar);

        const membershipId = await resolveActorMembership(db, ctx);
        const now = new Date();

        await db
          .update(agentApprovalRequests)
          .set({
            status: "approved",
            decidedAt: now,
            decidedByUserId: membershipId,
            decisionNotes: input.decisionNotes ?? null,
          })
          .where(eq(agentApprovalRequests.id, ar.id));

        // Output unchanged — the worker will read the original draft from
        // agent_run_actions.output that the awaiting transition recorded.
        await db
          .update(agentRunActions)
          .set({ status: "completed", completedAt: now })
          .where(eq(agentRunActions.id, ar.runActionId));

        await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, ar.runId));

        // Re-queue the outbox for the worker. status='pending' brings the
        // row back into polling rotation; locked_until=NULL is defensive
        // (the worker uses the OR (locked_until IS NULL OR < now()) clause
        // anyway, but stale lock state on a re-queued row would surprise).
        await db
          .update(agentRunOutbox)
          .set({ status: "pending", lockedUntil: null })
          .where(
            and(
              eq(agentRunOutbox.tenantId, ar.tenantId),
              eq(agentRunOutbox.agentId, ar.agentId),
              eq(agentRunOutbox.status, "awaiting_approval"),
            ),
          );

        return { status: "approved" as const, runId: ar.runId };
      });
    }),

  approveApprovalWithEdit: protectedProcedure
    .input(approveApprovalWithEditInputSchema)
    .output(approveApprovalWithEditOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("approve_approval_with_edit", ctx, input, async () => {
        const db = requireDb(ctx);
        const ar = await loadPendingApprovalForResolution(db, input.approvalRequestId);
        await ensureCanResolveApproval(db, ctx, ar);

        const membershipId = await resolveActorMembership(db, ctx);
        const now = new Date();

        await db
          .update(agentApprovalRequests)
          .set({
            status: "approved",
            decidedAt: now,
            decidedByUserId: membershipId,
            decisionNotes: input.decisionNotes ?? null,
            editedPayload: input.editedPayload,
          })
          .where(eq(agentApprovalRequests.id, ar.id));

        // Copy edited payload into agent_run_actions.output. On resume,
        // the worker reads this column directly and skips re-execution.
        // The original proposed_action_payload stays on the approval
        // request for the audit triple (proposed + edited + final).
        await db
          .update(agentRunActions)
          .set({ status: "completed", completedAt: now, output: input.editedPayload })
          .where(eq(agentRunActions.id, ar.runActionId));

        await db.update(agentRuns).set({ status: "running" }).where(eq(agentRuns.id, ar.runId));

        await db
          .update(agentRunOutbox)
          .set({ status: "pending", lockedUntil: null })
          .where(
            and(
              eq(agentRunOutbox.tenantId, ar.tenantId),
              eq(agentRunOutbox.agentId, ar.agentId),
              eq(agentRunOutbox.status, "awaiting_approval"),
            ),
          );

        return { status: "approved" as const, runId: ar.runId };
      });
    }),

  rejectApproval: protectedProcedure
    .input(rejectApprovalInputSchema)
    .output(rejectApprovalOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("reject_approval", ctx, input, async () => {
        const db = requireDb(ctx);
        const ar = await loadPendingApprovalForResolution(db, input.approvalRequestId);
        await ensureCanResolveApproval(db, ctx, ar);

        const membershipId = await resolveActorMembership(db, ctx);
        const now = new Date();
        const errorMsg = `Approval rejected: ${input.decisionNotes}`;

        await db
          .update(agentApprovalRequests)
          .set({
            status: "rejected",
            decidedAt: now,
            decidedByUserId: membershipId,
            decisionNotes: input.decisionNotes,
          })
          .where(eq(agentApprovalRequests.id, ar.id));

        // run_action marked failed (not 'skipped' — skipped is for downstream
        // actions implicitly bypassed; the rejected action itself failed).
        await db
          .update(agentRunActions)
          .set({ status: "failed", completedAt: now, error: errorMsg })
          .where(eq(agentRunActions.id, ar.runActionId));

        await db
          .update(agentRuns)
          .set({
            status: "rejected",
            completedAt: now,
            error: `Approval rejected at action ${ar.actionOrder}`,
          })
          .where(eq(agentRuns.id, ar.runId));

        // Outbox terminal-failed. Worker won't re-pick it up (status is
        // not 'pending'). Run does NOT resume — rejection is terminal.
        await db
          .update(agentRunOutbox)
          .set({
            status: "failed",
            completedAt: now,
            lastError: "Approval rejected",
          })
          .where(
            and(
              eq(agentRunOutbox.tenantId, ar.tenantId),
              eq(agentRunOutbox.agentId, ar.agentId),
              eq(agentRunOutbox.status, "awaiting_approval"),
            ),
          );

        return { status: "rejected" as const, runId: ar.runId };
      });
    }),

  snoozeApproval: protectedProcedure
    .input(snoozeApprovalInputSchema)
    .output(snoozeApprovalOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("snooze_approval", ctx, input, async () => {
        const db = requireDb(ctx);
        const ar = await loadPendingApprovalForResolution(db, input.approvalRequestId);
        // Any authorised recruiter (per approver_role) can snooze. Same
        // role gate as approve/reject — snoozing past a decision deadline
        // is still a decision affecting the run.
        await ensureCanResolveApproval(db, ctx, ar);

        // Snooze sets ttl_at unconditionally — works for both
        // human_required (the TTL scan clears it without auto-approving)
        // and human_optional (the TTL scan auto-approves at expiry).
        // Status stays 'pending'.
        const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await db
          .update(agentApprovalRequests)
          .set({ ttlAt: snoozedUntil })
          .where(eq(agentApprovalRequests.id, ar.id));

        return { status: "pending" as const, snoozedUntil: snoozedUntil.toISOString() };
      });
    }),

  // ─────────────────────── approval queue listing (AGENT-03) ───────────────────────

  listPendingApprovals: protectedProcedure
    .input(listPendingApprovalsInputSchema)
    .output(listPendingApprovalsOutputSchema)
    .query(async ({ ctx, input }) => {
      // RBAC-01 — the agent-draft approval queue is a recruiter surface.
      requireAnyRole(ctx, RECRUITER_SURFACE_ROLES, "Approvals are not available for your role");
      const db = requireDb(ctx);
      // Cursor is the proposed_at of the last row from the previous page —
      // strict-greater-than walks forward, no OFFSET cost. Limit +1 lets
      // us know whether more rows exist beyond the page.
      const limit = input.limit;
      const cursorDate = input.cursor ? new Date(input.cursor) : null;

      const result = await db.execute(dsql`
        SELECT
          ar.id::text AS id,
          ar.run_id::text AS run_id,
          ar.agent_id::text AS agent_id,
          aa.name AS agent_name,
          aa.agent_type AS agent_type,
          ar.proposed_at,
          ar.proposed_action_summary,
          ar.proposed_action_payload,
          run.trigger_context,
          ar.approver_role,
          ar.ttl_at,
          run.cost_micros::text AS cost_micros
        FROM public.agent_approval_requests ar
        JOIN public.automation_agents aa ON aa.id = ar.agent_id AND aa.tenant_id = ar.tenant_id
        JOIN public.agent_runs run ON run.id = ar.run_id AND run.tenant_id = ar.tenant_id
        -- SEED-02 Problem 3: mirror getApprovalRequest's INNER joins so the queue
        -- only lists rows the detail view can open. A pending approval whose
        -- run_action link or underlying action definition is gone (test/agent
        -- residue) would otherwise list here but 404 on open ("Couldn't load this
        -- approval…"). Join-guarding the read excludes those orphans at the source.
        JOIN public.agent_run_actions run_act
          ON run_act.id = ar.run_action_id AND run_act.tenant_id = ar.tenant_id
        JOIN public.agent_actions act
          ON act.id = run_act.action_id AND act.tenant_id = ar.tenant_id
        WHERE ar.status = 'pending'
          ${input.agentId ? dsql`AND ar.agent_id = ${input.agentId}::uuid` : dsql``}
          ${cursorDate ? dsql`AND ar.proposed_at > ${cursorDate}` : dsql``}
        ORDER BY ar.proposed_at ASC
        LIMIT ${limit + 1}
      `);

      interface Row {
        id: string;
        run_id: string;
        agent_id: string;
        agent_name: string;
        agent_type: string;
        proposed_at: Date | string;
        proposed_action_summary: string;
        proposed_action_payload: Record<string, unknown>;
        trigger_context: Record<string, unknown>;
        approver_role: string;
        ttl_at: Date | string | null;
        cost_micros: string;
      }
      const rows = (result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[]);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: PendingApprovalItem[] = pageRows.map((r) => ({
        id: r.id,
        runId: r.run_id,
        agentId: r.agent_id,
        agentName: r.agent_name,
        agentType: r.agent_type,
        proposedAt: toIsoString(r.proposed_at) ?? new Date(0).toISOString(),
        proposedActionSummary: r.proposed_action_summary,
        proposedActionPayload: r.proposed_action_payload,
        triggerContext: r.trigger_context,
        approverRole: r.approver_role,
        snoozedUntil: toIsoString(r.ttl_at),
        costMicrosSoFar: r.cost_micros,
      }));

      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor = hasMore && lastRow ? toIsoString(lastRow.proposed_at) : null;

      return { items, nextCursor };
    }),

  getApprovalRequest: protectedProcedure
    .input(getApprovalRequestInputSchema)
    .output(getApprovalRequestOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = requireDb(ctx);
      // Single query joins everything the detail surface needs — agent,
      // trigger, the run's action being approved, and the approval_rule
      // for approval_mode. previousActions are fetched separately.
      const detailRes = await db.execute(dsql`
        SELECT
          ar.id::text AS id,
          ar.run_id::text AS run_id,
          ar.agent_id::text AS agent_id,
          aa.name AS agent_name,
          aa.agent_type AS agent_type,
          aa.description AS agent_description,
          ar.proposed_at,
          ar.proposed_action_summary,
          ar.proposed_action_payload,
          run.trigger_context,
          ar.approver_role,
          ar.ttl_at,
          run.cost_micros::text AS cost_micros,
          trig.trigger_type,
          trig.trigger_config,
          act.action_type,
          act.action_config,
          rule.approval_mode,
          run_act.action_order::int AS action_order
        FROM public.agent_approval_requests ar
        JOIN public.automation_agents aa ON aa.id = ar.agent_id AND aa.tenant_id = ar.tenant_id
        JOIN public.agent_runs run ON run.id = ar.run_id AND run.tenant_id = ar.tenant_id
        JOIN public.agent_run_actions run_act
          ON run_act.id = ar.run_action_id AND run_act.tenant_id = ar.tenant_id
        JOIN public.agent_actions act
          ON act.id = run_act.action_id AND act.tenant_id = ar.tenant_id
        LEFT JOIN public.agent_triggers trig
          ON trig.agent_id = ar.agent_id AND trig.tenant_id = ar.tenant_id
        LEFT JOIN public.agent_approval_rules rule
          ON rule.action_id = act.id AND rule.tenant_id = ar.tenant_id
        WHERE ar.id = ${input.approvalRequestId}::uuid
        LIMIT 1
      `);

      interface DetailRow {
        id: string;
        run_id: string;
        agent_id: string;
        agent_name: string;
        agent_type: string;
        agent_description: string | null;
        proposed_at: Date | string;
        proposed_action_summary: string;
        proposed_action_payload: Record<string, unknown>;
        trigger_context: Record<string, unknown>;
        approver_role: string;
        ttl_at: Date | string | null;
        cost_micros: string;
        trigger_type: string;
        trigger_config: Record<string, unknown>;
        action_type: string;
        action_config: Record<string, unknown>;
        approval_mode: "auto" | "human_required" | "human_optional";
        action_order: number;
      }
      const detailRows =
        (detailRes as unknown as { rows?: DetailRow[] }).rows ??
        (detailRes as unknown as DetailRow[]);
      const detail = detailRows[0];
      if (!detail) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
      }

      // Previous actions in the same run, ordered by action_order. We include
      // the request's own run_action too — caller decides whether to render
      // it as "the pending one" or hide it.
      const prevRes = await db.execute(dsql`
        SELECT
          run_act.action_order::int AS action_order,
          act.action_type AS action_type,
          run_act.status,
          run_act.output,
          run_act.completed_at
        FROM public.agent_run_actions run_act
        JOIN public.agent_actions act
          ON act.id = run_act.action_id AND act.tenant_id = run_act.tenant_id
        WHERE run_act.run_id = ${detail.run_id}::uuid
        ORDER BY run_act.action_order ASC
      `);
      interface PrevRow {
        action_order: number;
        action_type: string;
        status: string;
        output: Record<string, unknown> | null;
        completed_at: Date | string | null;
      }
      const prevRows =
        (prevRes as unknown as { rows?: PrevRow[] }).rows ?? (prevRes as unknown as PrevRow[]);

      const out: GetApprovalRequestOutput = {
        id: detail.id,
        runId: detail.run_id,
        agentId: detail.agent_id,
        agentName: detail.agent_name,
        agentType: detail.agent_type,
        proposedAt: toIsoString(detail.proposed_at) ?? new Date(0).toISOString(),
        proposedActionSummary: detail.proposed_action_summary,
        proposedActionPayload: detail.proposed_action_payload,
        triggerContext: detail.trigger_context,
        approverRole: detail.approver_role,
        snoozedUntil: toIsoString(detail.ttl_at),
        costMicrosSoFar: detail.cost_micros,
        agentDescription: detail.agent_description,
        triggerType: detail.trigger_type,
        triggerConfig: detail.trigger_config,
        actionType: detail.action_type,
        actionConfig: detail.action_config,
        approvalMode: detail.approval_mode,
        previousActions: prevRows.map((p) => ({
          actionOrder: p.action_order,
          actionType: p.action_type,
          status: p.status,
          output: p.output,
          completedAt: toIsoString(p.completed_at),
        })),
      };
      return out;
    }),

  // ─────────────────────── onboarding cases (ONBOARD-02) ───────────────────────
  //
  // Internal onboarding surface. All procedures are protectedProcedure — a
  // JWT-resolved tenant member (recruiter / hr_ops / people_ops / admin);
  // candidates never reach these (they use the public offer routes). This
  // matches the dominant router convention (listAgents, draftOffer, …): the
  // tenant tx + RLS is the gate; no finer role set is invented here. Reads
  // run through ctx.db (RLS-scoped) so tenant isolation is enforced by the
  // database, plus an explicit eq(tenantId) matching listAuditEvents.

  /**
   * listTenantMemberships — the buddy/manager assignment pickers (ONBOARD-04).
   * Returns active members of the caller's tenant with id + display name +
   * email + roles. Goes through ctx.sql (service-role, explicit tenant_id)
   * rather than ctx.db because RLS on public.users is self-only — an
   * RLS-scoped join would return every OTHER member's name as null. Tenant
   * isolation is enforced by the explicit `tum.tenant_id = ${tenantId}` on a
   * JWT-resolved tenantId, matching onboarding-case.ts's discipline. No
   * pagination: at POC scale a tenant has a handful of members; capped at 200
   * defensively with a logged warning if the cap is hit.
   */
  listTenantMemberships: protectedProcedure
    .input(listTenantMembershipsInputSchema)
    .output(listTenantMembershipsOutputSchema)
    .query(async ({ ctx }) => {
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      const MEMBERSHIP_CAP = 200;

      const rows = await ctx.sql<
        { id: string; display_name: string | null; email: string | null; roles: string[] }[]
      >`
        SELECT tum.id::text AS id, u.display_name AS display_name,
               au.email AS email, tum.roles AS roles
        FROM public.tenant_user_memberships tum
        JOIN auth.users au ON au.id = tum.user_id
        LEFT JOIN public.users u ON u.id = tum.user_id
        WHERE tum.tenant_id = ${tenantId} AND tum.status = 'active'
        ORDER BY u.display_name ASC NULLS LAST, au.email ASC
        LIMIT ${MEMBERSHIP_CAP + 1}
      `;
      if (rows.length > MEMBERSHIP_CAP) {
        ctx.log.warn(
          { tenantId, count: rows.length },
          "listTenantMemberships hit the membership cap; truncating",
        );
      }

      const items: TenantMembershipRow[] = rows.slice(0, MEMBERSHIP_CAP).map((r) => ({
        membershipId: r.id,
        displayName: r.display_name ?? null,
        email: r.email ?? null,
        roles: Array.isArray(r.roles) ? r.roles : [],
      }));
      return { items };
    }),

  // ─────────────────────── CONF-03 users & roles admin ───────────────────────
  //
  // /admin/users. Admin-only on every read + write (USERS_ADMIN_ROLES). Reads
  // + writes go through the service-role pool (ctx.sql / poolDb) with an
  // explicit tenant_id predicate: tenant_user_memberships has NO authenticated
  // write policy (only memberships_self_select), so the RLS-scoped client
  // cannot list other members or mutate memberships. The explicit admin gate +
  // the tenantId predicate are the authorisation, matching the seed-test-users
  // service-role precedent. Role changes + deactivations take effect at the
  // member's NEXT token issuance (the auth hook reads active memberships at
  // sign-in) — surfaced in the UI copy.

  /**
   * listTenantUsersAdmin — every membership in the caller's tenant (all
   * statuses, unlike listTenantMemberships which is active-only for the
   * assignment pickers), with email + roles + status + createdAt + an isSelf
   * flag the client uses to render the self-guard affordances.
   */
  listTenantUsersAdmin: protectedProcedure
    .input(listTenantUsersAdminInputSchema)
    .output(listTenantUsersAdminOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "User administration is admin-only");
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      const selfUserId = ctx.userId;
      const CAP = 500;

      const rows = await ctx.sql<
        {
          id: string;
          user_id: string;
          display_name: string | null;
          email: string | null;
          roles: string[];
          status: string;
          created_at: Date | string;
        }[]
      >`
        SELECT tum.id::text AS id, tum.user_id::text AS user_id,
               u.display_name AS display_name, au.email AS email,
               tum.roles AS roles, tum.status AS status, tum.created_at AS created_at
        FROM public.tenant_user_memberships tum
        JOIN auth.users au ON au.id = tum.user_id
        LEFT JOIN public.users u ON u.id = tum.user_id
        WHERE tum.tenant_id = ${tenantId}
        ORDER BY (tum.status = 'active') DESC, u.display_name ASC NULLS LAST, au.email ASC
        LIMIT ${CAP}
      `;

      const items: TenantUserAdminRow[] = rows.map((r) => ({
        membershipId: r.id,
        userId: r.user_id,
        displayName: r.display_name ?? null,
        email: r.email ?? null,
        roles: Array.isArray(r.roles) ? r.roles : [],
        status: r.status,
        createdAt: toIsoString(r.created_at) ?? new Date(0).toISOString(),
        isSelf: r.user_id === selfUserId,
      }));
      return { items };
    }),

  /**
   * inviteTenantUser — mint (or resolve) an auth identity + membership with
   * the chosen internal roles, via the service-role admin pattern. NO email is
   * sent this ticket: the temp password is returned once for the admin to
   * relay out-of-band (flagged in the UI). Idempotent-ish: an existing auth
   * email has its password reset (alreadyExisted); an existing membership in
   * this tenant is updated in place (membershipReused) rather than duplicated.
   */
  inviteTenantUser: protectedProcedure
    .input(inviteTenantUserInputSchema)
    .output(inviteTenantUserOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("invite_tenant_user", ctx, { ...input, roles: input.roles }, async () => {
        requireAnyRole(ctx, USERS_ADMIN_ROLES, "Inviting users is admin-only");
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        const email = input.email.trim().toLowerCase();
        // Backstop the zod enum: every role must be an assignable internal role.
        for (const r of input.roles) {
          if (!ASSIGNABLE_INTERNAL_ROLES.has(r)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `role not assignable: ${r}` });
          }
        }

        const tempPassword = generateTempPassword();
        const { userId, alreadyExisted } = await createOrResolveAuthUser(email, tempPassword);

        // Profile row (display name) — best-effort upsert of display name.
        if (input.displayName) {
          await poolDb
            .insert(users)
            .values({ id: userId, displayName: input.displayName })
            .onConflictDoNothing();
        }

        // Existing membership in THIS tenant? Update roles + reactivate rather
        // than create a duplicate (the (user_id, tenant_id) unique index would
        // reject a second insert anyway).
        const [existing] = await poolDb
          .select({ id: tenantUserMemberships.id })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.userId, userId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);

        let membershipId: string;
        let membershipReused = false;
        if (existing) {
          membershipReused = true;
          await poolDb
            .update(tenantUserMemberships)
            .set({ roles: [...input.roles], status: "active", updatedAt: new Date() })
            .where(
              and(
                eq(tenantUserMemberships.id, existing.id),
                eq(tenantUserMemberships.tenantId, tenantId),
              ),
            );
          membershipId = existing.id;
        } else {
          const [inserted] = await poolDb
            .insert(tenantUserMemberships)
            .values({
              userId,
              tenantId,
              roles: [...input.roles],
              status: "active",
              jobTitle: input.displayName ?? null,
            })
            .returning({ id: tenantUserMemberships.id });
          if (!inserted) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "membership insert returned no row",
            });
          }
          membershipId = inserted.id;
        }

        return {
          membershipId,
          userId,
          email,
          tempPassword,
          alreadyExisted,
          membershipReused,
        };
      });
    }),

  /**
   * updateMembershipRoles — replace a membership's internal roles. Admin +
   * audited. Self-demotion guard: an admin cannot strip their OWN admin role
   * (clean BAD_REQUEST) — otherwise a lone admin could lock the tenant out.
   */
  updateMembershipRoles: protectedProcedure
    .input(updateMembershipRolesInputSchema)
    .output(updateMembershipRolesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_membership_roles", ctx, input, async () => {
        requireAnyRole(ctx, USERS_ADMIN_ROLES, "Editing roles is admin-only");
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        for (const r of input.roles) {
          if (!ASSIGNABLE_INTERNAL_ROLES.has(r)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `role not assignable: ${r}` });
          }
        }

        const [membership] = await poolDb
          .select({ id: tenantUserMemberships.id, userId: tenantUserMemberships.userId })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.id, input.membershipId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!membership) {
          throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
        }

        // Self-demotion guard: the acting admin may not remove their own admin.
        if (membership.userId === ctx.userId && !input.roles.includes("admin")) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You cannot remove your own admin role. Ask another admin to change it.",
          });
        }

        await poolDb
          .update(tenantUserMemberships)
          .set({ roles: [...input.roles], updatedAt: new Date() })
          .where(
            and(
              eq(tenantUserMemberships.id, input.membershipId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          );

        return { ok: true as const, membershipId: input.membershipId, roles: [...input.roles] };
      });
    }),

  /**
   * setMembershipStatus — deactivate (suspended) / reactivate (active) a
   * membership. Admin + audited. Self-deactivation guard: an admin cannot
   * deactivate their own membership (clean BAD_REQUEST).
   */
  setMembershipStatus: protectedProcedure
    .input(setMembershipStatusInputSchema)
    .output(setMembershipStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("set_membership_status", ctx, input, async () => {
        requireAnyRole(ctx, USERS_ADMIN_ROLES, "Changing membership status is admin-only");
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [membership] = await poolDb
          .select({ id: tenantUserMemberships.id, userId: tenantUserMemberships.userId })
          .from(tenantUserMemberships)
          .where(
            and(
              eq(tenantUserMemberships.id, input.membershipId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!membership) {
          throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
        }

        // Self-deactivation guard.
        if (membership.userId === ctx.userId && input.status !== "active") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You cannot deactivate your own membership.",
          });
        }

        await poolDb
          .update(tenantUserMemberships)
          .set({ status: input.status, updatedAt: new Date() })
          .where(
            and(
              eq(tenantUserMemberships.id, input.membershipId),
              eq(tenantUserMemberships.tenantId, tenantId),
            ),
          );

        return { ok: true as const, membershipId: input.membershipId, status: input.status };
      });
    }),

  /**
   * getDocumentRetention — READ-ONLY view of the ONBOARD-01 document_types
   * reference rows (retention years per geography). admin + hr_head (surfaced
   * on /admin/users AND the HRHEAD-03 /governance page). No mutations this
   * ticket — enforcement automation is a future work package. document_types
   * is a tenant-agnostic reference table with a permissive authenticated
   * SELECT policy, so ctx.db reads it fine.
   */
  getDocumentRetention: protectedProcedure
    .input(getDocumentRetentionInputSchema)
    .output(getDocumentRetentionOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        GOVERNANCE_READ_ROLES,
        "Data retention view requires the hr_head or admin role",
      );
      const db = requireDb(ctx);
      const rows = await db
        .select({
          code: documentTypes.code,
          name: documentTypes.name,
          geographyCode: documentTypes.geographyCode,
          requiredForLifecycleStage: documentTypes.requiredForLifecycleStage,
          retentionYears: documentTypes.retentionYears,
        })
        .from(documentTypes)
        .orderBy(
          dsql`${documentTypes.geographyCode} ASC NULLS FIRST`,
          documentTypes.retentionYears,
          documentTypes.name,
        );
      const items: DocumentRetentionRow[] = rows.map((r) => ({
        code: r.code,
        name: r.name,
        geographyCode: r.geographyCode ?? null,
        requiredForLifecycleStage: r.requiredForLifecycleStage ?? null,
        retentionYears: r.retentionYears ?? null,
      }));
      return { items };
    }),

  /**
   * listOnboardingCases — tenant-scoped, optional status filter, keyset-
   * paginated on (created_at, id) desc (same codec as the audit list).
   * Carries candidate name + position title + task-progress counts for the
   * list UI (ONBOARD-03).
   */
  listOnboardingCases: protectedProcedure
    .input(listOnboardingCasesInputSchema)
    .output(listOnboardingCasesOutputSchema)
    .query(async ({ ctx, input }) => {
      // RBAC-01 — onboarding is a recruiter + HR-ops surface.
      requireAnyRole(ctx, ONBOARDING_MANAGE_ROLES, "Onboarding is not available for your role");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      const limit = input.limit;
      const decoded = decodeAuditCursor(input.cursor);

      const conditions = [eq(onboardingCases.tenantId, tenantId)];
      if (input.status) {
        conditions.push(eq(onboardingCases.status, input.status));
      }
      if (decoded) {
        conditions.push(
          dsql`(${onboardingCases.createdAt}, ${onboardingCases.id}) < (${decoded.createdAt.toISOString()}::timestamptz, ${decoded.id}::uuid)`,
        );
      }

      const rows = await db
        .select({
          id: onboardingCases.id,
          applicationId: onboardingCases.applicationId,
          candidateId: onboardingCases.candidateId,
          status: onboardingCases.status,
          geographyCode: onboardingCases.geographyCode,
          expectedStartDate: onboardingCases.expectedStartDate,
          actualStartDate: onboardingCases.actualStartDate,
          probationDays: onboardingCases.probationDays,
          probationEndsAt: onboardingCases.probationEndsAt,
          buddyMembershipId: onboardingCases.buddyMembershipId,
          managerMembershipId: onboardingCases.managerMembershipId,
          workdayWorkerId: onboardingCases.workdayWorkerId,
          candidateName: persons.fullName,
          positionTitle: positions.title,
          totalTasks: dsql<number>`(SELECT count(*)::int FROM public.onboarding_tasks t WHERE t.tenant_id = ${onboardingCases.tenantId} AND t.case_id = ${onboardingCases.id})`,
          completedTasks: dsql<number>`(SELECT count(*)::int FROM public.onboarding_tasks t WHERE t.tenant_id = ${onboardingCases.tenantId} AND t.case_id = ${onboardingCases.id} AND t.status = 'completed')`,
          createdAt: onboardingCases.createdAt,
          updatedAt: onboardingCases.updatedAt,
        })
        .from(onboardingCases)
        .leftJoin(
          candidates,
          and(
            eq(candidates.id, onboardingCases.candidateId),
            eq(candidates.tenantId, onboardingCases.tenantId),
          ),
        )
        .leftJoin(
          persons,
          and(eq(persons.id, candidates.personId), eq(persons.tenantId, onboardingCases.tenantId)),
        )
        .leftJoin(
          applications,
          and(
            eq(applications.id, onboardingCases.applicationId),
            eq(applications.tenantId, onboardingCases.tenantId),
          ),
        )
        .leftJoin(
          requisitions,
          and(
            eq(requisitions.id, applications.requisitionId),
            eq(requisitions.tenantId, onboardingCases.tenantId),
          ),
        )
        .leftJoin(
          positions,
          and(
            eq(positions.id, requisitions.positionId),
            eq(positions.tenantId, onboardingCases.tenantId),
          ),
        )
        .where(and(...conditions))
        .orderBy(desc(onboardingCases.createdAt), desc(onboardingCases.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items: OnboardingCaseListRow[] = pageRows.map((r) => ({
        id: r.id,
        applicationId: r.applicationId,
        candidateId: r.candidateId,
        status: r.status as OnboardingCaseStatus,
        geographyCode: r.geographyCode,
        expectedStartDate: r.expectedStartDate ?? null,
        actualStartDate: r.actualStartDate ?? null,
        probationDays: r.probationDays,
        probationEndsAt: r.probationEndsAt ?? null,
        buddyMembershipId: r.buddyMembershipId ?? null,
        managerMembershipId: r.managerMembershipId ?? null,
        workdayWorkerId: r.workdayWorkerId ?? null,
        candidateName: r.candidateName ?? null,
        positionTitle: r.positionTitle ?? null,
        totalTasks: Number(r.totalTasks),
        completedTasks: Number(r.completedTasks),
        createdAt: toIsoString(r.createdAt) ?? new Date(0).toISOString(),
        updatedAt: toIsoString(r.updatedAt) ?? new Date(0).toISOString(),
      }));

      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && lastRow ? encodeAuditCursor(lastRow.createdAt, lastRow.id) : null;

      return { items, nextCursor };
    }),

  /**
   * getOnboardingCaseDetail — one case + its tasks + its document rows.
   */
  getOnboardingCaseDetail: protectedProcedure
    .input(getOnboardingCaseDetailInputSchema)
    .output(getOnboardingCaseDetailOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;

      const [caseRow] = await db
        .select({
          id: onboardingCases.id,
          applicationId: onboardingCases.applicationId,
          candidateId: onboardingCases.candidateId,
          status: onboardingCases.status,
          geographyCode: onboardingCases.geographyCode,
          expectedStartDate: onboardingCases.expectedStartDate,
          actualStartDate: onboardingCases.actualStartDate,
          probationDays: onboardingCases.probationDays,
          probationEndsAt: onboardingCases.probationEndsAt,
          buddyMembershipId: onboardingCases.buddyMembershipId,
          managerMembershipId: onboardingCases.managerMembershipId,
          workdayWorkerId: onboardingCases.workdayWorkerId,
          candidateName: persons.fullName,
          positionTitle: positions.title,
          createdAt: onboardingCases.createdAt,
          updatedAt: onboardingCases.updatedAt,
        })
        .from(onboardingCases)
        .leftJoin(
          candidates,
          and(
            eq(candidates.id, onboardingCases.candidateId),
            eq(candidates.tenantId, onboardingCases.tenantId),
          ),
        )
        .leftJoin(
          persons,
          and(eq(persons.id, candidates.personId), eq(persons.tenantId, onboardingCases.tenantId)),
        )
        .leftJoin(
          applications,
          and(
            eq(applications.id, onboardingCases.applicationId),
            eq(applications.tenantId, onboardingCases.tenantId),
          ),
        )
        .leftJoin(
          requisitions,
          and(
            eq(requisitions.id, applications.requisitionId),
            eq(requisitions.tenantId, onboardingCases.tenantId),
          ),
        )
        .leftJoin(
          positions,
          and(
            eq(positions.id, requisitions.positionId),
            eq(positions.tenantId, onboardingCases.tenantId),
          ),
        )
        .where(and(eq(onboardingCases.tenantId, tenantId), eq(onboardingCases.id, input.caseId)))
        .limit(1);
      if (!caseRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding case not found" });
      }

      const taskRows = await db
        .select()
        .from(onboardingTasks)
        .where(
          and(eq(onboardingTasks.tenantId, tenantId), eq(onboardingTasks.caseId, input.caseId)),
        )
        .orderBy(onboardingTasks.createdAt, onboardingTasks.id);

      // document_types is a reference table with a permissive read policy
      // for any authenticated caller, so this join resolves the name under
      // the RLS-scoped ctx.db (unlike the buddy/manager names below).
      const documentRows = await db
        .select({
          id: onboardingDocuments.id,
          caseId: onboardingDocuments.caseId,
          documentTypeId: onboardingDocuments.documentTypeId,
          documentTypeName: documentTypes.name,
          verificationStatus: onboardingDocuments.verificationStatus,
          fileName: onboardingDocuments.fileName,
          mimeType: onboardingDocuments.mimeType,
          verifiedByMembershipId: onboardingDocuments.verifiedByMembershipId,
          verifiedAt: onboardingDocuments.verifiedAt,
          rejectionReason: onboardingDocuments.rejectionReason,
          uploadedAt: onboardingDocuments.uploadedAt,
          createdAt: onboardingDocuments.createdAt,
        })
        .from(onboardingDocuments)
        .leftJoin(documentTypes, eq(documentTypes.id, onboardingDocuments.documentTypeId))
        .where(
          and(
            eq(onboardingDocuments.tenantId, tenantId),
            eq(onboardingDocuments.caseId, input.caseId),
          ),
        )
        .orderBy(onboardingDocuments.createdAt, onboardingDocuments.id);

      // Resolve buddy/manager membership ids → display name + email. RLS on
      // public.users is self-only, so a plain ctx.db join would return only
      // the caller's own name; we go through the service-role client
      // (ctx.sql) with an explicit tenant_id filter — the same
      // explicit-tenant discipline as onboarding-case.ts. auth.users holds
      // the email; public.users holds the display_name (nullable).
      // Verifier names piggy-back on the SAME service-role membership lookup
      // (ONBOARD-05) — no extra join, just more ids in the ANY() filter.
      const verifierMembershipIds = documentRows
        .map((d) => d.verifiedByMembershipId)
        .filter((id): id is string => id != null);
      const nameTargets = [
        caseRow.buddyMembershipId,
        caseRow.managerMembershipId,
        ...verifierMembershipIds,
      ].filter((id): id is string => id != null);
      const nameById = new Map<string, { displayName: string | null; email: string | null }>();
      if (nameTargets.length > 0) {
        const nameRows = await ctx.sql<
          { id: string; display_name: string | null; email: string | null }[]
        >`
          SELECT tum.id::text AS id, u.display_name AS display_name, au.email AS email
          FROM public.tenant_user_memberships tum
          JOIN auth.users au ON au.id = tum.user_id
          LEFT JOIN public.users u ON u.id = tum.user_id
          WHERE tum.tenant_id = ${tenantId} AND tum.id::text = ANY(${nameTargets})
        `;
        for (const r of nameRows) {
          nameById.set(r.id, { displayName: r.display_name, email: r.email });
        }
      }
      const buddy = caseRow.buddyMembershipId ? nameById.get(caseRow.buddyMembershipId) : undefined;
      const manager = caseRow.managerMembershipId
        ? nameById.get(caseRow.managerMembershipId)
        : undefined;

      const tasks: OnboardingTaskRow[] = taskRows.map((t) => ({
        id: t.id,
        caseId: t.caseId,
        taskType: t.taskType,
        status: t.status as OnboardingTaskRow["status"],
        title: t.title,
        description: t.description ?? null,
        assigneeMembershipId: t.assigneeMembershipId ?? null,
        dueAt: toIsoString(t.dueAt),
        completedAt: toIsoString(t.completedAt),
        blockedReason: t.blockedReason ?? null,
        metadata: t.metadata ?? null,
        createdAt: toIsoString(t.createdAt) ?? new Date(0).toISOString(),
        updatedAt: toIsoString(t.updatedAt) ?? new Date(0).toISOString(),
      }));

      const documents: OnboardingDocumentRow[] = documentRows.map((d) => {
        const verifier = d.verifiedByMembershipId
          ? nameById.get(d.verifiedByMembershipId)
          : undefined;
        return {
          id: d.id,
          caseId: d.caseId,
          documentTypeId: d.documentTypeId,
          documentTypeName: d.documentTypeName ?? null,
          verificationStatus: d.verificationStatus,
          fileName: d.fileName ?? null,
          mimeType: d.mimeType ?? null,
          verifiedByMembershipId: d.verifiedByMembershipId ?? null,
          verifiedAt: toIsoString(d.verifiedAt),
          rejectionReason: d.rejectionReason ?? null,
          verifierName: verifier?.displayName ?? verifier?.email ?? null,
          uploadedAt: toIsoString(d.uploadedAt) ?? new Date(0).toISOString(),
          createdAt: toIsoString(d.createdAt) ?? new Date(0).toISOString(),
        };
      });

      return {
        case: {
          id: caseRow.id,
          applicationId: caseRow.applicationId,
          candidateId: caseRow.candidateId,
          status: caseRow.status as OnboardingCaseStatus,
          geographyCode: caseRow.geographyCode,
          expectedStartDate: caseRow.expectedStartDate ?? null,
          actualStartDate: caseRow.actualStartDate ?? null,
          probationDays: caseRow.probationDays,
          probationEndsAt: caseRow.probationEndsAt ?? null,
          buddyMembershipId: caseRow.buddyMembershipId ?? null,
          managerMembershipId: caseRow.managerMembershipId ?? null,
          workdayWorkerId: caseRow.workdayWorkerId ?? null,
          candidateName: caseRow.candidateName ?? null,
          positionTitle: caseRow.positionTitle ?? null,
          buddyName: buddy?.displayName ?? null,
          buddyEmail: buddy?.email ?? null,
          managerName: manager?.displayName ?? null,
          managerEmail: manager?.email ?? null,
          createdAt: toIsoString(caseRow.createdAt) ?? new Date(0).toISOString(),
          updatedAt: toIsoString(caseRow.updatedAt) ?? new Date(0).toISOString(),
        },
        tasks,
        documents,
      };
    }),

  /**
   * updateOnboardingTaskStatus — task status transition. Sets completed_at
   * when → completed (clears it otherwise); requires blocked_reason when →
   * blocked (clears it otherwise). The audit_logs trigger (0047) records the
   * row change; withAudit records the API intent + actor.
   */
  updateOnboardingTaskStatus: protectedProcedure
    .input(updateOnboardingTaskStatusInputSchema)
    .output(updateOnboardingTaskStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_onboarding_task_status", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        if (input.status === "blocked" && !input.blockedReason) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "blockedReason is required when status is 'blocked'",
          });
        }

        const [existing] = await db
          .select({ id: onboardingTasks.id })
          .from(onboardingTasks)
          .where(and(eq(onboardingTasks.tenantId, tenantId), eq(onboardingTasks.id, input.taskId)))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding task not found" });
        }

        const completedAt = input.status === "completed" ? new Date() : null;
        const blockedReason = input.status === "blocked" ? (input.blockedReason ?? null) : null;

        const [updated] = await db
          .update(onboardingTasks)
          .set({
            status: input.status,
            completedAt,
            blockedReason,
            updatedAt: new Date(),
          })
          .where(and(eq(onboardingTasks.tenantId, tenantId), eq(onboardingTasks.id, input.taskId)))
          .returning({
            id: onboardingTasks.id,
            status: onboardingTasks.status,
            completedAt: onboardingTasks.completedAt,
            blockedReason: onboardingTasks.blockedReason,
          });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "task update returned no row",
          });
        }

        return {
          taskId: updated.id,
          status: updated.status as OnboardingTaskRow["status"],
          completedAt: toIsoString(updated.completedAt),
          blockedReason: updated.blockedReason ?? null,
        };
      });
    }),

  /**
   * updateOnboardingCase — limited-field update: geography_code, expected
   * start date, buddy / manager assignment, status transition (guarded).
   * A geography change SOFT-ADDS the newly-applicable document_collection
   * tasks (existing tasks + any progress are preserved; nothing is deleted)
   * and reports the count as `documentTasksAdded`.
   */
  updateOnboardingCase: protectedProcedure
    .input(updateOnboardingCaseInputSchema)
    .output(updateOnboardingCaseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_onboarding_case", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [existing] = await db
          .select({
            status: onboardingCases.status,
            geographyCode: onboardingCases.geographyCode,
            actualStartDate: onboardingCases.actualStartDate,
          })
          .from(onboardingCases)
          .where(and(eq(onboardingCases.tenantId, tenantId), eq(onboardingCases.id, input.caseId)))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding case not found" });
        }

        const setFields: Record<string, unknown> = { updatedAt: new Date() };

        // ONBOARD-06 — the Day-0 moment. Advancing a case to `day_zero` stamps
        // the actual start date (today, if not already set) and enqueues the
        // Workday Hire_Employee outbox event below. Guarded to a genuine
        // transition, so re-issuing day_zero (a no-op) never re-fires it.
        let advancingToDayZero = false;

        if (input.status !== undefined && input.status !== existing.status) {
          const allowed = ALLOWED_CASE_TRANSITIONS[existing.status] ?? [];
          if (!allowed.includes(input.status)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Illegal case status transition ${existing.status} → ${input.status}`,
            });
          }
          setFields.status = input.status;
          if (input.status === "day_zero") {
            advancingToDayZero = true;
            if (existing.actualStartDate == null) {
              // date column — 'YYYY-MM-DD' (UTC today).
              setFields.actualStartDate = new Date().toISOString().slice(0, 10);
            }
          }
        }

        let nextGeography = existing.geographyCode;
        if (input.geographyCode !== undefined) {
          nextGeography = resolveGeographyCode(input.geographyCode);
          setFields.geographyCode = nextGeography;
        }
        if (input.expectedStartDate !== undefined) {
          setFields.expectedStartDate = input.expectedStartDate;
        }
        if (input.buddyMembershipId !== undefined) {
          setFields.buddyMembershipId = input.buddyMembershipId;
        }
        if (input.managerMembershipId !== undefined) {
          setFields.managerMembershipId = input.managerMembershipId;
        }

        const [updated] = await db
          .update(onboardingCases)
          .set(setFields)
          .where(and(eq(onboardingCases.tenantId, tenantId), eq(onboardingCases.id, input.caseId)))
          .returning({
            status: onboardingCases.status,
            geographyCode: onboardingCases.geographyCode,
          });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "case update returned no row",
          });
        }

        // Soft-add document tasks for a changed geography. Runs LAST via the
        // service-role client (ctx.sql, explicit tenant_id) as the final
        // statement — a failure throws and rolls back the ctx.db update above,
        // so geography and its documents move together.
        let documentTasksAdded = 0;
        if (input.geographyCode !== undefined && nextGeography !== existing.geographyCode) {
          documentTasksAdded = await ensureDocumentCollectionTasks(ctx.sql, {
            tenantId,
            caseId: input.caseId,
            geographyCode: nextGeography,
          });
        }

        // ONBOARD-06 — fire the Day-0 Workday hire. Best-effort (never throws),
        // idempotent per case via its business key, so the transition stands
        // even if the enqueue races or has already fired. Runs after the case
        // row is committed and the doc-task soft-add above.
        if (advancingToDayZero) {
          await enqueueDayZeroWorkdayHire(ctx.sql, {
            tenantId,
            caseId: input.caseId,
            log: ctx.log,
          });
        }

        return {
          caseId: input.caseId,
          status: updated.status as OnboardingCaseStatus,
          geographyCode: updated.geographyCode,
          documentTasksAdded,
        };
      });
    }),

  /**
   * createOnboardingCaseForApplication — manual / backfill entry point,
   * reusing the same idempotent creation helper as the offer-accept hook.
   * Unlike that best-effort hook, this runs to completion or errors: it is a
   * deliberate recovery action, so a failure should surface, not be swallowed.
   */
  createOnboardingCaseForApplication: protectedProcedure
    .input(createOnboardingCaseForApplicationInputSchema)
    .output(createOnboardingCaseForApplicationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("create_onboarding_case_for_application", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        // Confirm the application exists in this tenant (RLS-scoped) before
        // handing off to the service-role creation helper — turns a missing
        // application into a clean 404 instead of an internal error.
        const [app] = await db
          .select({ id: applications.id })
          .from(applications)
          .where(and(eq(applications.tenantId, tenantId), eq(applications.id, input.applicationId)))
          .limit(1);
        if (!app) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        }

        const result = await createOnboardingCase(ctx.sql, {
          tenantId,
          applicationId: input.applicationId,
        });
        return {
          caseId: result.caseId,
          created: result.created,
          geographyCode: result.geographyCode,
        };
      });
    }),

  /**
   * attachOnboardingDocument (ONBOARD-05) — records an uploaded blob (opaque
   * storageKey from POST /api/onboarding-documents/upload) as a document row
   * for a (case, documentType) and nudges the matching document_collection
   * task pending → in_progress.
   *
   * Re-upload semantics: the schema has NO version / superseded / is_current
   * column and NO unique(tenant, case, documentType) constraint, so it models
   * "the current document for this type", not a history. We therefore REPLACE
   * an existing row for the same type (single current document per type),
   * resetting it to pending review and clearing any prior verify/reject stamp.
   * The old storage blob is left in place (no retention/erasure automation this
   * ticket — flagged as follow-up).
   */
  attachOnboardingDocument: protectedProcedure
    .input(attachOnboardingDocumentInputSchema)
    .output(attachOnboardingDocumentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("attach_onboarding_document", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        // Case must exist in this tenant (RLS) — turns a missing / cross-tenant
        // case into a clean 404 rather than an FK error, and is the tenant
        // isolation gate for the attach.
        const [caseRow] = await db
          .select({ id: onboardingCases.id })
          .from(onboardingCases)
          .where(and(eq(onboardingCases.tenantId, tenantId), eq(onboardingCases.id, input.caseId)))
          .limit(1);
        if (!caseRow) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding case not found" });
        }

        // document_types is a tenant-agnostic reference table with a permissive
        // read policy — validate the id for a clean 404 instead of an FK error.
        const [dtRow] = await db
          .select({ id: documentTypes.id })
          .from(documentTypes)
          .where(eq(documentTypes.id, input.documentTypeId))
          .limit(1);
        if (!dtRow) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Document type not found" });
        }

        // Shared find-or-replace + task-progression write path (reused
        // verbatim by the candidate-side candidateAttachDocument).
        const result = await attachDocumentToCase(db, tenantId, {
          caseId: input.caseId,
          documentTypeId: input.documentTypeId,
          storageKey: input.storageKey,
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
        });

        return {
          documentId: result.documentId,
          verificationStatus: result.verificationStatus,
          created: result.created,
          taskId: result.taskId,
          taskStatus: result.taskStatus as OnboardingTaskRow["status"] | null,
        };
      });
    }),

  /**
   * verifyOnboardingDocument (ONBOARD-05) — recruiter marks a document
   * verified. Stamps the reviewer membership + verified_at, clears any prior
   * rejection reason, and auto-completes the matching document_collection task.
   */
  verifyOnboardingDocument: protectedProcedure
    .input(verifyOnboardingDocumentInputSchema)
    .output(verifyOnboardingDocumentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("verify_onboarding_document", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const [doc] = await db
          .select({
            id: onboardingDocuments.id,
            caseId: onboardingDocuments.caseId,
            documentTypeId: onboardingDocuments.documentTypeId,
          })
          .from(onboardingDocuments)
          .where(
            and(
              eq(onboardingDocuments.tenantId, tenantId),
              eq(onboardingDocuments.id, input.documentId),
            ),
          )
          .limit(1);
        if (!doc) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding document not found" });
        }

        const membershipId = await resolveCallerMembershipId(ctx, tenantId);
        const now = new Date();
        const [updated] = await db
          .update(onboardingDocuments)
          .set({
            verificationStatus: "verified",
            verifiedByMembershipId: membershipId,
            verifiedAt: now,
            rejectionReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(onboardingDocuments.tenantId, tenantId),
              eq(onboardingDocuments.id, input.documentId),
            ),
          )
          .returning({ verificationStatus: onboardingDocuments.verificationStatus });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "verify document returned no row",
          });
        }

        const task = await matchDocumentCollectionTask(
          db,
          tenantId,
          doc.caseId,
          doc.documentTypeId,
        );
        let taskStatus = task?.status ?? null;
        if (task) {
          const [t] = await db
            .update(onboardingTasks)
            .set({ status: "completed", completedAt: now, updatedAt: now })
            .where(and(eq(onboardingTasks.tenantId, tenantId), eq(onboardingTasks.id, task.id)))
            .returning({ status: onboardingTasks.status });
          taskStatus = t?.status ?? taskStatus;
        }

        return {
          documentId: doc.id,
          verificationStatus: updated.verificationStatus,
          taskId: task?.id ?? null,
          taskStatus: taskStatus as OnboardingTaskRow["status"] | null,
        };
      });
    }),

  /**
   * rejectOnboardingDocument (ONBOARD-05) — recruiter rejects a document with a
   * REQUIRED reason (400 without). Stamps the reviewer + decision timestamp
   * (the schema has no rejected_by column, so verified_by doubles as the
   * decision actor), records the reason, and drops the matching
   * document_collection task back to pending for re-submission.
   */
  rejectOnboardingDocument: protectedProcedure
    .input(rejectOnboardingDocumentInputSchema)
    .output(rejectOnboardingDocumentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("reject_onboarding_document", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;

        const reason = input.rejectionReason.trim();
        if (reason.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "rejectionReason is required to reject a document",
          });
        }

        const [doc] = await db
          .select({
            id: onboardingDocuments.id,
            caseId: onboardingDocuments.caseId,
            documentTypeId: onboardingDocuments.documentTypeId,
          })
          .from(onboardingDocuments)
          .where(
            and(
              eq(onboardingDocuments.tenantId, tenantId),
              eq(onboardingDocuments.id, input.documentId),
            ),
          )
          .limit(1);
        if (!doc) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Onboarding document not found" });
        }

        const membershipId = await resolveCallerMembershipId(ctx, tenantId);
        const now = new Date();
        const [updated] = await db
          .update(onboardingDocuments)
          .set({
            verificationStatus: "rejected",
            verifiedByMembershipId: membershipId,
            verifiedAt: now,
            rejectionReason: reason,
            updatedAt: now,
          })
          .where(
            and(
              eq(onboardingDocuments.tenantId, tenantId),
              eq(onboardingDocuments.id, input.documentId),
            ),
          )
          .returning({
            verificationStatus: onboardingDocuments.verificationStatus,
            rejectionReason: onboardingDocuments.rejectionReason,
          });

        const task = await matchDocumentCollectionTask(
          db,
          tenantId,
          doc.caseId,
          doc.documentTypeId,
        );
        let taskStatus = task?.status ?? null;
        if (task) {
          const [t] = await db
            .update(onboardingTasks)
            .set({ status: "pending", completedAt: null, updatedAt: now })
            .where(and(eq(onboardingTasks.tenantId, tenantId), eq(onboardingTasks.id, task.id)))
            .returning({ status: onboardingTasks.status });
          taskStatus = t?.status ?? taskStatus;
        }

        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "reject document returned no row",
          });
        }
        return {
          documentId: doc.id,
          verificationStatus: updated.verificationStatus,
          rejectionReason: updated.rejectionReason ?? null,
          taskId: task?.id ?? null,
          taskStatus: taskStatus as OnboardingTaskRow["status"] | null,
        };
      });
    }),

  // ─────────────── OFFBOARD-02 — offboarding lifecycle ───────────────
  // Every procedure is OFFBOARD_MANAGE_ROLES-gated (hr_ops/people_ops/admin);
  // RLS scopes rows to the tenant on top. Case mutations mirror the ONBOARD
  // task/case semantics; the Workday terminate sim mirrors ONBOARD-06.

  /**
   * initiateOffboarding — open a departure case for a HIRED candidate and
   * generate the 7-task clearance checklist. Hired predicate + assignee
   * mapping live in the offboarding-case lib. A live case for the candidate
   * → CONFLICT (partial-unique); a never-employed candidate → BAD_REQUEST.
   */
  initiateOffboarding: protectedProcedure
    .input(initiateOffboardingInputSchema)
    .output(initiateOffboardingOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("initiate_offboarding", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

        // Candidate must exist in this tenant (RLS) — clean 404 rather than an
        // FK error from the lib insert.
        const [cand] = await db
          .select({ id: candidates.id })
          .from(candidates)
          .where(and(eq(candidates.tenantId, tenantId), eq(candidates.id, input.candidateId)))
          .limit(1);
        if (!cand) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Candidate not found" });
        }

        const initiatedByMembershipId = await resolveCallerMembershipId(ctx, tenantId);
        if (!initiatedByMembershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No tenant membership for the caller",
          });
        }

        try {
          const result = await createOffboardingCase(ctx.sql, {
            tenantId,
            candidateId: input.candidateId,
            initiationType: input.initiationType,
            noticeStartDate: input.noticeStartDate ?? null,
            lastWorkingDay: input.lastWorkingDay ?? null,
            reason: input.reason ?? null,
            initiatedByMembershipId,
            managerMembershipId: input.managerMembershipId ?? null,
          });
          return {
            caseId: result.caseId,
            created: true,
            status: "initiated" as const,
            tasksCreated: result.tasksCreated,
          };
        } catch (err) {
          if (err instanceof NotHiredError) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Candidate has no hire history — cannot be offboarded.",
            });
          }
          if (err instanceof ActiveCaseExistsError) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "An active offboarding case already exists for this candidate.",
            });
          }
          const e = err as { code?: string };
          if (e.code === "23503") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Invalid manager membership for this tenant.",
            });
          }
          throw err;
        }
      });
    }),

  /**
   * updateOffboardingTaskStatus — ONBOARD task-status semantics verbatim:
   * → completed stamps completed_at (cleared on reopen); → blocked requires a
   * reason (cleared otherwise).
   */
  updateOffboardingTaskStatus: protectedProcedure
    .input(updateOffboardingTaskStatusInputSchema)
    .output(updateOffboardingTaskStatusOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_offboarding_task_status", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

        if (input.status === "blocked" && !input.blockedReason) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "blockedReason is required when status is 'blocked'",
          });
        }

        const [existing] = await db
          .select({ id: offboardingTasks.id })
          .from(offboardingTasks)
          .where(
            and(eq(offboardingTasks.tenantId, tenantId), eq(offboardingTasks.id, input.taskId)),
          )
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding task not found" });
        }

        const completedAt = input.status === "completed" ? new Date() : null;
        const blockedReason = input.status === "blocked" ? (input.blockedReason ?? null) : null;

        const [updated] = await db
          .update(offboardingTasks)
          .set({ status: input.status, completedAt, blockedReason, updatedAt: new Date() })
          .where(
            and(eq(offboardingTasks.tenantId, tenantId), eq(offboardingTasks.id, input.taskId)),
          )
          .returning({
            id: offboardingTasks.id,
            status: offboardingTasks.status,
            completedAt: offboardingTasks.completedAt,
            blockedReason: offboardingTasks.blockedReason,
          });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "task update returned no row",
          });
        }
        return {
          taskId: updated.id,
          status: updated.status as OffboardingTaskRow["status"],
          completedAt: toIsoString(updated.completedAt),
          blockedReason: updated.blockedReason ?? null,
        };
      });
    }),

  /**
   * advanceOffboardingCase — forward-only lifecycle walk with the §8 gates:
   *   → clearance requires last_working_day set;
   *   → completed requires access_revocation + asset_return tasks completed AND
   *     the settlement approved|paid;
   *   → cancelled (from any non-terminal) requires a reason.
   * On → completed, enqueues the idempotent Workday terminate_employee event.
   */
  advanceOffboardingCase: protectedProcedure
    .input(advanceOffboardingCaseInputSchema)
    .output(advanceOffboardingCaseOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("advance_offboarding_case", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

        const [existing] = await db
          .select({
            status: offboardingCases.status,
            lastWorkingDay: offboardingCases.lastWorkingDay,
          })
          .from(offboardingCases)
          .where(
            and(eq(offboardingCases.tenantId, tenantId), eq(offboardingCases.id, input.caseId)),
          )
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding case not found" });
        }

        const target = input.targetStatus;
        if (target === existing.status) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Case is already ${target}`,
          });
        }
        const allowed = ALLOWED_OFFBOARDING_TRANSITIONS[existing.status] ?? [];
        if (!allowed.includes(target)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Illegal offboarding status transition ${existing.status} → ${target}`,
          });
        }

        // Merge any date fields the caller stamps on this step.
        const setFields: Record<string, unknown> = { status: target, updatedAt: new Date() };
        if (input.noticeStartDate !== undefined) setFields.noticeStartDate = input.noticeStartDate;
        if (input.lastWorkingDay !== undefined) setFields.lastWorkingDay = input.lastWorkingDay;

        // Gate: → clearance requires a last working day (existing or just set).
        if (target === "clearance") {
          const lwd = input.lastWorkingDay ?? existing.lastWorkingDay;
          if (!lwd) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "last_working_day must be set before moving to clearance.",
            });
          }
        }

        // Gate: → completed requires the clearance gates (§8.3 ordering enforced
        // at the settlement layer; here we require its terminal-ish state).
        if (target === "completed") {
          const [accessDone, assetsDone] = await Promise.all([
            isOffboardingTaskCompleted(db, tenantId, input.caseId, "access_revocation"),
            isOffboardingTaskCompleted(db, tenantId, input.caseId, "asset_return"),
          ]);
          if (!accessDone || !assetsDone) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Clearance incomplete: access_revocation and asset_return tasks must be completed.",
            });
          }
          const [settle] = await db
            .select({ status: finalSettlements.status })
            .from(finalSettlements)
            .where(
              and(
                eq(finalSettlements.tenantId, tenantId),
                eq(finalSettlements.caseId, input.caseId),
              ),
            )
            .limit(1);
          if (!settle || (settle.status !== "approved" && settle.status !== "paid")) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Final settlement must be approved or paid before completion.",
            });
          }
        }

        // Gate: → cancelled requires a reason (overwrites the resignation reason
        // with the cancellation reason — honest for the audit trail).
        if (target === "cancelled") {
          if (!input.reason) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "A reason is required to cancel an offboarding case.",
            });
          }
          setFields.reason = input.reason;
        }

        const [updated] = await db
          .update(offboardingCases)
          .set(setFields)
          .where(
            and(eq(offboardingCases.tenantId, tenantId), eq(offboardingCases.id, input.caseId)),
          )
          .returning({ status: offboardingCases.status });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "case update returned no row",
          });
        }

        // On → completed, fire the Workday terminate sim. Best-effort +
        // idempotent per case, so the transition stands even if it races.
        let terminateEnqueued = false;
        if (target === "completed") {
          terminateEnqueued = await enqueueTerminateWorkday(ctx.sql, {
            tenantId,
            caseId: input.caseId,
            log: ctx.log,
          });
        }

        return {
          caseId: input.caseId,
          status: updated.status as OffboardingCaseStatus,
          terminateEnqueued,
        };
      });
    }),

  /**
   * recordAssetReturn — add an asset_returns row for a case. When ALL rows for
   * the case are returned|written_off, auto-completes the asset_return task
   * (flagged). A 'lost'/'pending' row leaves the task open (honest).
   */
  recordAssetReturn: protectedProcedure
    .input(recordAssetReturnInputSchema)
    .output(assetReturnMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("record_asset_return", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

        const [caseRow] = await db
          .select({ id: offboardingCases.id })
          .from(offboardingCases)
          .where(
            and(eq(offboardingCases.tenantId, tenantId), eq(offboardingCases.id, input.caseId)),
          )
          .limit(1);
        if (!caseRow) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding case not found" });
        }

        const now = new Date();
        const returnedAt =
          input.status === "returned" || input.status === "written_off" ? now : null;
        const [inserted] = await db
          .insert(assetReturns)
          .values({
            tenantId,
            caseId: input.caseId,
            assetType: input.assetType,
            assetTag: input.assetTag ?? null,
            status: input.status,
            returnedAt,
            notes: input.notes ?? null,
          })
          .returning({ id: assetReturns.id, status: assetReturns.status });
        if (!inserted) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "asset return insert returned no row",
          });
        }

        const taskAutoCompleted = await maybeCompleteAssetReturnTask(db, tenantId, input.caseId);
        return {
          assetReturnId: inserted.id,
          status: inserted.status as AssetReturnStatus,
          taskAutoCompleted,
        };
      });
    }),

  /**
   * updateAssetReturn — mutate an existing asset_returns row (status / notes /
   * receiver). A → returned/written_off transition stamps returned_at + the
   * receiver; re-runs the all-returned auto-completion.
   */
  updateAssetReturn: protectedProcedure
    .input(updateAssetReturnInputSchema)
    .output(assetReturnMutationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_asset_return", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

        const [existing] = await db
          .select({ id: assetReturns.id, caseId: assetReturns.caseId })
          .from(assetReturns)
          .where(and(eq(assetReturns.tenantId, tenantId), eq(assetReturns.id, input.assetReturnId)))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Asset return not found" });
        }

        const now = new Date();
        const setFields: Record<string, unknown> = { updatedAt: now };
        if (input.status !== undefined) {
          setFields.status = input.status;
          if (input.status === "returned" || input.status === "written_off") {
            setFields.returnedAt = now;
          }
        }
        if (input.notes !== undefined) setFields.notes = input.notes;
        if (input.receivedByMembershipId !== undefined) {
          setFields.receivedByMembershipId = input.receivedByMembershipId;
        }

        const [updated] = await db
          .update(assetReturns)
          .set(setFields)
          .where(and(eq(assetReturns.tenantId, tenantId), eq(assetReturns.id, input.assetReturnId)))
          .returning({ id: assetReturns.id, status: assetReturns.status });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "asset return update returned no row",
          });
        }

        const taskAutoCompleted = await maybeCompleteAssetReturnTask(db, tenantId, existing.caseId);
        return {
          assetReturnId: updated.id,
          status: updated.status as AssetReturnStatus,
          taskAutoCompleted,
        };
      });
    }),

  /**
   * recordExitInterview — upsert the one-per-case exit interview. Mutable draft
   * until submit:true, which stamps submitted_at ONCE, auto-completes the
   * exit_interview task, and freezes the row (further writes → CONFLICT).
   */
  recordExitInterview: protectedProcedure
    .input(recordExitInterviewInputSchema)
    .output(recordExitInterviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("record_exit_interview", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

        const [caseRow] = await db
          .select({ id: offboardingCases.id })
          .from(offboardingCases)
          .where(
            and(eq(offboardingCases.tenantId, tenantId), eq(offboardingCases.id, input.caseId)),
          )
          .limit(1);
        if (!caseRow) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding case not found" });
        }

        const [existing] = await db
          .select({ id: exitInterviews.id, submittedAt: exitInterviews.submittedAt })
          .from(exitInterviews)
          .where(
            and(eq(exitInterviews.tenantId, tenantId), eq(exitInterviews.caseId, input.caseId)),
          )
          .limit(1);

        // Immutable once submitted (scorecard discipline).
        if (existing?.submittedAt) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Exit interview already submitted and is now immutable.",
          });
        }

        const now = new Date();
        const submittedAt = input.submit ? now : null;

        let interviewId: string;
        if (existing) {
          const setFields: Record<string, unknown> = { updatedAt: now };
          if (input.scheduledAt !== undefined) setFields.scheduledAt = new Date(input.scheduledAt);
          if (input.conductedByMembershipId !== undefined) {
            setFields.conductedByMembershipId = input.conductedByMembershipId;
          }
          if (input.structuredResponses !== undefined) {
            setFields.structuredResponses = input.structuredResponses;
          }
          if (input.freeText !== undefined) setFields.freeText = input.freeText;
          if (submittedAt) setFields.submittedAt = submittedAt;
          const [u] = await db
            .update(exitInterviews)
            .set(setFields)
            .where(and(eq(exitInterviews.tenantId, tenantId), eq(exitInterviews.id, existing.id)))
            .returning({ id: exitInterviews.id });
          interviewId = u?.id ?? existing.id;
        } else {
          const [ins] = await db
            .insert(exitInterviews)
            .values({
              tenantId,
              caseId: input.caseId,
              scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
              conductedByMembershipId: input.conductedByMembershipId ?? null,
              structuredResponses: input.structuredResponses ?? {},
              freeText: input.freeText ?? null,
              submittedAt,
            })
            .returning({ id: exitInterviews.id });
          if (!ins) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "exit interview insert returned no row",
            });
          }
          interviewId = ins.id;
        }

        // Completing (submitting) the interview auto-completes its task.
        const taskAutoCompleted = submittedAt
          ? await autoCompleteOffboardingTask(db, tenantId, input.caseId, "exit_interview")
          : false;

        return {
          exitInterviewId: interviewId,
          submittedAt: toIsoString(submittedAt),
          taskAutoCompleted,
        };
      });
    }),

  /**
   * updateFinalSettlement — walk the F&F record pending → calculated →
   * approved → paid (upsert-creates a pending row on first touch). → approved
   * requires the access_revocation task completed (§8.3 gate: IT confirms
   * before settlement is released). → paid stamps paid_at + auto-completes the
   * final_settlement task.
   */
  updateFinalSettlement: protectedProcedure
    .input(updateFinalSettlementInputSchema)
    .output(updateFinalSettlementOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("update_final_settlement", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "protected procedure missing tenantId",
          });
        }
        const tenantId = ctx.tenantId;
        requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

        const [caseRow] = await db
          .select({ id: offboardingCases.id })
          .from(offboardingCases)
          .where(
            and(eq(offboardingCases.tenantId, tenantId), eq(offboardingCases.id, input.caseId)),
          )
          .limit(1);
        if (!caseRow) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding case not found" });
        }

        // Upsert-create a pending row on first touch, so the walk always has a
        // starting point.
        let [settle] = await db
          .select({ id: finalSettlements.id, status: finalSettlements.status })
          .from(finalSettlements)
          .where(
            and(eq(finalSettlements.tenantId, tenantId), eq(finalSettlements.caseId, input.caseId)),
          )
          .limit(1);
        if (!settle) {
          const [ins] = await db
            .insert(finalSettlements)
            .values({ tenantId, caseId: input.caseId, status: "pending" })
            .returning({ id: finalSettlements.id, status: finalSettlements.status });
          settle = ins;
        }
        if (!settle) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "settlement upsert returned no row",
          });
        }

        const target = input.status;
        const now = new Date();
        const setFields: Record<string, unknown> = { updatedAt: now };
        if (input.amountMinor !== undefined) setFields.amountMinor = BigInt(input.amountMinor);
        if (input.currency !== undefined) setFields.currency = input.currency.toUpperCase();
        if (input.breakdown !== undefined) setFields.breakdown = input.breakdown;

        // Status walk (forward-only; same-status is an amount-only edit).
        if (target !== settle.status) {
          const allowed = ALLOWED_SETTLEMENT_TRANSITIONS[settle.status] ?? [];
          if (!allowed.includes(target)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Illegal settlement transition ${settle.status} → ${target}`,
            });
          }
          setFields.status = target;

          // §8.3 gate: approve only after access is revoked.
          if (target === "approved") {
            const accessDone = await isOffboardingTaskCompleted(
              db,
              tenantId,
              input.caseId,
              "access_revocation",
            );
            if (!accessDone) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message:
                  "Access revocation must be completed before the settlement can be approved.",
              });
            }
            setFields.approvedByMembershipId = await resolveCallerMembershipId(ctx, tenantId);
          }
          if (target === "paid") {
            setFields.paidAt = now;
          }
        } else if (target === "paid") {
          // A no-op onto 'paid' is not a valid edit — paid is terminal.
          throw new TRPCError({ code: "BAD_REQUEST", message: "Settlement is already paid." });
        }

        const [updated] = await db
          .update(finalSettlements)
          .set(setFields)
          .where(and(eq(finalSettlements.tenantId, tenantId), eq(finalSettlements.id, settle.id)))
          .returning({
            id: finalSettlements.id,
            status: finalSettlements.status,
            paidAt: finalSettlements.paidAt,
          });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "settlement update returned no row",
          });
        }

        const taskAutoCompleted =
          target === "paid"
            ? await autoCompleteOffboardingTask(db, tenantId, input.caseId, "final_settlement")
            : false;

        return {
          settlementId: updated.id,
          status: updated.status as FinalSettlementStatus,
          paidAt: toIsoString(updated.paidAt),
          taskAutoCompleted,
        };
      });
    }),

  /**
   * listOffboardingCases — tenant-scoped, optional status filter, keyset on
   * (created_at, id) desc (same codec as onboarding/audit). Carries candidate
   * name + task-progress counts.
   */
  listOffboardingCases: protectedProcedure
    .input(listOffboardingCasesInputSchema)
    .output(listOffboardingCasesOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");
      const limit = input.limit;
      const decoded = decodeAuditCursor(input.cursor);

      const conditions = [eq(offboardingCases.tenantId, tenantId)];
      if (input.status) {
        conditions.push(eq(offboardingCases.status, input.status));
      }
      if (decoded) {
        conditions.push(
          dsql`(${offboardingCases.createdAt}, ${offboardingCases.id}) < (${decoded.createdAt.toISOString()}::timestamptz, ${decoded.id}::uuid)`,
        );
      }

      const rows = await db
        .select({
          id: offboardingCases.id,
          candidateId: offboardingCases.candidateId,
          applicationId: offboardingCases.applicationId,
          onboardingCaseId: offboardingCases.onboardingCaseId,
          initiationType: offboardingCases.initiationType,
          status: offboardingCases.status,
          noticeStartDate: offboardingCases.noticeStartDate,
          lastWorkingDay: offboardingCases.lastWorkingDay,
          reason: offboardingCases.reason,
          initiatedByMembershipId: offboardingCases.initiatedByMembershipId,
          managerMembershipId: offboardingCases.managerMembershipId,
          candidateName: persons.fullName,
          totalTasks: dsql<number>`(SELECT count(*)::int FROM public.offboarding_tasks t WHERE t.tenant_id = ${offboardingCases.tenantId} AND t.case_id = ${offboardingCases.id})`,
          completedTasks: dsql<number>`(SELECT count(*)::int FROM public.offboarding_tasks t WHERE t.tenant_id = ${offboardingCases.tenantId} AND t.case_id = ${offboardingCases.id} AND t.status = 'completed')`,
          createdAt: offboardingCases.createdAt,
          updatedAt: offboardingCases.updatedAt,
        })
        .from(offboardingCases)
        .leftJoin(
          candidates,
          and(
            eq(candidates.id, offboardingCases.candidateId),
            eq(candidates.tenantId, offboardingCases.tenantId),
          ),
        )
        .leftJoin(
          persons,
          and(eq(persons.id, candidates.personId), eq(persons.tenantId, offboardingCases.tenantId)),
        )
        .where(and(...conditions))
        .orderBy(desc(offboardingCases.createdAt), desc(offboardingCases.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items: OffboardingCaseListRow[] = pageRows.map((r) => ({
        id: r.id,
        candidateId: r.candidateId,
        applicationId: r.applicationId ?? null,
        onboardingCaseId: r.onboardingCaseId ?? null,
        initiationType: r.initiationType as OffboardingInitiationType,
        status: r.status as OffboardingCaseStatus,
        noticeStartDate: r.noticeStartDate ?? null,
        lastWorkingDay: r.lastWorkingDay ?? null,
        reason: r.reason ?? null,
        initiatedByMembershipId: r.initiatedByMembershipId,
        managerMembershipId: r.managerMembershipId ?? null,
        candidateName: r.candidateName ?? null,
        totalTasks: Number(r.totalTasks),
        completedTasks: Number(r.completedTasks),
        createdAt: toIsoString(r.createdAt) ?? new Date(0).toISOString(),
        updatedAt: toIsoString(r.updatedAt) ?? new Date(0).toISOString(),
      }));

      const lastRow = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && lastRow ? encodeAuditCursor(lastRow.createdAt, lastRow.id) : null;

      return { items, nextCursor };
    }),

  /**
   * getOffboardingCaseDetail — one case + its tasks + asset returns + exit
   * interview + settlement, with candidate + manager + initiator name joins.
   */
  getOffboardingCaseDetail: protectedProcedure
    .input(getOffboardingCaseDetailInputSchema)
    .output(getOffboardingCaseDetailOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

      const [caseRow] = await db
        .select({
          id: offboardingCases.id,
          candidateId: offboardingCases.candidateId,
          applicationId: offboardingCases.applicationId,
          onboardingCaseId: offboardingCases.onboardingCaseId,
          initiationType: offboardingCases.initiationType,
          status: offboardingCases.status,
          noticeStartDate: offboardingCases.noticeStartDate,
          lastWorkingDay: offboardingCases.lastWorkingDay,
          reason: offboardingCases.reason,
          initiatedByMembershipId: offboardingCases.initiatedByMembershipId,
          managerMembershipId: offboardingCases.managerMembershipId,
          candidateName: persons.fullName,
          createdAt: offboardingCases.createdAt,
          updatedAt: offboardingCases.updatedAt,
        })
        .from(offboardingCases)
        .leftJoin(
          candidates,
          and(
            eq(candidates.id, offboardingCases.candidateId),
            eq(candidates.tenantId, offboardingCases.tenantId),
          ),
        )
        .leftJoin(
          persons,
          and(eq(persons.id, candidates.personId), eq(persons.tenantId, offboardingCases.tenantId)),
        )
        .where(and(eq(offboardingCases.tenantId, tenantId), eq(offboardingCases.id, input.caseId)))
        .limit(1);
      if (!caseRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Offboarding case not found" });
      }

      const taskRows = await db
        .select()
        .from(offboardingTasks)
        .where(
          and(eq(offboardingTasks.tenantId, tenantId), eq(offboardingTasks.caseId, input.caseId)),
        )
        .orderBy(offboardingTasks.createdAt, offboardingTasks.id);

      const assetRows = await db
        .select()
        .from(assetReturns)
        .where(and(eq(assetReturns.tenantId, tenantId), eq(assetReturns.caseId, input.caseId)))
        .orderBy(assetReturns.createdAt, assetReturns.id);

      const [exitRow] = await db
        .select()
        .from(exitInterviews)
        .where(and(eq(exitInterviews.tenantId, tenantId), eq(exitInterviews.caseId, input.caseId)))
        .limit(1);

      const [settleRow] = await db
        .select()
        .from(finalSettlements)
        .where(
          and(eq(finalSettlements.tenantId, tenantId), eq(finalSettlements.caseId, input.caseId)),
        )
        .limit(1);

      // Resolve manager + initiator names via the service-role membership
      // lookup (RLS on public.users is self-only) — same discipline as the
      // onboarding detail.
      const nameTargets = [caseRow.managerMembershipId, caseRow.initiatedByMembershipId].filter(
        (id): id is string => id != null,
      );
      const nameById = new Map<string, { displayName: string | null; email: string | null }>();
      if (nameTargets.length > 0) {
        const nameRows = await ctx.sql<
          { id: string; display_name: string | null; email: string | null }[]
        >`
          SELECT tum.id::text AS id, u.display_name AS display_name, au.email AS email
          FROM public.tenant_user_memberships tum
          JOIN auth.users au ON au.id = tum.user_id
          LEFT JOIN public.users u ON u.id = tum.user_id
          WHERE tum.tenant_id = ${tenantId} AND tum.id::text = ANY(${nameTargets})
        `;
        for (const r of nameRows) {
          nameById.set(r.id, { displayName: r.display_name, email: r.email });
        }
      }
      const manager = caseRow.managerMembershipId
        ? nameById.get(caseRow.managerMembershipId)
        : undefined;
      const initiator = nameById.get(caseRow.initiatedByMembershipId);

      const tasks: OffboardingTaskRow[] = taskRows.map((t) => ({
        id: t.id,
        caseId: t.caseId,
        taskType: t.taskType as OffboardingTaskType,
        status: t.status as OffboardingTaskRow["status"],
        title: t.title,
        assigneeMembershipId: t.assigneeMembershipId ?? null,
        dueAt: toIsoString(t.dueAt),
        completedAt: toIsoString(t.completedAt),
        blockedReason: t.blockedReason ?? null,
        metadata: t.metadata ?? null,
        createdAt: toIsoString(t.createdAt) ?? new Date(0).toISOString(),
        updatedAt: toIsoString(t.updatedAt) ?? new Date(0).toISOString(),
      }));

      const assetReturnRows: AssetReturnRow[] = assetRows.map((a) => ({
        id: a.id,
        caseId: a.caseId,
        assetType: a.assetType,
        assetTag: a.assetTag ?? null,
        status: a.status as AssetReturnStatus,
        returnedAt: toIsoString(a.returnedAt),
        receivedByMembershipId: a.receivedByMembershipId ?? null,
        notes: a.notes ?? null,
        createdAt: toIsoString(a.createdAt) ?? new Date(0).toISOString(),
        updatedAt: toIsoString(a.updatedAt) ?? new Date(0).toISOString(),
      }));

      const exitInterview: ExitInterviewRow | null = exitRow
        ? {
            id: exitRow.id,
            caseId: exitRow.caseId,
            scheduledAt: toIsoString(exitRow.scheduledAt),
            conductedByMembershipId: exitRow.conductedByMembershipId ?? null,
            structuredResponses: exitRow.structuredResponses ?? null,
            freeText: exitRow.freeText ?? null,
            submittedAt: toIsoString(exitRow.submittedAt),
            createdAt: toIsoString(exitRow.createdAt) ?? new Date(0).toISOString(),
            updatedAt: toIsoString(exitRow.updatedAt) ?? new Date(0).toISOString(),
          }
        : null;

      const settlement: FinalSettlementRow | null = settleRow
        ? {
            id: settleRow.id,
            caseId: settleRow.caseId,
            status: settleRow.status as FinalSettlementStatus,
            amountMinor: settleRow.amountMinor != null ? Number(settleRow.amountMinor) : null,
            currency: settleRow.currency ?? null,
            breakdown: settleRow.breakdown ?? null,
            approvedByMembershipId: settleRow.approvedByMembershipId ?? null,
            paidAt: toIsoString(settleRow.paidAt),
            createdAt: toIsoString(settleRow.createdAt) ?? new Date(0).toISOString(),
            updatedAt: toIsoString(settleRow.updatedAt) ?? new Date(0).toISOString(),
          }
        : null;

      return {
        case: {
          id: caseRow.id,
          candidateId: caseRow.candidateId,
          applicationId: caseRow.applicationId ?? null,
          onboardingCaseId: caseRow.onboardingCaseId ?? null,
          initiationType: caseRow.initiationType as OffboardingInitiationType,
          status: caseRow.status as OffboardingCaseStatus,
          noticeStartDate: caseRow.noticeStartDate ?? null,
          lastWorkingDay: caseRow.lastWorkingDay ?? null,
          reason: caseRow.reason ?? null,
          initiatedByMembershipId: caseRow.initiatedByMembershipId,
          managerMembershipId: caseRow.managerMembershipId ?? null,
          candidateName: caseRow.candidateName ?? null,
          managerName: manager?.displayName ?? null,
          managerEmail: manager?.email ?? null,
          initiatedByName: initiator?.displayName ?? initiator?.email ?? null,
          createdAt: toIsoString(caseRow.createdAt) ?? new Date(0).toISOString(),
          updatedAt: toIsoString(caseRow.updatedAt) ?? new Date(0).toISOString(),
        },
        tasks,
        assetReturns: assetReturnRows,
        exitInterview,
        settlement,
      };
    }),

  /**
   * listHiredCandidates — the picker behind the initiate-offboarding flow.
   * "Hired" mirrors the offboarding lib's resolveHireContext predicate exactly
   * (accepted offer OR onboarding case) — HireOps has no employees table. Each
   * row flags whether the person already has a live offboarding case so the
   * picker can disable it (initiating again would 409). OFFBOARD_MANAGE_ROLES-
   * gated like the rest of the pillar; tenant scoping is explicit on ctx.sql.
   */
  listHiredCandidates: protectedProcedure
    .input(listHiredCandidatesInputSchema)
    .output(listHiredCandidatesOutputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.tenantId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "protected procedure missing tenantId",
        });
      }
      const tenantId = ctx.tenantId;
      requireAnyRole(ctx, OFFBOARD_MANAGE_ROLES, "You don't have access to offboarding.");

      const rows = await ctx.sql<
        {
          candidate_id: string;
          person_name: string | null;
          email: string | null;
          onboarding_status: string | null;
          has_active_offboarding_case: boolean;
        }[]
      >`
        SELECT
          c.id AS candidate_id,
          p.full_name AS person_name,
          p.email_primary AS email,
          (
            SELECT oc.status FROM public.onboarding_cases oc
            WHERE oc.tenant_id = c.tenant_id AND oc.candidate_id = c.id
            ORDER BY oc.created_at DESC LIMIT 1
          ) AS onboarding_status,
          EXISTS (
            SELECT 1 FROM public.offboarding_cases o
            WHERE o.tenant_id = c.tenant_id AND o.candidate_id = c.id AND o.status <> 'cancelled'
          ) AS has_active_offboarding_case
        FROM public.candidates c
        JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
        WHERE c.tenant_id = ${tenantId}
          AND (
            EXISTS (
              SELECT 1 FROM public.offers o
              JOIN public.applications a ON a.id = o.application_id AND a.tenant_id = o.tenant_id
              WHERE o.tenant_id = c.tenant_id AND a.candidate_id = c.id AND o.status = 'accepted'
            )
            OR EXISTS (
              SELECT 1 FROM public.onboarding_cases oc
              WHERE oc.tenant_id = c.tenant_id AND oc.candidate_id = c.id
            )
          )
        ORDER BY p.full_name ASC NULLS LAST, c.id ASC
        LIMIT ${input.limit}
      `;

      return {
        items: rows.map((r) => ({
          candidateId: r.candidate_id,
          personName: r.person_name ?? null,
          email: r.email ?? null,
          onboardingStatus: r.onboarding_status ?? null,
          hasActiveOffboardingCase: r.has_active_offboarding_case,
        })),
      };
    }),

  // ─────────────── PARTNER-01 — partner-portal surface ───────────────
  // All three are partnerProcedure: the tenant is resolved from
  // partner_users (NOT the JWT), and every query filters by the resolved
  // partnerOrgId on top of the tenant_isolation RLS the tx applies —
  // org-scoping is explicit because the partner tables carry only a
  // tenant-level policy.

  /**
   * partnerGetMe — org + role + display identity for the shell header.
   * Pure read of the already-resolved partner context; no DB round-trip.
   */
  partnerGetMe: partnerProcedure.output(partnerGetMeOutputSchema).query(({ ctx }) => {
    const p = ctx.partner;
    return {
      partnerUserId: p.partnerUserId,
      partnerOrgId: p.partnerOrgId,
      tenantId: p.tenantId,
      orgName: p.orgName,
      displayName: p.displayName,
      email: p.email,
      role: p.role === "partner_admin" ? ("partner_admin" as const) : ("partner_user" as const),
    };
  }),

  /**
   * partnerListAssignedRequisitions — the reqs Kyndryl has opened to this
   * partner org (partner_assignments status='active'), joined to
   * requisitions + positions for the dashboard cards. Capped for POC scale.
   */
  partnerListAssignedRequisitions: partnerProcedure
    .input(partnerListAssignedRequisitionsInputSchema)
    .output(partnerListAssignedRequisitionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "partner ctx.db missing" });
      }
      const cap = input?.limit ?? 100;
      const rows = await db
        .select({
          requisitionId: requisitions.id,
          assignmentId: partnerAssignments.id,
          title: positions.title,
          location: positions.primaryLocation,
          requisitionStatus: requisitions.status,
          numberOfOpenings: requisitions.numberOfOpenings,
          postedAt: requisitions.postedAt,
          targetStartDate: requisitions.targetStartDate,
          assignedAt: partnerAssignments.assignedAt,
        })
        .from(partnerAssignments)
        .innerJoin(
          requisitions,
          and(
            eq(requisitions.tenantId, partnerAssignments.tenantId),
            eq(requisitions.id, partnerAssignments.requisitionId),
          ),
        )
        .innerJoin(
          positions,
          and(
            eq(positions.tenantId, requisitions.tenantId),
            eq(positions.id, requisitions.positionId),
          ),
        )
        .where(
          and(
            eq(partnerAssignments.tenantId, ctx.partner.tenantId),
            eq(partnerAssignments.partnerOrgId, ctx.partner.partnerOrgId),
            eq(partnerAssignments.status, "active"),
          ),
        )
        .orderBy(desc(partnerAssignments.assignedAt))
        .limit(cap + 1);
      const capped = rows.length > cap;
      const items: PartnerAssignedRequisitionRow[] = rows.slice(0, cap).map((r) => ({
        requisitionId: r.requisitionId,
        assignmentId: r.assignmentId,
        title: r.title,
        location: r.location ?? null,
        requisitionStatus: r.requisitionStatus,
        numberOfOpenings: r.numberOfOpenings,
        postedAt: r.postedAt ? r.postedAt.toISOString() : null,
        targetStartDate: r.targetStartDate ?? null,
        assignedAt: r.assignedAt.toISOString(),
      }));
      return { items, capped };
    }),

  /**
   * partnerSubmitCandidate — the partner submits a candidate against an
   * assigned req (PARTNER-02). The req being ASSIGNED to the caller's partner
   * org is the authorization (FORBIDDEN otherwise). Runs the wireflows' dedup
   * decision tree (§3.5) inside the partnerProcedure tenant-bound tx so the
   * whole thing commits or rolls back atomically:
   *
   *   (a) no active claim → create candidate + application + ownership claim
   *       (90-day window) + dedup-attempt(accepted). The candidate enters the
   *       SAME recruiter pipeline as a direct applicant (parse/knockout/score).
   *   (b) active claim owned by ANOTHER partner → reject; record a
   *       dedup-attempt(block_active_claim). The response reveals only how many
   *       days ago it was claimed — never the owner (requirements.md §6.4).
   *   (c) active claim owned by THIS partner (another req) → add a second
   *       application for this req under the existing claim; no new claim.
   *
   * Race guard: the partial-unique index one_active_claim_per_person on
   * (tenant_id, person_id) WHERE status='active' is the DB-level guarantee that
   * two partners racing the SAME resolved person can't both create a claim —
   * the loser's INSERT violates the constraint, aborting its tx (→ CONFLICT).
   * See the hand-back note on the residual brand-new-email window.
   */
  partnerSubmitCandidate: partnerProcedure
    .input(partnerSubmitCandidateInputSchema)
    .output(partnerSubmitCandidateOutputSchema)
    .mutation(async ({ ctx, input }): Promise<PartnerSubmitCandidateOutput> => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "partner ctx.db missing" });
      }
      const { tenantId, partnerOrgId, partnerUserId } = ctx.partner;

      return withAudit(
        "partner_submit_candidate",
        ctx,
        input,
        async (): Promise<PartnerSubmitCandidateOutput> => {
          // 1. Authorization: the req MUST be actively assigned to this org.
          //    Assignment IS the authorization — no assignment, no submission.
          const [assignment] = await db
            .select({ reqStatus: requisitions.status })
            .from(partnerAssignments)
            .innerJoin(
              requisitions,
              and(
                eq(requisitions.tenantId, partnerAssignments.tenantId),
                eq(requisitions.id, partnerAssignments.requisitionId),
              ),
            )
            .where(
              and(
                eq(partnerAssignments.tenantId, tenantId),
                eq(partnerAssignments.partnerOrgId, partnerOrgId),
                eq(partnerAssignments.requisitionId, input.requisitionId),
                eq(partnerAssignments.status, "active"),
              ),
            )
            .limit(1);
          if (!assignment) {
            throw new TRPCError({ code: "FORBIDDEN", message: "requisition_not_assigned" });
          }
          if (!PUBLIC_APPLY_ACCEPTING_STATUSES.has(assignment.reqStatus)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Requisition not accepting submissions (status=${assignment.reqStatus})`,
            });
          }

          const emailNorm = normaliseEmail(input.candidate.email);
          const phoneNorm = normalisePhone(input.candidate.phone);
          const submissionMetadata: Record<string, unknown> = {
            source: "partner_portal_submit",
            requisitionId: input.requisitionId,
            currentCompany: input.candidate.currentCompany ?? null,
            currentTitle: input.candidate.currentTitle ?? null,
            noteToRecruiter: input.candidate.noteToRecruiter ?? null,
            consentVersion: input.consentVersion,
          };

          // 2. Resolve an EXISTING person by exact normalised email (the
          //    Wave-1 dedup pivot per partner-data-model.md), falling back to
          //    phone so we reuse a person a direct applicant already created.
          //    No fuzzy matching. Lookup only — creation is deferred to the
          //    "created" branch so a blocked submission creates nothing.
          const [emailMatch] = await db
            .select({ id: persons.id, linkedinUrl: persons.linkedinUrl })
            .from(persons)
            .where(and(eq(persons.tenantId, tenantId), eq(persons.emailNormalised, emailNorm)))
            .limit(1);
          const [phoneMatch] = emailMatch
            ? [undefined]
            : await db
                .select({ id: persons.id, linkedinUrl: persons.linkedinUrl })
                .from(persons)
                .where(and(eq(persons.tenantId, tenantId), eq(persons.phoneNormalised, phoneNorm)))
                .limit(1);
          const existingPerson = emailMatch ?? phoneMatch ?? null;

          // 3. If the person already exists, inspect their active claim.
          if (existingPerson) {
            const [claim] = await db
              .select({
                id: candidateOwnershipClaims.id,
                partnerOrgId: candidateOwnershipClaims.partnerOrgId,
                claimedAt: candidateOwnershipClaims.claimedAt,
                claimedViaApplicationId: candidateOwnershipClaims.claimedViaApplicationId,
              })
              .from(candidateOwnershipClaims)
              .where(
                and(
                  eq(candidateOwnershipClaims.tenantId, tenantId),
                  eq(candidateOwnershipClaims.personId, existingPerson.id),
                  eq(candidateOwnershipClaims.status, "active"),
                ),
              )
              .limit(1);

            if (claim && claim.partnerOrgId !== partnerOrgId) {
              // (b) owned by ANOTHER partner → reject. Record the block; do
              // NOT create person/candidate/application/claim.
              await db.insert(candidateDedupAttempts).values({
                tenantId,
                attemptedByPartnerUserId: partnerUserId,
                submittedEmail: input.candidate.email,
                submittedPhone: input.candidate.phone,
                matchedPersonId: existingPerson.id,
                decision: "block_active_claim",
                decisionReason: "owned_by_other_partner",
                submissionMetadata,
              });
              const blockedDaysAgo = Math.max(
                0,
                Math.floor((Date.now() - claim.claimedAt.getTime()) / 86_400_000),
              );
              return { outcome: "duplicate_blocked", blockedDaysAgo };
            }

            if (claim && claim.partnerOrgId === partnerOrgId) {
              // (c) owned by THIS partner → add a second application for this
              // req under the existing claim (no new claim — the partial
              // unique already holds one active claim for this person).
              const ingest = await ingestPartnerApplication(db, {
                tenantId,
                requisitionId: input.requisitionId,
                personId: existingPerson.id,
                resumeUploadKey: input.resumeUploadKey,
                consentVersion: input.consentVersion,
                partnerOrgId,
                partnerUserId,
                partnerSubmissionMetadata: submissionMetadata,
                log: ctx.log,
                requestId: ctx.requestId,
              });
              await db.insert(candidateDedupAttempts).values({
                tenantId,
                attemptedByPartnerUserId: partnerUserId,
                submittedEmail: input.candidate.email,
                submittedPhone: input.candidate.phone,
                matchedPersonId: existingPerson.id,
                decision: "link_existing",
                decisionReason: ingest.wasNewApplication
                  ? "added_to_existing_claim"
                  : "already_on_this_req",
                submissionMetadata,
              });
              // The req the original claim was made against, for the copy.
              let priorRequisitionTitle: string | null = null;
              if (claim.claimedViaApplicationId) {
                const [prior] = await db
                  .select({ title: positions.title })
                  .from(applications)
                  .innerJoin(
                    requisitions,
                    and(
                      eq(requisitions.tenantId, applications.tenantId),
                      eq(requisitions.id, applications.requisitionId),
                    ),
                  )
                  .innerJoin(
                    positions,
                    and(
                      eq(positions.tenantId, requisitions.tenantId),
                      eq(positions.id, requisitions.positionId),
                    ),
                  )
                  .where(
                    and(
                      eq(applications.tenantId, tenantId),
                      eq(applications.id, claim.claimedViaApplicationId),
                    ),
                  )
                  .limit(1);
                priorRequisitionTitle = prior?.title ?? null;
              }
              return {
                outcome: "added_to_existing",
                applicationId: ingest.applicationId,
                candidateId: ingest.candidateId,
                claimId: claim.id,
                alreadyOnThisReq: !ingest.wasNewApplication,
                priorRequisitionTitle,
                priorClaimedAt: claim.claimedAt.toISOString(),
                parseStatus: ingest.parseStatus,
              };
            }
            // Person exists but has NO active claim (expired/released) →
            // falls through to the "created" branch to make a fresh claim.
          }

          // 4. (a) create. Resolve or create the person first.
          let personId: string;
          let dedupDecision: "allow_new" | "link_existing";
          let dedupReason: string;
          if (existingPerson) {
            personId = existingPerson.id;
            dedupDecision = "link_existing";
            dedupReason = "reclaimed_no_active_claim";
            if (!existingPerson.linkedinUrl && input.candidate.linkedinUrl) {
              await db
                .update(persons)
                .set({ linkedinUrl: input.candidate.linkedinUrl, updatedAt: new Date() })
                .where(and(eq(persons.tenantId, tenantId), eq(persons.id, personId)));
            }
          } else {
            personId = await db
              .insert(persons)
              .values({
                tenantId,
                fullName: input.candidate.fullName,
                emailPrimary: input.candidate.email,
                emailNormalised: emailNorm,
                phonePrimary: input.candidate.phone,
                phoneNormalised: phoneNorm,
                locationCountry: input.candidate.locationCountry ?? null,
                linkedinUrl: input.candidate.linkedinUrl ?? null,
              })
              .returning({ id: persons.id })
              .then((rows) => firstOrThrow(rows, "partner person insert").id);
            dedupDecision = "allow_new";
            dedupReason = "no_match";
          }

          const ingest = await ingestPartnerApplication(db, {
            tenantId,
            requisitionId: input.requisitionId,
            personId,
            resumeUploadKey: input.resumeUploadKey,
            consentVersion: input.consentVersion,
            partnerOrgId,
            partnerUserId,
            partnerSubmissionMetadata: submissionMetadata,
            log: ctx.log,
            requestId: ctx.requestId,
          });

          // The ownership claim — 90-day exclusivity window from now. The
          // partial-unique index is the race guard: a concurrent claim for the
          // same person makes this INSERT throw, rolling the whole tx back.
          const claimedAt = new Date();
          const expiresAt = new Date(claimedAt.getTime() + PARTNER_CLAIM_WINDOW_DAYS * 86_400_000);
          let claimId: string;
          try {
            claimId = await db
              .insert(candidateOwnershipClaims)
              .values({
                tenantId,
                personId,
                partnerOrgId,
                claimedViaPartnerUserId: partnerUserId,
                claimedViaApplicationId: ingest.applicationId,
                claimedAt,
                expiresAt,
                status: "active",
                releasedReason: null,
              })
              .returning({ id: candidateOwnershipClaims.id })
              .then((rows) => firstOrThrow(rows, "ownership claim insert").id);
          } catch (err) {
            // 23505 = unique_violation — another submission claimed this person
            // first (the partial-unique race guard fired). The tx rolls back.
            const code =
              typeof err === "object" && err !== null && "code" in err
                ? (err as { code?: string }).code
                : undefined;
            if (code === "23505") {
              throw new TRPCError({
                code: "CONFLICT",
                message: "candidate_claimed_concurrently",
              });
            }
            throw err;
          }

          await db.insert(candidateDedupAttempts).values({
            tenantId,
            attemptedByPartnerUserId: partnerUserId,
            submittedEmail: input.candidate.email,
            submittedPhone: input.candidate.phone,
            matchedPersonId: dedupDecision === "link_existing" ? personId : null,
            decision: dedupDecision,
            decisionReason: dedupReason,
            submissionMetadata,
          });

          return {
            outcome: "created",
            applicationId: ingest.applicationId,
            candidateId: ingest.candidateId,
            claimId,
            personId,
            parseStatus: ingest.parseStatus,
            claimExpiresAt: expiresAt.toISOString(),
          };
        },
        { tenantIdOverride: tenantId },
      );
    }),

  /**
   * partnerListMySubmissions — the org's candidate submissions, read from
   * candidate_ownership_claims (the Wave-1 submission model per
   * partner-data-model.md), joined through the claiming application to the
   * requisition + position for the role title, and to persons for the
   * candidate name. Returns [] until partner submission flow ships — the
   * shell renders an explicit empty/coming-soon state in that case.
   */
  partnerListMySubmissions: partnerProcedure
    .input(partnerListMySubmissionsInputSchema)
    .output(partnerListMySubmissionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "partner ctx.db missing" });
      }
      const cap = input?.limit ?? 100;
      const rows = await db
        .select({
          claimId: candidateOwnershipClaims.id,
          candidateName: persons.fullName,
          requisitionTitle: positions.title,
          status: candidateOwnershipClaims.status,
          claimedAt: candidateOwnershipClaims.claimedAt,
          expiresAt: candidateOwnershipClaims.expiresAt,
          applicationId: applications.id,
          requisitionId: applications.requisitionId,
          stage: applications.currentStage,
        })
        .from(candidateOwnershipClaims)
        .leftJoin(
          persons,
          and(
            eq(persons.tenantId, candidateOwnershipClaims.tenantId),
            eq(persons.id, candidateOwnershipClaims.personId),
          ),
        )
        .leftJoin(
          applications,
          and(
            eq(applications.tenantId, candidateOwnershipClaims.tenantId),
            eq(applications.id, candidateOwnershipClaims.claimedViaApplicationId),
          ),
        )
        .leftJoin(
          requisitions,
          and(
            eq(requisitions.tenantId, applications.tenantId),
            eq(requisitions.id, applications.requisitionId),
          ),
        )
        .leftJoin(
          positions,
          and(
            eq(positions.tenantId, requisitions.tenantId),
            eq(positions.id, requisitions.positionId),
          ),
        )
        .where(
          and(
            eq(candidateOwnershipClaims.tenantId, ctx.partner.tenantId),
            eq(candidateOwnershipClaims.partnerOrgId, ctx.partner.partnerOrgId),
          ),
        )
        .orderBy(desc(candidateOwnershipClaims.claimedAt))
        .limit(cap + 1);
      const capped = rows.length > cap;
      const items: PartnerSubmissionRow[] = rows.slice(0, cap).map((r) => ({
        claimId: r.claimId,
        candidateName: r.candidateName ?? null,
        requisitionTitle: r.requisitionTitle ?? null,
        status: r.status,
        claimedAt: r.claimedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        applicationId: r.applicationId ?? null,
        requisitionId: r.requisitionId ?? null,
        stage: r.stage ?? null,
      }));
      return { items, capped };
    }),

  // ─────────────── CAND-01 — candidate accounts (Wave C) ───────────────
  //
  // Two PUBLIC procedures drive activation (no open self-signup): request a
  // link → complete with a password. Four candidateProcedure reads/writes
  // power the dashboard. candidateProcedure resolves tenant + person from
  // candidate_accounts and every read is filtered by ctx.candidate.personId —
  // person-scoping is explicit (the table carries only a tenant policy).

  /**
   * requestCandidateActivation — public. If a person with this email exists
   * in the tenant, upsert a PENDING candidate_accounts row carrying the
   * SHA-256 of a single-use signed link and email that link. ALWAYS returns
   * { ok: true } — no account enumeration (requirements.md §9.2).
   */
  requestCandidateActivation: publicProcedure
    .input(requestCandidateActivationInputSchema)
    .output(requestCandidateActivationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const emailNorm = normaliseEmail(input.email);

      // Resolve tenant by slug. Missing tenant → still return ok (no leak).
      const [tenant] = await ctx.sql<{ id: string; display_name: string }[]>`
        SELECT id, display_name FROM public.tenants
        WHERE slug = ${input.tenantSlug} AND status = 'active' LIMIT 1
      `;
      if (!tenant) return { ok: true as const };

      return withAudit(
        "request_candidate_activation",
        ctx,
        { tenantSlug: input.tenantSlug },
        async () => {
          // Person must already exist in the tenant (created via apply). No
          // person → silently succeed (indistinguishable to the caller).
          const [person] = await ctx.sql<
            { id: string; full_name: string | null; email_primary: string | null }[]
          >`
            SELECT id, full_name, email_primary FROM public.persons
            WHERE tenant_id = ${tenant.id} AND email_normalised = ${emailNorm}
              AND redacted_at IS NULL
            LIMIT 1
          `;
          if (!person) return { ok: true as const };

          // Already-active account → nothing to do (don't re-issue; don't leak).
          const [existing] = await ctx.sql<{ id: string; status: string }[]>`
            SELECT id, status FROM public.candidate_accounts
            WHERE tenant_id = ${tenant.id} AND person_id = ${person.id} LIMIT 1
          `;
          if (existing && existing.status === "active") return { ok: true as const };

          // Upsert the pending row (unique on (tenant_id, person_id)). Get the
          // id first so the signed link's subject is the real account row.
          const [row] = await ctx.sql<{ id: string }[]>`
            INSERT INTO public.candidate_accounts (tenant_id, person_id, status, activation_requested_at)
            VALUES (${tenant.id}, ${person.id}, 'pending', now())
            ON CONFLICT (tenant_id, person_id) DO UPDATE
              SET status = 'pending', activation_requested_at = now(), updated_at = now()
            RETURNING id
          `;
          if (!row) return { ok: true as const };

          const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
          const token = signLink({
            action: "candidate.activate_account",
            subjectId: row.id,
            expiresAt,
          });
          const tokenHash = hashToken(token);
          await ctx.sql`
            UPDATE public.candidate_accounts
            SET activation_token_hash = ${tokenHash}, updated_at = now()
            WHERE id = ${row.id}
          `;

          const recipientEmail = person.email_primary ?? input.email;
          const portalBase = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
          const activationUrl = `${portalBase}/candidate/activate/${token}`;
          try {
            await enqueueNotification(poolDb, {
              tenantId: tenant.id,
              recipientType: "candidate",
              recipientEmail,
              templateKey: "candidate.account_activation",
              templateData: {
                candidateName: (person.full_name ?? "there").split(" ")[0] ?? "there",
                companyName: tenant.display_name,
                activationUrl,
              },
              dedupKey: `candidate_activation:${row.id}:${tokenHash.slice(0, 16)}`,
            });
          } catch (err) {
            ctx.log.warn(
              { err, request_id: ctx.requestId, tenant_id: tenant.id },
              "requestCandidateActivation: enqueueNotification failed",
            );
          }
          return { ok: true as const };
        },
        { tenantIdOverride: tenant.id },
      );
    }),

  /**
   * completeCandidateActivation — public. Verify the signed link, locate the
   * PENDING account by token hash, create the Supabase auth user, flip the
   * account to active, and NULL the hash. Single-use is intrinsic: once
   * consumed the hash is gone and status='active', so a replay 404s at the
   * lookup. Records a signed_link_uses row for audit (mirrors the interview
   * confirm route).
   */
  completeCandidateActivation: publicProcedure
    .input(completeCandidateActivationInputSchema)
    .output(completeCandidateActivationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const verify = verifyLink(input.token);
      if (!verify.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `activation_link_${verify.reason}` });
      }
      if (verify.payload.action !== "candidate.activate_account") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "activation_link_wrong_action" });
      }
      const tokenHash = verify.payload.tokenHash;

      const [pending] = await ctx.sql<
        {
          id: string;
          tenant_id: string;
          person_id: string;
          email_primary: string | null;
        }[]
      >`
        SELECT ca.id, ca.tenant_id, ca.person_id, p.email_primary
        FROM public.candidate_accounts ca
        JOIN public.persons p ON p.id = ca.person_id AND p.tenant_id = ca.tenant_id
        WHERE ca.activation_token_hash = ${tokenHash} AND ca.status = 'pending'
        LIMIT 1
      `;
      if (!pending) {
        // Hash cleared on first use, or never issued → replay / invalid.
        throw new TRPCError({ code: "BAD_REQUEST", message: "activation_already_used_or_invalid" });
      }
      const email = pending.email_primary;
      if (!email) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "activation_no_email_on_person" });
      }

      return withAudit(
        "complete_candidate_activation",
        ctx,
        { candidateAccountId: pending.id },
        async () => {
          const { userId, alreadyExisted } = await createOrResolveAuthUser(email, input.password);
          if (alreadyExisted) {
            ctx.log.warn(
              { request_id: ctx.requestId, tenant_id: pending.tenant_id },
              "completeCandidateActivation: reused an existing auth.users identity for candidate",
            );
          }

          // Atomic flip — only the still-pending row wins; a concurrent second
          // completion fails the WHERE and gets already_used.
          const [updated] = await ctx.sql<{ activated_at: Date | string }[]>`
            UPDATE public.candidate_accounts
            SET user_id = ${userId}, status = 'active', activated_at = now(),
                activation_token_hash = NULL, updated_at = now()
            WHERE id = ${pending.id} AND status = 'pending'
            RETURNING activated_at
          `;
          if (!updated) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "activation_already_used" });
          }

          // Append-only audit of the link redemption (best-effort; the partial
          // unique on (tenant, token_hash) WHERE successful blocks a re-use).
          try {
            await ctx.sql`
              INSERT INTO public.signed_link_uses
                (tenant_id, token_hash, action, subject_id, redeemed_by_ip, successful, failure_reason)
              VALUES (${pending.tenant_id}, ${tokenHash}, 'candidate.activate_account',
                      ${pending.id}, ${ctx.ipAddress}, true, null)
            `;
          } catch (err) {
            ctx.log.warn(
              { err, request_id: ctx.requestId },
              "completeCandidateActivation: signed_link_uses insert skipped",
            );
          }
          return { ok: true as const, email };
        },
        { tenantIdOverride: pending.tenant_id },
      );
    }),

  /**
   * candidateGetMe — the resolved candidate identity for the dashboard header.
   * Pure read of the already-resolved context; no DB round-trip.
   */
  candidateGetMe: candidateProcedure.output(candidateGetMeOutputSchema).query(({ ctx }) => {
    const c = ctx.candidate;
    return {
      candidateAccountId: c.candidateAccountId,
      personId: c.personId,
      tenantId: c.tenantId,
      tenantDisplayName: c.tenantDisplayName,
      fullName: c.fullName,
      email: c.email,
    };
  }),

  /**
   * candidateListMyApplications — the caller's own applications, person-scoped
   * via candidates.person_id = ctx.candidate.personId. Each row carries the
   * current stage + the ordered stepper vocabulary (the REAL application_stage
   * enum order, no invented stages).
   */
  candidateListMyApplications: candidateProcedure
    .output(candidateListMyApplicationsOutputSchema)
    .query(async ({ ctx }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "candidate ctx.db missing" });
      }
      const rows = await db
        .select({
          applicationId: applications.id,
          requisitionId: applications.requisitionId,
          positionTitle: positions.title,
          location: positions.primaryLocation,
          currentStage: applications.currentStage,
          appliedAt: applications.createdAt,
        })
        .from(applications)
        .innerJoin(
          candidates,
          and(
            eq(candidates.tenantId, applications.tenantId),
            eq(candidates.id, applications.candidateId),
          ),
        )
        .innerJoin(
          requisitions,
          and(
            eq(requisitions.tenantId, applications.tenantId),
            eq(requisitions.id, applications.requisitionId),
          ),
        )
        .innerJoin(
          positions,
          and(
            eq(positions.tenantId, requisitions.tenantId),
            eq(positions.id, requisitions.positionId),
          ),
        )
        .where(
          and(
            eq(applications.tenantId, ctx.candidate.tenantId),
            eq(candidates.personId, ctx.candidate.personId),
          ),
        )
        .orderBy(desc(applications.createdAt));

      const items: CandidateApplicationRow[] = rows.map((r) => ({
        applicationId: r.applicationId,
        requisitionId: r.requisitionId,
        positionTitle: r.positionTitle,
        location: r.location ?? null,
        currentStage: r.currentStage,
        stageSteps: [...CANDIDATE_STAGE_STEPS],
        appliedAt: r.appliedAt.toISOString(),
      }));
      return { items };
    }),

  /**
   * candidateListMyInterviews — the caller's own interviews, person-scoped via
   * candidates.person_id. Upcoming + past, with round, when, mode, meeting URL
   * and confirmed state.
   */
  candidateListMyInterviews: candidateProcedure
    .output(candidateListMyInterviewsOutputSchema)
    .query(async ({ ctx }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "candidate ctx.db missing" });
      }
      const rows = await db
        .select({
          interviewId: interviews.id,
          positionTitle: positions.title,
          roundName: interviews.roundName,
          status: interviews.status,
          mode: interviews.mode,
          scheduledStart: interviews.scheduledStart,
          durationMinutes: interviews.durationMinutes,
          meetingUrl: interviews.meetingUrl,
          confirmedAt: interviews.candidateConfirmedAt,
        })
        .from(interviews)
        .innerJoin(
          applications,
          and(
            eq(applications.tenantId, interviews.tenantId),
            eq(applications.id, interviews.applicationId),
          ),
        )
        .innerJoin(
          candidates,
          and(
            eq(candidates.tenantId, applications.tenantId),
            eq(candidates.id, applications.candidateId),
          ),
        )
        .innerJoin(
          requisitions,
          and(
            eq(requisitions.tenantId, interviews.tenantId),
            eq(requisitions.id, interviews.requisitionId),
          ),
        )
        .innerJoin(
          positions,
          and(
            eq(positions.tenantId, requisitions.tenantId),
            eq(positions.id, requisitions.positionId),
          ),
        )
        .where(
          and(
            eq(interviews.tenantId, ctx.candidate.tenantId),
            eq(candidates.personId, ctx.candidate.personId),
          ),
        )
        .orderBy(desc(interviews.scheduledStart));

      // HRHEAD-03 feedbackSharing — surface submitted-feedback highlights on
      // COMPLETED interviews only, and only what the tenant's policy opts into.
      // Scores are NEVER selected (the read touches strengths + recommendation
      // only). The feedback rows are person-safe because we scope to the
      // interview ids already fetched for THIS candidate's person above.
      const sharing = await resolveTenantFeedbackSharingDb(ctx.candidate.tenantId);
      const completedIds = rows.filter((r) => r.status === "completed").map((r) => r.interviewId);
      const sharedByInterview = new Map<
        string,
        { summary: string | null; recommendation: string | null }
      >();
      if ((sharing.shareInterviewSummary || sharing.shareRecommendation) && completedIds.length) {
        const fbRes = await db.execute(dsql`
          SELECT
            interview_id,
            string_agg(NULLIF(btrim(strengths), ''), E'\n\n' ORDER BY submitted_at) AS summary,
            (array_agg(recommendation ORDER BY submitted_at DESC))[1] AS recommendation
          FROM public.interview_feedback
          WHERE tenant_id = ${ctx.candidate.tenantId}::uuid
            AND submitted_at IS NOT NULL
            AND interview_id IN (${dsql.join(
              completedIds.map((id) => dsql`${id}::uuid`),
              dsql.raw(", "),
            )})
          GROUP BY interview_id
        `);
        const fbRows =
          (
            fbRes as {
              rows?: {
                interview_id: string;
                summary: string | null;
                recommendation: string | null;
              }[];
            }
          ).rows ??
          (fbRes as unknown as {
            interview_id: string;
            summary: string | null;
            recommendation: string | null;
          }[]);
        for (const f of fbRows) {
          sharedByInterview.set(f.interview_id, {
            summary: sharing.shareInterviewSummary ? (f.summary ?? null) : null,
            recommendation: sharing.shareRecommendation ? (f.recommendation ?? null) : null,
          });
        }
      }

      const now = Date.now();
      const items: CandidateInterviewRow[] = rows.map((r) => {
        const startMs = r.scheduledStart ? new Date(r.scheduledStart).getTime() : null;
        const isUpcoming = r.status === "scheduled" && startMs !== null && startMs >= now;
        const shared = r.status === "completed" ? sharedByInterview.get(r.interviewId) : undefined;
        return {
          interviewId: r.interviewId,
          positionTitle: r.positionTitle,
          roundName: r.roundName,
          status: r.status as CandidateInterviewRow["status"],
          mode: r.mode as CandidateInterviewRow["mode"],
          scheduledStart: r.scheduledStart ? new Date(r.scheduledStart).toISOString() : null,
          durationMinutes: r.durationMinutes,
          meetingUrl: r.meetingUrl ?? null,
          confirmedAt: r.confirmedAt ? new Date(r.confirmedAt).toISOString() : null,
          isUpcoming,
          sharedSummary: shared?.summary ?? null,
          sharedRecommendation: shared?.recommendation ?? null,
        };
      });
      return { items };
    }),

  /**
   * candidateConfirmInterview — the authenticated equivalent of the public
   * signed-link confirm. Stamps candidate_confirmed_at for an interview that
   * belongs to THIS candidate's person (person-scoping enforced explicitly —
   * candidate A cannot confirm candidate B's round). The signed-link route
   * (routes/interviews.ts) stays for email users.
   */
  candidateConfirmInterview: candidateProcedure
    .input(candidateConfirmInterviewInputSchema)
    .output(candidateConfirmInterviewOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "candidate ctx.db missing" });
      }
      return withAudit(
        "candidate_confirm_interview",
        ctx,
        { interviewId: input.interviewId },
        async () => {
          // Ownership check: the interview's application → candidate → person
          // MUST be this candidate's person. RLS scopes to tenant; this scopes
          // to the person.
          const [owned] = await db
            .select({
              id: interviews.id,
              status: interviews.status,
              confirmedAt: interviews.candidateConfirmedAt,
            })
            .from(interviews)
            .innerJoin(
              applications,
              and(
                eq(applications.tenantId, interviews.tenantId),
                eq(applications.id, interviews.applicationId),
              ),
            )
            .innerJoin(
              candidates,
              and(
                eq(candidates.tenantId, applications.tenantId),
                eq(candidates.id, applications.candidateId),
              ),
            )
            .where(
              and(
                eq(interviews.tenantId, ctx.candidate.tenantId),
                eq(interviews.id, input.interviewId),
                eq(candidates.personId, ctx.candidate.personId),
              ),
            )
            .limit(1);
          if (!owned) {
            // Not found OR not this candidate's — same opaque error either way.
            throw new TRPCError({ code: "NOT_FOUND", message: "interview_not_found" });
          }
          if (owned.status === "cancelled") {
            throw new TRPCError({ code: "CONFLICT", message: "already_cancelled" });
          }

          const nowTs = new Date();
          const [updated] = await db
            .update(interviews)
            .set({ candidateConfirmedAt: nowTs, updatedAt: nowTs })
            .where(
              and(
                eq(interviews.tenantId, ctx.candidate.tenantId),
                eq(interviews.id, input.interviewId),
                isNull(interviews.candidateConfirmedAt),
              ),
            )
            .returning({ confirmedAt: interviews.candidateConfirmedAt });

          const confirmedAt = updated?.confirmedAt ?? owned.confirmedAt ?? nowTs;
          return {
            ok: true as const,
            interviewId: input.interviewId,
            confirmedAt: new Date(confirmedAt).toISOString(),
          };
        },
      );
    }),

  // ─────────────── CAND-02 — candidate documents + in-portal offer ───────────────
  //
  // Four candidateProcedure procedures fill CAND-01's "Documents & offers"
  // placeholder. Every read/write is person-scoped by ctx.candidate.personId on
  // top of the tenant_isolation RLS the tx applies — the case/offer/document
  // must trace offer|case → application → candidate → person = the caller's
  // person, or it resolves to NOT_FOUND (never a cross-person leak).

  /**
   * candidateGetMyOffer — the candidate's latest extended-or-accepted offer,
   * disclosing NO MORE than the public signed-link offer page (routes/offers.ts
   * `GET /preview/:token`): company, position, comp, joining date, location,
   * expiry, terms, status. Returns { offer: null } when they have none.
   */
  candidateGetMyOffer: candidateProcedure
    .output(candidateGetMyOfferOutputSchema)
    .query(async ({ ctx }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "candidate ctx.db missing" });
      }
      const result = await db.execute(dsql`
        SELECT
          o.id::text AS offer_id,
          o.application_id::text AS application_id,
          o.status,
          o.base_salary_inr_paise::text AS base_salary_inr_paise,
          o.variable_target_inr_paise::text AS variable_target_inr_paise,
          o.joining_bonus_inr_paise::text AS joining_bonus_inr_paise,
          o.joining_date::text AS joining_date,
          o.location,
          o.expiry_at,
          o.terms_html,
          o.contract_type,
          o.probation_months,
          o.benefits,
          pos.title AS position_title,
          t.display_name AS company_name
        FROM public.offers o
        JOIN public.applications a ON a.id = o.application_id AND a.tenant_id = o.tenant_id
        JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = o.tenant_id
        JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = o.tenant_id
        JOIN public.positions pos ON pos.id = r.position_id AND pos.tenant_id = o.tenant_id
        JOIN public.tenants t ON t.id = o.tenant_id
        WHERE o.tenant_id = ${ctx.candidate.tenantId}
          AND c.person_id = ${ctx.candidate.personId}
          AND o.status IN ('extended', 'accepted')
        ORDER BY o.created_at DESC
        LIMIT 1
      `);
      const rows =
        (result as unknown as { rows?: CandidateOfferSqlRow[] }).rows ??
        (result as unknown as CandidateOfferSqlRow[]);
      const row = rows[0];
      if (!row) return { offer: null };

      return {
        offer: {
          offerId: row.offer_id,
          applicationId: row.application_id,
          status: row.status,
          companyName: row.company_name,
          positionTitle: row.position_title,
          baseSalaryInrPaise: Number(row.base_salary_inr_paise),
          variableTargetInrPaise:
            row.variable_target_inr_paise !== null ? Number(row.variable_target_inr_paise) : null,
          joiningBonusInrPaise:
            row.joining_bonus_inr_paise !== null ? Number(row.joining_bonus_inr_paise) : null,
          joiningDate: row.joining_date,
          location: row.location,
          expiryAt: new Date(row.expiry_at as string | Date).toISOString(),
          termsHtml: row.terms_html,
          // C10 — real terms (contract type / probation / benefits). `benefits`
          // is jsonb string[]; keep only string entries defensively.
          contractType: row.contract_type ?? null,
          probationMonths:
            row.probation_months !== null && row.probation_months !== undefined
              ? Number(row.probation_months)
              : null,
          benefits: Array.isArray(row.benefits)
            ? (row.benefits as unknown[]).filter((b): b is string => typeof b === "string")
            : [],
        },
      };
    }),

  /**
   * candidateAcceptOffer — the authenticated twin of the public signed-link
   * accept. Person-scopes to THEIR offer, then runs the SAME single-winner
   * transition + side-effects (Workday enqueue, onboarding case, recruiter
   * notice) via the shared helper. The public link route stays for email users.
   */
  candidateAcceptOffer: candidateProcedure
    .input(candidateAcceptOfferInputSchema)
    .output(candidateAcceptOfferOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("candidate_accept_offer", ctx, { offerId: input.offerId }, async () => {
        // Person-scoped ownership: the offer's application → candidate → person
        // MUST be this candidate's person. A cross-person offer id resolves to
        // no row → NOT_FOUND (opaque, same as candidateConfirmInterview).
        const [offer] = await ctx.sql<
          { id: string; application_id: string; status: string; expiry_at: Date | string }[]
        >`
          SELECT o.id, o.application_id, o.status, o.expiry_at
          FROM public.offers o
          JOIN public.applications a ON a.id = o.application_id AND a.tenant_id = o.tenant_id
          JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = o.tenant_id
          WHERE o.tenant_id = ${ctx.candidate.tenantId}
            AND c.person_id = ${ctx.candidate.personId}
            AND o.id = ${input.offerId}
          LIMIT 1
        `;
        if (!offer) {
          throw new TRPCError({ code: "NOT_FOUND", message: "offer_not_found" });
        }
        if (offer.status !== "extended") {
          // Already accepted / declined / cancelled — clean double-accept path.
          throw new TRPCError({ code: "CONFLICT", message: "already_resolved" });
        }
        const expiryMs = new Date(offer.expiry_at as string | Date).getTime();
        if (Number.isFinite(expiryMs) && expiryMs < Date.now()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "offer_expired" });
        }

        const won = await acceptOfferAtomically(ctx.sql, {
          offerId: offer.id,
          ip: ctx.ipAddress,
          userAgent: ctx.userAgent,
        });
        if (!won) {
          // Lost the race to a concurrent link/portal accept.
          throw new TRPCError({ code: "CONFLICT", message: "already_resolved" });
        }

        await runOfferAcceptSideEffects(ctx.sql, {
          tenantId: ctx.candidate.tenantId,
          applicationId: offer.application_id,
          offerId: offer.id,
          log: ctx.log,
        });

        return {
          ok: true as const,
          offerId: offer.id,
          applicationId: offer.application_id,
          status: "accepted" as const,
        };
      });
    }),

  /**
   * candidateGetMyOnboarding — the candidate's onboarding case (if any, latest)
   * plus its document-collection checklist, each slot carrying the current
   * uploaded document + its verification status. Person-scoped via
   * case → candidate → person = the caller.
   */
  candidateGetMyOnboarding: candidateProcedure
    .output(candidateGetMyOnboardingOutputSchema)
    .query(async ({ ctx }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "candidate ctx.db missing" });
      }

      const caseResult = await db.execute(dsql`
        SELECT
          oc.id::text AS id,
          oc.status,
          oc.expected_start_date::text AS expected_start_date,
          pos.title AS position_title
        FROM public.onboarding_cases oc
        JOIN public.candidates c ON c.id = oc.candidate_id AND c.tenant_id = oc.tenant_id
        LEFT JOIN public.applications a
          ON a.id = oc.application_id AND a.tenant_id = oc.tenant_id
        LEFT JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = oc.tenant_id
        LEFT JOIN public.positions pos ON pos.id = r.position_id AND pos.tenant_id = oc.tenant_id
        WHERE oc.tenant_id = ${ctx.candidate.tenantId}
          AND c.person_id = ${ctx.candidate.personId}
        ORDER BY oc.created_at DESC
        LIMIT 1
      `);
      const caseRows =
        (caseResult as unknown as { rows?: CandidateOnbCaseSqlRow[] }).rows ??
        (caseResult as unknown as CandidateOnbCaseSqlRow[]);
      const caseRow = caseRows[0];
      if (!caseRow) {
        return { case: null, documents: [] };
      }

      // One row per document_collection task, left-joined to its current
      // uploaded document (single-current per type). Person-scope is already
      // proven by the case lookup above; case_id filter keeps it to this case.
      const docResult = await db.execute(dsql`
        SELECT
          (t.metadata->>'documentTypeId') AS document_type_id,
          COALESCE(dt.name, t.title) AS document_type_name,
          t.status AS task_status,
          d.id::text AS document_id,
          d.verification_status,
          d.file_name,
          d.rejection_reason,
          d.uploaded_at
        FROM public.onboarding_tasks t
        LEFT JOIN public.document_types dt
          ON dt.id = NULLIF(t.metadata->>'documentTypeId', '')::uuid
        LEFT JOIN public.onboarding_documents d
          ON d.tenant_id = t.tenant_id
          AND d.case_id = t.case_id
          AND d.document_type_id = NULLIF(t.metadata->>'documentTypeId', '')::uuid
        WHERE t.tenant_id = ${ctx.candidate.tenantId}
          AND t.case_id = ${caseRow.id}
          AND t.task_type = 'document_collection'
        ORDER BY t.created_at, t.id
      `);
      const docRows =
        (docResult as unknown as { rows?: CandidateOnbDocSqlRow[] }).rows ??
        (docResult as unknown as CandidateOnbDocSqlRow[]);

      const documents = docRows
        .filter((r) => r.document_type_id)
        .map((r) => ({
          documentTypeId: r.document_type_id as string,
          documentTypeName: r.document_type_name ?? null,
          taskStatus: r.task_status,
          document: r.document_id
            ? {
                documentId: r.document_id,
                verificationStatus: r.verification_status ?? "pending",
                fileName: r.file_name ?? null,
                rejectionReason: r.rejection_reason ?? null,
                uploadedAt: r.uploaded_at
                  ? new Date(r.uploaded_at as string | Date).toISOString()
                  : null,
              }
            : null,
        }));

      return {
        case: {
          id: caseRow.id,
          status: caseRow.status,
          positionTitle: caseRow.position_title ?? null,
          expectedStartDate: caseRow.expected_start_date ?? null,
        },
        documents,
      };
    }),

  /**
   * candidateAttachDocument — the candidate's own upload-then-attach against
   * THEIR onboarding case + a document type. Person-scoped case ownership check,
   * then the SAME find-or-replace + task-progression internals the recruiter
   * attach uses (shared attachDocumentToCase). Verification stays recruiter-side.
   */
  candidateAttachDocument: candidateProcedure
    .input(attachOnboardingDocumentInputSchema)
    .output(attachOnboardingDocumentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit(
        "candidate_attach_document",
        ctx,
        { caseId: input.caseId, documentTypeId: input.documentTypeId },
        async () => {
          const db = ctx.db;
          if (!db) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "candidate ctx.db missing",
            });
          }

          // Person-scoped case ownership: the case → candidate → person MUST be
          // this candidate's. RLS scopes to tenant; this scopes to the person.
          const [owned] = await db
            .select({ id: onboardingCases.id })
            .from(onboardingCases)
            .innerJoin(
              candidates,
              and(
                eq(candidates.tenantId, onboardingCases.tenantId),
                eq(candidates.id, onboardingCases.candidateId),
              ),
            )
            .where(
              and(
                eq(onboardingCases.tenantId, ctx.candidate.tenantId),
                eq(onboardingCases.id, input.caseId),
                eq(candidates.personId, ctx.candidate.personId),
              ),
            )
            .limit(1);
          if (!owned) {
            throw new TRPCError({ code: "NOT_FOUND", message: "onboarding_case_not_found" });
          }

          // document_types is a tenant-agnostic reference table — validate the
          // id for a clean 404 instead of an FK error.
          const [dtRow] = await db
            .select({ id: documentTypes.id })
            .from(documentTypes)
            .where(eq(documentTypes.id, input.documentTypeId))
            .limit(1);
          if (!dtRow) {
            throw new TRPCError({ code: "NOT_FOUND", message: "document_type_not_found" });
          }

          const result = await attachDocumentToCase(db, ctx.candidate.tenantId, {
            caseId: input.caseId,
            documentTypeId: input.documentTypeId,
            storageKey: input.storageKey,
            fileName: input.fileName,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
          });

          return {
            documentId: result.documentId,
            verificationStatus: result.verificationStatus,
            created: result.created,
            taskId: result.taskId,
            taskStatus: result.taskStatus as OnboardingTaskRow["status"] | null,
          };
        },
      );
    }),

  // ═══════════ DASH-01 — persona landing dashboards ═══════════
  //
  // ONE aggregate read per persona. protectedProcedure guarantees ctx.db +
  // tenant scoping; requireAnyRole then gates to an internal persona role (a
  // candidate/partner JWT never carries `tid`, so it is rejected UNAUTHORIZED
  // upstream before ever reaching this gate). Every number is real (counts off
  // the live tables, tenant-scoped + explicit filters, no AI) and every href
  // deep-links an existing surface. Multi-role internal users get a merged view
  // (sections composed per held role); admin gets the condensed superset.

  getMyDashboard: protectedProcedure
    .output(getMyDashboardOutputSchema)
    .query(async ({ ctx }): Promise<GetMyDashboardOutput> => {
      requireAnyRole(ctx, DASHBOARD_PERSONA_ROLES, "A dashboard requires an internal tenant role.");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const membershipId = await resolveActorMembership(db, ctx);
      return buildInternalDashboard(db, ctx.tenantId, ctx.roles, membershipId);
    }),

  /**
   * getHrHeadDashboardExtras (HRHEAD-01) — the bespoke HR-head landing read.
   * Separate from getMyDashboard (whose flat {kpis, actions} shape feeds the
   * "Tasks due today" strip) so the hero KPI + delta, stage funnel with
   * bottleneck, decide-inline approvals list and risk panel each get a typed
   * home. hr_head + admin only (same gate as the approvals queue).
   */
  getHrHeadDashboardExtras: protectedProcedure
    .output(getHrHeadDashboardExtrasOutputSchema)
    .query(async ({ ctx }): Promise<GetHrHeadDashboardExtrasOutput> => {
      requireAnyRole(
        ctx,
        REQUISITION_APPROVAL_READ_ROLES,
        "The HR-head dashboard requires the hr_head or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      return buildHrHeadDashboardExtras(ctx, db, ctx.tenantId);
    }),

  /**
   * getRecruiterDashboardExtras (RECR-01) — the bespoke recruiter landing read,
   * beyond the getMyDashboard KPI + action payload. Everything is DETERMINISTIC
   * and tenant-scoped: a real stage-count pipeline funnel with conversion
   * deltas, priority-tagged tasks derived from live signals, stalled-candidate
   * follow-ups (Ping routes to the human-in-loop approvals flow), computed AI
   * insights (observations that link to the real SkillWeightsEditor — never an
   * auto-adjust magic button), data-completeness %, and risk flags. NO invented
   * probability tile. recruiter + admin only.
   */
  getRecruiterDashboardExtras: protectedProcedure
    .output(getRecruiterDashboardExtrasOutputSchema)
    .query(async ({ ctx }): Promise<GetRecruiterDashboardExtrasOutput> => {
      requireAnyRole(
        ctx,
        RECRUITER_DASHBOARD_ROLES,
        "The recruiter dashboard requires the recruiter or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      return buildRecruiterDashboardExtras(db, ctx.tenantId);
    }),

  /**
   * getAdminDashboardExtras (AD-01) — the bespoke admin landing read. Four
   * DETERMINISTIC, tenant-scoped governance counts for the admin dashboard
   * tiles: open requisitions, active users, active workflows (automation
   * agents), and audit events in the last 7 days. No AI, no writes, no
   * demographic inference — every number is a plain COUNT over a real table.
   * admin only (same USERS_ADMIN_ROLES set the users/costs procedures use).
   */
  getAdminDashboardExtras: protectedProcedure
    .output(getAdminDashboardExtrasOutputSchema)
    .query(async ({ ctx }): Promise<GetAdminDashboardExtrasOutput> => {
      requireAnyRole(ctx, USERS_ADMIN_ROLES, "The admin dashboard is admin-only");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;
      const asRows = <T>(res: unknown): T[] => (res as { rows?: T[] }).rows ?? (res as T[]);
      const scalar = async (query: SQL): Promise<number> => {
        const res = await db.execute(query);
        const row = asRows<{ n: number }>(res)[0];
        return row?.n ?? 0;
      };

      // Open requisitions = live-to-fill statuses (excludes draft, filled,
      // cancelled, closed). Active workflows = enabled, non-retired automation
      // agents. Audit events = last 7 days. Each is ANDed with tenant_id on
      // top of the protectedProcedure tenant_isolation RLS.
      const [openRequisitions, activeUsers, activeWorkflows, auditEvents7d] = await Promise.all([
        scalar(dsql`
          SELECT COUNT(*)::int AS n
          FROM public.requisitions
          WHERE tenant_id = ${tenantId}::uuid
            AND status IN ('pending_approval', 'approved', 'on_hold', 'posted')
        `),
        scalar(dsql`
          SELECT COUNT(*)::int AS n
          FROM public.tenant_user_memberships
          WHERE tenant_id = ${tenantId}::uuid AND status = 'active'
        `),
        scalar(dsql`
          SELECT COUNT(*)::int AS n
          FROM public.automation_agents
          WHERE tenant_id = ${tenantId}::uuid AND enabled = true AND retired_at IS NULL
        `),
        scalar(dsql`
          SELECT COUNT(*)::int AS n
          FROM public.audit_logs
          WHERE tenant_id = ${tenantId}::uuid
            AND created_at >= (now() - interval '7 days')
        `),
      ]);

      return { tiles: { openRequisitions, activeUsers, activeWorkflows, auditEvents7d } };
    }),

  partnerGetDashboardStats: partnerProcedure
    .output(partnerGetDashboardStatsOutputSchema)
    .query(async ({ ctx }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "partner ctx.db missing" });
      }
      // Submissions = candidate_ownership_claims joined to their claiming
      // application, bucketed by the application's live stage. Org-scoped by
      // partner_org_id (the explicit predicate that is load-bearing for org
      // isolation, per partnerProcedure's contract).
      const rows = await dashRows<{ stage: string | null; n: number }>(
        db,
        dsql`
          SELECT a.current_stage AS stage, count(*)::int AS n
          FROM public.candidate_ownership_claims c
          JOIN public.applications a
            ON a.tenant_id = c.tenant_id AND a.id = c.claimed_via_application_id
          WHERE c.tenant_id = ${ctx.partner.tenantId}::uuid
            AND c.partner_org_id = ${ctx.partner.partnerOrgId}::uuid
          GROUP BY a.current_stage
        `,
      );
      const TERMINAL = new Set(["offer_declined", "withdrawn", "recruiter_rejected"]);
      let total = 0;
      let active = 0;
      let placed = 0;
      const byStage: PartnerStageCount[] = [];
      for (const r of rows) {
        if (!r.stage) continue;
        total += r.n;
        if (r.stage === "offer_accepted") placed += r.n;
        else if (!TERMINAL.has(r.stage)) active += r.n;
        byStage.push({ stage: r.stage, label: humanizeStage(r.stage), count: r.n });
      }
      byStage.sort((a, b) => b.count - a.count);
      return { totalSubmissions: total, activeSubmissions: active, placed, byStage };
    }),

  // ═══════════ HRHEAD-02 — Market Intelligence + Feasibility ═══════════
  //
  // Market Intelligence = honest, curated benchmarks (market_benchmarks),
  // clearly labelled via source_note — NOT a live feed. Feasibility = a REAL
  // Claude assessment (requisition_feasibility) through the pluggable ai-client,
  // cached + cost-logged, generated only on an explicit click. See the two
  // schema files' headers + apps/api/src/lib/req-feasibility.ts.

  /**
   * listMarketBenchmarks — the Market Intelligence table + trending-skills
   * cards. hr_head + admin + hiring_manager read. RLS scopes to the tenant.
   */
  listMarketBenchmarks: protectedProcedure
    .input(listMarketBenchmarksInputSchema)
    .output(listMarketBenchmarksOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        MARKET_INTEL_READ_ROLES,
        "Market intelligence requires the hr_head, hiring_manager, or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const rows = await db
        .select()
        .from(marketBenchmarks)
        .where(eq(marketBenchmarks.tenantId, ctx.tenantId))
        .orderBy(marketBenchmarks.roleTitle);
      return { rows: rows.map(benchmarkRowToApi) };
    }),

  /**
   * upsertMarketBenchmark — admin-only, audited edit of one benchmark row,
   * keyed by (tenant, role_title). The tenant-editable, honestly-labelled part
   * of Market Intelligence. Uses the tenant-scoped client (the table's
   * tenant_isolation policy is FOR ALL, so authenticated writes are allowed +
   * still tenant-checked); the audit trigger + withAudit record the change.
   */
  upsertMarketBenchmark: protectedProcedure
    .input(upsertMarketBenchmarkInputSchema)
    .output(upsertMarketBenchmarkOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("upsert_market_benchmark", ctx, input, async () => {
        requireAnyRole(ctx, MARKET_BENCHMARK_ADMIN_ROLES, "Editing benchmarks is admin-only");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const [row] = await db
          .insert(marketBenchmarks)
          .values({
            tenantId,
            roleTitle: input.roleTitle,
            medianSalaryMinor: BigInt(input.medianSalaryMinor),
            currency: input.currency,
            ttfDays: input.ttfDays,
            availability: input.availability,
            competitorDemand: input.competitorDemand,
            recommendedRounds: input.recommendedRounds,
            trendingSkills: input.trendingSkills,
            sourceNote: input.sourceNote,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [marketBenchmarks.tenantId, marketBenchmarks.roleTitle],
            set: {
              medianSalaryMinor: BigInt(input.medianSalaryMinor),
              currency: input.currency,
              ttfDays: input.ttfDays,
              availability: input.availability,
              competitorDemand: input.competitorDemand,
              recommendedRounds: input.recommendedRounds,
              trendingSkills: input.trendingSkills,
              sourceNote: input.sourceNote,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!row) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "benchmark upsert returned no row",
          });
        }
        return { row: benchmarkRowToApi(row) };
      });
    }),

  /**
   * listRequisitionFeasibility — the Feasibility page grid. One card per
   * non-terminal requisition, each carrying its budget, its matched benchmark
   * context, and its cached AI assessment (null = "not generated yet", the
   * honest empty state). hr_head + admin. No AI calls here — pure reads.
   */
  listRequisitionFeasibility: protectedProcedure
    .input(listRequisitionFeasibilityInputSchema)
    .output(listRequisitionFeasibilityOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, FEASIBILITY_ROLES, "Feasibility requires the hr_head or admin role");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;
      const benchmarks = await loadTenantBenchmarks(db, tenantId);
      const reqRows = await db
        .select({
          id: requisitions.id,
          status: requisitions.status,
          title: positions.title,
          seniority: positions.level,
          compBandMin: positions.compBandMin,
          compBandMax: positions.compBandMax,
          compCurrency: positions.compCurrency,
          assessment: requisitionFeasibility.assessment,
          model: requisitionFeasibility.model,
          promptVersion: requisitionFeasibility.promptVersion,
          generatedAt: requisitionFeasibility.createdAt,
        })
        .from(requisitions)
        .innerJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .leftJoin(
          requisitionFeasibility,
          and(
            eq(requisitionFeasibility.tenantId, requisitions.tenantId),
            eq(requisitionFeasibility.requisitionId, requisitions.id),
          ),
        )
        .where(
          and(
            eq(requisitions.tenantId, tenantId),
            notInArray(requisitions.status, ["cancelled", "closed", "filled"]),
          ),
        )
        .orderBy(desc(requisitions.createdAt));

      const cards: FeasibilityCard[] = reqRows.map((r) =>
        buildFeasibilityCard({
          requisitionId: r.id,
          title: r.title,
          status: r.status,
          seniority: r.seniority ?? null,
          compBandMin: r.compBandMin ?? null,
          compBandMax: r.compBandMax ?? null,
          compCurrency: r.compCurrency ?? null,
          benchmarks,
          storedAssessment: r.assessment ?? null,
          model: r.model ?? null,
          promptVersion: r.promptVersion ?? null,
          generatedAt: r.generatedAt ? r.generatedAt.toISOString() : null,
        }),
      );
      return { cards };
    }),

  /**
   * getRequisitionFeasibility — a single card (the read after a generate, or a
   * deep link). hr_head + admin. No AI call.
   */
  getRequisitionFeasibility: protectedProcedure
    .input(getRequisitionFeasibilityInputSchema)
    .output(getRequisitionFeasibilityOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, FEASIBILITY_ROLES, "Feasibility requires the hr_head or admin role");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;
      const benchmarks = await loadTenantBenchmarks(db, tenantId);
      const facet = await loadReqFeasibilityFacet(db, tenantId, input.requisitionId);
      if (!facet) return { card: null };
      const [stored] = await db
        .select()
        .from(requisitionFeasibility)
        .where(
          and(
            eq(requisitionFeasibility.tenantId, tenantId),
            eq(requisitionFeasibility.requisitionId, input.requisitionId),
          ),
        )
        .limit(1);
      return {
        card: buildFeasibilityCard({
          requisitionId: facet.id,
          title: facet.title,
          status: facet.status,
          seniority: facet.seniority,
          compBandMin: facet.compBandMin,
          compBandMax: facet.compBandMax,
          compCurrency: facet.compCurrency,
          benchmarks,
          storedAssessment: stored?.assessment ?? null,
          model: stored?.model ?? null,
          promptVersion: stored?.promptVersion ?? null,
          generatedAt: stored?.createdAt ? stored.createdAt.toISOString() : null,
        }),
      };
    }),

  /**
   * generateRequisitionFeasibility — the ONE real AI call per click. Builds a
   * structured prompt from the req's JD skills + comp band + the matching
   * benchmark (fuzzy title match; honest no-benchmark fallback), calls Claude
   * via completeStructured (feature req_feasibility, cost-logged), and upserts
   * the assessment (regenerate replaces). hr_head + admin, audited. Honours the
   * CONF-01 per-tenant req_feasibility kill-switch.
   */
  generateRequisitionFeasibility: protectedProcedure
    .input(generateRequisitionFeasibilityInputSchema)
    .output(generateRequisitionFeasibilityOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("generate_requisition_feasibility", ctx, input, async () => {
        requireAnyRole(ctx, FEASIBILITY_ROLES, "Feasibility requires the hr_head or admin role");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Your membership was not found for this tenant",
          });
        }

        // CONF-01 kill-switch — disabled → clean error, no model call, no log.
        const aiSettings = await resolveTenantAiSettingsDb(tenantId);
        const feasSettings = aiSettings.req_feasibility;
        if (!feasSettings.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Feasibility assessment is disabled for this tenant. An admin can re-enable it in Admin → AI settings.",
          });
        }

        const facet = await loadReqFeasibilityFacet(db, tenantId, input.requisitionId);
        if (!facet) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
        }

        const skillRows = await db
          .select({
            skillName: jdSkills.skillName,
            weight: jdSkills.weight,
            isRequired: jdSkills.isRequired,
          })
          .from(jdSkills)
          .where(and(eq(jdSkills.tenantId, tenantId), eq(jdSkills.jdVersionId, facet.jdVersionId)));

        const benchmarks = await loadTenantBenchmarks(db, tenantId);
        const matchedTitle = matchBenchmarkTitle(
          facet.title,
          benchmarks.map((b) => b.roleTitle),
        );
        const matched = matchedTitle
          ? (benchmarks.find((b) => b.roleTitle === matchedTitle) ?? null)
          : null;

        const { system, user } = buildRequisitionFeasibilityPrompt({
          positionTitle: facet.title,
          seniority: facet.seniority,
          locationType: facet.locationType,
          primaryLocation: facet.primaryLocation,
          compBandMinMajor: facet.compBandMin != null ? Number(facet.compBandMin) : null,
          compBandMaxMajor: facet.compBandMax != null ? Number(facet.compBandMax) : null,
          compCurrency: facet.compCurrency,
          skills: skillRows.map((s) => ({
            skillName: s.skillName,
            weight: Number(s.weight),
            isRequired: s.isRequired,
          })),
          benchmark: matched
            ? {
                roleTitle: matched.roleTitle,
                medianSalaryMajor: minorToMajor(matched.medianSalaryMinor),
                currency: matched.currency,
                ttfDays: matched.ttfDays,
                availability: matched.availability,
                competitorDemand: matched.competitorDemand,
                recommendedRounds: matched.recommendedRounds,
                trendingSkills: matched.trendingSkills,
              }
            : null,
        });

        const client = await getAIClient(tenantId);
        const raw = await client.completeStructured<FeasibilityAssessment>({
          prompt: user,
          system,
          model: feasSettings.model,
          temperature: feasSettings.temperature,
          maxTokens: feasSettings.maxTokens,
          schema: feasibilityAssessmentJsonSchema,
          schemaName: REQ_FEASIBILITY_SCHEMA_NAME,
          feature: REQ_FEASIBILITY_FEATURE,
          requestId: ctx.requestId,
          actorMembershipId: membershipId,
        });
        // Trust-but-verify: re-parse so a provider quirk can't smuggle a bad
        // shape into the DB.
        const assessment = feasibilityAssessmentSchema.parse(raw);

        await db
          .insert(requisitionFeasibility)
          .values({
            tenantId,
            requisitionId: facet.id,
            assessment,
            model: client.provider,
            promptVersion: REQ_FEASIBILITY_PROMPT_VERSION,
            generatedByMembershipId: membershipId,
          })
          .onConflictDoUpdate({
            target: [requisitionFeasibility.tenantId, requisitionFeasibility.requisitionId],
            set: {
              assessment,
              model: client.provider,
              promptVersion: REQ_FEASIBILITY_PROMPT_VERSION,
              generatedByMembershipId: membershipId,
              createdAt: new Date(),
            },
          });

        const card = buildFeasibilityCard({
          requisitionId: facet.id,
          title: facet.title,
          status: facet.status,
          seniority: facet.seniority,
          compBandMin: facet.compBandMin,
          compBandMax: facet.compBandMax,
          compCurrency: facet.compCurrency,
          benchmarks,
          storedAssessment: assessment,
          model: client.provider,
          promptVersion: REQ_FEASIBILITY_PROMPT_VERSION,
          generatedAt: new Date().toISOString(),
        });
        return { card, usedBenchmark: matched != null };
      });
    }),

  // ═══════════════════ RO-01 — Requirement-owner (hiring_manager) ═══════════════════
  //
  // The requirement-owner persona surfaces: a rebuilt dashboard, My Requisitions
  // v2 (health + difficulty per row), an Approval Tracker, and AI revision
  // suggestions for rejected reqs. Health + difficulty are DETERMINISTIC
  // (lib/req-health.ts); the revision suggestions are the REAL-AI leg
  // (req_revision feature, feasibility pattern). NO demographic anything, NO
  // psychometrics, NO offer-acceptance probability.

  /**
   * listMyRequisitionsV2 — My Requisitions v2. One enriched row per requisition
   * the caller can read (RLS-scoped): status, deterministic health composite +
   * difficulty, budget band, and a draft-complete "canSubmit" flag. Same read
   * gate as the REQ-01 list (hiring_manager / recruiter / admin).
   */
  listMyRequisitionsV2: protectedProcedure
    .input(listMyRequisitionsV2InputSchema)
    .output(listMyRequisitionsV2OutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        REQUISITION_READ_ROLES,
        "Requisition access requires the hiring_manager, recruiter, or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const facets = await loadRequirementOwnerFacets(db, ctx.tenantId, input.limit);
      const benchmarks = await loadTenantBenchmarks(db, ctx.tenantId);
      return { rows: facets.map((f) => facetToOwnerRow(f, benchmarks)) };
    }),

  /**
   * getRequirementOwnerDashboard — the rebuilt hiring_manager landing read: a
   * hero stat strip, per-req health rows, pending-approval SLA items, the
   * deterministic action-required list, and honest market insights (curated
   * difficulty + our own historical time-to-hire). hiring_manager + admin.
   */
  getRequirementOwnerDashboard: protectedProcedure
    .output(getRequirementOwnerDashboardOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        RO_DASHBOARD_ROLES,
        "The requirement-owner dashboard requires the hiring_manager or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const facets = await loadRequirementOwnerFacets(db, ctx.tenantId, 200);
      const benchmarks = await loadTenantBenchmarks(db, ctx.tenantId);

      // Hero stat strip — honest requisition-centric counts.
      let draft = 0;
      let pending = 0;
      let live = 0;
      let interviewing = 0;
      let offerStage = 0;
      let rejected = 0;
      for (const f of facets) {
        if (f.status === "draft") draft += 1;
        else if (f.status === "pending_approval") pending += 1;
        else if (f.status === "approved" || f.status === "posted") live += 1;
        if (f.interviewingCount > 0) interviewing += 1;
        if (f.offerStageCount > 0) offerStage += 1;
        if (facetIsRejected(f)) rejected += 1;
      }
      const stats: RoDashboardStat[] = [
        { key: "total", label: "Total", value: facets.length, href: "/requisitions" },
        { key: "draft", label: "Open / draft", value: draft, href: "/requisitions?status=draft" },
        {
          key: "pending",
          label: "Pending approval",
          value: pending,
          href: "/approval-tracker",
        },
        {
          key: "live",
          label: "Approved / live",
          value: live,
          href: "/requisitions?status=approved",
        },
        { key: "interviewing", label: "Interviewing", value: interviewing, href: "/requisitions" },
        { key: "offer", label: "Offer stage", value: offerStage, href: "/requisitions" },
        { key: "rejected", label: "Rejected", value: rejected, href: "/approval-tracker" },
      ];

      // Health rows — worst-first so gaps surface.
      const healthRows: RoHealthRow[] = facets
        .map((f) => {
          const benchmark = matchFacetBenchmark(f, benchmarks);
          return {
            requisitionId: f.id,
            title: f.title,
            status: f.status,
            score: facetHealth(f).score,
            difficulty: facetDifficulty(f, benchmark),
          };
        })
        .sort((a, b) => a.score - b.score)
        .slice(0, 8);

      // Pending-approval SLA items (real waiting time vs the approval SLA).
      const slaHours = REQUISITION_APPROVAL_SLA_DAYS * 24;
      const approvalSla: RoApprovalSlaItem[] = facets
        .filter(
          (f) => f.status === "pending_approval" && f.approvalRequestId && f.approvalRequestedAt,
        )
        .map((f) => {
          const hoursWaiting = Math.max(
            0,
            Math.floor((Date.now() - (f.approvalRequestedAt as Date).getTime()) / (1000 * 60 * 60)),
          );
          return {
            requisitionId: f.id,
            approvalRequestId: f.approvalRequestId as string,
            title: f.title,
            submittedAt: (f.approvalRequestedAt as Date).toISOString(),
            hoursWaiting,
            slaHours,
            breach: hoursWaiting > slaHours,
          };
        })
        .sort((a, b) => b.hoursWaiting - a.hoursWaiting);

      // Deterministic action-required list.
      const actions: RoActionItem[] = facets.flatMap((f) => facetActions(f));
      const severityRank = { urgent: 0, attention: 1, info: 2 } as const;
      actions.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

      // Market insights: per distinct role title — difficulty + OUR historical
      // time-to-hire (labelled) + curated-benchmark TTF reference.
      const byRole = new Map<string, { facets: RoReqFacet[]; ttf: number[] }>();
      for (const f of facets) {
        if (!f.title) continue;
        const entry = byRole.get(f.title) ?? { facets: [], ttf: [] };
        entry.facets.push(f);
        entry.ttf.push(...f.timeToHireDays);
        byRole.set(f.title, entry);
      }
      const marketInsights: RoMarketInsight[] = [...byRole.entries()]
        .flatMap(([roleTitle, entry]) => {
          const first = entry.facets[0];
          if (!first) return [];
          const benchmark = matchFacetBenchmark(first, benchmarks);
          const sampleSize = entry.ttf.length;
          const avg =
            sampleSize > 0
              ? Math.round((entry.ttf.reduce((s, d) => s + d, 0) / sampleSize) * 10) / 10
              : null;
          return [
            {
              roleTitle,
              difficulty: facetDifficulty(first, benchmark),
              historicalAvgTimeToHireDays: avg,
              sampleSize,
              benchmarkTtfDays: benchmark ? benchmark.ttfDays : null,
            },
          ];
        })
        .slice(0, 10);

      return { stats, healthRows, approvalSla, actions, marketInsights };
    }),

  /**
   * getApprovalTracker — the requirement-owner Approval Tracker: pending /
   * approved / rejected stats, a pending-approval SLA list, and a full approval
   * history with elapsed SLA + the HR-head decision reason. hiring_manager +
   * admin. All rows are real (RLS-scoped to the tenant).
   */
  getApprovalTracker: protectedProcedure
    .output(getApprovalTrackerOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        RO_DASHBOARD_ROLES,
        "The approval tracker requires the hiring_manager or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const facets = await loadRequirementOwnerFacets(db, ctx.tenantId, 200);
      const slaHours = REQUISITION_APPROVAL_SLA_DAYS * 24;

      // History: one row per requisition that has ever been submitted.
      const history: ApprovalTrackerHistoryRow[] = [];
      let pendingCount = 0;
      let approvedCount = 0;
      let rejectedCount = 0;
      const pending: RoApprovalSlaItem[] = [];

      for (const f of facets) {
        if (!f.approvalRequestId || !f.approvalRequestedAt) continue;
        const submittedMs = f.approvalRequestedAt.getTime();
        const decidedMs = f.approvalDecidedAt ? f.approvalDecidedAt.getTime() : null;
        const endMs = decidedMs ?? Date.now();
        const elapsedHours = Math.max(0, Math.floor((endMs - submittedMs) / (1000 * 60 * 60)));

        // Outcome: prefer the recorded decision; else the request status.
        let outcome = f.approvalStatus ?? "pending";
        if (f.latestDecisionOutcome === "rejected") outcome = "rejected";
        else if (f.latestDecisionOutcome === "approved") outcome = "approved";
        else if (f.latestDecisionOutcome === "sent_back") outcome = "sent_back";

        if (f.approvalStatus === "pending") {
          pendingCount += 1;
          const hoursWaiting = elapsedHours;
          pending.push({
            requisitionId: f.id,
            approvalRequestId: f.approvalRequestId,
            title: f.title,
            submittedAt: f.approvalRequestedAt.toISOString(),
            hoursWaiting,
            slaHours,
            breach: hoursWaiting > slaHours,
          });
        }
        if (outcome === "approved") approvedCount += 1;
        if (outcome === "rejected") rejectedCount += 1;

        history.push({
          requisitionId: f.id,
          approvalRequestId: f.approvalRequestId,
          title: f.title,
          department: f.department,
          outcome,
          submittedAt: f.approvalRequestedAt.toISOString(),
          decidedAt: f.approvalDecidedAt ? f.approvalDecidedAt.toISOString() : null,
          slaElapsedHours: elapsedHours,
          breach: decidedMs != null ? elapsedHours > slaHours : elapsedHours > slaHours,
          decisionReason: f.latestDecisionReason,
        });
      }

      history.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
      pending.sort((a, b) => b.hoursWaiting - a.hoursWaiting);

      return {
        stats: { pending: pendingCount, approved: approvedCount, rejected: rejectedCount },
        pending,
        history,
      };
    }),

  /**
   * getReqRevisionSuggestions — the cached AI revision suggestions for a
   * requisition (read after generate). Returns null suggestions until generated;
   * carries `eligible` (rejected state) + `featureEnabled` (kill-switch) so the
   * UI renders honest states. Owner of the req + admin.
   */
  getReqRevisionSuggestions: protectedProcedure
    .input(getReqRevisionSuggestionsInputSchema)
    .output(getReqRevisionSuggestionsOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(
        ctx,
        RO_REVISION_ROLES,
        "Revision suggestions require the hiring_manager or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;
      const meta = await loadReqRevisionMeta(db, tenantId, input.requisitionId);
      if (!meta) throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      await ensureReqOwnerOrAdmin(db, ctx, meta.hiringManagerId);

      const aiSettings = await resolveTenantAiSettingsDb(tenantId);
      const featureEnabled = aiSettings.req_revision.enabled;

      const [row] = await db
        .select()
        .from(reqRevisionSuggestions)
        .where(
          and(
            eq(reqRevisionSuggestions.tenantId, tenantId),
            eq(reqRevisionSuggestions.requisitionId, input.requisitionId),
          ),
        )
        .limit(1);

      const suggestions = row ? reqRevisionRowToApi(row) : null;
      return { suggestions, eligible: meta.isRejected, featureEnabled };
    }),

  /**
   * generateReqRevisionSuggestions — the ONE real AI call per click. For a
   * REJECTED requisition, builds a prompt from the rejection reason + the req's
   * own fields + the matching curated benchmark, calls Claude via
   * completeStructured (feature req_revision, cost-logged), and upserts the
   * suggestions (regenerate replaces). Owner of the req + admin, audited,
   * rejected-only, kill-switch-honoured.
   */
  generateReqRevisionSuggestions: protectedProcedure
    .input(generateReqRevisionSuggestionsInputSchema)
    .output(generateReqRevisionSuggestionsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("generate_req_revision_suggestions", ctx, input, async () => {
        requireAnyRole(
          ctx,
          RO_REVISION_ROLES,
          "Revision suggestions require the hiring_manager or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Your membership was not found for this tenant",
          });
        }

        const meta = await loadReqRevisionMeta(db, tenantId, input.requisitionId);
        if (!meta) throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
        await ensureReqOwnerOrAdmin(db, ctx, meta.hiringManagerId);

        // Rejected-only guard.
        if (!meta.isRejected) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Revision suggestions are only available for rejected requisitions.",
          });
        }

        // CONF-01 kill-switch — disabled → clean error, no model call, no log.
        const aiSettings = await resolveTenantAiSettingsDb(tenantId);
        if (!aiSettings.req_revision.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Revision suggestions are disabled for this tenant. An admin can re-enable them in Admin → AI settings.",
          });
        }
        const revSettings = aiSettings.req_revision;

        const facet = await loadReqFeasibilityFacet(db, tenantId, input.requisitionId);
        if (!facet) throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });

        const skillRows = await db
          .select({
            skillName: jdSkills.skillName,
            weight: jdSkills.weight,
            isRequired: jdSkills.isRequired,
          })
          .from(jdSkills)
          .where(and(eq(jdSkills.tenantId, tenantId), eq(jdSkills.jdVersionId, facet.jdVersionId)));

        const benchmarks = await loadTenantBenchmarks(db, tenantId);
        const matchedTitle = matchBenchmarkTitle(
          facet.title,
          benchmarks.map((b) => b.roleTitle),
        );
        const matched = matchedTitle
          ? (benchmarks.find((b) => b.roleTitle === matchedTitle) ?? null)
          : null;

        const { system, user } = buildReqRevisionPrompt({
          positionTitle: facet.title,
          seniority: facet.seniority,
          locationType: facet.locationType,
          primaryLocation: facet.primaryLocation,
          compBandMinMajor: facet.compBandMin != null ? Number(facet.compBandMin) : null,
          compBandMaxMajor: facet.compBandMax != null ? Number(facet.compBandMax) : null,
          compCurrency: facet.compCurrency,
          skills: skillRows.map((s) => ({
            skillName: s.skillName,
            weight: Number(s.weight),
            isRequired: s.isRequired,
          })),
          rejectionReason: meta.rejectionReason,
          benchmark: matched
            ? {
                roleTitle: matched.roleTitle,
                medianSalaryMajor: minorToMajor(matched.medianSalaryMinor),
                currency: matched.currency,
                ttfDays: matched.ttfDays,
                availability: matched.availability,
                competitorDemand: matched.competitorDemand,
                trendingSkills: matched.trendingSkills,
              }
            : null,
        });

        const client = await getAIClient(tenantId);
        const raw = await client.completeStructured<ReqRevisionAi>({
          prompt: user,
          system,
          model: revSettings.model,
          temperature: revSettings.temperature,
          maxTokens: revSettings.maxTokens,
          schema: reqRevisionJsonSchema,
          schemaName: REQ_REVISION_SCHEMA_NAME,
          feature: REQ_REVISION_FEATURE,
          requestId: ctx.requestId,
          actorMembershipId: membershipId,
        });
        const parsed = reqRevisionAiSchema.parse(raw);
        const suggestionItems: ReqRevisionItem[] = parsed.suggestions;

        await db
          .insert(reqRevisionSuggestions)
          .values({
            tenantId,
            requisitionId: facet.id,
            suggestions: suggestionItems,
            rejectionReason: meta.rejectionReason,
            model: client.provider,
            promptVersion: REQ_REVISION_PROMPT_VERSION,
            generatedByMembershipId: membershipId,
          })
          .onConflictDoUpdate({
            target: [reqRevisionSuggestions.tenantId, reqRevisionSuggestions.requisitionId],
            set: {
              suggestions: suggestionItems,
              rejectionReason: meta.rejectionReason,
              model: client.provider,
              promptVersion: REQ_REVISION_PROMPT_VERSION,
              generatedByMembershipId: membershipId,
              createdAt: new Date(),
            },
          });

        return {
          suggestions: {
            requisitionId: facet.id,
            suggestions: suggestionItems,
            rejectionReason: meta.rejectionReason,
            model: client.provider,
            promptVersion: REQ_REVISION_PROMPT_VERSION,
            generatedAt: new Date().toISOString(),
          },
          usedBenchmark: matched != null,
        };
      });
    }),

  // ═══════════════════ HROPS-01 — HR Ops cases + HR round ═══════════════════

  /**
   * listHrCases — the HR-Ops workspace list. Every application in the HR-Ops
   * window (tech_interview / hr_round / offer_drafted / offer_accepted), enriched
   * with candidate + role, AI score, per-round interview recommendations, salary
   * band, assigned recruiter, and the saved HR-round assessment (if any). hr_ops
   * + admin; RLS scopes to the tenant. Search + stage filter applied server-side.
   */
  listHrCases: protectedProcedure
    .input(listHrCasesInputSchema)
    .output(listHrCasesOutputSchema)
    .query(async ({ ctx, input }): Promise<ListHrCasesOutput> => {
      requireAnyRole(ctx, HR_OPS_CASE_ROLES, "The HR cases workspace is for HR Ops.");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      return buildHrCaseList(db, ctx, ctx.tenantId, input.search ?? null, input.stage ?? null);
    }),

  /**
   * getHrCaseDetail — one HR case: the candidate card (real fields only),
   * pipeline status, prior-round interview feedback (recommendation + summary
   * text, NO scores — the anti-anchoring convention), and the saved HR-round
   * assessment. hr_ops + admin; RLS-scoped. Reads candidate PII → PII-logged.
   */
  getHrCaseDetail: protectedProcedure
    .input(getHrCaseDetailInputSchema)
    .output(getHrCaseDetailOutputSchema)
    .query(async ({ ctx, input }): Promise<GetHrCaseDetailOutput> => {
      requireAnyRole(ctx, HR_OPS_CASE_ROLES, "The HR cases workspace is for HR Ops.");
      return withAudit("get_hr_case_detail", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        return buildHrCaseDetail(db, ctx, ctx.tenantId, input.applicationId);
      });
    }),

  /**
   * saveHrRoundAssessment — upsert the deterministic HR-round assessment for an
   * application (one per tenant+application). Writes the completed_by membership
   * + an audit row (via the table trigger + withAudit intent). hr_ops + admin;
   * RLS-scoped. The application must be inside the HR-Ops window.
   */
  saveHrRoundAssessment: protectedProcedure
    .input(saveHrRoundAssessmentInputSchema)
    .output(saveHrRoundAssessmentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      requireAnyRole(ctx, HR_OPS_CASE_ROLES, "Saving an HR round assessment is for HR Ops.");
      return withAudit("save_hr_round_assessment", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        // Application must exist, be in this tenant, and be an HR case.
        const [app] = await db
          .select({ currentStage: applications.currentStage })
          .from(applications)
          .where(eq(applications.id, input.applicationId))
          .limit(1);
        if (!app) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        }
        if (!HR_CASE_STAGES.has(app.currentStage)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Application is not an HR case (stage=${app.currentStage}). HR round assessments apply to the HR-Ops window.`,
          });
        }
        const membershipId = await resolveActorMembership(db, ctx);
        const now = new Date();
        const [row] = await db
          .insert(hrRoundAssessments)
          .values({
            tenantId: ctx.tenantId,
            applicationId: input.applicationId,
            motivationDiscussed: input.motivationDiscussed,
            salaryExpectationDiscussed: input.salaryExpectationDiscussed,
            cultureFitAssessed: input.cultureFitAssessed,
            workAuthorizationVerified: input.workAuthorizationVerified,
            noticePeriodConfirmed: input.noticePeriodConfirmed,
            relocationWillingness: input.relocationWillingness,
            notes: input.notes ?? null,
            rating: input.rating,
            recommendation: input.recommendation,
            completedByMembershipId: membershipId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [hrRoundAssessments.tenantId, hrRoundAssessments.applicationId],
            set: {
              motivationDiscussed: input.motivationDiscussed,
              salaryExpectationDiscussed: input.salaryExpectationDiscussed,
              cultureFitAssessed: input.cultureFitAssessed,
              workAuthorizationVerified: input.workAuthorizationVerified,
              noticePeriodConfirmed: input.noticePeriodConfirmed,
              relocationWillingness: input.relocationWillingness,
              notes: input.notes ?? null,
              rating: input.rating,
              recommendation: input.recommendation,
              completedByMembershipId: membershipId,
              updatedAt: now,
            },
          })
          .returning();
        if (!row) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "assessment upsert returned no row",
          });
        }
        const names = await resolveMembershipNames(
          ctx,
          ctx.tenantId,
          membershipId ? [membershipId] : [],
        );
        return {
          assessment: hrAssessmentToApi(row, membershipId ? names.get(membershipId) : null),
        };
      });
    }),

  /**
   * listHrRounds — the HR-round scheduler view. One row per HR-round interview
   * (scorecard_template 'hr') for cases in the HR-Ops window, PLUS a synthetic
   * "pending" row for any hr_round case with no HR interview scheduled yet.
   * Carries the saved assessment's rating/recommendation. hr_ops + admin.
   */
  listHrRounds: protectedProcedure
    .input(listHrRoundsInputSchema)
    .output(listHrRoundsOutputSchema)
    .query(async ({ ctx }): Promise<ListHrRoundsOutput> => {
      requireAnyRole(ctx, HR_OPS_CASE_ROLES, "The HR rounds view is for HR Ops.");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      return buildHrRoundsList(db, ctx, ctx.tenantId);
    }),
  // ═══════════════════ HROPS-02 — Comp & offer desk ═══════════════════

  /**
   * listCompDesk — the desk table. One row per application in hr_round /
   * offer_drafted / offer_accepted, each carrying its DETERMINISTIC comp verdict
   * (rule engine), latest offer, and out-of-band approval posture. hr_ops +
   * admin. No AI, no writes.
   */
  listCompDesk: protectedProcedure
    .input(listCompDeskInputSchema)
    .output(listCompDeskOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, COMP_DESK_ROLES, "The comp desk requires the hr_ops or admin role");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const assembled = await loadCompDeskAssembled(db, ctx.tenantId);
      const rows = assembled.map((a) => a.row);
      const stats = {
        total: rows.length,
        proceed: rows.filter((r) => r.verdict === "proceed").length,
        negotiate: rows.filter((r) => r.verdict === "negotiate").length,
        needApproval: rows.filter((r) => r.verdict === "need_approval").length,
      };
      return { rows, stats };
    }),

  /**
   * getCompAnalysis — the per-application analysis for the Rec drawer /
   * case-detail tab: the desk row + curated benchmark context (labelled) +
   * interview signal + benefit suggestion + the cached AI rationale. hr_ops +
   * admin. No AI call (read only — generate is a separate mutation).
   */
  getCompAnalysis: protectedProcedure
    .input(getCompAnalysisInputSchema)
    .output(getCompAnalysisOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, COMP_DESK_ROLES, "The comp desk requires the hr_ops or admin role");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;
      const [assembled] = await loadCompDeskAssembled(db, tenantId, input.applicationId);
      if (!assembled) return { analysis: null };
      const { row } = assembled;

      // Curated benchmarks + fuzzy match on the role title (labelled honestly).
      const benchmarks = await loadTenantBenchmarks(db, tenantId);
      const matchedTitle = matchBenchmarkTitle(
        row.roleTitle,
        benchmarks.map((b) => b.roleTitle),
      );

      // Interview recommendation vocabulary summary.
      const sigRes = await db.execute(dsql`
        SELECT f.recommendation AS recommendation, COUNT(*)::int AS count
        FROM public.interview_feedback f
        JOIN public.interviews i ON i.id = f.interview_id
        WHERE f.tenant_id = ${tenantId}::uuid
          AND i.application_id = ${input.applicationId}::uuid
          AND f.recommendation IS NOT NULL
        GROUP BY f.recommendation
      `);
      const interviewSignal = (
        (sigRes as unknown as { rows?: { recommendation: string; count: number }[] }).rows ??
        (sigRes as unknown as { recommendation: string; count: number }[])
      ).map((r) => ({ recommendation: r.recommendation, count: r.count }));

      // Cached AI rationale, if any.
      const [rec] = await db
        .select()
        .from(compRecommendations)
        .where(
          and(
            eq(compRecommendations.tenantId, tenantId),
            eq(compRecommendations.applicationId, input.applicationId),
          ),
        )
        .limit(1);
      const rationale: CompRationale | null = rec
        ? {
            rationale: rec.rationale,
            verdictSnapshot: rec.verdict as CompVerdict,
            suggestedPaiseSnapshot: Number(rec.suggestedInrPaise),
            model: rec.model,
            promptVersion: rec.promptVersion,
            generatedAt: rec.createdAt.toISOString(),
          }
        : null;

      return {
        analysis: {
          row,
          currentSalaryInrPaise: row.offerBaseInrPaise,
          benchmarks: benchmarks.map((b) => ({
            id: b.id,
            roleTitle: b.roleTitle,
            medianSalaryMinor: Number(b.medianSalaryMinor),
            currency: b.currency,
            ttfDays: b.ttfDays,
            availability: b.availability,
            competitorDemand: b.competitorDemand,
            recommendedRounds: b.recommendedRounds,
            trendingSkills: b.trendingSkills,
            sourceNote: b.sourceNote,
            updatedAt: b.updatedAt.toISOString(),
          })),
          matchedBenchmarkRoleTitle: matchedTitle,
          interviewSignal,
          benefitsSuggested: DEFAULT_SUGGESTED_BENEFITS,
          rationale,
        },
      };
    }),

  /**
   * generateCompRationale — the ONE real AI call per click. The deterministic
   * verdict is computed first + is authoritative; the model writes only a short
   * prose rationale grounded in the provided numbers (expected, band, suggested,
   * curated benchmark, interview signal). Feature comp_recommendation, cost-
   * logged, kill-switchable. Upserts (regenerate replaces). hr_ops + admin,
   * audited.
   */
  generateCompRationale: protectedProcedure
    .input(generateCompRationaleInputSchema)
    .output(generateCompRationaleOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("generate_comp_rationale", ctx, input, async () => {
        requireAnyRole(ctx, COMP_DESK_ROLES, "The comp desk requires the hr_ops or admin role");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Your membership was not found for this tenant",
          });
        }

        // Kill-switch — disabled → clean error, no model call, no log.
        const aiSettings = await resolveTenantAiSettingsDb(tenantId);
        const compSettings = aiSettings.comp_recommendation;
        if (!compSettings.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "The compensation rationale is disabled for this tenant. An admin can re-enable it in Admin → AI settings.",
          });
        }

        const [assembled] = await loadCompDeskAssembled(db, tenantId, input.applicationId);
        if (!assembled) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Application not found on the desk" });
        }
        const { row } = assembled;
        if (
          row.verdict == null ||
          row.suggestedPaise == null ||
          row.expectedSalaryInrPaise == null ||
          row.bandMinPaise == null ||
          row.bandMidPaise == null ||
          row.bandMaxPaise == null
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Add an expected salary and a comp band before generating a rationale — there is no verdict to explain yet.",
          });
        }

        // Curated benchmark match + interview signal for the prompt.
        const benchmarks = await loadTenantBenchmarks(db, tenantId);
        const matchedTitle = matchBenchmarkTitle(
          row.roleTitle,
          benchmarks.map((b) => b.roleTitle),
        );
        const matched = matchedTitle
          ? (benchmarks.find((b) => b.roleTitle === matchedTitle) ?? null)
          : null;

        const sigRes = await db.execute(dsql`
          SELECT f.recommendation AS recommendation, COUNT(*)::int AS count
          FROM public.interview_feedback f
          JOIN public.interviews i ON i.id = f.interview_id
          WHERE f.tenant_id = ${tenantId}::uuid
            AND i.application_id = ${input.applicationId}::uuid
            AND f.recommendation IS NOT NULL
          GROUP BY f.recommendation
        `);
        const interviewSignal = (
          (sigRes as unknown as { rows?: { recommendation: string; count: number }[] }).rows ??
          (sigRes as unknown as { recommendation: string; count: number }[])
        ).map((r) => `${r.count}× ${r.recommendation}`);

        const currency = row.compCurrency ?? "INR";
        const { system, user } = buildCompRationalePrompt({
          candidateName: row.candidateName,
          roleTitle: row.roleTitle,
          verdict: row.verdict,
          expectedMajor: row.expectedSalaryInrPaise / 100,
          bandMinMajor: row.bandMinPaise / 100,
          bandMidMajor: row.bandMidPaise / 100,
          bandMaxMajor: row.bandMaxPaise / 100,
          suggestedMajor: row.suggestedPaise / 100,
          currency,
          benchmark: matched
            ? {
                roleTitle: matched.roleTitle,
                medianSalaryMajor: minorToMajor(matched.medianSalaryMinor),
                currency: matched.currency,
                availability: matched.availability,
                competitorDemand: matched.competitorDemand,
                sourceNote: matched.sourceNote,
              }
            : null,
          interviewSignal,
        });

        const client = await getAIClient(tenantId);
        const raw = await client.completeStructured<CompRationaleAi>({
          prompt: user,
          system,
          model: compSettings.model,
          temperature: compSettings.temperature,
          maxTokens: compSettings.maxTokens,
          schema: compRationaleJsonSchema,
          schemaName: COMP_RATIONALE_SCHEMA_NAME,
          feature: COMP_RATIONALE_FEATURE,
          requestId: ctx.requestId,
          actorMembershipId: membershipId,
        });
        const parsed = compRationaleAiSchema.parse(raw);

        await db
          .insert(compRecommendations)
          .values({
            tenantId,
            applicationId: input.applicationId,
            rationale: parsed.rationale,
            verdict: row.verdict,
            suggestedInrPaise: BigInt(row.suggestedPaise),
            model: client.provider,
            promptVersion: COMP_RATIONALE_PROMPT_VERSION,
            generatedByMembershipId: membershipId,
          })
          .onConflictDoUpdate({
            target: [compRecommendations.tenantId, compRecommendations.applicationId],
            set: {
              rationale: parsed.rationale,
              verdict: row.verdict,
              suggestedInrPaise: BigInt(row.suggestedPaise),
              model: client.provider,
              promptVersion: COMP_RATIONALE_PROMPT_VERSION,
              generatedByMembershipId: membershipId,
              createdAt: new Date(),
            },
          });

        return {
          rationale: {
            rationale: parsed.rationale,
            verdictSnapshot: row.verdict,
            suggestedPaiseSnapshot: row.suggestedPaise,
            model: client.provider,
            promptVersion: COMP_RATIONALE_PROMPT_VERSION,
            generatedAt: new Date().toISOString(),
          },
        };
      });
    }),

  /**
   * draftCompOffer — draft an offer from the comp desk composer, carrying the
   * HROPS-02 terms (contract type, probation, benefits) on top of the existing
   * offer lifecycle. Reuses the same offers table + draftable-stage gate as the
   * triage-drawer draftOffer. Returns needsApproval = base > band max so the
   * desk can route the extend through approval. hr_ops + admin, audited.
   */
  draftCompOffer: protectedProcedure
    .input(draftCompOfferInputSchema)
    .output(draftCompOfferOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("draft_comp_offer", ctx, input, async () => {
        requireAnyRole(ctx, COMP_DESK_ROLES, "The comp desk requires the hr_ops or admin role");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }

        const [app] = await db
          .select({
            tenantId: applications.tenantId,
            currentStage: applications.currentStage,
            requisitionId: applications.requisitionId,
          })
          .from(applications)
          .where(eq(applications.id, input.applicationId))
          .limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        if (!OFFER_DRAFTABLE_STAGES.has(app.currentStage)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot draft offer from stage ${app.currentStage}`,
          });
        }

        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Drafting membership not found for this tenant",
          });
        }

        // Band max → the needsApproval flag (out-of-band offer).
        const [pos] = await db
          .select({ bandMax: positions.compBandMax })
          .from(requisitions)
          .innerJoin(positions, eq(positions.id, requisitions.positionId))
          .where(eq(requisitions.id, app.requisitionId))
          .limit(1);
        const bandMaxPaise = pos ? majorRupeesToPaise(pos.bandMax) : null;
        const needsApproval = bandMaxPaise != null && input.baseSalaryInrPaise > bandMaxPaise;

        const expiryAt = new Date(Date.now() + input.expiryDays * 24 * 60 * 60 * 1000);
        const [created] = await db
          .insert(offers)
          .values({
            tenantId: app.tenantId,
            applicationId: input.applicationId,
            draftedByMembershipId: membershipId,
            baseSalaryInrPaise: BigInt(input.baseSalaryInrPaise),
            variableTargetInrPaise:
              input.variableTargetInrPaise !== undefined
                ? BigInt(input.variableTargetInrPaise)
                : null,
            joiningBonusInrPaise:
              input.joiningBonusInrPaise !== undefined ? BigInt(input.joiningBonusInrPaise) : null,
            joiningDate: input.joiningDate,
            location: input.location,
            contractType: input.contractType,
            probationMonths: input.probationMonths,
            benefits: input.benefits,
            termsHtml: input.termsHtml ?? null,
            expiryAt,
          })
          .returning({ id: offers.id });
        if (!created) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "offer insert returned no row",
          });
        }
        return { offerId: created.id, needsApproval };
      });
    }),

  /**
   * requestOfferApproval — raise an HR-head approval for an out-of-band offer
   * (base > band max). Idempotent via the approval_requests one-pending-per-
   * subject partial unique. hr_ops + admin, audited. Refuses if the offer is
   * within band (nothing to approve).
   */
  requestOfferApproval: protectedProcedure
    .input(requestOfferApprovalInputSchema)
    .output(requestOfferApprovalOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("request_offer_approval", ctx, input, async () => {
        requireAnyRole(ctx, COMP_DESK_ROLES, "The comp desk requires the hr_ops or admin role");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);

        const [offer] = await db
          .select({
            id: offers.id,
            status: offers.status,
            baseSalaryInrPaise: offers.baseSalaryInrPaise,
            applicationId: offers.applicationId,
          })
          .from(offers)
          .where(and(eq(offers.tenantId, tenantId), eq(offers.id, input.offerId)))
          .limit(1);
        if (!offer) throw new TRPCError({ code: "NOT_FOUND", message: "Offer not found" });
        if (!["drafted", "extended"].includes(offer.status)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot request approval for an offer in status ${offer.status}`,
          });
        }

        const [pos] = await db
          .select({ bandMax: positions.compBandMax })
          .from(applications)
          .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
          .innerJoin(positions, eq(positions.id, requisitions.positionId))
          .where(eq(applications.id, offer.applicationId))
          .limit(1);
        const bandMaxPaise = pos ? majorRupeesToPaise(pos.bandMax) : null;
        if (bandMaxPaise == null || Number(offer.baseSalaryInrPaise) <= bandMaxPaise) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This offer is within the comp band — no approval is needed.",
          });
        }

        // Already-decided or pending? Surface it idempotently.
        const [existing] = await db
          .select({ id: approvalRequests.id, status: approvalRequests.status })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.tenantId, tenantId),
              eq(approvalRequests.subjectType, "offer"),
              eq(approvalRequests.subjectId, offer.id),
            ),
          )
          .orderBy(desc(approvalRequests.requestedAt))
          .limit(1);
        if (existing && (existing.status === "pending" || existing.status === "approved")) {
          return {
            approvalRequestId: existing.id,
            status: existing.status === "approved" ? "approved" : "pending",
            alreadyRequested: true,
          };
        }

        const chainId = await resolveOfferApprovalChain(db, tenantId, membershipId);
        const inserted = await db
          .insert(approvalRequests)
          .values({
            tenantId,
            chainId,
            subjectType: "offer",
            subjectId: offer.id,
            status: "pending",
            currentStepIndex: 0,
            requestedByMembershipId: membershipId,
            context: {
              offer_id: offer.id,
              application_id: offer.applicationId,
              base_inr_paise: Number(offer.baseSalaryInrPaise),
              band_max_inr_paise: bandMaxPaise,
            },
          })
          .onConflictDoNothing()
          .returning({ id: approvalRequests.id });

        if (inserted.length === 0) {
          const [pending] = await db
            .select({ id: approvalRequests.id })
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.tenantId, tenantId),
                eq(approvalRequests.subjectType, "offer"),
                eq(approvalRequests.subjectId, offer.id),
                eq(approvalRequests.status, "pending"),
              ),
            )
            .limit(1);
          if (!pending) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "offer approval conflict but no pending row found",
            });
          }
          return { approvalRequestId: pending.id, status: "pending", alreadyRequested: true };
        }
        const row = inserted[0];
        if (!row) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "offer approval insert returned no row",
          });
        }
        return { approvalRequestId: row.id, status: "pending", alreadyRequested: false };
      });
    }),

  /**
   * decideOfferApproval — the HR head / admin approves or rejects an out-of-band
   * offer approval. Writes an append-only approval_decision + moves the request
   * off pending. Approve unblocks extendOffer; reject leaves the offer un-
   * extendable (the recruiter must re-draft within band). hr_head + admin,
   * audited.
   */
  decideOfferApproval: protectedProcedure
    .input(decideOfferApprovalInputSchema)
    .output(decideOfferApprovalOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("decide_offer_approval", ctx, input, async () => {
        requireAnyRole(
          ctx,
          OFFER_APPROVAL_DECIDE_ROLES,
          "Deciding an offer approval requires the hr_head or admin role",
        );
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Deciding membership not found for this tenant",
          });
        }

        const [request] = await db
          .select({
            id: approvalRequests.id,
            status: approvalRequests.status,
            subjectId: approvalRequests.subjectId,
            currentStepIndex: approvalRequests.currentStepIndex,
          })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.tenantId, tenantId),
              eq(approvalRequests.id, input.approvalRequestId),
              eq(approvalRequests.subjectType, "offer"),
            ),
          )
          .limit(1);
        if (!request) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Offer approval request not found" });
        }
        if (request.status !== "pending") {
          throw new TRPCError({
            code: "CONFLICT",
            message: `This approval is already ${request.status} — nothing to decide.`,
          });
        }

        const decidedAt = new Date();
        const outcome = input.decision === "approve" ? "approved" : "rejected";
        const requestStatus = input.decision === "approve" ? "approved" : "rejected";
        const reason = input.reason?.trim() ?? "";

        const [decision] = await db
          .insert(approvalDecisions)
          .values({
            tenantId,
            requestId: request.id,
            stepIndex: request.currentStepIndex,
            outcome,
            approverMembershipId: membershipId,
            decidedAt,
            comment: reason.length > 0 ? reason : null,
            metadata: { decision: input.decision },
          })
          .returning({ id: approvalDecisions.id });
        if (!decision) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "offer approval_decision insert returned no row",
          });
        }

        await db
          .update(approvalRequests)
          .set({ status: requestStatus, decidedAt, updatedAt: decidedAt })
          .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, request.id)));

        return {
          approvalRequestId: request.id,
          offerId: request.subjectId,
          decision: input.decision,
          status: requestStatus,
        };
      });
    }),

  /**
   * listOfferApprovals — the HR-head / admin out-of-band offer approval queue.
   * Pending offer approval_requests + candidate/role/base/band context. hr_head
   * + admin. No writes.
   */
  listOfferApprovals: protectedProcedure
    .input(listOfferApprovalsInputSchema)
    .output(listOfferApprovalsOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        OFFER_APPROVAL_DECIDE_ROLES,
        "The offer approval queue requires the hr_head or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;
      const rowsRes = await db.execute(dsql`
        SELECT
          ar.id AS approval_request_id,
          ar.subject_id AS offer_id,
          o.application_id AS application_id,
          COALESCE(pe.full_name, 'Candidate') AS candidate_name,
          p.title AS role_title,
          o.base_salary_inr_paise::text AS base_inr_paise,
          p.comp_band_max AS band_max,
          ar.requested_at AS requested_at
        FROM public.approval_requests ar
        JOIN public.offers o ON o.id = ar.subject_id AND o.tenant_id = ar.tenant_id
        JOIN public.applications a ON a.id = o.application_id
        JOIN public.candidates c ON c.id = a.candidate_id
        JOIN public.persons pe ON pe.id = c.person_id
        JOIN public.requisitions r ON r.id = a.requisition_id
        JOIN public.positions p ON p.id = r.position_id
        WHERE ar.tenant_id = ${tenantId}::uuid
          AND ar.subject_type = 'offer'
          AND ar.status = 'pending'
        ORDER BY ar.requested_at ASC
      `);
      interface QRow {
        approval_request_id: string;
        offer_id: string;
        application_id: string;
        candidate_name: string;
        role_title: string;
        base_inr_paise: string;
        band_max: string | null;
        requested_at: Date | string;
      }
      const rows = (
        (rowsRes as unknown as { rows?: QRow[] }).rows ?? (rowsRes as unknown as QRow[])
      ).map((r) => {
        const base = Number(r.base_inr_paise);
        const bandMaxPaise = majorRupeesToPaise(r.band_max);
        const overBandPct =
          bandMaxPaise && bandMaxPaise > 0 ? ((base - bandMaxPaise) / bandMaxPaise) * 100 : null;
        return {
          approvalRequestId: r.approval_request_id,
          offerId: r.offer_id,
          applicationId: r.application_id,
          candidateName: r.candidate_name,
          roleTitle: r.role_title,
          baseInrPaise: base,
          bandMaxPaise,
          overBandPct: overBandPct != null ? Math.round(overBandPct * 10) / 10 : null,
          requestedAt:
            typeof r.requested_at === "string" ? r.requested_at : r.requested_at.toISOString(),
        };
      });
      return { rows };
    }),

  // ═══════════════════ HROPS-02 — HR analytics ═══════════════════

  /**
   * getHrAnalytics — five real charts over real queries for /hr-analytics:
   * time-to-hire by department, candidate drop-off by stage, offer acceptance,
   * hiring demand by department, average offer vs band midpoint by role. KPI
   * header derived from the live desk. hr_ops + admin. No AI, no writes.
   */
  getHrAnalytics: protectedProcedure.output(getHrAnalyticsOutputSchema).query(async ({ ctx }) => {
    requireAnyRole(ctx, COMP_DESK_ROLES, "HR analytics requires the hr_ops or admin role");
    const db = requireDb(ctx);
    if (!ctx.tenantId) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
    }
    const tenantId = ctx.tenantId;
    const asRows = <T>(res: unknown): T[] => (res as { rows?: T[] }).rows ?? (res as T[]);

    // 1. Time-to-hire by department (created → offer_accepted, days).
    const tthRes = await db.execute(dsql`
        SELECT bu.name AS department,
          ROUND(AVG(EXTRACT(EPOCH FROM (t.transitioned_at - a.created_at)) / 86400.0)::numeric, 1)::float8 AS avg_days
        FROM public.application_state_transitions t
        JOIN public.applications a ON a.id = t.application_id AND a.tenant_id = t.tenant_id
        JOIN public.requisitions r ON r.id = a.requisition_id
        JOIN public.positions p ON p.id = r.position_id
        JOIN public.business_units bu ON bu.id = p.business_unit_id
        WHERE t.tenant_id = ${tenantId}::uuid AND t.to_stage = 'offer_accepted'
        GROUP BY bu.name
        ORDER BY bu.name
      `);

    // 2. Candidate drop-off by stage (current count per stage; zero-filled).
    const dropRes = await db.execute(dsql`
        SELECT current_stage AS stage, COUNT(*)::int AS count
        FROM public.applications
        WHERE tenant_id = ${tenantId}::uuid
        GROUP BY current_stage
      `);

    // 3. Offer acceptance (accepted / declined / pending).
    const accRes = await db.execute(dsql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
          COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
          COUNT(*) FILTER (WHERE status IN ('drafted', 'extended'))::int AS pending
        FROM public.offers
        WHERE tenant_id = ${tenantId}::uuid
      `);

    // 4. Hiring demand by department (open vs filled requisitions).
    const demandRes = await db.execute(dsql`
        SELECT bu.name AS department,
          COUNT(*) FILTER (WHERE r.status IN ('posted', 'approved', 'on_hold'))::int AS open,
          COUNT(*) FILTER (WHERE r.status = 'filled')::int AS filled
        FROM public.requisitions r
        JOIN public.positions p ON p.id = r.position_id
        JOIN public.business_units bu ON bu.id = p.business_unit_id
        WHERE r.tenant_id = ${tenantId}::uuid
        GROUP BY bu.name
        ORDER BY bu.name
      `);

    // 5. Average offer vs band midpoint by role (paise). Band in MAJOR rupees
    //    → *100 to paise; only roles with a band set.
    const ovbRes = await db.execute(dsql`
        SELECT p.title AS role,
          ROUND(AVG(o.base_salary_inr_paise))::float8 AS avg_offer_paise,
          ROUND(AVG((p.comp_band_min + p.comp_band_max) / 2.0) * 100)::float8 AS band_mid_paise
        FROM public.offers o
        JOIN public.applications a ON a.id = o.application_id
        JOIN public.requisitions r ON r.id = a.requisition_id
        JOIN public.positions p ON p.id = r.position_id
        WHERE o.tenant_id = ${tenantId}::uuid
          AND p.comp_band_min IS NOT NULL AND p.comp_band_max IS NOT NULL
        GROUP BY p.title
        ORDER BY p.title
      `);

    interface DeptDaysRow {
      department: string;
      avg_days: number | null;
    }
    interface StageRow {
      stage: ApplicationStage;
      count: number;
    }
    interface AccRow {
      accepted: number;
      declined: number;
      pending: number;
    }
    interface DemandRow {
      department: string;
      open: number;
      filled: number;
    }
    interface OvbRow {
      role: string;
      avg_offer_paise: number | null;
      band_mid_paise: number | null;
    }

    const dropByStage = new Map(asRows<StageRow>(dropRes).map((r) => [r.stage, r.count]));
    const acc = asRows<AccRow>(accRes)[0] ?? { accepted: 0, declined: 0, pending: 0 };

    // KPI header from the live desk.
    const assembled = await loadCompDeskAssembled(db, tenantId);
    const deskRows = assembled.map((a) => a.row);
    const acceptanceDenom = acc.accepted + acc.declined;
    const acceptanceRatePct =
      acceptanceDenom > 0 ? Math.round((acc.accepted / acceptanceDenom) * 1000) / 10 : null;

    return {
      timeToHireByDept: asRows<DeptDaysRow>(tthRes).map((r) => ({
        department: r.department,
        avgDays: r.avg_days,
      })),
      dropOffByStage: applicationStageEnum.enumValues.map((stage) => ({
        stage,
        count: dropByStage.get(stage) ?? 0,
      })),
      offerAcceptance: { accepted: acc.accepted, declined: acc.declined, pending: acc.pending },
      demandByDept: asRows<DemandRow>(demandRes).map((r) => ({
        department: r.department,
        open: r.open,
        filled: r.filled,
      })),
      offerVsBandByRole: asRows<OvbRow>(ovbRes).map((r) => ({
        role: r.role,
        avgOfferPaise: r.avg_offer_paise,
        bandMidPaise: r.band_mid_paise,
      })),
      kpis: {
        onDesk: deskRows.length,
        offersOut: deskRows.filter((r) => r.offerStatus === "extended").length,
        needApproval: deskRows.filter(
          (r) => r.approvalStatus === "required" || r.approvalStatus === "pending",
        ).length,
        acceptanceRatePct,
      },
    };
  }),
  // ═══════════════════ HROPS-03 — documents & verification ═══════════════════
  //
  // Pre-offer document verification for hr_ops. Real machinery reuse: the
  // application_documents table follows onboarding_documents' RLS/audit/PII
  // discipline; downloads proxy through the PII-logged REST route; the candidate
  // uploads via the same blob endpoint they use for onboarding docs. Every
  // procedure is HR_OPS_DOC_ROLES-gated; RLS scopes rows to the tenant on top.

  /**
   * listApplicationDocumentCandidates — one row per application in the HR-ops
   * window that has at least one requested document, with its per-doc status +
   * an overall rollup, plus the hero stats. Search matches candidate name /
   * role; the status filter narrows which candidates appear (a candidate stays
   * if any of their docs is in that status). Stats are computed over the
   * search-scoped set, independent of the status filter, so the strip is stable.
   */
  listApplicationDocumentCandidates: protectedProcedure
    .input(listApplicationDocumentCandidatesInputSchema)
    .output(listApplicationDocumentCandidatesOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Documents & verification is an HR-ops surface.");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;

      const rows = await db
        .select({
          applicationId: applicationDocuments.applicationId,
          candidateId: applications.candidateId,
          stage: applications.currentStage,
          candidateName: persons.fullName,
          roleTitle: positions.title,
          docId: applicationDocuments.id,
          documentTypeId: applicationDocuments.documentTypeId,
          documentTypeName: documentTypes.name,
          status: applicationDocuments.status,
          fileName: applicationDocuments.fileName,
          mimeType: applicationDocuments.mimeType,
          rejectionReason: applicationDocuments.rejectionReason,
          requestedAt: applicationDocuments.requestedAt,
          uploadedAt: applicationDocuments.uploadedAt,
          verifiedAt: applicationDocuments.verifiedAt,
          verifiedBy: applicationDocuments.verifiedByMembershipId,
        })
        .from(applicationDocuments)
        .innerJoin(
          applications,
          and(
            eq(applications.tenantId, applicationDocuments.tenantId),
            eq(applications.id, applicationDocuments.applicationId),
          ),
        )
        .leftJoin(
          candidates,
          and(
            eq(candidates.tenantId, applications.tenantId),
            eq(candidates.id, applications.candidateId),
          ),
        )
        .leftJoin(
          persons,
          and(eq(persons.tenantId, applications.tenantId), eq(persons.id, candidates.personId)),
        )
        .leftJoin(
          requisitions,
          and(
            eq(requisitions.tenantId, applications.tenantId),
            eq(requisitions.id, applications.requisitionId),
          ),
        )
        .leftJoin(
          positions,
          and(
            eq(positions.tenantId, applications.tenantId),
            eq(positions.id, requisitions.positionId),
          ),
        )
        .leftJoin(documentTypes, eq(documentTypes.id, applicationDocuments.documentTypeId))
        .where(
          and(
            eq(applicationDocuments.tenantId, tenantId),
            inArray(applications.currentStage, HR_OPS_WINDOW_STAGES),
          ),
        )
        .orderBy(desc(applicationDocuments.requestedAt));

      const verifierNames = await resolveMembershipNames(
        ctx,
        tenantId,
        rows.map((r) => r.verifiedBy).filter((v): v is string => !!v),
      );

      const search = input.search?.trim().toLowerCase();
      const groups = new Map<string, ApplicationDocumentCandidateRow>();
      for (const r of rows) {
        const name = r.candidateName ?? null;
        const role = r.roleTitle ?? null;
        if (
          search &&
          !(name?.toLowerCase().includes(search) || role?.toLowerCase().includes(search))
        ) {
          continue;
        }
        let g = groups.get(r.applicationId);
        if (!g) {
          g = {
            applicationId: r.applicationId,
            candidateId: r.candidateId,
            candidateName: name,
            roleTitle: role,
            stage: r.stage,
            documents: [],
            overall: "none",
          };
          groups.set(r.applicationId, g);
        }
        const doc: ApplicationDocumentRow = {
          id: r.docId,
          applicationId: r.applicationId,
          documentTypeId: r.documentTypeId,
          documentTypeName: r.documentTypeName ?? null,
          status: r.status as ApplicationDocumentRow["status"],
          fileName: r.fileName ?? null,
          mimeType: r.mimeType ?? null,
          rejectionReason: r.rejectionReason ?? null,
          requestedAt: toIsoString(r.requestedAt) ?? new Date(0).toISOString(),
          uploadedAt: toIsoString(r.uploadedAt),
          verifiedAt: toIsoString(r.verifiedAt),
          verifierName: r.verifiedBy ? (verifierNames.get(r.verifiedBy) ?? null) : null,
        };
        g.documents.push(doc);
      }

      let verifiedDocs = 0;
      let pendingDocs = 0;
      let totalDocs = 0;
      for (const g of groups.values()) {
        g.overall = computeDocOverall(g.documents.map((d) => d.status));
        for (const d of g.documents) {
          totalDocs += 1;
          if (d.status === "verified") verifiedDocs += 1;
          else if (d.status === "requested" || d.status === "uploaded") pendingDocs += 1;
        }
      }

      let items = [...groups.values()];
      if (input.status) {
        items = items.filter((g) => g.documents.some((d) => d.status === input.status));
      }
      items = items.slice(0, input.limit);

      return {
        items,
        stats: { candidates: groups.size, verifiedDocs, pendingDocs, totalDocs },
      };
    }),

  /**
   * listRequestableDocumentTypes — the tenant-agnostic document_types catalogue,
   * for the "Request documents" modal. Reads the reference table (permissive
   * SELECT policy); no tenant scoping (the table has no tenant_id).
   */
  listRequestableDocumentTypes: protectedProcedure
    .output(listRequestableDocumentTypesOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Documents & verification is an HR-ops surface.");
      const db = requireDb(ctx);
      const rows = await db
        .select({
          id: documentTypes.id,
          code: documentTypes.code,
          name: documentTypes.name,
          geographyCode: documentTypes.geographyCode,
        })
        .from(documentTypes)
        .orderBy(dsql`${documentTypes.geographyCode} ASC NULLS FIRST`, documentTypes.name);
      return {
        items: rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          geographyCode: r.geographyCode ?? null,
        })),
      };
    }),

  /**
   * requestApplicationDocuments — hr_ops requests one or more document types for
   * an application. Creates a 'requested' row per type (no blob yet), idempotent
   * on (tenant, application, document_type) so a re-request skips existing rows.
   * The candidate sees the requests in their portal and uploads against them —
   * the same pull model onboarding document collection uses (no per-request
   * email; consistent with how onboarding requests surface).
   */
  requestApplicationDocuments: protectedProcedure
    .input(requestApplicationDocumentsInputSchema)
    .output(requestApplicationDocumentsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("request_application_documents", ctx, input, async () => {
        requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Documents & verification is an HR-ops surface.");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;

        const [app] = await db
          .select({ id: applications.id, stage: applications.currentStage })
          .from(applications)
          .where(and(eq(applications.tenantId, tenantId), eq(applications.id, input.applicationId)))
          .limit(1);
        if (!app) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        }

        // Validate the document type ids against the reference table.
        const typeRows = await db
          .select({ id: documentTypes.id })
          .from(documentTypes)
          .where(inArray(documentTypes.id, input.documentTypeIds));
        const validTypeIds = new Set(typeRows.map((t) => t.id));
        const requestTypes = input.documentTypeIds.filter((id) => validTypeIds.has(id));
        if (requestTypes.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "No valid document types" });
        }

        const membershipId = await resolveCallerMembershipId(ctx, tenantId);
        const inserted = await db
          .insert(applicationDocuments)
          .values(
            requestTypes.map((documentTypeId) => ({
              tenantId,
              applicationId: input.applicationId,
              documentTypeId,
              status: "requested",
              requestedByMembershipId: membershipId,
            })),
          )
          .onConflictDoNothing({
            target: [
              applicationDocuments.tenantId,
              applicationDocuments.applicationId,
              applicationDocuments.documentTypeId,
            ],
          })
          .returning({ id: applicationDocuments.id });

        return {
          applicationId: input.applicationId,
          requested: inserted.length,
          skipped: requestTypes.length - inserted.length,
        };
      });
    }),

  /**
   * verifyApplicationDocument — hr_ops marks an uploaded document verified.
   * Stamps the reviewer + verified_at, clears any prior rejection reason. A
   * still-'requested' document (no blob uploaded) can't be verified (400).
   */
  verifyApplicationDocument: protectedProcedure
    .input(verifyApplicationDocumentInputSchema)
    .output(verifyApplicationDocumentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("verify_application_document", ctx, input, async () => {
        requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Documents & verification is an HR-ops surface.");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;

        const [doc] = await db
          .select({ id: applicationDocuments.id, status: applicationDocuments.status })
          .from(applicationDocuments)
          .where(
            and(
              eq(applicationDocuments.tenantId, tenantId),
              eq(applicationDocuments.id, input.documentId),
            ),
          )
          .limit(1);
        if (!doc) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Application document not found" });
        }
        if (doc.status === "requested") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot verify a document that hasn't been uploaded yet",
          });
        }

        const membershipId = await resolveCallerMembershipId(ctx, tenantId);
        const now = new Date();
        const [updated] = await db
          .update(applicationDocuments)
          .set({
            status: "verified",
            verifiedByMembershipId: membershipId,
            verifiedAt: now,
            rejectionReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(applicationDocuments.tenantId, tenantId),
              eq(applicationDocuments.id, input.documentId),
            ),
          )
          .returning({ status: applicationDocuments.status });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "verify application document returned no row",
          });
        }
        return { documentId: doc.id, status: updated.status as "verified" };
      });
    }),

  /**
   * rejectApplicationDocument — hr_ops rejects an uploaded document with a
   * REQUIRED reason (400 without). The candidate re-uploads (→ 'uploaded').
   */
  rejectApplicationDocument: protectedProcedure
    .input(rejectApplicationDocumentInputSchema)
    .output(rejectApplicationDocumentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("reject_application_document", ctx, input, async () => {
        requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Documents & verification is an HR-ops surface.");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const reason = input.rejectionReason.trim();
        if (reason.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "rejectionReason is required to reject a document",
          });
        }

        const [doc] = await db
          .select({ id: applicationDocuments.id, status: applicationDocuments.status })
          .from(applicationDocuments)
          .where(
            and(
              eq(applicationDocuments.tenantId, tenantId),
              eq(applicationDocuments.id, input.documentId),
            ),
          )
          .limit(1);
        if (!doc) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Application document not found" });
        }
        if (doc.status === "requested") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot reject a document that hasn't been uploaded yet",
          });
        }

        const membershipId = await resolveCallerMembershipId(ctx, tenantId);
        const now = new Date();
        const [updated] = await db
          .update(applicationDocuments)
          .set({
            status: "rejected",
            verifiedByMembershipId: membershipId,
            verifiedAt: now,
            rejectionReason: reason,
            updatedAt: now,
          })
          .where(
            and(
              eq(applicationDocuments.tenantId, tenantId),
              eq(applicationDocuments.id, input.documentId),
            ),
          )
          .returning({
            status: applicationDocuments.status,
            rejectionReason: applicationDocuments.rejectionReason,
          });
        if (!updated) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "reject application document returned no row",
          });
        }
        return {
          documentId: doc.id,
          status: updated.status as "rejected",
          rejectionReason: updated.rejectionReason ?? null,
        };
      });
    }),

  // ─────────── candidate side: pre-offer documents ───────────

  /**
   * candidateListMyApplicationDocuments — the requested pre-offer documents on
   * the candidate's own applications, grouped by application. Person-scoped:
   * every row traces application → candidate → person = the caller.
   */
  candidateListMyApplicationDocuments: candidateProcedure
    .output(candidateListMyApplicationDocumentsOutputSchema)
    .query(async ({ ctx }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "candidate ctx.db missing" });
      }
      const rows = await db
        .select({
          applicationId: applicationDocuments.applicationId,
          roleTitle: positions.title,
          docId: applicationDocuments.id,
          documentTypeId: applicationDocuments.documentTypeId,
          documentTypeName: documentTypes.name,
          status: applicationDocuments.status,
          fileName: applicationDocuments.fileName,
          rejectionReason: applicationDocuments.rejectionReason,
          uploadedAt: applicationDocuments.uploadedAt,
          requestedAt: applicationDocuments.requestedAt,
        })
        .from(applicationDocuments)
        .innerJoin(
          applications,
          and(
            eq(applications.tenantId, applicationDocuments.tenantId),
            eq(applications.id, applicationDocuments.applicationId),
          ),
        )
        .innerJoin(
          candidates,
          and(
            eq(candidates.tenantId, applications.tenantId),
            eq(candidates.id, applications.candidateId),
          ),
        )
        .leftJoin(
          requisitions,
          and(
            eq(requisitions.tenantId, applications.tenantId),
            eq(requisitions.id, applications.requisitionId),
          ),
        )
        .leftJoin(
          positions,
          and(
            eq(positions.tenantId, applications.tenantId),
            eq(positions.id, requisitions.positionId),
          ),
        )
        .leftJoin(documentTypes, eq(documentTypes.id, applicationDocuments.documentTypeId))
        .where(
          and(
            eq(applicationDocuments.tenantId, ctx.candidate.tenantId),
            eq(candidates.personId, ctx.candidate.personId),
          ),
        )
        .orderBy(desc(applicationDocuments.requestedAt));

      const groups = new Map<string, CandidateApplicationDocumentGroup>();
      for (const r of rows) {
        let g = groups.get(r.applicationId);
        if (!g) {
          g = { applicationId: r.applicationId, roleTitle: r.roleTitle ?? null, documents: [] };
          groups.set(r.applicationId, g);
        }
        const slot: CandidateApplicationDocumentSlot = {
          documentId: r.docId,
          documentTypeId: r.documentTypeId,
          documentTypeName: r.documentTypeName ?? null,
          status: r.status as CandidateApplicationDocumentSlot["status"],
          fileName: r.fileName ?? null,
          rejectionReason: r.rejectionReason ?? null,
          uploadedAt: toIsoString(r.uploadedAt),
        };
        g.documents.push(slot);
      }
      return { groups: [...groups.values()] };
    }),

  /**
   * candidateAttachApplicationDocument — the candidate uploads a blob (via the
   * shared /api/candidate-documents/upload endpoint) then attaches it here to a
   * requested document row they own. Person-scoped ownership check, then the
   * shared attach write-path moves the row to 'uploaded' for hr_ops review.
   */
  candidateAttachApplicationDocument: candidateProcedure
    .input(candidateAttachApplicationDocumentInputSchema)
    .output(candidateAttachApplicationDocumentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit(
        "candidate_attach_application_document",
        ctx,
        { documentId: input.documentId },
        async () => {
          const db = ctx.db;
          if (!db) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "candidate ctx.db missing",
            });
          }
          // Person-scoped ownership: document → application → candidate → person.
          const [owned] = await db
            .select({ id: applicationDocuments.id })
            .from(applicationDocuments)
            .innerJoin(
              applications,
              and(
                eq(applications.tenantId, applicationDocuments.tenantId),
                eq(applications.id, applicationDocuments.applicationId),
              ),
            )
            .innerJoin(
              candidates,
              and(
                eq(candidates.tenantId, applications.tenantId),
                eq(candidates.id, applications.candidateId),
              ),
            )
            .where(
              and(
                eq(applicationDocuments.tenantId, ctx.candidate.tenantId),
                eq(applicationDocuments.id, input.documentId),
                eq(candidates.personId, ctx.candidate.personId),
              ),
            )
            .limit(1);
          if (!owned) {
            throw new TRPCError({ code: "NOT_FOUND", message: "application_document_not_found" });
          }

          const result = await attachApplicationDocumentBlob(db, ctx.candidate.tenantId, {
            documentId: input.documentId,
            storageKey: input.storageKey,
            fileName: input.fileName,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
          });
          return { documentId: result.documentId, status: result.status as "uploaded" };
        },
      );
    }),

  // ─────────── CAND-02 — candidate self-service profile ───────────

  /**
   * candidateGetProfile — the caller's own editable profile, read from the
   * canonical sources (persons contact/location + candidates summaries +
   * parsed_skills + most-recent application salary). Person-scoped. Discloses
   * NOTHING internal (no AI score, no scorecard).
   */
  candidateGetProfile: candidateProcedure
    .output(candidateGetProfileOutputSchema)
    .query(async ({ ctx }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "candidate ctx.db missing" });
      }
      const profile = await readCandidateProfile(
        db,
        ctx.candidate.tenantId,
        ctx.candidate.personId,
      );
      return { profile };
    }),

  /**
   * candidateUpdateProfile — the candidate edits their OWN profile. Every field
   * is optional (send only what changed; `null` clears). Persists to the exact
   * canonical sources the recruiter's Missing-Info tracker reads — honest loop
   * closure:
   *   - phone / location   → persons.phone_primary(+normalised) / location_*
   *   - experience/education→ candidates.experience_summary / education_summary
   *   - skills / notice     → candidates.parsed_skills (shallow-merged jsonb)
   *   - salary expectation  → the caller's LIVE (non-terminal) applications'
   *                           expected_salary_inr_paise
   * Person-scoped throughout (RLS scopes tenant; the person_id predicate scopes
   * identity). Echoes the freshly-persisted profile so the client re-syncs.
   */
  candidateUpdateProfile: candidateProcedure
    .input(candidateUpdateProfileInputSchema)
    .output(candidateUpdateProfileOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit(
        "candidate_update_profile",
        ctx,
        { fields: Object.keys(input) },
        async () => {
          const db = ctx.db;
          if (!db) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "candidate ctx.db missing",
            });
          }
          const tenantId = ctx.candidate.tenantId;
          const personId = ctx.candidate.personId;

          // 1) persons — contact + location (self-editable identity fields).
          const personSet: Record<string, unknown> = {};
          if (input.phone !== undefined) {
            const phone = input.phone && input.phone.length > 0 ? input.phone : null;
            personSet.phonePrimary = phone;
            personSet.phoneNormalised = phone ? normalisePhone(phone) : null;
          }
          if (input.locationCity !== undefined) {
            personSet.locationCity =
              input.locationCity && input.locationCity.length > 0 ? input.locationCity : null;
          }
          if (input.locationCountry !== undefined) {
            personSet.locationCountry = input.locationCountry
              ? input.locationCountry.toUpperCase()
              : null;
          }
          if (Object.keys(personSet).length > 0) {
            personSet.updatedAt = new Date();
            await db
              .update(persons)
              .set(personSet)
              .where(and(eq(persons.tenantId, tenantId), eq(persons.id, personId)));
          }

          // Resolve the caller's candidate row (recruitment lifecycle record).
          // A candidate_account person that never entered the pipeline may lack
          // one; the candidate-side writes below are skipped honestly in that
          // case (persons-side edits above still persist).
          const [cand] = await db
            .select({ id: candidates.id })
            .from(candidates)
            .where(and(eq(candidates.tenantId, tenantId), eq(candidates.personId, personId)))
            .limit(1);

          if (cand) {
            // 2) candidates — free-text summaries.
            const candSet: Record<string, unknown> = {};
            if (input.experienceSummary !== undefined) {
              candSet.experienceSummary =
                input.experienceSummary && input.experienceSummary.length > 0
                  ? input.experienceSummary
                  : null;
            }
            if (input.educationSummary !== undefined) {
              candSet.educationSummary =
                input.educationSummary && input.educationSummary.length > 0
                  ? input.educationSummary
                  : null;
            }
            if (Object.keys(candSet).length > 0) {
              candSet.updatedAt = new Date();
              await db
                .update(candidates)
                .set(candSet)
                .where(and(eq(candidates.tenantId, tenantId), eq(candidates.id, cand.id)));
            }

            // 3) candidates.parsed_skills — shallow-merge skills + notice period
            // so we preserve every other parsed key (personal, work_history,
            // education, parse_metadata). COALESCE guards a null blob.
            const patch: Record<string, unknown> = {};
            if (input.skills !== undefined) patch.skills = input.skills;
            if (input.noticePeriodDays !== undefined) {
              patch.notice_period_days = input.noticePeriodDays;
            }
            if (Object.keys(patch).length > 0) {
              await db.execute(dsql`
              UPDATE public.candidates
              SET parsed_skills = COALESCE(parsed_skills, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
                  updated_at = now()
              WHERE tenant_id = ${tenantId} AND id = ${cand.id}
            `);
            }

            // 4) applications — the salary expectation the recruiter chases lives
            // per-application. Apply to every LIVE (non-terminal) application this
            // candidate has, so the Missing-Info tracker clears across each open
            // pipeline. Terminal applications (accepted/declined/withdrawn/
            // rejected) are left untouched — their record is locked.
            if (input.expectedSalaryInrPaise !== undefined) {
              await db.execute(dsql`
              UPDATE public.applications
              SET expected_salary_inr_paise = ${input.expectedSalaryInrPaise}::bigint,
                  updated_at = now()
              WHERE tenant_id = ${tenantId}
                AND candidate_id = ${cand.id}
                AND current_stage NOT IN (
                  'offer_accepted', 'offer_declined', 'withdrawn', 'recruiter_rejected'
                )
            `);
            }
          }

          const profile = await readCandidateProfile(db, tenantId, personId);
          return { ok: true as const, profile };
        },
      );
    }),

  // ─────────── CAND-02 — candidate notifications feed ───────────

  /**
   * candidateListMyNotifications — the caller's OWN notifications, a person-
   * scoped read of REAL notification_outbox rows (recipient_type = 'candidate',
   * matched by recipient_candidate_id or the candidate's email for pre-account
   * rows like activation). NOTHING is fabricated: an empty outbox → an empty
   * feed. Each row's title/category is a deterministic map from its template
   * key; the body is the row's real email subject (or a mapped fallback).
   */
  candidateListMyNotifications: candidateProcedure
    .output(candidateListMyNotificationsOutputSchema)
    .query(async ({ ctx }) => {
      const db = ctx.db;
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "candidate ctx.db missing" });
      }
      const tenantId = ctx.candidate.tenantId;
      const email = ctx.candidate.email;

      const [cand] = await db
        .select({ id: candidates.id })
        .from(candidates)
        .where(
          and(eq(candidates.tenantId, tenantId), eq(candidates.personId, ctx.candidate.personId)),
        )
        .limit(1);

      const recipientFilter = cand
        ? or(
            eq(notificationOutbox.recipientCandidateId, cand.id),
            eq(notificationOutbox.recipientEmail, email),
          )
        : eq(notificationOutbox.recipientEmail, email);

      const rows = await db
        .select({
          id: notificationOutbox.id,
          templateKey: notificationOutbox.templateKey,
          subject: notificationOutbox.subject,
          createdAt: notificationOutbox.createdAt,
          readAt: notificationOutbox.candidateReadAt,
        })
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.tenantId, tenantId),
            eq(notificationOutbox.recipientType, "candidate"),
            ne(notificationOutbox.status, "cancelled"),
            recipientFilter,
          ),
        )
        .orderBy(desc(notificationOutbox.createdAt))
        .limit(100);

      let unreadCount = 0;
      const items: CandidateNotificationRow[] = rows.map((r) => {
        const display = displayForCandidateNotification(r.templateKey);
        const read = r.readAt != null;
        if (!read) unreadCount += 1;
        const body = r.subject && r.subject.trim().length > 0 ? r.subject : display.fallbackBody;
        return {
          id: r.id,
          category: display.category,
          title: display.title,
          body,
          read,
          createdAt: r.createdAt.toISOString(),
        };
      });

      return { items, unreadCount };
    }),

  /**
   * candidateMarkNotificationsRead — mark the caller's unread candidate
   * notifications read (all, or a specific set by id). Person-scoped; persists
   * to notification_outbox.candidate_read_at. Idempotent (only NULL rows are
   * touched). Returns how many rows were newly marked.
   */
  candidateMarkNotificationsRead: candidateProcedure
    .input(candidateMarkNotificationsReadInputSchema)
    .output(candidateMarkNotificationsReadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit(
        "candidate_mark_notifications_read",
        ctx,
        { count: input.ids?.length ?? "all" },
        async () => {
          const db = ctx.db;
          if (!db) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "candidate ctx.db missing",
            });
          }
          const tenantId = ctx.candidate.tenantId;
          const email = ctx.candidate.email;

          const [cand] = await db
            .select({ id: candidates.id })
            .from(candidates)
            .where(
              and(
                eq(candidates.tenantId, tenantId),
                eq(candidates.personId, ctx.candidate.personId),
              ),
            )
            .limit(1);

          const recipientFilter = cand
            ? or(
                eq(notificationOutbox.recipientCandidateId, cand.id),
                eq(notificationOutbox.recipientEmail, email),
              )
            : eq(notificationOutbox.recipientEmail, email);

          const conditions = [
            eq(notificationOutbox.tenantId, tenantId),
            eq(notificationOutbox.recipientType, "candidate"),
            ne(notificationOutbox.status, "cancelled"),
            isNull(notificationOutbox.candidateReadAt),
            recipientFilter,
          ];
          if (input.ids && input.ids.length > 0) {
            conditions.push(inArray(notificationOutbox.id, input.ids));
          }

          const updated = await db
            .update(notificationOutbox)
            .set({ candidateReadAt: new Date() })
            .where(and(...conditions))
            .returning({ id: notificationOutbox.id });

          return { ok: true as const, markedCount: updated.length };
        },
      );
    }),

  // ═══════════════════ HROPS-03 — case audit trail ═══════════════════
  //
  // Read + note-write over the REAL audit_logs stream. The timeline for an
  // application unions the trigger-written rows for the application itself
  // (stage transitions), its offers, its pre-offer documents, and its
  // hr_case_notes. Notes are written to a durable table whose audit trigger
  // produces the audit_logs row the timeline renders — no synthetic audit rows.
  // Tenant-scoped throughout (RLS + explicit predicate); HR_OPS_DOC_ROLES-gated.

  /**
   * listCaseAuditCases — one row per application in the HR-ops window, with its
   * total audit-event count + last activity, newest activity first. Search
   * matches candidate name / role.
   */
  listCaseAuditCases: protectedProcedure
    .input(listCaseAuditCasesInputSchema)
    .output(listCaseAuditCasesOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Case audit is an HR-ops surface.");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;
      const search = input.search?.trim();
      const searchClause = search
        ? dsql`AND (p.full_name ILIKE ${"%" + search + "%"} OR pos.title ILIKE ${"%" + search + "%"})`
        : dsql``;

      const result = await db.execute(dsql`
        WITH app_events AS (
          SELECT al.entity_id AS application_id, al.created_at
          FROM public.audit_logs al
          WHERE al.tenant_id = ${tenantId} AND al.entity_type = 'applications'
          UNION ALL
          SELECT o.application_id, al.created_at
          FROM public.audit_logs al
          JOIN public.offers o ON o.id = al.entity_id AND o.tenant_id = al.tenant_id
          WHERE al.tenant_id = ${tenantId} AND al.entity_type = 'offers'
          UNION ALL
          SELECT ad.application_id, al.created_at
          FROM public.audit_logs al
          JOIN public.application_documents ad ON ad.id = al.entity_id AND ad.tenant_id = al.tenant_id
          WHERE al.tenant_id = ${tenantId} AND al.entity_type = 'application_documents'
          UNION ALL
          SELECT n.application_id, al.created_at
          FROM public.audit_logs al
          JOIN public.hr_case_notes n ON n.id = al.entity_id AND n.tenant_id = al.tenant_id
          WHERE al.tenant_id = ${tenantId} AND al.entity_type = 'hr_case_notes'
        ),
        ev AS (
          SELECT application_id, count(*)::int AS cnt, max(created_at) AS last_at
          FROM app_events GROUP BY application_id
        ),
        nc AS (
          SELECT application_id, count(*)::int AS notes
          FROM public.hr_case_notes WHERE tenant_id = ${tenantId} GROUP BY application_id
        )
        SELECT
          a.id::text AS application_id,
          a.current_stage AS stage,
          p.full_name AS candidate_name,
          pos.title AS role_title,
          COALESCE(ev.cnt, 0) AS event_count,
          ev.last_at::text AS last_at,
          COALESCE(nc.notes, 0) AS note_count,
          a.stage_entered_at::text AS stage_entered_at
        FROM public.applications a
        LEFT JOIN public.candidates c ON c.id = a.candidate_id AND c.tenant_id = a.tenant_id
        LEFT JOIN public.persons p ON p.id = c.person_id AND p.tenant_id = a.tenant_id
        LEFT JOIN public.requisitions r ON r.id = a.requisition_id AND r.tenant_id = a.tenant_id
        LEFT JOIN public.positions pos ON pos.id = r.position_id AND pos.tenant_id = a.tenant_id
        LEFT JOIN ev ON ev.application_id = a.id
        LEFT JOIN nc ON nc.application_id = a.id
        WHERE a.tenant_id = ${tenantId}
          AND a.current_stage IN ('tech_interview', 'hr_round', 'offer_drafted', 'offer_accepted')
          ${searchClause}
        ORDER BY ev.last_at DESC NULLS LAST, a.stage_entered_at DESC
        LIMIT ${input.limit}
      `);
      const rows =
        (result as unknown as { rows?: CaseAuditListSqlRow[] }).rows ??
        (result as unknown as CaseAuditListSqlRow[]);

      let events = 0;
      let notes = 0;
      const items = rows.map((r) => {
        events += Number(r.event_count);
        notes += Number(r.note_count);
        return {
          applicationId: r.application_id,
          caseRef: `CASE-${r.application_id.slice(0, 8).toUpperCase()}`,
          candidateName: r.candidate_name ?? null,
          roleTitle: r.role_title ?? null,
          stage: r.stage as ApplicationStage,
          eventCount: Number(r.event_count),
          lastActivityAt: r.last_at ? new Date(r.last_at).toISOString() : null,
        };
      });

      return { items, stats: { cases: items.length, events, notes } };
    }),

  /**
   * getCaseAuditTimeline — the full audit timeline for one application: every
   * trigger-written audit_logs row for the application, its offers, its pre-offer
   * documents, and its hr_case_notes, newest first, projected to display events.
   */
  getCaseAuditTimeline: protectedProcedure
    .input(getCaseAuditTimelineInputSchema)
    .output(getCaseAuditTimelineOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Case audit is an HR-ops surface.");
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const tenantId = ctx.tenantId;

      const [app] = await db
        .select({
          id: applications.id,
          stage: applications.currentStage,
          candidateName: persons.fullName,
          roleTitle: positions.title,
        })
        .from(applications)
        .leftJoin(
          candidates,
          and(
            eq(candidates.tenantId, applications.tenantId),
            eq(candidates.id, applications.candidateId),
          ),
        )
        .leftJoin(
          persons,
          and(eq(persons.tenantId, applications.tenantId), eq(persons.id, candidates.personId)),
        )
        .leftJoin(
          requisitions,
          and(
            eq(requisitions.tenantId, applications.tenantId),
            eq(requisitions.id, applications.requisitionId),
          ),
        )
        .leftJoin(
          positions,
          and(
            eq(positions.tenantId, applications.tenantId),
            eq(positions.id, requisitions.positionId),
          ),
        )
        .where(and(eq(applications.tenantId, tenantId), eq(applications.id, input.applicationId)))
        .limit(1);
      if (!app) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
      }

      // Related entity ids + label maps (doc type names, note text/authors).
      const offerRows = await db
        .select({ id: offers.id })
        .from(offers)
        .where(and(eq(offers.tenantId, tenantId), eq(offers.applicationId, input.applicationId)));
      const docRows = await db
        .select({
          id: applicationDocuments.id,
          typeName: documentTypes.name,
        })
        .from(applicationDocuments)
        .leftJoin(documentTypes, eq(documentTypes.id, applicationDocuments.documentTypeId))
        .where(
          and(
            eq(applicationDocuments.tenantId, tenantId),
            eq(applicationDocuments.applicationId, input.applicationId),
          ),
        );
      const noteRows = await db
        .select({
          id: hrCaseNotes.id,
          note: hrCaseNotes.note,
          author: hrCaseNotes.authorMembershipId,
        })
        .from(hrCaseNotes)
        .where(
          and(
            eq(hrCaseNotes.tenantId, tenantId),
            eq(hrCaseNotes.applicationId, input.applicationId),
          ),
        );

      const docTypeById = new Map(docRows.map((d) => [d.id, d.typeName ?? null]));
      const noteById = new Map(noteRows.map((n) => [n.id, n.note]));
      const noteAuthorNames = await resolveMembershipNames(
        ctx,
        tenantId,
        noteRows.map((n) => n.author).filter((v): v is string => !!v),
      );
      const noteAuthorById = new Map(
        noteRows.map((n) => [n.id, n.author ? (noteAuthorNames.get(n.author) ?? null) : null]),
      );

      const allIds = [
        input.applicationId,
        ...offerRows.map((o) => o.id),
        ...docRows.map((d) => d.id),
        ...noteRows.map((n) => n.id),
      ];
      const idList = dsql.join(
        allIds.map((id) => dsql`${id}::uuid`),
        dsql`, `,
      );

      const auditRows = await db
        .select({
          id: auditLogs.id,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          action: auditLogs.action,
          changedColumns: auditLogs.changedColumns,
          beforeData: auditLogs.beforeData,
          afterData: auditLogs.afterData,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, tenantId), dsql`${auditLogs.entityId} IN (${idList})`))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id));

      const events: CaseAuditEvent[] = auditRows.map((r) =>
        projectCaseAuditEvent(r, docTypeById, noteById, noteAuthorById),
      );

      return {
        applicationId: app.id,
        candidateName: app.candidateName ?? null,
        roleTitle: app.roleTitle ?? null,
        stage: app.stage,
        events,
      };
    }),

  /**
   * addCaseAuditNote — hr_ops adds a free-text note to an application's case.
   * Inserts an hr_case_notes row; the audit_record_change() trigger writes the
   * REAL audit_logs event the timeline renders as a note.
   */
  addCaseAuditNote: protectedProcedure
    .input(addCaseAuditNoteInputSchema)
    .output(addCaseAuditNoteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit(
        "add_case_audit_note",
        ctx,
        { applicationId: input.applicationId },
        async () => {
          requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Case audit is an HR-ops surface.");
          const db = requireDb(ctx);
          if (!ctx.tenantId) {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
          }
          const tenantId = ctx.tenantId;
          const note = input.note.trim();
          if (note.length === 0) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Note text is required" });
          }

          const [app] = await db
            .select({ id: applications.id })
            .from(applications)
            .where(
              and(eq(applications.tenantId, tenantId), eq(applications.id, input.applicationId)),
            )
            .limit(1);
          if (!app) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
          }

          const membershipId = await resolveCallerMembershipId(ctx, tenantId);
          const [row] = await db
            .insert(hrCaseNotes)
            .values({
              tenantId,
              applicationId: input.applicationId,
              note,
              authorMembershipId: membershipId,
            })
            .returning({ id: hrCaseNotes.id, createdAt: hrCaseNotes.createdAt });
          if (!row) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "add case note returned no row",
            });
          }
          return {
            noteId: row.id,
            createdAt: toIsoString(row.createdAt) ?? new Date().toISOString(),
          };
        },
      );
    }),

  // ═══════════════════ HROPS-03 — templates & policies ═══════════════════

  /**
   * listHrPolicies — the tenant's curated templates & policies library
   * (/hr-policies). Read-only; seeded by db:seed:hr-policies as curated
   * reference content (labelled in the UI). Tenant-scoped (RLS + predicate).
   */
  listHrPolicies: protectedProcedure.output(listHrPoliciesOutputSchema).query(async ({ ctx }) => {
    requireAnyRole(ctx, HR_OPS_DOC_ROLES, "Policies is an HR-ops surface.");
    const db = requireDb(ctx);
    if (!ctx.tenantId) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
    }
    const rows = await db
      .select({
        id: hrPolicyDocuments.id,
        title: hrPolicyDocuments.title,
        category: hrPolicyDocuments.category,
        summary: hrPolicyDocuments.summary,
        bodyMd: hrPolicyDocuments.bodyMd,
        updatedAt: hrPolicyDocuments.updatedAt,
      })
      .from(hrPolicyDocuments)
      .where(eq(hrPolicyDocuments.tenantId, ctx.tenantId))
      .orderBy(hrPolicyDocuments.category, hrPolicyDocuments.title);
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category as "offers" | "benefits" | "policies",
        summary: r.summary,
        bodyMd: r.bodyMd,
        updatedAt: toIsoString(r.updatedAt) ?? new Date(0).toISOString(),
      })),
    };
  }),

  // ═══════════ RO-03 — JD library, panel setup, requisition insights ═══════════
  //
  // The hiring-manager persona surfaces. Every read is scoped to the caller's
  // OWN requisitions (resolveMyRequisitionScope) — admin sees the whole tenant.
  // Real data only; the deliberate refusals (demographics, psychometric radar,
  // offer-acceptance probability) are simply absent from the shape.

  /**
   * listJdLibrary (/jd-library) — a searchable table over MY requisitions'
   * current JD version: role, department, keyword chips (jd_skills, falling
   * back to aiMetadata.keywords — real data), req status + JD status
   * (draft|approved|archived per jd_versions.status), created. Rows link to the
   * requisition detail; the client owns per-req version history (below).
   */
  listJdLibrary: protectedProcedure
    .input(listJdLibraryInputSchema)
    .output(listJdLibraryOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, HM_INSIGHTS_ROLES, "JD library is a hiring-manager surface.");
      const db = requireDb(ctx);
      const scope = await resolveMyRequisitionScope(db, ctx);
      if (scope.ids.length === 0) return { rows: [] };

      const rows = await db
        .select({
          requisitionId: requisitions.id,
          positionId: positions.id,
          title: positions.title,
          department: businessUnits.name,
          reqStatus: requisitions.status,
          createdAt: requisitions.createdAt,
          jdVersionId: jdVersions.id,
          jdStatus: jdVersions.status,
          jdMetadata: jdVersions.aiMetadata,
        })
        .from(requisitions)
        .innerJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .leftJoin(
          businessUnits,
          and(
            eq(positions.tenantId, businessUnits.tenantId),
            eq(positions.businessUnitId, businessUnits.id),
          ),
        )
        .innerJoin(
          jdVersions,
          and(
            eq(requisitions.tenantId, jdVersions.tenantId),
            eq(requisitions.jdVersionId, jdVersions.id),
          ),
        )
        .where(inArray(requisitions.id, scope.ids))
        .orderBy(desc(requisitions.createdAt))
        .limit(input.limit);

      // Keyword chips: prefer the JD version's real skills; fall back to
      // aiMetadata.keywords. Both are real curated/parsed data — never invented.
      const skillRows =
        rows.length > 0
          ? await db
              .select({ jdVersionId: jdSkills.jdVersionId, skillName: jdSkills.skillName })
              .from(jdSkills)
              .where(
                inArray(
                  jdSkills.jdVersionId,
                  rows.map((r) => r.jdVersionId),
                ),
              )
          : [];
      const skillsByVersion = new Map<string, string[]>();
      for (const s of skillRows) {
        const list = skillsByVersion.get(s.jdVersionId) ?? [];
        list.push(s.skillName);
        skillsByVersion.set(s.jdVersionId, list);
      }

      return {
        rows: rows.map((r) => {
          let keywords = skillsByVersion.get(r.jdVersionId) ?? [];
          if (keywords.length === 0) {
            const meta = (r.jdMetadata ?? {}) as Record<string, unknown>;
            const kw = meta.keywords;
            if (Array.isArray(kw)) {
              keywords = kw.filter((k): k is string => typeof k === "string");
            }
          }
          return {
            requisitionId: r.requisitionId,
            positionId: r.positionId,
            title: r.title ?? null,
            department: r.department ?? null,
            reqStatus: r.reqStatus,
            jdStatus: r.jdStatus,
            keywords: keywords.slice(0, 12),
            createdAt: r.createdAt.toISOString(),
          };
        }),
      };
    }),

  /**
   * getJdVersionHistory (/jd-library expando) — every JD version for a
   * requisition's position, newest first: version number, status, summary
   * snippet, and the full JD text for the read-only view modal. The requisition
   * must be one of MINE (or any, for admin) — else NOT_FOUND under the scope
   * guard, mirroring how a cross-tenant req 404s under RLS.
   */
  getJdVersionHistory: protectedProcedure
    .input(getJdVersionHistoryInputSchema)
    .output(getJdVersionHistoryOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, HM_INSIGHTS_ROLES, "JD library is a hiring-manager surface.");
      const db = requireDb(ctx);
      const scope = await resolveMyRequisitionScope(db, ctx);
      if (!scope.ids.includes(input.requisitionId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      }
      const [req] = await db
        .select({
          positionId: requisitions.positionId,
          currentJdVersionId: requisitions.jdVersionId,
          title: positions.title,
        })
        .from(requisitions)
        .innerJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .where(eq(requisitions.id, input.requisitionId))
        .limit(1);
      if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });

      const versions = await db
        .select({
          id: jdVersions.id,
          versionNumber: jdVersions.versionNumber,
          status: jdVersions.status,
          summary: jdVersions.summary,
          jdText: jdVersions.jdText,
          createdAt: jdVersions.createdAt,
        })
        .from(jdVersions)
        .where(eq(jdVersions.positionId, req.positionId))
        .orderBy(desc(jdVersions.versionNumber));

      return {
        requisitionId: input.requisitionId,
        title: req.title ?? null,
        versions: versions.map((v) => ({
          id: v.id,
          versionNumber: v.versionNumber,
          status: v.status,
          summary: v.summary ?? null,
          jdText: v.jdText,
          isCurrent: v.id === req.currentJdVersionId,
          createdAt: v.createdAt.toISOString(),
        })),
      };
    }),

  /**
   * listPanelSetupRequisitions (/panel-setup) — MY requisitions with an
   * interview-plan summary: round count, total duration, templates used. The
   * pick-a-requisition list; per-req detail is getPanelSetup + the embedded
   * InterviewPlanSection editor.
   */
  listPanelSetupRequisitions: protectedProcedure
    .input(listPanelSetupRequisitionsInputSchema)
    .output(listPanelSetupRequisitionsOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, HM_INSIGHTS_ROLES, "Panel setup is a hiring-manager surface.");
      const db = requireDb(ctx);
      const scope = await resolveMyRequisitionScope(db, ctx);
      if (scope.ids.length === 0) return { rows: [] };

      const reqRows = await db
        .select({
          requisitionId: requisitions.id,
          title: positions.title,
          department: businessUnits.name,
          status: requisitions.status,
          createdAt: requisitions.createdAt,
        })
        .from(requisitions)
        .innerJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .leftJoin(
          businessUnits,
          and(
            eq(positions.tenantId, businessUnits.tenantId),
            eq(positions.businessUnitId, businessUnits.id),
          ),
        )
        .where(inArray(requisitions.id, scope.ids))
        .orderBy(desc(requisitions.createdAt))
        .limit(input.limit);

      const planRows = await db
        .select({
          requisitionId: interviewPlans.requisitionId,
          durationMinutes: interviewPlans.durationMinutes,
          scorecardTemplate: interviewPlans.scorecardTemplate,
        })
        .from(interviewPlans)
        .where(inArray(interviewPlans.requisitionId, scope.ids));

      const planByReq = new Map<string, { rounds: number; duration: number; tmpl: Set<string> }>();
      for (const p of planRows) {
        const agg = planByReq.get(p.requisitionId) ?? { rounds: 0, duration: 0, tmpl: new Set() };
        agg.rounds += 1;
        agg.duration += p.durationMinutes ?? 0;
        if (p.scorecardTemplate) agg.tmpl.add(p.scorecardTemplate);
        planByReq.set(p.requisitionId, agg);
      }

      return {
        rows: reqRows.map((r) => {
          const agg = planByReq.get(r.requisitionId);
          return {
            requisitionId: r.requisitionId,
            title: r.title ?? null,
            department: r.department ?? null,
            status: r.status,
            roundCount: agg?.rounds ?? 0,
            totalDurationMinutes: agg?.duration ?? 0,
            templatesUsed: agg ? Array.from(agg.tmpl) : [],
          };
        }),
      };
    }),

  /**
   * getPanelSetup (/panel-setup detail) — the interview plan as a pipeline: an
   * ordered list of rounds with name, duration, mode, scorecard, and the
   * plan's advisory default panellists resolved to display names (READ-ONLY —
   * actual per-round assignment happens at scheduling, /interviews). Feeds the
   * numbered-dot pipeline visualization above the embedded plan editor.
   */
  getPanelSetup: protectedProcedure
    .input(getPanelSetupInputSchema)
    .output(getPanelSetupOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, HM_INSIGHTS_ROLES, "Panel setup is a hiring-manager surface.");
      const db = requireDb(ctx);
      const scope = await resolveMyRequisitionScope(db, ctx);
      if (!scope.ids.includes(input.requisitionId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      }
      const [req] = await db
        .select({ title: positions.title, status: requisitions.status })
        .from(requisitions)
        .innerJoin(
          positions,
          and(
            eq(requisitions.tenantId, positions.tenantId),
            eq(requisitions.positionId, positions.id),
          ),
        )
        .where(eq(requisitions.id, input.requisitionId))
        .limit(1);
      if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });

      const rounds = await db
        .select()
        .from(interviewPlans)
        .where(eq(interviewPlans.requisitionId, input.requisitionId))
        .orderBy(interviewPlans.roundNumber);

      // Resolve default-panellist display names once (read-only surfacing).
      const allIds = Array.from(
        new Set(rounds.flatMap((r) => r.defaultPanelMembershipIds ?? [])),
      ).filter((id): id is string => !!id);
      const nameById =
        allIds.length > 0 && ctx.tenantId
          ? await resolveMembershipNames(ctx, ctx.tenantId, allIds)
          : new Map<string, string>();

      let totalDurationMinutes = 0;
      const shaped = rounds.map((r) => {
        totalDurationMinutes += r.durationMinutes ?? 0;
        return {
          roundNumber: r.roundNumber,
          roundName: r.roundName,
          durationMinutes: r.durationMinutes,
          mode: r.mode as "video" | "onsite" | "phone",
          scorecardTemplate: (r.scorecardTemplate ?? "general") as
            | "technical"
            | "manager"
            | "hr"
            | "general",
          defaultPanelists: (r.defaultPanelMembershipIds ?? [])
            .map((id) => nameById.get(id))
            .filter((n): n is string => !!n),
        };
      });

      return {
        requisitionId: input.requisitionId,
        title: req.title ?? null,
        status: req.status,
        rounds: shaped,
        totalDurationMinutes,
      };
    }),

  /**
   * getRequisitionInsights (/insights) — per-requisition analytics (or an "all
   * my reqs" rollup when requisitionId is null). Everything is a real,
   * deterministic query over the live pipeline / scorecards / curated
   * benchmarks. NO psychometric radar, NO offer-acceptance probability, NO
   * AI-recommendation block (deliberate refusals). Time-to-hire is a HISTORICAL
   * AVERAGE, never a prediction.
   */
  getRequisitionInsights: protectedProcedure
    .input(getRequisitionInsightsInputSchema)
    .output(getRequisitionInsightsOutputSchema)
    .query(async ({ ctx, input }): Promise<GetRequisitionInsightsOutput> => {
      requireAnyRole(ctx, HM_INSIGHTS_ROLES, "Insights is a hiring-manager surface.");
      const db = requireDb(ctx);
      return buildRequisitionInsights(db, ctx, input.requisitionId ?? null);
    }),

  // ═══════════ RECR-02 — recruiter candidates + AI shortlist ═══════════

  /**
   * listCandidatesByRequisition (/candidates) — the recruiter's "All candidates"
   * surface, grouped into one accordion per requisition. Read-only over the live
   * pipeline (applications × candidates × persons × requisitions × positions,
   * plus jd_skills for the must-have %). Tenant-scoped by RLS. Every derived
   * value is DETERMINISTIC:
   *   - AI Score is the REAL applications.ai_score (null → the UI says "unscored"
   *     honestly, reusing the AIScoreBadge honesty pattern).
   *   - Missing Info is a count + labels of absent REQUIRED profile fields,
   *     computed inline here (RECR-03 owns a dedicated missing-info lib; when it
   *     merges, swap this block for that lib — the candidateMissingInfoSchema
   *     shape is the seam).
   *   - must-have % is the share of the req's required skills the candidate lists.
   *   - phase is a coarse pipeline rollup over the group's application stages.
   * Same identity-masking as triage (HRHEAD-03 screeningPrivacy) applies per row.
   */
  listCandidatesByRequisition: protectedProcedure
    .input(listCandidatesByRequisitionInputSchema)
    .output(listCandidatesByRequisitionOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, RECRUITER_SURFACE_ROLES, "Candidates is a recruiter surface.");
      const db = requireDb(ctx);
      const search = input.search?.trim().toLowerCase() ?? "";

      const conds = [
        ...(input.stage ? [eq(applications.currentStage, input.stage)] : []),
        ...(input.source ? [eq(applications.source, input.source)] : []),
      ];

      const rows = await db
        .select({
          candidateId: candidates.id,
          applicationId: applications.id,
          requisitionId: applications.requisitionId,
          roleTitle: positions.title,
          jdVersionId: requisitions.jdVersionId,
          fullName: persons.fullName,
          email: persons.emailPrimary,
          phone: persons.phonePrimary,
          locationCountry: persons.locationCountry,
          locationCity: persons.locationCity,
          linkedinUrl: persons.linkedinUrl,
          resumeUrl: candidates.currentResumeUrl,
          parsedSkills: candidates.parsedSkills,
          yearsOfExperience: candidates.yearsOfExperience,
          expectedSalaryInrPaise: applications.expectedSalaryInrPaise,
          source: applications.source,
          stage: applications.currentStage,
          stageEnteredAt: applications.stageEnteredAt,
          aiScore: applications.aiScore,
          aiScoreExplanation: applications.aiScoreExplanation,
        })
        .from(applications)
        .innerJoin(
          candidates,
          and(
            eq(applications.candidateId, candidates.id),
            eq(applications.tenantId, candidates.tenantId),
          ),
        )
        .innerJoin(
          persons,
          and(eq(candidates.personId, persons.id), eq(candidates.tenantId, persons.tenantId)),
        )
        .innerJoin(
          requisitions,
          and(
            eq(applications.requisitionId, requisitions.id),
            eq(applications.tenantId, requisitions.tenantId),
          ),
        )
        .innerJoin(
          positions,
          and(
            eq(requisitions.positionId, positions.id),
            eq(requisitions.tenantId, positions.tenantId),
          ),
        )
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(applications.aiScore), desc(applications.createdAt));

      // Must-have skills per jd_version (one query, then a lookup map).
      const mustHaveByJd = await loadMustHaveSkillsByJdVersion(
        db,
        rows.map((r) => r.jdVersionId),
      );

      const privacy = ctx.tenantId
        ? await resolveTenantScreeningPrivacyDb(ctx.tenantId)
        : resolveScreeningPrivacy({});

      const groups = new Map<
        string,
        { requisitionId: string; roleTitle: string; stages: ApplicationStage[]; rows: unknown[] }
      >();

      for (const r of rows) {
        if (search) {
          const hay = `${r.fullName ?? ""} ${recruiterRefCode(r.candidateId)}`.toLowerCase();
          if (!hay.includes(search)) continue;
        }
        const parsed = narrowParsedSkills(r.parsedSkills);
        const mask = resolveCandidateMasking({ roles: ctx.roles, stage: r.stage, privacy });
        const noticePeriodDays = parsed.notice_period_days ?? null;
        const mustHavePct = computeMustHavePct(
          mustHaveByJd.get(r.jdVersionId) ?? [],
          parsed.skills,
        );
        const missingInfo = computeCandidateMissingInfo({
          phone: r.phone,
          location: r.locationCountry ?? r.locationCity,
          linkedinUrl: r.linkedinUrl,
          resumeUrl: r.resumeUrl,
          expectedSalaryInrPaise: r.expectedSalaryInrPaise,
          noticePeriodDays,
        });

        let g = groups.get(r.requisitionId);
        if (!g) {
          g = {
            requisitionId: r.requisitionId,
            roleTitle: r.roleTitle ?? "Untitled requisition",
            stages: [],
            rows: [],
          };
          groups.set(r.requisitionId, g);
        }
        g.stages.push(r.stage);
        g.rows.push({
          candidateId: r.candidateId,
          applicationId: r.applicationId,
          refCode: recruiterRefCode(r.candidateId),
          fullName: mask.maskName ? candidateMaskLabel(r.candidateId) : r.fullName,
          email: mask.maskContact ? null : r.email,
          source: r.source,
          stage: r.stage,
          stageEnteredAt: r.stageEnteredAt.toISOString(),
          aiScore: r.aiScore === null ? null : Number(r.aiScore),
          aiScoreExplanation: r.aiScoreExplanation,
          yearsOfExperience: r.yearsOfExperience === null ? null : Number(r.yearsOfExperience),
          noticePeriodDays,
          mustHavePct,
          missingInfo,
        });
      }

      const shapedGroups = [...groups.values()]
        .map((g) => ({
          requisitionId: g.requisitionId,
          roleTitle: g.roleTitle,
          phase: rollupRequisitionPhase(g.stages),
          candidateCount: g.rows.length,
          rows: g.rows,
        }))
        .filter((g) => g.candidateCount > 0)
        .sort((a, b) => b.candidateCount - a.candidateCount);

      return {
        groups: shapedGroups as never,
        totalCandidates: shapedGroups.reduce((sum, g) => sum + g.candidateCount, 0),
      };
    }),

  /**
   * listShortlist (/shortlist) — the AI Shortlist surface. A THRESHOLD control
   * over the REAL ai_score, three DETERMINISTIC match tiers (excellent 90+,
   * good 75–89, partial 60–74), and per-row Urgency (the deterministic
   * recruiter-urgency composite — NOT the prototype's fabricated "Heat Score")
   * + Risk (deterministic flags). Tier count cards summarise the full scored
   * pool; the table lists scored, non-terminal applications at/above the
   * threshold. Tenant-scoped by RLS.
   */
  listShortlist: protectedProcedure
    .input(listShortlistInputSchema)
    .output(listShortlistOutputSchema)
    .query(async ({ ctx, input }) => {
      requireAnyRole(ctx, RECRUITER_SURFACE_ROLES, "Shortlist is a recruiter surface.");
      const db = requireDb(ctx);

      const rows = await db
        .select({
          candidateId: candidates.id,
          applicationId: applications.id,
          jdVersionId: requisitions.jdVersionId,
          roleTitle: positions.title,
          compBandMax: positions.compBandMax,
          compCurrency: positions.compCurrency,
          fullName: persons.fullName,
          parsedSkills: candidates.parsedSkills,
          expectedSalaryInrPaise: applications.expectedSalaryInrPaise,
          source: applications.source,
          stage: applications.currentStage,
          stageEnteredAt: applications.stageEnteredAt,
          aiScore: applications.aiScore,
          aiScoreExplanation: applications.aiScoreExplanation,
        })
        .from(applications)
        .innerJoin(
          candidates,
          and(
            eq(applications.candidateId, candidates.id),
            eq(applications.tenantId, candidates.tenantId),
          ),
        )
        .innerJoin(
          persons,
          and(eq(candidates.personId, persons.id), eq(candidates.tenantId, persons.tenantId)),
        )
        .innerJoin(
          requisitions,
          and(
            eq(applications.requisitionId, requisitions.id),
            eq(applications.tenantId, requisitions.tenantId),
          ),
        )
        .innerJoin(
          positions,
          and(
            eq(requisitions.positionId, positions.id),
            eq(requisitions.tenantId, positions.tenantId),
          ),
        )
        .where(
          and(
            dsql`${applications.aiScore} IS NOT NULL`,
            dsql`${applications.currentStage} NOT IN ('offer_declined', 'withdrawn', 'recruiter_rejected')`,
          ),
        )
        .orderBy(desc(applications.aiScore));

      const mustHaveByJd = await loadMustHaveSkillsByJdVersion(
        db,
        rows.map((r) => r.jdVersionId),
      );

      const privacy = ctx.tenantId
        ? await resolveTenantScreeningPrivacyDb(ctx.tenantId)
        : resolveScreeningPrivacy({});

      const tierCounts = { excellent: 0, good: 0, partial: 0 };
      const shaped: unknown[] = [];

      for (const r of rows) {
        const score = Number(r.aiScore);
        const tier = matchTier(score);
        if (tier === "excellent") tierCounts.excellent += 1;
        else if (tier === "good") tierCounts.good += 1;
        else if (tier === "partial") tierCounts.partial += 1;
        // Below the partial floor never belongs on the shortlist.
        if (tier === null || tier === "below") continue;
        if (score < input.threshold) continue;

        const parsed = narrowParsedSkills(r.parsedSkills);
        const noticePeriodDays = parsed.notice_period_days ?? null;
        const mustHavePct = computeMustHavePct(
          mustHaveByJd.get(r.jdVersionId) ?? [],
          parsed.skills,
        );
        const hoursInStage = (Date.now() - r.stageEnteredAt.getTime()) / (60 * 60 * 1000);
        const urgency = computeRecruiterUrgency({
          slaState: slaStateFor(r.stage, hoursInStage),
          daysInStage: Math.floor(hoursInStage / 24),
          noticePeriodDays,
        });
        const riskFlags = computeRiskFlags({
          mustHavePct,
          expectedSalaryInrPaise: r.expectedSalaryInrPaise,
          compBandMaxInrPaise: compBandMaxToPaise(r.compBandMax, r.compCurrency),
        });
        const mask = resolveCandidateMasking({ roles: ctx.roles, stage: r.stage, privacy });

        shaped.push({
          candidateId: r.candidateId,
          applicationId: r.applicationId,
          fullName: mask.maskName ? candidateMaskLabel(r.candidateId) : r.fullName,
          source: r.source,
          roleTitle: r.roleTitle ?? "Untitled requisition",
          aiScore: score,
          aiScoreExplanation: r.aiScoreExplanation,
          tier: tier as MatchTier,
          mustHavePct,
          noticePeriodDays,
          stage: r.stage,
          urgencyIndex: urgency.index,
          urgencyRank: urgency.rank,
          riskFlags,
        });
      }

      return {
        threshold: input.threshold,
        tierCounts,
        rows: shaped as never,
      };
    }),

  // ═══════════ RECR-03 — recruiter AI brief drawer + Missing Info Tracker ═══════════

  /**
   * getRecruiterBrief (/candidate brief drawer) — everything the drawer renders
   * for ONE application. The candidate snapshot, the resume-vs-JD skills match
   * (DETERMINISTIC — reuses computeSkillsMatch, no AI), the gaps/missing-info
   * list (deterministic requiredness + real stage-gate), and the parsed resume
   * highlights are computed live. Any previously-generated AI aids are returned
   * from cache. `aiEnabled` mirrors the recruiter_brief kill-switch. Recruiter +
   * admin; PII-logged (reads name/location/parsed resume).
   */
  getRecruiterBrief: protectedProcedure
    .input(getRecruiterBriefInputSchema)
    .output(getRecruiterBriefOutputSchema)
    .query(async ({ ctx, input }): Promise<GetRecruiterBriefOutput> => {
      requireAnyRole(ctx, RECRUITER_SURFACE_ROLES, "The candidate brief is a recruiter surface.");
      return withAudit("get_recruiter_brief", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const loaded = await loadRecruiterBriefContext(db, input.applicationId);
        if (!loaded) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        const { row, skillsMatch } = loaded;

        const membershipId = await resolveActorMembership(db, ctx);
        recordPiiAccess({
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorMembershipId: membershipId,
          actorLabel: "user",
          entityType: "candidate",
          entityId: row.candidateId,
          fieldsAccessed: [
            "persons.full_name",
            "persons.location_country",
            "candidates.parsed_skills",
          ],
          reason: "get_recruiter_brief",
          requestId: ctx.requestId,
        });

        const parsed = narrowParsedResume(row.parsedSkills);
        const presence = computeFieldPresence({
          expectedSalaryInrPaise: row.expectedSalaryInrPaise,
          parsed,
          personLocationCountry: row.personLocationCountry,
        });
        const verdicts = computeMissingInfo(presence);

        const reqRows = await db
          .select({ fieldKey: missingInfoRequests.fieldKey, status: missingInfoRequests.status })
          .from(missingInfoRequests)
          .where(
            and(
              eq(missingInfoRequests.tenantId, ctx.tenantId),
              eq(missingInfoRequests.applicationId, input.applicationId),
            ),
          );
        const statusByField = new Map(reqRows.map((r) => [r.fieldKey, r.status]));
        const gaps: RecruiterBriefGap[] = verdicts.map((v) => ({
          fieldKey: v.fieldKey,
          fieldLabel: v.fieldLabel,
          requiredness: v.requiredness,
          status: ((statusByField.get(v.fieldKey) as MissingInfoStatus) ??
            "pending") as MissingInfoStatus,
          blocksAdvanceLabel: v.blocksAdvanceLabel,
        }));

        const aiSettings = await resolveTenantAiSettingsDb(ctx.tenantId);
        const briefRows = await db
          .select()
          .from(recruiterBrief)
          .where(
            and(
              eq(recruiterBrief.tenantId, ctx.tenantId),
              eq(recruiterBrief.applicationId, input.applicationId),
            ),
          );
        const briefs: RecruiterBriefCard[] = [];
        for (const b of briefRows) {
          if (!isRecruiterBriefKind(b.kind)) continue;
          const content = parseRecruiterBriefContent(b.kind, b.content);
          if (!content) continue;
          briefs.push({
            kind: b.kind,
            content,
            model: b.model,
            promptVersion: b.promptVersion,
            generatedAt: toIsoString(b.updatedAt),
          });
        }

        return {
          snapshot: {
            candidateId: row.candidateId,
            applicationId: row.applicationId,
            name: row.candidateName ?? "(no name)",
            roleTitle: row.positionTitle,
            contextLabel: STAGE_LABELS[row.currentStage] ?? row.currentStage.replace(/_/g, " "),
            aiScore: row.aiScore,
            mustHavePct: mustHaveCoveragePct(skillsMatch),
            source: row.source,
          },
          skillsMatch,
          gaps,
          resumeHighlights: extractResumeHighlights(parsed),
          briefs,
          aiEnabled: aiSettings.recruiter_brief.enabled,
        };
      });
    }),

  /**
   * generateRecruiterBrief — the ONE real AI call per click. Builds a grounded
   * prompt (JD + skills, deterministic skills-match, parsed resume, application
   * data) for ONE of three kinds, calls Claude via completeStructured (feature
   * recruiter_brief, cost-logged), re-parses, and upserts the cache (regenerate
   * replaces). The availability_draft is a DRAFT — it is cached + returned but
   * NEVER auto-sent; sending routes through the normal approval path. Honours
   * the recruiter_brief kill-switch. Recruiter + admin, audited.
   */
  generateRecruiterBrief: protectedProcedure
    .input(generateRecruiterBriefInputSchema)
    .output(generateRecruiterBriefOutputSchema)
    .mutation(async ({ ctx, input }): Promise<GenerateRecruiterBriefOutput> => {
      return withAudit("generate_recruiter_brief", ctx, input, async () => {
        requireAnyRole(ctx, RECRUITER_SURFACE_ROLES, "The candidate brief is a recruiter surface.");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No membership for this actor." });
        }

        const loaded = await loadRecruiterBriefContext(db, input.applicationId);
        if (!loaded) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
        const { row, jdSkills, skillsMatch } = loaded;

        const aiSettings = await resolveTenantAiSettingsDb(tenantId);
        const settings = aiSettings.recruiter_brief;
        if (!settings.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "The recruiter AI brief is disabled for this tenant. An admin can re-enable it in Admin → AI settings.",
          });
        }

        const parsed = narrowParsedResume(row.parsedSkills);
        const highlights = extractResumeHighlights(parsed);
        const { system, user } = buildRecruiterBriefPrompt(input.kind, {
          candidateName: row.candidateName,
          roleTitle: row.positionTitle,
          stageLabel: STAGE_LABELS[row.currentStage] ?? row.currentStage.replace(/_/g, " "),
          jdText: row.jdText,
          skills: jdSkills,
          parsedResumeSkills: asStringArray(parsed.skills),
          yearsOfExperience: row.yearsOfExperience,
          resumeHighlights: [...highlights.keyProjects, ...highlights.achievements],
          coveragePct: skillsMatch.coveragePct,
          companyName: row.companyName,
        });

        const client = await getAIClient(tenantId);
        const raw = await client.completeStructured<unknown>({
          prompt: user,
          system,
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          schema: recruiterBriefJsonSchema[input.kind],
          schemaName: RECRUITER_BRIEF_SCHEMA_NAME[input.kind],
          feature: RECRUITER_BRIEF_FEATURE,
          requestId: ctx.requestId,
          actorMembershipId: membershipId,
        });
        // Trust-but-verify — re-parse against the kind's strict schema.
        const content: RecruiterBriefContent =
          input.kind === "strengths_risks"
            ? (strengthsRisksAiSchema.parse(raw) as StrengthsRisksAi)
            : input.kind === "screen_script"
              ? (screenScriptAiSchema.parse(raw) as ScreenScriptAi)
              : (availabilityDraftAiSchema.parse(raw) as AvailabilityDraftAi);

        const now = new Date();
        await db
          .insert(recruiterBrief)
          .values({
            tenantId,
            applicationId: input.applicationId,
            kind: input.kind,
            content,
            model: client.provider,
            promptVersion: RECRUITER_BRIEF_PROMPT_VERSION,
            generatedByMembershipId: membershipId,
          })
          .onConflictDoUpdate({
            target: [recruiterBrief.tenantId, recruiterBrief.applicationId, recruiterBrief.kind],
            set: {
              content,
              model: client.provider,
              promptVersion: RECRUITER_BRIEF_PROMPT_VERSION,
              generatedByMembershipId: membershipId,
              updatedAt: now,
            },
          });

        return {
          brief: {
            kind: input.kind,
            content,
            model: client.provider,
            promptVersion: RECRUITER_BRIEF_PROMPT_VERSION,
            generatedAt: now.toISOString(),
          },
        };
      });
    }),

  /**
   * listMissingInfo (/missing-info) — the Missing Info Tracker. For every
   * in-flight application, DETERMINISTICALLY classifies each tracked field as
   * present or missing (apps/api/src/lib/missing-info.ts), joins the four-state
   * lifecycle from missing_info_requests, and returns the stat cards + table
   * rows. "Required vs Optional" and "Blocks Advance to <stage>" are pure rule
   * outputs — there is NO score-impact / cap column. Recruiter + admin.
   */
  listMissingInfo: protectedProcedure
    .input(listMissingInfoInputSchema)
    .output(listMissingInfoOutputSchema)
    .query(async ({ ctx, input }): Promise<ListMissingInfoOutput> => {
      requireAnyRole(ctx, RECRUITER_SURFACE_ROLES, "Missing Info is a recruiter surface.");
      return withAudit("list_missing_info", ctx, input, async () => {
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;

        // In-flight applications only (terminal stages carry no live chase).
        const appRows = await db
          .select({
            applicationId: applications.id,
            candidateId: candidates.id,
            candidateName: persons.fullName,
            currentStage: applications.currentStage,
            expectedSalaryInrPaise: applications.expectedSalaryInrPaise,
            personLocationCountry: persons.locationCountry,
            parsedSkills: candidates.parsedSkills,
            positionTitle: positions.title,
          })
          .from(applications)
          .innerJoin(candidates, eq(candidates.id, applications.candidateId))
          .innerJoin(persons, eq(persons.id, candidates.personId))
          .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
          .innerJoin(positions, eq(positions.id, requisitions.positionId))
          .where(eq(applications.tenantId, tenantId))
          .limit(500);

        const requestRows = await db
          .select({
            applicationId: missingInfoRequests.applicationId,
            fieldKey: missingInfoRequests.fieldKey,
            status: missingInfoRequests.status,
            lastContactAt: missingInfoRequests.lastContactAt,
            requestId: missingInfoRequests.id,
          })
          .from(missingInfoRequests)
          .where(eq(missingInfoRequests.tenantId, tenantId));
        const requestByKey = new Map(
          requestRows.map((r) => [`${r.applicationId}::${r.fieldKey}`, r]),
        );

        const rows: MissingInfoRow[] = [];
        for (const a of appRows) {
          if (TERMINAL_APP_STAGES.has(a.currentStage)) continue;
          const parsed = narrowParsedResume(a.parsedSkills);
          const presence = computeFieldPresence({
            expectedSalaryInrPaise: a.expectedSalaryInrPaise,
            parsed,
            personLocationCountry: a.personLocationCountry,
          });
          const verdicts = computeMissingInfo(presence);
          const candidateRef = `RC-${a.candidateId.slice(0, 6).toUpperCase()}`;

          // Union: currently-missing fields (pending unless a row upgrades them)
          // + any existing request rows (persist through received/verified).
          const seen = new Set<string>();
          const emit = (fieldKey: MissingInfoFieldKey) => {
            if (seen.has(fieldKey)) return;
            seen.add(fieldKey);
            const def = missingInfoFieldDef(fieldKey);
            if (!def) return;
            const req = requestByKey.get(`${a.applicationId}::${fieldKey}`);
            const status = (req?.status as MissingInfoStatus) ?? "pending";
            rows.push({
              applicationId: a.applicationId,
              candidateId: a.candidateId,
              candidateName: a.candidateName ?? "(no name)",
              candidateRef,
              roleTitle: a.positionTitle,
              fieldKey,
              fieldLabel: def.label,
              requiredness: def.requiredness,
              status,
              lastContactAt: req?.lastContactAt ? toIsoString(req.lastContactAt) : null,
              blocksAdvanceStage: def.blocksAdvanceStage,
              blocksAdvanceLabel: blocksAdvanceLabelFor(fieldKey),
              requestId: req?.requestId ?? null,
            });
          };
          for (const v of verdicts) emit(v.fieldKey);
          for (const r of requestRows) {
            if (r.applicationId !== a.applicationId) continue;
            if (isMissingInfoFieldKey(r.fieldKey)) emit(r.fieldKey);
          }
        }

        // Filters.
        let filtered = rows;
        if (input.status) filtered = filtered.filter((r) => r.status === input.status);
        if (input.fieldKey) filtered = filtered.filter((r) => r.fieldKey === input.fieldKey);
        if (input.search && input.search.trim().length > 0) {
          const q = input.search.trim().toLowerCase();
          filtered = filtered.filter(
            (r) =>
              r.candidateName.toLowerCase().includes(q) ||
              r.roleTitle.toLowerCase().includes(q) ||
              (r.candidateRef ?? "").toLowerCase().includes(q),
          );
        }

        // Stats over the UNFILTERED set (the four honest cards; dismissed excluded).
        const stats = { pending: 0, requested: 0, received: 0, verified: 0 };
        for (const r of rows) {
          if (r.status === "pending") stats.pending += 1;
          else if (r.status === "requested") stats.requested += 1;
          else if (r.status === "received") stats.received += 1;
          else if (r.status === "verified") stats.verified += 1;
        }

        return { stats, rows: filtered };
      });
    }),

  /**
   * requestMissingInfo — the recruiter chases ONE missing field. Upserts the
   * missing_info_requests row to 'requested' (re-request re-stamps last_contact)
   * and enqueues a REAL candidate notification (candidate.agent_message, a
   * deterministic templated ask — NOT AI-generated). Notification failure never
   * rolls back the request row. Recruiter + admin, audited.
   */
  requestMissingInfo: protectedProcedure
    .input(requestMissingInfoInputSchema)
    .output(requestMissingInfoOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("request_missing_info", ctx, input, async () => {
        requireAnyRole(ctx, RECRUITER_SURFACE_ROLES, "Missing Info is a recruiter surface.");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        if (!isMissingInfoFieldKey(input.fieldKey)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown missing-info field." });
        }
        const def = missingInfoFieldDef(input.fieldKey);
        if (!def)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown missing-info field." });

        const [app] = await db
          .select({ id: applications.id })
          .from(applications)
          .where(and(eq(applications.tenantId, tenantId), eq(applications.id, input.applicationId)))
          .limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No membership for this actor." });
        }

        // Real candidate notification — a deterministic, human-initiated ask
        // (NOT AI-drafted, so no approval gate needed; same directness as the
        // stage-advance / interview-invite emails). Wrapped so a notify failure
        // never blocks recording the chase.
        let notificationOutboxId: string | null = null;
        const meta = await fetchTransitionEmailContext(db, input.applicationId);
        if (meta) {
          try {
            const subject = `Quick info needed for your ${meta.positionTitle} application`;
            const body =
              `Hi ${meta.candidateName},\n\n` +
              `To keep your application for ${meta.positionTitle} at ${meta.companyName} moving, ` +
              `could you please confirm your ${def.label.toLowerCase()}?\n\n` +
              `Just reply to this email and we'll update your file.\n\n` +
              `Thanks,\nThe ${meta.companyName} Recruitment Team`;
            const { outboxId } = await enqueueNotification(db, {
              tenantId,
              recipientType: "candidate",
              recipientEmail: meta.candidateEmail,
              recipientCandidateId: meta.candidateId,
              templateKey: "candidate.agent_message",
              templateData: {
                candidateName: meta.candidateName,
                companyName: meta.companyName,
                positionTitle: meta.positionTitle,
                body,
                subject,
              },
              subject,
              dedupKey: `missing_info:${input.applicationId}:${input.fieldKey}:${Date.now()}`,
            });
            notificationOutboxId = outboxId;
          } catch (err) {
            ctx.log.warn(
              { err, request_id: ctx.requestId, application_id: input.applicationId },
              "requestMissingInfo: enqueueNotification failed",
            );
          }
        }

        const now = new Date();
        const [saved] = await db
          .insert(missingInfoRequests)
          .values({
            tenantId,
            applicationId: input.applicationId,
            fieldKey: input.fieldKey,
            status: "requested",
            requestedByMembershipId: membershipId,
            notificationOutboxId,
            requestedAt: now,
            lastContactAt: now,
          })
          .onConflictDoUpdate({
            target: [
              missingInfoRequests.tenantId,
              missingInfoRequests.applicationId,
              missingInfoRequests.fieldKey,
            ],
            set: {
              status: "requested",
              lastContactAt: now,
              notificationOutboxId,
              updatedAt: now,
            },
          })
          .returning({ id: missingInfoRequests.id, status: missingInfoRequests.status });
        if (!saved) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "missing_info_requests upsert returned no row",
          });
        }

        return {
          requestId: saved.id,
          status: saved.status as MissingInfoStatus,
          notified: notificationOutboxId != null,
        };
      });
    }),

  /**
   * resolveMissingInfo — move a chased field along its lifecycle: 'received'
   * (candidate replied), 'verified' (recruiter confirmed), or 'dismissed' (the
   * honest "N/A" — this field does not apply to this candidate). Upserts so a
   * recruiter can mark a still-pending field directly. Recruiter + admin.
   */
  resolveMissingInfo: protectedProcedure
    .input(resolveMissingInfoInputSchema)
    .output(resolveMissingInfoOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("resolve_missing_info", ctx, input, async () => {
        requireAnyRole(ctx, RECRUITER_SURFACE_ROLES, "Missing Info is a recruiter surface.");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        if (!isMissingInfoFieldKey(input.fieldKey)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown missing-info field." });
        }

        const [app] = await db
          .select({ id: applications.id })
          .from(applications)
          .where(and(eq(applications.tenantId, tenantId), eq(applications.id, input.applicationId)))
          .limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

        const membershipId = await resolveActorMembership(db, ctx);
        if (!membershipId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "No membership for this actor." });
        }

        const now = new Date();
        const receivedAt = input.action === "received" ? now : null;
        const verifiedAt = input.action === "verified" ? now : null;
        const [saved] = await db
          .insert(missingInfoRequests)
          .values({
            tenantId,
            applicationId: input.applicationId,
            fieldKey: input.fieldKey,
            status: input.action,
            requestedByMembershipId: membershipId,
            resolvedByMembershipId: membershipId,
            requestedAt: now,
            receivedAt,
            verifiedAt,
          })
          .onConflictDoUpdate({
            target: [
              missingInfoRequests.tenantId,
              missingInfoRequests.applicationId,
              missingInfoRequests.fieldKey,
            ],
            set: {
              status: input.action,
              resolvedByMembershipId: membershipId,
              ...(input.action === "received" ? { receivedAt: now } : {}),
              ...(input.action === "verified" ? { verifiedAt: now } : {}),
              updatedAt: now,
            },
          })
          .returning({ id: missingInfoRequests.id, status: missingInfoRequests.status });
        if (!saved) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "missing_info_requests resolve returned no row",
          });
        }

        return { requestId: saved.id, status: saved.status as MissingInfoStatus };
      });
    }),

  // ═══════════ T1.1 / G04 — sourcing-channel registry ═══════════
  //
  // The tenant's editable CONFIG over the fixed `application_source` enum:
  // which channels are enabled, what the org calls them (labels flow through
  // to the recruiter source surfaces), and an honest `ingestionMode` flag —
  // configuring a channel is NOT connecting an auto-pull; connectors are a
  // deferred work package. See packages/db/src/schema/tenant-application-sources.ts.

  /**
   * listTenantSources — the full registry for the tenant (enabled + disabled),
   * ordered by label. recruiter + admin read (the recruiter surfaces render
   * the labels; the admin surface manages the rows). RLS scopes to the tenant.
   */
  listTenantSources: protectedProcedure
    .input(listTenantSourcesInputSchema)
    .output(listTenantSourcesOutputSchema)
    .query(async ({ ctx }) => {
      requireAnyRole(
        ctx,
        TENANT_SOURCE_READ_ROLES,
        "The sourcing-channel registry requires the recruiter or admin role",
      );
      const db = requireDb(ctx);
      if (!ctx.tenantId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
      }
      const rows = await db
        .select()
        .from(tenantApplicationSources)
        .where(eq(tenantApplicationSources.tenantId, ctx.tenantId))
        .orderBy(tenantApplicationSources.label);
      return { rows: rows.map(tenantSourceRowToApi) };
    }),

  /**
   * upsertTenantSource — admin-only, audited declare/edit of one channel,
   * keyed by (tenant, sourceEnum). Enable/disable, relabel, set the honesty
   * mode + notes + config blob. Uses the tenant-scoped client (the table's
   * tenant_isolation policy is FOR ALL); the audit trigger + withAudit record it.
   */
  upsertTenantSource: protectedProcedure
    .input(upsertTenantSourceInputSchema)
    .output(upsertTenantSourceOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("upsert_tenant_source", ctx, input, async () => {
        requireAnyRole(ctx, TENANT_SOURCE_ADMIN_ROLES, "Editing sourcing channels is admin-only");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const tenantId = ctx.tenantId;
        const [row] = await db
          .insert(tenantApplicationSources)
          .values({
            tenantId,
            sourceEnum: input.sourceEnum,
            label: input.label,
            enabled: input.enabled,
            ingestionMode: input.ingestionMode,
            config: input.config,
            notes: input.notes,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [tenantApplicationSources.tenantId, tenantApplicationSources.sourceEnum],
            set: {
              label: input.label,
              enabled: input.enabled,
              ingestionMode: input.ingestionMode,
              config: input.config,
              notes: input.notes,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!row) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "tenant source upsert returned no row",
          });
        }
        return { row: tenantSourceRowToApi(row) };
      });
    }),

  /**
   * setTenantSourceEnabled — admin-only, audited enable/disable toggle for one
   * registry row (by id). Tenant-scoped by RLS; NOT_FOUND if the row is not the
   * caller's tenant's.
   */
  setTenantSourceEnabled: protectedProcedure
    .input(setTenantSourceEnabledInputSchema)
    .output(setTenantSourceEnabledOutputSchema)
    .mutation(async ({ ctx, input }) => {
      return withAudit("set_tenant_source_enabled", ctx, input, async () => {
        requireAnyRole(ctx, TENANT_SOURCE_ADMIN_ROLES, "Editing sourcing channels is admin-only");
        const db = requireDb(ctx);
        if (!ctx.tenantId) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "missing tenantId" });
        }
        const [row] = await db
          .update(tenantApplicationSources)
          .set({ enabled: input.enabled, updatedAt: new Date() })
          .where(eq(tenantApplicationSources.id, input.id))
          .returning();
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "sourcing channel not found" });
        }
        return { row: tenantSourceRowToApi(row) };
      });
    }),
});

// ═══════════ RECR-02 — recruiter surface helpers ═══════════
//
// Small, pure-ish (DB-reading where noted) helpers for the candidates +
// shortlist procedures. The DETERMINISTIC verdict logic (urgency, tiers,
// must-have %, risk) lives in lib/recruiter-urgency.ts; these adapt live rows
// to that engine and compute the presentation-only bits (ref codes, phase
// rollup, missing-info) — the latter READ-ONLY until RECR-03's missing-info
// lib merges (candidateMissingInfoSchema is the seam).

// RECRUITER_SURFACE_ROLES is declared once, module-level, above appRouter
// (shared by the RECR-02 candidates/shortlist and RECR-03 brief/missing-info
// procedures — merge-dedup of two identical declarations).

/** Short, stable, human-readable candidate code from the uuid — a DISPLAY id
 * (first 6 hex of the real id), not fabricated data. */
function recruiterRefCode(candidateId: string): string {
  return `C-${candidateId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

interface NarrowedParsedSkills {
  skills: string[];
  notice_period_days: number | null;
}

/** parsed_skills is opaque jsonb; narrow the two fields the recruiter surfaces
 * read. notice_period_days is real seeded data (demo parser output). */
function narrowParsedSkills(value: unknown): NarrowedParsedSkills {
  if (!value || typeof value !== "object") return { skills: [], notice_period_days: null };
  const v = value as { skills?: unknown; notice_period_days?: unknown };
  const skills = Array.isArray(v.skills)
    ? v.skills.filter((s): s is string => typeof s === "string")
    : [];
  const notice =
    typeof v.notice_period_days === "number" && Number.isFinite(v.notice_period_days)
      ? v.notice_period_days
      : null;
  return { skills, notice_period_days: notice };
}

/** Load each jd_version's MUST-HAVE (required) skill names, keyed by version. */
async function loadMustHaveSkillsByJdVersion(
  db: TenantBoundDb,
  jdVersionIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(jdVersionIds)];
  if (ids.length === 0) return out;
  const rows = await db
    .select({ jdVersionId: jdSkills.jdVersionId, skillName: jdSkills.skillName })
    .from(jdSkills)
    .where(and(inArray(jdSkills.jdVersionId, ids), eq(jdSkills.isRequired, true)));
  for (const r of rows) {
    const list = out.get(r.jdVersionId) ?? [];
    list.push(r.skillName);
    out.set(r.jdVersionId, list);
  }
  return out;
}

/**
 * DETERMINISTIC missing-info summary — count + labels of REQUIRED profile
 * fields that are absent. Labels are drawn ONLY from fields we actually store;
 * there is deliberately no "work authorization" line because there is no column
 * for it (no fabrication). RECR-03 owns the shared lib; when it merges, replace
 * this body and keep the candidateMissingInfoSchema shape.
 */
function computeCandidateMissingInfo(input: {
  phone: string | null;
  location: string | null;
  linkedinUrl: string | null;
  resumeUrl: string | null;
  expectedSalaryInrPaise: bigint | null;
  noticePeriodDays: number | null;
}): { count: number; fields: string[] } {
  const fields: string[] = [];
  if (!input.phone) fields.push("Phone");
  if (!input.location) fields.push("Location");
  if (!input.resumeUrl) fields.push("Résumé");
  if (!input.linkedinUrl) fields.push("Portfolio");
  if (input.expectedSalaryInrPaise == null) fields.push("Salary expectation");
  if (input.noticePeriodDays == null) fields.push("Notice period");
  return { count: fields.length, fields };
}

/** Coarse pipeline phase for a requisition, rolled up from its applications'
 * stages (most-advanced wins). Deterministic; not a stored field. */
function rollupRequisitionPhase(
  stages: ApplicationStage[],
): "sourcing" | "screening" | "interviewing" | "offer" | "closed" {
  const has = (s: ApplicationStage) => stages.includes(s);
  if (has("offer_drafted") || has("offer_accepted")) return "offer";
  if (has("tech_interview") || has("hr_round")) return "interviewing";
  if (has("ai_screening") || has("recruiter_review") || has("shortlisted")) return "screening";
  if (has("application_received")) return "sourcing";
  return "closed";
}

/** Resolve the SLA state for the urgency engine from live hours-in-stage vs the
 * stage's SLA threshold. "at_risk" is the last quarter before breach. */
function slaStateFor(stage: ApplicationStage, hoursInStage: number): UrgencySlaState {
  const threshold = (SLA_THRESHOLDS_HOURS as Record<string, number | null>)[stage];
  if (threshold == null) return "none";
  if (hoursInStage > threshold) return "breached";
  if (hoursInStage > threshold * 0.75) return "at_risk";
  return "ok";
}

/** Convert a position comp-band ceiling (MAJOR units, its own currency) to INR
 * paise for the risk salary-gap check. Returns null when no band is set or the
 * band is in a non-INR currency (we do not cross-convert — INR here always). */
function compBandMaxToPaise(
  compBandMax: string | null,
  compCurrency: string | null,
): bigint | null {
  if (compBandMax == null) return null;
  if (compCurrency != null && compCurrency.toUpperCase() !== "INR") return null;
  const rupees = Number(compBandMax);
  if (!Number.isFinite(rupees)) return null;
  return BigInt(Math.round(rupees * 100));
}

// ═══════════ DASH-01 — persona-dashboard builders ═══════════
//
// Each builder returns the KPI tiles + recommended actions for one persona,
// computed from real table counts (tenant-scoped, explicit filters). db.execute
// runs under the caller's RLS-scoped tx (protectedProcedure), so every row is
// already tenant-isolated; the explicit `tenant_id = …::uuid` predicate is
// defence-in-depth + matches the getAiUsageSummary idiom. No AI, no writes.

type DashDb = NonNullable<HonoTRPCContext["db"]>;

/** Read a single scalar (count or a bigint-as-text sum) off a raw query. */
async function dashScalar(db: DashDb, query: SQL): Promise<number> {
  const res = await db.execute(query);
  const rows =
    (res as unknown as { rows?: { n: number | string }[] }).rows ??
    (res as unknown as { n: number | string }[]);
  const n = rows[0]?.n;
  return typeof n === "string" ? Number(n) : (n ?? 0);
}

/** Read a small set of rows off a raw query. */
async function dashRows<T>(db: DashDb, query: SQL): Promise<T[]> {
  const res = await db.execute(query);
  return (res as unknown as { rows?: T[] }).rows ?? (res as unknown as T[]);
}

/** "tech_interview" → "Tech Interview". */
function humanizeStage(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatUsdMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** Whole-days elapsed since an ISO/Date instant (floored, never negative). */
function daysSince(at: Date | string | null): number {
  if (!at) return 0;
  const then = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/** The SLA-breach predicate (bare columns) for a raw SELECT on applications —
 * the same CASE the triage listCandidates query composes, reused here. */
function slaBreachSql(): SQL {
  const clauses = (Object.entries(SLA_THRESHOLDS_HOURS) as [ApplicationStage, number | null][])
    .filter(([, h]) => h !== null)
    .map(
      ([stage, h]) =>
        dsql`WHEN current_stage = ${stage} THEN extract(epoch FROM (now() - stage_entered_at)) / 3600.0 > ${h}`,
    );
  return dsql`(CASE ${dsql.join(clauses, dsql.raw(" "))} ELSE false END)`;
}

interface DashSection {
  kpis: DashboardKpi[];
  actions: DashboardAction[];
}

async function hiringManagerSection(
  db: DashDb,
  tenantId: string,
  membershipId: string | null,
): Promise<DashSection> {
  if (!membershipId) return { kpis: [], actions: [] };
  const mine = dsql`tenant_id = ${tenantId}::uuid AND hiring_manager_id = ${membershipId}::uuid`;
  const [total, awaiting, sentBack, drafts] = await Promise.all([
    dashScalar(db, dsql`SELECT count(*)::int AS n FROM public.requisitions WHERE ${mine}`),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.requisitions WHERE ${mine} AND status = 'pending_approval'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.requisitions r WHERE r.tenant_id = ${tenantId}::uuid
             AND r.hiring_manager_id = ${membershipId}::uuid AND r.status = 'draft'
             AND EXISTS (SELECT 1 FROM public.requisition_state_transitions t
               WHERE t.tenant_id = r.tenant_id AND t.requisition_id = r.id
                 AND t.from_status = 'pending_approval' AND t.to_status = 'draft')`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.requisitions r WHERE r.tenant_id = ${tenantId}::uuid
             AND r.hiring_manager_id = ${membershipId}::uuid AND r.status = 'draft'
             AND (EXISTS (SELECT 1 FROM public.jd_versions j WHERE j.tenant_id = r.tenant_id
                    AND j.id = r.jd_version_id AND j.jd_text = ${JD_DRAFT_PLACEHOLDER})
                  OR NOT EXISTS (SELECT 1 FROM public.jd_skills s WHERE s.tenant_id = r.tenant_id
                    AND s.jd_version_id = r.jd_version_id))`,
    ),
  ]);
  const kpis: DashboardKpi[] = [
    {
      key: "hm_my_reqs",
      label: "My requisitions",
      value: total,
      hint: "all statuses",
      tone: "accent",
      href: "/requisitions",
    },
    {
      key: "hm_awaiting",
      label: "Awaiting approval",
      value: awaiting,
      hint: awaiting ? "with HR" : "none pending",
      tone: awaiting ? "info" : "neutral",
      href: "/requisitions",
    },
    {
      key: "hm_sent_back",
      label: "Sent back",
      value: sentBack,
      hint: sentBack ? "need revision" : "none",
      tone: sentBack ? "warning" : "neutral",
      href: "/requisitions",
    },
    {
      key: "hm_drafts",
      label: "Drafts to finish",
      value: drafts,
      hint: drafts ? "missing JD or skills" : "none",
      tone: drafts ? "warning" : "neutral",
      href: "/requisitions",
    },
  ];

  const actions: DashboardAction[] = [];
  const rows = await dashRows<{
    id: string;
    title: string | null;
    sent_back: boolean;
    incomplete: boolean;
  }>(
    db,
    dsql`SELECT r.id::text AS id, p.title AS title,
           EXISTS (SELECT 1 FROM public.requisition_state_transitions t
             WHERE t.tenant_id = r.tenant_id AND t.requisition_id = r.id
               AND t.from_status = 'pending_approval' AND t.to_status = 'draft') AS sent_back,
           (EXISTS (SELECT 1 FROM public.jd_versions j WHERE j.tenant_id = r.tenant_id
                AND j.id = r.jd_version_id AND j.jd_text = ${JD_DRAFT_PLACEHOLDER})
             OR NOT EXISTS (SELECT 1 FROM public.jd_skills s WHERE s.tenant_id = r.tenant_id
                AND s.jd_version_id = r.jd_version_id)) AS incomplete
         FROM public.requisitions r
         LEFT JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
         WHERE r.tenant_id = ${tenantId}::uuid AND r.hiring_manager_id = ${membershipId}::uuid
           AND r.status = 'draft'
         ORDER BY r.updated_at DESC
         LIMIT 5`,
  );
  for (const r of rows) {
    const title = r.title ?? "Untitled requisition";
    if (r.sent_back) {
      actions.push({
        key: `hm_resubmit_${r.id}`,
        label: `Revise & resubmit ${title}`,
        detail: "Sent back by HR for changes",
        href: `/requisitions/${r.id}`,
        urgency: "attention",
      });
    } else if (r.incomplete) {
      actions.push({
        key: `hm_finish_${r.id}`,
        label: `Finish draft: ${title}`,
        detail: "Add a JD and required skills, then submit",
        href: `/requisitions/${r.id}`,
        urgency: "normal",
      });
    }
  }
  return { kpis, actions };
}

async function hrHeadSection(db: DashDb, tenantId: string): Promise<DashSection> {
  const reqApproval = dsql`tenant_id = ${tenantId}::uuid AND subject_type = 'requisition'`;
  const [pending, flagged, decidedWeek, postedMonth] = await Promise.all([
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.approval_requests WHERE ${reqApproval} AND status = 'pending'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.approval_requests WHERE ${reqApproval} AND status = 'pending' AND context -> 'bias_scan' IS NOT NULL`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.approval_requests WHERE ${reqApproval} AND decided_at >= now() - interval '7 days'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.requisitions WHERE tenant_id = ${tenantId}::uuid AND status = 'posted' AND posted_at >= date_trunc('month', now())`,
    ),
  ]);
  const kpis: DashboardKpi[] = [
    {
      key: "hrh_pending",
      label: "Pending approvals",
      value: pending,
      hint: pending ? "awaiting your decision" : "queue clear",
      tone: pending ? "accent" : "neutral",
      href: "/requisition-approvals",
    },
    {
      key: "hrh_flagged",
      label: "Bias-flagged",
      value: flagged,
      hint: flagged ? "review wording" : "none flagged",
      tone: flagged ? "warning" : "neutral",
      href: "/requisition-approvals",
    },
    {
      key: "hrh_decided",
      label: "Decided this week",
      value: decidedWeek,
      hint: "last 7 days",
      tone: "info",
      href: "/requisition-approvals",
    },
    {
      key: "hrh_posted",
      label: "Posted this month",
      value: postedMonth,
      hint: "went live",
      tone: "positive",
      href: "/requisitions",
    },
  ];

  const actions: DashboardAction[] = [];
  const rows = await dashRows<{
    id: string;
    title: string | null;
    requested_at: string | Date;
    bias: boolean;
  }>(
    db,
    dsql`SELECT ar.id::text AS id, p.title AS title, ar.requested_at AS requested_at,
           (ar.context -> 'bias_scan' IS NOT NULL) AS bias
         FROM public.approval_requests ar
         LEFT JOIN public.requisitions r ON r.tenant_id = ar.tenant_id AND r.id = ar.subject_id
         LEFT JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
         WHERE ar.tenant_id = ${tenantId}::uuid AND ar.subject_type = 'requisition' AND ar.status = 'pending'
         ORDER BY ar.requested_at ASC
         LIMIT 5`,
  );
  for (const r of rows) {
    const age = daysSince(r.requested_at);
    const title = r.title ?? "a requisition";
    const detailBits = [age > 0 ? `waiting ${age}d` : "just submitted"];
    if (r.bias) detailBits.push("bias flags");
    actions.push({
      key: `hrh_decide_${r.id}`,
      label: `Decide approval: ${title}`,
      detail: detailBits.join(" · "),
      href: "/requisition-approvals",
      urgency: age > 2 ? "urgent" : "attention",
    });
  }
  return { kpis, actions };
}

async function recruiterSection(db: DashDb, tenantId: string): Promise<DashSection> {
  const T = dsql`tenant_id = ${tenantId}::uuid`;
  const breach = slaBreachSql();
  const [newTriage, breaches, toSchedule, toComplete, offers, agentApprovals] = await Promise.all([
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications WHERE ${T} AND current_stage = 'application_received'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications WHERE ${T} AND ${breach}`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications a WHERE a.tenant_id = ${tenantId}::uuid
             AND a.current_stage IN ('shortlisted', 'tech_interview', 'hr_round')
             AND NOT EXISTS (SELECT 1 FROM public.interviews i WHERE i.tenant_id = a.tenant_id
               AND i.application_id = a.id AND i.status = 'scheduled')`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.interviews i WHERE i.tenant_id = ${tenantId}::uuid
             AND i.status = 'scheduled'
             AND EXISTS (SELECT 1 FROM public.interview_panelists p WHERE p.tenant_id = i.tenant_id AND p.interview_id = i.id)
             AND NOT EXISTS (SELECT 1 FROM public.interview_panelists p WHERE p.tenant_id = i.tenant_id AND p.interview_id = i.id
               AND NOT EXISTS (SELECT 1 FROM public.interview_feedback f WHERE f.tenant_id = i.tenant_id
                 AND f.interview_id = i.id AND f.membership_id = p.membership_id AND f.submitted_at IS NOT NULL))`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.offers WHERE ${T} AND status IN ('drafted', 'extended')`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.agent_approval_requests WHERE ${T} AND status = 'pending'`,
    ),
  ]);
  const kpis: DashboardKpi[] = [
    {
      key: "rec_new",
      label: "New in triage",
      value: newTriage,
      hint: newTriage ? "just applied" : "all triaged",
      tone: newTriage ? "accent" : "neutral",
      href: "/triage",
    },
    {
      key: "rec_sla",
      label: "SLA breaches",
      value: breaches,
      hint: breaches ? "overdue in stage" : "all on time",
      tone: breaches ? "error" : "positive",
      href: "/triage",
    },
    {
      key: "rec_schedule",
      label: "To schedule",
      value: toSchedule,
      hint: "interviews awaiting a slot",
      tone: toSchedule ? "warning" : "neutral",
      href: "/interviews",
    },
    {
      key: "rec_complete",
      label: "Ready to close",
      value: toComplete,
      hint: "all feedback in",
      tone: toComplete ? "info" : "neutral",
      href: "/interviews",
    },
    {
      key: "rec_offers",
      label: "Offers outstanding",
      value: offers,
      hint: "drafted or extended",
      tone: offers ? "info" : "neutral",
      href: "/triage",
    },
    {
      key: "rec_agents",
      label: "Agent approvals",
      value: agentApprovals,
      hint: agentApprovals ? "awaiting your review" : "none pending",
      tone: agentApprovals ? "accent" : "neutral",
      href: "/approvals",
    },
  ];
  const actions: DashboardAction[] = [];
  if (agentApprovals > 0)
    actions.push({
      key: "rec_a_agents",
      label: `Review ${agentApprovals} agent approval${agentApprovals === 1 ? "" : "s"}`,
      detail: "Drafted messages awaiting your sign-off",
      href: "/approvals",
      urgency: "attention",
    });
  if (breaches > 0)
    actions.push({
      key: "rec_a_sla",
      label: `Clear ${breaches} SLA breach${breaches === 1 ? "" : "es"}`,
      detail: "Candidates overdue in their stage",
      href: "/triage",
      urgency: "urgent",
    });
  if (toComplete > 0)
    actions.push({
      key: "rec_a_complete",
      label: `Close ${toComplete} interview${toComplete === 1 ? "" : "s"}`,
      detail: "All panel feedback is in",
      href: "/interviews",
      urgency: "attention",
    });
  if (toSchedule > 0)
    actions.push({
      key: "rec_a_schedule",
      label: `Schedule ${toSchedule} interview${toSchedule === 1 ? "" : "s"}`,
      detail: "Advanced candidates without a slot",
      href: "/interviews",
      urgency: "normal",
    });
  return { kpis, actions };
}

// ═══════════ RECR-01 — recruiter dashboard extras builder ═══════════
//
// A richer, recruiter-specific read layered on top of getMyDashboard's KPIs:
// a real stage-count pipeline funnel with conversion deltas, priority-tagged
// tasks derived from live signals, stalled-candidate follow-ups (Ping routes
// to the human-in-loop approvals surface, NEVER a send), computed AI insights
// (observations that link to the real SkillWeightsEditor — no auto-adjust
// magic), data-completeness %, and risk flags. All counts run under the
// caller's RLS-scoped tx with an explicit tenant predicate as defence-in-depth.
// EVERY number is a real count — no invented probability tile.

/** The recruiter funnel, mapped from OUR 11 canonical stages into the five
 * progression buckets the recruiter thinks in. Terminal negatives are excluded
 * — the funnel shows the live forward flow. This is deliberately OUR pipeline,
 * not the prototype's fictional Round 1 / Round 2 split we do not track. */
const RECRUITER_FUNNEL_BUCKETS: { key: string; label: string; stages: ApplicationStage[] }[] = [
  {
    key: "screening",
    label: "Screening",
    stages: ["application_received", "ai_screening", "recruiter_review"],
  },
  { key: "shortlisted", label: "Shortlisted", stages: ["shortlisted"] },
  { key: "tech_interview", label: "Tech interview", stages: ["tech_interview"] },
  { key: "hr_round", label: "HR round", stages: ["hr_round"] },
  { key: "offer", label: "Offer", stages: ["offer_drafted", "offer_accepted"] },
];

const RECRUITER_TERMINAL_STAGES = "('offer_declined', 'withdrawn', 'recruiter_rejected')";
/** Below this AI match score an in-flight candidate is flagged skill-mismatch. */
const RECRUITER_MISMATCH_SCORE = 60;
/** At/above this score a candidate counts as "strong" for the insights. */
const RECRUITER_STRONG_SCORE = 80;

async function buildRecruiterDashboardExtras(
  db: DashDb,
  tenantId: string,
): Promise<GetRecruiterDashboardExtrasOutput> {
  const T = dsql`tenant_id = ${tenantId}::uuid`;
  const live = dsql`current_stage NOT IN ${dsql.raw(RECRUITER_TERMINAL_STAGES)}`;
  const breach = slaBreachSql();

  const [
    stageRows,
    scoreRow,
    completeRow,
    skillMismatch,
    salaryGap,
    riskTotal,
    newTriage,
    breaches,
    toSchedule,
    toComplete,
    offers,
    agentApprovals,
    followRows,
  ] = await Promise.all([
    dashRows<{ stage: string; n: number | string }>(
      db,
      dsql`SELECT current_stage AS stage, count(*)::int AS n FROM public.applications
             WHERE ${T} AND ${live} GROUP BY current_stage`,
    ),
    dashRows<{ avg: number | string | null; scored: number | string; strong: number | string }>(
      db,
      dsql`SELECT avg(ai_score)::float AS avg,
                  count(*) FILTER (WHERE ai_score IS NOT NULL)::int AS scored,
                  count(*) FILTER (WHERE ai_score IS NOT NULL AND ai_score >= ${RECRUITER_STRONG_SCORE}
                    AND current_stage IN ('application_received','ai_screening','recruiter_review'))::int AS strong
             FROM public.applications WHERE ${T} AND ${live}`,
    ),
    dashRows<{ complete: number | string; total: number | string }>(
      db,
      dsql`SELECT count(*) FILTER (WHERE ai_score IS NOT NULL AND expected_salary_inr_paise IS NOT NULL)::int AS complete,
                  count(*)::int AS total
             FROM public.applications WHERE ${T} AND ${live}`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications
             WHERE ${T} AND ${live} AND ai_score IS NOT NULL AND ai_score < ${RECRUITER_MISMATCH_SCORE}`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications a
             JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
             JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
             WHERE a.tenant_id = ${tenantId}::uuid AND a.current_stage NOT IN ${dsql.raw(RECRUITER_TERMINAL_STAGES)}
               AND a.expected_salary_inr_paise IS NOT NULL AND p.comp_band_max IS NOT NULL
               AND a.expected_salary_inr_paise > (p.comp_band_max * 100)`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications a
             JOIN public.requisitions r ON r.tenant_id = a.tenant_id AND r.id = a.requisition_id
             JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
             WHERE a.tenant_id = ${tenantId}::uuid AND a.current_stage NOT IN ${dsql.raw(RECRUITER_TERMINAL_STAGES)}
               AND ( (a.ai_score IS NOT NULL AND a.ai_score < ${RECRUITER_MISMATCH_SCORE})
                     OR (a.expected_salary_inr_paise IS NOT NULL AND p.comp_band_max IS NOT NULL
                         AND a.expected_salary_inr_paise > (p.comp_band_max * 100)) )`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications WHERE ${T} AND current_stage = 'application_received'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications WHERE ${T} AND ${breach}`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications a WHERE a.tenant_id = ${tenantId}::uuid
             AND a.current_stage IN ('shortlisted', 'tech_interview', 'hr_round')
             AND NOT EXISTS (SELECT 1 FROM public.interviews i WHERE i.tenant_id = a.tenant_id
               AND i.application_id = a.id AND i.status = 'scheduled')`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.interviews i WHERE i.tenant_id = ${tenantId}::uuid
             AND i.status = 'scheduled'
             AND EXISTS (SELECT 1 FROM public.interview_panelists p WHERE p.tenant_id = i.tenant_id AND p.interview_id = i.id)
             AND NOT EXISTS (SELECT 1 FROM public.interview_panelists p WHERE p.tenant_id = i.tenant_id AND p.interview_id = i.id
               AND NOT EXISTS (SELECT 1 FROM public.interview_feedback f WHERE f.tenant_id = i.tenant_id
                 AND f.interview_id = i.id AND f.membership_id = p.membership_id AND f.submitted_at IS NOT NULL))`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.offers WHERE ${T} AND status IN ('drafted', 'extended')`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.agent_approval_requests WHERE ${T} AND status = 'pending'`,
    ),
    dashRows<{
      application_id: string;
      candidate_id: string;
      candidate_name: string | null;
      days: number | string;
    }>(
      db,
      dsql`SELECT i.application_id::text AS application_id, a.candidate_id::text AS candidate_id,
                  pe.full_name AS candidate_name,
                  floor(extract(epoch FROM (now() - i.created_at)) / 86400.0)::int AS days
             FROM public.interviews i
             JOIN public.applications a ON a.tenant_id = i.tenant_id AND a.id = i.application_id
             JOIN public.candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
             JOIN public.persons pe ON pe.tenant_id = c.tenant_id AND pe.id = c.person_id
             WHERE i.tenant_id = ${tenantId}::uuid AND i.status = 'scheduled'
               AND i.candidate_confirmed_at IS NULL
               AND i.created_at < now() - interval '48 hours'
             ORDER BY i.created_at ASC
             LIMIT 6`,
    ),
  ]);

  // ─── funnel ───
  const countByStage = new Map<string, number>();
  for (const r of stageRows) countByStage.set(r.stage, Number(r.n) || 0);
  const bucketCounts = RECRUITER_FUNNEL_BUCKETS.map((b) => ({
    ...b,
    count: b.stages.reduce((sum, s) => sum + (countByStage.get(s) ?? 0), 0),
  }));
  const headCount = bucketCounts[0]?.count ?? 0;
  const total = bucketCounts.reduce((sum, b) => sum + b.count, 0);
  let worstDrop: { label: string; prev: string; pct: number } | null = null;
  const stages: RecruiterFunnelStage[] = bucketCounts.map((b, i) => {
    const prev = i > 0 ? bucketCounts[i - 1] : null;
    const conversionPct =
      prev && prev.count > 0 ? Math.round((b.count / prev.count) * 100) : prev ? 0 : null;
    if (prev && prev.count > 0 && conversionPct !== null) {
      const dropPct = 100 - conversionPct;
      if (dropPct > 0 && (worstDrop === null || dropPct > 100 - worstDrop.pct)) {
        worstDrop = { label: b.label, prev: prev.label, pct: conversionPct };
      }
    }
    return {
      stage: b.key,
      label: b.label,
      count: b.count,
      pct: headCount > 0 ? Math.round((b.count / headCount) * 100) : 0,
      conversionPct,
    };
  });
  const wd = worstDrop as { label: string; prev: string; pct: number } | null;
  const bottleneck =
    wd && 100 - wd.pct >= 30
      ? `Biggest drop-off: ${wd.prev} → ${wd.label} (${wd.pct}% carry-through).`
      : null;

  // ─── averages + completeness + risk ───
  const avgRaw = scoreRow[0]?.avg;
  const avgMatchScore =
    avgRaw != null && Number.isFinite(Number(avgRaw)) ? Math.round(Number(avgRaw)) : null;
  const scoredCount = Number(scoreRow[0]?.scored ?? 0);
  const strongInScreening = Number(scoreRow[0]?.strong ?? 0);
  const completeCount = Number(completeRow[0]?.complete ?? 0);
  const inFlightTotal = Number(completeRow[0]?.total ?? 0);
  const dataCompleteness = {
    pct: inFlightTotal > 0 ? Math.round((completeCount / inFlightTotal) * 100) : 100,
    needInfoCount: Math.max(0, inFlightTotal - completeCount),
  };
  const riskFlags = { total: riskTotal, skillMismatch, salaryGap };

  // ─── tasks (priority-tagged, from live signals) ───
  const tasks: RecruiterTask[] = [];
  const pushTask = (t: RecruiterTask) => tasks.push(t);
  if (breaches > 0)
    pushTask({
      key: "task_sla",
      label: `Clear ${breaches} SLA breach${breaches === 1 ? "" : "es"} in triage`,
      priority: "high",
      href: "/triage",
    });
  if (newTriage > 0)
    pushTask({
      key: "task_triage",
      label: `Review ${newTriage} new applicant${newTriage === 1 ? "" : "s"} in triage`,
      priority: "high",
      href: "/triage",
    });
  if (toComplete > 0)
    pushTask({
      key: "task_complete",
      label: `Close ${toComplete} interview${toComplete === 1 ? "" : "s"} — all feedback in`,
      priority: "medium",
      href: "/interviews",
    });
  if (toSchedule > 0)
    pushTask({
      key: "task_schedule",
      label: `Schedule ${toSchedule} interview${toSchedule === 1 ? "" : "s"}`,
      priority: "medium",
      href: "/interviews",
    });
  if (agentApprovals > 0)
    pushTask({
      key: "task_agents",
      label: `Review ${agentApprovals} agent draft${agentApprovals === 1 ? "" : "s"} awaiting approval`,
      priority: "medium",
      href: "/approvals",
    });
  if (offers > 0)
    pushTask({
      key: "task_offers",
      label: `Finalise ${offers} outstanding offer${offers === 1 ? "" : "s"}`,
      priority: "low",
      href: "/triage",
    });

  // ─── smart follow-ups (stalled = interview invite unconfirmed > 48h) ───
  const followUps: RecruiterFollowUp[] = followRows.map((r, i) => {
    const days = Math.max(2, Number(r.days) || 2);
    return {
      key: `follow_${r.application_id}_${i}`,
      candidateName: r.candidate_name ?? "Candidate",
      reason: `Interview invite unconfirmed · ${days}d`,
      applicationId: r.application_id,
      candidateId: r.candidate_id,
      // Human-in-loop: routes to the agent-approval queue, never a one-click send.
      href: "/approvals",
    };
  });

  // ─── AI insights (deterministic observations) ───
  const insights: RecruiterInsight[] = [];
  const skillWeightsCta = { label: "Review skill weights", href: "/requisitions" };
  if (wd && 100 - wd.pct >= 30) {
    insights.push({
      key: "insight_bottleneck",
      severity: 100 - wd.pct >= 50 ? "critical" : "warning",
      title: `High drop-off: ${wd.prev} → ${wd.label}`,
      body: `Only ${wd.pct}% of candidates carry through from ${wd.prev} to ${wd.label}. Review interviewer calibration or the JD skill weights.`,
      cta: skillWeightsCta,
    });
  }
  if (scoredCount > 0 && skillMismatch / scoredCount >= 0.4) {
    const pct = Math.round((skillMismatch / scoredCount) * 100);
    insights.push({
      key: "insight_mismatch",
      severity: pct >= 60 ? "critical" : "warning",
      title: `${pct}% of scored candidates below the match threshold`,
      body: `${skillMismatch} of ${scoredCount} scored candidates fall below ${RECRUITER_MISMATCH_SCORE}%. Skill weights may be miscalibrated for the sourcing pool.`,
      cta: skillWeightsCta,
    });
  }
  if (strongInScreening > 0) {
    insights.push({
      key: "insight_strong_screening",
      severity: "info",
      title: `${strongInScreening} strong candidate${strongInScreening === 1 ? "" : "s"} still in screening`,
      body: `${strongInScreening} candidate${strongInScreening === 1 ? " scores" : "s score"} ${RECRUITER_STRONG_SCORE}%+ but ${strongInScreening === 1 ? "is" : "are"} still awaiting triage. Expedite to avoid losing them.`,
      cta: { label: "Open triage", href: "/triage" },
    });
  }
  if (salaryGap > 0) {
    insights.push({
      key: "insight_salary_gap",
      severity: "warning",
      title: `${salaryGap} candidate${salaryGap === 1 ? "" : "s"} above the budget band`,
      body: `${salaryGap} in-flight candidate${salaryGap === 1 ? " expects" : "s expect"} more than the requisition budget max. Comp gaps may stall offers — revisit the band or the shortlist.`,
      cta: { label: "Review requisitions", href: "/requisitions" },
    });
  }

  return {
    funnel: { stages, total, bottleneck },
    tasks,
    followUps,
    insights,
    dataCompleteness,
    riskFlags,
    avgMatchScore,
  };
}

async function panelSection(
  db: DashDb,
  tenantId: string,
  membershipId: string | null,
): Promise<DashSection> {
  if (!membershipId) return { kpis: [], actions: [] };
  const onPanel = dsql`EXISTS (SELECT 1 FROM public.interview_panelists p WHERE p.tenant_id = i.tenant_id AND p.interview_id = i.id AND p.membership_id = ${membershipId}::uuid)`;
  const myFeedbackDone = dsql`EXISTS (SELECT 1 FROM public.interview_feedback f WHERE f.tenant_id = i.tenant_id AND f.interview_id = i.id AND f.membership_id = ${membershipId}::uuid AND f.submitted_at IS NOT NULL)`;
  const [upcoming, feedbackDue] = await Promise.all([
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.interviews i WHERE i.tenant_id = ${tenantId}::uuid
             AND i.status = 'scheduled' AND i.scheduled_start >= now() AND i.scheduled_start < now() + interval '7 days'
             AND ${onPanel}`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.interviews i WHERE i.tenant_id = ${tenantId}::uuid
             AND ${onPanel} AND i.status <> 'cancelled'
             AND (i.status = 'completed' OR (i.scheduled_end IS NOT NULL AND i.scheduled_end < now()))
             AND NOT ${myFeedbackDone}`,
    ),
  ]);
  const kpis: DashboardKpi[] = [
    {
      key: "pan_upcoming",
      label: "Upcoming interviews",
      value: upcoming,
      hint: "next 7 days",
      tone: upcoming ? "accent" : "neutral",
      href: "/panel",
    },
    {
      key: "pan_feedback",
      label: "Feedback due",
      value: feedbackDue,
      hint: feedbackDue ? "scorecards to submit" : "all in",
      tone: feedbackDue ? "warning" : "positive",
      href: "/panel",
    },
  ];
  const actions: DashboardAction[] = [];
  const rows = await dashRows<{
    id: string;
    round_name: string | null;
    scheduled_start: string | Date | null;
  }>(
    db,
    dsql`SELECT i.id::text AS id, i.round_name AS round_name, i.scheduled_start AS scheduled_start
         FROM public.interviews i
         WHERE i.tenant_id = ${tenantId}::uuid AND ${onPanel} AND i.status <> 'cancelled'
           AND (i.status = 'completed' OR (i.scheduled_end IS NOT NULL AND i.scheduled_end < now()))
           AND NOT ${myFeedbackDone}
         ORDER BY i.scheduled_start ASC NULLS LAST
         LIMIT 5`,
  );
  for (const r of rows) {
    actions.push({
      key: `pan_score_${r.id}`,
      label: `Submit feedback: ${r.round_name ?? "interview"}`,
      detail: r.scheduled_start ? `Interviewed ${daysSince(r.scheduled_start)}d ago` : null,
      href: `/panel/${r.id}`,
      urgency: "attention",
    });
  }
  return { kpis, actions };
}

async function peopleOpsSection(db: DashDb, tenantId: string): Promise<DashSection> {
  const T = dsql`tenant_id = ${tenantId}::uuid`;
  const [docs, tasksDue, blockedOn, blockedOff, offActive] = await Promise.all([
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.onboarding_documents WHERE ${T} AND verification_status = 'pending'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.onboarding_tasks WHERE ${T} AND status IN ('pending', 'in_progress') AND due_at IS NOT NULL AND due_at <= now()`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.onboarding_tasks WHERE ${T} AND status = 'blocked'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.offboarding_tasks WHERE ${T} AND status = 'blocked'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.offboarding_cases WHERE ${T} AND status NOT IN ('completed', 'cancelled')`,
    ),
  ]);
  const blocked = blockedOn + blockedOff;
  const kpis: DashboardKpi[] = [
    {
      key: "ops_docs",
      label: "Documents to review",
      value: docs,
      hint: docs ? "pending verification" : "none pending",
      tone: docs ? "accent" : "neutral",
      href: "/onboarding",
    },
    {
      key: "ops_tasks_due",
      label: "Onboarding tasks due",
      value: tasksDue,
      hint: tasksDue ? "past their due date" : "on track",
      tone: tasksDue ? "warning" : "neutral",
      href: "/onboarding",
    },
    {
      key: "ops_blocked",
      label: "Blocked tasks",
      value: blocked,
      hint: blocked ? "need unblocking" : "none blocked",
      tone: blocked ? "error" : "neutral",
      href: "/onboarding",
    },
    {
      key: "ops_offboarding",
      label: "Offboarding active",
      value: offActive,
      hint: "in progress",
      tone: offActive ? "info" : "neutral",
      href: "/offboarding",
    },
  ];
  const actions: DashboardAction[] = [];
  const docRows = await dashRows<{ id: string; case_id: string; file_name: string | null }>(
    db,
    dsql`SELECT d.id::text AS id, d.case_id::text AS case_id, d.file_name AS file_name
         FROM public.onboarding_documents d WHERE d.tenant_id = ${tenantId}::uuid AND d.verification_status = 'pending'
         ORDER BY d.uploaded_at ASC LIMIT 3`,
  );
  for (const r of docRows) {
    actions.push({
      key: `ops_verify_${r.id}`,
      label: `Verify document: ${r.file_name ?? "uploaded file"}`,
      detail: "Awaiting review",
      href: `/onboarding/${r.case_id}`,
      urgency: "attention",
    });
  }
  const blockRows = await dashRows<{ id: string; case_id: string; title: string | null }>(
    db,
    dsql`SELECT t.id::text AS id, t.case_id::text AS case_id, t.title AS title
         FROM public.onboarding_tasks t WHERE t.tenant_id = ${tenantId}::uuid AND t.status = 'blocked'
         ORDER BY t.updated_at DESC LIMIT 3`,
  );
  for (const r of blockRows) {
    actions.push({
      key: `ops_unblock_${r.id}`,
      label: `Unblock: ${r.title ?? "onboarding task"}`,
      detail: "Blocked — needs attention",
      href: `/onboarding/${r.case_id}`,
      urgency: "urgent",
    });
  }
  return { kpis, actions };
}

async function adminSection(
  db: DashDb,
  tenantId: string,
): Promise<DashSection & { activity: DashboardActivity[] }> {
  const T = dsql`tenant_id = ${tenantId}::uuid`;
  const [
    newTriage,
    reqApprovals,
    interviewsUp,
    onbActive,
    offActive,
    agentApprovals,
    workflows,
    spendToday,
    spendWeek,
    auditToday,
  ] = await Promise.all([
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.applications WHERE ${T} AND current_stage = 'application_received'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.approval_requests WHERE ${T} AND subject_type = 'requisition' AND status = 'pending'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.interviews WHERE ${T} AND status = 'scheduled' AND scheduled_start >= now()`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.onboarding_cases WHERE ${T} AND status NOT IN ('completed', 'cancelled')`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.offboarding_cases WHERE ${T} AND status NOT IN ('completed', 'cancelled')`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.agent_approval_requests WHERE ${T} AND status = 'pending'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.automation_agents WHERE ${T} AND enabled = true AND retired_at IS NULL`,
    ),
    dashScalar(
      db,
      dsql`SELECT COALESCE(SUM(cost_micros), 0)::text AS n FROM public.ai_usage_logs WHERE ${T} AND created_at >= date_trunc('day', now())`,
    ),
    dashScalar(
      db,
      dsql`SELECT COALESCE(SUM(cost_micros), 0)::text AS n FROM public.ai_usage_logs WHERE ${T} AND created_at >= now() - interval '7 days'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.audit_logs WHERE ${T} AND created_at >= date_trunc('day', now())`,
    ),
  ]);
  const kpis: DashboardKpi[] = [
    {
      key: "adm_triage",
      label: "New in triage",
      value: newTriage,
      hint: "just applied",
      tone: newTriage ? "accent" : "neutral",
      href: "/triage",
    },
    {
      key: "adm_req_appr",
      label: "Req approvals",
      value: reqApprovals,
      hint: "pending",
      tone: reqApprovals ? "warning" : "neutral",
      href: "/requisition-approvals",
    },
    {
      key: "adm_interviews",
      label: "Interviews scheduled",
      value: interviewsUp,
      hint: "upcoming",
      tone: "info",
      href: "/interviews",
    },
    {
      key: "adm_onboarding",
      label: "Onboarding active",
      value: onbActive,
      hint: "in progress",
      tone: "info",
      href: "/onboarding",
    },
    {
      key: "adm_offboarding",
      label: "Offboarding active",
      value: offActive,
      hint: "in progress",
      tone: "info",
      href: "/offboarding",
    },
    {
      key: "adm_agents",
      label: "Agent approvals",
      value: agentApprovals,
      hint: "pending",
      tone: agentApprovals ? "warning" : "neutral",
      href: "/approvals",
    },
    {
      key: "adm_workflows",
      label: "Workflows enabled",
      value: workflows,
      hint: "live agents",
      tone: "neutral",
      href: "/admin/workflows",
    },
    {
      key: "adm_spend_today",
      label: "AI spend today",
      value: formatUsdMicros(spendToday),
      hint: "USD",
      tone: "neutral",
      href: "/admin/costs",
    },
    {
      key: "adm_spend_week",
      label: "AI spend · 7d",
      value: formatUsdMicros(spendWeek),
      hint: "USD",
      tone: "neutral",
      href: "/admin/costs",
    },
    {
      key: "adm_audit",
      label: "Audit events today",
      value: auditToday,
      hint: "logged",
      tone: "neutral",
      href: "/admin/audit",
    },
  ];
  const actions: DashboardAction[] = [];
  if (reqApprovals > 0)
    actions.push({
      key: "adm_a_req",
      label: `Decide ${reqApprovals} requisition approval${reqApprovals === 1 ? "" : "s"}`,
      detail: "HR-head queue",
      href: "/requisition-approvals",
      urgency: "urgent",
    });
  if (agentApprovals > 0)
    actions.push({
      key: "adm_a_agents",
      label: `Review ${agentApprovals} agent approval${agentApprovals === 1 ? "" : "s"}`,
      detail: "Awaiting sign-off",
      href: "/approvals",
      urgency: "attention",
    });
  if (newTriage > 0)
    actions.push({
      key: "adm_a_triage",
      label: `Triage ${newTriage} new application${newTriage === 1 ? "" : "s"}`,
      detail: "Fresh in the pipeline",
      href: "/triage",
      urgency: "attention",
    });
  if (onbActive > 0)
    actions.push({
      key: "adm_a_onb",
      label: `Track ${onbActive} onboarding case${onbActive === 1 ? "" : "s"}`,
      detail: "In progress",
      href: "/onboarding",
      urgency: "normal",
    });

  const activityRows = await dashRows<{
    id: string;
    entity_type: string;
    action: string;
    created_at: string | Date;
  }>(
    db,
    dsql`SELECT id::text AS id, entity_type, action::text AS action, created_at
         FROM public.audit_logs WHERE ${T} ORDER BY created_at DESC LIMIT 5`,
  );
  const activity: DashboardActivity[] = activityRows.map((r) => ({
    key: `act_${r.id}`,
    label: `${humanizeStage(r.action)} · ${humanizeStage(r.entity_type)}`,
    detail: null,
    href: "/admin/audit",
    at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : new Date(r.created_at).toISOString(),
  }));
  return { kpis, actions, activity };
}

/**
 * Compose the caller's dashboard. admin → the condensed superset (one KPI row
 * per pillar + AI spend + workflows + audit + a recent-activity strip). Any
 * other internal identity → the union of its persona sections, so a
 * recruiter-only user gets recruiter content, an hr_head gets hr_head content
 * (recruiter ≠ hr_head), and a multi-role user gets both. `it_admin` (no bespoke
 * section) lands an honest empty dashboard — the UI renders the calm empty state.
 */
async function buildInternalDashboard(
  db: DashDb,
  tenantId: string,
  roles: string[],
  membershipId: string | null,
): Promise<GetMyDashboardOutput> {
  if (roles.includes("admin")) {
    const a = await adminSection(db, tenantId);
    return {
      variants: ["admin"],
      kpis: a.kpis,
      actions: a.actions,
      ...(a.activity.length ? { activity: a.activity } : {}),
    };
  }
  const variants: string[] = [];
  const kpis: DashboardKpi[] = [];
  const actions: DashboardAction[] = [];
  const has = (r: string) => roles.includes(r);
  if (has("hiring_manager")) {
    variants.push("hiring_manager");
    const s = await hiringManagerSection(db, tenantId, membershipId);
    kpis.push(...s.kpis);
    actions.push(...s.actions);
  }
  if (has("hr_head")) {
    variants.push("hr_head");
    const s = await hrHeadSection(db, tenantId);
    kpis.push(...s.kpis);
    actions.push(...s.actions);
  }
  if (has("recruiter")) {
    variants.push("recruiter");
    const s = await recruiterSection(db, tenantId);
    kpis.push(...s.kpis);
    actions.push(...s.actions);
  }
  if (has("panel_member")) {
    variants.push("panel_member");
    const s = await panelSection(db, tenantId, membershipId);
    kpis.push(...s.kpis);
    actions.push(...s.actions);
  }
  if (has("hr_ops") || has("people_ops")) {
    variants.push("people_ops");
    const s = await peopleOpsSection(db, tenantId);
    kpis.push(...s.kpis);
    actions.push(...s.actions);
  }
  return { variants, kpis, actions };
}

// ═══════════ HRHEAD-01 — HR-head dashboard extras builder ═══════════
//
// A richer, HR-head-specific read: a hero KPI + three siblings (each with a
// real period-over-period delta where the maths exists), a current-stage
// pipeline funnel with a bottleneck callout, the decide-inline pending
// approvals, and a risk/compliance panel. All counts run under the caller's
// RLS-scoped tx (db.execute) with an explicit tenant predicate as
// defence-in-depth; requester names resolve via the service-role helper.

/** The forward pipeline, in progression order, for the funnel. Terminal
 *  negatives (declined/withdrawn/rejected) are excluded — the funnel shows
 *  the live forward flow, not dead ends. */
const HRHEAD_FUNNEL_STAGES: ApplicationStage[] = [
  "application_received",
  "ai_screening",
  "recruiter_review",
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
];

/** Build a KPI delta from a numeric current/prior pair. `betterWhen` says
 *  which direction is good. Returns null when there's no prior signal. */
function buildKpiDelta(
  current: number,
  prior: number,
  betterWhen: "lower" | "higher",
  format: (magnitude: number) => string,
  caption: string,
): HrHeadKpi["delta"] {
  if (prior <= 0 && current <= 0) return null;
  const diff = current - prior;
  if (Math.abs(diff) < 1e-9) {
    return { label: "no change", direction: "flat", tone: "neutral", caption };
  }
  const rose = diff > 0;
  const good = betterWhen === "lower" ? !rose : rose;
  return {
    label: format(Math.abs(diff)),
    direction: rose ? "up" : "down",
    tone: good ? "good" : "bad",
    caption,
  };
}

async function buildHrHeadDashboardExtras(
  ctx: HonoTRPCContext,
  db: DashDb,
  tenantId: string,
): Promise<GetHrHeadDashboardExtrasOutput> {
  const T = dsql`tenant_id = ${tenantId}::uuid`;
  const reqAppr = dsql`${T} AND subject_type = 'requisition'`;

  const [
    pending,
    stale,
    raisedThisWeek,
    raisedPrevWeek,
    tthCurrent,
    tthPrior,
    hiresCurrent,
    spendCurrentMicros,
    acceptance,
    funnelRows,
  ] = await Promise.all([
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.approval_requests WHERE ${reqAppr} AND status = 'pending'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.approval_requests WHERE ${reqAppr} AND status = 'pending' AND requested_at < now() - interval '2 days'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.approval_requests WHERE ${reqAppr} AND requested_at >= now() - interval '7 days'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.approval_requests WHERE ${reqAppr}
             AND requested_at >= now() - interval '14 days' AND requested_at < now() - interval '7 days'`,
    ),
    // Avg days from application created → first offer_accepted transition, 90d.
    dashScalar(
      db,
      dsql`SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (t.transitioned_at - a.created_at)) / 86400.0), 0)::float AS n
           FROM public.application_state_transitions t
           JOIN public.applications a ON a.tenant_id = t.tenant_id AND a.id = t.application_id
           WHERE t.tenant_id = ${tenantId}::uuid AND t.to_stage = 'offer_accepted'
             AND t.transitioned_at >= now() - interval '90 days'`,
    ),
    dashScalar(
      db,
      dsql`SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (t.transitioned_at - a.created_at)) / 86400.0), 0)::float AS n
           FROM public.application_state_transitions t
           JOIN public.applications a ON a.tenant_id = t.tenant_id AND a.id = t.application_id
           WHERE t.tenant_id = ${tenantId}::uuid AND t.to_stage = 'offer_accepted'
             AND t.transitioned_at >= now() - interval '180 days' AND t.transitioned_at < now() - interval '90 days'`,
    ),
    dashScalar(
      db,
      dsql`SELECT count(*)::int AS n FROM public.application_state_transitions
             WHERE ${T} AND to_stage = 'offer_accepted' AND transitioned_at >= now() - interval '90 days'`,
    ),
    dashScalar(
      db,
      dsql`SELECT COALESCE(SUM(cost_micros), 0)::text AS n FROM public.ai_usage_logs
             WHERE ${T} AND created_at >= now() - interval '90 days'`,
    ),
    dashRows<{ accepted: number; declined: number; accepted_prev: number; declined_prev: number }>(
      db,
      dsql`SELECT
             count(*) FILTER (WHERE accepted_at >= now() - interval '90 days')::int AS accepted,
             count(*) FILTER (WHERE declined_at >= now() - interval '90 days')::int AS declined,
             count(*) FILTER (WHERE accepted_at >= now() - interval '180 days' AND accepted_at < now() - interval '90 days')::int AS accepted_prev,
             count(*) FILTER (WHERE declined_at >= now() - interval '180 days' AND declined_at < now() - interval '90 days')::int AS declined_prev
           FROM public.offers WHERE ${T}`,
    ),
    dashRows<{ stage: string; n: number }>(
      db,
      dsql`SELECT current_stage AS stage, count(*)::int AS n
           FROM public.applications WHERE ${T} GROUP BY current_stage`,
    ),
  ]);

  // ── KPIs ──
  // Round time-to-hire to 1dp before comparing so sub-0.1d noise (same-day
  // seed hires) doesn't manufacture a spurious "slower/faster" delta.
  const tthCur1 = Math.round(tthCurrent * 10) / 10;
  const tthPrev1 = Math.round(tthPrior * 10) / 10;
  const tthValue = tthCur1 > 0 ? `${tthCur1.toFixed(1)}d` : "—";
  const acc = acceptance[0] ?? { accepted: 0, declined: 0, accepted_prev: 0, declined_prev: 0 };
  const accTotal = acc.accepted + acc.declined;
  const accPct = accTotal > 0 ? acc.accepted / accTotal : 0;
  const accPrevTotal = acc.accepted_prev + acc.declined_prev;
  const accPrevPct = accPrevTotal > 0 ? acc.accepted_prev / accPrevTotal : 0;
  const spendCurrent = spendCurrentMicros;
  const costPerHire = hiresCurrent > 0 ? spendCurrent / hiresCurrent : 0;

  const kpis: HrHeadKpi[] = [
    {
      key: "hrh_pending",
      label: "Pending approvals",
      value: String(pending),
      caption: stale > 0 ? `${stale} over 2 days old` : "queue fresh",
      delta: buildKpiDelta(
        raisedThisWeek,
        raisedPrevWeek,
        "lower",
        (m) => `${raisedThisWeek - raisedPrevWeek > 0 ? "+" : "−"}${Math.round(m)}`,
        "new requests vs prior week",
      ),
      hero: true,
      href: "/requisition-approvals",
    },
    {
      key: "hrh_tth",
      label: "Avg time-to-hire",
      value: tthValue,
      caption: "apply → offer accepted, 90d",
      delta:
        tthCur1 > 0 && tthPrev1 > 0
          ? buildKpiDelta(
              tthCur1,
              tthPrev1,
              "lower",
              (m) => `${m.toFixed(1)}d ${tthCur1 < tthPrev1 ? "faster" : "slower"}`,
              "vs prior 90 days",
            )
          : null,
      hero: false,
      href: "/requisition-approvals",
    },
    {
      key: "hrh_acceptance",
      label: "Offer acceptance",
      value: accTotal > 0 ? `${Math.round(accPct * 100)}%` : "—",
      caption: accTotal > 0 ? `${acc.accepted}/${accTotal} offers, 90d` : "no offers decided",
      delta:
        accTotal > 0
          ? buildKpiDelta(
              accPct,
              accPrevPct,
              "higher",
              (m) => `${(m * 100).toFixed(0)} pts`,
              "vs prior 90 days",
            )
          : null,
      hero: false,
      href: "/requisition-approvals",
    },
    {
      key: "hrh_cost_per_hire",
      label: "AI cost per hire",
      value: hiresCurrent > 0 ? formatUsdMicros(costPerHire) : "—",
      // FLAG: AI spend is the only real cost we track — labelled honestly.
      caption: hiresCurrent > 0 ? `AI spend ÷ ${hiresCurrent} hires, 90d` : "no hires in period",
      delta: null,
      hero: false,
      href: "/admin/costs",
    },
  ];

  // ── Funnel ──
  // FLAG (interpretation): the ticket says "applications by current stage",
  // but "largest relative drop" only reads meaningfully on a MONOTONIC funnel.
  // A raw current-stage snapshot has transient pass-through stages sitting at 0
  // (ai_screening, shortlisted), which manufacture false "100% drop-off"
  // callouts. So the bars are cumulative REACH: reach[stage] = applications
  // currently at that stage OR any later forward stage. This yields a proper
  // non-increasing funnel where each drop is "how many stopped progressing
  // here". Terminal-negative outcomes (rejected/declined/withdrawn) leave the
  // forward set and aren't counted — the funnel shows the live+hired flow.
  const countByStage = new Map<string, number>();
  for (const r of funnelRows) countByStage.set(r.stage, r.n);
  const currentCounts = HRHEAD_FUNNEL_STAGES.map((s) => countByStage.get(s) ?? 0);
  const reach: number[] = new Array(HRHEAD_FUNNEL_STAGES.length).fill(0);
  let running = 0;
  for (let i = HRHEAD_FUNNEL_STAGES.length - 1; i >= 0; i--) {
    running += currentCounts[i] ?? 0;
    reach[i] = running;
  }
  const topReach = Math.max(1, reach[0] ?? 0);
  const funnelStages = HRHEAD_FUNNEL_STAGES.map((s, i) => ({
    stage: s,
    label: humanizeStage(s),
    count: reach[i] ?? 0,
    pct: Math.round(((reach[i] ?? 0) / topReach) * 100),
  }));
  // Bottleneck = the largest relative drop between adjacent reach levels,
  // reported when it clears 30% (and the upstream level had real volume).
  let bottleneck: string | null = null;
  let worstDrop = 0.3;
  for (let i = 1; i < funnelStages.length; i++) {
    const prevStage = funnelStages[i - 1];
    const curStage = funnelStages[i];
    if (!prevStage || !curStage || prevStage.count <= 0) continue;
    const drop = (prevStage.count - curStage.count) / prevStage.count;
    if (drop > worstDrop) {
      worstDrop = drop;
      bottleneck = `Bottleneck at ${curStage.label} — ${Math.round(drop * 100)}% drop-off from ${prevStage.label}`;
    }
  }

  // ── Approvals pending, decide-inline (same enrichment as the queue) ──
  const apprRows = await dashRows<{
    id: string;
    subject_id: string;
    title: string | null;
    department: string | null;
    comp_min: string | null;
    comp_max: string | null;
    comp_currency: string | null;
    requested_by: string | null;
    requested_at: string | Date;
    context: unknown;
  }>(
    db,
    dsql`SELECT ar.id::text AS id, ar.subject_id::text AS subject_id, p.title AS title,
           bu.name AS department, p.comp_band_min AS comp_min, p.comp_band_max AS comp_max,
           p.comp_currency AS comp_currency, ar.requested_by_membership_id::text AS requested_by,
           ar.requested_at AS requested_at, ar.context AS context
         FROM public.approval_requests ar
         LEFT JOIN public.requisitions r ON r.tenant_id = ar.tenant_id AND r.id = ar.subject_id
         LEFT JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
         LEFT JOIN public.business_units bu ON bu.tenant_id = p.tenant_id AND bu.id = p.business_unit_id
         WHERE ar.tenant_id = ${tenantId}::uuid AND ar.subject_type = 'requisition' AND ar.status = 'pending'
         ORDER BY ar.requested_at ASC
         LIMIT 8`,
  );
  const apprNames = await resolveMembershipNames(
    ctx,
    tenantId,
    apprRows.map((r) => r.requested_by).filter((id): id is string => !!id),
  );
  const approvals: HrHeadApprovalItem[] = apprRows.map((r) => {
    const ageDays = daysSince(r.requested_at);
    return {
      approvalRequestId: r.id,
      requisitionId: r.subject_id,
      title: r.title ?? null,
      department: r.department ?? null,
      budgetBand: formatBudgetBand(r.comp_min, r.comp_max, r.comp_currency),
      requestedByName: r.requested_by ? (apprNames.get(r.requested_by) ?? null) : null,
      priority: deriveApprovalPriority(ageDays),
      ageDays,
      biasFlags: readBiasFlagsFromContext(r.context),
    };
  });

  // ── Risk & compliance ──
  const lexicon = await resolveTenantBiasLexiconDb(tenantId);
  // Reconciled to HRHEAD-02's actual table: market_benchmarks(role_title,
  // median_salary_minor /* paise */), matched on normalised position title.
  // Probe stays defensive so environments without the table render no row.
  const benchmarkExists = await dashScalar(
    db,
    dsql`SELECT (to_regclass('public.market_benchmarks') IS NOT NULL)::int AS n`,
  );
  let belowBenchmark: number | null = null;
  if (benchmarkExists === 1) {
    belowBenchmark = await dashScalar(
      db,
      dsql`SELECT count(*)::int AS n
        FROM public.requisitions r
        JOIN public.positions p ON p.tenant_id = r.tenant_id AND p.id = r.position_id
        JOIN public.market_benchmarks mb
          ON mb.tenant_id = r.tenant_id
          AND LOWER(TRIM(mb.role_title)) = LOWER(TRIM(p.title))
        WHERE r.tenant_id = ${tenantId}::uuid
          AND r.status IN ('approved', 'posted')
          AND p.comp_band_max IS NOT NULL
          AND mb.median_salary_minor IS NOT NULL
          AND p.comp_band_max < (mb.median_salary_minor / 100.0) * 0.9`,
    );
  }

  return {
    kpis,
    funnel: { stages: funnelStages, bottleneck },
    approvals,
    risk: {
      biasGateEnforcement: lexicon.enforcement,
      staleApprovals: stale,
      belowBenchmark,
    },
  };
}

// ─────────────── ONBOARD-05 document helpers ───────────────

/**
 * Resolves the caller's tenant_user_memberships.id for the verifier stamp.
 * The JWT carries user + tenant but not membership id (see tenant-context.ts),
 * so we look it up via the service-role client with an explicit tenant filter.
 * Returns null if the caller has no membership row (defensive — a JWT with a
 * tid always has one in practice).
 */
async function resolveCallerMembershipId(
  ctx: HonoTRPCContext,
  tenantId: string,
): Promise<string | null> {
  if (!ctx.userId) return null;
  const rows = await ctx.sql<{ id: string }[]>`
    SELECT id::text AS id
    FROM public.tenant_user_memberships
    WHERE tenant_id = ${tenantId} AND user_id = ${ctx.userId}
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

// ─────────────── HROPS-03 case-audit + document helpers ───────────────

/** Raw row shape from the listCaseAuditCases aggregate query. */
interface CaseAuditListSqlRow {
  application_id: string;
  stage: string;
  candidate_name: string | null;
  role_title: string | null;
  event_count: number | string;
  last_at: string | null;
  note_count: number | string;
  stage_entered_at: string | null;
}

/** The audit_logs projection input for a single timeline event. */
interface AuditRowForProjection {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  changedColumns: string[] | null;
  beforeData: unknown;
  afterData: unknown;
  createdAt: Date | string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Per-candidate document rollup: rejected wins, then all-verified, then partial.
 */
function computeDocOverall(statuses: string[]): ApplicationDocumentOverall {
  if (statuses.length === 0) return "none";
  if (statuses.some((s) => s === "rejected")) return "rejected";
  if (statuses.every((s) => s === "verified")) return "all_verified";
  return "partial";
}

/**
 * Projects one trigger-written audit_logs row into a display timeline event.
 * Actors are null for trigger rows (the existing convention — the UI renders
 * "System"); notes carry their author resolved from hr_case_notes.
 */
function projectCaseAuditEvent(
  r: AuditRowForProjection,
  docTypeById: Map<string, string | null>,
  noteById: Map<string, string>,
  noteAuthorById: Map<string, string | null>,
): CaseAuditEvent {
  const before = asRecord(r.beforeData);
  const after = asRecord(r.afterData);
  const ts = toIsoString(r.createdAt) ?? new Date(0).toISOString();
  const base = { id: r.id, actorName: null as string | null, isNote: false, timestamp: ts };

  if (r.entityType === "hr_case_notes") {
    return {
      ...base,
      kind: "note",
      title: "Note added",
      description: noteById.get(r.entityId) ?? (typeof after.note === "string" ? after.note : null),
      actorName: noteAuthorById.get(r.entityId) ?? null,
      isNote: true,
    };
  }
  if (r.entityType === "applications") {
    if (r.action === "insert") {
      return { ...base, kind: "stage", title: "Application created", description: null };
    }
    const cols = r.changedColumns ?? [];
    if (cols.includes("current_stage")) {
      const from = typeof before.current_stage === "string" ? before.current_stage : "?";
      const to = typeof after.current_stage === "string" ? after.current_stage : "?";
      return {
        ...base,
        kind: "stage",
        title: "Stage changed",
        description: `${from.replace(/_/g, " ")} → ${to.replace(/_/g, " ")}`,
      };
    }
    return {
      ...base,
      kind: "stage",
      title: "Application updated",
      description: cols.length ? cols.join(", ") : null,
    };
  }
  if (r.entityType === "offers") {
    if (r.action === "insert") {
      return { ...base, kind: "offer", title: "Offer drafted", description: null };
    }
    if (r.action === "delete") {
      return { ...base, kind: "offer", title: "Offer removed", description: null };
    }
    const status = typeof after.status === "string" ? after.status : null;
    return {
      ...base,
      kind: "offer",
      title: status ? `Offer ${status.replace(/_/g, " ")}` : "Offer updated",
      description: null,
    };
  }
  if (r.entityType === "application_documents") {
    const typeName = docTypeById.get(r.entityId) ?? "document";
    const statusRaw = r.action === "delete" ? before.status : after.status;
    const status = typeof statusRaw === "string" ? statusRaw : null;
    let title: string;
    if (r.action === "insert") title = `Document requested: ${typeName}`;
    else if (status === "uploaded") title = `Document uploaded: ${typeName}`;
    else if (status === "verified") title = `Document verified: ${typeName}`;
    else if (status === "rejected") title = `Document rejected: ${typeName}`;
    else title = `Document updated: ${typeName}`;
    const reason = typeof after.rejection_reason === "string" ? after.rejection_reason : null;
    return {
      ...base,
      kind: "document",
      title,
      description: status === "rejected" ? reason : null,
    };
  }
  return { ...base, kind: "other", title: `${r.entityType} ${r.action}`, description: null };
}

// ─────────────── ONBOARD-02 case status transition guard ───────────────

/**
 * Legal onboarding_cases.status transitions (requirements.md §7 lifecycle):
 *   pre_boarding → day_zero | cancelled
 *   day_zero     → in_progress | cancelled
 *   in_progress  → completed | cancelled
 *   completed / cancelled are terminal.
 * A no-op (same status) is filtered out before this map is consulted.
 */
const ALLOWED_CASE_TRANSITIONS: Record<string, OnboardingCaseStatus[]> = {
  pre_boarding: ["day_zero", "cancelled"],
  day_zero: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

// ─────────────── OFFBOARD-02 case status transition guard ───────────────

/**
 * Legal offboarding_cases.status transitions (requirements.md §8 lifecycle):
 *   initiated     → notice_period | cancelled
 *   notice_period → clearance | cancelled
 *   clearance     → completed | cancelled
 *   completed / cancelled are terminal.
 * Forward-only; a no-op (same status) is rejected before this map is consulted.
 * The transition-specific GATES (→ clearance needs LWD; → completed needs the
 * clearance gates; → cancelled needs a reason) are enforced in the procedure.
 */
const ALLOWED_OFFBOARDING_TRANSITIONS: Record<string, OffboardingCaseStatus[]> = {
  initiated: ["notice_period", "cancelled"],
  notice_period: ["clearance", "cancelled"],
  clearance: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Legal final_settlements.status walk (OFFBOARD-02). Forward-only. */
const ALLOWED_SETTLEMENT_TRANSITIONS: Record<string, FinalSettlementStatus[]> = {
  pending: ["calculated"],
  calculated: ["approved"],
  approved: ["paid"],
  paid: [],
};

/**
 * OFFBOARD-02 — auto-complete the single checklist task of `taskType` for a
 * case when its underlying artifact reaches done (all assets returned / exit
 * interview submitted / settlement paid). Flips a not-yet-completed task to
 * completed (stamps completed_at, clears blocked_reason) and returns whether a
 * row changed. Idempotent: re-running after completion is a no-op (false).
 * All three call sites are flagged in the hand-back.
 */
async function autoCompleteOffboardingTask(
  db: ReturnType<typeof requireDb>,
  tenantId: string,
  caseId: string,
  taskType: OffboardingTaskType,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(offboardingTasks)
    .set({ status: "completed", completedAt: now, blockedReason: null, updatedAt: now })
    .where(
      and(
        eq(offboardingTasks.tenantId, tenantId),
        eq(offboardingTasks.caseId, caseId),
        eq(offboardingTasks.taskType, taskType),
        ne(offboardingTasks.status, "completed"),
      ),
    )
    .returning({ id: offboardingTasks.id });
  return rows.length > 0;
}

/**
 * OFFBOARD-02 — auto-complete the asset_return task when EVERY asset row for
 * the case is settled (returned | written_off) and at least one row exists. A
 * 'pending'/'lost' row leaves the task open. Returns whether the task flipped.
 */
async function maybeCompleteAssetReturnTask(
  db: ReturnType<typeof requireDb>,
  tenantId: string,
  caseId: string,
): Promise<boolean> {
  const [counts] = await db
    .select({
      total: dsql<number>`count(*)::int`,
      outstanding: dsql<number>`count(*) FILTER (WHERE ${assetReturns.status} NOT IN ('returned', 'written_off'))::int`,
    })
    .from(assetReturns)
    .where(and(eq(assetReturns.tenantId, tenantId), eq(assetReturns.caseId, caseId)));
  const total = Number(counts?.total ?? 0);
  const outstanding = Number(counts?.outstanding ?? 0);
  if (total === 0 || outstanding > 0) return false;
  return autoCompleteOffboardingTask(db, tenantId, caseId, "asset_return");
}

/** True when the case's single task of `taskType` exists AND is completed. */
async function isOffboardingTaskCompleted(
  db: ReturnType<typeof requireDb>,
  tenantId: string,
  caseId: string,
  taskType: OffboardingTaskType,
): Promise<boolean> {
  const [row] = await db
    .select({ id: offboardingTasks.id })
    .from(offboardingTasks)
    .where(
      and(
        eq(offboardingTasks.tenantId, tenantId),
        eq(offboardingTasks.caseId, caseId),
        eq(offboardingTasks.taskType, taskType),
        eq(offboardingTasks.status, "completed"),
      ),
    )
    .limit(1);
  return row != null;
}

// ─────────────── AGENT-04a #30 rule-attachment guard ───────────────

/**
 * tRPC-side wrapper around `assertRuleAttachable` from
 * @hireops/agent-actions. The underlying assert throws
 * IncompatibleApprovalRuleError on misconfiguration; this wrapper maps
 * that to a `BAD_REQUEST` tRPC error so callers see a clean 400
 * instead of an INTERNAL_SERVER_ERROR. Anything else (genuine bugs)
 * propagates unchanged.
 *
 * Used by every router procedure that inserts/updates
 * agent_approval_rules. The guard is correct-by-attachment-point: if
 * a future procedure forgets to call it, the misconfiguration would
 * land in the DB and produce a silent never-firing gate. Treat it as
 * mandatory for any rule write.
 */
function ensureRuleAttachable(actionType: string, approvalMode: string): void {
  try {
    assertRuleAttachable(actionType, approvalMode);
  } catch (err) {
    if (err instanceof IncompatibleApprovalRuleError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

// ─────────────── AGENT-03 approval-resolution helpers ───────────────

/**
 * Loaded approval-request shape used by the resolution procedures. Trims
 * to just the fields the resolution path needs to write the four-row
 * state transition (no full row clone).
 */
interface LoadedApproval {
  id: string;
  tenantId: string;
  agentId: string;
  runId: string;
  runActionId: string;
  actionOrder: number;
  approverRole: string;
  approverUserId: string | null;
}

/**
 * Loads a pending approval request, joining to agent_run_actions for
 * action_order (used in rejection error messages) and to
 * agent_approval_rules for the optional approver_user_id (specific_user
 * mode). Throws NOT_FOUND if missing or not pending — callers don't
 * need to second-guess status.
 */
async function loadPendingApprovalForResolution(
  db: NonNullable<HonoTRPCContext["db"]>,
  approvalRequestId: string,
): Promise<LoadedApproval> {
  // approver_user_id is on agent_approval_rules (keyed by action_id),
  // not on the request itself — join through run_action to find it.
  const result = await db.execute(dsql`
    SELECT
      ar.id::text AS id,
      ar.tenant_id::text AS tenant_id,
      ar.agent_id::text AS agent_id,
      ar.run_id::text AS run_id,
      ar.run_action_id::text AS run_action_id,
      ar.approver_role,
      ar.status,
      run_act.action_order::int AS action_order,
      rule.approver_user_id::text AS approver_user_id
    FROM public.agent_approval_requests ar
    JOIN public.agent_run_actions run_act
      ON run_act.id = ar.run_action_id AND run_act.tenant_id = ar.tenant_id
    LEFT JOIN public.agent_approval_rules rule
      ON rule.action_id = run_act.action_id AND rule.tenant_id = ar.tenant_id
    WHERE ar.id = ${approvalRequestId}::uuid
    LIMIT 1
  `);
  interface Row {
    id: string;
    tenant_id: string;
    agent_id: string;
    run_id: string;
    run_action_id: string;
    approver_role: string;
    status: string;
    action_order: number;
    approver_user_id: string | null;
  }
  const rows = (result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[]);
  const row = rows[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Approval request not found" });
  }
  if (row.status !== "pending") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Approval request is ${row.status}, not pending — cannot resolve`,
    });
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    runId: row.run_id,
    runActionId: row.run_action_id,
    actionOrder: row.action_order,
    approverRole: row.approver_role,
    approverUserId: row.approver_user_id,
  };
}

// Recruiter-tier roles — admin always passes because admin is the
// super-role across the codebase (see existing FORBIDDEN paths in
// router that follow the same admin-included pattern).
const RECRUITER_RESOLVE_ROLES = new Set(["admin", "recruiter", "hr_ops", "people_ops"]);
const HR_TEAM_RESOLVE_ROLES = new Set(["admin", "hr_ops", "people_ops"]);

/**
 * Enforces the approver_role gate for an approval-resolution call.
 *
 * For AGENT-03, owning_recruiter is treated as any-recruiter — joining
 * trigger_context → application → assigned_recruiter would couple the
 * agent layer to the application layer in a way that has no precedent
 * in this codebase yet. AGENT-04+ tightens this once we have the join
 * pattern reusable elsewhere.
 */
async function ensureCanResolveApproval(
  db: NonNullable<HonoTRPCContext["db"]>,
  ctx: HonoTRPCContext,
  ar: LoadedApproval,
): Promise<void> {
  const callerRoles = ctx.roles;
  switch (ar.approverRole) {
    case "any_recruiter":
    case "owning_recruiter": {
      // TODO(AGENT-04): tighten owning_recruiter via trigger_context →
      // application.assigned_recruiter join, once that join pattern is
      // also used elsewhere in the codebase.
      if (!callerRoles.some((r) => RECRUITER_RESOLVE_ROLES.has(r))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Recruiter role required to resolve this approval",
        });
      }
      return;
    }
    case "hr_team": {
      if (!callerRoles.some((r) => HR_TEAM_RESOLVE_ROLES.has(r))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "HR team role required to resolve this approval",
        });
      }
      return;
    }
    case "specific_user": {
      // specific_user mode pins to a single membership id (the
      // approver_user_id column on agent_approval_rules). The caller must
      // be that user.
      const callerMembershipId = await resolveActorMembership(db, ctx);
      if (!callerMembershipId || !ar.approverUserId || callerMembershipId !== ar.approverUserId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the specifically-named approver can resolve this approval",
        });
      }
      return;
    }
    default: {
      // Defensive — DB CHECK constraint restricts the column to the
      // four documented values, so this branch is unreachable.
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Unknown approver_role ${ar.approverRole}`,
      });
    }
  }
}

/**
 * Shared core for advance + reject. Reads current_stage, writes the
 * transition row, updates the application — all inside the protected
 * procedure's tenant-scoped tx so a failure rolls back atomically.
 */
async function transitionApplicationStage(
  db: NonNullable<HonoTRPCContext["db"]>,
  ctx: HonoTRPCContext,
  applicationId: string,
  targetStage: ApplicationStage,
  reason: string | null,
  metadata: Record<string, unknown> | null = null,
) {
  const [app] = await db
    .select({
      currentStage: applications.currentStage,
      tenantId: applications.tenantId,
    })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
  }
  if (app.currentStage === targetStage) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Application is already at stage ${targetStage}`,
    });
  }

  // HROPS-01 deterministic gate: advancing an application FORWARD out of
  // hr_round (→ the offer stages) requires a saved HR-round assessment whose
  // recommendation is 'proceed'. A hold/reject assessment, or none at all,
  // blocks the forward move server-side. Negative / lateral moves (reject,
  // withdraw, offer_declined, or a revert back to tech_interview) are NOT
  // gated — you can always end or step a candidate back.
  if (app.currentStage === "hr_round" && HR_ROUND_FORWARD_STAGES.has(targetStage)) {
    const [assessment] = await db
      .select({ recommendation: hrRoundAssessments.recommendation })
      .from(hrRoundAssessments)
      .where(eq(hrRoundAssessments.applicationId, applicationId))
      .limit(1);
    if (!assessment) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "HR round assessment required — complete and save the HR round assessment (recommendation: proceed) before advancing this candidate to the offer stage.",
      });
    }
    if (assessment.recommendation !== "proceed") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `HR round assessment recommends '${assessment.recommendation}', not 'proceed' — the candidate cannot be advanced to the offer stage until the HR round assessment recommends proceeding.`,
      });
    }
  }

  const membershipId = await resolveActorMembership(db, ctx);

  const [tx] = await db
    .insert(applicationStateTransitions)
    .values({
      tenantId: app.tenantId,
      applicationId,
      fromStage: app.currentStage,
      toStage: targetStage,
      actorMembershipId: membershipId,
      reason,
      metadata,
    })
    .returning({ id: applicationStateTransitions.id });

  await db
    .update(applications)
    .set({ currentStage: targetStage, stageEnteredAt: new Date() })
    .where(eq(applications.id, applicationId));

  if (!tx) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "transition insert returned no row",
    });
  }

  // Enqueue the candidate-facing email — only for stages the candidate
  // should hear about directly. Internal moves (recruiter_review,
  // ai_screening) are recruiter workflow, not candidate-visible.
  // The enqueue is wrapped — a notifications failure must not roll back
  // the transition itself.
  if (CANDIDATE_VISIBLE_STAGES.has(targetStage)) {
    try {
      const meta = await fetchTransitionEmailContext(db, applicationId);
      if (meta) {
        await enqueueNotification(db, {
          tenantId: app.tenantId,
          recipientType: "candidate",
          recipientEmail: meta.candidateEmail,
          recipientCandidateId: meta.candidateId,
          templateKey: "candidate.stage_advanced",
          templateData: {
            candidateName: meta.candidateName,
            positionTitle: meta.positionTitle,
            companyName: meta.companyName,
            newStageLabel: STAGE_LABELS[targetStage] ?? targetStage,
          },
          dedupKey: `stage_advanced:${tx.id}`,
        });
      }
    } catch (err) {
      ctx.log.warn(
        { err, request_id: ctx.requestId, application_id: applicationId },
        "transitionApplicationStage: enqueueNotification failed",
      );
    }
  }

  return {
    applicationId,
    fromStage: app.currentStage,
    toStage: targetStage,
    transitionId: tx.id,
  };
}

/**
 * Stages the candidate should hear about directly. Wave 1 list — add a
 * stage here only when there's a copy ready for it and product agrees.
 */
/**
 * HROPS-01 — the forward-progress stages an application moves to when leaving
 * hr_round in the good direction. Reaching any of these from hr_round is gated
 * on a saved 'proceed' HR-round assessment (see transitionApplicationStage).
 */
const HR_ROUND_FORWARD_STAGES = new Set<ApplicationStage>(["offer_drafted", "offer_accepted"]);

const CANDIDATE_VISIBLE_STAGES = new Set<ApplicationStage>([
  "shortlisted",
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
  "offer_declined",
  "recruiter_rejected",
  "withdrawn",
]);

const STAGE_LABELS: Partial<Record<ApplicationStage, string>> = {
  shortlisted: "Shortlisted",
  tech_interview: "Technical interview",
  hr_round: "HR round",
  offer_drafted: "Offer in preparation",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  recruiter_rejected: "Not moving forward",
  withdrawn: "Withdrawn",
};

interface TransitionEmailContext {
  candidateId: string;
  candidateName: string;
  candidateEmail: string;
  positionTitle: string;
  companyName: string;
}

async function fetchTransitionEmailContext(
  db: NonNullable<HonoTRPCContext["db"]>,
  applicationId: string,
): Promise<TransitionEmailContext | null> {
  const [row] = await db
    .select({
      candidateId: candidates.id,
      candidateName: persons.fullName,
      candidateEmail: persons.emailPrimary,
      positionTitle: positions.title,
      companyName: tenants.displayName,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .innerJoin(tenants, eq(tenants.id, applications.tenantId))
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!row || !row.candidateEmail) return null;
  return {
    candidateId: row.candidateId,
    candidateName: row.candidateName ?? "there",
    candidateEmail: row.candidateEmail,
    positionTitle: row.positionTitle,
    companyName: row.companyName,
  };
}

async function fetchPositionTitleForRequisition(requisitionId: string): Promise<string> {
  const [row] = await poolDb
    .select({ title: positions.title })
    .from(requisitions)
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .where(eq(requisitions.id, requisitionId))
    .limit(1);
  return row?.title ?? "the role you applied to";
}

async function fetchTenantDisplayName(tenantId: string): Promise<string> {
  const [row] = await poolDb
    .select({ name: tenants.displayName })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.name ?? "our team";
}

/**
 * Looks up the caller's tenant_user_memberships.id from their userId.
 * Stored as actor_membership_id on transitions for join-friendly audit
 * queries ("what did this recruiter do today"). Returns null if the
 * caller is somehow in the tenant via JWT but missing a membership row
 * — the procedure proceeds with NULL actor, which the column allows.
 */
async function resolveActorMembership(
  db: NonNullable<HonoTRPCContext["db"]>,
  ctx: HonoTRPCContext,
): Promise<string | null> {
  if (!ctx.userId || !ctx.tenantId) return null;
  const [row] = await db
    .select({ id: tenantUserMemberships.id })
    .from(tenantUserMemberships)
    .where(
      and(
        eq(tenantUserMemberships.userId, ctx.userId),
        eq(tenantUserMemberships.tenantId, ctx.tenantId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

// ─────────── REQ-02: requisition-creation helpers ───────────

/**
 * Sentinel jd_text for a freshly-created draft JD version. Detected at submit
 * time to require the hiring manager to actually generate/write a JD before
 * submission. jd_text is NOT NULL, so we can't leave it empty.
 */
const JD_DRAFT_PLACEHOLDER = "(draft — generate or write the job description)";

/** Slugify a free-text department into a business_unit slug. */
function slugifyDepartment(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length >= 2 ? slug : `bu-${slug}`;
}

// ─────────────── REQ-03: decision + posting helpers ───────────────

/**
 * Product decision → append-only approval_decision_outcome enum. The schema
 * enum is (approved | rejected | abstained); send_back has no first-class
 * outcome, so it maps to `abstained` ("declines to act without rejecting") and
 * the product-level intent is preserved in approval_decisions.metadata.decision.
 */
const DECISION_TO_OUTCOME: Record<
  "approve" | "send_back" | "reject",
  "approved" | "rejected" | "abstained"
> = { approve: "approved", send_back: "abstained", reject: "rejected" };

/**
 * Product decision → approval_request terminal status. send_back → `cancelled`
 * (the request is withdrawn/set-aside so the one-pending-per-subject partial
 * unique frees up and the hiring manager can resubmit a fresh request);
 * reject → `rejected`; approve → `approved`.
 */
const DECISION_TO_REQUEST_STATUS: Record<
  "approve" | "send_back" | "reject",
  "approved" | "rejected" | "cancelled"
> = { approve: "approved", send_back: "cancelled", reject: "rejected" };

/**
 * Product decision → requisition status. The requisition vocabulary has no
 * 'rejected'; a rejected req terminalises to `cancelled` (the error-toned
 * terminal in the status vocabulary — 'closed' is the neutral "hiring
 * completed" terminal, which is the wrong semantics for a rejection).
 * send_back returns the req to `draft` for revision.
 */
const DECISION_TO_REQUISITION_STATUS: Record<
  "approve" | "send_back" | "reject",
  "approved" | "draft" | "cancelled"
> = { approve: "approved", send_back: "draft", reject: "cancelled" };

/** Inverse of DECISION_TO_OUTCOME for read paths (getRequisitionDetail). REQ-03
 *  only ever writes these three outcomes against requisition approvals. */
function decisionOutcomeToKind(outcome: string): "approve" | "send_back" | "reject" {
  if (outcome === "approved") return "approve";
  if (outcome === "rejected") return "reject";
  return "send_back"; // abstained
}

/**
 * Build a human, URL-safe public_slug for a posted requisition: slugified
 * title + a short random suffix for uniqueness. Satisfies the requisitions
 * public_slug CHECK (`^[a-z0-9-]+$`, length 3–80). The suffix makes blind
 * collisions vanishingly unlikely; the caller still retries on the unique.
 */
function buildRequisitionSlug(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const suffix = Math.random()
    .toString(36)
    .slice(2, 8)
    .replace(/[^a-z0-9]/g, "");
  const safeSuffix = suffix.length >= 4 ? suffix : `${suffix}0000`.slice(0, 4);
  const stem = base.length >= 2 ? base : "req";
  return `${stem}-${safeSuffix}`.slice(0, 80);
}

/** Postgres unique-violation detector (SQLSTATE 23505), driver-tolerant. */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === "23505" || e.cause?.code === "23505";
}

interface DraftRequisitionFacet {
  requisitionId: string;
  status: string;
  positionId: string;
  title: string;
  locationType: string;
  primaryLocation: string | null;
  level: string | null;
  jdVersionId: string;
  jdText: string;
  jdSummary: string | null;
}

/**
 * Load the requisition + its position + its locked draft JD version in one
 * shot. Throws NOT_FOUND if the requisition doesn't exist (RLS-scoped).
 */
async function loadDraftRequisitionFacet(
  db: NonNullable<HonoTRPCContext["db"]>,
  requisitionId: string,
): Promise<DraftRequisitionFacet> {
  const [row] = await db
    .select({
      requisitionId: requisitions.id,
      status: requisitions.status,
      positionId: positions.id,
      title: positions.title,
      locationType: positions.locationType,
      primaryLocation: positions.primaryLocation,
      level: positions.level,
      jdVersionId: jdVersions.id,
      jdText: jdVersions.jdText,
      jdSummary: jdVersions.summary,
    })
    .from(requisitions)
    .innerJoin(
      positions,
      and(eq(requisitions.tenantId, positions.tenantId), eq(requisitions.positionId, positions.id)),
    )
    .innerJoin(
      jdVersions,
      and(
        eq(requisitions.tenantId, jdVersions.tenantId),
        eq(requisitions.jdVersionId, jdVersions.id),
      ),
    )
    .where(eq(requisitions.id, requisitionId))
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
  }
  return {
    requisitionId: row.requisitionId,
    status: row.status,
    positionId: row.positionId,
    title: row.title,
    locationType: row.locationType,
    primaryLocation: row.primaryLocation ?? null,
    level: row.level ?? null,
    jdVersionId: row.jdVersionId,
    jdText: row.jdText,
    jdSummary: row.jdSummary ?? null,
  };
}

/** Read the tenant's display name for the JD prompt (service-role pool). */
async function resolveTenantDisplayName(tenantId: string): Promise<string> {
  const [row] = await poolDb
    .select({ name: tenants.displayName })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.name ?? "the company";
}

/**
 * Compose a requisition_knockouts.threshold_value jsonb that the apply-flow
 * evaluator (@hireops/ai-scoring evaluateKnockouts) accepts: a `field_path`
 * plus the type-specific threshold key. Unknown/malformed inputs still
 * produce a shape the evaluator resolves to "not evaluable" (null) rather
 * than throwing.
 */
function buildKnockoutThreshold(k: RequisitionKnockoutInput): Record<string, unknown> {
  const base: Record<string, unknown> = { field_path: k.fieldPath };
  switch (k.type) {
    case "boolean":
      return { ...base, required: true };
    case "numeric_min":
      return { ...base, min: k.min ?? 0 };
    case "numeric_max":
      return { ...base, max: k.max ?? 0 };
    case "enum":
      return { ...base, allowed: k.allowed ?? [] };
    default:
      return base;
  }
}

/**
 * Resolve-or-create the tenant's single-step "HR Head approval" matrix for
 * requisitions, then create a fresh immutable chain from it and return the
 * chain id. Each submission gets its own chain (chains are immutable per
 * instance); the matrix is the reusable config. No matrices/chains are
 * seeded, so this is the honest minimal shape REQ-03 will decide against.
 */
async function resolveRequisitionApprovalChain(
  db: NonNullable<HonoTRPCContext["db"]>,
  tenantId: string,
  createdByMembershipId: string | null,
): Promise<string> {
  const RULES = {
    version: 1,
    steps: [{ approver_kind: "role", approver_ref: "hr_head", required: true }],
  };
  const RESOLVED_STEPS = [
    {
      step_index: 0,
      approver_kind: "role",
      approver_ref: "hr_head",
      required: true,
      order_index: 0,
    },
  ];

  const [existing] = await db
    .select({ id: approvalMatrices.id, rules: approvalMatrices.rules })
    .from(approvalMatrices)
    .where(
      and(eq(approvalMatrices.tenantId, tenantId), eq(approvalMatrices.subjectType, "requisition")),
    )
    .orderBy(desc(approvalMatrices.effectiveFrom))
    .limit(1);

  let matrixId = existing?.id;
  let matrixRules: unknown = existing?.rules;
  if (!matrixId) {
    const [created] = await db
      .insert(approvalMatrices)
      .values({
        tenantId,
        subjectType: "requisition",
        name: "Requisition approval — HR Head",
        rules: RULES,
        effectiveFrom: new Date(),
        createdByMembershipId,
      })
      .returning({ id: approvalMatrices.id, rules: approvalMatrices.rules });
    matrixId = created?.id;
    matrixRules = created?.rules;
  }
  if (!matrixId) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "approval_matrix resolution returned no row",
    });
  }

  const [chain] = await db
    .insert(approvalChains)
    .values({
      tenantId,
      matrixId,
      matrixVersionSnapshot: matrixRules ?? RULES,
      resolvedSteps: RESOLVED_STEPS,
    })
    .returning({ id: approvalChains.id });
  if (!chain) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "approval_chain insert returned no row",
    });
  }
  return chain.id;
}

// ─────────── Module 4: offer helpers ───────────

/**
 * Stages from which a recruiter can draft an offer. Today: only after
 * the HR round is done OR after a prior draft sits unfilled. Adjust if
 * product later wants to allow earlier drafts.
 */
const OFFER_DRAFTABLE_STAGES = new Set<ApplicationStage>(["hr_round", "offer_drafted"]);

interface OfferEmailContext {
  candidateId: string;
  candidateName: string;
  candidateEmail: string;
  positionTitle: string;
  companyName: string;
  currentStage: ApplicationStage;
}

async function fetchOfferEmailContext(
  db: NonNullable<HonoTRPCContext["db"]>,
  applicationId: string,
): Promise<OfferEmailContext | null> {
  const [row] = await db
    .select({
      candidateId: candidates.id,
      candidateName: persons.fullName,
      candidateEmail: persons.emailPrimary,
      positionTitle: positions.title,
      companyName: tenants.displayName,
      currentStage: applications.currentStage,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .innerJoin(tenants, eq(tenants.id, applications.tenantId))
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!row || !row.candidateEmail) return null;
  return {
    candidateId: row.candidateId,
    candidateName: row.candidateName ?? "there",
    candidateEmail: row.candidateEmail,
    positionTitle: row.positionTitle,
    companyName: row.companyName,
    currentStage: row.currentStage,
  };
}

/**
 * postgres-js returns timestamp columns as either Date or string
 * depending on driver mode (HANDOVER #79/#96). Coerce defensively.
 */
function toIsoString(val: Date | string | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  return new Date(val).toISOString();
}

/**
 * Format paise → "₹12,34,567" using en-IN grouping (lakh / crore).
 * Localised to the Indian rupee convention because that's the Wave 1
 * currency. Multi-currency Phase 3.
 */
export function formatPaiseAsInr(paise: bigint | number): string {
  const rupees = Number(BigInt(paise) / 100n);
  return `₹${rupees.toLocaleString("en-IN")}`;
}

// ─────────────────────── INT-02: interview helpers ───────────────────────

const INTERVIEW_MODE_LABEL: Record<string, string> = {
  video: "Video",
  onsite: "On-site",
  phone: "Phone",
};

/** UTC date-time → "2026-07-20 at 14:30 UTC" for the invitation email. */
function formatInterviewWhen(start: Date): string {
  const iso = start.toISOString();
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

/**
 * Fail BAD_REQUEST unless every id is an active membership in the tenant.
 * Used for both the plan's advisory default panel and a schedule's concrete
 * panel — the advisory uuid[] on interview_plans is intentionally NOT
 * FK-enforced, so validation happens here at write time.
 */
async function assertActiveMemberships(
  sql: HonoTRPCContext["sql"],
  tenantId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  // Service-role read with an explicit tenant filter. The RLS-scoped tx
  // must NOT be used here: tenant_user_memberships only carries a
  // self-select policy, so under caller RLS this helper could only ever
  // see the caller's own membership — paneling any OTHER member failed
  // with a spurious BAD_REQUEST (INT-04 discovery). Same discipline as
  // listTenantMemberships.
  const found = await sql<{ id: string }[]>`
    SELECT id FROM public.tenant_user_memberships
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${ids}::uuid[])
      AND status = 'active'
  `;
  const foundIds = new Set(found.map((r) => r.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Not active memberships in this tenant: ${missing.join(", ")}`,
    });
  }
}

async function resolveRequisitionId(
  db: NonNullable<HonoTRPCContext["db"]>,
  input: { requisitionId?: string; applicationId?: string },
): Promise<string> {
  if (input.requisitionId) return input.requisitionId;
  const [app] = await db
    .select({ requisitionId: applications.requisitionId })
    .from(applications)
    .where(eq(applications.id, input.applicationId ?? ""))
    .limit(1);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });
  return app.requisitionId;
}

interface PanelMemberView {
  membershipId: string;
  name: string | null;
  isLead: boolean;
  feedbackState: FeedbackState;
}

/**
 * interview panel → {membershipId, name, isLead, feedbackState}[] keyed by
 * interviewId. INT-03 added `feedbackState` (none/draft/submitted) via a
 * LEFT JOIN to interview_feedback per (interview, membership) — this powers
 * the recruiter scorecard-progress chips on both interview list surfaces.
 */
async function fetchInterviewPanels(
  db: NonNullable<HonoTRPCContext["db"]>,
  interviewIds: string[],
): Promise<Map<string, PanelMemberView[]>> {
  const map = new Map<string, PanelMemberView[]>();
  if (interviewIds.length === 0) return map;
  const rows = await db
    .select({
      interviewId: interviewPanelists.interviewId,
      membershipId: interviewPanelists.membershipId,
      isLead: interviewPanelists.isLead,
      name: users.displayName,
      feedbackId: interviewFeedback.id,
      feedbackSubmittedAt: interviewFeedback.submittedAt,
    })
    .from(interviewPanelists)
    .leftJoin(tenantUserMemberships, eq(tenantUserMemberships.id, interviewPanelists.membershipId))
    .leftJoin(users, eq(users.id, tenantUserMemberships.userId))
    .leftJoin(
      interviewFeedback,
      and(
        eq(interviewFeedback.interviewId, interviewPanelists.interviewId),
        eq(interviewFeedback.membershipId, interviewPanelists.membershipId),
      ),
    )
    .where(inArray(interviewPanelists.interviewId, interviewIds));
  for (const r of rows) {
    const list = map.get(r.interviewId) ?? [];
    list.push({
      membershipId: r.membershipId,
      name: r.name ?? null,
      isLead: r.isLead,
      feedbackState: deriveFeedbackState(r.feedbackId, r.feedbackSubmittedAt),
    });
    map.set(r.interviewId, list);
  }
  return map;
}

/** none = no row; draft = row with submitted_at NULL; submitted = stamped. */
function deriveFeedbackState(
  feedbackId: string | null,
  submittedAt: Date | string | null,
): FeedbackState {
  if (!feedbackId) return "none";
  return submittedAt ? "submitted" : "draft";
}

// ─────────────────────── panel persona helpers (INT-03) ───────────────────────

/** MY feedback state per interview id — for the "my interviews" list badges. */
async function fetchMyFeedbackStates(
  db: NonNullable<HonoTRPCContext["db"]>,
  membershipId: string,
  interviewIds: string[],
): Promise<Map<string, FeedbackState>> {
  const map = new Map<string, FeedbackState>();
  if (interviewIds.length === 0) return map;
  const rows = await db
    .select({
      interviewId: interviewFeedback.interviewId,
      id: interviewFeedback.id,
      submittedAt: interviewFeedback.submittedAt,
    })
    .from(interviewFeedback)
    .where(
      and(
        eq(interviewFeedback.membershipId, membershipId),
        inArray(interviewFeedback.interviewId, interviewIds),
      ),
    );
  for (const r of rows) {
    map.set(r.interviewId, deriveFeedbackState(r.id, r.submittedAt));
  }
  return map;
}

/**
 * PANEL-01 — the aggregate panel workboard for one panellist: the hero stat
 * strip, the pending-feedback list (completed/past interviews with no submitted
 * scorecard of mine, overdue-flagged), and the submitted list (my recommendation
 * + my scorecard's mean score). Every read is scoped to `tenantId` + the
 * caller's own `membershipId` — this is the "mine only" boundary the tests
 * assert. `avgScore` averages the numeric values of a scorecard jsonb blob.
 */
async function buildPanelDashboard(
  db: DashDb,
  tenantId: string,
  membershipId: string,
): Promise<GetPanelDashboardOutput> {
  const T = dsql`i.tenant_id = ${tenantId}::uuid`;
  const onPanel = dsql`EXISTS (SELECT 1 FROM public.interview_panelists p
    WHERE p.tenant_id = i.tenant_id AND p.interview_id = i.id AND p.membership_id = ${membershipId}::uuid)`;
  const myFeedbackDone = dsql`EXISTS (SELECT 1 FROM public.interview_feedback f
    WHERE f.tenant_id = i.tenant_id AND f.interview_id = i.id AND f.membership_id = ${membershipId}::uuid
      AND f.submitted_at IS NOT NULL)`;
  // Past its window (or explicitly completed) — the "ready for a scorecard" gate.
  const isPast = dsql`(i.status = 'completed' OR (i.scheduled_end IS NOT NULL AND i.scheduled_end < now()))`;

  const [todayInterviews, completedToday, inWindowNow, avgRows, pendingRows, submittedRows] =
    await Promise.all([
      dashScalar(
        db,
        dsql`SELECT count(*)::int AS n FROM public.interviews i
             WHERE ${T} AND ${onPanel} AND i.status <> 'cancelled'
               AND i.scheduled_start >= date_trunc('day', now())
               AND i.scheduled_start < date_trunc('day', now()) + interval '1 day'`,
      ),
      dashScalar(
        db,
        dsql`SELECT count(*)::int AS n FROM public.interviews i
             WHERE ${T} AND ${onPanel} AND i.status = 'completed'
               AND i.scheduled_start >= date_trunc('day', now())
               AND i.scheduled_start < date_trunc('day', now()) + interval '1 day'`,
      ),
      dashScalar(
        db,
        dsql`SELECT count(*)::int AS n FROM public.interviews i
             WHERE ${T} AND ${onPanel} AND i.status = 'scheduled'
               AND i.scheduled_start IS NOT NULL AND i.scheduled_end IS NOT NULL
               AND i.scheduled_start <= now() AND i.scheduled_end >= now()`,
      ),
      dashRows<{ avg: number | string | null }>(
        db,
        dsql`SELECT AVG(e.val)::float AS avg
             FROM public.interview_feedback f
             CROSS JOIN LATERAL jsonb_each(f.scorecard) AS kv(key, value)
             CROSS JOIN LATERAL (SELECT (kv.value #>> '{}')::numeric AS val
                                 WHERE jsonb_typeof(kv.value) = 'number') AS e
             WHERE f.tenant_id = ${tenantId}::uuid AND f.membership_id = ${membershipId}::uuid
               AND f.submitted_at IS NOT NULL`,
      ),
      dashRows<{
        interview_id: string;
        candidate_name: string | null;
        role_title: string;
        round_number: number;
        round_name: string;
        mode: string;
        scheduled_start: string | Date | null;
        completed_at: string | Date | null;
        overdue: boolean;
      }>(
        db,
        dsql`SELECT i.id::text AS interview_id, p.full_name AS candidate_name,
                    pos.title AS role_title, i.round_number, i.round_name, i.mode,
                    i.scheduled_start,
                    COALESCE(i.scheduled_end, i.scheduled_start) AS completed_at,
                    (COALESCE(i.scheduled_end, i.scheduled_start) < now() - interval '24 hours') AS overdue
             FROM public.interviews i
             JOIN public.applications a ON a.id = i.application_id
             JOIN public.candidates c ON c.id = a.candidate_id
             JOIN public.persons p ON p.id = c.person_id
             JOIN public.requisitions r ON r.id = i.requisition_id
             JOIN public.positions pos ON pos.id = r.position_id
             WHERE ${T} AND ${onPanel} AND i.status <> 'cancelled'
               AND ${isPast} AND NOT ${myFeedbackDone}
             ORDER BY completed_at ASC NULLS LAST`,
      ),
      dashRows<{
        interview_id: string;
        candidate_name: string | null;
        role_title: string;
        round_number: number;
        round_name: string;
        submitted_at: string | Date | null;
        recommendation: string | null;
        avg_score: number | string | null;
      }>(
        db,
        dsql`SELECT i.id::text AS interview_id, p.full_name AS candidate_name,
                    pos.title AS role_title, i.round_number, i.round_name,
                    f.submitted_at, f.recommendation,
                    (SELECT AVG(e.val)::float
                     FROM jsonb_each(f.scorecard) AS kv(key, value)
                     CROSS JOIN LATERAL (SELECT (kv.value #>> '{}')::numeric AS val
                                         WHERE jsonb_typeof(kv.value) = 'number') AS e) AS avg_score
             FROM public.interview_feedback f
             JOIN public.interviews i ON i.id = f.interview_id
             JOIN public.applications a ON a.id = i.application_id
             JOIN public.candidates c ON c.id = a.candidate_id
             JOIN public.persons p ON p.id = c.person_id
             JOIN public.requisitions r ON r.id = i.requisition_id
             JOIN public.positions pos ON pos.id = r.position_id
             WHERE f.tenant_id = ${tenantId}::uuid AND f.membership_id = ${membershipId}::uuid
               AND f.submitted_at IS NOT NULL
             ORDER BY f.submitted_at DESC`,
      ),
    ]);

  const avgRaw = avgRows[0]?.avg ?? null;
  const avgScoreGiven =
    avgRaw === null
      ? null
      : Math.round((typeof avgRaw === "string" ? Number(avgRaw) : avgRaw) * 10) / 10;

  const pending: PanelPendingFeedbackItem[] = pendingRows.map((r) => ({
    interviewId: r.interview_id,
    candidateName: r.candidate_name,
    roleTitle: r.role_title,
    roundNumber: r.round_number,
    roundName: r.round_name,
    mode: r.mode as "video" | "onsite" | "phone",
    scheduledStart: toIsoString(r.scheduled_start),
    completedAt: toIsoString(r.completed_at),
    overdue: Boolean(r.overdue),
  }));

  const submitted: PanelSubmittedFeedbackItem[] = submittedRows.map((r) => {
    const s = r.avg_score;
    const score = s === null ? null : Math.round((typeof s === "string" ? Number(s) : s) * 10) / 10;
    return {
      interviewId: r.interview_id,
      candidateName: r.candidate_name,
      roleTitle: r.role_title,
      roundNumber: r.round_number,
      roundName: r.round_name,
      submittedAt: toIsoString(r.submitted_at),
      recommendation: (r.recommendation as "strong_yes" | "yes" | "hold" | "no" | null) ?? null,
      avgScore: score,
    };
  });

  return {
    stats: {
      todayInterviews,
      pendingFeedback: pending.length,
      avgScoreGiven,
      completedToday,
      inWindowNow,
    },
    pending,
    submitted,
  };
}

/** Is this membership a panelist on this interview? Returns the row or null. */
async function findPanelistRow(
  db: NonNullable<HonoTRPCContext["db"]>,
  interviewId: string,
  membershipId: string,
): Promise<{ id: string; isLead: boolean } | null> {
  const [row] = await db
    .select({ id: interviewPanelists.id, isLead: interviewPanelists.isLead })
    .from(interviewPanelists)
    .where(
      and(
        eq(interviewPanelists.interviewId, interviewId),
        eq(interviewPanelists.membershipId, membershipId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** MY feedback row for an interview (the single per-panelist scorecard). */
async function findMyFeedbackRow(
  db: NonNullable<HonoTRPCContext["db"]>,
  interviewId: string,
  membershipId: string,
): Promise<{
  id: string;
  scorecard: unknown;
  strengths: string | null;
  concerns: string | null;
  notes: string | null;
  recommendation: string | null;
  submittedAt: Date | string | null;
} | null> {
  const [row] = await db
    .select({
      id: interviewFeedback.id,
      scorecard: interviewFeedback.scorecard,
      strengths: interviewFeedback.strengths,
      concerns: interviewFeedback.concerns,
      notes: interviewFeedback.notes,
      recommendation: interviewFeedback.recommendation,
      submittedAt: interviewFeedback.submittedAt,
    })
    .from(interviewFeedback)
    .where(
      and(
        eq(interviewFeedback.interviewId, interviewId),
        eq(interviewFeedback.membershipId, membershipId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * SUBMITTED feedback from OTHER interviews of the same application — the
 * prior-round disclosure on the brief. DELIBERATE partial disclosure: only
 * recommendation + strengths + concerns cross to the next panelist; the
 * per-criterion scores never leave the row (not selected here).
 */
async function fetchPriorRoundFeedback(
  db: NonNullable<HonoTRPCContext["db"]>,
  applicationId: string,
  excludeInterviewId: string,
): Promise<PriorRoundFeedback[]> {
  const rows = await db
    .select({
      interviewId: interviewFeedback.interviewId,
      roundNumber: interviews.roundNumber,
      roundName: interviews.roundName,
      panelistName: users.displayName,
      recommendation: interviewFeedback.recommendation,
      strengths: interviewFeedback.strengths,
      concerns: interviewFeedback.concerns,
      submittedAt: interviewFeedback.submittedAt,
    })
    .from(interviewFeedback)
    .innerJoin(interviews, eq(interviews.id, interviewFeedback.interviewId))
    .leftJoin(tenantUserMemberships, eq(tenantUserMemberships.id, interviewFeedback.membershipId))
    .leftJoin(users, eq(users.id, tenantUserMemberships.userId))
    .where(
      and(
        eq(interviews.applicationId, applicationId),
        dsql`${interviews.id} <> ${excludeInterviewId}`,
        dsql`${interviewFeedback.submittedAt} IS NOT NULL`,
      ),
    )
    .orderBy(interviews.roundNumber);
  return rows.map((r) => ({
    interviewId: r.interviewId,
    roundNumber: r.roundNumber,
    roundName: r.roundName,
    panelistName: r.panelistName ?? null,
    recommendation: (r.recommendation as "strong_yes" | "yes" | "hold" | "no" | null) ?? null,
    strengths: r.strengths,
    concerns: r.concerns,
    submittedAt: toIsoString(r.submittedAt),
  }));
}

/**
 * PANEL-02 — map a stored interview_prep row to the wire card. The jsonb
 * columns are re-validated by the api-types zod schema at the tRPC output
 * boundary, so a coarse cast here is safe. `generatedAt` reflects the last
 * regenerate (updated_at), falling back to created_at.
 */
function storedInterviewPrepToCard(row: {
  focusAreas: unknown;
  probingQuestions: unknown;
  model: string | null;
  promptVersion: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): InterviewPrepCard {
  return {
    focusAreas: Array.isArray(row.focusAreas)
      ? (row.focusAreas as InterviewPrepCard["focusAreas"])
      : [],
    probingQuestions: Array.isArray(row.probingQuestions) ? (row.probingQuestions as string[]) : [],
    model: row.model,
    promptVersion: row.promptVersion,
    generatedAt: toIsoString(row.updatedAt ?? row.createdAt),
  };
}

/**
 * INT-04 — the stage an interview belongs to, and the natural next stage the
 * recruiter is invited to advance to, both derived from the REAL
 * application_stage enum (no invented stages). The interview's stage is read
 * from its scorecard template: an `hr` round belongs to the hr_round stage,
 * every other template (technical / manager / general) to the tech_interview
 * stage. Forward step follows the enum's documented progression:
 *   tech_interview → hr_round → offer_drafted (the "offer-ready" stage; the
 *   offer itself stays a manual recruiter action from triage — out of scope).
 */
function interviewStageContext(scorecardTemplate: string | null): {
  belongsToStage: ApplicationStage;
  suggestedNextStage: ApplicationStage | null;
} {
  if (scorecardTemplate === "hr") {
    return { belongsToStage: "hr_round", suggestedNextStage: "offer_drafted" };
  }
  return { belongsToStage: "tech_interview", suggestedNextStage: "hr_round" };
}

/**
 * INT-04 — the recruiter decision summary for ONE interview: per-panelist FULL
 * scorecards (every criterion score — the read the panel brief hides across
 * rounds), recommendations, lead flags, and an honest computed roll-up (counts
 * per recommendation among submitted scorecards + the lead's recommendation as
 * the headline). Returns null when the interview doesn't exist. RLS scopes the
 * reads to the tenant; the caller's persona gate is enforced at the procedure.
 */
async function fetchInterviewDecisionSummary(
  db: NonNullable<HonoTRPCContext["db"]>,
  interviewId: string,
): Promise<GetInterviewDecisionSummaryOutput | null> {
  const [iv] = await db
    .select({
      id: interviews.id,
      requisitionId: interviews.requisitionId,
      roundNumber: interviews.roundNumber,
      roundName: interviews.roundName,
      status: interviews.status,
      scorecardTemplateSnapshot: interviews.scorecardTemplate,
    })
    .from(interviews)
    .where(eq(interviews.id, interviewId))
    .limit(1);
  if (!iv) return null;

  // Resolve the template (snapshot preferred; live plan round fallback) so the
  // criteria labels match what the panelist was scored against.
  let template = iv.scorecardTemplateSnapshot;
  if (!template) {
    const [planRound] = await db
      .select({ scorecardTemplate: interviewPlans.scorecardTemplate })
      .from(interviewPlans)
      .where(
        and(
          eq(interviewPlans.requisitionId, iv.requisitionId),
          eq(interviewPlans.roundNumber, iv.roundNumber),
        ),
      )
      .limit(1);
    template = planRound?.scorecardTemplate ?? "general";
  }
  const criteriaDefs = scorecardCriteriaFor(template);

  const rows = await db
    .select({
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
    .leftJoin(tenantUserMemberships, eq(tenantUserMemberships.id, interviewPanelists.membershipId))
    .leftJoin(users, eq(users.id, tenantUserMemberships.userId))
    .leftJoin(
      interviewFeedback,
      and(
        eq(interviewFeedback.interviewId, interviewPanelists.interviewId),
        eq(interviewFeedback.membershipId, interviewPanelists.membershipId),
      ),
    )
    .where(eq(interviewPanelists.interviewId, interviewId));

  const counts = { strong_yes: 0, yes: 0, hold: 0, no: 0 };
  let submittedCount = 0;
  let leadRecommendation: InterviewRecommendation | null = null;

  const panelists: DecisionPanelist[] = rows.map((r) => {
    const saved =
      r.scorecard && typeof r.scorecard === "object" ? (r.scorecard as Record<string, number>) : {};
    const rec = (r.recommendation as InterviewRecommendation | null) ?? null;
    const state = deriveFeedbackState(r.feedbackId, r.submittedAt);
    if (state === "submitted") {
      submittedCount += 1;
      if (rec && rec in counts) counts[rec] += 1;
      if (r.isLead) leadRecommendation = rec;
    }
    return {
      membershipId: r.membershipId,
      name: r.name ?? null,
      isLead: r.isLead,
      feedbackState: state,
      recommendation: rec,
      scorecard: criteriaDefs.map((c) => {
        const score = saved[c.key];
        return { key: c.key, label: c.label, score: typeof score === "number" ? score : null };
      }),
      strengths: r.strengths ?? null,
      concerns: r.concerns ?? null,
      notes: r.notes ?? null,
      submittedAt: toIsoString(r.submittedAt),
    };
  });

  return {
    interviewId: iv.id,
    roundNumber: iv.roundNumber,
    roundName: iv.roundName,
    status: iv.status as "scheduled" | "completed" | "cancelled" | "no_show",
    scorecardTemplate: template as "technical" | "manager" | "hr" | "general",
    panelists,
    rollup: {
      panelistCount: rows.length,
      submittedCount,
      counts,
      leadRecommendation,
    },
  };
}

/**
 * Shared read for the interview list surfaces (byApplication + upcoming).
 * Joins candidate name + role title and attaches the relational panel.
 * Ordered scheduled_start DESC, id DESC (keyset-compatible).
 */
async function selectInterviewRows(
  db: NonNullable<HonoTRPCContext["db"]>,
  conds: SQL[],
  limit = 200,
): Promise<InterviewRow[]> {
  const rows = await db
    .select({
      id: interviews.id,
      applicationId: interviews.applicationId,
      candidateId: applications.candidateId,
      requisitionId: interviews.requisitionId,
      roundNumber: interviews.roundNumber,
      roundName: interviews.roundName,
      status: interviews.status,
      scheduledStart: interviews.scheduledStart,
      scheduledEnd: interviews.scheduledEnd,
      durationMinutes: interviews.durationMinutes,
      mode: interviews.mode,
      meetingUrl: interviews.meetingUrl,
      candidateConfirmedAt: interviews.candidateConfirmedAt,
      createdAt: interviews.createdAt,
      candidateName: persons.fullName,
      positionTitle: positions.title,
      // A13 honest slice — when the candidate interview-invitation (with the
      // .ics attachment) was enqueued for this interview. Reflects a REAL
      // notification_outbox row keyed by the schedule dedup_key.
      invitationSentAt: dsql<Date | null>`(
        SELECT n.created_at FROM public.notification_outbox n
        WHERE n.tenant_id = ${interviews.tenantId}
          AND n.dedup_key = 'interview_invitation:' || ${interviews.id}::text
        ORDER BY n.created_at DESC LIMIT 1
      )`,
    })
    .from(interviews)
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, interviews.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(interviews.scheduledStart), desc(interviews.id))
    .limit(limit);

  const panels = await fetchInterviewPanels(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    id: r.id,
    applicationId: r.applicationId,
    candidateId: r.candidateId,
    requisitionId: r.requisitionId,
    roundNumber: r.roundNumber,
    roundName: r.roundName,
    status: r.status as "scheduled" | "completed" | "cancelled" | "no_show",
    scheduledStart: toIsoString(r.scheduledStart),
    scheduledEnd: toIsoString(r.scheduledEnd),
    durationMinutes: r.durationMinutes,
    mode: r.mode as "video" | "onsite" | "phone",
    meetingUrl: r.meetingUrl,
    candidateConfirmedAt: toIsoString(r.candidateConfirmedAt),
    candidateName: r.candidateName,
    positionTitle: r.positionTitle,
    panel: panels.get(r.id) ?? [],
    createdAt: r.createdAt.toISOString(),
    invitationSentAt: toIsoString(r.invitationSentAt),
  }));
}

/**
 * Core scheduling: insert the interview from its plan round (with overrides),
 * mint the candidate confirm signed link (hash on the row, raw token only in
 * the email), insert the panel, and enqueue the invitation. A pre-existing
 * non-cancelled round for (application, round_number) surfaces as CONFLICT via
 * the partial-unique index — the caller should reschedule instead. Runs inside
 * the procedure's tenant-bound tx so link + panel + email commit atomically
 * with the interview (an email-enqueue failure is logged, not fatal).
 */
async function doScheduleRound(
  db: NonNullable<HonoTRPCContext["db"]>,
  ctx: HonoTRPCContext,
  input: {
    applicationId: string;
    roundNumber: number;
    scheduledStart: string;
    scheduledEnd?: string;
    durationMinutes?: number;
    mode?: "video" | "onsite" | "phone";
    meetingUrl?: string;
    panelMembershipIds: string[];
    leadMembershipId?: string;
  },
): Promise<{ interviewId: string; roundNumber: number; invitationSentTo: string | null }> {
  const [app] = await db
    .select({ tenantId: applications.tenantId, requisitionId: applications.requisitionId })
    .from(applications)
    .where(eq(applications.id, input.applicationId))
    .limit(1);
  if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "Application not found" });

  const [plan] = await db
    .select()
    .from(interviewPlans)
    .where(
      and(
        eq(interviewPlans.requisitionId, app.requisitionId),
        eq(interviewPlans.roundNumber, input.roundNumber),
      ),
    )
    .limit(1);
  if (!plan) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `No interview plan round ${input.roundNumber} on this requisition. Define the plan first.`,
    });
  }

  const panelIds = [...new Set(input.panelMembershipIds)];
  await assertActiveMemberships(ctx.sql, app.tenantId, panelIds);

  const createdByMembershipId = await resolveActorMembership(db, ctx);
  if (!createdByMembershipId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Scheduling membership not found for this tenant",
    });
  }

  // Pre-check the "one non-cancelled round per (application, round)" rule so
  // a clean CONFLICT is returned deterministically. The partial-unique index
  // is the race backstop below — but a failed insert poisons the surrounding
  // tx (postgres aborts it), which would mask a CONFLICT thrown afterwards, so
  // we catch the common case here first.
  const [clash] = await db
    .select({ id: interviews.id })
    .from(interviews)
    .where(
      and(
        eq(interviews.applicationId, input.applicationId),
        eq(interviews.roundNumber, input.roundNumber),
        dsql`${interviews.status} <> 'cancelled'`,
      ),
    )
    .limit(1);
  if (clash) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `A non-cancelled interview already exists for round ${input.roundNumber}. Reschedule it instead.`,
    });
  }

  const mode = input.mode ?? (plan.mode as "video" | "onsite" | "phone");
  const durationMinutes = input.durationMinutes ?? plan.durationMinutes;
  const scheduledStart = new Date(input.scheduledStart);
  const scheduledEnd = input.scheduledEnd
    ? new Date(input.scheduledEnd)
    : new Date(scheduledStart.getTime() + durationMinutes * 60_000);

  let interviewId: string;
  try {
    const [created] = await db
      .insert(interviews)
      .values({
        tenantId: app.tenantId,
        applicationId: input.applicationId,
        requisitionId: app.requisitionId,
        roundNumber: input.roundNumber,
        roundName: plan.roundName,
        status: "scheduled",
        // INT-04: snapshot the scorecard template from the plan round at
        // schedule time (migration 0055) so a later plan edit can't drift the
        // criteria this interview is scored against.
        scorecardTemplate: plan.scorecardTemplate,
        scheduledStart,
        scheduledEnd,
        durationMinutes,
        mode,
        meetingUrl: input.meetingUrl ?? null,
        createdByMembershipId,
      })
      .returning({ id: interviews.id });
    if (!created) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "interview insert returned no row",
      });
    }
    interviewId = created.id;
  } catch (err) {
    // Drizzle wraps the driver error in DrizzleQueryError, so the pg SQLSTATE
    // lands on `.cause` — isUniqueViolation checks both levels.
    if (isUniqueViolation(err)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `A non-cancelled interview already exists for round ${input.roundNumber}. Reschedule it instead.`,
      });
    }
    throw err;
  }

  // Mint the confirm link AFTER the insert so subjectId is the real row id.
  // Expires 24h past the interview start (and always in the future).
  const expiresAt = new Date(Math.max(scheduledStart.getTime(), Date.now()) + 24 * 60 * 60 * 1000);
  const token = signLink({
    action: "candidate.confirm_interview",
    subjectId: interviewId,
    expiresAt,
  });
  const tokenHash = hashToken(token);
  await db
    .update(interviews)
    .set({ confirmSignedLinkTokenHash: tokenHash, updatedAt: new Date() })
    .where(eq(interviews.id, interviewId));

  await db.insert(interviewPanelists).values(
    panelIds.map((membershipId) => ({
      tenantId: app.tenantId,
      interviewId,
      membershipId,
      isLead: membershipId === input.leadMembershipId,
    })),
  );

  let invitationSentTo: string | null = null;
  const meta = await fetchOfferEmailContext(db, input.applicationId);
  if (meta) {
    const portalBase = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002";
    const confirmUrl = `${portalBase}/interviews/confirm/${token}`;
    try {
      await enqueueNotification(db, {
        tenantId: app.tenantId,
        recipientType: "candidate",
        recipientEmail: meta.candidateEmail,
        recipientCandidateId: meta.candidateId,
        templateKey: "candidate.interview_invitation",
        templateData: {
          candidateName: meta.candidateName,
          companyName: meta.companyName,
          positionTitle: meta.positionTitle,
          roundName: plan.roundName,
          interviewWhenFormatted: formatInterviewWhen(scheduledStart),
          modeLabel: INTERVIEW_MODE_LABEL[mode] ?? mode,
          durationMinutes,
          meetingUrl: input.meetingUrl ?? "",
          confirmUrl,
          // A13 honest slice — the raw start ISO + a stable id let the template
          // build a REAL .ics VEVENT (deterministic, no third-party API) and
          // attach it. The candidate's mail client offers a genuine
          // "add to calendar", not a fake two-way sync.
          interviewStartIso: scheduledStart.toISOString(),
          interviewId,
        },
        dedupKey: `interview_invitation:${interviewId}`,
      });
      invitationSentTo = meta.candidateEmail;
    } catch (err) {
      ctx.log.warn(
        { err, request_id: ctx.requestId, interview_id: interviewId },
        "doScheduleRound: enqueueNotification failed",
      );
    }
  }

  return { interviewId, roundNumber: input.roundNumber, invitationSentTo };
}

/**
 * Keyset cursor for listUpcomingInterviews — (scheduled_start, id) of the
 * page's last row. Same base64url codec shape as the audit cursor.
 */
function encodeInterviewCursor(scheduledStartIso: string, id: string): string {
  return Buffer.from(`${scheduledStartIso}|${id}`, "utf8").toString("base64url");
}
function decodeInterviewCursor(
  cursor: string | undefined,
): { scheduledStart: string; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep === -1) return null;
    return { scheduledStart: raw.slice(0, sep), id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

// ═══════════════════ HROPS-01 — HR Ops case helpers ═══════════════════

/** The HR-Ops case window as a Set + ordered list (matches hrCaseStageSchema). */
const HR_CASE_STAGES = new Set<ApplicationStage>([
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
]);
const HR_CASE_STAGE_LIST: ApplicationStage[] = [
  "tech_interview",
  "hr_round",
  "offer_drafted",
  "offer_accepted",
];

type InterviewRec = "strong_yes" | "yes" | "hold" | "no";
type HrRec = "proceed" | "hold" | "reject";

/** Map a stored hr_round_assessments row → the API assessment shape. */
function hrAssessmentToApi(
  row: typeof hrRoundAssessments.$inferSelect,
  completedByName: string | null | undefined,
): HrRoundAssessment {
  return {
    id: row.id,
    applicationId: row.applicationId,
    motivationDiscussed: row.motivationDiscussed,
    salaryExpectationDiscussed: row.salaryExpectationDiscussed,
    cultureFitAssessed: row.cultureFitAssessed,
    workAuthorizationVerified: row.workAuthorizationVerified,
    noticePeriodConfirmed: row.noticePeriodConfirmed,
    relocationWillingness: row.relocationWillingness,
    notes: row.notes,
    rating: row.rating,
    recommendation: row.recommendation as HrRec,
    completedByMembershipId: row.completedByMembershipId,
    completedByName: completedByName ?? null,
    createdAt: toIsoString(row.createdAt) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updatedAt) ?? new Date().toISOString(),
  };
}

/**
 * Per-round interview results for a set of applications, ordered by round. One
 * entry per non-cancelled interview; `recommendation` is the LATEST submitted
 * panelist recommendation for that round (NO scores — anti-anchoring).
 */
async function fetchHrRoundResults(
  db: NonNullable<HonoTRPCContext["db"]>,
  applicationIds: string[],
): Promise<Map<string, HrRoundResult[]>> {
  const out = new Map<string, HrRoundResult[]>();
  if (applicationIds.length === 0) return out;
  const rows = await db
    .select({
      applicationId: interviews.applicationId,
      interviewId: interviews.id,
      roundNumber: interviews.roundNumber,
      roundName: interviews.roundName,
      scorecardTemplate: interviews.scorecardTemplate,
      status: interviews.status,
      recommendation: interviewFeedback.recommendation,
      submittedAt: interviewFeedback.submittedAt,
    })
    .from(interviews)
    .leftJoin(
      interviewFeedback,
      and(
        eq(interviewFeedback.interviewId, interviews.id),
        dsql`${interviewFeedback.submittedAt} IS NOT NULL`,
      ),
    )
    .where(
      and(inArray(interviews.applicationId, applicationIds), ne(interviews.status, "cancelled")),
    )
    .orderBy(interviews.roundNumber, desc(interviewFeedback.submittedAt));
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.interviewId)) continue;
    seen.add(r.interviewId);
    const result: HrRoundResult = {
      interviewId: r.interviewId,
      roundNumber: r.roundNumber,
      roundName: r.roundName,
      scorecardTemplate: r.scorecardTemplate,
      status: r.status,
      recommendation: (r.recommendation as InterviewRec | null) ?? null,
    };
    const arr = out.get(r.applicationId) ?? [];
    arr.push(result);
    out.set(r.applicationId, arr);
  }
  return out;
}

/** Saved HR-round assessments for a set of applications, keyed by application. */
async function fetchHrAssessments(
  db: NonNullable<HonoTRPCContext["db"]>,
  applicationIds: string[],
): Promise<Map<string, typeof hrRoundAssessments.$inferSelect>> {
  const out = new Map<string, typeof hrRoundAssessments.$inferSelect>();
  if (applicationIds.length === 0) return out;
  const rows = await db
    .select()
    .from(hrRoundAssessments)
    .where(inArray(hrRoundAssessments.applicationId, applicationIds));
  for (const r of rows) out.set(r.applicationId, r);
  return out;
}

/** The HR-case list + hero stats (stats over the whole window, rows filtered). */
async function buildHrCaseList(
  db: NonNullable<HonoTRPCContext["db"]>,
  ctx: HonoTRPCContext,
  tenantId: string,
  search: string | null,
  stageFilter: HrCaseStage | null,
): Promise<ListHrCasesOutput> {
  const appRows = await db
    .select({
      applicationId: applications.id,
      candidateId: applications.candidateId,
      stage: applications.currentStage,
      aiScore: applications.aiScore,
      stageEnteredAt: applications.stageEnteredAt,
      assignedRecruiterMembershipId: applications.assignedRecruiterMembershipId,
      candidateName: persons.fullName,
      roleTitle: positions.title,
      compBandMin: positions.compBandMin,
      compBandMax: positions.compBandMax,
      compCurrency: positions.compCurrency,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .where(inArray(applications.currentStage, HR_CASE_STAGE_LIST))
    .orderBy(desc(applications.stageEnteredAt));

  const appIds = appRows.map((r) => r.applicationId);
  const [roundResults, assessments] = await Promise.all([
    fetchHrRoundResults(db, appIds),
    fetchHrAssessments(db, appIds),
  ]);
  const recruiterIds = appRows
    .map((r) => r.assignedRecruiterMembershipId)
    .filter((id): id is string => !!id);
  const names = await resolveMembershipNames(ctx, tenantId, recruiterIds);

  const allRows: HrCaseListRow[] = appRows.map((r) => {
    const assessment = assessments.get(r.applicationId) ?? null;
    return {
      applicationId: r.applicationId,
      candidateId: r.candidateId,
      candidateName: r.candidateName,
      roleTitle: r.roleTitle,
      stage: r.stage as HrCaseStage,
      aiScore: r.aiScore != null ? Number(r.aiScore) : null,
      roundResults: roundResults.get(r.applicationId) ?? [],
      salaryBand: formatBudgetBand(r.compBandMin, r.compBandMax, r.compCurrency),
      assignedRecruiterName: r.assignedRecruiterMembershipId
        ? (names.get(r.assignedRecruiterMembershipId) ?? null)
        : null,
      lastActivityAt: toIsoString(r.stageEnteredAt) ?? new Date().toISOString(),
      hrRoundPending: r.stage === "hr_round" && !assessment,
      hasAssessment: !!assessment,
      assessmentRecommendation: assessment ? (assessment.recommendation as HrRec) : null,
      assessmentRating: assessment ? assessment.rating : null,
    };
  });

  const stats = {
    total: allRows.length,
    hrRoundPending: allRows.filter((r) => r.hrRoundPending).length,
    offerStage: allRows.filter((r) => r.stage === "offer_drafted").length,
    accepted: allRows.filter((r) => r.stage === "offer_accepted").length,
  };

  const needle = search?.trim().toLowerCase() ?? "";
  const rows = allRows.filter((r) => {
    if (stageFilter && r.stage !== stageFilter) return false;
    if (needle) {
      const hay = `${r.candidateName ?? ""} ${r.roleTitle ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  return { rows, stats };
}

/** Prior-round feedback cards for one application — recommendation + summary
 *  text (strengths / concerns / notes), NO scores. Ordered by round. */
async function fetchHrCaseFeedbackCards(
  db: NonNullable<HonoTRPCContext["db"]>,
  applicationId: string,
): Promise<HrCaseFeedbackCard[]> {
  const rows = await db
    .select({
      interviewId: interviewFeedback.interviewId,
      roundNumber: interviews.roundNumber,
      roundName: interviews.roundName,
      panelistName: users.displayName,
      recommendation: interviewFeedback.recommendation,
      strengths: interviewFeedback.strengths,
      concerns: interviewFeedback.concerns,
      notes: interviewFeedback.notes,
      submittedAt: interviewFeedback.submittedAt,
    })
    .from(interviewFeedback)
    .innerJoin(interviews, eq(interviews.id, interviewFeedback.interviewId))
    .leftJoin(tenantUserMemberships, eq(tenantUserMemberships.id, interviewFeedback.membershipId))
    .leftJoin(users, eq(users.id, tenantUserMemberships.userId))
    .where(
      and(
        eq(interviews.applicationId, applicationId),
        dsql`${interviewFeedback.submittedAt} IS NOT NULL`,
      ),
    )
    .orderBy(interviews.roundNumber);
  return rows.map((r) => ({
    interviewId: r.interviewId,
    roundNumber: r.roundNumber,
    roundName: r.roundName,
    panelistName: r.panelistName ?? null,
    recommendation: (r.recommendation as InterviewRec | null) ?? null,
    strengths: r.strengths,
    concerns: r.concerns,
    notes: r.notes,
    submittedAt: toIsoString(r.submittedAt),
  }));
}

/** One HR case in full — candidate card, pipeline, feedback, assessment. */
async function buildHrCaseDetail(
  db: NonNullable<HonoTRPCContext["db"]>,
  ctx: HonoTRPCContext,
  tenantId: string,
  applicationId: string,
): Promise<GetHrCaseDetailOutput> {
  const [app] = await db
    .select({
      applicationId: applications.id,
      candidateId: applications.candidateId,
      stage: applications.currentStage,
      aiScore: applications.aiScore,
      stageEnteredAt: applications.stageEnteredAt,
      assignedRecruiterMembershipId: applications.assignedRecruiterMembershipId,
      candidateName: persons.fullName,
      email: persons.emailPrimary,
      phone: persons.phonePrimary,
      locationCity: persons.locationCity,
      locationCountry: persons.locationCountry,
      linkedinUrl: persons.linkedinUrl,
      yearsOfExperience: candidates.yearsOfExperience,
      parsedSkills: candidates.parsedSkills,
      roleTitle: positions.title,
      department: businessUnits.name,
      compBandMin: positions.compBandMin,
      compBandMax: positions.compBandMax,
      compCurrency: positions.compCurrency,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .leftJoin(businessUnits, eq(businessUnits.id, positions.businessUnitId))
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app || !HR_CASE_STAGES.has(app.stage)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "HR case not found" });
  }

  // Reads candidate PII — mirror the getCandidateById / panel-brief PII log.
  const membershipId = await resolveActorMembership(db, ctx);
  recordPiiAccess({
    tenantId,
    actorUserId: ctx.userId,
    actorMembershipId: membershipId,
    actorLabel: "user",
    entityType: "candidate",
    entityId: app.candidateId,
    fieldsAccessed: [
      "persons.full_name",
      "persons.email_primary",
      "persons.phone_primary",
      "persons.location_country",
    ],
    reason: "get_hr_case_detail",
    requestId: ctx.requestId,
  });

  const [roundResults, feedback, assessments] = await Promise.all([
    fetchHrRoundResults(db, [applicationId]),
    fetchHrCaseFeedbackCards(db, applicationId),
    fetchHrAssessments(db, [applicationId]),
  ]);
  const assessment = assessments.get(applicationId) ?? null;

  const nameIds = [app.assignedRecruiterMembershipId, assessment?.completedByMembershipId].filter(
    (id): id is string => !!id,
  );
  const names = await resolveMembershipNames(ctx, tenantId, nameIds);

  return {
    candidate: {
      candidateId: app.candidateId,
      name: app.candidateName,
      email: app.email,
      phone: app.phone,
      locationCity: app.locationCity,
      locationCountry: app.locationCountry,
      linkedinUrl: app.linkedinUrl,
      yearsOfExperience: app.yearsOfExperience != null ? Number(app.yearsOfExperience) : null,
      parsedSkills: Array.isArray(app.parsedSkills) ? (app.parsedSkills as string[]) : [],
    },
    pipeline: {
      stage: app.stage as HrCaseStage,
      aiScore: app.aiScore != null ? Number(app.aiScore) : null,
      roleTitle: app.roleTitle,
      department: app.department ?? null,
      salaryBand: formatBudgetBand(app.compBandMin, app.compBandMax, app.compCurrency),
      assignedRecruiterName: app.assignedRecruiterMembershipId
        ? (names.get(app.assignedRecruiterMembershipId) ?? null)
        : null,
      roundResults: roundResults.get(applicationId) ?? [],
      stageEnteredAt: toIsoString(app.stageEnteredAt) ?? new Date().toISOString(),
    },
    interviewFeedback: feedback,
    assessment: assessment
      ? hrAssessmentToApi(
          assessment,
          assessment.completedByMembershipId ? names.get(assessment.completedByMembershipId) : null,
        )
      : null,
    advanceRequiresAssessment: app.stage === "hr_round",
  };
}

/** The HR-round scheduler view — HR-round interviews + pending hr_round cases. */
async function buildHrRoundsList(
  db: NonNullable<HonoTRPCContext["db"]>,
  ctx: HonoTRPCContext,
  tenantId: string,
): Promise<ListHrRoundsOutput> {
  // Every HR-case application (for candidate/role + pending detection).
  const appRows = await db
    .select({
      applicationId: applications.id,
      stage: applications.currentStage,
      candidateName: persons.fullName,
      roleTitle: positions.title,
    })
    .from(applications)
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(persons, eq(persons.id, candidates.personId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(positions, eq(positions.id, requisitions.positionId))
    .where(inArray(applications.currentStage, HR_CASE_STAGE_LIST));
  const appById = new Map(appRows.map((r) => [r.applicationId, r]));
  const appIds = appRows.map((r) => r.applicationId);

  // HR-round interviews (scorecard_template 'hr'), non-cancelled.
  const ivRows =
    appIds.length === 0
      ? []
      : await db
          .select({
            interviewId: interviews.id,
            applicationId: interviews.applicationId,
            scheduledStart: interviews.scheduledStart,
            mode: interviews.mode,
            status: interviews.status,
            createdByMembershipId: interviews.createdByMembershipId,
          })
          .from(interviews)
          .where(
            and(
              inArray(interviews.applicationId, appIds),
              eq(interviews.scorecardTemplate, "hr"),
              ne(interviews.status, "cancelled"),
            ),
          )
          .orderBy(desc(interviews.scheduledStart));

  const assessments = await fetchHrAssessments(db, appIds);
  const ownerIds = ivRows.map((r) => r.createdByMembershipId).filter((id): id is string => !!id);
  const names = await resolveMembershipNames(ctx, tenantId, ownerIds);

  const rows: HrRoundRow[] = [];
  const appsWithHrInterview = new Set<string>();
  for (const iv of ivRows) {
    appsWithHrInterview.add(iv.applicationId);
    const app = appById.get(iv.applicationId);
    const assessment = assessments.get(iv.applicationId) ?? null;
    rows.push({
      interviewId: iv.interviewId,
      applicationId: iv.applicationId,
      candidateName: app?.candidateName ?? null,
      roleTitle: app?.roleTitle ?? null,
      scheduledStart: toIsoString(iv.scheduledStart),
      mode: iv.mode,
      ownerName: iv.createdByMembershipId ? (names.get(iv.createdByMembershipId) ?? null) : null,
      status: iv.status,
      rating: assessment ? assessment.rating : null,
      hasAssessment: !!assessment,
      assessmentRecommendation: assessment ? (assessment.recommendation as HrRec) : null,
    });
  }

  // Pending: an application sitting at hr_round with no HR interview scheduled.
  let pendingCount = 0;
  for (const app of appRows) {
    if (app.stage !== "hr_round") continue;
    if (appsWithHrInterview.has(app.applicationId)) continue;
    pendingCount += 1;
    const assessment = assessments.get(app.applicationId) ?? null;
    rows.push({
      interviewId: null,
      applicationId: app.applicationId,
      candidateName: app.candidateName,
      roleTitle: app.roleTitle,
      scheduledStart: null,
      mode: null,
      ownerName: null,
      status: "pending",
      rating: assessment ? assessment.rating : null,
      hasAssessment: !!assessment,
      assessmentRecommendation: assessment ? (assessment.recommendation as HrRec) : null,
    });
  }

  const stats = {
    total: rows.length,
    scheduled: rows.filter((r) => r.status === "scheduled").length,
    completed: rows.filter((r) => r.status === "completed").length,
    pending: pendingCount,
  };
  return { rows, stats };
}

// ═══════════ RO-03 — requisition-scope + insights builders ═══════════

type InsightsDb = NonNullable<HonoTRPCContext["db"]>;

/**
 * The set of requisitions the caller "owns" for the hiring-manager surfaces:
 * requisitions.hiring_manager_id = the caller's membership. admin, the
 * super-role, gets EVERY requisition in the tenant (RLS already scopes to the
 * tenant, so a plain unfiltered select is correct there). Returns the id list
 * so callers can `inArray(...)` or membership-check a single id.
 */
async function resolveMyRequisitionScope(
  db: InsightsDb,
  ctx: HonoTRPCContext,
): Promise<{ ids: string[]; isAdmin: boolean; membershipId: string | null }> {
  const isAdmin = ctx.roles.includes("admin");
  const membershipId = await resolveActorMembership(db, ctx);
  const rows = await db
    .select({ id: requisitions.id, hm: requisitions.hiringManagerId })
    .from(requisitions);
  const ids = rows
    .filter((r) => isAdmin || (membershipId != null && r.hm === membershipId))
    .map((r) => r.id);
  return { ids, isAdmin, membershipId };
}

const INSIGHTS_TERMINAL_STAGES = new Set<ApplicationStage>([
  "offer_accepted",
  "offer_declined",
  "withdrawn",
  "recruiter_rejected",
]);

/** Mean of a scorecard's numeric criterion values (1..5), or null if empty. */
function scorecardMean(scorecard: unknown): number | null {
  if (!scorecard || typeof scorecard !== "object") return null;
  const nums = Object.values(scorecard as Record<string, unknown>).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Case-insensitive skill tokens from a candidate's parsed_skills.skills array. */
function parsedSkillTokens(parsed: unknown): Set<string> {
  const out = new Set<string>();
  if (parsed && typeof parsed === "object") {
    const skills = (parsed as Record<string, unknown>).skills;
    if (Array.isArray(skills)) {
      for (const s of skills) {
        if (typeof s === "string") out.add(s.trim().toLowerCase());
      }
    }
  }
  return out;
}

async function buildRequisitionInsights(
  db: InsightsDb,
  ctx: HonoTRPCContext,
  requisitionId: string | null,
): Promise<GetRequisitionInsightsOutput> {
  const scope = await resolveMyRequisitionScope(db, ctx);

  // Requisition selector — my reqs, newest first.
  const optionRows =
    scope.ids.length > 0
      ? await db
          .select({
            id: requisitions.id,
            title: positions.title,
            createdAt: requisitions.createdAt,
          })
          .from(requisitions)
          .innerJoin(
            positions,
            and(
              eq(requisitions.tenantId, positions.tenantId),
              eq(requisitions.positionId, positions.id),
            ),
          )
          .where(inArray(requisitions.id, scope.ids))
          .orderBy(desc(requisitions.createdAt))
      : [];
  const reqOptions = optionRows.map((r) => ({ id: r.id, title: r.title ?? null }));

  let single = false;
  let targetIds = scope.ids;
  if (requisitionId) {
    if (!scope.ids.includes(requisitionId)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
    }
    single = true;
    targetIds = [requisitionId];
  }

  const scopeLabel = single ? ("single" as const) : ("all" as const);
  const emptyScoreDist = [
    { key: "excellent" as const, label: "Excellent", range: "85–100", count: 0 },
    { key: "good" as const, label: "Good", range: "70–84", count: 0 },
    { key: "partial" as const, label: "Partial", range: "50–69", count: 0 },
    { key: "low" as const, label: "Low", range: "0–49", count: 0 },
  ];
  const emptySla = (Object.entries(SLA_THRESHOLDS_HOURS) as [ApplicationStage, number | null][])
    .filter(([, h]) => h !== null)
    .map(([stage, h]) => ({
      stage,
      avgAgeHours: null,
      targetHours: h,
      breach: false,
      count: 0,
    }));

  if (targetIds.length === 0) {
    return {
      scope: scopeLabel,
      selectedRequisitionId: requisitionId,
      reqOptions,
      kpis: {
        avgTimeToHireDays: null,
        fillRate: { hires: 0, openings: 0 },
        activeCandidates: 0,
        offerAcceptRate: { accepted: 0, extended: 0 },
      },
      funnel: applicationStageEnum.enumValues.map((stage) => ({
        stage,
        count: 0,
        dropOffPct: null,
      })),
      scoreDistribution: emptyScoreDist,
      skillGap: [],
      salaryBand: null,
      slaTiles: emptySla,
      bottleneckNote: null,
      panelFeedbackTrends: [],
    };
  }

  // ── applications in scope ──
  const apps = await db
    .select({
      id: applications.id,
      candidateId: applications.candidateId,
      requisitionId: applications.requisitionId,
      currentStage: applications.currentStage,
      aiScore: applications.aiScore,
      stageEnteredAt: applications.stageEnteredAt,
      createdAt: applications.createdAt,
    })
    .from(applications)
    .where(inArray(applications.requisitionId, targetIds));

  const now = Date.now();

  // Funnel + drop-off (enum order).
  const countByStage = new Map<ApplicationStage, number>();
  for (const a of apps) {
    countByStage.set(a.currentStage, (countByStage.get(a.currentStage) ?? 0) + 1);
  }
  const funnel = applicationStageEnum.enumValues.map((stage, i) => {
    const count = countByStage.get(stage) ?? 0;
    let dropOffPct: number | null = null;
    const prevStage = i > 0 ? applicationStageEnum.enumValues[i - 1] : undefined;
    if (prevStage) {
      const prev = countByStage.get(prevStage) ?? 0;
      dropOffPct = prev > 0 ? Math.round(((prev - count) / prev) * 1000) / 10 : null;
    }
    return { stage, count, dropOffPct };
  });

  // Score distribution — real AI scores bucketed.
  const buckets = { excellent: 0, good: 0, partial: 0, low: 0 };
  for (const a of apps) {
    if (a.aiScore == null) continue;
    const s = Number(a.aiScore);
    if (s >= 85) buckets.excellent += 1;
    else if (s >= 70) buckets.good += 1;
    else if (s >= 50) buckets.partial += 1;
    else buckets.low += 1;
  }
  const scoreDistribution = [
    { key: "excellent" as const, label: "Excellent", range: "85–100", count: buckets.excellent },
    { key: "good" as const, label: "Good", range: "70–84", count: buckets.good },
    { key: "partial" as const, label: "Partial", range: "50–69", count: buckets.partial },
    { key: "low" as const, label: "Low", range: "0–49", count: buckets.low },
  ];

  // Active candidates (non-terminal stages).
  const activeCandidates = apps.filter((a) => !INSIGHTS_TERMINAL_STAGES.has(a.currentStage)).length;
  const hires = apps.filter((a) => a.currentStage === "offer_accepted").length;

  // Openings (fill rate denominator).
  const openingRows = await db
    .select({ openings: requisitions.numberOfOpenings })
    .from(requisitions)
    .where(inArray(requisitions.id, targetIds));
  const openings = openingRows.reduce((s, r) => s + (r.openings ?? 0), 0);

  // Historical average time-to-hire — days from application created to the
  // offer_accepted transition (labelled historical in the UI, never predicted).
  const appIds = apps.map((a) => a.id);
  const createdByApp = new Map(apps.map((a) => [a.id, a.createdAt.getTime()]));
  let avgTimeToHireDays: number | null = null;
  if (appIds.length > 0) {
    const accepts = await db
      .select({
        applicationId: applicationStateTransitions.applicationId,
        transitionedAt: applicationStateTransitions.transitionedAt,
      })
      .from(applicationStateTransitions)
      .where(
        and(
          inArray(applicationStateTransitions.applicationId, appIds),
          eq(applicationStateTransitions.toStage, "offer_accepted"),
        ),
      );
    const firstAcceptByApp = new Map<string, number>();
    for (const t of accepts) {
      const ts = t.transitionedAt.getTime();
      const prev = firstAcceptByApp.get(t.applicationId);
      if (prev === undefined || ts < prev) firstAcceptByApp.set(t.applicationId, ts);
    }
    const durations: number[] = [];
    for (const [appId, acceptedAt] of firstAcceptByApp) {
      const created = createdByApp.get(appId);
      if (created != null && acceptedAt >= created) {
        durations.push((acceptedAt - created) / 86_400_000);
      }
    }
    if (durations.length > 0) {
      avgTimeToHireDays =
        Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10;
    }
  }

  // Offer accept rate (accepted / extended) over in-scope applications.
  let acceptedOffers = 0;
  let extendedOffers = 0;
  if (appIds.length > 0) {
    const offerRows = await db
      .select({ status: offers.status, extendedAt: offers.extendedAt })
      .from(offers)
      .where(inArray(offers.applicationId, appIds));
    for (const o of offerRows) {
      const extended =
        o.extendedAt != null ||
        (o.status != null && ["extended", "accepted", "declined", "expired"].includes(o.status));
      if (extended) extendedOffers += 1;
      if (o.status === "accepted") acceptedOffers += 1;
    }
  }

  // SLA & bottleneck — per-stage average age of applications CURRENTLY in that
  // stage vs the sla-thresholds target.
  const ageByStage = new Map<ApplicationStage, { sum: number; n: number }>();
  for (const a of apps) {
    const ageHours = (now - a.stageEnteredAt.getTime()) / 3_600_000;
    const agg = ageByStage.get(a.currentStage) ?? { sum: 0, n: 0 };
    agg.sum += ageHours;
    agg.n += 1;
    ageByStage.set(a.currentStage, agg);
  }
  const slaTiles = (Object.entries(SLA_THRESHOLDS_HOURS) as [ApplicationStage, number | null][])
    .filter(([, h]) => h !== null)
    .map(([stage, target]) => {
      const agg = ageByStage.get(stage);
      const avgAgeHours = agg && agg.n > 0 ? Math.round((agg.sum / agg.n) * 10) / 10 : null;
      const breach = avgAgeHours != null && target != null && avgAgeHours > target;
      return { stage, avgAgeHours, targetHours: target, breach, count: agg?.n ?? 0 };
    });
  // Deterministic bottleneck note — the worst breaching stage by age/target.
  let bottleneckNote: string | null = null;
  const ratio = (t: { avgAgeHours: number | null; targetHours: number | null }): number =>
    t.avgAgeHours != null && t.targetHours != null && t.targetHours > 0
      ? t.avgAgeHours / t.targetHours
      : 0;
  const breaching = slaTiles
    .filter((t) => t.breach && t.targetHours != null)
    .sort((a, b) => ratio(b) - ratio(a));
  const worst = breaching[0];
  if (worst) {
    const label = worst.stage.replace(/_/g, " ");
    bottleneckNote = `${worst.count} candidate${worst.count === 1 ? "" : "s"} are sitting in "${label}" for ${worst.avgAgeHours}h on average — past the ${worst.targetHours}h SLA target. This is the current bottleneck.`;
  } else if (apps.length > 0) {
    bottleneckNote = "No stage is currently over its SLA target.";
  }

  // Skill gap — single-req only (a gap needs one JD to compare candidates to).
  let skillGap: GetRequisitionInsightsOutput["skillGap"] = [];
  let salaryBand: GetRequisitionInsightsOutput["salaryBand"] = null;
  if (single && requisitionId) {
    const [req] = await db
      .select({
        jdVersionId: requisitions.jdVersionId,
        title: positions.title,
        compBandMin: positions.compBandMin,
        compBandMax: positions.compBandMax,
        compCurrency: positions.compCurrency,
      })
      .from(requisitions)
      .innerJoin(
        positions,
        and(
          eq(requisitions.tenantId, positions.tenantId),
          eq(requisitions.positionId, positions.id),
        ),
      )
      .where(eq(requisitions.id, requisitionId))
      .limit(1);

    if (req) {
      const jdSkillRows = await db
        .select({ skillName: jdSkills.skillName, isRequired: jdSkills.isRequired })
        .from(jdSkills)
        .where(eq(jdSkills.jdVersionId, req.jdVersionId))
        .orderBy(desc(jdSkills.isRequired));

      const candidateIds = Array.from(new Set(apps.map((a) => a.candidateId)));
      const candRows =
        candidateIds.length > 0
          ? await db
              .select({ id: candidates.id, parsedSkills: candidates.parsedSkills })
              .from(candidates)
              .where(inArray(candidates.id, candidateIds))
          : [];
      const tokensByCandidate = candRows
        .filter((c) => c.parsedSkills != null)
        .map((c) => parsedSkillTokens(c.parsedSkills));
      const totalCandidates = tokensByCandidate.length;

      skillGap = jdSkillRows.map((s) => {
        const needle = s.skillName.trim().toLowerCase();
        let missing = 0;
        for (const toks of tokensByCandidate) {
          const has = Array.from(toks).some(
            (t) => t === needle || t.includes(needle) || needle.includes(t),
          );
          if (!has) missing += 1;
        }
        const gapPct =
          totalCandidates > 0 ? Math.round((missing / totalCandidates) * 1000) / 10 : 0;
        return {
          skillName: s.skillName,
          isRequired: s.isRequired,
          gapPct,
          candidatesMissing: missing,
          totalCandidates,
        };
      });

      // Salary band vs curated benchmark (labelled "Curated benchmarks").
      const benchRows = await db
        .select({
          roleTitle: marketBenchmarks.roleTitle,
          medianSalaryMinor: marketBenchmarks.medianSalaryMinor,
          currency: marketBenchmarks.currency,
          ttfDays: marketBenchmarks.ttfDays,
          sourceNote: marketBenchmarks.sourceNote,
        })
        .from(marketBenchmarks);
      const title = (req.title ?? "").trim().toLowerCase();
      const bench =
        benchRows.find((b) => b.roleTitle.trim().toLowerCase() === title) ??
        benchRows.find(
          (b) =>
            title.length > 0 &&
            (title.includes(b.roleTitle.trim().toLowerCase()) ||
              b.roleTitle.trim().toLowerCase().includes(title)),
        ) ??
        null;
      const budgetMin = req.compBandMin != null ? Number(req.compBandMin) : null;
      const budgetMax = req.compBandMax != null ? Number(req.compBandMax) : null;
      salaryBand = {
        currency: req.compCurrency ?? bench?.currency ?? "INR",
        budgetMin,
        budgetMax,
        // market_benchmarks stores MINOR units (paise); positions store MAJOR
        // (rupees). Convert minor→major so the bars share a scale.
        benchmarkMedian: bench ? Number(bench.medianSalaryMinor) / 100 : null,
        benchmarkTtfDays: bench ? bench.ttfDays : null,
        sourceNote: bench ? bench.sourceNote : null,
      };
    }
  }

  // Panel feedback trends — per completed round, aggregates only (NO panellist
  // identity ever leaves this procedure). Submitted scorecards only.
  const completedInterviews = await db
    .select({
      id: interviews.id,
      roundNumber: interviews.roundNumber,
      roundName: interviews.roundName,
    })
    .from(interviews)
    .where(and(inArray(interviews.requisitionId, targetIds), eq(interviews.status, "completed")));
  let panelFeedbackTrends: GetRequisitionInsightsOutput["panelFeedbackTrends"] = [];
  if (completedInterviews.length > 0) {
    const ivIds = completedInterviews.map((i) => i.id);
    const fb = await db
      .select({
        interviewId: interviewFeedback.interviewId,
        scorecard: interviewFeedback.scorecard,
        recommendation: interviewFeedback.recommendation,
        submittedAt: interviewFeedback.submittedAt,
      })
      .from(interviewFeedback)
      .where(inArray(interviewFeedback.interviewId, ivIds));
    const ivMeta = new Map(completedInterviews.map((i) => [i.id, i]));
    // group by roundNumber + roundName
    const byRound = new Map<
      string,
      {
        roundNumber: number;
        roundName: string;
        scores: number[];
        passes: number;
        submitted: number;
      }
    >();
    for (const f of fb) {
      if (f.submittedAt == null) continue; // aggregates over SUBMITTED only
      const meta = ivMeta.get(f.interviewId);
      if (!meta) continue;
      const key = `${meta.roundNumber}::${meta.roundName}`;
      const agg = byRound.get(key) ?? {
        roundNumber: meta.roundNumber,
        roundName: meta.roundName,
        scores: [] as number[],
        passes: 0,
        submitted: 0,
      };
      agg.submitted += 1;
      const mean = scorecardMean(f.scorecard);
      if (mean != null) agg.scores.push(mean);
      if (f.recommendation === "strong_yes" || f.recommendation === "yes") agg.passes += 1;
      byRound.set(key, agg);
    }
    panelFeedbackTrends = Array.from(byRound.values())
      .sort((a, b) => a.roundNumber - b.roundNumber)
      .map((r) => ({
        roundNumber: r.roundNumber,
        roundName: r.roundName,
        avgScore:
          r.scores.length > 0
            ? Math.round((r.scores.reduce((a, b) => a + b, 0) / r.scores.length) * 10) / 10
            : null,
        passRate: r.submitted > 0 ? Math.round((r.passes / r.submitted) * 1000) / 10 : null,
        submittedCount: r.submitted,
      }));
  }

  return {
    scope: scopeLabel,
    selectedRequisitionId: requisitionId,
    reqOptions,
    kpis: {
      avgTimeToHireDays,
      fillRate: { hires, openings },
      activeCandidates,
      offerAcceptRate: { accepted: acceptedOffers, extended: extendedOffers },
    },
    funnel,
    scoreDistribution,
    skillGap,
    salaryBand,
    slaTiles,
    bottleneckNote,
    panelFeedbackTrends,
  };
}

export type AppRouter = typeof appRouter;

// Re-export schemas the frontend will compose with — convenience so
// `import type { AppRouter } from '@hireops/api/trpc'` is the only
// cross-package import the consumer needs.
export { z };
