import { decodeJwt } from "jose";
import { roleLabel } from "@hireops/api-types";

/**
 * Session shape used internally — flattens the bits we care about so
 * downstream callers don't have to know Supabase's nested response.
 */
export interface AuthSession {
  accessToken: string;
  userId: string;
  tenantId: string;
  roles: string[];
  /** Present when the Supabase JWT carries the standard `email` claim.
   * Purely for display (the sidebar user chip); never load-bearing. */
  email?: string;
}

/**
 * Decode an internal identity out of a Supabase access token.
 *
 * `tid` / `roles` are custom claims stamped by the Custom Access Token hook
 * (db migration 0002), which reads `tenant_user_memberships`. CANDIDATES AND
 * PARTNERS HAVE NO MEMBERSHIP ROW, so their tokens are perfectly valid but
 * carry no `tid` — signing in with one is a wrong-door mistake, not a broken
 * token. Returning `null` for that case is what lets the internal surfaces
 * bounce the caller calmly instead of exploding; treating it as malformed is
 * exactly the bug that put a raw "JWT missing required claims" error page in
 * front of anyone who typed candidate or partner credentials into /login.
 *
 * A token with no `sub` at all IS malformed — nothing issued it that we'd
 * trust — so that still throws.
 *
 * Pure + framework-free so it can be unit-tested and shared by the server
 * guards (lib/auth.ts) and the login form's up-front check.
 */
export function readSessionClaims(accessToken: string): AuthSession | null {
  // We trust the verified-at-issuance JWT — Supabase's auth gateway
  // signed it. Re-verifying here would require a JWKS roundtrip per
  // server render, which is the same workload `apps/api`'s
  // tenantContext middleware performs once per HTTP request. For
  // server-component reads we trust the cookie + Supabase's session
  // refresh contract.
  const raw = decodeJwt(accessToken) as {
    sub?: string;
    tid?: string;
    roles?: string[];
    email?: string;
  };
  if (!raw.sub) {
    throw new Error("JWT missing required claim (sub)");
  }
  if (!raw.tid) {
    return null;
  }
  return {
    accessToken,
    userId: raw.sub,
    tenantId: raw.tid,
    roles: Array.isArray(raw.roles) ? raw.roles : [],
    email: typeof raw.email === "string" ? raw.email : undefined,
  };
}

/**
 * Display label + role for the sidebar user chip. Prefers the email claim;
 * falls back to a generic label. Role is the first membership role's
 * PLATFORM-DEFAULT display label ("hr_head" → "HR Head"); the chip swaps in
 * the tenant's own label client-side (PC-23, RoleName). Pure — no I/O.
 */
export function sessionUserChip(session: AuthSession): {
  label: string;
  role: string;
  roleKey?: string;
} {
  const primary = session.roles[0] ?? "";
  return {
    label: session.email ?? "Signed in",
    role: roleLabel(primary),
    ...(primary ? { roleKey: primary } : {}),
  };
}
