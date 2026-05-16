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
  applications,
  applicationStateTransitions,
  requisitions,
  tenantUserMemberships,
  type ApplicationStage,
} from "@hireops/db";
import { SLA_THRESHOLDS_HOURS } from "../lib/sla-thresholds";
import {
  submitApplicationInputSchema,
  submitApplicationOutputSchema,
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
  type SubmitApplicationOutput,
  type GetCandidateByIdOutput,
} from "@hireops/api-types";
import { parseResume } from "@hireops/ai-client";
import { router, publicProcedure, protectedProcedure, type HonoTRPCContext } from "./trpc-core";
import { withAudit } from "./with-audit";
import { getStorageClient } from "../lib/storage";

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
      // others are open game for an apply form.
      const ACCEPTING = new Set(["approved", "posted"]);
      if (!ACCEPTING.has(req.status)) {
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

          // 3. Dedup person by normalised email within tenant.
          const emailNorm = normaliseEmail(input.applicant.email);
          const phoneNorm = normalisePhone(input.applicant.phone);
          const [existingPerson] = await poolDb
            .select({ id: persons.id })
            .from(persons)
            .where(and(eq(persons.tenantId, req.tenantId), eq(persons.emailNormalised, emailNorm)))
            .limit(1);

          const personId = existingPerson?.id
            ? existingPerson.id
            : await poolDb
                .insert(persons)
                .values({
                  tenantId: req.tenantId,
                  fullName: input.applicant.fullName,
                  emailPrimary: input.applicant.email,
                  emailNormalised: emailNorm,
                  phonePrimary: input.applicant.phone,
                  phoneNormalised: phoneNorm,
                  locationCountry: input.applicant.locationCountry ?? null,
                })
                .returning({ id: persons.id })
                .then((rows) => firstOrThrow(rows, "persons insert").id);

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

          return { applicationId, candidateId, status: parseStatus };
        },
        { tenantIdOverride: req.tenantId },
      );
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
  return {
    applicationId,
    fromStage: app.currentStage,
    toStage: targetStage,
    transitionId: tx.id,
  };
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

export type AppRouter = typeof appRouter;

// Re-export schemas the frontend will compose with — convenience so
// `import type { AppRouter } from '@hireops/api/trpc'` is the only
// cross-package import the consumer needs.
export { z };
