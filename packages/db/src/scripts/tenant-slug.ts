/**
 * The demo/pilot tenant slug every seed script targets. Defaults to the
 * original POC slug so existing environments are unaffected; the Solenis
 * pilot sets HIREOPS_TENANT_SLUG=solenis after the tenant row is renamed.
 *
 * A FUNCTION, not a module-level constant, on purpose: every seed script
 * loads the repo-root `.env` via a `loadDotenv()` statement that runs AFTER
 * ESM has already evaluated all static imports. A constant here would read
 * process.env before `.env` is loaded and silently miss a value set there.
 * Callers invoke this after their `loadDotenv()` call.
 */
export function demoTenantSlug(): string {
  return process.env.HIREOPS_TENANT_SLUG?.trim() || "kyndryl-poc";
}
