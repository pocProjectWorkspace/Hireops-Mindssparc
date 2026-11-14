/**
 * C1-F11 — tenant provisioning, starter packs, the setup wizard and config
 * export / import (migration 0135).
 *
 * LOCAL POSTGRES ONLY. This suite creates tenants, auth users and memberships,
 * so it must never touch the shared database. It runs only when
 * HIREOPS_LOCAL_PG_URL points at localhost (skipped otherwise — the default in
 * CI and on the shared DB). On an EMPTY database it first creates minimal
 * Supabase stubs (roles, auth.users, auth.jwt/uid) and applies the whole
 * migration chain in journal order. Supabase Auth is replaced by a FAKE
 * AuthAdminPort that records invites and inserts the auth.users row itself.
 *
 *   initdb -D /tmp/pg -U postgres --auth=trust
 *   pg_ctl -D /tmp/pg -o "-p 55511" start
 *   createdb -h localhost -p 55511 -U postgres hireops_f11
 *   HIREOPS_LOCAL_PG_URL=postgres://postgres@localhost:55511/hireops_f11 \
 *     NODE_ENV=test DB_POOL_MAX=3 npx vitest run test/c1-f11-provisioning.test.ts
 *
 * Coverage (the ticket's acceptance list):
 *   - provision `blank` and `india-gcc-finance-gbs` end to end (tenant active,
 *     modules, settings, lookups, levels, invite called once, membership,
 *     encryption key, platform + tenant audit, sign-in hook resolves)
 *   - idempotent re-run; failure mid-way then retry completes
 *   - export → import round-trip into a second tenant yields identical config
 *   - import dry-run diff; version + fingerprint refusals
 *   - export contains no people data and no secrets
 *   - setup wizard step completion + go-live checks
 *   - platform / tenant role gates
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAS_LOCAL_PG, LOCAL_PG_URL, loadLocalDb } from "./local-pg-fixture";
import type { AuthAdminPort, AuthInviteResult } from "../src/lib/platform/auth-admin-port";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, "../../../packages/db/drizzle/migrations");

// ── fixture ids (the `0f11` block) ──────────────────────────────────────────
const id = (n: number) => `00000000-0000-4000-8000-0000000f11${n.toString(16).padStart(2, "0")}`;
const U_OWNER = id(0x01);
const U_SUPPORT = id(0x02);
const U_STRANGER = id(0x03);
const T_OTHER = id(0x10); // a pre-existing tenant whose admin is NOT an operator
const U_OTHER_ADMIN = id(0x11);

const SLUGS = ["f11-blank", "f11-india", "f11-flaky", "f11-target", "f11-wizard"];

const SUPABASE_STUBS = `
SET client_min_messages = warning;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role, supabase_auth_admin;
GRANT SELECT ON auth.users TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated, anon, service_role, supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon, service_role, supabase_auth_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon, supabase_auth_admin;
`;

type DbModule = Awaited<ReturnType<typeof loadLocalDb>>;
/** A loosely-typed jsonb read (tenants.settings) — assertions walk arbitrary nested keys. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Deep = Record<string, any>;

function must<T>(v: T | null | undefined, what = "value"): T {
  assert.ok(v !== null && v !== undefined, `${what} missing`);
  return v;
}
type Sql = DbModule["sql"];

async function prepareSchema(sql: Sql): Promise<void> {
  const [probe] = await sql<
    { t: string | null }[]
  >`SELECT to_regclass('public.tenant_provisioning_jobs')::text AS t`;
  if (probe?.t) return;
  await sql.unsafe(SUPABASE_STUBS);
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  for (const e of journal.entries) {
    const text = readFileSync(resolve(MIGRATIONS, `${e.tag}.sql`), "utf8");
    await sql.begin(async (tx) => {
      for (const stmt of text.split("--> statement-breakpoint")) {
        if (stmt.trim()) await tx.unsafe(stmt);
      }
    });
  }
}

/** Fake Supabase Auth admin: records every invite, inserts auth.users like Supabase would. */
class FakeAuthAdmin implements AuthAdminPort {
  calls: { email: string; metadata: Record<string, string> }[] = [];
  failNext = 0;
  constructor(private readonly sql: Sql) {}
  async inviteUser(email: string, metadata: Record<string, string>): Promise<AuthInviteResult> {
    this.calls.push({ email, metadata });
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("simulated auth outage");
    }
    const [existing] = await this.sql<{ id: string }[]>`
      SELECT id::text AS id FROM auth.users WHERE lower(email) = lower(${email})
    `;
    if (existing) return { userId: existing.id, alreadyExisted: true };
    const [row] = await this.sql<{ id: string }[]>`
      INSERT INTO auth.users (email, raw_user_meta_data)
      VALUES (${email}, ${JSON.stringify(metadata)}::jsonb) RETURNING id::text AS id
    `;
    return { userId: must(row).id, alreadyExisted: false };
  }
}

