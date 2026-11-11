/**
 * C1-BUGS BUG-13 — which tenant a candidate activation request is for.
 *
 * Password sign-in needs no tenant (the Supabase identity resolves it); only
 * "Activate your account" does. Resolution, first non-empty wins:
 *   1. the route — /t/<tenantSlug>/candidate/login (tenant-scoped door);
 *   2. the `?tenant=` query parameter (links that carry it);
 *   3. the deployment's NEXT_PUBLIC_DEFAULT_TENANT_SLUG (a single-tenant
 *      deployment's configuration, not a code default);
 *   4. none → null. The page then asks the candidate to use the link from
 *      their application email instead of guessing a tenant. There is NO
 *      client slug literal anywhere in this chain.
 * Pure.
 */
const SLUG_RE = /^[a-z0-9-]{3,40}$/;

function clean(v: string | null | undefined): string | null {
  const t = v?.trim().toLowerCase();
  return t && SLUG_RE.test(t) ? t : null;
}

export function resolveCandidateTenantSlug(args: {
  routeSlug?: string | null;
  querySlug?: string | null;
  deploymentDefault?: string | null;
}): string | null {
  return clean(args.routeSlug) ?? clean(args.querySlug) ?? clean(args.deploymentDefault);
}
