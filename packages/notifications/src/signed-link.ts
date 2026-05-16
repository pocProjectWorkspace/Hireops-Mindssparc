import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 signed links — short, opaque, single-use tokens for
 * unauthenticated actions (candidate "confirm withdrawal", "view offer
 * letter"). Stateless: the token carries (action, subjectId, expiresAt)
 * + a MAC; verify() recomputes the MAC from the secret and rejects on
 * mismatch or expiry. Storage-side one-time-use is enforced by
 * signed_link_uses (UNIQUE on token_hash); see verifyAndConsume() in
 * the API route consumer.
 *
 * Token format (base64url, no padding):
 *   <payloadB64>.<macB64>
 *   payload = JSON.stringify({ a: action, s: subjectId, e: expiresEpochS, n: nonceHex })
 *
 * The nonce makes two tokens for the same (action, subject, expiresAt)
 * distinct — so the per-token UNIQUE index on signed_link_uses doesn't
 * cause a collision if the same email goes out twice (e.g. retry).
 *
 * The secret comes from SIGNED_LINK_SECRET (required at boot). Rotation
 * is a future ticket; for now a single secret with a long random value.
 */

const NONCE_BYTES = 16;

export interface SignedLinkPayload {
  action: string;
  subjectId: string;
  expiresAt: Date;
}

export interface VerifiedSignedLink extends SignedLinkPayload {
  /** SHA-256 of the raw token — what signed_link_uses stores. */
  tokenHash: string;
}

interface RawPayload {
  a: string;
  s: string;
  e: number;
  n: string;
}

function getSecret(): string {
  const secret = process.env.SIGNED_LINK_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SIGNED_LINK_SECRET is missing or shorter than 32 chars. " +
        "Generate with: openssl rand -base64 48",
    );
  }
  return secret;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function mac(payloadB64: string): Buffer {
  return createHmac("sha256", getSecret()).update(payloadB64).digest();
}

export function signLink(payload: SignedLinkPayload): string {
  const raw: RawPayload = {
    a: payload.action,
    s: payload.subjectId,
    e: Math.floor(payload.expiresAt.getTime() / 1000),
    n: randomBytes(NONCE_BYTES).toString("hex"),
  };
  const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(raw), "utf8"));
  const macB64 = b64urlEncode(mac(payloadB64));
  return `${payloadB64}.${macB64}`;
}

export type VerifyResult =
  | { ok: true; payload: VerifiedSignedLink }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyLink(token: string): VerifyResult {
  const dot = token.indexOf(".");
  if (dot < 0) return { ok: false, reason: "malformed" };
  const payloadB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  if (!payloadB64 || !macB64) return { ok: false, reason: "malformed" };

  const expectedMac = mac(payloadB64);
  let providedMac: Buffer;
  try {
    providedMac = b64urlDecode(macB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (providedMac.length !== expectedMac.length) {
    return { ok: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(providedMac, expectedMac)) {
    return { ok: false, reason: "bad_signature" };
  }

  let raw: RawPayload;
  try {
    raw = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as RawPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof raw.a !== "string" || typeof raw.s !== "string" || typeof raw.e !== "number") {
    return { ok: false, reason: "malformed" };
  }

  const expiresAt = new Date(raw.e * 1000);
  if (Number.isNaN(expiresAt.getTime())) return { ok: false, reason: "malformed" };
  if (expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

  return {
    ok: true,
    payload: {
      action: raw.a,
      subjectId: raw.s,
      expiresAt,
      tokenHash: hashToken(token),
    },
  };
}

/**
 * SHA-256 of the raw token — what signed_link_uses.token_hash stores.
 * Plain (non-keyed) hash so an audit query can recompute hashes from
 * raw tokens (e.g. an inspector dumping a captured token from a log)
 * without holding SIGNED_LINK_SECRET.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
