/**
 * PC-2 — reads + the retry write behind the bulk-upload drawer. Every
 * function takes a tenant-bound db (RLS) AND an explicit tenant predicate.
 */

import { and, desc, eq, inArray, isNotNull, sql as dsql } from "drizzle-orm";
import {
  bulkCvBatches,
  bulkCvItems,
  candidates,
  persons,
  sql as poolSql,
  type TenantBoundDb,
} from "@hireops/db";
import type {
  BulkCvBatchCounts,
  BulkCvBatchSummary,
  BulkCvItemRow,
  BulkCvItemStatus,
} from "@hireops/api-types";

export function emptyCounts(): BulkCvBatchCounts {
  return { total: 0, queued: 0, parsing: 0, created: 0, duplicate: 0, failed: 0, skipped: 0 };
}

const COUNT_KEYS: ReadonlySet<string> = new Set([
  "queued",
  "parsing",
  "created",
  "duplicate",
  "failed",
  "skipped",
]);

/** Status counts per batch. */
export async function countsForBatches(
  db: TenantBoundDb,
  tenantId: string,
  batchIds: string[],
): Promise<Map<string, BulkCvBatchCounts>> {
  const out = new Map<string, BulkCvBatchCounts>();
  for (const id of batchIds) out.set(id, emptyCounts());
  if (batchIds.length === 0) return out;
  const rows = await db
    .select({
      batchId: bulkCvItems.batchId,
      status: bulkCvItems.status,
      n: dsql<number>`count(*)::int`,
    })
    .from(bulkCvItems)
    .where(and(eq(bulkCvItems.tenantId, tenantId), inArray(bulkCvItems.batchId, batchIds)))
    .groupBy(bulkCvItems.batchId, bulkCvItems.status);
  for (const r of rows) {
    const c = out.get(r.batchId);
    if (!c) continue;
    if (COUNT_KEYS.has(r.status)) c[r.status as Exclude<keyof BulkCvBatchCounts, "total">] = r.n;
    c.total += r.n;
  }
  return out;
}

interface BatchRow {
  id: string;
  requisitionId: string;
  createdAt: Date;
  uploadedByUserId: string;
}

/**
 * Uploader display names via the service-role pool — public.users is
 * self-only under RLS, so an RLS-tx join would return only the caller's own
 * name (the router's resolveMembershipNames idiom). Explicit tenant predicate
 * is load-bearing. display_name → email local part → null.
 */
async function resolveUploaderNames(
  tenantId: string,
  userIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const rows = await poolSql<{ id: string; display_name: string | null; email: string | null }[]>`
    SELECT tum.user_id::text AS id, u.display_name AS display_name, au.email AS email
    FROM public.tenant_user_memberships tum
    JOIN auth.users au ON au.id = tum.user_id
    LEFT JOIN public.users u ON u.id = tum.user_id
    WHERE tum.tenant_id = ${tenantId} AND tum.user_id::text = ANY(${ids})
  `;
  for (const r of rows) {
    out.set(r.id, r.display_name ?? (r.email ? (r.email.split("@")[0] ?? null) : null));
  }
  return out;
}

async function summarise(
  db: TenantBoundDb,
  tenantId: string,
  rows: BatchRow[],
): Promise<BulkCvBatchSummary[]> {
  const counts = await countsForBatches(
    db,
    tenantId,
    rows.map((r) => r.id),
  );
  const names = await resolveUploaderNames(
    tenantId,
    rows.map((r) => r.uploadedByUserId),
  );
  return rows.map((r) => {
    const c = counts.get(r.id) ?? emptyCounts();
    return {
      id: r.id,
      requisitionId: r.requisitionId,
      createdAt: r.createdAt.toISOString(),
      uploadedByUserId: r.uploadedByUserId,
      uploadedByName: names.get(r.uploadedByUserId) ?? null,
      counts: c,
      done: c.queued === 0 && c.parsing === 0,
    };
  });
}

const batchCols = {
  id: bulkCvBatches.id,
  requisitionId: bulkCvBatches.requisitionId,
  createdAt: bulkCvBatches.createdAt,
  uploadedByUserId: bulkCvBatches.uploadedByUserId,
};

