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
import { loadAcceptingStatuses, loadEffectiveUploadLimits } from "../policy-parameters";

/*
 * Who may bulk-upload CVs to a requisition: the `candidates.bulk_upload`
 * capability (C2-F1; platform default recruiter + admin — the roles that own the
 * recruiter Candidates surface). RLS scopes everything to the tenant on top.
 */

/**
 * Requisition statuses that accept new candidates — the same set the public
 * apply form and partner submissions accept. C2-F7 / PP10: tenant policy
 * (`screeningPolicy.acceptingStatuses`, default approved + posted). A draft /
 * on-hold / closed req never takes uploads, and the drain re-checks at parse
 * time so a req closed mid-batch stops creating applications.
 */
export function loadTenantAcceptingStatuses(tenantId: string): Promise<ReadonlySet<string>> {
  return loadAcceptingStatuses(tenantId);
}

/** Most entries a single .zip may declare before it is refused outright. */
export const BULK_CV_MAX_ZIP_ENTRIES = 5000;

/**
 * Effective caps for a tenant: platform default overlaid by
 * tenants.settings.bulkCvUpload; the per-FILE cap is the tenant's document
 * cap (C2-F7 uploadPolicy — never above the platform MAX_DOCUMENT_BYTES).
 */
export async function resolveTenantBulkCvLimits(
  tenantId: string,
): Promise<BulkCvUploadLimits & { maxFileBytes: number }> {
  const [row] = await poolSql<{ settings: unknown }[]>`
    SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  const upload = await loadEffectiveUploadLimits(tenantId);
  return {
    ...resolveBulkCvUploadLimits(settings.bulkCvUpload),
    maxFileBytes: upload.maxDocumentBytes,
  };
}

/** C2-F1 — may this caller bulk-upload? (Their resolved permissions.) */
export function canBulkUploadCvs(perms: Pick<EffectivePermissions, "caps">): boolean {
  return hasCapability(perms, "candidates.bulk_upload");
}
