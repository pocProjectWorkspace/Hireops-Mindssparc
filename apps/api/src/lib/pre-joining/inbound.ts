/**
 * PC-15 — an inbound candidate reply (already signature-verified) → stored
 * message → classified signals → recruiter alerts.
 *
 *   1. Only `email.received` events are handled; anything else is ignored.
 *   2. Match: the reply-to token in the recipient list (replies+<token>@…)
 *      → pre_joining_journeys.reply_token → tenant + application. No token /
 *      unknown token → not stored (there is no tenant to store it under).
 *   3. Store in candidate_inbound_messages, idempotent on Resend's email id
 *      (a webhook redelivery is a no-op).
 *   4. Body: from the payload when present, else fetched from Resend's
 *      Received-emails API (the webhook carries metadata only).
 *   5. Classify (kill switch `engagement_reply_signals`; fixture client in
 *      tests) only the candidate's NEW text (quoted history stripped), keep
 *      only verbatim-verified quotes of known types, raise signals → alerts.
 *
 * A classification failure leaves the message stored with
 * classification_status = 'failed' — the reply is never lost, and the route
 * still answers 200 so the provider does not redeliver.
 */

import { sql as poolSql } from "@hireops/db";
import type { Logger } from "@hireops/observability";
import { getAIClient, maskPiiIf, resolveTenantAiSettings } from "@hireops/ai-client";
import { extractReplyToken, stripQuotedReply, verifyClassifiedSignals } from "@hireops/api-types";
import { loadPreJoiningSettings, raiseRiskSignal } from "./journey";
import {
  REPLY_SIGNALS_FEATURE,
  REPLY_SIGNALS_PROMPT_VERSION,
  REPLY_SIGNALS_SCHEMA_NAME,
  buildReplySignalsPrompt,
  replySignalsAiJsonSchema,
  replySignalsAiSchema,
  type ReplySignalsAiResponse,
} from "./reply-classifier";

type PgSqlClient = typeof poolSql;

/** The subset of Resend's `email.received` webhook we read. */
export interface ResendInboundEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[] | string;
    cc?: string[] | string;
    subject?: string;
    /** Not part of Resend's webhook today; honoured if present (and in tests). */
    text?: string;
    html?: string;
  };
}

export type InboundBodyFetcher = (
  emailId: string,
) => Promise<{ text: string | null; html: string | null } | null>;

/** Resend Received-emails API: GET /emails/receiving/{id}. */
export const fetchResendReceivedBody: InboundBodyFetcher = async (emailId) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const res = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
    {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`Resend receiving API ${res.status}`);
  const body = (await res.json()) as { text?: unknown; html?: unknown };
  return {
    text: typeof body.text === "string" ? body.text : null,
    html: typeof body.html === "string" ? body.html : null,
  };
};

function asList(v: string[] | string | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [v];
}

