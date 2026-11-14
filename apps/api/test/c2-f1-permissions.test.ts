/**
 * C2-F1 — tenant-defined roles, capability bundles, scoped permissions
 * (migration 0137).
 *
 * LOCAL POSTGRES ONLY. Creates tenants, memberships, custom roles and
 * requisitions, so it must never touch the shared database. Runs only when
 * HIREOPS_LOCAL_PG_URL points at localhost (skipped otherwise — the default in
 * CI and on the shared DB). On an EMPTY database it first creates minimal
 * Supabase stubs and applies the whole migration chain in journal order.
 *
 *   initdb -D /tmp/pg -U postgres --auth=trust
 *   pg_ctl -D /tmp/pg -o "-p 55537" start
 *   createdb -h localhost -p 55537 -U postgres hireops_c2f1
 *   HIREOPS_LOCAL_PG_URL=postgres://postgres@localhost:55537/hireops_c2f1 \
 *     NODE_ENV=test DB_POOL_MAX=3 npx vitest run test/c2-f1-permissions.test.ts
 *
 * Coverage (the ticket's acceptance list):
 *   - membership WITHOUT role_key behaves exactly as before (system bundles)
 *   - a custom role with a SUBSET of capabilities is enforced (allowed + forbidden)
 *   - admin no longer bypasses: an admin-based custom role without a capability
 *     is refused it (and the portal-facing getMyPermissions agrees)
 *   - scope `business_unit` limits a list procedure (listMyRequisitionsV2) and
 *     the detail read; scope `own` / `team` likewise
 *   - no privilege escalation through role definition or assignment; lock-out
 *     guard; deactivation refused while assigned
 *   - roles export → import round-trip into a second tenant
 *   - RLS: tenant_roles / role_capabilities are tenant-isolated; a capability
 *     never reaches another tenant's rows
 */

import { afterAll, beforeAll, describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAS_LOCAL_PG, LOCAL_PG_URL, loadLocalDb } from "./local-pg-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, "../../../packages/db/drizzle/migrations");

// ── fixture ids (the `0c2f` block) ──────────────────────────────────────────
const id = (n: number) => `00000000-0000-4000-8000-0000000c2f${n.toString(16).padStart(2, "0")}`;
const T = id(0x01);
const T2 = id(0x02);
// auth users
const U_ADMIN = id(0x10);
const U_ADMIN2 = id(0x11);
const U_TA = id(0x12); // custom "ta_lead" (base hr_head) — subset of capabilities
const U_ITADMIN = id(0x13); // custom admin-based role WITHOUT admin.users
const U_HM_A = id(0x14); // hiring manager, BU fin-ap (child of fin)
const U_HM_B = id(0x15); // hiring manager, BU ops
const U_BU = id(0x16); // custom "fin_viewer" (base recruiter) scope business_unit, BU fin
const U_OWN = id(0x17); // custom "own_viewer" (base recruiter) scope own
const U_TEAM = id(0x18); // custom "team_viewer" (base recruiter) scope team; HM_A reports to them
const U_REC = id(0x19); // plain recruiter (no role_key)
const U_T2_ADMIN = id(0x1a);
// memberships
const M_ADMIN = id(0x20);
const M_ADMIN2 = id(0x21);
const M_TA = id(0x22);
const M_ITADMIN = id(0x23);
const M_HM_A = id(0x24);
const M_HM_B = id(0x25);
const M_BU = id(0x26);
const M_OWN = id(0x27);
const M_TEAM = id(0x28);
const M_REC = id(0x29);
const M_T2_ADMIN = id(0x2a);
// org
const LE = id(0x30);
const BU_FIN = id(0x31);
const BU_FIN_AP = id(0x32);
const BU_OPS = id(0x33);
// requisitions
const P_A = id(0x40);
const P_B = id(0x41);
const JD_A = id(0x42);
const JD_B = id(0x43);
const R_A = id(0x44); // BU fin-ap, HM_A
const R_B = id(0x45); // BU ops, HM_B
const PER_A = id(0x50);
const PER_B = id(0x51);
const CAN_A = id(0x52);
const CAN_B = id(0x53);
const APP_A = id(0x54); // on R_A
const APP_B = id(0x55); // on R_B

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

