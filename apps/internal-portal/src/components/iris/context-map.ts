/**
 * Iris page-context derivation (IRIS-A2) — PURE, no React / no DOM so it unit
 * tests cleanly. The provider (IrisProvider) feeds it `usePathname()`; the
 * drawer reads the result to pick a context-suggested default action.
 *
 * HONESTY: this is deterministic routing sugar, not intelligence — it only maps
 * a known route to the ONE whitelisted action that makes sense there. An
 * unknown route yields no suggestion (the menu still lists everything).
 */

/** The lightweight page context the drawer consumes. */
export interface IrisPageContext {
  /** The current route (pathname), normalised (no trailing slash). */
  route: string;
  /** Trivially path-derived entity, when the route carries one. */
  entityType?: string;
  entityId?: string;
}

/**
 * Route-prefix → suggested action id. Longest matching prefix wins, so a more
 * specific route can override a broader one. Keep this to routes where a single
 * default action is genuinely the obvious next step.
 */
const SUGGESTED_ACTION_BY_PREFIX: readonly { prefix: string; actionId: string }[] = [
  { prefix: "/requisitions", actionId: "create_requisition_jd" },
  { prefix: "/dashboard", actionId: "create_requisition_jd" },
];

/** Strip a trailing slash (except the root) so "/x/" and "/x" match alike. */
function normalizeRoute(route: string): string {
  if (!route) return "/";
  const trimmed = route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;
  return trimmed || "/";
}

/**
 * The suggested action id for a route, or null when no route matches. A prefix
 * matches the route itself or any child segment ("/requisitions" matches
 * "/requisitions" and "/requisitions/new", not "/requisitions-archive").
 */
export function suggestedActionForRoute(route: string): string | null {
  const path = normalizeRoute(route);
  const best = SUGGESTED_ACTION_BY_PREFIX.filter(
    (e) => path === e.prefix || path.startsWith(`${e.prefix}/`),
  ).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return best ? best.actionId : null;
}

/**
 * Derive the page context from a pathname. Entity extraction is deliberately
 * minimal — only the trivial requisition-detail case (/requisitions/<id>) —
 * because the one A2 action needs no entity. Everything else is just `route`.
 */
export function deriveIrisContext(pathname: string): IrisPageContext {
  const route = normalizeRoute(pathname);
  const reqDetail = /^\/requisitions\/([0-9a-f-]{8,})$/i.exec(route);
  if (reqDetail) {
    return { route, entityType: "requisition", entityId: reqDetail[1] };
  }
  return { route };
}
