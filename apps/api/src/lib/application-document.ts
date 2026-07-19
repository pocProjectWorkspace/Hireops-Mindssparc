/**
 * Shared application-document internals (HROPS-03).
 *
 * The pre-offer document flow mirrors onboarding-document.ts: a caller
 * authorises access to the row first, then hands the blob attach to the shared
 * write-path here. Unlike onboarding documents (which model a per-(case, type)
 * find-or-replace), a pre-offer document row is CREATED by hr_ops's "request"
 * action first (status='requested', no blob); the candidate then uploads
 * against that existing row — so the write-path is an UPDATE that stamps the
 * blob metadata and moves the row to 'uploaded'.
 */

import { and, eq } from "drizzle-orm";
import { applicationDocuments, type TenantBoundDb } from "@hireops/db";
import { TRPCError } from "@trpc/server";

export interface AttachApplicationDocumentInput {
  documentId: string;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AttachApplicationDocumentResult {
  documentId: string;
  status: string;
}

/**
 * Records an uploaded blob against an existing (requested/uploaded/rejected)
 * application_documents row and moves it to 'uploaded' for hr_ops review. The
 * CALLER must have authorised access to `documentId` (candidate: person-scoped
 * ownership; recruiter: tenant RLS). Clears any prior rejection reason /
 * verify stamp — a re-upload is a fresh submission. A verified row is left
 * untouched (nothing to re-upload) and reported back as-is.
 */
export async function attachApplicationDocumentBlob(
  db: TenantBoundDb,
  tenantId: string,
  input: AttachApplicationDocumentInput,
): Promise<AttachApplicationDocumentResult> {
  const now = new Date();
  const [existing] = await db
    .select({ id: applicationDocuments.id, status: applicationDocuments.status })
    .from(applicationDocuments)
    .where(
      and(
        eq(applicationDocuments.tenantId, tenantId),
        eq(applicationDocuments.id, input.documentId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "application_document_not_found" });
  }

  const [updated] = await db
    .update(applicationDocuments)
    .set({
      status: "uploaded",
      storageRef: input.storageKey,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: BigInt(input.sizeBytes),
      rejectionReason: null,
      verifiedByMembershipId: null,
      verifiedAt: null,
      uploadedAt: now,
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
      message: "attach application document update returned no row",
    });
  }

  return { documentId: input.documentId, status: updated.status };
}
