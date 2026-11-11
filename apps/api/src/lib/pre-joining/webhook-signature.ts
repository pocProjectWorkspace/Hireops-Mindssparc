/**
 * PC-15 — verify a Resend webhook (Resend signs webhooks with Svix).
 *
 * Headers: `svix-id`, `svix-timestamp` (unix seconds), `svix-signature`
 * (space-separated list of `v1,<base64 HMAC-SHA256>`). Signed content is
 * `${id}.${timestamp}.${rawBody}`; the key is the base64 part of the
 * endpoint secret `whsec_<base64>` shown in the Resend dashboard.
 *
 * Dependency-free (node:crypto), constant-time compare, 5-minute timestamp
 * tolerance against replay. An unsigned / malformed / stale / mismatched
 * request is rejected — and so is EVERY request when no secret is configured
 * (fail closed: an inbound route without a secret would accept forged
 * "candidate replies").
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "no_secret" | "missing_headers" | "stale_timestamp" | "bad_signature";
    };

function secretKey(secret: string): Buffer {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(raw, "base64");
}

export function signWebhookPayload(
  secret: string,
  id: string,
  timestamp: number,
  rawBody: string,
): string {
  const mac = createHmac("sha256", secretKey(secret))
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  return `v1,${mac}`;
}

export function verifyResendWebhook(args: {
  secret: string | undefined | null;
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null };
  rawBody: string;
  nowSeconds?: number;
}): WebhookVerifyResult {
  const secret = args.secret?.trim();
  if (!secret) return { ok: false, reason: "no_secret" };
  const { id, timestamp, signature } = args.headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
  const ts = Number(timestamp);
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = Buffer.from(signWebhookPayload(secret, id, ts, args.rawBody).slice(3), "base64");
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    let given: Buffer;
    try {
      given = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}
