import { z } from "zod";

/**
 * Validated env-var surface for the internal portal. Fail fast at module
 * load if anything required is missing or malformed — better than
 * discovering it via a 500 inside an unrelated request handler.
 *
 * NEXT_PUBLIC_* vars are inlined at build time by Next; the values
 * here are read at runtime on both server and client. Server-only
 * secrets (SUPABASE_SERVICE_ROLE_KEY, KMS_*, etc.) MUST NOT be exposed
 * here — they live in process.env for server-only modules and never
 * cross the network boundary.
 */

/**
 * BRAND-1 — deployment-level branding for the PRE-AUTH chrome (the login
 * screen). A pre-auth page cannot know the tenant: there is no session, so
 * there is nothing to resolve `tenants.display_name` / `settings.branding`
 * from. Deployment-scoped env vars are therefore the deliberate design for
 * that surface. (Post-login chrome is a different mechanism: the internal
 * portal resolves the signed-in tenant's own branding. Partner-portal
 * post-login chrome is outside BRAND-1's scope.)
 *
 * All three are OPTIONAL and permissive on purpose. `next build` prerenders
 * through getEnv(), and a schema violation there fails the build (we learned
 * that with NEXT_PUBLIC_ENV) — so unset, empty, and whitespace-only must all
 * be valid. Blank is normalised to "absent" at the read site
 * (lib/brand-env.ts), which keeps the default deployment pixel-identical.
 */
const optionalBrandText = z.string().trim().optional();

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_ENV: z.enum(["dev", "staging", "production"]).default("dev"),
  /** Absolute or app-relative URL of the deployment's logo, shown on /login. */
  NEXT_PUBLIC_BRAND_LOGO_URL: optionalBrandText,
  /** Alt text / brand name that goes with NEXT_PUBLIC_BRAND_LOGO_URL. */
  NEXT_PUBLIC_BRAND_NAME: optionalBrandText,
  /** e.g. "Powered by MindsSparc" — muted attribution line on /login. */
  NEXT_PUBLIC_POWERED_BY: optionalBrandText,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const result = envSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_ENV: process.env.NEXT_PUBLIC_ENV,
    // Next only inlines NEXT_PUBLIC_* vars it can see as literal
    // `process.env.X` member reads — hence the explicit spelling here.
    NEXT_PUBLIC_BRAND_LOGO_URL: process.env.NEXT_PUBLIC_BRAND_LOGO_URL,
    NEXT_PUBLIC_BRAND_NAME: process.env.NEXT_PUBLIC_BRAND_NAME,
    NEXT_PUBLIC_POWERED_BY: process.env.NEXT_PUBLIC_POWERED_BY,
  });
  if (!result.success) {
    throw new Error(
      `Invalid environment configuration:\n${result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
    );
  }
  cached = result.data;
  return cached;
}

/**
 * Test escape hatch — clears the memoised env so tests can re-validate
 * with different process.env values per case.
 */
export function resetEnvCache(): void {
  cached = undefined;
}
