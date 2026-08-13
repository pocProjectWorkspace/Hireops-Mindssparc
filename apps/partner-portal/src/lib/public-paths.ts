/**
 * The partner portal's public-route decision, extracted from middleware.ts so
 * it is unit-testable (P0.6 — this app's first test). Everything not public
 * requires a Supabase session.
 *
 * /accept-invite/<rawToken> is prefix-matched because the whole point of the
 * invitation redemption link (P0.2) is that its visitor has no session yet —
 * a regression here locks every invitee out at the door.
 */

const PUBLIC_PATHS = new Set<string>(["/login", "/logout"]);

const PUBLIC_PREFIXES = ["/accept-invite"] as const;

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
