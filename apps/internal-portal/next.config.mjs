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

// CRS-01: default the browser-side tRPC + REST endpoints to the local
// api (3001). Without this, the TRPCProvider falls back to
// `${window.location.origin}/trpc` = http://localhost:3002/trpc which
// returns 404 (the portal has no /trpc handler). The triage page
// historically worked only because its data fetches go through the
// in-process server caller, not the client tRPC. The public apply
// form has no server session so it MUST hit the api over HTTP.
// Production deploys should set NEXT_PUBLIC_API_BASE_URL +
// NEXT_PUBLIC_API_BASE explicitly to point at the prod api domain.
if (!process.env.NEXT_PUBLIC_API_BASE_URL) {
  process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:3001/trpc";
}
if (!process.env.NEXT_PUBLIC_API_BASE) {
  process.env.NEXT_PUBLIC_API_BASE = "http://localhost:3001";
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

// Server Actions reject POSTs whose Origin host isn't in this allow-list.
// STAGING-PREP-01: derive the deployed host from NEXT_PUBLIC_SITE_URL so
// staging/prod (e.g. https://portal.staging.hireops.app) is accepted
// without editing this file. allowedOrigins wants host[:port], no
// protocol. The localhost dev fallbacks are preserved (3002 default,
// 3003 is the port the portal actually runs on locally per the
// platform-build-status dev note).
const serverActionOrigins = ["localhost:3002", "localhost:3003"];
if (process.env.NEXT_PUBLIC_SITE_URL) {
  try {
    serverActionOrigins.unshift(new URL(process.env.NEXT_PUBLIC_SITE_URL).host);
  } catch {
    // Malformed NEXT_PUBLIC_SITE_URL — keep the dev fallbacks rather than crash the build.
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
