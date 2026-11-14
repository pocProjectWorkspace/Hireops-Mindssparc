/**
 * C2-F1 — resolve a caller's effective capabilities for one tenant.
 *
 * Read ONCE per request (by the protectedProcedure middleware, or a REST route)
 * through the service-role pool with an explicit tenant + user predicate, then
 * cached per process for ≤ 60 s. Role / assignment writes invalidate the cache
 * for the tenant, so on the API that served the write the change is immediate;
 * other API processes pick it up within the TTL.
 *
 *   membership.role_key NULL (or no membership row) → the UNION of the system
 *     bundles of the JWT base roles — exactly the pre-C2-F1 gates.
 *   membership.role_key set → that custom role's bundle only (inactive role →
 *     nothing).
 *
 * MIGRATION TOLERANCE: if 0137 is not applied yet (`role_key` / `tenant_roles`
 * missing → SQLSTATE 42703 / 42P01) there can be no custom role, so the system
 * bundles apply. That is the pre-C2-F1 behaviour, never a widening.
 *
 * Capabilities are always resolved for the caller's OWN tenant (the JWT `tid`);
 * nothing here can grant anything in another tenant.
 */

import { readMemberPermissionRow, type sql as poolSql } from "@hireops/db";
import {
  populationFor,
  resolveEffectivePermissions,
  type CapabilityScope,
  type EffectivePermissions,
  type Population,
  type PopulationFacts,
} from "@hireops/api-types";

type SqlHandle = typeof poolSql;

export const PERMISSIONS_CACHE_TTL_MS = 60_000;

/** Effective permissions + the membership facts scope evaluation needs. */
export interface CallerPermissions extends EffectivePermissions {
  tenantId: string;
  membershipId: string | null;
  businessUnitId: string | null;
}

interface Cached {
  value: CallerPermissions;
  expiresAt: number;
}

const cache = new Map<string, Cached>();

function cacheKey(tenantId: string, userId: string, roles: readonly string[]): string {
  return `${tenantId}|${userId}|${[...roles].sort().join(",")}`;
}

/** Drop cached permissions for one tenant (or everything). */
export function invalidatePermissionsCache(tenantId?: string): void {
  if (!tenantId) {
    cache.clear();
    return;
  }
  for (const k of cache.keys()) if (k.startsWith(`${tenantId}|`)) cache.delete(k);
}

/** Resolve (cached) the caller's permissions in `tenantId`. */
export async function resolveCallerPermissions(
  sql: SqlHandle,
  tenantId: string,
  userId: string,
  roles: readonly string[],
): Promise<CallerPermissions> {
  const key = cacheKey(tenantId, userId, roles);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const m = await readMemberPermissionRow(sql, tenantId, userId);
  const eff = resolveEffectivePermissions({ roles, customRole: m?.customRole ?? null });
  const value: CallerPermissions = {
    ...eff,
    tenantId,
    membershipId: m?.membershipId ?? null,
    businessUnitId: m?.businessUnitId ?? null,
  };
  cache.set(key, { value, expiresAt: Date.now() + PERMISSIONS_CACHE_TTL_MS });
  return value;
}

/**
 * The membership facts a scope needs, loaded only for the scope asked for
 * (own → nothing extra; team → direct reports; business_unit → BU subtree;
 * legal_entity → every unit of the member's entity). Tenant-predicated.
 */
export async function loadPopulationFacts(
  sql: SqlHandle,
  perms: CallerPermissions,
  scope: CapabilityScope,
): Promise<PopulationFacts> {
  const facts: PopulationFacts = {
    membershipId: perms.membershipId,
    directReportIds: [],
    businessUnitSubtreeIds: [],
    legalEntityBusinessUnitIds: [],
  };
  const { tenantId } = perms;
  if (scope === "team" && perms.membershipId) {
    const rows = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM public.tenant_user_memberships
       WHERE tenant_id = ${tenantId} AND manager_id = ${perms.membershipId}
    `;
    facts.directReportIds = rows.map((r) => r.id);
  }
  if (scope === "business_unit" && perms.businessUnitId) {
    const rows = await sql<{ id: string }[]>`
      WITH RECURSIVE bu_subtree(id, path, depth) AS (
        SELECT b.id, ARRAY[b.id], 0
          FROM public.business_units b
         WHERE b.tenant_id = ${tenantId}::uuid AND b.id = ${perms.businessUnitId}::uuid
        UNION ALL
        SELECT c.id, s.path || c.id, s.depth + 1
          FROM public.business_units c
          JOIN bu_subtree s ON c.parent_business_unit_id = s.id
         WHERE c.tenant_id = ${tenantId}::uuid
           AND NOT (c.id = ANY(s.path))
           AND s.depth < 32
      )
      SELECT DISTINCT id::text AS id FROM bu_subtree
    `;
    facts.businessUnitSubtreeIds = rows.map((r) => r.id);
  }
  if (scope === "legal_entity" && perms.businessUnitId) {
    const rows = await sql<{ id: string }[]>`
      SELECT b.id::text AS id
        FROM public.business_units b
        JOIN public.business_units mine
          ON mine.tenant_id = b.tenant_id AND mine.legal_entity_id = b.legal_entity_id
       WHERE b.tenant_id = ${tenantId}::uuid
         AND mine.id = ${perms.businessUnitId}::uuid
         AND mine.legal_entity_id IS NOT NULL
    `;
    facts.legalEntityBusinessUnitIds = rows.map((r) => r.id);
  }
  return facts;
}

/** The population for a granted scope (null scope → nothing). */
export async function populationForScope(
  sql: SqlHandle,
  perms: CallerPermissions,
  scope: CapabilityScope | null,
): Promise<Population> {
  if (scope === null) return { kind: "members", membershipIds: [] };
  if (scope === "all") return { kind: "all" };
  return populationFor(scope, await loadPopulationFacts(sql, perms, scope));
}
