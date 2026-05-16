/**
 * Audit-on-opt-in helper for tRPC procedures.
 *
 * Procedures that touch PII, change state, or have regulatory
 * significance wrap their handler in withAudit('action_name'). Routine
 * reads do not — the DB-AUDIT trigger already captures row changes;
 * api_audit_logs captures INTENT (which API action drove the change),
 * which is the question regulators ask.
 *
 * Convention for `action`: snake_case of the procedure name
 * (`submit_application`, `get_candidate_by_id`).
 *
 * Failure mode: audit write is fire-and-forget. If the insert fails,
 * we log and continue — never fail the user-facing request because
 * we couldn't audit it. Loss is logged + Sentry'd so it's investigable.
 *
 * tenantId resolution: the protected procedures get tenant from
 * ctx.tenantId (JWT). publicProcedures that derive their tenant from
 * input (e.g. submitApplication looks up the requisition) pass the
 * resolved id explicitly via opts.tenantIdOverride. If neither is set,
 * we skip the audit write (don't fail the request).
 *
 * sanitiseForAudit drops obvious secrets. Today's procedures don't carry
 * secrets in input shapes; the helper is there for future ones.
 */

import { db as poolDb, apiAuditLogs } from "@hireops/db";
import type { HonoTRPCContext } from "./trpc-core";

const SECRET_KEYS = new Set(["password", "token", "secret", "apiKey", "api_key"]);

function sanitiseForAudit(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k) ? "[redacted]" : v;
  }
  return out;
}

export interface WithAuditOpts {
  /**
   * Override ctx.tenantId. Public procedures that derive tenant from
   * input (e.g. submitApplication) pass the resolved id here.
   */
  tenantIdOverride?: string | null;
}

/**
 * Run handler, then record an api_audit_logs row asynchronously. The
 * record never blocks the response. Returns the handler's value
 * unchanged.
 */
export async function withAudit<TInput, TOutput>(
  action: string,
  ctx: HonoTRPCContext,
  input: TInput,
  handler: () => Promise<TOutput>,
  opts: WithAuditOpts = {},
): Promise<TOutput> {
  const result = await handler();
  const tenantId = opts.tenantIdOverride ?? ctx.tenantId;
  if (!tenantId) {
    ctx.log.warn({ action, request_id: ctx.requestId }, "api_audit_logs skipped (no tenant)");
    return result;
  }
  void poolDb
    .insert(apiAuditLogs)
    .values({
      tenantId,
      action,
      actorUserId: ctx.userId,
      requestId: ctx.requestId,
      source: "app",
      inputJson: { action, input: sanitiseForAudit(input) },
    })
    .then(() => undefined)
    .catch((err: unknown) => {
      ctx.log.error({ err, action, request_id: ctx.requestId }, "api_audit_logs write failed");
    });
  return result;
}
