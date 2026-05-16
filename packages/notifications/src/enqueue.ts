import { notificationOutbox, type NewNotificationOutbox } from "@hireops/db";
import type { EmailRecipientType, TemplateKey } from "./types";

/**
 * Insert a row into notification_outbox in the caller's transaction.
 *
 * Why a thin wrapper instead of an "exec the insert here" helper:
 *   - The caller's tx (protectedProcedure's withTenantContext) is what
 *     gives us RLS + atomicity with the triggering state change. We
 *     accept the same db handle so a tenant_isolation policy applies
 *     and the insert rolls back if the surrounding mutation throws.
 *   - The worker is the consumer; it polls. We do not call the
 *     EmailProvider here — that would block the request.
 *
 * dedupKey is optional. Pass it when the same logical event might fire
 * twice (mutation retried at the trpc layer; the schema's partial
 * UNIQUE on (tenant_id, dedup_key) rejects the second insert with a
 * 23505, which the caller can catch + treat as "already enqueued").
 *
 * priority defaults to 5 (the schema default). Reserve 0..4 for ops
 * (sla-imminent worker scan), 6..9 for non-urgent batches.
 */

export interface EnqueueNotificationArgs {
  tenantId: string;
  recipientType: EmailRecipientType;
  recipientEmail: string;
  recipientMembershipId?: string | null;
  recipientCandidateId?: string | null;
  templateKey: TemplateKey;
  templateData?: Record<string, unknown>;
  subject?: string | null;
  dedupKey?: string | null;
  priority?: number;
  scheduledFor?: Date | null;
}

/**
 * Loose `insert` shape — any Drizzle pg database (tx or pool) satisfies
 * it. Avoids importing PgDatabase<TSchema>, which forces every call site
 * to thread the schema generic.
 */
interface InsertableDb {
  insert: (table: typeof notificationOutbox) => {
    values: (row: NewNotificationOutbox) => {
      returning: (cols: { id: typeof notificationOutbox.id }) => Promise<{ id: string }[]>;
    };
  };
}

export async function enqueueNotification(
  db: InsertableDb,
  args: EnqueueNotificationArgs,
): Promise<{ outboxId: string }> {
  const row: NewNotificationOutbox = {
    tenantId: args.tenantId,
    recipientType: args.recipientType,
    recipientEmail: args.recipientEmail,
    recipientMembershipId: args.recipientMembershipId ?? null,
    recipientCandidateId: args.recipientCandidateId ?? null,
    templateKey: args.templateKey,
    templateData: args.templateData ?? {},
    subject: args.subject ?? null,
    dedupKey: args.dedupKey ?? null,
    priority: args.priority ?? 5,
    scheduledFor: args.scheduledFor ?? null,
  };

  const [inserted] = await db
    .insert(notificationOutbox)
    .values(row)
    .returning({ id: notificationOutbox.id });

  if (!inserted) {
    throw new Error("notification_outbox insert returned no row");
  }
  return { outboxId: inserted.id };
}
