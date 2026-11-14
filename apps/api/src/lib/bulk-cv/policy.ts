/**
 * PC-2 — bulk CV upload policy in one place: who may upload, which
 * requisitions accept uploads, and the effective caps for a tenant. The
 * attestation text + version live in @hireops/api-types (the portal renders it).
 */

import { sql as poolSql } from "@hireops/db";
import {
  hasCapability,
  resolveBulkCvUploadLimits,
  type BulkCvUploadLimits,
  type EffectivePermissions,
} from "@hireops/api-types";
import { MAX_DOCUMENT_BYTES } from "../upload-limits";

/*
 * Who may bulk-upload CVs to a requisition: the `candidates.bulk_upload`
 * capability (C2-F1; platform default recruiter + admin — the roles that own the
 * recruiter Candidates surface). RLS scopes everything to the tenant on top.
 */

/**
 * Requisition statuses that accept new candidates — the same set the public
 * apply form and partner submissions accept (router PUBLIC_APPLY_ACCEPTING_STATUSES).
 * A draft / on-hold / closed req takes no uploads, and the drain re-checks at
 * parse time so a req closed mid-batch stops creating applications.
 */
export const BULK_CV_ACCEPTING_REQ_STATUSES: ReadonlySet<string> = new Set(["approved", "posted"]);

/** Most entries a single .zip may declare before it is refused outright. */
export const BULK_CV_MAX_ZIP_ENTRIES = 5000;

/** Effective caps for a tenant: platform default overlaid by tenants.settings.bulkCvUpload. */
export async function resolveTenantBulkCvLimits(
  tenantId: string,
): Promise<BulkCvUploadLimits & { maxFileBytes: number }> {
  const [row] = await poolSql<{ settings: unknown }[]>`
    SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  return { ...resolveBulkCvUploadLimits(settings.bulkCvUpload), maxFileBytes: MAX_DOCUMENT_BYTES };
}

/** C2-F1 — may this caller bulk-upload? (Their resolved permissions.) */
export function canBulkUploadCvs(perms: Pick<EffectivePermissions, "caps">): boolean {
  return hasCapability(perms, "candidates.bulk_upload");
}