/** The requisition's batches, newest first (bounded — the drawer shows recent ones). */
export async function listBatchesForRequisition(
  db: TenantBoundDb,
  tenantId: string,
  requisitionId: string,
  limit = 20,
): Promise<BulkCvBatchSummary[]> {
  const rows = await db
    .select(batchCols)
    .from(bulkCvBatches)
    .where(
      and(eq(bulkCvBatches.tenantId, tenantId), eq(bulkCvBatches.requisitionId, requisitionId)),
    )
    .orderBy(desc(bulkCvBatches.createdAt))
    .limit(limit);
  return summarise(db, tenantId, rows);
}

/** One batch + its items, or null when not in this tenant. */
export async function getBatchWithItems(
  db: TenantBoundDb,
  tenantId: string,
  batchId: string,
): Promise<{ batch: BulkCvBatchSummary; items: BulkCvItemRow[] } | null> {
  const [row] = await db
    .select(batchCols)
    .from(bulkCvBatches)
    .where(and(eq(bulkCvBatches.tenantId, tenantId), eq(bulkCvBatches.id, batchId)))
    .limit(1);
  if (!row) return null;
  const [batch] = await summarise(db, tenantId, [row]);
  if (!batch) return null;

  const items = await db
    .select({
      id: bulkCvItems.id,
      fileName: bulkCvItems.fileName,
      sizeBytes: bulkCvItems.sizeBytes,
      status: bulkCvItems.status,
      outcomeDetail: bulkCvItems.outcomeDetail,
      failureReason: bulkCvItems.failureReason,
      attemptCount: bulkCvItems.attemptCount,
      storageKey: bulkCvItems.storageKey,
      candidateId: bulkCvItems.candidateId,
      applicationId: bulkCvItems.applicationId,
      candidateName: persons.fullName,
      updatedAt: bulkCvItems.updatedAt,
    })
    .from(bulkCvItems)
    .leftJoin(
      candidates,
      and(
        eq(candidates.tenantId, bulkCvItems.tenantId),
        eq(candidates.id, bulkCvItems.candidateId),
      ),
    )
    .leftJoin(
      persons,
      and(eq(persons.tenantId, candidates.tenantId), eq(persons.id, candidates.personId)),
    )
    .where(and(eq(bulkCvItems.tenantId, tenantId), eq(bulkCvItems.batchId, batchId)))
    .orderBy(bulkCvItems.createdAt, bulkCvItems.fileName);

  return {
    batch,
    items: items.map((i) => ({
      id: i.id,
      fileName: i.fileName,
      sizeBytes: i.sizeBytes,
      status: i.status as BulkCvItemStatus,
      outcomeDetail: i.outcomeDetail,
      failureReason: i.failureReason,
      attemptCount: i.attemptCount,
      retryable: i.status === "failed" && i.storageKey !== null,
      candidateId: i.candidateId,
      applicationId: i.applicationId,
      candidateName: i.candidateName,
      updatedAt: i.updatedAt.toISOString(),
    })),
  };
}

/**
 * Put failed-but-stored items back on the queue with a fresh attempt budget.
 * Only 'failed' rows with a stored file are touched; anything else in
 * `itemIds` is ignored. Returns how many were re-queued.
 */
export async function requeueFailedItems(
  db: TenantBoundDb,
  tenantId: string,
  batchId: string,
  itemIds?: string[],
): Promise<number> {
  const conds = [
    eq(bulkCvItems.tenantId, tenantId),
    eq(bulkCvItems.batchId, batchId),
    eq(bulkCvItems.status, "failed"),
    isNotNull(bulkCvItems.storageKey),
  ];
  if (itemIds) {
    if (itemIds.length === 0) return 0;
    conds.push(inArray(bulkCvItems.id, itemIds));
  }
  const rows = await db
    .update(bulkCvItems)
    .set({
      status: "queued",
      attemptCount: 0,
      leaseExpiresAt: null,
      failureReason: null,
      outcomeDetail: null,
      updatedAt: new Date(),
    })
    .where(and(...conds))
    .returning({ id: bulkCvItems.id });
  return rows.length;
}
