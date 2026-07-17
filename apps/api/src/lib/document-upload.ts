/**
 * Shared onboarding-document upload handling (ONBOARD-05 + CAND-02).
 *
 * The recruiter-authenticated `POST /api/onboarding-documents/upload` and the
 * candidate-authenticated `POST /api/candidate-documents/upload` accept the
 * SAME file class (10MB; PDF / DOCX / JPEG / PNG), store the blob under the
 * same opaque `onboarding-documents/` prefix, and return the same two-step
 * upload-then-attach envelope. Only the identity middleware in front differs,
 * so the multipart parse + validate + store lives here once.
 *
 * Returns a discriminated result the route maps to a Hono JSON response — the
 * lib stays framework-agnostic (no Hono context) so both routes and tests can
 * exercise it.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  uploadOnboardingDocumentResponseSchema,
  type UploadOnboardingDocumentResponse,
} from "@hireops/api-types";
import type { Logger } from "@hireops/observability";
import { getStorageClient, StorageError } from "./storage";

const MAX_BYTES = 10 * 1024 * 1024;
// ID documents are commonly scans/photos, so JPEG + PNG join the PDF/DOCX set
// the resume route allows.
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
]);

export type DocumentUploadResult =
  | { ok: true; response: UploadOnboardingDocumentResponse }
  | { ok: false; status: 400 | 500; body: Record<string, unknown> };

/**
 * Parse a Hono-parsed multipart body, validate the `file` field, store the
 * blob, and return the opaque storage key + metadata. `parsedBody` is the
 * result of `c.req.parseBody()`; passing it in (rather than the Hono context)
 * keeps this lib decoupled from the two different `Variables` shapes.
 */
export async function storeUploadedDocument(
  parsedBody: Record<string, unknown>,
  log: Logger,
): Promise<DocumentUploadResult> {
  const file = parsedBody["file"];
  if (!(file instanceof File)) {
    return { ok: false, status: 400, body: { error: "no_file" } };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, status: 400, body: { error: "file_too_large", maxBytes: MAX_BYTES } };
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return { ok: false, status: 400, body: { error: "unsupported_type", contentType: file.type } };
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
      log.error({ err, storageKey }, "onboarding document storage put failed");
      return { ok: false, status: 500, body: { error: "upload_failed" } };
    }
    throw err;
  }

  const response: UploadOnboardingDocumentResponse = {
    storageKey,
    sizeBytes: file.size,
    contentType: file.type,
    checksum,
  };
  uploadOnboardingDocumentResponseSchema.parse(response);
  return { ok: true, response };
}
