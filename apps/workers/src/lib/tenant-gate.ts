/**
 * C1-F10 — tenant lifecycle (D3) + module entitlement (D4) gates for workers.
 *
 * Drains append `tenantGateSql(table, module?)` to their claim subquery, so a
 * row belonging to a non-`active` tenant — or to a tenant with the module
 * switched off — is simply NOT CLAIMED. It stays in its queue untouched (no
 * email sent, no AI call made, no attempt burned) and is worked normally if
 * the tenant is reactivated / the module re-enabled. Nothing is cancelled:
 * suspension is reversible, so the queue must be too.
 *
 * Scans that iterate tenants filter with ACTIVE_TENANT_SQL / the
 * activeTenantIds() set instead.
 *
 * Both predicates are evaluated in the database on every claim, so there is no
 * cache to go stale here: the worker reacts to a status change on its very
 * next tick.
 */

import { sql as poolSql } from "@hireops/db";
import type { PlatformModuleKey } from "@hireops/api-types";

/**
 * SQL fragment: `AND <table>.tenant_id belongs to an active tenant [AND the
 * module is not disabled for it]`. `table` is the unqualified name of the
 * table in the enclosing FROM clause (identifier-escaped here).
 */
export function tenantGateSql(table: string, moduleKey?: PlatformModuleKey) {
  const ref = poolSql(table);
  return poolSql`
    AND EXISTS (
      SELECT 1 FROM public.tenants gate_t
       WHERE gate_t.id = ${ref}.tenant_id AND gate_t.status = 'active'
    )
    ${
      moduleKey
        ? poolSql`AND NOT EXISTS (
            SELECT 1 FROM public.tenant_modules gate_m
             WHERE gate_m.tenant_id = ${ref}.tenant_id
               AND gate_m.module_key = ${moduleKey}
               AND gate_m.enabled = false
          )`
        : poolSql``
    }
  `;
}

/** Ids of every `active` tenant (for scans that loop over tenants in JS). */
export async function activeTenantIds(): Promise<Set<string>> {
  const rows = await poolSql<{ id: string }[]>`
    SELECT id::text AS id FROM public.tenants WHERE status = 'active'
  `;
  return new Set(rows.map((r) => r.id));
}

/** Ids of active tenants that have NOT switched the module off. */
export async function tenantsWithModule(moduleKey: PlatformModuleKey): Promise<Set<string>> {
  const rows = await poolSql<{ id: string }[]>`
    SELECT t.id::text AS id FROM public.tenants t
     WHERE t.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM public.tenant_modules m
          WHERE m.tenant_id = t.id AND m.module_key = ${moduleKey} AND m.enabled = false
       )
  `;
  return new Set(rows.map((r) => r.id));
}
