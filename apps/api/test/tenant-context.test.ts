/**
 * Tenant-context + RLS integration verification.
 *
 * Covers, end to end through the Hono app + withTenantContext:
 *
 * FND-15e:
 *   1. no Authorization header → 401 (reason: "missing")
 *   2. malformed Bearer token → 401
 *   3. valid JWT → 200, /test/whoami returns tenantId/userId/roles
 *   4. RLS scoping → /test/tenants returns exactly 1 row for the test user
 *   5. Worker-side parity → withTenantContext called directly yields the
 *      same single-tenant view as the HTTP path
 *
 * DB-01:
 *   6. public.users RLS — the user sees only their own profile row
 *   7. public.business_units RLS — tenant isolation; the test user sees
 *      only the kyndryl-poc business unit, not the one in a synthetic
 *      second tenant
 *
 * Test user comes from FND-15b: test-fnd15b@hireops-dev.local with the
 * fnd15b-test-password-do-not-reuse password. The auth hook stamps
 * tid + tenant_slug + roles into the JWT at issuance time.
 */

import "../src/bootstrap";

import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import {
  sql as poolSql,
  db,
  withTenantContext,
  drizzleSql,
  users,
  businessUnits,
  tenantUserMemberships,
  positions,
  jdVersions,
  jdSkills,
  type JwtClaims,
} from "@hireops/db";
import { eq } from "drizzle-orm";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Synthetic second tenant for test 7. Fixed UUID + slug so cleanup-then-
// create is reliable across re-runs.
const SYNTH_TENANT_ID = "00000000-0000-0000-0000-000000db0107";
const SYNTH_TENANT_SLUG = "synth-db01-test";

// Separate synthetic tenant for test 8 (Drizzle round-trip).
const ROUNDTRIP_TENANT_ID = "00000000-0000-0000-0000-000000db0108";
const ROUNDTRIP_TENANT_SLUG = "synth-roundtrip";

// DB-02a synthetic tenant + BUs for tests 9-10.
const DB02A_SYNTH_TENANT_ID = "00000000-0000-0000-0000-000000db02a1";
const DB02A_SYNTH_BU_ID = "00000000-0000-0000-0000-000000db02a2";
const DB02A_OWN_BU_ID = "00000000-0000-0000-0000-000000db02a3";
const DB02A_JD_BU_ID = "00000000-0000-0000-0000-000000db02b1";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error("Required env: SUPABASE_URL, SUPABASE_ANON_KEY (set in workspace-root .env)");
}

interface WhoamiResponse {
  tenantId: string;
  userId: string;
  roles: string[];
}

interface TenantsResponse {
  rows: { id: string; slug: string }[];
  count: number;
}

interface ErrorResponse {
  error: string;
  reason: string;
}

async function getTestJwt(): Promise<string> {
  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`Failed to sign in test user: ${error?.message}`);
  }
  return data.session.access_token;
}

