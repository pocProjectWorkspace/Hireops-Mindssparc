/**
 * POST /api/upload/resume — public REST endpoint for the apply form.
 *
 * Why this is public:
 *   - The apply form runs pre-auth (candidates don't have accounts yet).
 *   - The storage key returned is opaque; possessing it doesn't grant
 *     access to anyone else's data — Supabase Storage policies only
 *     allow service-role / authenticated SELECT, and the apps/api proxies
 *     all reads.
 *
 * Validation:
 *   - 5MB cap (real CVs are usually < 1MB; 5MB is generous).
 *   - PDF + DOCX only. Image-only / vision-to-JSON deferred.
 *
 * Returns { storageKey, sizeBytes, contentType, checksum }. The
 * checksum (sha256 hex) lets downstream dedup spot duplicate resumes
 * across re-uploads.
 *
 * Uses the pluggable Storage abstraction (apps/api/src/lib/storage) —
 * Supabase in prod, in-memory map in tests.
 */

import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import type { OptionalAuthVars } from "../middleware/optional-auth";
import { uploadResumeResponseSchema, type UploadResumeResponse } from "@hireops/api-types";
import { getStorageClient, StorageError } from "../lib/storage";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const uploadRoutes = new Hono<{ Variables: OptionalAuthVars }>();

uploadRoutes.post("/resume", async (c) => {
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

  // storageKey shape: resumes/<uuid>-<safe filename>. UUID prefix dodges
  // any collision risk; the filename is kept readable for debugging.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const storageKey = `resumes/${randomUUID()}-${safeName}`;

  try {
    const storage = getStorageClient();
    await storage.put(storageKey, buffer, { contentType: file.type });
  } catch (err) {
    if (err instanceof StorageError) {
      c.var.log.error({ err, storageKey }, "storage put failed");
      return c.json({ error: "upload_failed" }, 500);
    }
    throw err;
  }

  const out: UploadResumeResponse = {
    storageKey,
    sizeBytes: file.size,
    contentType: file.type,
    checksum,
  };
  // Defensive: the schema we share with the frontend must accept what
  // we return. If it doesn't, fail loud rather than ship a contract drift.
  uploadResumeResponseSchema.parse(out);
  return c.json(out);
});
