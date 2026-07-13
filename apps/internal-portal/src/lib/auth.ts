import { redirect } from "next/navigation";
import { decodeJwt } from "jose";
import { createSupabaseServerClient } from "./supabase-server";

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
 * Display label + role for the sidebar user chip. Prefers the email claim;
 * falls back to a generic label. Role is the first membership role,
 * title-cased ("admin" → "Admin"). Pure formatting — no I/O.
 */
export function sessionUserChip(session: AuthSession): { label: string; role: string } {
  const primary = session.roles[0] ?? "";
  const role = primary ? primary.charAt(0).toUpperCase() + primary.slice(1).replace(/_/g, " ") : "";
  return { label: session.email ?? "Signed in", role };
}

/**
 * Server-component / route-handler auth guard. Returns the session if
 * present + valid; redirects to /login otherwise. Next's `redirect()`
 * throws a special error the framework catches — never returns.
 *
 * The JWT itself carries `tid` / `roles` (custom claims stamped by the
 * Supabase auth hook per FND-15b). Decoding here avoids a DB roundtrip
 * for every server-component render.
 */
export async function requireAuth(): Promise<AuthSession> {
  const supabase = createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect("/login");
  }
  return readSessionClaims(session.access_token);
}

/**
 * Stronger guard: requires the caller to have the 'admin' role on
 * their tenant membership. /admin/* routes use this. Anyone else gets
 * a 403-equivalent (we redirect to /triage rather than show a bare 403
 * — the user is authenticated, just on the wrong screen).
 */
export async function requireAdmin(): Promise<AuthSession> {
  const session = await requireAuth();
  if (!session.roles.includes("admin")) {
    redirect("/triage");
  }
  return session;
}

/**
 * Variant for pages that prefer to render their own "please log in"
 * affordance instead of redirecting. Returns null when unauthenticated.
 */
export async function getOptionalSession(): Promise<AuthSession | null> {
  const supabase = createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  return readSessionClaims(session.access_token);
}

function readSessionClaims(accessToken: string): AuthSession {
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
  if (!raw.sub || !raw.tid) {
    throw new Error("JWT missing required claims (sub, tid)");
  }
  return {
    accessToken,
    userId: raw.sub,
    tenantId: raw.tid,
    roles: Array.isArray(raw.roles) ? raw.roles : [],
    email: typeof raw.email === "string" ? raw.email : undefined,
  };
}