async function cleanup(sql: Sql): Promise<void> {
  const tenants = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM public.tenants WHERE slug = ANY(${SLUGS}) OR id = ${T_OTHER}
  `;
  for (const { id: t } of tenants) {
    await sql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.panel_pool_members WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.job_profiles WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.comp_bands WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.business_units WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.locations WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.tenants WHERE id = ${t}`;
  }
  await sql`DELETE FROM auth.users WHERE email LIKE '%@f11.test'`;
  await sql`UPDATE public.platform_operators SET active = false WHERE user_id IN (${U_OWNER}, ${U_SUPPORT})`;
}

describe.skipIf(!HAS_LOCAL_PG)(
  "C1-F11 provisioning + config export/import (local Postgres)",
  () => {
    let db: DbModule;
    let sql: Sql;
    let appRouter: typeof import("../src/trpc/router").appRouter;
    let provisioning: typeof import("../src/lib/platform/provisioning");
    let authPort: typeof import("../src/lib/platform/auth-admin-port");
    let log: import("@hireops/observability").Logger;
    let fake: FakeAuthAdmin;
    const tenantIds: Record<string, string> = {};
    const adminIds: Record<string, string> = {};

    function caller(userId: string | null, tenantId: string | null = null, roles: string[] = []) {
      return appRouter.createCaller({
        tenantId,
        userId,
        roles,
        claims: userId ? { sub: userId, ...(tenantId ? { tid: tenantId, roles } : {}) } : null,
        db: undefined,
        sql: db.sql,
        log,
        requestId: `f11-${Math.random().toString(36).slice(2)}`,
        userAgent: null,
        ipAddress: null,
      });
    }
    const owner = () => caller(U_OWNER);
    const tenantAdmin = (slug: string) =>
      caller(adminIds[slug] as string, tenantIds[slug] as string, ["admin"]);

    async function expectTrpc(p: Promise<unknown>, code: string, message?: string): Promise<void> {
      try {
        await p;
      } catch (err) {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
        if (message)
          assert.ok(e.message?.includes(message), `message ${e.message} lacks ${message}`);
        return;
      }
      assert.fail(`expected ${code}, but the call succeeded`);
    }

    async function count(table: string, tenantId: string, where = "true"): Promise<number> {
      const [r] = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM public.${table} WHERE tenant_id = $1 AND ${where}`,
        [tenantId],
      );
      return r?.n ?? 0;
    }

    async function hookTid(userId: string): Promise<string | null> {
      const [r] = await sql<{ ev: { claims?: { tid?: string } } }[]>`
      SELECT public.custom_access_token_hook(
        jsonb_build_object('user_id', ${userId}::text, 'claims', '{}'::jsonb)) AS ev
    `;
      return r?.ev?.claims?.tid ?? null;
    }

    async function create(slug: string, pack: string, extra: Record<string, unknown> = {}) {
      const out = await owner().platformCreateTenant({
        slug,
        displayName: `F11 ${slug}`,
        primaryRegion: "ap-south-1",
        starterPack: pack,
        adminEmail: `admin.${slug}@f11.test`,
        adminDisplayName: `Admin ${slug}`,
        ...extra,
      });
      tenantIds[slug] = out.tenantId;
      const invite = out.steps.find((s) => s.key === "admin_invite");
      if (invite?.detail.userId) adminIds[slug] = String(invite.detail.userId);
      return out;
    }

    beforeAll(async () => {
      if (!LOCAL_PG_URL) return;
      process.env.SUPABASE_KEK_SECRET = randomBytes(32).toString("hex");
      process.env.KMS_PROVIDER = "local";
      db = await loadLocalDb();
      sql = db.sql;
      await prepareSchema(sql);
      await import("../src/bootstrap");
      ({ appRouter } = await import("../src/trpc/router"));
      provisioning = await import("../src/lib/platform/provisioning");
      authPort = await import("../src/lib/platform/auth-admin-port");
      log = (await import("@hireops/observability")).createLogger({ level: "error" });
      fake = new FakeAuthAdmin(sql);
      authPort.setAuthAdminPort(fake);

      await cleanup(sql);
      await sql`
      INSERT INTO auth.users (id, email) VALUES
        (${U_OWNER}, 'owner@f11.test'), (${U_SUPPORT}, 'support@f11.test'),
        (${U_STRANGER}, 'stranger@f11.test'), (${U_OTHER_ADMIN}, 'other-admin@f11.test')
      ON CONFLICT (id) DO NOTHING
    `;
      await sql`
      INSERT INTO public.platform_operators (user_id, email, role, active) VALUES
        (${U_OWNER}, 'owner@f11.test', 'owner', true),
        (${U_SUPPORT}, 'support@f11.test', 'support', true)
      ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active
    `;
      await sql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${T_OTHER}, 'f11-other', 'F11 Other', 'ap-south-1', 'active')
      ON CONFLICT (id) DO NOTHING
    `;
      await sql`
      INSERT INTO public.tenant_user_memberships (user_id, tenant_id, roles, status)
      VALUES (${U_OTHER_ADMIN}, ${T_OTHER}, '{admin}', 'active')
      ON CONFLICT DO NOTHING
    `;
    });

    afterAll(async () => {
      if (!sql) return;
      authPort?.setAuthAdminPort(null);
      await cleanup(sql);
      await sql`DELETE FROM public.tenants WHERE id = ${T_OTHER}`;
      await sql.end();
    });

    it("platform gates: only an operator with a write role can create a tenant", async () => {
      const input = {
        slug: "f11-denied",
        displayName: "Denied",
        primaryRegion: "ap-south-1",
        starterPack: "blank",
        adminEmail: "x@f11.test",
      };
      await expectTrpc(caller(null).platformCreateTenant(input), "UNAUTHORIZED");
      await expectTrpc(
        caller(U_STRANGER).platformCreateTenant(input),
        "FORBIDDEN",
        "not_a_platform_operator",
      );
      await expectTrpc(
        caller(U_OTHER_ADMIN, T_OTHER, ["admin"]).platformCreateTenant(input),
        "FORBIDDEN",
        "not_a_platform_operator",
      );
      await expectTrpc(
        caller(U_SUPPORT).platformCreateTenant(input),
        "FORBIDDEN",
        "platform_role_read_only",
      );
      await expectTrpc(
        caller(U_SUPPORT).platformExportTenantConfig({ tenantId: T_OTHER }),
        "FORBIDDEN",
        "platform_role_read_only",
      );
      await expectTrpc(
        caller(U_STRANGER).platformGetProvisioningStatus({ tenantId: T_OTHER }),
        "FORBIDDEN",
      );
      await expectTrpc(
        owner().platformCreateTenant({ ...input, starterPack: "no-such-pack" }),
        "BAD_REQUEST",
        "unknown_pack",
      );
      const [n] = await sql<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM public.tenants WHERE slug = 'f11-denied'`;
      assert.equal(n?.n, 0);
      // Support can read the pack catalogue and a pre-F11 tenant has no job.
      const packs = await caller(U_SUPPORT).platformListStarterPacks();
      assert.deepEqual(
        packs.packs.map((p) => p.key),
        ["blank", "india-gcc-finance-gbs"],
      );
      const none = await caller(U_SUPPORT).platformGetProvisioningStatus({ tenantId: T_OTHER });
      assert.equal(none.status, null);
    });

    it("provisions the blank pack end to end", async () => {
      const before = fake.calls.length;
      const out = await create("f11-blank", "blank");
      assert.equal(out.jobStatus, "completed", JSON.stringify(out));
      assert.equal(out.tenantStatus, "active");
      assert.ok(out.steps.every((s) => s.status === "done"));
      assert.equal(fake.calls.length - before, 1, "invite called once");
      const call = must(fake.calls[fake.calls.length - 1]);
      assert.equal(call.email, "admin.f11-blank@f11.test");
      assert.equal(call.metadata.tenant_slug, "f11-blank", "hook reads tenant_slug");

      const t = must(tenantIds["f11-blank"]);
      const [row] = await sql<
        { status: string; tier: string; onboarding_status: string; settings: Deep }[]
      >`
      SELECT status, tier, onboarding_status, settings FROM public.tenants WHERE id = ${t}
    `;
      assert.equal(row?.status, "active");
      assert.equal(row?.tier, "standard");
      assert.equal(row?.onboarding_status, "in_progress");
      assert.equal(row?.settings.starterPack.key, "blank");
      assert.equal(row?.settings.starterPack.version, 1);
      assert.deepEqual(
        Object.keys(row?.settings ?? {}),
        ["starterPack"],
        "blank lays down nothing else",
      );

      assert.equal(await count("tenant_modules", t), 14);
      assert.equal(await count("tenant_modules", t, "enabled = false"), 0);
      assert.equal(await count("job_levels", t), 0);
      assert.equal(await count("tenant_lookups", t), 0);

      // Real envelope key, not a placeholder; unwraps to a 32-byte DEK.
      const [key] = await sql<{ encrypted_dek: Buffer; kms_key_id: string }[]>`
      SELECT encrypted_dek, kms_key_id FROM public.tenant_encryption_keys WHERE tenant_id = ${t}
    `;
      assert.equal(key?.kms_key_id, "local:v1");
      const dek = await db.unwrapDek(
        must(key).encrypted_dek,
        must(key).kms_key_id,
        db.getKmsClient(),
      );
      assert.equal(dek.byteLength, 32);

      const admin = must(adminIds["f11-blank"]);
      const [m] = await sql<{ roles: string[]; status: string }[]>`
      SELECT roles::text[] AS roles, status FROM public.tenant_user_memberships WHERE tenant_id = ${t} AND user_id = ${admin}
    `;
      assert.deepEqual(m?.roles, ["admin"]);
      assert.equal(m?.status, "active");
      assert.equal(await hookTid(admin), t, "the invited admin signs in to the new tenant");

      const actions = await sql<{ action: string; n: number }[]>`
      SELECT action, count(*)::int AS n FROM public.platform_audit_log WHERE tenant_id = ${t} GROUP BY action
    `;
      const a = Object.fromEntries(actions.map((r) => [r.action, r.n]));
      assert.equal(a["tenant.create"], 1);
      assert.equal(a["tenant.provision.step"], 6);
      assert.equal(a["tenant.provision.completed"], 1);
      assert.equal(a["tenant.status_change"], 1);

      await expectTrpc(create("f11-blank", "blank"), "CONFLICT", "slug_taken");
    });

    it("provisions the india-gcc-finance-gbs pack end to end (with a module override)", async () => {
      const out = await create("f11-india", "india-gcc-finance-gbs", {
        tier: "sandbox",
        modules: [{ key: "ask_data", enabled: false }],
      });
      assert.equal(out.jobStatus, "completed", JSON.stringify(out));
      const t = must(tenantIds["f11-india"]);
      const [row] = await sql<{ tier: string; settings: Deep }[]>`
      SELECT tier, settings FROM public.tenants WHERE id = ${t}
    `;
      const s = must(row).settings;
      assert.equal(row?.tier, "sandbox");
      assert.equal(s.starterPack.key, "india-gcc-finance-gbs");
      assert.equal(s.currency, "INR");
      assert.equal(s.timezone, "Asia/Kolkata");
      assert.equal(s.scheduling.timezone, "Asia/Kolkata");
      assert.deepEqual(s.scheduling.durationPresets, [30, 45, 60]);
      assert.equal(s.preJoiningEngagement.enabled, false);
      assert.equal(s.preJoiningEngagement.cadenceDays, 14);
      assert.equal(s.preJoiningEngagement.quietHours.timezone, "Asia/Kolkata");
      assert.equal(s.diversitySlate.enabled, false);
      assert.deepEqual(s.urgency.noticeBands, [30, 60, 90, 120, 180]);
      assert.equal(s.labels.stages.tech_interview.staff, "Interview");
      assert.equal(s.slaThresholds.tech_interview, 120);

      const levels = await sql<{ key: string; rank: number }[]>`
      SELECT key, rank FROM public.job_levels WHERE tenant_id = ${t} ORDER BY rank
    `;
      assert.deepEqual(
        levels.map((l) => l.key),
        ["IN09", "IN10", "IN11", "IN12", "IN13", "IN14", "IN15", "IN16", "IN17", "IN18"],
      );
      assert.equal(await count("job_functions", t), 10);
      assert.equal(
        await count("locations", t, "timezone = 'Asia/Kolkata' AND country_code = 'IN'"),
        6,
      );
      assert.equal(await count("locations", t, "legal_entity_id IS NOT NULL"), 6);
      assert.equal(await count("legal_entities", t), 1);
      assert.equal(await count("tenant_lookups", t), 2);
      assert.equal(await count("tenant_interview_round_template", t), 4);
      const [sc] = await sql<{ criteria: { label: string }[] }[]>`
      SELECT criteria FROM public.tenant_scorecard_template WHERE tenant_id = ${t}
    `;
      assert.deepEqual(
        sc?.criteria.map((c) => c.label),
        ["People", "Performance", "Results", "Functional", "Competencies"],
      );
      // Modules: pack recommendation + the operator's override.
      const off = await sql<{ module_key: string }[]>`
      SELECT module_key FROM public.tenant_modules WHERE tenant_id = ${t} AND enabled = false ORDER BY module_key
    `;
      assert.deepEqual(
        off.map((r) => r.module_key),
        ["ask_data", "diversity_slate", "learning"],
      );
      // Tenant audit: config rows were written through the audit trigger as system.
      assert.ok(
        (await count("audit_logs", t, "entity_type = 'job_levels' AND source = 'system'")) >= 10,
      );
      // Phone dedup places bare national numbers in India (C1-BUGS BUG-5);
      // the Organisation page's default-country field reads + writes the key.
      assert.equal(s.defaultCountry, "IN");
      const indiaAdmin = caller(must(adminIds["f11-india"]), t, ["admin"]);
      assert.equal((await indiaAdmin.getTenantDefaultCountry({})).defaultCountry, "IN");
      await indiaAdmin.setTenantDefaultCountry({ defaultCountry: null });
      const cleared = await sql<{ has: boolean }[]>`
      SELECT settings ? 'defaultCountry' AS has FROM public.tenants WHERE id = ${t}
    `;
      assert.equal(cleared[0]?.has, false);
      assert.equal(
        (await indiaAdmin.setTenantDefaultCountry({ defaultCountry: "in" })).defaultCountry,
        "IN",
      );
      await expectTrpc(indiaAdmin.setTenantDefaultCountry({ defaultCountry: "ZZ" }), "BAD_REQUEST");
      await expectTrpc(
        caller(must(adminIds["f11-india"]), t, ["hr_head"]).setTenantDefaultCountry({
          defaultCountry: "IN",
        }),
        "FORBIDDEN",
      );
      assert.equal((await indiaAdmin.getTenantDefaultCountry({})).defaultCountry, "IN");

      // Document types are tenant-scoped (C1-BUGS BUG-4, 0132): the pack adds
      // only UAN; PAN / Aadhaar / PF / ESIC stay platform types, not copies.
      const pack = must(out.steps.find((x) => x.key === "starter_pack"));
      assert.equal(pack.detail.skipped, undefined, JSON.stringify(pack.detail));
      const docTypes = await sql<{ code: string; stage: string | null }[]>`
      SELECT code, required_for_lifecycle_stage AS stage FROM public.document_types
       WHERE tenant_id = ${t} ORDER BY code
    `;
      assert.deepEqual([...docTypes], [{ code: "uan", stage: "pre_boarding" }]);
      // The effective catalogue lists each code once; a tenant row with a
      // platform code replaces the platform row (BUG-4 override rule).
      const codesOf = async () =>
        (await indiaAdmin.listRequestableDocumentTypes()).items.map((i) => i.code);
      let codes = await codesOf();
      assert.ok(codes.includes("uan") && codes.includes("esic") && codes.includes("pan_card"));
      assert.equal(new Set(codes).size, codes.length, `duplicate codes: ${codes.join(",")}`);
      await sql`
      INSERT INTO public.document_types (tenant_id, code, name, geography_code, retention_years)
      VALUES (${t}, 'esic', 'ESIC (tenant)', 'IN', 8)
    `;
      codes = await codesOf();
      assert.equal(codes.filter((c) => c === "esic").length, 1);
      const retention = await indiaAdmin.getDocumentRetention({});
      const esic = retention.items.filter((i) => i.code === "esic");
      assert.deepEqual(
        esic.map((i) => i.name),
        ["ESIC (tenant)"],
      );
      await sql`DELETE FROM public.document_types WHERE tenant_id = ${t} AND code = 'esic'`;
    });

    it("re-running is idempotent: no duplicates, no second invite", async () => {
      const t = must(tenantIds["f11-india"]);
      const invitesBefore = fake.calls.length;
      const counts = async () => ({
        levels: await count("job_levels", t),
        fns: await count("job_functions", t),
        locs: await count("locations", t),
        lookups: await count("tenant_lookups", t),
        rounds: await count("tenant_interview_round_template", t),
        modules: await count("tenant_modules", t),
        members: await count("tenant_user_memberships", t),
        keys: await count("tenant_encryption_keys", t),
      });
      const before = await counts();
      // A completed job: retry is a no-op.
      const r1 = await owner().platformRetryProvisioning({ tenantId: t });
      assert.equal(r1.jobStatus, "completed");
      assert.equal(fake.calls.length, invitesBefore);
      // Force every step after tenant_row to re-run (simulates a lost job record).
      await sql`
      UPDATE public.tenant_provisioning_jobs
         SET status = 'failed', steps = jsonb_build_object('tenant_row', steps->'tenant_row')
       WHERE tenant_id = ${t}
    `;
      // An admin edited a pack value meanwhile; additive re-apply must not overwrite it.
      await sql`UPDATE public.job_levels SET label = 'Grade 12' WHERE tenant_id = ${t} AND key = 'IN12'`;
      const r2 = await owner().platformRetryProvisioning({ tenantId: t });
      assert.equal(r2.jobStatus, "completed", JSON.stringify(r2));
      assert.deepEqual(await counts(), before);
      const [lvl] = await sql<{ label: string }[]>`
      SELECT label FROM public.job_levels WHERE tenant_id = ${t} AND key = 'IN12'
    `;
      assert.equal(lvl?.label, "Grade 12");
      // The re-run asked Auth again (the step record was lost) but got the existing identity.
      const step = must(r2.steps.find((s) => s.key === "admin_invite"));
      assert.equal(step.detail.alreadyExisted, true);
    });

    it("a failure mid-way leaves the tenant provisioning; retry completes it", async () => {
      fake.failNext = 1;
      const out = await create("f11-flaky", "india-gcc-finance-gbs");
      const t = out.tenantId;
      assert.equal(out.jobStatus, "failed");
      assert.equal(out.tenantStatus, "provisioning");
      assert.match(out.lastError ?? "", /simulated auth outage/);
      const byKey = Object.fromEntries(out.steps.map((s) => [s.key, s.status]));
      assert.equal(byKey.starter_pack, "done");
      assert.equal(byKey.admin_invite, "failed");
      assert.equal(byKey.activate, "pending");
      assert.equal(
        await (async () => {
          const [p] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM public.platform_audit_log
           WHERE tenant_id = ${t} AND action = 'tenant.provision.failed'`;
          return p?.n;
        })(),
        1,
      );

      const invitesBefore = fake.calls.length;
      const retry = await owner().platformRetryProvisioning({ tenantId: t });
      assert.equal(retry.jobStatus, "completed", JSON.stringify(retry));
      assert.equal(retry.tenantStatus, "active");
      assert.equal(retry.attempts, 2);
      assert.equal(fake.calls.length - invitesBefore, 1, "one successful invite on retry");
      assert.equal(await count("job_levels", t), 10, "pack not applied twice");
      assert.equal(await count("tenant_modules", t), 14);
      adminIds["f11-flaky"] = String(
        must(retry.steps.find((s) => s.key === "admin_invite")).detail.userId,
      );
      assert.equal(await count("tenant_user_memberships", t), 1);
      const status = await caller(U_SUPPORT).platformGetProvisioningStatus({ tenantId: t });
      assert.equal(status.status?.jobStatus, "completed");
    });

    it("tenant role gates on export / import / setup", async () => {
      const t = must(tenantIds["f11-india"]);
      const admin = must(adminIds["f11-india"]);
      await expectTrpc(caller(admin, t, ["recruiter"]).exportTenantConfig(), "FORBIDDEN");
      await expectTrpc(caller(admin, t, ["hr_head"]).getTenantSetup(), "FORBIDDEN");
      await expectTrpc(
        caller(admin, t, ["recruiter"]).previewTenantConfigImport({ document: {} }),
        "FORBIDDEN",
      );
      // A platform operator with no tenant claim cannot reach tenant procedures.
      await expectTrpc(owner().exportTenantConfig(), "UNAUTHORIZED");
    });

    it("export → import round-trips into a second tenant, carrying no people data or secrets", async () => {
      const src = must(tenantIds["f11-india"]);
      const srcAdmin = must(adminIds["f11-india"]);
      // Enrich the source with every section type, including people data that must not leave.
      const [m] = await sql<{ id: string }[]>`
      SELECT id::text AS id FROM public.tenant_user_memberships WHERE tenant_id = ${src} LIMIT 1
    `;
      await sql`
      UPDATE public.tenants SET settings = settings || jsonb_build_object(
        'systemSetup', jsonb_build_object('version', 1,
            'emailAlerts', jsonb_build_object('enabled', true, 'recipients', '["ops.lead@f11.test"]'::jsonb, 'alertTypes', '[]'::jsonb),
            'escalationRules', '[{"daysThreshold":3,"recipient":"boss@f11.test","severity":"high"}]'::jsonb),
        'reportDigests', jsonb_build_object('version', 1, 'enabled', true, 'cadence', 'weekly',
            'recipients', '["exec@f11.test"]'::jsonb, 'sendHourUtc', 7),
        'communications', jsonb_build_object('senderName', 'Talent Team'),
        'anthropic', jsonb_build_object('apiKey', 'sk-should-never-leave'))
       WHERE id = ${src}
    `;
      await sql`INSERT INTO public.business_units (tenant_id, name, slug) VALUES (${src}, 'Finance Ops', 'finance-ops')`;
      await sql`
      INSERT INTO public.business_units (tenant_id, name, slug, parent_business_unit_id, legal_entity_id)
      SELECT ${src}, 'P2P Hub', 'p2p-hub', b.id, e.id FROM public.business_units b, public.legal_entities e
       WHERE b.tenant_id = ${src} AND b.slug = 'finance-ops' AND e.tenant_id = ${src}
    `;
      await sql`
      INSERT INTO public.jd_templates (tenant_id, label, title, role_family, seniority, location_type,
                                       budget_min_inr, budget_max_inr, skills)
      VALUES (${src}, 'AP Analyst', 'Accounts Payable Analyst', 'Finance', 'IN10', 'onsite', 600000, 900000,
              '["SAP FI","Invoice processing"]'::jsonb)
    `;
      await sql`
      INSERT INTO public.job_profiles (tenant_id, title, job_function_id, job_level_min_id, job_level_max_id,
                                       default_jd_template_id, competencies)
      SELECT ${src}, 'AP Analyst', f.id, l1.id, l2.id, j.id, '[{"key":"sap","label":"SAP FI"}]'::jsonb
        FROM public.job_functions f, public.job_levels l1, public.job_levels l2, public.jd_templates j
       WHERE f.tenant_id = ${src} AND f.key = 'procure_to_pay' AND l1.tenant_id = ${src} AND l1.key = 'IN09'
         AND l2.tenant_id = ${src} AND l2.key = 'IN11' AND j.tenant_id = ${src}
    `;
      await sql`
      INSERT INTO public.comp_bands (tenant_id, name, level, currency, min_major, max_major, midpoint_major,
                                     job_level_id, location_id)
      SELECT ${src}, 'IN10 Hyderabad', 'IN10', 'INR', 600000, 950000, 775000.50, l.id, loc.id
        FROM public.job_levels l, public.locations loc
       WHERE l.tenant_id = ${src} AND l.key = 'IN10' AND loc.tenant_id = ${src} AND loc.name = 'Hyderabad'
    `;
      await sql`
      INSERT INTO public.tenant_email_template_overrides (tenant_id, template_key, subject_override, slot_overrides)
      VALUES (${src}, 'candidate.application_received', 'Thanks for applying',
              '{"intro":"We have your application."}'::jsonb)
    `;
      await sql`
      INSERT INTO public.candidate_field_policy (tenant_id, field_key, requiredness, blocks_advance_stage)
      VALUES (${src}, 'notice_period', 'required', 'shortlisted')
    `;
      await sql`
      INSERT INTO public.tenant_application_sources (tenant_id, source_enum, label, config, ingestion_mode)
      VALUES (${src}, 'job_board', 'Naukri', '{"board":"naukri","apiKey":"nk-secret-123"}'::jsonb, 'connector_pending')
    `;
      await sql`
      INSERT INTO public.approval_matrices (tenant_id, subject_type, name, rules, effective_from)
      VALUES (${src}, 'offer', 'Offer approval', '{"version":1,"steps":[{"approver_kind":"role","approver_ref":"hr_head","required":true}]}'::jsonb,
              '2026-01-01T00:00:00Z'),
             (${src}, 'requisition', 'Named approver', ${JSON.stringify({ version: 1, steps: [{ approver_kind: "user", approver_ref: srcAdmin }] })}::jsonb,
              '2026-01-01T00:00:00Z')
    `;
      const [pool] = await sql<{ id: string }[]>`
      INSERT INTO public.panel_pools (tenant_id, name, focus) VALUES (${src}, 'R2R panel', 'Record to Report')
      RETURNING id::text AS id
    `;
      await sql`
      INSERT INTO public.panel_pool_members (tenant_id, panel_pool_id, membership_id)
      VALUES (${src}, ${must(pool).id}, ${must(m).id})
    `;

      const exported = await tenantAdmin("f11-india").exportTenantConfig();
      const json = JSON.stringify(exported.document);
      for (const forbidden of [
        "@f11.test",
        srcAdmin,
        must(m).id,
        "nk-secret-123",
        "apiKey",
        "sk-should-never-leave",
        "anthropic",
        'starterPack":{"key":"india-gcc-finance-gbs","version":2,"appliedAt',
      ]) {
        assert.ok(!json.includes(forbidden), `export leaks ${forbidden}`);
      }
      assert.ok(
        exported.skipped.some((s) => s.includes("Named approver")),
        "person approver skipped",
      );
      assert.ok(!exported.skipped.some((s) => s.startsWith("documentTypes")));
      assert.deepEqual(
        exported.document.sections.documentTypes?.map((d) => d.code),
        ["uan"],
      );
      assert.equal(exported.document.sections.locale?.defaultCountry, "IN");
      assert.equal(exported.document.source?.starterPack?.key, "india-gcc-finance-gbs");
      assert.equal(exported.document.sections.panelPools?.[0]?.name, "R2R panel");
      assert.equal(exported.document.sections.settings?.communications?.senderName, "Talent Team");
      // Operator export is the same document (and audited).
      const opExport = await owner().platformExportTenantConfig({ tenantId: src });
      assert.deepEqual(opExport.document.sections, exported.document.sections);

      // Import into a freshly provisioned blank tenant.
      await create("f11-target", "blank");
      const target = tenantAdmin("f11-target");
      const preview = await target.previewTenantConfigImport({ document: exported.document });
      assert.equal(preview.ok, true, preview.error ?? "");
      assert.equal(preview.empty, false);
      const sec = Object.fromEntries(preview.diff.map((d) => [d.section, d]));
      assert.equal(sec.jobLevels?.adds.length, 10);
      assert.equal(sec.locations?.adds.length, 6);
      assert.deepEqual(sec.businessUnits?.adds, ["finance-ops", "p2p-hub"]);
      assert.equal(sec.jobLevels?.removals.length, 0);

      const applied = await target.applyTenantConfigImport({
        document: exported.document,
        fingerprint: must(preview.fingerprint),
      });
      assert.ok(applied.applied.length > 0);

      const back = await target.exportTenantConfig();
      assert.deepEqual(
        back.document.sections,
        exported.document.sections,
        "identical configuration",
      );
      // The target's pool has structure, no members; source recipients were not copied.
      assert.equal(await count("panel_pool_members", must(tenantIds["f11-target"])), 0);
      const [ts] = await sql<{ settings: Deep }[]>`
      SELECT settings FROM public.tenants WHERE id = ${must(tenantIds["f11-target"])}
    `;
      assert.deepEqual(ts?.settings.reportDigests.recipients, []);
      assert.equal(ts?.settings.starterPack.key, "blank", "import never rewrites the pack marker");
      assert.equal(ts?.settings.anthropic, undefined);
      // Re-preview after apply: nothing left to change.
      const again = await target.previewTenantConfigImport({ document: exported.document });
      assert.equal(again.empty, true, JSON.stringify(again.diff));
    });

    it("import dry-run reports adds / changes / removals; apply honours them; bad files are refused", async () => {
      const target = tenantAdmin("f11-target");
      const t = must(tenantIds["f11-target"]);
      const current = (await target.exportTenantConfig()).document;
      const doc = structuredClone(current);
      const s = doc.sections;
      s.jobLevels = must(s.jobLevels).map((l) =>
        l.key === "IN10" ? { ...l, label: "Senior Associate" } : l,
      );
      s.locations = must(s.locations).filter((l) => l.name !== "Pune");
      s.jobFunctions = [
        ...must(s.jobFunctions),
        { key: "treasury", label: "Treasury", sortOrder: 110, isActive: true },
      ];
      s.lookups = [];
      delete (s as Record<string, unknown>).compBands; // absent section = untouched

      const preview = await target.previewTenantConfigImport({ document: doc });
      const sec = Object.fromEntries(preview.diff.map((d) => [d.section, d]));
      assert.deepEqual(sec.jobLevels?.changes, ["IN10"]);
      assert.deepEqual(sec.locations?.removals, ["Pune"]);
      assert.deepEqual(sec.jobFunctions?.adds, ["treasury"]);
      assert.equal(sec.lookups?.removals.length, 2);
      assert.equal(sec.compBands, undefined);
      assert.equal(must(sec.legalEntities).adds.length + must(sec.legalEntities).changes.length, 0);

      // Fingerprint must match the reviewed file.
      await expectTrpc(
        target.applyTenantConfigImport({
          document: current,
          fingerprint: must(preview.fingerprint),
        }),
        "BAD_REQUEST",
        "not the file that was previewed",
      );
      await target.applyTenantConfigImport({
        document: doc,
        fingerprint: must(preview.fingerprint),
      });
      const [pune] = await sql<{ is_active: boolean }[]>`
      SELECT is_active FROM public.locations WHERE tenant_id = ${t} AND name = 'Pune'
    `;
      assert.equal(pune?.is_active, false, "removal deactivates, never deletes");
      const [lvl] = await sql<{ label: string }[]>`
      SELECT label FROM public.job_levels WHERE tenant_id = ${t} AND key = 'IN10'
    `;
      assert.equal(lvl?.label, "Senior Associate");
      assert.equal(await count("tenant_lookups", t), 0, "lists reset to platform defaults");
      assert.equal(await count("comp_bands", t), 1, "absent section untouched");

      // Version + format refusals.
      const bad = await target.previewTenantConfigImport({
        document: { ...doc, schemaVersion: 99 },
      });
      assert.equal(bad.ok, false);
      assert.match(bad.error ?? "", /version 99 is not compatible/);
      const notOurs = await target.previewTenantConfigImport({ document: { hello: "world" } });
      assert.equal(notOurs.ok, false);
      await expectTrpc(
        target.applyTenantConfigImport({
          document: { ...doc, schemaVersion: 2 },
          fingerprint: "deadbeefdeadbeef",
        }),
        "BAD_REQUEST",
      );
    });

    it("setup wizard: steps tick, go-live is gated on the checklist, lifecycle untouched", async () => {
      await create("f11-wizard", "india-gcc-finance-gbs");
      const t = must(tenantIds["f11-wizard"]);
      const w = tenantAdmin("f11-wizard");
      let s = await w.getTenantSetup();
      assert.equal(s.onboardingStatus, "in_progress");
      assert.equal(s.starterPack?.key, "india-gcc-finance-gbs");
      assert.equal(s.canGoLive, false);
      const checks = () => Object.fromEntries(s.checks.map((c) => [c.key, c.ok]));
      assert.deepEqual(checks(), {
        admin_present: true,
        business_unit_present: false,
        approval_routing: false,
        sender_name: false,
      });
      await expectTrpc(w.tenantGoLive(), "BAD_REQUEST", "go_live_blocked");

      s = await w.setTenantSetupStep({ step: "organisation", complete: true });
      s = await w.setTenantSetupStep({ step: "roles_users", complete: true });
      assert.deepEqual(
        s.steps.filter((x) => x.complete).map((x) => x.key),
        ["organisation", "roles_users"],
      );
      s = await w.setTenantSetupStep({ step: "roles_users", complete: false });
      assert.deepEqual(
        s.steps.filter((x) => x.complete).map((x) => x.key),
        ["organisation"],
      );

      await sql`INSERT INTO public.business_units (tenant_id, name, slug) VALUES (${t}, 'GBS', 'gbs')`;
      s = await w.updateTenantSenderName({ senderName: "Talent Acquisition" });
      assert.equal(s.senderName, "Talent Acquisition");
      s = await w.setTenantSetupApprovalSkip({ skipped: true });
      assert.equal(s.canGoLive, true, JSON.stringify(s.checks));

      s = await w.tenantGoLive();
      assert.equal(s.onboardingStatus, "completed");
      assert.ok(s.steps.find((x) => x.key === "go_live")?.complete);
      const [row] = await sql<
        { status: string; onboarding_status: string; onboarding_step_completed: string }[]
      >`
      SELECT status, onboarding_status, onboarding_step_completed FROM public.tenants WHERE id = ${t}
    `;
      assert.equal(row?.onboarding_status, "completed");
      assert.equal(row?.onboarding_step_completed, "go_live");
      assert.equal(row?.status, "active", "lifecycle stays operator-controlled");
      // The wizard state and the pack marker never leak into an export.
      const exp = await w.exportTenantConfig();
      assert.equal(exp.document.sections.settings?.setup, undefined);
      assert.equal(exp.document.sections.settings?.starterPack, undefined);
      // Provisioning helper refuses a missing job.
      await expectTrpc(owner().platformRetryProvisioning({ tenantId: T_OTHER }), "NOT_FOUND");
      void provisioning;
    });
  },
);
