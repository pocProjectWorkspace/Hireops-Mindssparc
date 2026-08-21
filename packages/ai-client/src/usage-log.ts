import { db as poolDb, aiUsageLogs } from "@hireops/db";
import type { AIProvider } from "./types";
import type { ASRProvider } from "./asr/types";

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
  /**
   * ASRProvider widens this beyond the LLM providers (N3.1). The column is
   * free text, so nothing in the database changes; the union exists to stop
   * a typo becoming a permanently unattributable ledger row.
   */
  provider: AIProvider | ASRProvider | "local";
  model: string;
  feature: string;
  actorMembershipId?: string | null;
  /**
   * Zero for per-minute-priced calls (ASR). See asr-pricing.ts: those rows
   * carry a real cost_micros derived from duration, and the zeros mean
   * "not token-priced", not "unknown".
   */
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
