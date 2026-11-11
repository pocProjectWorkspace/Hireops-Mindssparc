/**
 * The tenant slug a seed / ops script targets — from HIREOPS_TENANT_SLUG.
 *
 * C1-BUGS NEW-14: there is NO default. A seed that silently picked a client's
 * tenant (it used to fall back to the original POC slug) writes demo data into
 * whichever environment the DATABASE_URL points at; with several tenants per
 * database that is how one client's seed lands in another's tenant. Set it
 * explicitly every run, e.g. `HIREOPS_TENANT_SLUG=<slug> pnpm db:seed:...`.
 *
 * A FUNCTION, not a module-level constant, on purpose: every seed script
 * loads the repo-root `.env` via a `loadDotenv()` statement that runs AFTER
 * ESM has already evaluated all static imports. A constant here would read
 * process.env before `.env` is loaded and silently miss a value set there.
 * Callers invoke this after their `loadDotenv()` call.
 */
export class MissingTenantSlugError extends Error {
  constructor() {
    super(
      "HIREOPS_TENANT_SLUG is not set. Seed scripts no longer default to a tenant — " +
        "set it to the target tenant's slug, e.g. `HIREOPS_TENANT_SLUG=<slug> pnpm db:seed:<script>`.",
    );
    this.name = "MissingTenantSlugError";
  }
}

/** Pure core — exported for tests. Throws MissingTenantSlugError when unset/blank. */
export function tenantSlugFromEnv(env: Record<string, string | undefined>): string {
  const slug = env.HIREOPS_TENANT_SLUG?.trim();
  if (!slug) throw new MissingTenantSlugError();
  return slug;
}

export function demoTenantSlug(): string {
  return tenantSlugFromEnv(process.env);
}
