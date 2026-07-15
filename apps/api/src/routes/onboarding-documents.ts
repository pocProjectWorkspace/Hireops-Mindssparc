/**
 * Onboarding document blob transport (ONBOARD-05) — the REST side of the
 * document-collection flow. Two routes, BOTH authenticated (mounted behind
 * the strict `tenantContext` middleware, unlike the public resume upload):
 *
 *   POST /api/onboarding-documents/upload
 *     Multipart upload of an ID document. 10MB cap; PDF / DOCX / JPEG / PNG
 *     allowlist (ID docs are usually photos or scans, so images are in scope
 *     here where they are not for resumes). Returns an opaque `storageKey`
 *     under a distinct `onboarding-documents/` prefix. The blob only becomes a
 *     real row when the `attachOnboardingDocument` tRPC procedure references
 *     the key — the same two-step (upload-then-reference) shape as the apply
 *     form's resume upload.
 *
 *   GET /api/onboarding-documents/:documentId/download
 *     Streams the blob back through the API (never a public/signed storage
 *     URL — storage keys stay opaque and every read is proxied + authorised).
 *     Onboarding documents are heavy PII (Aadhaar, PAN, bank details), so
 *     every download writes a `pii_access_log` row (PII-01 pattern) before the
 *     bytes leave.
 *
 * Encryption note: `encryption_key_ref` is left NULL — this ticket does not
 * build envelope encryption for blobs (flagged as a follow-up); the storage
 * lib stores bytes as-is under Supabase Storage's at-rest encryption.
 */

import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { recordPiiAccess, onboardingDocuments } from "@hireops/db";
import {
  uploadOnboardingDocumentResponseSchema,
  type UploadOnboardingDocumentResponse,
} from "@hireops/api-types";
import type { TenantContextVars } from "../middleware/tenant-context";
import { getStorageClient, StorageError, StorageNotFoundError } from "../lib/storage";

const MAX_BYTES = 10 * 1024 * 1024;
// ID documents are commonly scans/photos, so JPEG + PNG join the PDF/DOCX set
// the resume route allows.
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
]);

export const onboardingDocumentRoutes = new Hono<{ Variables: TenantContextVars }>();

onboardingDocumentRoutes.post("/upload", async (c) => {
  let body: Awaited<ReturnType<typeof c.req.parseBody>>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: "invalid_form" }, 400);
  }
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "no_file" }, 400);
  }

  if (file.size > MAX_BYTES) {
    return c.json({ error: "file_too_large", maxBytes: MAX_BYTES }, 400);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return c.json({ error: "unsupported_type", contentType: file.type }, 400);
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const checksum = createHash("sha256").update(buffer).digest("hex");

  // Distinct prefix from resumes so the two upload classes never collide and
  // storage policies / lifecycle rules can target them independently.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const storageKey = `onboarding-documents/${randomUUID()}-${safeName}`;

  try {
    const storage = getStorageClient();
    await storage.put(storageKey, buffer, { contentType: file.type });
  } catch (err) {
    if (err instanceof StorageError) {
      c.var.log.error({ err, storageKey }, "onboarding document storage put failed");
      return c.json({ error: "upload_failed" }, 500);
    }
    throw err;
  }

  const out: UploadOnboardingDocumentResponse = {
    storageKey,
    sizeBytes: file.size,
    contentType: file.type,
    checksum,
  };
  uploadOnboardingDocumentResponseSchema.parse(out);
  return c.json(out);
});

onboardingDocumentRoutes.get("/:documentId/download", async (c) => {
  const documentId = c.req.param("documentId");

  // RLS-scoped read via the tenant-bound tx — a cross-tenant id simply
  // resolves to no row (404), never a leak.
  const [row] = await c.var.db
    .select({
      id: onboardingDocuments.id,
      tenantId: onboardingDocuments.tenantId,
      storageRef: onboardingDocuments.storageRef,
      fileName: onboardingDocuments.fileName,
      mimeType: onboardingDocuments.mimeType,
    })
    .from(onboardingDocuments)
    .where(
      and(eq(onboardingDocuments.tenantId, c.var.tenantId), eq(onboardingDocuments.id, documentId)),
    )
    .limit(1);

  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  // PII-01: log the read BEFORE the bytes leave. Fire-and-forget insert on the
  // service-role pool — never blocks or fails the download.
  recordPiiAccess({
    tenantId: row.tenantId,
    actorUserId: c.var.userId,
    actorLabel: "user",
    entityType: "onboarding_document",
    entityId: row.id,
    fieldsAccessed: ["onboarding_documents.storage_ref", "onboarding_documents.file_name"],
    reason: "download_onboarding_document",
    requestId: c.var.requestId,
  });

  let object: Awaited<ReturnType<ReturnType<typeof getStorageClient>["get"]>>;
  try {
    object = await getStorageClient().get(row.storageRef);
  } catch (err) {
    if (err instanceof StorageNotFoundError) {
      // Row exists but the blob is gone (e.g. a groomed / superseded blob).
      return c.json({ error: "blob_not_found" }, 404);
    }
    if (err instanceof StorageError) {
      c.var.log.error({ err, documentId }, "onboarding document storage get failed");
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
