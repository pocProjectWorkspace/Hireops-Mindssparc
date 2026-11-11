/**
 * C1-F10 — tenant lifecycle + module-entitlement checks for the API.
 *
 * LIFECYCLE (D3). Every tenant-scoped entry point (protectedProcedure,
 * partnerProcedure, candidateProcedure, the strict Hono tenantContext and the
 * bulk-CV upload route) calls assertTenantActive / tenantIsActive before doing
 * any work, so a tenant suspended AFTER a token was issued is refused on its
 * next call — the auth hook alone only stops NEW tokens.
 *
 * ENTITLEMENTS (D4). requireModule(ctx, key) is applied to each module's entry
 * procedures. A missing tenant_modules row means ENABLED (platform default), so
 * existing tenants are unaffected on deploy.
 *
 * CACHE. Both reads go through a small per-process cache (TTL 30 s, ≤ the 60 s
 * the ticket allows) so a busy tenant costs one tiny query per half-minute,
 * not one per call. The platform mutations invalidate the entry for their
 * tenant in the process that served them; other API instances converge within
 * the TTL. Reads use the service-role pool (ctx.sql): the check runs BEFORE a
 * tenant transaction is opened, and tenant_modules has no tenant-visible write
 * path anyway.
 */

import { TRPCError } from "@trpc/server";
import type { sql as poolSql } from "@hireops/db";
import {
  MODULE_DISABLED_ERROR_PREFIX,
  TENANT_SUSPENDED_ERROR,
  isTenantActive,
  resolveTenantModules,
  type PlatformModuleKey,
} from "@hireops/api-types";

type SqlHandle = typeof poolSql;

export const TENANT_ACCESS_CACHE_TTL_MS = 30_000;

interface Cached<T> {
  value: T;
  expiresAt: number;
}

const statusCache = new Map<string, Cached<string | null>>();
const modulesCache = new Map<string, Cached<Record<PlatformModuleKey, boolean>>>();

function fresh<T>(entry: Cached<T> | undefined): entry is Cached<T> {
  return entry !== undefined && entry.expiresAt > Date.now();
}

/** Drop cached status/modules for one tenant (or all, when omitted). */
export function invalidateTenantAccessCache(tenantId?: string): void {
  if (tenantId) {
    statusCache.delete(tenantId);
    modulesCache.delete(tenantId);
  } else {
    statusCache.clear();
    modulesCache.clear();
  }
}

/** The tenant's lifecycle status, or null when the tenant row does not exist. */
export async function getTenantStatus(sql: SqlHandle, tenantId: string): Promise<string | null> {
  const hit = statusCache.get(tenantId);
  if (fresh(hit)) return hit.value;
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  const value = rows[0]?.status ?? null;
  statusCache.set(tenantId, { value, expiresAt: Date.now() + TENANT_ACCESS_CACHE_TTL_MS });
  return value;
}

export async function tenantIsActive(sql: SqlHandle, tenantId: string): Promise<boolean> {
  return isTenantActive(await getTenantStatus(sql, tenantId));
}

/** FORBIDDEN `tenant_suspended` unless the tenant is `active`. */
export async function assertTenantActive(sql: SqlHandle, tenantId: string): Promise<void> {
  if (!(await tenantIsActive(sql, tenantId))) {
    throw new TRPCError({ code: "FORBIDDEN", message: TENANT_SUSPENDED_ERROR });
  }
}

/** The tenant's resolved module map (missing row → enabled). */
export async function getTenantModules(
  sql: SqlHandle,
  tenantId: string,
): Promise<Record<PlatformModuleKey, boolean>> {
  const hit = modulesCache.get(tenantId);
  if (fresh(hit)) return hit.value;
  let rows: { module_key: string; enabled: boolean }[];
  try {
    rows = await sql<{ module_key: string; enabled: boolean }[]>`
      SELECT module_key, enabled FROM public.tenant_modules WHERE tenant_id = ${tenantId}
    `;
  } catch (err) {
    // Deploy-order safety: code shipped before migration 0134 sees no
    // tenant_modules table. Entitlements are commercial packaging, not an
    // isolation boundary, so fall back to the platform default (all enabled —
    // exactly the pre-F10 behaviour) instead of failing every module call.
    // Any other error propagates.
    if ((err as { code?: string } | null)?.code !== "42P01") throw err;
    console.warn(
      "[tenant-access] tenant_modules missing (migration 0134 not applied); all modules enabled",
    );
    rows = [];
  }
  const value = resolveTenantModules(
    rows.map((r) => ({ moduleKey: r.module_key, enabled: r.enabled })),
  );
  modulesCache.set(tenantId, { value, expiresAt: Date.now() + TENANT_ACCESS_CACHE_TTL_MS });
  return value;
}

export async function isModuleEnabled(
  sql: SqlHandle,
  tenantId: string,
  key: PlatformModuleKey,
): Promise<boolean> {
  return (await getTenantModules(sql, tenantId))[key];
}

/**
 * Module entitlement guard for a procedure body. FORBIDDEN
 * `module_disabled:<key>` when the caller's tenant does not have the module.
 * Works for internal, partner and candidate procedures (all three set
 * ctx.tenantId before the handler runs).
 */
export async function requireModule(
  ctx: { tenantId: string | null; sql: SqlHandle },
  key: PlatformModuleKey,
): Promise<void> {
  if (!ctx.tenantId) throw new TRPCError({ code: "UNAUTHORIZED" });
  if (!(await isModuleEnabled(ctx.sql, ctx.tenantId, key))) {
    throw new TRPCError({ code: "FORBIDDEN", message: `${MODULE_DISABLED_ERROR_PREFIX}${key}` });
  }
}
