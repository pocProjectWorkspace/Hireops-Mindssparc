import { db as poolDb } from "./client";
import { piiAccessLog } from "./schema/pii-access-log";

/**
 * PII-access recorder (ADR-002 §7 — mandatory under DPDPA).
 *
 * Fire-and-forget, exactly like `withAudit` in the api app: the insert is
 * voided, never awaited by the caller, and an insert failure is logged but
 * NEVER breaks the caller. Accountability logging must not be able to take
 * down a candidate read or a credential decrypt.
 *
 * The write goes through the unscoped pool (service_role) rather than a
 * tenant-scoped, RLS-bound session. ADR-002's service-role accountability path
 * requires the row to be written regardless of the caller's RLS context — a
 * background worker or a service-role credential read has no
 * current_tenant_id() set, and the ADR wants every read logged.
 *
 * Signature is intentionally explicit so every call site states the actor,
 * the entity, and the reason.
 */
export interface RecordPiiAccessArgs {
  tenantId: string;
  actorUserId?: string | null;
  actorMembershipId?: string | null;
  /**
   * The ADR's actor concept as free text. 'user' for a human (with the id
   * columns filled), or a descriptive service label ('service_role',
   * 'ai-client', 'workday-sync-worker').
   */
  actorLabel: string;
  /** e.g. 'candidate', 'integration_credential'. */
  entityType: string;
  entityId: string;
  /** Column / field names read, when known. */
  fieldsAccessed?: string[] | null;
  /** snake_case call site, e.g. 'get_candidate_by_id'. */
  reason: string;
  requestId?: string | null;
}

/**
 * Records a single pii_access_log row. Returns immediately — the insert
 * settles asynchronously on the pool. Do not await this to gate a response.
 */
export function recordPiiAccess(args: RecordPiiAccessArgs): void {
  void poolDb
    .insert(piiAccessLog)
    .values({
      tenantId: args.tenantId,
      actorUserId: args.actorUserId ?? null,
      actorMembershipId: args.actorMembershipId ?? null,
      actorLabel: args.actorLabel,
      entityType: args.entityType,
      entityId: args.entityId,
      fieldsAccessed: args.fieldsAccessed ?? null,
      reason: args.reason,
      requestId: args.requestId ?? null,
    })
    .then(() => undefined)
    .catch((err: unknown) => {
      // Never rethrow — accountability logging is best-effort and must not
      // break the caller. Logged so the loss is investigable.
      console.error("[pii_access_log] write failed", {
        err,
        tenantId: args.tenantId,
        entityType: args.entityType,
        entityId: args.entityId,
        reason: args.reason,
      });
    });
}
