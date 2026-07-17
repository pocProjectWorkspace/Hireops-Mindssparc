/**
 * Shared onboarding-document internals (ONBOARD-05 + CAND-02).
 *
 * The recruiter-side `attachOnboardingDocument` procedure and the
 * candidate-side `candidateAttachDocument` procedure both need the SAME
 * find-or-replace + task-progression semantics — only the tenant/person
 * authorisation gate in front of them differs. Rather than duplicate the
 * body (CAND-02 hand-back: "reuse the internals — extract a shared helper"),
 * both callers validate their own access to the case, then hand off to
 * `attachDocumentToCase` here.
 *
 * `matchDocumentCollectionTask` is likewise shared by attach / verify /
 * reject (recruiter side) and attach (candidate side).
 */

import { and, eq, sql as dsql } from "drizzle-orm";
import { onboardingDocuments, onboardingTasks, type TenantBoundDb } from "@hireops/db";
import { TRPCError } from "@trpc/server";

/**
 * Finds the document_collection task for a (case, documentType) — the task the
 * ONBOARD-02 checklist generator seeded with metadata.documentTypeId. Returns
 * null when no such task exists (e.g. a document attached for a type outside
 * the case's geography set). Raw SQL because the match is on a JSONB field.
 */
export async function matchDocumentCollectionTask(
  db: TenantBoundDb,
  tenantId: string,
  caseId: string,
  documentTypeId: string,
): Promise<{ id: string; status: string } | null> {
  const result = await db.execute(dsql`
    SELECT id::text AS id, status
    FROM public.onboarding_tasks
    WHERE tenant_id = ${tenantId}
      AND case_id = ${caseId}
      AND task_type = 'document_collection'
      AND metadata->>'documentTypeId' = ${documentTypeId}
    LIMIT 1
  `);
  const rows =
    (result as unknown as { rows?: { id: string; status: string }[] }).rows ??
    (result as unknown as { id: string; status: string }[]);
  return rows[0] ?? null;
}

export interface AttachDocumentInput {
  caseId: string;
  documentTypeId: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AttachDocumentResult {
  documentId: string;
  verificationStatus: string;
  created: boolean;
  taskId: string | null;
  taskStatus: string | null;
}

/**
 * Records an uploaded blob as the (single) current document row for a
 * (case, documentType) and nudges the matching document_collection task
 * pending → in_progress. The CALLER is responsible for having authorised
 * access to `input.caseId` (recruiter: tenant-scoped RLS check; candidate:
 * person-scoped ownership check) and for validating the document type id —
 * this helper assumes both are already proven, and is the shared write-path.
 *
 * Re-upload semantics: the schema has NO version / superseded / is_current
 * column and NO unique(tenant, case, documentType) constraint, so it models
 * "the current document for this type", not a history. We therefore REPLACE
 * an existing row for the same type, resetting it to pending review and
 * clearing any prior verify/reject stamp. The old storage blob is left in
 * place (no retention/erasure automation — flagged as follow-up).
 */
export async function attachDocumentToCase(
  db: TenantBoundDb,
  tenantId: string,
  input: AttachDocumentInput,
): Promise<AttachDocumentResult> {
  const now = new Date();
  const [existingDoc] = await db
    .select({ id: onboardingDocuments.id })
    .from(onboardingDocuments)
    .where(
      and(
        eq(onboardingDocuments.tenantId, tenantId),
        eq(onboardingDocuments.caseId, input.caseId),
        eq(onboardingDocuments.documentTypeId, input.documentTypeId),
      ),
    )
    .limit(1);

  let documentId: string;
  let created: boolean;
  if (existingDoc) {
    const [updated] = await db
      .update(onboardingDocuments)
      .set({
        storageRef: input.storageKey,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        verificationStatus: "pending",
        verifiedByMembershipId: null,
        verifiedAt: null,
        rejectionReason: null,
        uploadedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(onboardingDocuments.tenantId, tenantId), eq(onboardingDocuments.id, existingDoc.id)),
      )
      .returning({ id: onboardingDocuments.id });
    if (!updated) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "attach document update returned no row",
      });
    }
    documentId = updated.id;
    created = false;
  } else {
    const [inserted] = await db
      .insert(onboardingDocuments)
      .values({
        tenantId,
        caseId: input.caseId,
        documentTypeId: input.documentTypeId,
        storageRef: input.storageKey,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: BigInt(input.sizeBytes),
        verificationStatus: "pending",
      })
      .returning({ id: onboardingDocuments.id });
    if (!inserted) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "attach document insert returned no row",
      });
    }
    documentId = inserted.id;
    created = true;
  }

  // Nudge the matching document_collection task forward, but only from
  // pending — an already in_progress / completed / blocked task is left
  // as-is so a re-upload doesn't clobber a recruiter's manual state.
  const task = await matchDocumentCollectionTask(db, tenantId, input.caseId, input.documentTypeId);
  let taskStatus = task?.status ?? null;
  if (task && task.status === "pending") {
    const [t] = await db
      .update(onboardingTasks)
      .set({ status: "in_progress", updatedAt: now })
      .where(and(eq(onboardingTasks.tenantId, tenantId), eq(onboardingTasks.id, task.id)))
      .returning({ status: onboardingTasks.status });
    taskStatus = t?.status ?? taskStatus;
  }

  return {
    documentId,
    verificationStatus: "pending",
    created,
    taskId: task?.id ?? null,
    taskStatus,
  };
}
