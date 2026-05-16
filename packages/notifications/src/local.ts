import { randomUUID } from "node:crypto";
import { db as poolDb, devEmailOutbox } from "@hireops/db";
import type { EmailMessage, EmailProvider, EmailSendResult } from "./types";

/**
 * Dev / test EmailProvider — writes the rendered message to
 * dev_email_outbox instead of sending anything. The worker still
 * marks the notification_outbox row sent + records providerMessageId,
 * so end-to-end flow runs identically to production.
 *
 * Uses the unscoped pool (poolDb) — the worker runs as service_role
 * and has no current_tenant_id() set. tenant_id is provided
 * explicitly on every insert.
 */
export class LocalEmailProvider implements EmailProvider {
  readonly provider = "local" as const;

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    await poolDb.insert(devEmailOutbox).values({
      tenantId: msg.tenantId,
      recipientEmail: msg.to,
      subject: msg.subject,
      renderedHtml: msg.html,
      renderedText: msg.text,
      templateKey: msg.templateKey,
      outboxId: msg.outboxId,
    });
    return { providerMessageId: `local-${randomUUID()}` };
  }
}
