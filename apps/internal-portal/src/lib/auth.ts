import { cache } from "react";
import { redirect } from "next/navigation";
import { sql as poolSql } from "@hireops/db";
import { decodeJwt } from "jose";
import { createSupabaseServerClient } from "./supabase-server";
import { readSessionClaims, sessionCan, type AuthSession } from "./session-claims";
import { loadSessionPermissions } from "./permissions";
import type { Capability } from "@hireops/api-types";

export type { AuthSession } from "./session-claims";
export { sessionCan, sessionScope, sessionUserChip } from "./session-claims";

/**
 * Where a signed-in-but-not-internal identity gets sent. It goes through
 * /logout rather than straight to /login so the candidate/partner cookie is
 * actually CLEARED on the way — otherwise the caller lands back on the login
 * form still carrying the session that just bounced them, and every
 * subsequent internal link bounces again.
 */
const NOT_INTERNAL_EXIT = "/logout?reason=not-internal";

/**
 * C1-F10 (D3) — where a signed-in member of a NON-active tenant goes: signed
 * out, back to /login with the lifecycle message. A token issued before the
 * suspension still carries its tid, so this is checked on every guarded
 * render, not only at sign-in.
 */
const TENANT_INACTIVE_EXIT = "/logout?reason=tenant-inactive";

/**
 * The tenant's lifecycle status, read once per request (React cache). Fails
 * OPEN to "active" on a read error so a DB blip never signs everybody out —
 * the API's tenant middleware enforces the same rule fail-closed on every
 * procedure call, so nothing is reachable for a suspended tenant regardless.
 */
const loadTenantStatus = cache(async (tenantId: string): Promise<string> => {
  try {
    const rows = await poolSql<{ status: string }[]>`
      SELECT status FROM public.tenants WHERE id = ${tenantId} LIMIT 1
    `;
    return rows[0]?.status ?? "deleting";
  } catch (err) {
    console.warn("[auth] tenant status read failed; not blocking the render", err);
    return "active";
  }
});

/** C1-F10 — is this auth user an active platform operator? Per-request cached. */
export const isPlatformOperatorUser = cache(async (userId: string): Promise<boolean> => {
  try {
    const rows = await poolSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.platform_operators
       WHERE user_id = ${userId} AND active = true
    `;
    return (rows[0]?.n ?? 0) > 0;
  } catch (err) {
    console.warn("[auth] platform operator lookup failed", err);
    return false;
  }
});

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
    // C1-F10: a platform operator with no tenant membership belongs in the
    // platform console, not on the wrong-door page.
    const sub = decodeJwt(session.access_token).sub;
    if (typeof sub === "string" && (await isPlatformOperatorUser(sub))) {
      redirect("/platform");
    }
    redirect(NOT_INTERNAL_EXIT);
  }
  if ((await loadTenantStatus(claims.tenantId)) !== "active") {
    redirect(TENANT_INACTIVE_EXIT);
  }
  // C2-F1: pages + nav gate on capabilities, resolved once per request.
  const perms = await loadSessionPermissions(claims);
  return { ...claims, caps: perms.caps, roleKey: perms.roleKey };
}

/**
 * C1-F10 — guard for the /platform console. Requires a Supabase session whose
 * auth user is an ACTIVE platform operator (resolved server-side from `sub`,
 * never from a claim). Tenant membership is irrelevant either way. Anyone else
 * is sent to their normal landing ("/"), which applies the usual guards.
 */
export async function requirePlatformOperator(): Promise<{ userId: string; email?: string }> {
  const supabase = createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect("/login?from=/platform");
  }
  const raw = decodeJwt(session.access_token) as { sub?: string; email?: string };
  if (!raw.sub || !(await isPlatformOperatorUser(raw.sub))) {
    redirect("/");
  }
  return { userId: raw.sub, email: typeof raw.email === "string" ? raw.email : undefined };
}

/**
 * Stronger guard for /admin/* routes: requires the capability the page
 * administers (C2-F1 — `admin.console` when the page names none). The platform
 * default bundle gives every admin capability to `admin` only, so for a member
 * without a custom role this is exactly the old "has the admin role" check.
 * Anyone else gets a 403-equivalent (we redirect to /triage rather than show a
 * bare 403 — the user is authenticated, just on the wrong screen).
 */
export async function requireAdmin(cap: Capability = "admin.console"): Promise<AuthSession> {
  const session = await requireAuth();
  if (!sessionCan(session, cap)) {
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
