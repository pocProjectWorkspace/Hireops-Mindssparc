import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "./supabase-server";
import { readSessionClaims, type AuthSession } from "./session-claims";

export type { AuthSession } from "./session-claims";
export { sessionUserChip } from "./session-claims";

/**
 * Where a signed-in-but-not-internal identity gets sent. It goes through
 * /logout rather than straight to /login so the candidate/partner cookie is
 * actually CLEARED on the way — otherwise the caller lands back on the login
 * form still carrying the session that just bounced them, and every
 * subsequent internal link bounces again.
 */
const NOT_INTERNAL_EXIT = "/logout?reason=not-internal";

/**
 * Server-component / route-handler auth guard. Returns the session if
 * present + valid; redirects to /login otherwise. Next's `redirect()`
 * throws a special error the framework catches — never returns.
 *
 * The JWT itself carries `tid` / `roles` (custom claims stamped by the
 * Supabase auth hook per FND-15b). Decoding here avoids a DB roundtrip
 * for every server-component render.
 *
 * A valid session whose token has no `tid` is a candidate or partner who
 * signed in at the internal door. That is a routing mistake, not an error:
 * sign them out and return them to /login with an explanation.
 */
export async function requireAuth(): Promise<AuthSession> {
  const supabase = createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect("/login");
  }
  const claims = readSessionClaims(session.access_token);
  if (!claims) {
    redirect(NOT_INTERNAL_EXIT);
  }
  return claims;
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
 * affordance instead of redirecting. Returns null when unauthenticated —
 * and equally when the session belongs to a non-internal identity, so
 * callers like the chrome branding loader degrade instead of throwing.
 */
export async function getOptionalSession(): Promise<AuthSession | null> {
  const supabase = createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) return null;
  return readSessionClaims(session.access_token);
}
