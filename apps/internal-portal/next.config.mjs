import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the workspace .env so cross-workspace modules (@hireops/db's
// DATABASE_URL check, @hireops/observability's LOG_LEVEL, etc.) see
// the same values as apps/api. Next.js only auto-loads .env in the
// app directory, which would force us to duplicate the file or
// symlink — explicit dotenv read is cleaner.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../.env") });

// Mirror the Supabase URL + anon key into the NEXT_PUBLIC_* namespace
// Next requires for client-bundled vars. Both values are inherently
// public (the anon key is designed for client use); the prefix is a
// Next convention, not a security boundary. Production deploys can
// set NEXT_PUBLIC_* directly and skip this mirror.
if (process.env.SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
}
if (process.env.SUPABASE_ANON_KEY && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
}

/**
 * Cross-workspace imports (notably from @hireops/api, @hireops/db,
 * @hireops/ui) are TypeScript sources, not built artefacts. Next.js
 * needs to transpile them itself rather than expecting pre-compiled
 * dist/ output — listing them under transpilePackages does exactly that.
 *
 * Next.js 14 doesn't support TS configs (15+ does); .mjs gets us
 * native ESM + checked JSDoc typing via @type below.
 */

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  transpilePackages: [
    "@hireops/api",
    "@hireops/api-types",
    "@hireops/db",
    "@hireops/observability",
    "@hireops/ui",
  ],
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3002"] },
  },
};

export default config;
