import { randomUUID } from "node:crypto";
import { sql as poolSql } from "@hireops/db";
import { getEmailProvider, type EmailProvider, type TemplateKey } from "@hireops/notifications";
import { renderTemplate, type EmailTemplateOverrides } from "@hireops/email-templates";
import type { Logger } from "@hireops/observability";

/**
 * Outbox drain — one pass:
 *   1. UPDATE ... SET status='processing', claimed_by=workerId, claimed_at=now()
 *      WHERE id IN (SELECT id FROM notification_outbox
 *                   WHERE status='pending' AND (scheduled_for IS NULL OR scheduled_for <= now())
 *                   ORDER BY priority, created_at
 *                   LIMIT batchSize FOR UPDATE SKIP LOCKED)
 *      RETURNING *.
 *   2. For each claimed row: render template, send via EmailProvider,
 *      then UPDATE status='sent', sent_at=now(), provider_message_id=...
 *   3. On error: increment attempt_count, set last_error, decide
 *      pending (retry) vs failed (exhausted) based on attemptCap.
 *
 * SKIP LOCKED makes the claim race-free under multiple workers. Wave 1
 * runs only one worker, but the worker-instance discipline is cheap to
 * keep.
 *
 * Per-row try/catch so one bad render or one provider 4xx doesn't
 * stall the rest of the batch.
 */

export interface DispatcherOpts {
  batchSize?: number;
  attemptCap?: number;
  workerId?: string;
  log: Logger;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  recipient_type: string;
  recipient_email: string;
  template_key: string;
  template_data: Record<string, unknown>;
  attempt_count: number;
}

const DEFAULT_BATCH = 25;
const DEFAULT_ATTEMPT_CAP = 5;

interface OverrideRow {
  subject_override: string | null;
  slot_overrides: Record<string, string> | null;
}

/**
 * Load the tenant's ENABLED copy override for (tenant, template_key), if any
 * (T1.4 / G09). No row, or a disabled row, yields `undefined` — the render then
 * uses the code-owned default copy (byte-identical to a tenant with no override).
 * Only the subject + named text slots are carried; there is no raw-HTML path.
 */
async function loadTemplateOverrides(
  tenantId: string,
  templateKey: string,
): Promise<EmailTemplateOverrides | undefined> {
  const [row] = await poolSql<OverrideRow[]>`
    SELECT subject_override, slot_overrides
    FROM public.tenant_email_template_overrides
    WHERE tenant_id = ${tenantId} AND template_key = ${templateKey} AND enabled = true
    LIMIT 1
  `;
  if (!row) return undefined;
  const slots = row.slot_overrides ?? {};
  const overrides: EmailTemplateOverrides = {};
  if (row.subject_override && row.subject_override.trim().length > 0) {
    overrides.subject = row.subject_override;
  }
  if (Object.keys(slots).length > 0) overrides.slots = slots;
  // A row that enables an override but carries neither a subject nor any slot is
  // functionally a no-op — return undefined so the render stays default.
  return overrides.subject || overrides.slots ? overrides : undefined;
}

export async function drainOutboxOnce(opts: DispatcherOpts): Promise<{
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const attemptCap = opts.attemptCap ?? DEFAULT_ATTEMPT_CAP;
  const workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  const log = opts.log;

  const rows = await poolSql<ClaimedRow[]>`
    UPDATE public.notification_outbox
    SET status = 'processing', claimed_by = ${workerId}, claimed_at = now(),
        attempt_count = attempt_count + 1, last_attempt_at = now()
    WHERE id IN (
      SELECT id FROM public.notification_outbox
      WHERE status = 'pending'
        AND (scheduled_for IS NULL OR scheduled_for <= now())
      ORDER BY priority, created_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, recipient_type, recipient_email,
              template_key, template_data, attempt_count
  `;

  if (rows.length === 0) return { claimed: 0, sent: 0, retried: 0, failed: 0 };

  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const row of rows) {
    const childLog = log.child({
      outbox_id: row.id,
      tenant_id: row.tenant_id,
      template_key: row.template_key,
      attempt: row.attempt_count,
    });
    try {
      const overrides = await loadTemplateOverrides(row.tenant_id, row.template_key);
      const rendered = await renderTemplate(
        row.template_key as TemplateKey,
        row.template_data ?? {},
        overrides,
      );
      const provider: EmailProvider = getEmailProvider(row.tenant_id);
      const result = await provider.send({
        to: row.recipient_email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(rendered.attachments ? { attachments: rendered.attachments } : {}),
        templateKey: row.template_key as TemplateKey,
        tenantId: row.tenant_id,
        outboxId: row.id,
      });
      await poolSql`
        UPDATE public.notification_outbox
        SET status = 'sent', sent_at = now(),
            provider_message_id = ${result.providerMessageId},
            subject = ${rendered.subject}
        WHERE id = ${row.id}
      `;
      sent += 1;
      childLog.info("notification.sent");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const exhausted = row.attempt_count >= attemptCap;
      if (exhausted) {
        await poolSql`
          UPDATE public.notification_outbox
          SET status = 'failed', last_error = ${errMsg}
          WHERE id = ${row.id}
        `;
        failed += 1;
        childLog.error({ err: errMsg }, "notification.failed_terminal");
      } else {
        await poolSql`
          UPDATE public.notification_outbox
          SET status = 'pending', last_error = ${errMsg},
              claimed_by = NULL, claimed_at = NULL
          WHERE id = ${row.id}
        `;
        retried += 1;
        childLog.warn({ err: errMsg }, "notification.retry_scheduled");
      }
    }
  }

  return { claimed: rows.length, sent, retried, failed };
}

/**
 * Recover rows stuck in 'processing' — happens when a worker crashes
 * between claim and final update. Anything still 'processing' after
 * the timeout is re-eligible.
 */
export async function recoverOrphans(staleMs = 5 * 60_000): Promise<number> {
  // ISO string — postgres-js rejects raw Date objects as bind params.
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const rows = await poolSql<{ id: string }[]>`
    UPDATE public.notification_outbox
    SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
        last_error = COALESCE(last_error, '') || ' [orphan_recovered]'
    WHERE status = 'processing' AND claimed_at < ${cutoff}
    RETURNING id
  `;
  return rows.length;
}
