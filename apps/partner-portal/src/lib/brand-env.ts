import { getEnv } from "./env";

/**
 * BRAND-1 — deployment branding for pre-auth surfaces.
 *
 * The login screen renders before any session exists, so the tenant is
 * unknowable there (no JWT → no tenant id → nothing to resolve
 * `tenants.display_name` / `settings.branding` from). Env vars scoped to the
 * DEPLOYMENT are the deliberate design for that surface: one client env, one
 * logo.
 *
 * Everything is optional. When nothing is set the caller renders exactly what
 * shipped, so the default deployment stays pixel-identical. Mirrors the
 * internal portal's lib/brand-env.ts — the two portals are separate Next apps
 * with no shared client-side module, so the small helper is duplicated rather
 * than lifted into a package.
 */
export interface DeploymentBrand {
  /** Logo to render in place of the HireOps mark, when configured. */
  logoUrl?: string;
  /** Name used as the logo's alt text; defaults to a generic "logo". */
  name?: string;
  /** Muted attribution line, e.g. "Powered by MindsSparc". */
  poweredBy?: string;
}

/** Treat blank / whitespace-only env values as "not configured". */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getDeploymentBrand(): DeploymentBrand {
  const env = getEnv();
  return {
    logoUrl: present(env.NEXT_PUBLIC_BRAND_LOGO_URL),
    name: present(env.NEXT_PUBLIC_BRAND_NAME),
    poweredBy: present(env.NEXT_PUBLIC_POWERED_BY),
  };
}
