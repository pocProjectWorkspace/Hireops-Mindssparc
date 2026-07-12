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

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, lt, lte, sql as dsql } from "drizzle-orm";
import {
  db as poolDb,
  persons,
  candidates,
  candidateDedupAttempts,
  applications,
  applicationStateTransitions,
  requisitions,
  requisitionKnockouts,
  tenantUserMemberships,
  offers,
  workdaySyncOutbox,
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
  recordPiiAccess,
  type ApplicationStage,
} from "@hireops/db";
import { evaluateKnockouts, type KnockoutInput } from "@hireops/ai-scoring";
import { SLA_THRESHOLDS_HOURS } from "../lib/sla-thresholds";
import {
  submitApplicationInputSchema,
  submitApplicationOutputSchema,
  resolvePublicRequisitionInputSchema,
  resolvePublicRequisitionOutputSchema,
  getCandidateByIdInputSchema,
  getCandidateByIdOutputSchema,
  listCandidatesInputSchema,
  listCandidatesOutputSchema,
  getRequisitionByIdInputSchema,
  getRequisitionByIdOutputSchema,
  listRequisitionsInputSchema,
  listRequisitionsOutputSchema,
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
  getAiUsageSummaryInputSchema,
  getAiUsageSummaryOutputSchema,
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
  type SubmitApplicationOutput,
  type GetCandidateByIdOutput,
  type AgentListRow,
  type AuditEventRow,
  type PendingApprovalItem,
  type GetApprovalRequestOutput,
} from "@hireops/api-types";
import { parseResume } from "@hireops/ai-client";
import { enqueueNotification, signLink, hashToken } from "@hireops/notifications";
import { assertRuleAttachable, IncompatibleApprovalRuleError } from "@hireops/agent-actions";
import { router, publicProcedure, protectedProcedure, type HonoTRPCContext } from "./trpc-core";
import { withAudit } from "./with-audit";
import { getStorageClient } from "../lib/storage";
import { tenants, positions } from "@hireops/db";

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
          let initialAiScoreExplanation: Record<string, unknown> | null = null;
          let outboxEligible = false;
          if (knockoutEval.passed === false) {
            initialAiScoreExplanation = {
              scored_by: "skipped",
              reason: "knockouts_failed",
              skipped_at: knockoutEvaluatedAt.toISOString(),
            };
          } else if (
            parserConfidence !== null &&
            parserConfidence < PARSER_CONFIDENCE_SCORING_FLOOR
          ) {
            initialAiScoreExplanation = {
              scored_by: "skipped",
              reason: "parser_confidence_below_threshold",
              confidence: parserConfidence,
              skipped_at: knockoutEvaluatedAt.toISOString(),
            };
          } else {
            outboxEligible = true;
          }

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
          person: row.person,
        };
      });
    }),

  listCandidates: protectedProcedure
    .input(listCandidatesInputSchema)
    .output(listCandidatesOutputSchema)
    .query(async ({ ctx, input }) => {
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
      return {
        rows: out.map((r) => ({
          candidateId: r.candidateId,
          applicationId: r.applicationId,
          fullName: r.fullName,
          email: r.email,
          source: r.source,
          stage: r.stage,
          stageEnteredAt: r.stageEnteredAt.toISOString(),
          aiScore: r.aiScore === null ? null : Number(r.aiScore),
          aiScoreExplanation: r.aiScoreExplanation,
          createdAt: r.createdAt.toISOString(),
        })),
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
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }),

  // ─────────── protected: integration health (admin) ───────────

  listWorkdaySyncs: protectedProcedure
    .input(listWorkdaySyncsInputSchema)
    .output(listWorkdaySyncsOutputSchema)
    .query(async ({ ctx, input }) => {
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
      const db = requireDb(ctx);
      // Join three sources via raw SQL — clean than 3 separate Drizzle
      // queries stitched in JS. tenant_isolation RLS scopes everything.
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
          run_counts.last_run_at
        FROM public.automation_agents aa
        LEFT JOIN (
          SELECT agent_id, COUNT(*)::int AS pending_approval_count
          FROM public.agent_approval_requests
          WHERE status = 'pending'
          GROUP BY agent_id
        ) AS approval_counts ON approval_counts.agent_id = aa.id
        LEFT JOIN (
          SELECT agent_id, COUNT(*)::int AS total_runs, MAX(triggered_at) AS last_run_at
          FROM public.agent_runs
          GROUP BY agent_id
        ) AS run_counts ON run_counts.agent_id = aa.id
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
});

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

export type AppRouter = typeof appRouter;

// Re-export schemas the frontend will compose with — convenience so
// `import type { AppRouter } from '@hireops/api/trpc'` is the only
// cross-package import the consumer needs.
export { z };
