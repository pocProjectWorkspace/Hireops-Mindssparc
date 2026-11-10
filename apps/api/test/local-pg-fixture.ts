/**
 * Throwaway LOCAL Postgres fixture for the PC-19 / PC-21 SQL tests.
 *
 * These tests exercise real SQL (the recursive BU CTE, the question-log RLS)
 * but must NEVER touch the shared Supabase database: they create stub tables
 * and apply migration 0131. They therefore run only when
 * `HIREOPS_LOCAL_PG_URL` points at localhost / 127.0.0.1 / a unix socket, and
 * are skipped otherwise (the default in CI and on the shared DB).
 *
 *   initdb -D /tmp/pg -U postgres --auth=trust
 *   pg_ctl -D /tmp/pg -o "-p 55439" start
 *   HIREOPS_LOCAL_PG_URL=postgres://postgres@localhost:55439/postgres \
 *     NODE_ENV=test npx vitest run test/pc19-bu-tree.test.ts
 *
 * The stubs mirror ONLY what the code under test reads: Supabase's
 * `authenticated` role + `auth.jwt()`, `current_tenant_id()`, and minimal
 * `tenants` / `tenant_user_memberships` / `business_units` tables (no
 * compound FK on business_units, so a cross-tenant edge CAN be planted and the
 * resolver's own tenant predicate is what is tested).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const LOCAL_PG_URL = process.env.HIREOPS_LOCAL_PG_URL ?? "";

export function isLocalPgUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return ["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(u.hostname);
  } catch {
    return false;
  }
}

export const HAS_LOCAL_PG = isLocalPgUrl(LOCAL_PG_URL);

type DbModule = typeof import("@hireops/db");

/** Point @hireops/db at the local database, then import it. */
export async function loadLocalDb(): Promise<DbModule> {
  if (!HAS_LOCAL_PG) throw new Error("HIREOPS_LOCAL_PG_URL must point at localhost");
  process.env.TEST_DATABASE_URL = LOCAL_PG_URL;
  process.env.DATABASE_URL = LOCAL_PG_URL;
  process.env.NODE_ENV = "test";
  const mod = await import("@hireops/db");
  // Belt and braces: refuse to continue unless the pool really is local.
  const hosts = (mod.sql.options as { host?: string[] }).host ?? [];
  if (!hosts.every((h) => ["localhost", "127.0.0.1", "::1"].includes(h))) {
    await mod.sql.end();
    throw new Error(`refusing to run: @hireops/db pool is not local (${hosts.join(",")})`);
  }
  return mod;
}

const STUBS = `
SET client_min_messages = warning;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT (auth.jwt() ->> 'tid')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated;
CREATE TABLE IF NOT EXISTS public.tenants (id uuid PRIMARY KEY, settings jsonb DEFAULT '{}'::jsonb);
CREATE TABLE IF NOT EXISTS public.tenant_user_memberships (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  UNIQUE (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS public.business_units (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  name text NOT NULL, parent_business_unit_id uuid NULL,
  is_archived boolean NOT NULL DEFAULT false
);
ALTER TABLE public.business_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_units FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.business_units;
CREATE POLICY tenant_isolation ON public.business_units TO authenticated
  USING (tenant_id = current_tenant_id());
`;

/** Create the stubs and apply migration 0131 (idempotent). */
export async function prepareLocalSchema(db: DbModule): Promise<void> {
  const { sql } = db;
  await sql.unsafe(STUBS);
  const exists = await sql`SELECT to_regclass('public.ask_data_questions') AS t`;
  if (!exists[0]?.t) {
    const file = resolve(
      here,
      "../../../packages/db/drizzle/migrations/0131_ask_data_questions.sql",
    );
    // Drizzle splits on the breakpoint marker; run statement by statement the same way.
    for (const stmt of readFileSync(file, "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await sql.unsafe(stmt);
    }
  }
  // Supabase grants table privileges to `authenticated` by default; RLS gates rows.
  await sql.unsafe(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated",
  );
}
