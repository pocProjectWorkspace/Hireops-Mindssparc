/**
 * PC-2 — bulk CV upload policy in one place: who may upload, which
 * requisitions accept uploads, and the effective caps for a tenant. The
 * attestation text + version live in @hireops/api-types (the portal renders it).
 */

import { sql as poolSql } from "@hireops/db";
import { resolveBulkCvUploadLimits, type BulkCvUploadLimits } from "@hireops/api-types";
import { loadAcceptingStatuses, loadEffectiveUploadLimits } from "../policy-parameters";

/**
 * Who may bulk-upload CVs to a requisition: the roles that own the recruiter
 * Candidates surface today (listCandidatesByRequisition — RECRUITER_SURFACE_ROLES)
 * — recruiter + admin. RLS scopes everything to the tenant on top.
 */
export const BULK_CV_UPLOAD_ROLES: ReadonlySet<string> = new Set(["admin", "recruiter"]);

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

export function hasBulkCvUploadRole(roles: readonly string[]): boolean {
  return roles.some((r) => BULK_CV_UPLOAD_ROLES.has(r));
}
