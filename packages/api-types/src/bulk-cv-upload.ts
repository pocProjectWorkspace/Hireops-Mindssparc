import { z } from "zod";

/**
 * PC-2 — bulk CV upload per requisition (platform feature).
 *
 * A recruiter drops many PDF/DOCX files (or one .zip of them) on a
 * requisition. Each file becomes a `bulk_cv_items` row (migration 0123) that
 * a worker drain parses and turns into candidate + application through the
 * same ingest core partner submissions use. This module is the shared
 * contract: the batch caps (platform default + tenant override hook) and the
 * tRPC shapes the upload drawer polls.
 */

/** Any id a Postgres `uuid` column holds (see learning.ts for why not `.uuid()`). */
const pgUuid = z.guid();

// ─────────────── Batch caps: platform default + tenant override ───────────────

/**
 * Per-BATCH caps. The per-FILE cap is deliberately NOT here: it is the
 * platform-wide document ceiling (`MAX_DOCUMENT_BYTES`, apps/api
 * upload-limits.ts) that the apply form and every document path already use —
 * a bulk upload must not become a way round it.
 *
 * Tenant override: `tenants.settings.bulkCvUpload` (resolved leniently by
 * `resolveBulkCvUploadLimits`; an absent or malformed block is the platform
 * default). There is no admin surface for it yet — it is the hook.
 *
 * Bounds: a batch above 2,000 files or 1 GB is not a "drop a role's CVs"
 * operation any more, it is a migration and belongs in an import job.
 */
export const BULK_CV_DEFAULT_MAX_FILES = 500;
export const BULK_CV_DEFAULT_MAX_BATCH_BYTES = 200 * 1024 * 1024;

export const bulkCvUploadLimitsSchema = z.object({
  maxFilesPerBatch: z.number().int().min(1).max(2000).default(BULK_CV_DEFAULT_MAX_FILES),
  maxBatchBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(1024 * 1024 * 1024)
    .default(BULK_CV_DEFAULT_MAX_BATCH_BYTES),
});
export type BulkCvUploadLimits = z.infer<typeof bulkCvUploadLimitsSchema>;

export function defaultBulkCvUploadLimits(): BulkCvUploadLimits {
  return bulkCvUploadLimitsSchema.parse({});
}

/**
 * Lenient resolver over `tenants.settings.bulkCvUpload`. Garbage resolves to
 * the platform default rather than throwing — a typo'd tenant setting must
 * not disable the guard or break the upload.
 */
export function resolveBulkCvUploadLimits(raw: unknown): BulkCvUploadLimits {
  const parsed = bulkCvUploadLimitsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : defaultBulkCvUploadLimits();
}

// ─────────────── Uploader attestation ───────────────

/**
 * The recruiter's attestation when creating a batch — the processing basis
 * for candidates who have consented to nothing themselves. Versioned: any
 * wording change bumps the version (the platform's disclosure-copy rule).
 * Stored on bulk_cv_batches.attestation_version; the drawer renders the text
 * verbatim.
 */
export const BULK_CV_ATTESTATION_VERSION = "bulk-cv-attest-2026-11-v1";
export const BULK_CV_ATTESTATION_TEXT =
  "I confirm these CVs were provided to us for this requisition (by the candidate, an agency or an RPO partner) and may be processed for this hiring decision. Candidates are not emailed.";

// ─────────────── Item ladder ───────────────

/**
 * bulk_cv_items.status (text + CHECK in 0123, not a pgEnum).
 *
 *   queued     stored, waiting for the drain (also: re-queued by Retry)
 *   parsing    claimed by the drain (lease-bounded)
 *   created    an application was created on this requisition
 *              (outcomeDetail: new_candidate | existing_candidate)
 *   duplicate  nothing created — the person is already on this requisition
 *              (outcomeDetail: already_on_requisition | same_file_in_batch)
 *   failed     could not be processed; failureReason says why. Retryable
 *              when the stored file exists.
 *   skipped    rejected at upload (not a CV type, too large, unsafe name…);
 *              never stored, never retryable.
 */