async function run(): Promise<void> {
  console.log("Tenant-context + RLS integration tests starting...\n");

  // === Test 1: no JWT → 401 ===
  {
    const res = await app.request("/test/whoami");
    assert.equal(res.status, 401, "no JWT should return 401");
    const body = (await res.json()) as ErrorResponse;
    assert.equal(body.reason, "missing");
    console.log("  ✓ no JWT → 401 (reason: missing)");
  }

  // === Test 2: malformed JWT → 401 ===
  {
    const res = await app.request("/test/whoami", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    assert.equal(res.status, 401, "malformed JWT should return 401");
    const body = (await res.json()) as ErrorResponse;
    assert.ok(
      ["malformed", "invalid_signature"].includes(body.reason),
      `unexpected reason: ${body.reason}`,
    );
    console.log(`  ✓ malformed JWT → 401 (reason: ${body.reason})`);
  }

  // === Test 3: valid JWT → 200 with correct claims ===
  const jwt = await getTestJwt();
  const decodedClaims = decodeJwt(jwt) as JwtClaims;
  const testUserId = decodedClaims.sub!;
  const testTenantId = decodedClaims.tid!;
  {
    const res = await app.request("/test/whoami", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    assert.equal(res.status, 200, "valid JWT should return 200");
    const body = (await res.json()) as WhoamiResponse;
    assert.equal(typeof body.tenantId, "string");
    assert.equal(typeof body.userId, "string");
    assert.ok(Array.isArray(body.roles));
    assert.ok(body.roles.includes("admin"), "test user should have admin role");
    assert.equal(body.tenantId, decodedClaims.tid, "tenantId should match JWT tid claim");
    console.log(
      `  ✓ valid JWT → 200 (tenantId=${body.tenantId.slice(0, 8)}…, roles=[${body.roles.join(",")}])`,
    );
  }

  // === Test 4: RLS scoping — /test/tenants returns exactly 1 row ===
  {
    const res = await app.request("/test/tenants", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as TenantsResponse;
    assert.equal(body.count, 1, "RLS should scope to exactly 1 tenant");
    assert.equal(body.rows[0]?.slug, "kyndryl-poc");
    console.log(`  ✓ RLS scoping fires (1 tenant visible: ${body.rows[0]?.slug})`);
  }

  // === Test 5: worker-side withTenantContext parity ===
  {
    const result = await withTenantContext(decodedClaims, async ({ db }) => {
      return db.execute<{ id: string; slug: string }>(drizzleSql`SELECT id, slug FROM tenants`);
    });
    assert.equal(result.length, 1, "worker helper should see 1 tenant via RLS");
    assert.equal(result[0]?.slug, "kyndryl-poc");
    console.log("  ✓ withTenantContext worker pattern matches HTTP path");
  }

  // === Test 6: public.users RLS — self-row visible (DB-01) ===
  {
    // Setup runs as the postgres pool role (BYPASSRLS) because users has
    // no INSERT policy for `authenticated`. Idempotent across re-runs.
    await poolSql`
      INSERT INTO public.users (id, display_name)
      VALUES (${testUserId}, 'FND-15b Test User')
      ON CONFLICT (id) DO NOTHING
    `;

    const visible = await withTenantContext(decodedClaims, async ({ db }) => {
      return db.select().from(users);
    });
    assert.equal(visible.length, 1, "user sees exactly their own profile");
    assert.equal(visible[0]?.id, testUserId);
    console.log("  ✓ public.users RLS: self-row visible");
  }

  // === Test 7: business_units RLS — tenant isolation (DB-01) ===
  let cleanupSynthTenant = false;
  try {
    // Defensive pre-cleanup in case a prior run left rows.
    await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT_ID}`;

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${SYNTH_TENANT_ID}, ${SYNTH_TENANT_SLUG}, 'Synthetic DB-01 Test', 'ap-northeast-1', 'active')
    `;
    cleanupSynthTenant = true;

    await poolSql`
      INSERT INTO public.business_units (tenant_id, name, slug)
      VALUES
        (${testTenantId}, 'Bangalore GCC', 'bangalore-gcc'),
        (${SYNTH_TENANT_ID}, 'Should Not Be Visible', 'invisible')
      ON CONFLICT (tenant_id, slug) DO NOTHING
    `;

    const visible = await withTenantContext(decodedClaims, async ({ db }) => {
      return db.select().from(businessUnits);
    });
    assert.equal(visible.length, 1, "user sees exactly their own tenant's business units");
    assert.equal(visible[0]?.slug, "bangalore-gcc");
    console.log("  ✓ business_units RLS: tenant isolation");
  } finally {
    // The kyndryl-poc business_unit row stays around for later tests; the
    // synth tenant + its business_unit cascade-delete together.
    if (cleanupSynthTenant) {
      await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${testTenantId} AND slug = 'bangalore-gcc'`;
      await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT_ID}`;
    }
  }

  // === Test 8: Drizzle round-trip for tenant_user_memberships.roles ===
  // After DRIZZLE-INFRA-01, the roles column is modeled as tenantRoleEnum().array()
  // in the Drizzle schema. A normal Drizzle insert with roles: TenantRole[] must
  // round-trip through Postgres without manual ::tenant_role[] casts.
  let cleanupRoundtripTenant = false;
  try {
    await poolSql`DELETE FROM public.tenants WHERE id = ${ROUNDTRIP_TENANT_ID}`;
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${ROUNDTRIP_TENANT_ID}, ${ROUNDTRIP_TENANT_SLUG}, 'Roundtrip Test', 'ap-northeast-1', 'active')
    `;
    cleanupRoundtripTenant = true;

    // Drizzle insert with pgEnum-typed array — would have failed before
    // DRIZZLE-INFRA-01 with "text[] cannot be assigned to tenant_role[]".
    await db.insert(tenantUserMemberships).values({
      userId: testUserId,
      tenantId: ROUNDTRIP_TENANT_ID,
      roles: ["recruiter", "hiring_manager"],
      status: "active",
    });

    const rows = await db
      .select()
      .from(tenantUserMemberships)
      .where(eq(tenantUserMemberships.tenantId, ROUNDTRIP_TENANT_ID));

    assert.equal(rows.length, 1, "Drizzle select should return the inserted row");
    assert.deepEqual(
      [...(rows[0]?.roles ?? [])].sort(),
      ["hiring_manager", "recruiter"],
      "round-trip should preserve role values",
    );
    console.log("  ✓ Drizzle round-trip for tenant_role[] works");
  } finally {
    if (cleanupRoundtripTenant) {
      await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${ROUNDTRIP_TENANT_ID}`;
      await poolSql`DELETE FROM public.tenants WHERE id = ${ROUNDTRIP_TENANT_ID}`;
    }
  }

  // === Test 9: positions RLS — tenant isolation (DB-02a) ===
  let cleanupDb02aIsolation = false;
  try {
    // Defensive pre-cleanup in case a prior run died mid-test.
    await poolSql`DELETE FROM public.positions WHERE business_unit_id = ${DB02A_OWN_BU_ID}`;
    await poolSql`DELETE FROM public.business_units WHERE id = ${DB02A_OWN_BU_ID}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${DB02A_SYNTH_TENANT_ID}`;

    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${DB02A_SYNTH_TENANT_ID}, 'synth-db02a', 'Synth DB-02a', 'ap-northeast-1', 'active')
    `;
    cleanupDb02aIsolation = true;

    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES
        (${DB02A_SYNTH_BU_ID}, ${DB02A_SYNTH_TENANT_ID}, 'Synth BU', 'synth-bu'),
        (${DB02A_OWN_BU_ID}, ${testTenantId}, 'Test BU DB02a', 'test-bu-db02a')
    `;

    await poolSql`
      INSERT INTO public.positions (tenant_id, business_unit_id, title)
      VALUES
        (${DB02A_SYNTH_TENANT_ID}, ${DB02A_SYNTH_BU_ID}, 'Should Not Be Visible'),
        (${testTenantId}, ${DB02A_OWN_BU_ID}, 'Senior Backend Engineer')
    `;

    const visible = await withTenantContext(decodedClaims, async ({ db }) => {
      return db.select().from(positions);
    });

    const ourPositions = visible.filter((p) => p.businessUnitId === DB02A_OWN_BU_ID);
    assert.equal(ourPositions.length, 1, "sees own-tenant position");
    assert.equal(ourPositions[0]?.title, "Senior Backend Engineer");

    const leaked = visible.filter((p) => p.tenantId === DB02A_SYNTH_TENANT_ID);
    assert.equal(leaked.length, 0, "no cross-tenant leakage");

    console.log("  ✓ positions RLS: tenant isolation");
  } finally {
    if (cleanupDb02aIsolation) {
      // positions.business_unit_id is ON DELETE RESTRICT, so delete the
      // position rows in the own-tenant BU before dropping the BU itself.
      // The synth tenant's positions + BU cascade-delete with the tenant.
      await poolSql`DELETE FROM public.positions WHERE business_unit_id = ${DB02A_OWN_BU_ID}`;
      await poolSql`DELETE FROM public.business_units WHERE id = ${DB02A_OWN_BU_ID}`;
      await poolSql`DELETE FROM public.tenants WHERE id = ${DB02A_SYNTH_TENANT_ID}`;
    }
  }

  // === Test 10: JD version + skills round-trip through Drizzle (DB-02a) ===
  let cleanupDb02aJd = false;
  try {
    // Defensive pre-cleanup.
    await poolSql`DELETE FROM public.positions WHERE business_unit_id = ${DB02A_JD_BU_ID}`;
    await poolSql`DELETE FROM public.business_units WHERE id = ${DB02A_JD_BU_ID}`;

    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${DB02A_JD_BU_ID}, ${testTenantId}, 'JD Test BU', 'jd-test-bu')
    `;
    cleanupDb02aJd = true;

    const result = await withTenantContext(decodedClaims, async ({ db }) => {
      const [position] = await db
        .insert(positions)
        .values({
          tenantId: testTenantId,
          businessUnitId: DB02A_JD_BU_ID,
          title: "Test Position DB-02a",
          level: "L4",
          locationType: "hybrid",
        })
        .returning();
      if (!position) throw new Error("position insert returned no row");

      const [jd1] = await db
        .insert(jdVersions)
        .values({
          tenantId: testTenantId,
          positionId: position.id,
          versionNumber: 1,
          status: "draft",
          jdText: "Initial JD",
        })
        .returning();
      if (!jd1) throw new Error("jd_version insert returned no row");

      await db.insert(jdSkills).values([
        {
          tenantId: testTenantId,
          jdVersionId: jd1.id,
          skillName: "TypeScript",
          weight: "2.00",
          isRequired: true,
        },
        {
          tenantId: testTenantId,
          jdVersionId: jd1.id,
          skillName: "PostgreSQL",
          weight: "1.50",
          isRequired: true,
        },
      ]);

      const skills = await db.select().from(jdSkills).where(eq(jdSkills.jdVersionId, jd1.id));

      return { position, jd: jd1, skills };
    });

    assert.equal(result.skills.length, 2);
    assert.ok(
      result.skills.find((s) => s.skillName === "TypeScript"),
      "TypeScript skill round-tripped",
    );
    assert.ok(
      result.skills.find((s) => s.skillName === "PostgreSQL"),
      "PostgreSQL skill round-tripped",
    );
    console.log("  ✓ JD version + skills round-trip through Drizzle");
  } finally {
    if (cleanupDb02aJd) {
      // Deleting the BU cascades positions → jd_versions → jd_skills (the
      // BU FK is RESTRICT so we delete positions first).
      await poolSql`DELETE FROM public.positions WHERE business_unit_id = ${DB02A_JD_BU_ID}`;
      await poolSql`DELETE FROM public.business_units WHERE id = ${DB02A_JD_BU_ID}`;
    }
  }

  console.log("\n=========================================");
  console.log("Tenant-context + RLS verification: PASS");
  console.log("=========================================");
}

run()
  .then(() => {
    void poolSql.end({ timeout: 2 });
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nTenant-context + RLS verification: FAIL");
    console.error(err);
    void poolSql.end({ timeout: 2 });
    process.exit(1);
  });
