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
import { and, desc, eq, lt, sql as dsql } from "drizzle-orm";
import {
  db as poolDb,
  persons,
  candidates,
  candidateDedupAttempts,
  applications,
  applicationStateTransitions,
  requisitions,
  tenantUserMemberships,
  offers,
  workdaySyncOutbox,
  type ApplicationStage,
} from "@hireops/db";
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
  type SubmitApplicationOutput,
  type GetCandidateByIdOutput,
} from "@hireops/api-types";
import { parseResume } from "@hireops/ai-client";
import { enqueueNotification, signLink, hashToken } from "@hireops/notifications";
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
 * Requisition statuses that an unauthenticated apply form may submit
 * against. Shared by `submitApplication` (rejects 400) and
 * `resolvePublicRequisition` (returns 404 — keeps slug existence
 * private from passers-by). Keep this single source of truth.
 */
const PUBLIC_APPLY_ACCEPTING_STATUSES = new Set<string>(["approved", "posted"]);

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
          let yearsOfExperience: number | null = null;
          try {
            const parsed = await parseResume(obj.buffer, obj.contentType, {
              tenantId: req.tenantId,
            });
            parsedSkills = parsed;
            yearsOfExperience = parsed.total_years_experience;
            if (parsed.parse_metadata.confidence_score === 0) parseStatus = "parse_failed";
          } catch (err) {
            ctx.log.error({ err, request_id: ctx.requestId }, "parseResume threw");
            parseStatus = "parse_failed";
          }

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
            .where(
              and(eq(persons.tenantId, req.tenantId), eq(persons.emailNormalised, emailNorm)),
            )
            .limit(1);
          const [phoneMatch] = await poolDb
            .select({
              id: persons.id,
              emailNorm: persons.emailNormalised,
              phoneNorm: persons.phoneNormalised,
              linkedinUrl: persons.linkedinUrl,
            })
            .from(persons)
            .where(
              and(eq(persons.tenantId, req.tenantId), eq(persons.phoneNormalised, phoneNorm)),
            )
            .limit(1);

          let personId: string;
          let dedupDecision: "allow_new" | "link_existing";
          let dedupReason: string | null = null;

          const sameMatch = emailMatch && phoneMatch && emailMatch.id === phoneMatch.id;
          const winner = sameMatch ? emailMatch : (emailMatch ?? phoneMatch);
          const isCollision =
            !!emailMatch && !!phoneMatch && emailMatch.id !== phoneMatch.id;

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
            dedupReason = isCollision
              ? "ambiguous_email_phone_collision"
              : "no_match";
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
                })
                .returning({ id: applications.id })
                .then((rows) => firstOrThrow(rows, "applications insert").id);

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
          and(eq(positions.id, requisitions.positionId), eq(positions.tenantId, requisitions.tenantId)),
        )
        .where(
          and(eq(tenants.slug, input.tenantSlug), eq(requisitions.publicSlug, input.reqSlug)),
        )
        .limit(1);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not found" });
      }
      if (!PUBLIC_APPLY_ACCEPTING_STATUSES.has(row.status)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Requisition not accepting applications" });
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
              input.joiningBonusInrPaise !== undefined
                ? BigInt(input.joiningBonusInrPaise)
                : null,
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
          status: r.status as "drafted" | "extended" | "accepted" | "declined" | "expired" | "cancelled",
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
        ...(input.filters?.status
          ? [eq(workdaySyncOutbox.status, input.filters.status)]
          : []),
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
});

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
