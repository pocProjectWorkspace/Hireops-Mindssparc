/**
 * C2-F7 — server-side readers for the policy-parameter blocks
 * (@hireops/api-types policy-parameters.ts). Every reader resolves through the
 * block's never-throwing, guardrail-clamping resolver, and a failed settings
 * read degrades to the platform default rather than failing the caller — a
 * policy lookup must never be the reason an apply, a report or a scoring run
 * fails.
 *
 * Reads go through the service-role pool (`tenants` row by id), the same way
 * resolveTenantBulkCvLimits / resolveApplyScreeningPolicy read settings, so a
 * caller does not need a tenant-bound transaction.
 */

import { sql as poolSql } from "@hireops/db";
import {
  resolveAiInterviewPolicy,
  resolveMarketIntelPolicy,
  resolveNotetakerPolicy,
  resolveOfferPolicy,
  resolveReportPolicy,
  resolveScreeningPolicy,
  resolveUploadPolicy,
  uploadMimeTypes,
  type AiInterviewPolicy,
  type MarketIntelPolicy,
  type NotetakerPolicy,
  type OfferPolicy,
  type ReportPolicy,
  type ScreeningPolicy,
  type UploadPolicy,
} from "@hireops/api-types";
import { MAX_DOCUMENT_BYTES, maxMediaBytes } from "./upload-limits";

/** The whole tenants.settings jsonb, `{}` when missing or unreadable. */
export async function loadTenantSettingsRaw(
  tenantId: string | null | undefined,
): Promise<Record<string, unknown>> {
  if (!tenantId) return {};
  try {
    const [row] = await poolSql<{ settings: unknown }[]>`
      SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
    `;
    const s = row?.settings;
    return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function loadScreeningPolicy(tenantId: string | null | undefined) {
  return resolveScreeningPolicy((await loadTenantSettingsRaw(tenantId)).screeningPolicy);
}
export async function loadUploadPolicy(tenantId: string | null | undefined): Promise<UploadPolicy> {
  return resolveUploadPolicy((await loadTenantSettingsRaw(tenantId)).uploadPolicy);
}
export async function loadOfferPolicy(tenantId: string | null | undefined): Promise<OfferPolicy> {
  return resolveOfferPolicy((await loadTenantSettingsRaw(tenantId)).offerPolicy);
}
export async function loadAiInterviewPolicy(
  tenantId: string | null | undefined,
): Promise<AiInterviewPolicy> {
  return resolveAiInterviewPolicy((await loadTenantSettingsRaw(tenantId)).aiInterviewPolicy);
}
export async function loadNotetakerPolicy(
  tenantId: string | null | undefined,
): Promise<NotetakerPolicy> {
  return resolveNotetakerPolicy((await loadTenantSettingsRaw(tenantId)).notetakerPolicy);
}
export async function loadReportPolicy(tenantId: string | null | undefined): Promise<ReportPolicy> {
  return resolveReportPolicy((await loadTenantSettingsRaw(tenantId)).reportPolicy);
}
export async function loadMarketIntelPolicy(
  tenantId: string | null | undefined,
): Promise<MarketIntelPolicy> {
  return resolveMarketIntelPolicy((await loadTenantSettingsRaw(tenantId)).marketIntelPolicy);
}

export type { ScreeningPolicy };

/** PP10 — the requisition statuses that accept applications for a tenant. */
export async function loadAcceptingStatuses(
  tenantId: string | null | undefined,
): Promise<ReadonlySet<string>> {
  return new Set((await loadScreeningPolicy(tenantId)).acceptingStatuses);
}

/**
 * PP9 — effective per-file limits for a tenant: the tenant's value, never
 * above the platform ceiling (documents: MAX_DOCUMENT_BYTES; media: the
 * deployment's MEDIA_MAX_UPLOAD_BYTES).
 */
export interface EffectiveUploadLimits {
  maxDocumentBytes: number;
  maxMediaBytes: number;
  resumeMimeTypes: Set<string>;
  documentMimeTypes: Set<string>;
}

export function effectiveUploadLimits(policy: UploadPolicy): EffectiveUploadLimits {
  const mediaCeiling = maxMediaBytes();
  return {
    maxDocumentBytes: Math.min(policy.maxDocumentBytes, MAX_DOCUMENT_BYTES),
    maxMediaBytes:
      policy.maxMediaBytes == null ? mediaCeiling : Math.min(policy.maxMediaBytes, mediaCeiling),
    resumeMimeTypes: uploadMimeTypes(policy.resumeTypes),
    documentMimeTypes: uploadMimeTypes(policy.documentTypes),
  };
}

export async function loadEffectiveUploadLimits(
  tenantId: string | null | undefined,
): Promise<EffectiveUploadLimits> {
  return effectiveUploadLimits(await loadUploadPolicy(tenantId));
}

/** Tenant id for a public tenant slug (upload routes that run pre-auth). Null when unknown. */
export async function tenantIdForSlug(slug: string | null | undefined): Promise<string | null> {
  if (!slug || slug.length > 100) return null;
  try {
    const [row] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenants WHERE slug = ${slug} LIMIT 1
    `;
    return row?.id ?? null;
  } catch {
    return null;
  }
}
