/**
 * The partner portal's public-route decision, extracted from middleware.ts so
 * it is unit-testable (P0.6 — this app's first test). Everything not public
 * requires a Supabase session.
 *
 * /accept-invite/<rawToken> is prefix-matched because the whole point of the
 * invitation redemption link (P0.2) is that its visitor has no session yet —
 * a regression here locks every invitee out at the door.
 */

// /forgot-password and /reset-password (P1.4): password recovery is by
// definition for visitors who cannot sign in. /reset-password DOES end up
// with a Supabase recovery session, but the middleware gate would bounce the
// recovery redirect before the client can exchange the code, so it stays
// public and the page itself refuses to render the form without a session.
const PUBLIC_PATHS = new Set<string>(["/login", "/logout", "/forgot-password", "/reset-password"]);

const PUBLIC_PREFIXES = ["/accept-invite"] as const;

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
