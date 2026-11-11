/**
 * POST /api/upload/bulk-cv — PC-2 bulk CV upload per requisition.
 *
 * Multipart fields:
 *   requisitionId   required
 *   batchId         optional — continue an existing batch (the drawer sends a
 *                   large drop as several requests so no single request has to
 *                   carry 400 CVs; the first creates the batch)
 *   attested        "true" — required when creating a batch (the recruiter's
 *                   processing-basis attestation, BULK_CV_ATTESTATION_VERSION)
 *   files           one or more PDF / DOCX / .zip files
 *
 * Auth: mounted under optionalAuth like the rest of /api/upload, so this
 * handler enforces the JWT itself (401) and the role (403,
 * BULK_CV_UPLOAD_ROLES). The requisition must belong to the caller's tenant
 * (404 otherwise — never a cross-tenant existence leak) and be accepting
 * candidates (409).
 *
 * Shape: validation + storage writes happen OUTSIDE any DB transaction (a
 * 200 MB drop must not pin a pooled connection for the length of the
 * uploads); the batch + item rows are then written in ONE short
 * tenant-bound transaction (withTenantContext → RLS + audit attribution).
 * Parsing is NOT done here — the bulk-CV drain (apps/workers) picks the
 * queued items up. The response is the batch id + running counts; the drawer
 * polls getBulkCvBatch for progress.
 *
 * Caps (per batch, cumulative across requests): file count and total bytes
 * from resolveTenantBulkCvLimits (platform default + tenant override); per
 * file = MAX_DOCUMENT_BYTES, the same ceiling the apply form uses. Over the
 * file-count cap the whole request is refused (413) rather than silently
 * truncated.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  bulkCvBatches,
  bulkCvItems,
  sql as poolSql,
  withTenantContext,
  type NewBulkCvItem,
} from "@hireops/db";
import {
  BULK_CV_ATTESTATION_VERSION,
  bulkCvUploadResponseSchema,
  type BulkCvUploadResponse,
} from "@hireops/api-types";
import type { OptionalAuthVars } from "../middleware/optional-auth";
import { isModuleEnabled, tenantIsActive } from "../lib/platform/tenant-access";
import { getStorageClient } from "../lib/storage";
import { countsForBatches, emptyCounts } from "../lib/bulk-cv/read";
import { expandUpload, type AcceptedCv, type UploadedFile } from "../lib/bulk-cv/expand";
import {
  BULK_CV_ACCEPTING_REQ_STATUSES,
  BULK_CV_MAX_ZIP_ENTRIES,
  hasBulkCvUploadRole,
  resolveTenantBulkCvLimits,
} from "../lib/bulk-cv/policy";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parallel storage writes per request. */
const STORAGE_PUT_CONCURRENCY = 4;

export const bulkCvUploadRoutes = new Hono<{ Variables: OptionalAuthVars }>();

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function safeStorageName(name: string): string {
  const base = name.split("/").pop() ?? name;
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "cv";
}

