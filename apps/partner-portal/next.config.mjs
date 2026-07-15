import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the workspace .env so cross-workspace modules (@hireops/db's
// DATABASE_URL check, @hireops/observability's LOG_LEVEL, etc.) see the
// same values as apps/api. Mirrors apps/internal-portal's next.config.
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../.env") });

// Mirror the Supabase URL + anon key into the NEXT_PUBLIC_* namespace Next
// requires for client-bundled vars (both are inherently public).
if (process.env.SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
}
if (process.env.SUPABASE_ANON_KEY && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
}

// Default the browser-side tRPC endpoint to the local api (3001). The client
// tRPC (mutations, client queries) MUST hit the api over HTTP; the /trpc
// suffix matters (detail panels 404 without it — see PLATFORM-BUILD-STATUS).
// Production deploys set NEXT_PUBLIC_API_BASE_URL explicitly.
if (!process.env.NEXT_PUBLIC_API_BASE_URL) {
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:3001/trpc";
}

// Server Actions reject POSTs whose Origin host isn't in this allow-list.
// Partner portal runs on 3005 locally; staging/prod derive from
// NEXT_PUBLIC_SITE_URL.
const serverActionOrigins = ["localhost:3005"];
if (process.env.NEXT_PUBLIC_SITE_URL) {
  try {
    serverActionOrigins.unshift(new URL(process.env.NEXT_PUBLIC_SITE_URL).host);
  } catch {
    // Malformed NEXT_PUBLIC_SITE_URL — keep the dev fallback rather than crash the build.
  }
}

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
    serverActions: { allowedOrigins: serverActionOrigins },
  },
};

export default config;
