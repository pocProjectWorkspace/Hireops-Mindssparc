/**
 * C1-F3 — tenant lookup loaders (platform default + tenant value).
 *
 * The pure resolver lives in @hireops/api-types (resolveTenantLookup /
 * resolveRenegeReasons); these helpers only fetch a tenant's `tenant_lookups`
 * rows. Two flavours, matching the two DB access paths in this app:
 *
 *   - loadTenantLookupRows(sql, …): the service-role pool with an EXPLICIT
 *     tenant predicate (load-bearing) — used by lib code that also serves
 *     workers / public routes (e.g. the PC-17 renege flow).
 *   - procedures use ctx.db (RLS tx) directly via drizzle.
 *
 * A tenant with no rows resolves to the platform defaults; a failed read is NOT
 * swallowed (callers run inside a request and should surface DB errors).
 */

import type { sql as poolSql } from "@hireops/db";
import {
  resolveRenegeReasons,
  resolveTenantLookup,
  type RenegeReason,
  type ResolvedLookupEntry,
  type TenantLookupKind,
  type TenantLookupRowInput,
} from "@hireops/api-types";

type PgSqlClient = typeof poolSql;

interface LookupSqlRow {
  id: string;
  kind: string;
  key: string;
  label: string;
  sort_order: number;
  is_active: boolean;
  attrs: Record<string, unknown> | null;
}

export async function loadTenantLookupRows(
  sql: PgSqlClient,
  tenantId: string,
  kinds: readonly TenantLookupKind[],
): Promise<TenantLookupRowInput[]> {
  if (kinds.length === 0) return [];
  const rows = await sql<LookupSqlRow[]>`
    SELECT id::text AS id, kind, key, label, sort_order, is_active, attrs
    FROM public.tenant_lookups
    WHERE tenant_id = ${tenantId} AND kind = ANY(${kinds as string[]})
  `;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    key: r.key,
    label: r.label,
    sortOrder: Number(r.sort_order),
    isActive: r.is_active,
    attrs: r.attrs,
  }));
}

/** Resolved entries for one kind (service-role path). */
export async function loadResolvedLookup(
  sql: PgSqlClient,
  tenantId: string,
  kind: TenantLookupKind,
  opts: { activeOnly?: boolean } = {},
): Promise<ResolvedLookupEntry[]> {
  const rows = await loadTenantLookupRows(sql, tenantId, [kind]);
  return resolveTenantLookup(kind, rows, opts);
}

/**
 * PC-17 renege reasons via the lookup, with the tenant's existing
 * `settings.preJoiningEngagement.renegeReasons` as the fallback (see
 * resolveRenegeReasons). `settingsReasons` is the already-resolved setting.
 */
export async function loadRenegeReasons(
  sql: PgSqlClient,
  tenantId: string,
  settingsReasons: readonly RenegeReason[],
): Promise<RenegeReason[]> {
  const rows = await loadTenantLookupRows(sql, tenantId, ["renege_reason"]);
  return resolveRenegeReasons(settingsReasons, rows);
}