/** Crude HTML → text for when only HTML is available (classification only). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export type InboundOutcome =
  | { status: "ignored"; reason: string }
  | { status: "unmatched" }
  | { status: "duplicate"; messageId: string | null }
  | {
      status: "stored";
      messageId: string;
      classification: "done" | "failed" | "skipped";
      signals: number;
      dropped: number;
    };

export async function processInboundReply(
  sql: PgSqlClient,
  event: ResendInboundEvent,
  opts: { log: Logger; fetchBody?: InboundBodyFetcher },
): Promise<InboundOutcome> {
  const log = opts.log;
  if (event.type !== "email.received" || !event.data) {
    return { status: "ignored", reason: `type:${event.type ?? "none"}` };
  }
  const d = event.data;
  const recipients = [...asList(d.to), ...asList(d.cc)];
  const token = extractReplyToken(recipients);
  if (!token) return { status: "unmatched" };

  const [journey] = await sql<
    { id: string; tenant_id: string; application_id: string; status: string }[]
  >`
    SELECT id, tenant_id, application_id, status
    FROM public.pre_joining_journeys WHERE reply_token = ${token} LIMIT 1
  `;
  if (!journey) return { status: "unmatched" };

  let text = typeof d.text === "string" ? d.text : null;
  let html = typeof d.html === "string" ? d.html : null;
  if (text === null && html === null && d.email_id) {
    try {
      const fetched = await (opts.fetchBody ?? fetchResendReceivedBody)(d.email_id);
      text = fetched?.text ?? null;
      html = fetched?.html ?? null;
    } catch (err) {
      log.warn({ err, email_id: d.email_id }, "pre_joining.inbound_body_fetch_failed");
    }
  }

  const toEmail =
    recipients.find((r) => r.toLowerCase().includes(`replies+${token}@`)) ?? recipients[0] ?? "";
  const inserted = await sql<{ id: string }[]>`
    INSERT INTO public.candidate_inbound_messages
      (tenant_id, application_id, journey_id, from_email, to_email, subject,
       body_text, body_html, resend_message_id, classification_status)
    VALUES (${journey.tenant_id}, ${journey.application_id}, ${journey.id},
            ${(d.from ?? "").slice(0, 320)}, ${toEmail.slice(0, 320)}, ${d.subject ?? null},
            ${text}, ${html}, ${d.email_id ?? null}, 'pending')
    ON CONFLICT (tenant_id, resend_message_id) WHERE resend_message_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  const messageId = inserted[0]?.id;
  if (!messageId) return { status: "duplicate", messageId: null };

  const settings = await loadPreJoiningSettings(sql, journey.tenant_id);
  const aiSettings = await resolveTenantAiSettings(sql, journey.tenant_id);
  const feature = aiSettings[REPLY_SIGNALS_FEATURE];
  const plain = stripQuotedReply(text ?? (html ? htmlToText(html) : ""));

  const markSkipped = async (why: string) => {
    await sql`
      UPDATE public.candidate_inbound_messages
      SET classification_status = 'skipped', classification_error = ${why}, classified_at = now()
      WHERE tenant_id = ${journey.tenant_id} AND id = ${messageId}
    `;
    return {
      status: "stored" as const,
      messageId,
      classification: "skipped" as const,
      signals: 0,
      dropped: 0,
    };
  };
  if (!settings.enabled) return markSkipped("engagement disabled");
  if (!feature.enabled) return markSkipped("feature disabled");
  if (plain.trim().length === 0) return markSkipped("no text");

  try {
    // PII masking (tenant setting) applies to what the model sees. Quotes are
    // verified against the SAME text the model saw, so a masked span can never
    // be "quoted" back as if the candidate wrote the mask.
    const modelText = maskPiiIf(aiSettings.piiMasking, plain);
    const built = buildReplySignalsPrompt({ messageText: modelText });
    const client = await getAIClient(journey.tenant_id);
    const response = await client.completeStructured<ReplySignalsAiResponse>({
      system: built.system,
      prompt: built.user,
      model: feature.model,
      temperature: feature.temperature,
      maxTokens: feature.maxTokens,
      schema: replySignalsAiJsonSchema,
      schemaName: REPLY_SIGNALS_SCHEMA_NAME,
      feature: REPLY_SIGNALS_FEATURE,
      requestId: messageId,
    });
    const raw = replySignalsAiSchema.parse(response);
    const { signals, dropped } = verifyClassifiedSignals(raw.signals, modelText);

    let raised = 0;
    for (const s of signals) {
      const r = await raiseRiskSignal(sql, {
        tenantId: journey.tenant_id,
        applicationId: journey.application_id,
        journeyId: journey.id,
        type: s.type,
        source: "inbound_email",
        quote: s.quote,
        inboundMessageId: messageId,
        settings,
        log,
      });
      if (r.signalId) raised += 1;
    }
    await sql`
      UPDATE public.candidate_inbound_messages
      SET classification_status = 'done', classification_error = NULL, classified_at = now(),
          classifier_model = ${feature.model}, classifier_prompt_version = ${REPLY_SIGNALS_PROMPT_VERSION}
      WHERE tenant_id = ${journey.tenant_id} AND id = ${messageId}
    `;
    log.info({ message_id: messageId, signals: raised, dropped }, "pre_joining.inbound_classified");
    return { status: "stored", messageId, classification: "done", signals: raised, dropped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE public.candidate_inbound_messages
      SET classification_status = 'failed', classification_error = ${msg.slice(0, 1000)}
      WHERE tenant_id = ${journey.tenant_id} AND id = ${messageId}
    `;
    log.warn({ err: msg, message_id: messageId }, "pre_joining.inbound_classify_failed");
    return { status: "stored", messageId, classification: "failed", signals: 0, dropped: 0 };
  }
}