bulkCvUploadRoutes.post("/", async (c) => {
  const { tenantId, userId, roles, claims, log, requestId } = c.var;
  if (!tenantId || !userId || !claims) return c.json({ error: "unauthorized" }, 401);
  if (!hasBulkCvUploadRole(roles)) return c.json({ error: "forbidden" }, 403);
  // C1-F10: lifecycle (D3) + module entitlement (D4), before any upload work.
  if (!(await tenantIsActive(poolSql, tenantId))) {
    return c.json({ error: "forbidden", reason: "tenant_suspended" }, 403);
  }
  if (!(await isModuleEnabled(poolSql, tenantId, "bulk_cv_upload"))) {
    return c.json({ error: "forbidden", reason: "module_disabled:bulk_cv_upload" }, 403);
  }

  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    return c.json({ error: "invalid_form" }, 400);
  }
  const field = (k: string): string | null => {
    const v = body[k];
    return typeof v === "string" ? v : null;
  };
  const requisitionId = field("requisitionId");
  const batchIdIn = field("batchId");
  if (!requisitionId || !UUID_SHAPE.test(requisitionId)) {
    return c.json({ error: "invalid_requisition_id" }, 400);
  }
  if (batchIdIn !== null && !UUID_SHAPE.test(batchIdIn)) {
    return c.json({ error: "invalid_batch_id" }, 400);
  }
  const rawFiles = body["files"];
  const fileList = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []).filter(
    (f): f is File => f instanceof File,
  );
  if (fileList.length === 0) return c.json({ error: "no_files" }, 400);

  // ── Requisition: same tenant (explicit predicate on the service-role pool;
  //    a foreign id is a plain 404) and accepting candidates. ──
  const [req] = await poolSql<{ status: string }[]>`
    SELECT status FROM public.requisitions
    WHERE tenant_id = ${tenantId} AND id = ${requisitionId} LIMIT 1
  `;
  if (!req) return c.json({ error: "requisition_not_found" }, 404);
  if (!BULK_CV_ACCEPTING_REQ_STATUSES.has(req.status)) {
    return c.json({ error: "requisition_not_accepting", status: req.status }, 409);
  }

  const limits = await resolveTenantBulkCvLimits(tenantId);

  // ── Existing batch (continuation) — same tenant, same req, same uploader. ──
  let existingCount = 0;
  let existingBytes = 0;
  const existingChecksums = new Set<string>();
  if (batchIdIn) {
    const [batch] = await poolSql<{ requisition_id: string; uploaded_by_user_id: string }[]>`
      SELECT requisition_id, uploaded_by_user_id FROM public.bulk_cv_batches
      WHERE tenant_id = ${tenantId} AND id = ${batchIdIn} LIMIT 1
    `;
    if (!batch || batch.requisition_id !== requisitionId) {
      return c.json({ error: "batch_not_found" }, 404);
    }
    if (batch.uploaded_by_user_id !== userId) return c.json({ error: "forbidden" }, 403);
    const rows = await poolSql<
      { checksum: string | null; size_bytes: string | null; status: string }[]
    >`
      SELECT checksum, size_bytes::text AS size_bytes, status FROM public.bulk_cv_items
      WHERE tenant_id = ${tenantId} AND batch_id = ${batchIdIn}
    `;
    for (const r of rows) {
      if (r.status === "skipped") continue;
      existingCount += 1;
      existingBytes += Number(r.size_bytes ?? 0);
      if (r.checksum) existingChecksums.add(r.checksum);
    }
  } else if (field("attested") !== "true") {
    return c.json({ error: "attestation_required" }, 400);
  }

  // ── Expand zips + type/size checks (pure). ──
  const uploaded: UploadedFile[] = await Promise.all(
    fileList.map(async (f) => ({ name: f.name, data: Buffer.from(await f.arrayBuffer()) })),
  );
  const expanded = expandUpload(uploaded, {
    maxFileBytes: limits.maxFileBytes,
    remainingBytes: Math.max(0, limits.maxBatchBytes - existingBytes),
    maxZipEntries: BULK_CV_MAX_ZIP_ENTRIES,
  });

  // Same bytes twice (in this request or earlier in the batch) → recorded as
  // a duplicate, stored once.
  const fresh: AcceptedCv[] = [];
  const sameFile: AcceptedCv[] = [];
  for (const cv of expanded.accepted) {
    if (existingChecksums.has(cv.checksum)) sameFile.push(cv);
    else {
      existingChecksums.add(cv.checksum);
      fresh.push(cv);
    }
  }

  if (existingCount + fresh.length > limits.maxFilesPerBatch) {
    return c.json(
      {
        error: "too_many_files",
        maxFilesPerBatch: limits.maxFilesPerBatch,
        alreadyInBatch: existingCount,
        inThisUpload: fresh.length,
      },
      413,
    );
  }

  const batchId = batchIdIn ?? randomUUID();

  // ── Store (outside any tx). A failed put becomes a failed, non-retryable item. ──
  const storage = getStorageClient();
  const stored = await mapLimit(fresh, STORAGE_PUT_CONCURRENCY, async (cv) => {
    const storageKey = `resumes/bulk/${batchId}/${randomUUID()}-${safeStorageName(cv.fileName)}`;
    try {
      await storage.put(storageKey, cv.data, { contentType: cv.contentType });
      return { cv, storageKey };
    } catch (err) {
      log.error({ err, request_id: requestId, batch_id: batchId }, "bulk-cv: storage put failed");
      return { cv, storageKey: null };
    }
  });

  const itemRows: NewBulkCvItem[] = [
    ...stored.map(
      ({ cv, storageKey }): NewBulkCvItem => ({
        tenantId,
        batchId,
        requisitionId,
        fileName: cv.fileName,
        storageKey,
        contentType: cv.contentType,
        sizeBytes: cv.data.length,
        checksum: cv.checksum,
        status: storageKey ? "queued" : "failed",
        failureReason: storageKey ? null : "storage_failed",
      }),
    ),
    ...sameFile.map(
      (cv): NewBulkCvItem => ({
        tenantId,
        batchId,
        requisitionId,
        fileName: cv.fileName,
        storageKey: null,
        contentType: cv.contentType,
        sizeBytes: cv.data.length,
        checksum: cv.checksum,
        status: "duplicate",
        outcomeDetail: "same_file_in_batch",
      }),
    ),
    ...expanded.skipped.map(
      (s): NewBulkCvItem => ({
        tenantId,
        batchId,
        requisitionId,
        fileName: s.fileName.slice(0, 500),
        status: "skipped",
        failureReason: s.reason,
      }),
    ),
  ];

  // ── One short tenant-bound tx: batch (if new) + items. ──
  const counts = await withTenantContext(
    claims,
    async ({ db }) => {
      if (!batchIdIn) {
        const membership = await poolSql<{ id: string }[]>`
          SELECT id::text AS id FROM public.tenant_user_memberships
          WHERE tenant_id = ${tenantId} AND user_id = ${userId} LIMIT 1
        `;
        await db.insert(bulkCvBatches).values({
          id: batchId,
          tenantId,
          requisitionId,
          uploadedByUserId: userId,
          uploadedByMembershipId: membership[0]?.id ?? null,
          basis: "recruiter_attested",
          attestationVersion: BULK_CV_ATTESTATION_VERSION,
        });
      } else {
        await db
          .update(bulkCvBatches)
          .set({ updatedAt: new Date() })
          .where(and(eq(bulkCvBatches.tenantId, tenantId), eq(bulkCvBatches.id, batchId)));
      }
      // Chunked so a 500-row drop stays well under the bind-parameter limit.
      for (let i = 0; i < itemRows.length; i += 200) {
        await db.insert(bulkCvItems).values(itemRows.slice(i, i + 200));
      }
      const byBatch = await countsForBatches(db, tenantId, [batchId]);
      return byBatch.get(batchId) ?? emptyCounts();
    },
    { actorUserId: userId, requestId, source: "app" },
  );

  log.info(
    {
      batch_id: batchId,
      requisition_id: requisitionId,
      queued: stored.filter((s) => s.storageKey).length,
      skipped: expanded.skipped.length,
      same_file: sameFile.length,
    },
    "bulk-cv: upload accepted",
  );

  const out: BulkCvUploadResponse = {
    batchId,
    accepted: stored.filter((s) => s.storageKey).length,
    skipped: expanded.skipped,
    counts,
  };
  bulkCvUploadResponseSchema.parse(out);
  return c.json(out);
});