export const bulkCvItemStatusSchema = z.enum([
  "queued",
  "parsing",
  "created",
  "duplicate",
  "failed",
  "skipped",
]);
export type BulkCvItemStatus = z.infer<typeof bulkCvItemStatusSchema>;

export const bulkCvItemRowSchema = z.object({
  id: pgUuid,
  fileName: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  status: bulkCvItemStatusSchema,
  outcomeDetail: z.string().nullable(),
  failureReason: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  retryable: z.boolean(),
  candidateId: pgUuid.nullable(),
  applicationId: pgUuid.nullable(),
  /** persons.full_name of the created / matched candidate. */
  candidateName: z.string().nullable(),
  updatedAt: z.string(),
});
export type BulkCvItemRow = z.infer<typeof bulkCvItemRowSchema>;

export const bulkCvBatchCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  parsing: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type BulkCvBatchCounts = z.infer<typeof bulkCvBatchCountsSchema>;

export const bulkCvBatchSummarySchema = z.object({
  id: pgUuid,
  requisitionId: pgUuid,
  createdAt: z.string(),
  uploadedByUserId: pgUuid,
  uploadedByName: z.string().nullable(),
  counts: bulkCvBatchCountsSchema,
  /** No item is queued or parsing. */
  done: z.boolean(),
});
export type BulkCvBatchSummary = z.infer<typeof bulkCvBatchSummarySchema>;

// ─────────────── tRPC: listBulkCvBatches ───────────────

export const listBulkCvBatchesInputSchema = z.object({ requisitionId: pgUuid });
export type ListBulkCvBatchesInput = z.infer<typeof listBulkCvBatchesInputSchema>;
export const listBulkCvBatchesOutputSchema = z.object({
  limits: bulkCvUploadLimitsSchema.extend({
    maxFileBytes: z.number().int().positive(),
  }),
  /** False when the requisition's status does not accept new candidates. */
  acceptingUploads: z.boolean(),
  batches: z.array(bulkCvBatchSummarySchema),
});
export type ListBulkCvBatchesOutput = z.infer<typeof listBulkCvBatchesOutputSchema>;

// ─────────────── tRPC: getBulkCvBatch ───────────────

export const getBulkCvBatchInputSchema = z.object({ batchId: pgUuid });
export type GetBulkCvBatchInput = z.infer<typeof getBulkCvBatchInputSchema>;
export const getBulkCvBatchOutputSchema = z.object({
  batch: bulkCvBatchSummarySchema,
  items: z.array(bulkCvItemRowSchema),
});
export type GetBulkCvBatchOutput = z.infer<typeof getBulkCvBatchOutputSchema>;

// ─────────────── tRPC: retryBulkCvItems ───────────────

export const retryBulkCvItemsInputSchema = z.object({
  batchId: pgUuid,
  /** Omit to retry every retryable failed item in the batch. */
  itemIds: z.array(pgUuid).max(2000).optional(),
});
export type RetryBulkCvItemsInput = z.infer<typeof retryBulkCvItemsInputSchema>;
export const retryBulkCvItemsOutputSchema = z.object({ requeued: z.number().int().nonnegative() });
export type RetryBulkCvItemsOutput = z.infer<typeof retryBulkCvItemsOutputSchema>;

// ─────────────── REST: POST /api/upload/bulk-cv ───────────────

/**
 * Response of the multipart upload. Files are sent in one or more requests;
 * the first creates the batch and later ones pass its `batchId` back so a
 * 400-CV drop does not have to be one giant request.
 */
export const bulkCvUploadResponseSchema = z.object({
  batchId: pgUuid,
  accepted: z.number().int().nonnegative(),
  skipped: z.array(z.object({ fileName: z.string(), reason: z.string() })),
  counts: bulkCvBatchCountsSchema,
});
export type BulkCvUploadResponse = z.infer<typeof bulkCvUploadResponseSchema>;
