/**
 * PC-15 — the Resend inbound webhook + the pulse check-in, end to end through
 * the Hono app (app.request — no server), against a real DB, with the
 * LocalAIClient fixture tier (NODE_ENV=test) standing in for the model.
 *
 *   1. Signature: unsigned → 401; wrong secret → 401; stale timestamp → 401;
 *      no secret configured → 503 (fail closed). Nothing is stored.
 *   2. Token match: a reply to replies+<token>@… is stored against the right
 *      tenant / application / journey; an unknown token is not stored.
 *   3. Classify via fixture: the reply's NEW text (quoted history stripped)
 *      is classified; the fixture returns one verbatim quote, one paraphrase
 *      and one off-list type — only the verbatim, on-list signal is kept.
 *   4. Alert: the kept signal is an open candidate_risk_signals row and the
 *      application's recruiter gets ONE recruiter.joining_risk_signal email
 *      carrying the quote. Redelivery of the same webhook is a no-op.
 *   5. Pulse: "Unsure" + comment via the signed link → response stored,
 *      pulse_unsure signal with the comment as quote, recruiter alerted;
 *      a second submit is 409.
 *
 * Synthetic tenant (namespace 15a). REQUIRES migration 0128.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql as poolSql } from "@hireops/db";
import { createLogger } from "@hireops/observability";
import { hashStructuredOptions } from "@hireops/ai-client";
import { AI_DEFAULT_MODEL, stripQuotedReply } from "@hireops/api-types";
import { signLink } from "@hireops/notifications";
import { app } from "../src/index";
import { startPreJoiningJourney } from "../src/lib/pre-joining/journey";
import {
  REPLY_SIGNALS_FEATURE,
  REPLY_SIGNALS_SCHEMA_NAME,
  buildReplySignalsPrompt,
  replySignalsAiJsonSchema,
} from "../src/lib/pre-joining/reply-classifier";
import { signWebhookPayload } from "../src/lib/pre-joining/webhook-signature";
import { hashToken } from "@hireops/notifications";
import {
  ENABLED_IST,
  cleanupTenant,
  seedAcceptedCandidate,
  seedIds,
  seedTenant,
} from "./pc14-helpers";

/** Narrow away undefined/null, failing loudly (instead of a non-null assertion). */
function must<V>(v: V | null | undefined, what = "value"): V {
  if (v === null || v === undefined) throw new Error(`expected ${what}`);
  return v;
}

const ids = seedIds("15a");
const log = createLogger({ base: { service: "pc15-webhook-test" } });
const SECRET = `whsec_${Buffer.from("pc15-test-secret-0123456789abcdef").toString("base64")}`;

const REPLY_TEXT = [
  "Hi Arjun,",
  "",
  "Thanks for the update. To be honest my current employer has made a counter offer and I am still deciding.",
  "",
  "On Tue, 10 Nov 2026 at 10:00, PC14 Synth <replies@example.test> wrote:",
  "> Are you still on track to join? I have another offer?",
].join("\n");

const FIXTURE_JSON = {
  signals: [
    { type: "counter_offer", quote: "my current employer has made a counter offer" },
    { type: "doubt_or_hesitation", quote: "I am unsure about joining" }, // paraphrase — dropped
    { type: "flight_risk_score", quote: "I am still deciding" }, // off-list — dropped
    // From the QUOTED history (our own words) — not in the stripped text — dropped.
    { type: "other_offer", quote: "I have another offer" },
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
const AI_FIXTURE_DIR = resolve(here, "../../../packages/ai-client/src/local/fixtures");
const written: string[] = [];

async function primeFixture(text: string, json: unknown): Promise<void> {
  const built = buildReplySignalsPrompt({ messageText: stripQuotedReply(text) });
  const hash = hashStructuredOptions({
    system: built.system,
    prompt: built.user,
    model: AI_DEFAULT_MODEL,
    schema: replySignalsAiJsonSchema,
    schemaName: REPLY_SIGNALS_SCHEMA_NAME,
    feature: REPLY_SIGNALS_FEATURE,
  });
  await mkdir(AI_FIXTURE_DIR, { recursive: true });
  const path = resolve(AI_FIXTURE_DIR, `${hash}.json`);
  await writeFile(
    path,
    JSON.stringify({ json, inputTokens: 600, outputTokens: 80, costMicros: 2000, latencyMs: 300 }),
  );
  written.push(path);
}

function webhookBody(token: string, emailId: string, text: string) {
  return JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      from: "Priya Test <priya@example.test>",
      to: [`replies+${token}@in.example.test`],
      subject: "Re: Quick check-in",
      text,
    },
  });
}

