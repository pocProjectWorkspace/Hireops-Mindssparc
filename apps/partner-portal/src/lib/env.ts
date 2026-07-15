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

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_ENV: z.enum(["dev", "staging", "production"]).default("dev"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const result = envSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_ENV: process.env.NEXT_PUBLIC_ENV,
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
