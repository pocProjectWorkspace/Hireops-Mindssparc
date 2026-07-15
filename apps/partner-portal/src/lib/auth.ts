import { redirect } from "next/navigation";
import { decodeJwt } from "jose";
import { createSupabaseServerClient } from "./supabase-server";

/**
 * Partner session shape. CRUCIALLY different from the internal portal's
 * AuthSession: a partner-only identity's Supabase JWT carries a verified
 * `sub` but NO `tid`/`roles` claim, because the Custom Access Token hook
 * (db migration 0002) only reads tenant_user_memberships. The tenant +
 * partner_org + role are resolved server-side by the api's partnerProcedure
 * from partner_users — never decoded from the JWT here.
 *
 * So this guard only needs a present Supabase session with a `sub`. Whether
 * the identity is actually a partner (has an active partner_users row) is
 * decided downstream by partnerProcedure (partnerGetMe throws FORBIDDEN if
 * not), which the dashboard turns into the "not a partner account" state.
 */
export interface PartnerAuthSession {
  accessToken: string;
  userId: string;
  /** Present when the Supabase JWT carries the standard `email` claim.
   * Display-only (login chip fallback); never load-bearing. */
  email?: string;
}

/**
 * Server-component / route-handler auth guard. Returns the session if a
 * Supabase session is present; redirects to /login otherwise. Next's
 * redirect() throws a framework-caught error — never returns on that path.
 */
export async function requireAuth(): Promise<PartnerAuthSession> {
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
 * Variant that returns null instead of redirecting — for surfaces that
 * render their own "please sign in" affordance.
 */
export async function getOptionalSession(): Promise<PartnerAuthSession | null> {
  const supabase = createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  return readSessionClaims(session.access_token);
}

function readSessionClaims(accessToken: string): PartnerAuthSession {
  // Trust the verified-at-issuance JWT (Supabase's auth gateway signed it).
  // We only need `sub` — the tenant is resolved from partner_users by the api.
  const raw = decodeJwt(accessToken) as { sub?: string; email?: string };
  if (!raw.sub) {
    throw new Error("JWT missing required claim (sub)");
  }
  return {
    accessToken,
    userId: raw.sub,
    email: typeof raw.email === "string" ? raw.email : undefined,
  };
}
