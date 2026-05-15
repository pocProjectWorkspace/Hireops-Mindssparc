import { db as poolDb, aiUsageLogs } from "@hireops/db";
import type { AIProvider } from "./types";

/**
 * Inserts one ai_usage_logs row.
 *
 * Always goes through the unscoped pool (service_role). Reasons:
 *   - The integration_credentials helper sets the precedent for
 *     "service-managed write to a tenant-scoped table" — same pattern.
 *   - The caller may or may not be inside withTenantContext; we don't
 *     want to require it. The tenant_id is supplied explicitly.
 *   - ai_usage_logs has no audit trigger attached (it IS the log), so
 *     we don't need the app.* session vars that withTenantContext sets.
 *
 * RLS still protects reads: tenant_isolation_select means authenticated
 * callers only see their own tenant's rows. Service-role writes bypass
 * the insert policy by design.
 */
export interface UsageLogInput {
  tenantId: string;
  provider: AIProvider | "local";
  model: string;
  feature: string;
  actorMembershipId?: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicros: bigint;
  latencyMs: number;
  requestId?: string | null;
  succeeded: boolean;
  errorCode?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordAIUsage(input: UsageLogInput): Promise<void> {
  await poolDb.insert(aiUsageLogs).values({
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    feature: input.feature,
    actorMembershipId: input.actorMembershipId ?? null,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    costMicros: input.costMicros,
    latencyMs: input.latencyMs,
    requestId: input.requestId ?? null,
    succeeded: input.succeeded,
    errorCode: input.errorCode ?? null,
    metadata: input.metadata ?? null,
  });
}