async function post(body: string, headers: Record<string, string>) {
  return app.request("/api/pre-joining/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function signed(body: string, opts: { secret?: string; ts?: number } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  return {
    "svix-id": id,
    "svix-timestamp": String(ts),
    "svix-signature": signWebhookPayload(opts.secret ?? SECRET, id, ts, body),
  };
}

async function inboundCount(): Promise<number> {
  const [r] = await poolSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM public.candidate_inbound_messages WHERE tenant_id = ${ids.T}
  `;
  return r?.n ?? 0;
}

describe("PC-15 — inbound webhook + pulse signals", () => {
  let A: Awaited<ReturnType<typeof seedAcceptedCandidate>>;
  let replyToken: string;
  const prevSecret = process.env.RESEND_INBOUND_WEBHOOK_SECRET;

  beforeAll(async () => {
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    await seedTenant(ids, "15a", ENABLED_IST);
    const now = new Date();
    A = await seedAcceptedCandidate(ids, "0001", {
      joiningDate: new Date(now.getTime() + 50 * 86_400_000).toISOString().slice(0, 10),
      acceptedAt: now,
    });
    const r = await startPreJoiningJourney(poolSql, { tenantId: ids.T, applicationId: A.app, log });
    assert.equal(r.created, true);
    const [j] = await poolSql<{ reply_token: string }[]>`
      SELECT reply_token FROM public.pre_joining_journeys WHERE id = ${r.journeyId}
    `;
    replyToken = must(j).reply_token;
    await primeFixture(REPLY_TEXT, FIXTURE_JSON);
  });

  afterAll(async () => {
    if (prevSecret === undefined) delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    else process.env.RESEND_INBOUND_WEBHOOK_SECRET = prevSecret;
    for (const p of written) await unlink(p).catch(() => undefined);
    await cleanupTenant(ids);
    await poolSql.end({ timeout: 5 });
  });

  it("rejects unsigned, wrongly signed and stale requests; fails closed without a secret", async () => {
    const body = webhookBody(replyToken, `em_reject_${Date.now()}`, REPLY_TEXT);
    assert.equal((await post(body, {})).status, 401);
    const wrong = `whsec_${Buffer.from("some-other-secret-0123456789abcd").toString("base64")}`;
    assert.equal((await post(body, signed(body, { secret: wrong }))).status, 401);
    assert.equal(
      (await post(body, signed(body, { ts: Math.floor(Date.now() / 1000) - 3600 }))).status,
      401,
    );
    // Tampered body with a valid signature for the original.
    const h = signed(body);
    assert.equal((await post(body.replace("counter offer", "great offer"), h)).status, 401);
    delete process.env.RESEND_INBOUND_WEBHOOK_SECRET;
    assert.equal((await post(body, signed(body))).status, 503);
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = SECRET;
    assert.equal(await inboundCount(), 0);
  });

  it("does not store a reply whose token matches no journey", async () => {
    const body = webhookBody("0".repeat(32), `em_unknown_${Date.now()}`, REPLY_TEXT);
    const res = await post(body, signed(body));
    assert.equal(res.status, 200);
    const json = (await res.json()) as { status: string };
    assert.equal(json.status, "unmatched");
    assert.equal(await inboundCount(), 0);
  });

  it("matches by token, classifies via fixture, keeps only verbatim on-list quotes, alerts the recruiter once", async () => {
    const emailId = `em_ok_${Date.now()}`;
    const body = webhookBody(replyToken, emailId, REPLY_TEXT);
    const res = await post(body, signed(body));
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      status: string;
      classification: string;
      signals: number;
      dropped: number;
    };
    assert.equal(json.status, "stored");
    assert.equal(json.classification, "done");
    assert.equal(json.signals, 1);
    assert.equal(json.dropped, 3);

    const [msg] = await poolSql<
      {
        id: string;
        application_id: string;
        journey_id: string;
        classification_status: string;
        classifier_prompt_version: string;
      }[]
    >`
      SELECT id, application_id, journey_id, classification_status, classifier_prompt_version
      FROM public.candidate_inbound_messages WHERE tenant_id = ${ids.T} AND resend_message_id = ${emailId}
    `;
    assert.equal(msg?.application_id, A.app);
    assert.ok(msg?.journey_id);
    assert.equal(msg?.classification_status, "done");
    assert.equal(msg?.classifier_prompt_version, "pc15-v1");

    const sigs = await poolSql<
      { signal_type: string; quote: string; status: string; alerted_at: Date | null }[]
    >`
      SELECT signal_type, quote, status, alerted_at FROM public.candidate_risk_signals
      WHERE tenant_id = ${ids.T} AND inbound_message_id = ${must(msg).id}
    `;
    assert.equal(sigs.length, 1);
    assert.equal(sigs[0]?.signal_type, "counter_offer");
    assert.equal(sigs[0]?.quote, "my current employer has made a counter offer");
    assert.equal(sigs[0]?.status, "open");
    assert.ok(sigs[0]?.alerted_at);

    const alerts = await poolSql<
      { recipient_membership_id: string; template_data: Record<string, unknown> }[]
    >`
      SELECT recipient_membership_id, template_data FROM public.notification_outbox
      WHERE tenant_id = ${ids.T} AND template_key = 'recruiter.joining_risk_signal'
    `;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.recipient_membership_id, ids.REC_A);
    assert.equal(alerts[0]?.template_data.quote, "my current employer has made a counter offer");
    assert.match(
      String(alerts[0]?.template_data.timelineUrl),
      new RegExp(`/joining-watchlist/${A.app}$`),
    );

    // One usage row under the feature, keyed to the message.
    const [usage] = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.ai_usage_logs
      WHERE tenant_id = ${ids.T} AND feature = ${REPLY_SIGNALS_FEATURE} AND request_id = ${must(msg).id}
    `;
    assert.equal(usage?.n, 1);

    // Redelivery of the same email is a no-op.
    const again = await post(body, signed(body));
    assert.equal(((await again.json()) as { status: string }).status, "duplicate");
    assert.equal(await inboundCount(), 1);
  });

  it("pulse: 'Unsure' with a comment raises pulse_unsure (comment as quote) and alerts; resubmit is 409", async () => {
    const [tp] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.pre_joining_touchpoints
      WHERE tenant_id = ${ids.T} AND application_id = ${A.app} AND carries_pulse
      ORDER BY scheduled_for LIMIT 1
    `;
    const token = signLink({
      action: "candidate.pre_joining_pulse",
      subjectId: must(tp).id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    // A token that verifies but was never issued for this touchpoint is refused.
    const res404 = await app.request(`/api/pre-joining/pulse/${token}`);
    assert.equal(res404.status, 404);
    await poolSql`
      UPDATE public.pre_joining_touchpoints SET pulse_token_hash = ${hashToken(token)}, status = 'sent', sent_at = now()
      WHERE id = ${must(tp).id}
    `;
    const view = await app.request(`/api/pre-joining/pulse/${token}`);
    assert.equal(view.status, 200);
    const v = (await view.json()) as { open: boolean; candidateFirstName: string };
    assert.equal(v.open, true);
    assert.equal(v.candidateFirstName, "Priya");

    const submit = (payload: unknown) =>
      app.request(`/api/pre-joining/pulse/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    assert.equal((await submit({ onTrack: "maybe" })).status, 400);
    const ok = await submit({
      onTrack: "unsure",
      feeling: 3,
      comment: "Waiting on my release letter.",
    });
    assert.equal(ok.status, 200);
    assert.equal((await submit({ onTrack: "yes" })).status, 409);

    const [resp] = await poolSql<{ id: string; on_track: string; feeling: number }[]>`
      SELECT id, on_track, feeling FROM public.pre_joining_pulse_responses
      WHERE tenant_id = ${ids.T} AND touchpoint_id = ${must(tp).id}
    `;
    assert.deepEqual(
      { on_track: resp?.on_track, feeling: resp?.feeling },
      { on_track: "unsure", feeling: 3 },
    );
    const [sig] = await poolSql<{ signal_type: string; quote: string; source: string }[]>`
      SELECT signal_type, quote, source FROM public.candidate_risk_signals
      WHERE tenant_id = ${ids.T} AND pulse_response_id = ${must(resp).id}
    `;
    assert.deepEqual(sig, {
      signal_type: "pulse_unsure",
      quote: "Waiting on my release letter.",
      source: "pulse_response",
    });
    const [alerts] = await poolSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM public.notification_outbox
      WHERE tenant_id = ${ids.T} AND template_key = 'recruiter.joining_risk_signal'
    `;
    assert.equal(alerts?.n, 2);
  });
});
