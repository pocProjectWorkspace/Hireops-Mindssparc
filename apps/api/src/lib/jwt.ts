/**
 * JWT verification for incoming Supabase Auth tokens.
 *
 * Supabase moved access tokens from HS256 (symmetric, single shared secret)
 * to ES256 (asymmetric, JWKS) as part of API Keys 2.0. We fetch the project's
 * public keys from <SUPABASE_URL>/auth/v1/.well-known/jwks.json and cache
 * them via jose's createRemoteJWKSet (default cache 5min cooldown, 30s retry
 * on cache miss).
 *
 * SUPABASE_JWT_SECRET is no longer used for signature verification; if it's
 * still present in .env it's for legacy tooling only.
 */

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";
import type { JwtClaims } from "@hireops/db";

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) {
  throw new Error(
    "SUPABASE_URL is not set. Add it to .env from Supabase dashboard → Project Settings → API.",
  );
}

const issuer = `${supabaseUrl}/auth/v1`;
const audience = "authenticated";
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

export type JwtVerificationResult =
  | { ok: true; claims: JwtClaims }
  | {
      ok: false;
      reason: "missing" | "malformed" | "invalid_signature" | "expired";
    };

export async function verifyJwt(token: string | null | undefined): Promise<JwtVerificationResult> {
  if (!token) return { ok: false, reason: "missing" };

  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    return { ok: true, claims: payload as JwtClaims };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: "expired" };
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, reason: "invalid_signature" };
    }
    return { ok: false, reason: "malformed" };
  }
}

export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  return match?.[1] ?? null;
}