async function prepareSchema(sql: Sql): Promise<void> {
  const [probe] = await sql<
    { t: string | null }[]
  >`SELECT to_regclass('public.tenant_roles')::text AS t`;
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
  for (const t of [T, T2]) {
    await sql`DELETE FROM public.api_audit_logs WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.audit_logs WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.applications WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.candidates WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.persons WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.requisitions WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.jd_versions WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.positions WHERE tenant_id = ${t}`;
    await sql`UPDATE public.tenant_user_memberships SET role_key = NULL, manager_id = NULL, business_unit_id = NULL WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.role_capabilities WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.tenant_roles WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.business_units WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.legal_entities WHERE tenant_id = ${t}`;
    await sql`DELETE FROM public.tenants WHERE id = ${t}`;
  }
  await sql`DELETE FROM auth.users WHERE email LIKE '%@c2f1.test'`;
}

describe.skipIf(!HAS_LOCAL_PG)("C2-F1 roles, capabilities, scopes (local Postgres)", () => {
  let db: DbModule;
  let sql: Sql;
  let appRouter: typeof import("../src/trpc/router").appRouter;
  let invalidate: typeof import("../src/lib/permissions/resolve").invalidatePermissionsCache;
  let log: import("@hireops/observability").Logger;

  function caller(userId: string, roles: string[], tenantId = T) {
    return appRouter.createCaller({
      tenantId,
      userId,
      roles,
      claims: { sub: userId, tid: tenantId, tenant_slug: "c2f1", roles },
      db: undefined,
      sql: db.sql,
      log,
      requestId: `c2f1-${Math.random().toString(36).slice(2)}`,
      userAgent: null,
      ipAddress: null,
    });
  }

  async function expectTrpc(p: Promise<unknown>, code: string, message?: string): Promise<void> {
    try {
      await p;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
      if (message) assert.ok(e.message?.includes(message), `message ${e.message} lacks ${message}`);
      return;
    }
    assert.fail(`expected ${code}, but the call succeeded`);
  }

  const reqIds = async (userId: string, roles: string[]) =>
    (await caller(userId, roles).listMyRequisitionsV2({ limit: 100 })).rows.map((r) => r.id).sort();

  beforeAll(async () => {
    if (!LOCAL_PG_URL) return;
    process.env.SUPABASE_KEK_SECRET = randomBytes(32).toString("hex");
    process.env.KMS_PROVIDER = "local";
    db = await loadLocalDb();
    sql = db.sql;
    await prepareSchema(sql);
    await import("../src/bootstrap");
    ({ appRouter } = await import("../src/trpc/router"));
    ({ invalidatePermissionsCache: invalidate } = await import("../src/lib/permissions/resolve"));
    log = (await import("@hireops/observability")).createLogger({ level: "error" });

    await cleanup(sql);
    const users: [string, string][] = [
      [U_ADMIN, "admin"],
      [U_ADMIN2, "admin2"],
      [U_TA, "ta"],
      [U_ITADMIN, "itadmin"],
      [U_HM_A, "hm-a"],
      [U_HM_B, "hm-b"],
      [U_BU, "bu"],
      [U_OWN, "own"],
      [U_TEAM, "team"],
      [U_REC, "rec"],
      [U_T2_ADMIN, "t2admin"],
    ];
    for (const [u, n] of users) {
      await sql`INSERT INTO auth.users (id, email) VALUES (${u}, ${`${n}@c2f1.test`})`;
    }
    await sql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status) VALUES
        (${T}, 'c2f1', 'C2F1', 'ap-south-1', 'active'),
        (${T2}, 'c2f1-two', 'C2F1 Two', 'ap-south-1', 'active')
    `;
    await sql`INSERT INTO public.legal_entities (id, tenant_id, name, country_code) VALUES (${LE}, ${T}, 'C2F1 India', 'IN')`;
    await sql`
      INSERT INTO public.business_units (id, tenant_id, name, slug, parent_business_unit_id, legal_entity_id) VALUES
        (${BU_FIN}, ${T}, 'Finance', 'finance', NULL, ${LE}),
        (${BU_FIN_AP}, ${T}, 'Accounts Payable', 'finance-ap', ${BU_FIN}, ${LE}),
        (${BU_OPS}, ${T}, 'Operations', 'operations', NULL, NULL)
    `;
    const mem: [string, string, string, string[], string | null][] = [
      [M_ADMIN, U_ADMIN, T, ["admin"], null],
      [M_ADMIN2, U_ADMIN2, T, ["admin"], null],
      [M_TA, U_TA, T, ["hr_head"], null],
      [M_ITADMIN, U_ITADMIN, T, ["admin"], null],
      [M_HM_A, U_HM_A, T, ["hiring_manager"], BU_FIN_AP],
      [M_HM_B, U_HM_B, T, ["hiring_manager"], BU_OPS],
      [M_BU, U_BU, T, ["recruiter"], BU_FIN],
      [M_OWN, U_OWN, T, ["recruiter"], null],
      [M_TEAM, U_TEAM, T, ["recruiter"], null],
      [M_REC, U_REC, T, ["recruiter"], null],
      [M_T2_ADMIN, U_T2_ADMIN, T2, ["admin"], null],
    ];
    for (const [m, u, t, roles, bu] of mem) {
      await sql`
        INSERT INTO public.tenant_user_memberships (id, user_id, tenant_id, roles, status, business_unit_id)
        VALUES (${m}, ${u}, ${t}, ${`{${roles.join(",")}}`}::tenant_role[], 'active', ${bu})
      `;
    }
    // HM_A reports to the team viewer.
    await sql`UPDATE public.tenant_user_memberships SET manager_id = ${M_TEAM} WHERE id = ${M_HM_A}`;

    await sql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title) VALUES
        (${P_A}, ${T}, ${BU_FIN_AP}, 'AP Analyst'),
        (${P_B}, ${T}, ${BU_OPS}, 'Ops Lead')
    `;
    await sql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text) VALUES
        (${JD_A}, ${T}, ${P_A}, 1, 'AP analyst JD'),
        (${JD_B}, ${T}, ${P_B}, 1, 'Ops lead JD')
    `;
    // R_A: HM_A, recruiter OWN. R_B: HM_B, recruiter REC.
    await sql`
      INSERT INTO public.requisitions (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status) VALUES
        (${R_A}, ${T}, ${P_A}, ${JD_A}, ${M_OWN}, ${M_HM_A}, 'approved'),
        (${R_B}, ${T}, ${P_B}, ${JD_B}, ${M_REC}, ${M_HM_B}, 'approved')
    `;
    await sql`
      INSERT INTO public.persons (id, tenant_id, full_name) VALUES
        (${PER_A}, ${T}, 'Asha AP'), (${PER_B}, ${T}, 'Bala Ops')
    `;
    await sql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source) VALUES
        (${CAN_A}, ${T}, ${PER_A}, 'career_site'), (${CAN_B}, ${T}, ${PER_B}, 'career_site')
    `;
    await sql`
      INSERT INTO public.applications (id, tenant_id, candidate_id, requisition_id, source) VALUES
        (${APP_A}, ${T}, ${CAN_A}, ${R_A}, 'career_site'),
        (${APP_B}, ${T}, ${CAN_B}, ${R_B}, 'career_site')
    `;
    invalidate();
  });

  afterAll(async () => {
    if (!HAS_LOCAL_PG || !sql) return;
    await cleanup(sql);
    await sql.end({ timeout: 5 });
  });

  // ─────────────────────────── no role_key ───────────────────────────

  it("a membership WITHOUT role_key behaves as before (system bundles)", async () => {
    // Recruiter: triage yes, requisition write no; sees every requisition.
    const rec = caller(U_REC, ["recruiter"]);
    const me = await rec.getMyPermissions({});
    assert.equal(me.roleKey, null);
    assert.equal(me.caps["candidates.triage"], "all");
    assert.equal(me.caps["requisitions.write"], undefined);
    assert.deepEqual(await reqIds(U_REC, ["recruiter"]), [R_A, R_B].sort());
    await expectTrpc(rec.listTenantUsersAdmin({}), "FORBIDDEN");
    // Admin keeps everything (by bundle).
    const admin = caller(U_ADMIN, ["admin"]);
    const users = await admin.listTenantUsersAdmin({});
    assert.ok(users.items.length >= 10);
    assert.ok(users.items.every((u) => u.roleKey === null));
    // The role catalog exposes system roles read-only.
    const roles = await admin.listRoles({});
    const sys = roles.roles.filter((r) => r.isSystem).map((r) => r.key);
    assert.ok(sys.includes("admin") && sys.includes("hr_head") && sys.includes("it_admin"));
    // REC, BU, OWN, TEAM hold the recruiter system role.
    assert.equal(roles.roles.find((r) => r.key === "recruiter")?.memberCount, 4);
  });

  // ─────────────────────────── custom subset role ───────────────────────────

  it("a custom role with a SUBSET of capabilities is enforced (allowed + forbidden)", async () => {
    const admin = caller(U_ADMIN, ["admin"]);
    const created = await admin.upsertCustomRole({
      key: "ta_lead",
      label: "TA lead",
      baseRole: "hr_head",
      description: "Runs recruiting reports and vendors, no comp desk",
      grants: [
        { capability: "reports.read", scope: "all" },
        { capability: "partners.admin", scope: "all" },
        { capability: "requisitions.read", scope: "all" },
      ],
    });
    assert.equal(created.created, true);
    assert.equal(created.role.grants.length, 3);
    await admin.assignMemberRole({ membershipId: M_TA, roleKey: "ta_lead" });
    const [m] = await sql<{ roles: string[]; role_key: string }[]>`
      SELECT roles::text[] AS roles, role_key FROM public.tenant_user_memberships WHERE id = ${M_TA}
    `;
    assert.deepEqual(m?.roles, ["hr_head"]);
    assert.equal(m?.role_key, "ta_lead");

    const ta = caller(U_TA, ["hr_head"]);
    // Allowed: granted capabilities (partners.admin is NOT in hr_head's system bundle).
    await ta.listPartnerOrgs();
    await ta.getPipelineReport({});
    // Forbidden: hr_head system capabilities the custom bundle leaves out.
    await expectTrpc(ta.getHrMetrics(), "FORBIDDEN");
    await expectTrpc(ta.listRequisitionApprovals({}), "FORBIDDEN");
    await expectTrpc(ta.getGovernancePolicy({}), "FORBIDDEN");
    const me = await ta.getMyPermissions({});
    assert.equal(me.roleKey, "ta_lead");
    assert.deepEqual(Object.keys(me.caps).sort(), [
      "partners.admin",
      "reports.read",
      "requisitions.read",
    ]);
  });

  // ─────────────────────────── no admin bypass ───────────────────────────

  it("admin no longer bypasses: an admin-based custom role without a capability is refused it", async () => {
    const admin = caller(U_ADMIN, ["admin"]);
    await admin.upsertCustomRole({
      key: "it_lead",
      label: "IT lead",
      baseRole: "admin",
      grants: [
        { capability: "settings.branding", scope: "all" },
        { capability: "admin.integrations", scope: "all" },
        { capability: "governance.audit_log", scope: "all" },
      ],
    });
    await admin.assignMemberRole({ membershipId: M_ITADMIN, roleKey: "it_lead" });
    // JWT still says admin — the custom bundle decides.
    const it = caller(U_ITADMIN, ["admin"]);
    await it.getTenantBranding({});
    await it.listAuditEvents({ limit: 5 });
    await expectTrpc(it.listTenantUsersAdmin({}), "FORBIDDEN");
    await expectTrpc(it.listCompDesk({}), "FORBIDDEN");
    await expectTrpc(it.listCandidates({ pagination: { limit: 5 } }), "FORBIDDEN");
    await expectTrpc(it.getTenantAiSettings({}), "FORBIDDEN");
    // Every capability absent → the dashboard gate too (no bypass anywhere).
    await expectTrpc(it.getMyDashboard(), "FORBIDDEN");
  });

  // ─────────────────────────── scopes ───────────────────────────

  it("scope business_unit limits the requisition list + detail to the member's BU subtree", async () => {
    const admin = caller(U_ADMIN, ["admin"]);
    await admin.upsertCustomRole({
      key: "fin_viewer",
      label: "Finance requisitions viewer",
      baseRole: "recruiter",
      grants: [{ capability: "requisitions.read", scope: "business_unit" }],
    });
    await admin.assignMemberRole({ membershipId: M_BU, roleKey: "fin_viewer" });
    // Member BU = Finance; R_A is on Accounts Payable (a child) → visible; R_B (Ops) → not.
    assert.deepEqual(await reqIds(U_BU, ["recruiter"]), [R_A]);
    const bu = caller(U_BU, ["recruiter"]);
    const detail = await bu.getRequisitionDetail({ requisitionId: R_A });
    assert.equal(detail.id, R_A);
    await expectTrpc(bu.getRequisitionDetail({ requisitionId: R_B }), "NOT_FOUND");
    // The application list (listCandidates, same capability) is limited the same way.
    const apps = await bu.listCandidates({ pagination: { limit: 50, offset: 0 } });
    assert.deepEqual(
      apps.rows.map((i) => i.applicationId),
      [APP_A],
    );
    // …while a system recruiter (scope all) still sees both.
    const all = await caller(U_REC, ["recruiter"]).listCandidates({
      pagination: { limit: 50, offset: 0 },
    });
    assert.deepEqual(all.rows.map((i) => i.applicationId).sort(), [APP_A, APP_B].sort());
    // A BU-less member with the same scope sees nothing (fail closed), never everything.
    await sql`UPDATE public.tenant_user_memberships SET business_unit_id = NULL WHERE id = ${M_BU}`;
    invalidate(T);
    assert.deepEqual(await reqIds(U_BU, ["recruiter"]), []);
    await sql`UPDATE public.tenant_user_memberships SET business_unit_id = ${BU_FIN} WHERE id = ${M_BU}`;
    invalidate(T);
    // legal_entity: Finance + AP share the entity; Ops has none.
    await admin.upsertCustomRole({
      key: "fin_viewer",
      label: "Finance requisitions viewer",
      baseRole: "recruiter",
      grants: [{ capability: "requisitions.read", scope: "legal_entity" }],
    });
    assert.deepEqual(await reqIds(U_BU, ["recruiter"]), [R_A]);
  });

  it("scope own / team limit by ownership (HM or primary recruiter; + direct reports)", async () => {
    const admin = caller(U_ADMIN, ["admin"]);
    await admin.upsertCustomRole({
      key: "own_viewer",
      label: "Own requisitions",
      baseRole: "recruiter",
      grants: [{ capability: "requisitions.read", scope: "own" }],
    });
    await admin.upsertCustomRole({
      key: "team_viewer",
      label: "Team requisitions",
      baseRole: "recruiter",
      grants: [{ capability: "requisitions.read", scope: "team" }],
    });
    await admin.assignMemberRole({ membershipId: M_OWN, roleKey: "own_viewer" });
    await admin.assignMemberRole({ membershipId: M_TEAM, roleKey: "team_viewer" });
    // OWN is R_A's primary recruiter.
    assert.deepEqual(await reqIds(U_OWN, ["recruiter"]), [R_A]);
    // TEAM owns nothing, but HM_A (R_A's hiring manager) reports to them.
    assert.deepEqual(await reqIds(U_TEAM, ["recruiter"]), [R_A]);
  });

  it("scope semantics already in the code keep working through the bundles (HM insights = own)", async () => {
    // A system hiring manager's owner_insights scope is `own`; admin's is `all`.
    const hm = await caller(U_HM_A, ["hiring_manager"]).getMyPermissions({});
    assert.equal(hm.caps["requisitions.owner_insights"], "own");
    const ad = await caller(U_ADMIN, ["admin"]).getMyPermissions({});
    assert.equal(ad.caps["requisitions.owner_insights"], "all");
  });

  // ─────────────────────────── guards ───────────────────────────

  it("no privilege escalation, lock-out guard, deactivation guard, validation", async () => {
    const admin = caller(U_ADMIN, ["admin"]);
    // A role admin who lacks a capability can't grant it. Give ADMIN2 a custom
    // role that may define roles but lacks the comp desk.
    await admin.upsertCustomRole({
      key: "role_admin",
      label: "Role admin",
      baseRole: "admin",
      grants: [
        { capability: "admin.roles", scope: "all" },
        { capability: "admin.users", scope: "all" },
        { capability: "reports.read", scope: "all" },
      ],
    });
    await admin.assignMemberRole({ membershipId: M_ADMIN2, roleKey: "role_admin" });
    const ra = caller(U_ADMIN2, ["admin"]);
    await expectTrpc(
      ra.upsertCustomRole({
        key: "sneaky",
        label: "Sneaky",
        baseRole: "recruiter",
        grants: [{ capability: "offers.comp_desk", scope: "all" }],
      }),
      "FORBIDDEN",
      "hold yourself",
    );
    // …nor assign a role whose bundle exceeds theirs (ta_lead has partners.admin).
    await expectTrpc(
      ra.assignMemberRole({ membershipId: M_REC, roleKey: "ta_lead" }),
      "FORBIDDEN",
      "hold yourself",
    );
    // Lock-out guard: can't move yourself to a role without admin.users (the
    // role is within your own grants, so it is the lock-out rule that fires).
    await admin.upsertCustomRole({
      key: "reports_only",
      label: "Reports only",
      baseRole: "hr_ops",
      grants: [{ capability: "reports.read", scope: "all" }],
    });
    await expectTrpc(
      ra.assignMemberRole({ membershipId: M_ADMIN2, roleKey: "reports_only" }),
      "BAD_REQUEST",
      "your own user administration",
    );
    // Deactivating a role members hold is refused; an unused one deactivates.
    await expectTrpc(admin.setCustomRoleActive({ key: "ta_lead", active: false }), "BAD_REQUEST");
    await admin.upsertCustomRole({
      key: "unused_x",
      label: "Unused",
      baseRole: "recruiter",
      grants: [],
    });
    await admin.setCustomRoleActive({ key: "unused_x", active: false });
    // Scope must be one the capability allows; system keys are refused.
    await expectTrpc(
      admin.upsertCustomRole({
        key: "bad_scope",
        label: "Bad",
        baseRole: "recruiter",
        grants: [{ capability: "settings.branding", scope: "own" }],
      }),
      "BAD_REQUEST",
    );
    await expectTrpc(
      admin.upsertCustomRole({ key: "admin", label: "x", baseRole: "admin", grants: [] }),
      "BAD_REQUEST",
    );
    // A member on a custom role can't have their system roles edited directly.
    await expectTrpc(
      admin.updateMembershipRoles({ membershipId: M_TA, roles: ["recruiter"] }),
      "BAD_REQUEST",
      "custom role",
    );
    // Back to system roles restores the base-role bundle.
    await admin.assignMemberRole({ membershipId: M_OWN, roleKey: null });
    assert.deepEqual(await reqIds(U_OWN, ["recruiter"]), [R_A, R_B].sort());
    // Writes are audited (api_audit_logs intent rows).
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.api_audit_logs
       WHERE tenant_id = ${T} AND action IN ('upsert_custom_role','assign_member_role','set_custom_role_active')
    `;
    // withAudit is fire-and-forget; give it a moment.
    await new Promise((r) => setTimeout(r, 300));
    const [n2] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.api_audit_logs
       WHERE tenant_id = ${T} AND action IN ('upsert_custom_role','assign_member_role','set_custom_role_active')
    `;
    assert.ok((n2?.n ?? n?.n ?? 0) > 5, `audit rows: ${n2?.n}`);
    const [trig] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.audit_logs
       WHERE tenant_id = ${T} AND entity_type IN ('tenant_roles','role_capabilities')
    `;
    assert.ok((trig?.n ?? 0) > 0, "audit trigger rows for role tables");
  });

  // ─────────────────────────── tenant isolation ───────────────────────────

  it("RLS isolates role tables; capabilities never reach another tenant", async () => {
    // Under the authenticated role with T2 claims, T's roles are invisible.
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE authenticated`);
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: U_T2_ADMIN, tid: T2, roles: ["admin"] })}, true)`;
      return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM public.tenant_roles`;
    });
    assert.equal(rows[0]?.n, 0);
    // T2's admin sees only system roles (no T custom roles leak through the API).
    const t2 = caller(U_T2_ADMIN, ["admin"], T2);
    const list = await t2.listRoles({});
    assert.ok(list.roles.every((r) => r.isSystem));
    // …and cannot assign a T role to a T membership id.
    await expectTrpc(t2.assignMemberRole({ membershipId: M_REC, roleKey: "ta_lead" }), "NOT_FOUND");
    // A T requisition is invisible to T2 whatever its capabilities.
    assert.deepEqual(
      (await t2.listMyRequisitionsV2({ limit: 100 })).rows.map((r) => r.id),
      [],
    );
  });

  // ─────────────────────────── export / import ───────────────────────────

  it("roles export → import round-trips into another tenant (no assignments exported)", async () => {
    const admin = caller(U_ADMIN, ["admin"]);
    const { document } = await admin.exportTenantConfig({});
    const exported = document.sections.roles ?? [];
    const keys = exported.map((r) => r.key).sort();
    assert.ok(keys.includes("ta_lead") && keys.includes("fin_viewer"));
    assert.ok(!JSON.stringify(document).includes(M_TA), "no membership ids in the export");
    const ta = exported.find((r) => r.key === "ta_lead");
    assert.equal(ta?.baseRole, "hr_head");

    const t2 = caller(U_T2_ADMIN, ["admin"], T2);
    const preview = await t2.previewTenantConfigImport({
      document: { ...document, sections: { roles: exported } },
    });
    const rolesDiff = preview.diff.find((d) => d.section === "roles");
    assert.ok(rolesDiff && rolesDiff.adds.length === exported.length);
    await t2.applyTenantConfigImport({
      document: { ...document, sections: { roles: exported } },
      fingerprint: preview.fingerprint ?? "missing-fingerprint",
    });
    const after = await t2.listRoles({});
    const t2ta = after.roles.find((r) => r.key === "ta_lead" && !r.isSystem);
    assert.deepEqual(t2ta?.grants.map((g) => g.capability).sort(), [
      "partners.admin",
      "reports.read",
      "requisitions.read",
    ]);
    // Re-export of T2 equals the imported section.
    const again = await t2.exportTenantConfig({});
    assert.deepEqual(
      (again.document.sections.roles ?? []).map((r) => [r.key, r.grants.length]),
      exported.map((r) => [r.key, r.grants.length]),
    );
  });
});
