/**
 * C1-F10 — platform layer: platform operators, tenant lifecycle enforcement,
 * module entitlements (migration 0134).
 *
 * LOCAL POSTGRES ONLY. Migration 0134 is not on the shared database, and this
 * suite suspends tenants and flips entitlements, so it must never touch it. It
 * runs only when HIREOPS_LOCAL_PG_URL points at localhost (skipped otherwise —
 * the default in CI and on the shared DB). On an EMPTY database it first
 * creates minimal Supabase stubs (roles, auth.users, auth.jwt/uid) and applies
 * the whole migration chain in journal order, so the procedures under test run
 * against the real schema, RLS and auth hook.
 *
 *   initdb -D /tmp/pg -U postgres --auth=trust
 *   pg_ctl -D /tmp/pg -o "-p 55471" start
 *   createdb -h localhost -p 55471 -U postgres hireops_f10
 *   HIREOPS_LOCAL_PG_URL=postgres://postgres@localhost:55471/hireops_f10 \
 *     NODE_ENV=test DB_POOL_MAX=3 npx vitest run test/c1-f10-platform-layer.test.ts
 *
 * Coverage (the ticket's acceptance list):
 *   - existing tenants unaffected by default (active, every module on)
 *   - platformProcedure refuses: no session, a stranger, a TENANT ADMIN, an
 *     inactive operator; support is read-only
 *   - an operator cannot read tenant content procedures
 *   - suspended tenant: auth hook issues no tid (login refused), the sign-in
 *     doors report the lifecycle message, internal / partner / candidate
 *     procedures are FORBIDDEN, the notification drain does not claim its rows
 *   - module disabled: procedures FORBIDDEN, partner API FORBIDDEN, the worker
 *     gate skips the tenant
 *   - platform_audit_log rows written for every action
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAS_LOCAL_PG, LOCAL_PG_URL, loadLocalDb } from "./local-pg-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, "../../../packages/db/drizzle/migrations");

// ── fixture ids (the `0f10` block) ──────────────────────────────────────────
const id = (n: number) => `00000000-0000-4000-8000-0000000f10${n.toString(16).padStart(2, "0")}`;
const T1 = id(0x01); // the tenant under test
const T2 = id(0x02); // control tenant, never touched
const U_OWNER = id(0x11);
const U_SUPPORT = id(0x12);
const U_OP_INACTIVE = id(0x13);
const U_ADMIN = id(0x14); // tenant admin of T1, NOT an operator
const U_PARTNER = id(0x15);
const U_CANDIDATE = id(0x16);
const U_STRANGER = id(0x17); // auth user with no rows anywhere
const M_ADMIN = id(0x21);
const P_ORG = id(0x31);
const P_USER = id(0x32);
const PERSON = id(0x41);
const CAND_ACCT = id(0x42);
const OUT_T1 = id(0x51);
const OUT_T2 = id(0x52);

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
type Sql = DbModule["sql"];

/** Stubs + the full migration chain, only when the schema is absent. */
async function prepareSchema(sql: Sql): Promise<void> {
  const [probe] = await sql<
    { t: string | null }[]
  >`SELECT to_regclass('public.tenant_modules')::text AS t`;
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

async function cleanup(sql: Sql): Promise<void> {
  // platform_audit_log is append-only; its tenant FK nulls out on tenant delete.
  await sql`DELETE FROM public.notification_outbox WHERE tenant_id IN (${T1}, ${T2})`;
  await sql`DELETE FROM public.candidate_accounts WHERE tenant_id = ${T1}`;
  await sql`DELETE FROM public.persons WHERE tenant_id = ${T1}`;
  await sql`DELETE FROM public.partner_users WHERE tenant_id = ${T1}`;
  await sql`DELETE FROM public.partner_orgs WHERE tenant_id = ${T1}`;
  await sql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${T1}`;
  await sql`DELETE FROM public.tenants WHERE id IN (${T1}, ${T2})`;
  await sql`UPDATE public.platform_operators SET active = false WHERE user_id IN (${U_OWNER}, ${U_SUPPORT}, ${U_OP_INACTIVE})`;
}

describe.skipIf(!HAS_LOCAL_PG)("C1-F10 platform layer (local Postgres)", () => {
  let db: DbModule;
  let sql: Sql;
  let appRouter: typeof import("../src/trpc/router").appRouter;
  let access: typeof import("../src/lib/platform/tenant-access");
  let gate: typeof import("../../workers/src/lib/tenant-gate");
  let drainOutboxOnce: typeof import("../../workers/src/lib/dispatcher").drainOutboxOnce;
  let log: import("@hireops/observability").Logger;

  function caller(userId: string | null, tenantId: string | null = null, roles: string[] = []) {
    return appRouter.createCaller({
      tenantId,
      userId,
      roles,
      claims: userId ? { sub: userId, ...(tenantId ? { tid: tenantId, roles } : {}) } : null,
      db: undefined,
      sql: db.sql,
      log,
      requestId: `f10-${Math.random().toString(36).slice(2)}`,
      userAgent: null,
      ipAddress: null,
    });
  }
  const owner = () => caller(U_OWNER);
  const admin = () => caller(U_ADMIN, T1, ["admin"]);

  async function expectTrpc(p: Promise<unknown>, code: string, message?: string): Promise<void> {
    try {
      await p;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
      if (message) assert.equal(e.message, message);
      return;
    }
    assert.fail(`expected ${code}${message ? ` ${message}` : ""}, but the call succeeded`);
  }

  async function hookTid(userId: string): Promise<string | null> {
    const [r] = await sql<{ ev: { claims?: { tid?: string } } }[]>`
      SELECT public.custom_access_token_hook(
        jsonb_build_object('user_id', ${userId}::text, 'claims', '{}'::jsonb)) AS ev
    `;
    return r?.ev?.claims?.tid ?? null;
  }

  async function auditCount(action: string, tenantId: string | null): Promise<number> {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.platform_audit_log
       WHERE action = ${action}
         AND ${tenantId === null ? sql`tenant_id IS NULL` : sql`tenant_id = ${tenantId}`}
    `;
    return r?.n ?? 0;
  }

  beforeAll(async () => {
    if (!LOCAL_PG_URL) return;
    db = await loadLocalDb();
    sql = db.sql;
    await prepareSchema(sql);
    await import("../src/bootstrap");
    ({ appRouter } = await import("../src/trpc/router"));
    access = await import("../src/lib/platform/tenant-access");
    gate = await import("../../workers/src/lib/tenant-gate");
    ({ drainOutboxOnce } = await import("../../workers/src/lib/dispatcher"));
    log = (await import("@hireops/observability")).createLogger({ level: "error" });

    await cleanup(sql);
    await sql`
      INSERT INTO auth.users (id, email) VALUES
        (${U_OWNER}, 'owner@f10.test'), (${U_SUPPORT}, 'support@f10.test'),
        (${U_OP_INACTIVE}, 'gone@f10.test'), (${U_ADMIN}, 'admin@f10.test'),
        (${U_PARTNER}, 'partner@f10.test'), (${U_CANDIDATE}, 'cand@f10.test'),
        (${U_STRANGER}, 'stranger@f10.test')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO public.platform_operators (user_id, email, role, active) VALUES
        (${U_OWNER}, 'owner@f10.test', 'owner', true),
        (${U_SUPPORT}, 'support@f10.test', 'support', true),
        (${U_OP_INACTIVE}, 'gone@f10.test', 'operator', false)
      ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active
    `;
    await sql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES
        (${T1}, 'f10-tenant-one', 'F10 Tenant One', 'ap-south-1', 'active'),
        (${T2}, 'f10-tenant-two', 'F10 Tenant Two', 'ap-south-1', 'active')
    `;
    await sql`
      INSERT INTO public.tenant_user_memberships (id, user_id, tenant_id, roles, status)
      VALUES (${M_ADMIN}, ${U_ADMIN}, ${T1}, '{admin}', 'active')
    `;
    await sql`
      INSERT INTO public.partner_orgs (id, tenant_id, name, tier)
      VALUES (${P_ORG}, ${T1}, 'F10 Partners', 'empanelled')
    `;
    await sql`
      INSERT INTO public.partner_users (id, tenant_id, partner_org_id, user_id, full_name, email, role)
      VALUES (${P_USER}, ${T1}, ${P_ORG}, ${U_PARTNER}, 'Pat Partner', 'partner@f10.test', 'partner_admin')
    `;
    await sql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary)
      VALUES (${PERSON}, ${T1}, 'Casey Candidate', 'cand@f10.test')
    `;
    await sql`
      INSERT INTO public.candidate_accounts (id, tenant_id, person_id, user_id, status)
      VALUES (${CAND_ACCT}, ${T1}, ${PERSON}, ${U_CANDIDATE}, 'active')
    `;
    access.invalidateTenantAccessCache();
  });

  afterAll(async () => {
    if (!sql) return;
    await cleanup(sql);
    await sql.end();
  });

  it("existing tenants are unaffected by default: active, every module on", async () => {
    const modules = await access.getTenantModules(sql, T1);
    assert.ok(Object.values(modules).every(Boolean), "every module enabled with no rows");
    assert.equal(await access.tenantIsActive(sql, T1), true);
    await admin().getDiversitySlateSettings();
    const me = await caller(U_PARTNER).partnerGetMe();
    assert.equal(me.orgName, "F10 Partners");
    const cand = await caller(U_CANDIDATE).candidateGetMe();
    assert.equal(cand.tenantId, T1);
    assert.equal(await hookTid(U_ADMIN), T1);
    const status = await caller(U_ADMIN).accountAccessStatus({ audience: "internal" });
    assert.equal(status.access, "ok");
    assert.equal(status.platformOperator, false);
  });

  it("platformProcedure refuses everyone who is not an active operator", async () => {
    await expectTrpc(caller(null).platformWhoami(), "UNAUTHORIZED");
    await expectTrpc(caller(U_STRANGER).platformWhoami(), "FORBIDDEN", "not_a_platform_operator");
    // A tenant ADMIN — even carrying a tenant token — is not an operator.
    await expectTrpc(admin().platformWhoami(), "FORBIDDEN", "not_a_platform_operator");
    await expectTrpc(admin().platformListTenants(), "FORBIDDEN", "not_a_platform_operator");
    await expectTrpc(
      admin().platformSetTenantStatus({ tenantId: T1, status: "suspended", reason: "nope" }),
      "FORBIDDEN",
      "not_a_platform_operator",
    );
    await expectTrpc(
      caller(U_OP_INACTIVE).platformWhoami(),
      "FORBIDDEN",
      "not_a_platform_operator",
    );

    const me = await owner().platformWhoami();
    assert.equal(me.role, "owner");
    assert.equal(me.canWrite, true);

    const sup = await caller(U_SUPPORT).platformWhoami();
    assert.equal(sup.canWrite, false);
    await expectTrpc(
      caller(U_SUPPORT).platformSetTenantStatus({
        tenantId: T1,
        status: "suspended",
        reason: "x y z",
      }),
      "FORBIDDEN",
      "platform_role_read_only",
    );
    await expectTrpc(
      caller(U_SUPPORT).platformSetTenantModules({
        tenantId: T1,
        modules: [{ key: "ask_data", enabled: false }],
      }),
      "FORBIDDEN",
      "platform_role_read_only",
    );
    assert.equal(await access.tenantIsActive(sql, T1), true, "support could not suspend");
  });

  it("an operator cannot read tenant content procedures", async () => {
    // Operator identity has no tenant claim → every tenant tier refuses it.
    await expectTrpc(owner().listRequisitions({ pagination: { limit: 5 } }), "UNAUTHORIZED");
    await expectTrpc(owner().getDiversitySlateSettings(), "UNAUTHORIZED");
    await expectTrpc(owner().partnerGetMe(), "FORBIDDEN", "not_a_partner_account");
    await expectTrpc(owner().candidateGetMe(), "FORBIDDEN", "not_a_candidate_account");

    // The platform read itself is metadata only: a fixed key set, no content.
    const t = await owner().platformGetTenant({ tenantId: T1 });
    assert.deepEqual(Object.keys(t).sort(), ["modules", "recentAudit", "tenant"]);
    assert.deepEqual(Object.keys(t.tenant).sort(), [
      "activatedAt",
      "activeMembers",
      "activeRequisitions",
      "candidateAccounts",
      "createdAt",
      "disabledModules",
      "displayName",
      "id",
      "onboardingStatus",
      "partnerUsers",
      "primaryRegion",
      "scheduledDeletionAt",
      "slug",
      "status",
      "suspendedAt",
      "tier",
    ]);
    assert.equal(t.tenant.activeMembers, 1);
    assert.equal(t.tenant.partnerUsers, 1);
    assert.equal(t.tenant.candidateAccounts, 1);
    assert.ok(!JSON.stringify(t).includes("Casey Candidate"), "no person content leaks");

    const list = await owner().platformListTenants();
    assert.ok(list.items.some((i) => i.id === T1 && i.status === "active"));
    const health = await owner().platformGetHealth();
    assert.ok(health.tenants.some((h) => h.tenantId === T1));
  });

  it("suspended tenant: login refused, procedures FORBIDDEN, worker skips it", async () => {
    await sql`
      INSERT INTO public.notification_outbox (id, tenant_id, recipient_type, recipient_email, template_key)
      VALUES (${OUT_T1}, ${T1}, 'candidate', 'cand@f10.test', 'f10_probe'),
             (${OUT_T2}, ${T2}, 'candidate', 'cand@f10.test', 'f10_probe')
    `;
    // Warm the cache while active, so the mutation's invalidation is what is tested.
    await admin().getDiversitySlateSettings();

    const res = await owner().platformSetTenantStatus({
      tenantId: T1,
      status: "suspended",
      reason: "unpaid invoice (test)",
    });
    assert.equal(res.previousStatus, "active");
    const [row] = await sql<{ status: string; suspended_at: Date | null }[]>`
      SELECT status, suspended_at FROM public.tenants WHERE id = ${T1}
    `;
    assert.equal(row?.status, "suspended");
    assert.ok(row?.suspended_at);

    // (a) sign-in: the auth hook stops issuing a tid; every door explains why.
    assert.equal(await hookTid(U_ADMIN), null);
    for (const [user, audience] of [
      [U_ADMIN, "internal"],
      [U_PARTNER, "partner"],
      [U_CANDIDATE, "candidate"],
    ] as const) {
      const s = await caller(user).accountAccessStatus({ audience });
      assert.equal(s.access, "tenant_inactive", audience);
      assert.equal(s.tenantStatus, "suspended");
      assert.match(s.message ?? "", /suspended/);
    }

    // (b) a token issued BEFORE the suspension still carries tid → FORBIDDEN.
    await expectTrpc(admin().getDiversitySlateSettings(), "FORBIDDEN", "tenant_suspended");
    await expectTrpc(
      admin().listRequisitions({ pagination: { limit: 5 } }),
      "FORBIDDEN",
      "tenant_suspended",
    );
    await expectTrpc(caller(U_PARTNER).partnerGetMe(), "FORBIDDEN", "tenant_suspended");
    await expectTrpc(caller(U_CANDIDATE).candidateGetMe(), "FORBIDDEN", "tenant_suspended");

    // (c) workers: the suspended tenant's email is not claimed (no send, no
    // attempt burned); the control tenant's is.
    await drainOutboxOnce({ log });
    const outbox = await sql<{ id: string; status: string; attempt_count: number }[]>`
      SELECT id::text AS id, status, attempt_count FROM public.notification_outbox
       WHERE id IN (${OUT_T1}, ${OUT_T2})
    `;
    const o1 = outbox.find((o) => o.id === OUT_T1);
    const o2 = outbox.find((o) => o.id === OUT_T2);
    assert.equal(o1?.status, "pending");
    assert.equal(o1?.attempt_count, 0, "suspended tenant's row untouched");
    assert.equal(o2?.attempt_count, 1, "active tenant's row was worked");
    const active = await gate.activeTenantIds();
    assert.ok(!active.has(T1) && active.has(T2));

    // Reactivate → everything is back, and the held row is claimable again.
    await owner().platformSetTenantStatus({
      tenantId: T1,
      status: "active",
      reason: "paid (test)",
    });
    assert.equal(await hookTid(U_ADMIN), T1);
    await admin().getDiversitySlateSettings();
    await caller(U_PARTNER).partnerGetMe();
    await drainOutboxOnce({ log });
    const [after] = await sql<{ attempt_count: number }[]>`
      SELECT attempt_count FROM public.notification_outbox WHERE id = ${OUT_T1}
    `;
    assert.equal(after?.attempt_count, 1, "held row is worked after reactivation");

    assert.equal(await auditCount("tenant.status_change", T1), 2);
    const [audit] = await sql<{ summary: Record<string, unknown>; operator_email: string }[]>`
      SELECT summary, operator_email FROM public.platform_audit_log
       WHERE tenant_id = ${T1} AND action = 'tenant.status_change'
       ORDER BY created_at LIMIT 1
    `;
    assert.deepEqual(audit?.summary, {
      from: "active",
      to: "suspended",
      reason: "unpaid invoice (test)",
    });
    assert.equal(audit?.operator_email, "owner@f10.test");
  });

  it("module disabled: procedures FORBIDDEN, partner API FORBIDDEN, worker gate skips it", async () => {
    await admin().getDiversitySlateSettings(); // warm the module cache
    const res = await owner().platformSetTenantModules({
      tenantId: T1,
      modules: [
        { key: "diversity_slate", enabled: false },
        { key: "partner_portal", enabled: false },
        { key: "ask_data", enabled: false },
        { key: "learning", enabled: false },
        { key: "market_intel", enabled: false },
        { key: "onboarding", enabled: true }, // already on (default) → no change, no row
      ],
      reason: "not in the starter tier (test)",
    });
    assert.deepEqual(res.changed.map((c) => c.key).sort(), [
      "ask_data",
      "diversity_slate",
      "learning",
      "market_intel",
      "partner_portal",
    ]);

    await expectTrpc(
      admin().getDiversitySlateSettings(),
      "FORBIDDEN",
      "module_disabled:diversity_slate",
    );
    await expectTrpc(admin().askDataCatalog({}), "FORBIDDEN", "module_disabled:ask_data");
    await expectTrpc(admin().listLearningTracks({}), "FORBIDDEN", "module_disabled:learning");
    await expectTrpc(admin().listMarketBenchmarks({}), "FORBIDDEN", "module_disabled:market_intel");
    await expectTrpc(
      caller(U_PARTNER).partnerGetMe(),
      "FORBIDDEN",
      "module_disabled:partner_portal",
    );
    // A core (non-module) procedure still works for the tenant.
    await admin().listRequisitions({ pagination: { limit: 5 } });
    // The control tenant is untouched.
    assert.equal((await access.getTenantModules(sql, T2)).ask_data, true);

    // Worker gate: the claim predicate drops T1 for the module, keeps T2.
    await sql`UPDATE public.notification_outbox SET status = 'pending' WHERE id IN (${OUT_T1}, ${OUT_T2})`;
    const claimable = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id::text AS tenant_id FROM public.notification_outbox
       WHERE id IN (${OUT_T1}, ${OUT_T2}) ${gate.tenantGateSql("notification_outbox", "ask_data")}
    `;
    assert.deepEqual(
      claimable.map((c) => c.tenant_id),
      [T2],
    );
    const withModule = await gate.tenantsWithModule("ask_data");
    assert.ok(!withModule.has(T1) && withModule.has(T2));

    const t = await owner().platformGetTenant({ tenantId: T1 });
    const ds = t.modules.find((m) => m.key === "diversity_slate");
    assert.equal(ds?.enabled, false);
    assert.equal(ds?.explicit, true);
    assert.deepEqual(t.tenant.disabledModules, [
      "ask_data",
      "diversity_slate",
      "learning",
      "market_intel",
      "partner_portal",
    ]);
    assert.equal(t.modules.find((m) => m.key === "onboarding")?.explicit, false);

    // Re-enable → works again, enabled_at stamped, audited.
    await owner().platformSetTenantModules({
      tenantId: T1,
      modules: [{ key: "diversity_slate", enabled: true }],
    });
    await admin().getDiversitySlateSettings();
    const [m] = await sql<{ enabled: boolean; enabled_at: Date | null }[]>`
      SELECT enabled, enabled_at FROM public.tenant_modules
       WHERE tenant_id = ${T1} AND module_key = 'diversity_slate'
    `;
    assert.equal(m?.enabled, true);
    assert.ok(m?.enabled_at);
    assert.equal(await auditCount("tenant.modules_change", T1), 2);

    // A no-op save writes neither a row nor an audit entry.
    const noop = await owner().platformSetTenantModules({
      tenantId: T1,
      modules: [{ key: "diversity_slate", enabled: true }],
    });
    assert.equal(noop.changed.length, 0);
    assert.equal(await auditCount("tenant.modules_change", T1), 2);
  });

  it("every operator action is in the platform audit log, metadata only", async () => {
    assert.ok((await auditCount("tenants.list", null)) >= 1);
    assert.ok((await auditCount("health.view", null)) >= 1);
    assert.ok((await auditCount("tenant.view", T1)) >= 1);
    const rows = await sql<{ summary: unknown }[]>`
      SELECT summary FROM public.platform_audit_log WHERE tenant_id = ${T1}
    `;
    assert.ok(!JSON.stringify(rows).includes("Casey"), "no tenant content in the audit trail");
    // Append-only.
    await assert.rejects(
      sql`UPDATE public.platform_audit_log SET action = 'tampered' WHERE tenant_id = ${T1}`,
      /append-only/,
    );
    await assert.rejects(
      sql`DELETE FROM public.platform_audit_log WHERE tenant_id = ${T1}`,
      /append-only/,
    );
  });
});
