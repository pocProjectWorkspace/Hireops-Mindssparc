import { Hono } from "hono";
import { sql as poolSql } from "@hireops/db";
import { submitPulseResponseInputSchema } from "@hireops/api-types";
import { baseLog } from "../lib/observability";
import { lookupPulse, publicPulseView, submitPulse } from "../lib/pre-joining/pulse";
import { processInboundReply, type ResendInboundEvent } from "../lib/pre-joining/inbound";
import { verifyResendWebhook } from "../lib/pre-joining/webhook-signature";

/**
 * PC-14 / PC-15 — public pre-joining endpoints.
 *
 *   GET  /api/pre-joining/pulse/:token   check-in context for the candidate page
 *   POST /api/pre-joining/pulse/:token   submit the one-question check-in
 *   POST /api/pre-joining/inbound        Resend inbound-email webhook
 *
 * The pulse token IS the credential (signed link, matched to its touchpoint).
 * The webhook is authenticated by its Svix signature against
 * RESEND_INBOUND_WEBHOOK_SECRET — unsigned / badly signed requests get 401,
 * and with no secret configured EVERY request is refused (fail closed).
 */
export const preJoiningRoutes = new Hono();

function clientIp(h: (name: string) => string | undefined): string | null {
  return h("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

preJoiningRoutes.get("/pulse/:token", async (c) => {
  const found = await lookupPulse(poolSql, c.req.param("token"));
  if (!found.ok) return c.json({ ok: false, reason: found.reason }, found.status);
  return c.json({ ok: true, ...publicPulseView(found.row) });
});

preJoiningRoutes.post("/pulse/:token", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, reason: "invalid_body" }, 400);
  }
  const parsed = submitPulseResponseInputSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, reason: "invalid_body" }, 400);
  const r = await submitPulse(poolSql, c.req.param("token"), parsed.data, {
    ip: clientIp((n) => c.req.header(n)),
    log: baseLog,
  });
  if (!r.ok) return c.json({ ok: false, reason: r.reason }, r.status);
  return c.json({ ok: true });
});

preJoiningRoutes.post("/inbound", async (c) => {
  const rawBody = await c.req.text();
  const v = verifyResendWebhook({
    secret: process.env.RESEND_INBOUND_WEBHOOK_SECRET,
    headers: {
      id: c.req.header("svix-id"),
      timestamp: c.req.header("svix-timestamp"),
      signature: c.req.header("svix-signature"),
    },
    rawBody,
  });
  if (!v.ok) {
    baseLog.warn(
      { reason: v.reason, ip: clientIp((n) => c.req.header(n)) },
      "pre_joining.inbound_rejected",
    );
    return c.json({ ok: false, reason: v.reason }, v.reason === "no_secret" ? 503 : 401);
  }
  let event: ResendInboundEvent;
  try {
    event = JSON.parse(rawBody) as ResendInboundEvent;
  } catch {
    return c.json({ ok: false, reason: "invalid_json" }, 400);
  }
  const outcome = await processInboundReply(poolSql, event, { log: baseLog });
  return c.json({ ok: true, ...outcome });
});
