/**
 * Pre-offer application-document blob download (HROPS-03) — the hr_ops preview
 * side of the document-verification flow. One authenticated route:
 *
 *   GET /api/application-documents/:documentId/download
 *     Streams the uploaded blob back through the API (never a public/signed
 *     storage URL — storage keys stay opaque and every read is proxied +
 *     authorised). Pre-offer ID/eligibility documents are heavy PII, so every
 *     download writes a `pii_access_log` row (PII-01 pattern) before the bytes
 *     leave — identical discipline to the onboarding-document download.
 *
 * Uploads reuse the existing candidate blob endpoint
 * (POST /api/candidate-documents/upload): the candidate uploads pre-offer docs
 * exactly as they upload onboarding docs, and the returned opaque storageKey
 * is referenced by the candidateAttachApplicationDocument tRPC procedure. No
 * new upload route is needed here.
 */

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { recordPiiAccess, applicationDocuments } from "@hireops/db";
import type { TenantContextVars } from "../middleware/tenant-context";
import { getStorageClient, StorageError, StorageNotFoundError } from "../lib/storage";

export const applicationDocumentRoutes = new Hono<{ Variables: TenantContextVars }>();

applicationDocumentRoutes.get("/:documentId/download", async (c) => {
  const documentId = c.req.param("documentId");

  // RLS-scoped read via the tenant-bound tx — a cross-tenant id simply
  // resolves to no row (404), never a leak.
  const [row] = await c.var.db
    .select({
      id: applicationDocuments.id,
      tenantId: applicationDocuments.tenantId,
      storageRef: applicationDocuments.storageRef,
      fileName: applicationDocuments.fileName,
      mimeType: applicationDocuments.mimeType,
    })
    .from(applicationDocuments)
    .where(
      and(
        eq(applicationDocuments.tenantId, c.var.tenantId),
        eq(applicationDocuments.id, documentId),
      ),
    )
    .limit(1);

  if (!row || !row.storageRef) {
    // No row, or a row still in 'requested' state (no blob uploaded yet).
    return c.json({ error: "not_found" }, 404);
  }

  // PII-01: log the read BEFORE the bytes leave. Fire-and-forget insert on the
  // service-role pool — never blocks or fails the download.
  recordPiiAccess({
    tenantId: row.tenantId,
    actorUserId: c.var.userId,
    actorLabel: "user",
    entityType: "application_document",
    entityId: row.id,
    fieldsAccessed: ["application_documents.storage_ref", "application_documents.file_name"],
    reason: "download_application_document",
    requestId: c.var.requestId,
  });

  let object: Awaited<ReturnType<ReturnType<typeof getStorageClient>["get"]>>;
  try {
    object = await getStorageClient().get(row.storageRef);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      return c.json({ error: "blob_not_found" }, 404);
    }
    if (err instanceof StorageError) {
      c.var.log.error({ err, documentId }, "application document storage get failed");
      return c.json({ error: "download_failed" }, 500);
    }
    throw err;
  }

  const contentType = row.mimeType ?? object.contentType ?? "application/octet-stream";
  const downloadName = (row.fileName ?? `document-${row.id}`).replace(/["\\]/g, "_");
  return c.body(new Uint8Array(object.buffer), 200, {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${downloadName}"`,
    "Content-Length": String(object.buffer.length),
    "Cache-Control": "private, no-store",
  });
});
