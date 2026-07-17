/**
 * Per-tenant AI settings resolver (CONF-01).
 *
 * Reads `tenants.settings.aiSettings` and merges defaults, returning the
 * effective, validated config the call sites consume. Mirrors how
 * `resolveProvider` (factory.ts) reads the sibling `ai_provider` key — one
 * jsonb read, no cache. The block is a few hundred bytes and the read is
 * cheap; a cache would only introduce a staleness window right after an
 * admin flips a toggle (which the live check depends on being immediate),
 * so we deliberately read fresh every call. `model` / `temperature` /
 * `maxTokens` are passed per-call into the client, so no client-cache
 * invalidation is involved.
 *
 * Both variants read through the unscoped pool (service_role) with an
 * explicit `id = tenantId` predicate — the same pattern `resolveProvider`
 * uses. `tenants` is FORCE RLS with tenant-self SELECT only; background
 * workers have no JWT, so the pool is the only correct client here.
 */

import { db as poolDb, sql as poolSqlDefault, tenants } from "@hireops/db";
import { eq } from "drizzle-orm";
import { resolveAiSettings, type AiSettings } from "@hireops/api-types";

export type { AiSettings } from "@hireops/api-types";

/**
 * Resolve the effective AI settings for a tenant via a postgres-js `sql`
 * client (the worker drains pass their `poolSql`, which is this same shared
 * pool). Malformed or missing blocks fall back to defaults inside
 * `resolveAiSettings` — the AI call path must never break on a stale blob.
 */
export async function resolveTenantAiSettings(
  sql: typeof poolSqlDefault,
  tenantId: string,
): Promise<AiSettings> {
  const rows = await sql<{ settings: unknown }[]>`
    SELECT settings FROM public.tenants WHERE id = ${tenantId} LIMIT 1
  `;
  const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>;
  return resolveAiSettings(settings["aiSettings"]);
}

/**
 * Drizzle-client variant for call sites that hold no raw `sql` tag (the
 * tRPC router). Reads the same row via the ORM on the shared pool.
 */
export async function resolveTenantAiSettingsDb(
  tenantId: string,
  client: typeof poolDb = poolDb,
): Promise<AiSettings> {
  const [row] = await client
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  return resolveAiSettings(settings["aiSettings"]);
}
