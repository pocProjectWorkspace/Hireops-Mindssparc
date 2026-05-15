import { db as poolDb, getIntegrationCredential, tenants } from "@hireops/db";
import { eq } from "drizzle-orm";
import { AnthropicAIClient } from "./anthropic";
import { OpenAIAIClient } from "./openai";
import { LocalAIClient } from "./local";
import type { AIClient, AIProvider } from "./types";

/**
 * Per-tenant AI client resolution.
 *
 * Flow:
 *   1. If NODE_ENV === 'test' or AI_CLIENT_MODE === 'local' → LocalAIClient.
 *      Tests get fixtures regardless of tenant config.
 *   2. Read tenants.settings.ai_provider for the tenant. Default 'anthropic'.
 *   3. Fetch the per-tenant credential from integration_credentials
 *      (type 'ai_<provider>'). If absent, throw — never silently swap
 *      providers, because cost attribution would lie.
 *   4. Construct the appropriate client with the decrypted credential.
 *   5. Cache per (tenant_id, provider) for 5 minutes. The same TTL as
 *      DEK caching makes sense because the credential is the load-bearing
 *      thing the cache holds.
 *
 * Returns AIClient. Use resetAIClientCache() in tests.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  client: AIClient;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export interface GetAIClientOpts {
  /**
   * Override the cache lookup. Used by tests to bypass the 5-min TTL
   * without resetting the whole cache.
   */
  forceFresh?: boolean;
}

export async function getAIClient(tenantId: string, opts: GetAIClientOpts = {}): Promise<AIClient> {
  if (isLocalMode()) {
    const key = `${tenantId}::local`;
    const cached = !opts.forceFresh ? readCache(key) : undefined;
    if (cached) return cached;
    const client = new LocalAIClient({ tenantId });
    writeCache(key, client);
    return client;
  }

  const provider = await resolveProvider(tenantId);
  const key = `${tenantId}::${provider}`;
  const cached = !opts.forceFresh ? readCache(key) : undefined;
  if (cached) return cached;

  const credentialType = `ai_${provider}` as const;
  const cred = await getIntegrationCredential({ tenantId, integrationType: credentialType });
  if (!cred) {
    throw new Error(
      `Tenant ${tenantId} has no ${provider} credential configured ` +
        `(integration_credentials.integration_type = '${credentialType}').`,
    );
  }
  const client =
    provider === "anthropic"
      ? new AnthropicAIClient({ tenantId, apiKey: cred.secret })
      : new OpenAIAIClient({ tenantId, apiKey: cred.secret });
  writeCache(key, client);
  return client;
}

export function resetAIClientCache(): void {
  cache.clear();
}

function readCache(key: string): AIClient | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.client;
}

function writeCache(key: string, client: AIClient): void {
  cache.set(key, { client, expiresAt: Date.now() + CACHE_TTL_MS });
}

function isLocalMode(): boolean {
  return process.env.NODE_ENV === "test" || process.env.AI_CLIENT_MODE === "local";
}

/**
 * Resolves the configured provider for a tenant. Exported so tests can
 * verify the resolution logic without constructing a client (which would
 * try to load an optional peer SDK).
 */
export async function resolveProvider(tenantId: string): Promise<AIProvider> {
  const [row] = await poolDb
    .select({ settings: tenants.settings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) {
    throw new Error(`Tenant ${tenantId} not found.`);
  }
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const raw = settings["ai_provider"];
  if (raw === "openai") return "openai";
  if (raw === "anthropic" || raw === undefined || raw === null) return "anthropic";
  throw new Error(
    `Tenant ${tenantId} has an unsupported ai_provider in settings: ${String(raw)}. ` +
      `Expected 'anthropic' or 'openai'.`,
  );
}
