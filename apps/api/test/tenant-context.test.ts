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
 * Plus DB-02a / DB-02b / DB-TENANT-FK / FND-15d / DB-AUDIT / DB-03 (tests
 * 8-35). See the individual it() titles below.
 *
 * Test user comes from FND-15b: test-fnd15b@hireops-dev.local with the
 * fnd15b-test-password-do-not-reuse password. The auth hook stamps
 * tid + tenant_slug + roles into the JWT at issuance time.
 *
 * FND-TEST migration note: the suite is structured as one describe with
 * 35 sequential it() blocks (Vitest runs them in source order within a
 * file). Shared setup — auth, membership lookup, the DB-03 fixture chain
 * — lives in beforeAll. Tests retain their original try/finally for
 * per-test fixtures. Trailing teardowns live in afterAll, which also
 * drains the postgres-js pool so the next file (db-approval) starts
 * with a clean pooler.
 */

import "../src/bootstrap";

import { afterAll, beforeAll, describe, it } from "vitest";
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
  requisitions,
  requisitionKnockouts,
  requisitionStateTransitions,
  auditLogs,
  persons,
  candidates,
  applications,
  applicationStateTransitions,
  storeIntegrationCredential,
  getIntegrationCredential,
  getKmsClient,
  unwrapDek,
  decryptStringWithDek,
  type ApplicationSource,
  type ApplicationStage,
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

// DB-02b synthetic tenant + BUs for tests 11-13.
const DB02B_SYNTH_TENANT_ID = "00000000-0000-0000-0000-000000db02b2";
const DB02B_SYNTH_BU_ID = "00000000-0000-0000-0000-000000db02b3";
const DB02B_OWN_BU_ID = "00000000-0000-0000-0000-000000db02b4";

// FND-15d envelope encryption synthetic tenant for tests 15-17.
const FND15D_SYNTH_TENANT_ID = "00000000-0000-0000-0000-00000fd1015d";

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

// Hex-only suffixes (UUIDs only allow 0-9 and a-f). "adda" stands in for
// "audit-data-access" — pick whatever mnemonic fits; the digits are what
// matters. Declared at module scope so the pre-test cleanup below and the
// DB-AUDIT tests at the bottom share the same constants.
const AUDIT_BU_ID = "00000000-0000-0000-0000-0000adda0001";
const AUDIT_SYNTH_TENANT_ID = "00000000-0000-0000-0000-0000adda0002";
const AUDIT_SYNTH_BU_ID = "00000000-0000-0000-0000-0000adda0003";
const AUDIT_NOOP_BU_ID = "00000000-0000-0000-0000-0000adda0004";
const AUDIT_DIFF_BU_ID = "00000000-0000-0000-0000-0000adda0005";
const AUDIT_VARS_BU_ID = "00000000-0000-0000-0000-0000adda0006";
const AUDIT_MISSING_BU_ID = "00000000-0000-0000-0000-0000adda0007";
const AUDIT_PART_BU_ID = "00000000-0000-0000-0000-0000adda0008";

// DB-03 fixtures. Hex-only suffixes. "db03" namespace per ticket. Tests
// 26-35 share the own-tenant chain set up in beforeAll; per-test inserts
// (e.g. test 35's fresh person+candidate) use the *_B / *_C ids.
const DB03_SYNTH_TENANT_ID = "00000000-0000-0000-0000-0000db03ee01";
const DB03_OWN_BU_ID = "00000000-0000-0000-0000-0000db03ee02";
const DB03_OWN_POSITION_ID = "00000000-0000-0000-0000-0000db03ee03";
const DB03_OWN_JD_ID = "00000000-0000-0000-0000-0000db03ee04";
const DB03_OWN_REQ_ID = "00000000-0000-0000-0000-0000db03ee05";
const DB03_PERSON_A_ID = "00000000-0000-0000-0000-0000db03aa01";
const DB03_PERSON_B_ID = "00000000-0000-0000-0000-0000db03aa02";
const DB03_PERSON_C_ID = "00000000-0000-0000-0000-0000db03aa03";
const DB03_CANDIDATE_A_ID = "00000000-0000-0000-0000-0000db03ca01";
const DB03_CANDIDATE_B_ID = "00000000-0000-0000-0000-0000db03ca02";
const DB03_CANDIDATE_C_ID = "00000000-0000-0000-0000-0000db03ca03";
const DB03_APP_A_ID = "00000000-0000-0000-0000-0000db03ad01";
const DB03_APP_B_ID = "00000000-0000-0000-0000-0000db03ad02";
const DB03_APP_C_ID = "00000000-0000-0000-0000-0000db03ad03";

// Synth-tenant DB-03 chain (used by tests 26-27 for cross-tenant isolation
// + compound-FK rejection). Lifted to module scope so beforeAll can
// populate them and the individual tests can reference them.
const DB03_SYNTH_BU_ID = "00000000-0000-0000-0000-0000db03ef02";
const DB03_SYNTH_POSITION_ID = "00000000-0000-0000-0000-0000db03ef03";
const DB03_SYNTH_JD_ID = "00000000-0000-0000-0000-0000db03ef04";
const DB03_SYNTH_REQ_ID = "00000000-0000-0000-0000-0000db03ef05";
const DB03_SYNTH_MEMBERSHIP_ID = "00000000-0000-0000-0000-0000db03ef06";
const DB03_SYNTH_PERSON_ID = "00000000-0000-0000-0000-0000db03ef07";
const DB03_SYNTH_CANDIDATE_ID = "00000000-0000-0000-0000-0000db03ef08";
const DB03_SYNTH_APP_ID = "00000000-0000-0000-0000-0000db03ef09";
const DB03_SYNTH_TRANSITION_ID = "00000000-0000-0000-0000-0000db03ef10";
const DB03_OWN_TRANSITION_ID = "00000000-0000-0000-0000-0000db03fa01";

// All the IDs the pre-cleanup needs to touch. Order matters at delete time:
// children before parents.
const DB03_APPLICATION_IDS = [DB03_APP_A_ID, DB03_APP_B_ID, DB03_APP_C_ID];
const DB03_CANDIDATE_IDS = [DB03_CANDIDATE_A_ID, DB03_CANDIDATE_B_ID, DB03_CANDIDATE_C_ID];
const DB03_PERSON_IDS = [DB03_PERSON_A_ID, DB03_PERSON_B_ID, DB03_PERSON_C_ID];
const DB03_AUDIT_ENTITY_IDS = [
  ...DB03_PERSON_IDS,
  ...DB03_CANDIDATE_IDS,
  ...DB03_APPLICATION_IDS,
  DB03_OWN_REQ_ID,
  DB03_OWN_JD_ID,
  DB03_OWN_POSITION_ID,
  DB03_OWN_BU_ID,
];

// Shared state populated by beforeAll. `let` because the values are filled
// in asynchronously before any it() runs.
let jwt: string;
let decodedClaims: JwtClaims;
let testUserId: string;
let testTenantId: string;
let testMembershipId: string;

describe("tenant-context + RLS integration", () => {
  beforeAll(async () => {
    // Pre-clean any business_units / audit_logs / tenants left from a prior
    // aborted DB-AUDIT or DB-03 run. We zap BOTH namespaces here because
    // the previous test runner used separate files; we still want to
    // recover from any leftover state.
    await poolSql`DELETE FROM public.audit_logs WHERE entity_id IN (${AUDIT_BU_ID}, ${AUDIT_NOOP_BU_ID}, ${AUDIT_DIFF_BU_ID}, ${AUDIT_VARS_BU_ID}, ${AUDIT_MISSING_BU_ID}, ${AUDIT_PART_BU_ID}, ${AUDIT_SYNTH_BU_ID})`;
    await poolSql`DELETE FROM public.business_units WHERE id IN (${AUDIT_BU_ID}, ${AUDIT_NOOP_BU_ID}, ${AUDIT_DIFF_BU_ID}, ${AUDIT_VARS_BU_ID}, ${AUDIT_MISSING_BU_ID}, ${AUDIT_PART_BU_ID}, ${AUDIT_SYNTH_BU_ID})`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${AUDIT_SYNTH_TENANT_ID}`;

    await poolSql`DELETE FROM public.audit_logs WHERE entity_id = ANY(${DB03_AUDIT_ENTITY_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${DB03_APPLICATION_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.applications WHERE id = ANY(${DB03_APPLICATION_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.candidates WHERE id = ANY(${DB03_CANDIDATE_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.persons WHERE id = ANY(${DB03_PERSON_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${DB03_OWN_REQ_ID}`;
    await poolSql`DELETE FROM public.requisitions WHERE id = ${DB03_OWN_REQ_ID}`;
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${DB03_OWN_JD_ID}`;
    await poolSql`DELETE FROM public.positions WHERE id = ${DB03_OWN_POSITION_ID}`;
    await poolSql`DELETE FROM public.business_units WHERE id = ${DB03_OWN_BU_ID}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${DB03_SYNTH_TENANT_ID}`;

    // JWT auth + claim decode.
    jwt = await getTestJwt();
    decodedClaims = decodeJwt(jwt) as JwtClaims;
    testUserId = decodedClaims.sub!;
    testTenantId = decodedClaims.tid!;

    const [membership] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.tenant_user_memberships
      WHERE user_id = ${testUserId} AND tenant_id = ${testTenantId}
      LIMIT 1
    `;
    if (!membership) {
      throw new Error("test user has no membership in its tenant — fixture broken");
    }
    testMembershipId = membership.id;
  });

  afterAll(async () => {
    // DB-AUDIT teardown — drop the BUs / synth tenant created by tests 18-25.
    await poolSql`DELETE FROM public.audit_logs WHERE entity_id IN (${AUDIT_BU_ID}, ${AUDIT_NOOP_BU_ID}, ${AUDIT_DIFF_BU_ID}, ${AUDIT_VARS_BU_ID}, ${AUDIT_MISSING_BU_ID}, ${AUDIT_PART_BU_ID}, ${AUDIT_SYNTH_BU_ID})`;
    await poolSql`DELETE FROM public.business_units WHERE id IN (${AUDIT_NOOP_BU_ID}, ${AUDIT_DIFF_BU_ID}, ${AUDIT_VARS_BU_ID}, ${AUDIT_MISSING_BU_ID}, ${AUDIT_PART_BU_ID})`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${AUDIT_SYNTH_TENANT_ID}`;
  });

  it("Test 1: no JWT → 401 (reason: missing)", async () => {
    const res = await app.request("/test/whoami");
    assert.equal(res.status, 401, "no JWT should return 401");
    const body = (await res.json()) as ErrorResponse;
    assert.equal(body.reason, "missing");
  });

  it("Test 2: malformed JWT → 401", async () => {
    const res = await app.request("/test/whoami", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    assert.equal(res.status, 401, "malformed JWT should return 401");
    const body = (await res.json()) as ErrorResponse;
    assert.ok(
      ["malformed", "invalid_signature"].includes(body.reason),
      `unexpected reason: ${body.reason}`,
    );
  });

  it("Test 3: valid JWT → 200 with correct claims", async () => {
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
  });

  it("Test 4: RLS scoping — /test/tenants returns exactly 1 row", async () => {
    const res = await app.request("/test/tenants", {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as TenantsResponse;
    assert.equal(body.count, 1, "RLS should scope to exactly 1 tenant");
    assert.equal(body.rows[0]?.slug, "kyndryl-poc");
  });

  it("Test 5: worker-side withTenantContext parity", async () => {
    const result = await withTenantContext(decodedClaims, async ({ db }) => {
      return db.execute<{ id: string; slug: string }>(drizzleSql`SELECT id, slug FROM tenants`);
    });
    assert.equal(result.length, 1, "worker helper should see 1 tenant via RLS");
    assert.equal(result[0]?.slug, "kyndryl-poc");
  });

  it("Test 6: public.users RLS — self-row visible (DB-01)", async () => {
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
  });

  it("Test 7: business_units RLS — tenant isolation (DB-01)", async () => {
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
    } finally {
      if (cleanupSynthTenant) {
        await poolSql`DELETE FROM public.business_units WHERE tenant_id = ${testTenantId} AND slug = 'bangalore-gcc'`;
        await poolSql`DELETE FROM public.tenants WHERE id = ${SYNTH_TENANT_ID}`;
      }
    }
  });

  it("Test 8: Drizzle round-trip for tenant_user_memberships.roles", async () => {
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
    } finally {
      if (cleanupRoundtripTenant) {
        await poolSql`DELETE FROM public.tenant_user_memberships WHERE tenant_id = ${ROUNDTRIP_TENANT_ID}`;
        await poolSql`DELETE FROM public.tenants WHERE id = ${ROUNDTRIP_TENANT_ID}`;
      }
    }
  });

  it("Test 9: positions RLS — tenant isolation (DB-02a)", async () => {
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
  });

  it("Test 10: JD version + skills round-trip through Drizzle (DB-02a)", async () => {
    let cleanupDb02aJd = false;
    try {
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
    } finally {
      if (cleanupDb02aJd) {
        await poolSql`DELETE FROM public.positions WHERE business_unit_id = ${DB02A_JD_BU_ID}`;
        await poolSql`DELETE FROM public.business_units WHERE id = ${DB02A_JD_BU_ID}`;
      }
    }
  });

  it("Test 11: requisitions RLS — tenant isolation (DB-02b)", async () => {
    const SYNTH_MEMBERSHIP_ID = "00000000-0000-0000-0000-0000000201c1";
    let cleanupDb02bIsolation = false;
    try {
      await poolSql`DELETE FROM public.requisition_state_transitions WHERE tenant_id IN (${testTenantId}, ${DB02B_SYNTH_TENANT_ID})`;
      await poolSql`DELETE FROM public.requisitions WHERE tenant_id IN (${testTenantId}, ${DB02B_SYNTH_TENANT_ID}) AND id IN (SELECT r.id FROM public.requisitions r JOIN public.positions p ON r.position_id = p.id WHERE p.business_unit_id IN (${DB02B_OWN_BU_ID}, ${DB02B_SYNTH_BU_ID}))`;
      await poolSql`DELETE FROM public.jd_versions WHERE position_id IN (SELECT id FROM public.positions WHERE business_unit_id IN (${DB02B_OWN_BU_ID}, ${DB02B_SYNTH_BU_ID}))`;
      await poolSql`DELETE FROM public.positions WHERE business_unit_id IN (${DB02B_OWN_BU_ID}, ${DB02B_SYNTH_BU_ID})`;
      await poolSql`DELETE FROM public.business_units WHERE id = ${DB02B_OWN_BU_ID}`;
      await poolSql`DELETE FROM public.tenant_user_memberships WHERE id = ${SYNTH_MEMBERSHIP_ID}`;
      await poolSql`DELETE FROM public.tenants WHERE id = ${DB02B_SYNTH_TENANT_ID}`;

      await poolSql`
        INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
        VALUES (${DB02B_SYNTH_TENANT_ID}, 'synth-db02b', 'Synth DB-02b', 'ap-northeast-1', 'active')
      `;
      cleanupDb02bIsolation = true;

      await poolSql`
        INSERT INTO public.business_units (id, tenant_id, name, slug)
        VALUES
          (${DB02B_SYNTH_BU_ID}, ${DB02B_SYNTH_TENANT_ID}, 'Synth BU', 'synth-bu-02b'),
          (${DB02B_OWN_BU_ID}, ${testTenantId}, 'Test BU DB02b', 'test-bu-db02b')
      `;

      await poolSql`
        INSERT INTO public.tenant_user_memberships
          (id, user_id, tenant_id, roles, status, accepted_at)
        VALUES (${SYNTH_MEMBERSHIP_ID}, ${testUserId}, ${DB02B_SYNTH_TENANT_ID}, ARRAY['admin']::tenant_role[], 'active', now())
      `;

      const synthPositionId = "00000000-0000-0000-0000-0000000201a1";
      const ownPositionId = "00000000-0000-0000-0000-0000000201a2";
      const synthJdId = "00000000-0000-0000-0000-0000000201b1";
      const ownJdId = "00000000-0000-0000-0000-0000000201b2";

      await poolSql`
        INSERT INTO public.positions (id, tenant_id, business_unit_id, title)
        VALUES
          (${synthPositionId}, ${DB02B_SYNTH_TENANT_ID}, ${DB02B_SYNTH_BU_ID}, 'Synth Position'),
          (${ownPositionId}, ${testTenantId}, ${DB02B_OWN_BU_ID}, 'Own Position')
      `;

      await poolSql`
        INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text)
        VALUES
          (${synthJdId}, ${DB02B_SYNTH_TENANT_ID}, ${synthPositionId}, 1, 'synth JD'),
          (${ownJdId}, ${testTenantId}, ${ownPositionId}, 1, 'own JD')
      `;

      await poolSql`
        INSERT INTO public.requisitions
          (tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
        VALUES
          (${DB02B_SYNTH_TENANT_ID}, ${synthPositionId}, ${synthJdId}, ${SYNTH_MEMBERSHIP_ID}, ${SYNTH_MEMBERSHIP_ID}, 'draft'),
          (${testTenantId}, ${ownPositionId}, ${ownJdId}, ${testMembershipId}, ${testMembershipId}, 'draft')
      `;

      const visible = await withTenantContext(decodedClaims, async ({ db }) => {
        return db.select().from(requisitions);
      });

      const ourReqs = visible.filter((r) => r.positionId === ownPositionId);
      assert.equal(ourReqs.length, 1, "sees own-tenant requisition");
      const leaked = visible.filter((r) => r.tenantId === DB02B_SYNTH_TENANT_ID);
      assert.equal(leaked.length, 0, "no cross-tenant requisition leakage");
    } finally {
      if (cleanupDb02bIsolation) {
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE tenant_id IN (${testTenantId}, ${DB02B_SYNTH_TENANT_ID})`;
        await poolSql`DELETE FROM public.requisitions WHERE tenant_id IN (${testTenantId}, ${DB02B_SYNTH_TENANT_ID}) AND id IN (SELECT r.id FROM public.requisitions r JOIN public.positions p ON r.position_id = p.id WHERE p.business_unit_id IN (${DB02B_OWN_BU_ID}, ${DB02B_SYNTH_BU_ID}))`;
        await poolSql`DELETE FROM public.jd_versions WHERE position_id IN (SELECT id FROM public.positions WHERE business_unit_id IN (${DB02B_OWN_BU_ID}, ${DB02B_SYNTH_BU_ID}))`;
        await poolSql`DELETE FROM public.positions WHERE business_unit_id IN (${DB02B_OWN_BU_ID}, ${DB02B_SYNTH_BU_ID})`;
        await poolSql`DELETE FROM public.business_units WHERE id = ${DB02B_OWN_BU_ID}`;
        await poolSql`DELETE FROM public.tenant_user_memberships WHERE id = ${SYNTH_MEMBERSHIP_ID}`;
        await poolSql`DELETE FROM public.tenants WHERE id = ${DB02B_SYNTH_TENANT_ID}`;
      }
    }
  });

  it("Test 12: append-only state transitions (DB-02b)", async () => {
    const APPEND_BU_ID = "00000000-0000-0000-0000-0000000202a1";
    const APPEND_POSITION_ID = "00000000-0000-0000-0000-0000000202a2";
    const APPEND_JD_ID = "00000000-0000-0000-0000-0000000202a3";
    const APPEND_REQ_ID = "00000000-0000-0000-0000-0000000202a4";
    let cleanupAppendOnly = false;
    try {
      await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${APPEND_REQ_ID}`;
      await poolSql`DELETE FROM public.requisitions WHERE id = ${APPEND_REQ_ID}`;
      await poolSql`DELETE FROM public.jd_versions WHERE id = ${APPEND_JD_ID}`;
      await poolSql`DELETE FROM public.positions WHERE id = ${APPEND_POSITION_ID}`;
      await poolSql`DELETE FROM public.business_units WHERE id = ${APPEND_BU_ID}`;

      await poolSql`
        INSERT INTO public.business_units (id, tenant_id, name, slug)
        VALUES (${APPEND_BU_ID}, ${testTenantId}, 'Append-Only BU', 'append-only-bu')
      `;
      cleanupAppendOnly = true;
      await poolSql`
        INSERT INTO public.positions (id, tenant_id, business_unit_id, title)
        VALUES (${APPEND_POSITION_ID}, ${testTenantId}, ${APPEND_BU_ID}, 'Append Test Position')
      `;
      await poolSql`
        INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text)
        VALUES (${APPEND_JD_ID}, ${testTenantId}, ${APPEND_POSITION_ID}, 1, 'append JD')
      `;
      await poolSql`
        INSERT INTO public.requisitions
          (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
        VALUES (${APPEND_REQ_ID}, ${testTenantId}, ${APPEND_POSITION_ID}, ${APPEND_JD_ID}, ${testMembershipId}, ${testMembershipId}, 'draft')
      `;

      const inserted = await withTenantContext(decodedClaims, async ({ db }) => {
        return db
          .insert(requisitionStateTransitions)
          .values({
            tenantId: testTenantId,
            requisitionId: APPEND_REQ_ID,
            fromStatus: null,
            toStatus: "draft",
            transitionedBy: testMembershipId,
            reason: "initial creation",
          })
          .returning();
      });
      assert.equal(inserted.length, 1, "INSERT into state_transitions allowed");
      const transitionId = inserted[0]!.id;

      const selected = await withTenantContext(decodedClaims, async ({ db }) => {
        return db
          .select()
          .from(requisitionStateTransitions)
          .where(eq(requisitionStateTransitions.id, transitionId));
      });
      assert.equal(selected.length, 1, "SELECT from state_transitions returns the row");
      assert.equal(selected[0]?.toStatus, "draft");

      const updated = await withTenantContext(decodedClaims, async ({ db }) => {
        return db
          .update(requisitionStateTransitions)
          .set({ reason: "tampered" })
          .where(eq(requisitionStateTransitions.id, transitionId))
          .returning();
      });
      assert.equal(updated.length, 0, "UPDATE on state_transitions blocked by RLS");

      const deleted = await withTenantContext(decodedClaims, async ({ db }) => {
        return db
          .delete(requisitionStateTransitions)
          .where(eq(requisitionStateTransitions.id, transitionId))
          .returning();
      });
      assert.equal(deleted.length, 0, "DELETE on state_transitions blocked by RLS");

      const reread = await withTenantContext(decodedClaims, async ({ db }) => {
        return db
          .select()
          .from(requisitionStateTransitions)
          .where(eq(requisitionStateTransitions.id, transitionId));
      });
      assert.equal(reread.length, 1, "row still present after blocked UPDATE/DELETE");
      assert.equal(reread[0]?.reason, "initial creation", "reason unchanged");
    } finally {
      if (cleanupAppendOnly) {
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${APPEND_REQ_ID}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${APPEND_REQ_ID}`;
        await poolSql`DELETE FROM public.jd_versions WHERE id = ${APPEND_JD_ID}`;
        await poolSql`DELETE FROM public.positions WHERE id = ${APPEND_POSITION_ID}`;
        await poolSql`DELETE FROM public.business_units WHERE id = ${APPEND_BU_ID}`;
      }
    }
  });

  it("Test 13: knockout ordering + threshold_value JSONB round-trip (DB-02b)", async () => {
    const KO_BU_ID = "00000000-0000-0000-0000-0000000203a1";
    const KO_POSITION_ID = "00000000-0000-0000-0000-0000000203a2";
    const KO_JD_ID = "00000000-0000-0000-0000-0000000203a3";
    const KO_REQ_ID = "00000000-0000-0000-0000-0000000203a4";
    let cleanupKnockouts = false;
    try {
      await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${KO_REQ_ID}`;
      await poolSql`DELETE FROM public.requisitions WHERE id = ${KO_REQ_ID}`;
      await poolSql`DELETE FROM public.jd_versions WHERE id = ${KO_JD_ID}`;
      await poolSql`DELETE FROM public.positions WHERE id = ${KO_POSITION_ID}`;
      await poolSql`DELETE FROM public.business_units WHERE id = ${KO_BU_ID}`;

      await poolSql`
        INSERT INTO public.business_units (id, tenant_id, name, slug)
        VALUES (${KO_BU_ID}, ${testTenantId}, 'Knockout BU', 'knockout-bu')
      `;
      cleanupKnockouts = true;
      await poolSql`
        INSERT INTO public.positions (id, tenant_id, business_unit_id, title)
        VALUES (${KO_POSITION_ID}, ${testTenantId}, ${KO_BU_ID}, 'Knockout Test Position')
      `;
      await poolSql`
        INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text)
        VALUES (${KO_JD_ID}, ${testTenantId}, ${KO_POSITION_ID}, 1, 'knockout JD')
      `;
      await poolSql`
        INSERT INTO public.requisitions
          (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
        VALUES (${KO_REQ_ID}, ${testTenantId}, ${KO_POSITION_ID}, ${KO_JD_ID}, ${testMembershipId}, ${testMembershipId}, 'draft')
      `;

      const ordered = await withTenantContext(decodedClaims, async ({ db }) => {
        await db.insert(requisitionKnockouts).values([
          {
            tenantId: testTenantId,
            requisitionId: KO_REQ_ID,
            questionText: "Do you have a valid work permit?",
            type: "boolean",
            thresholdValue: { required: true },
            source: "candidate_asserted",
            orderIndex: 0,
          },
          {
            tenantId: testTenantId,
            requisitionId: KO_REQ_ID,
            questionText: "Years of experience?",
            type: "numeric_min",
            thresholdValue: { min: 5 },
            source: "parsed_cv",
            orderIndex: 1,
          },
          {
            tenantId: testTenantId,
            requisitionId: KO_REQ_ID,
            questionText: "Preferred location?",
            type: "enum",
            thresholdValue: { allowed: ["Bangalore", "Hyderabad"] },
            source: "candidate_asserted",
            orderIndex: 2,
          },
        ]);

        return db
          .select()
          .from(requisitionKnockouts)
          .where(eq(requisitionKnockouts.requisitionId, KO_REQ_ID))
          .orderBy(requisitionKnockouts.orderIndex);
      });

      assert.equal(ordered.length, 3, "three knockouts round-trip");
      assert.deepEqual(
        ordered.map((k) => k.orderIndex),
        [0, 1, 2],
        "ordering preserved",
      );
      assert.equal(ordered[0]?.type, "boolean");
      assert.equal(ordered[1]?.type, "numeric_min");
      assert.equal(ordered[2]?.type, "enum");
      assert.deepEqual(ordered[0]?.thresholdValue, { required: true });
      assert.deepEqual(ordered[1]?.thresholdValue, { min: 5 });
      assert.deepEqual(ordered[2]?.thresholdValue, {
        allowed: ["Bangalore", "Hyderabad"],
      });
    } finally {
      if (cleanupKnockouts) {
        await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${KO_REQ_ID}`;
        await poolSql`DELETE FROM public.requisitions WHERE id = ${KO_REQ_ID}`;
        await poolSql`DELETE FROM public.jd_versions WHERE id = ${KO_JD_ID}`;
        await poolSql`DELETE FROM public.positions WHERE id = ${KO_POSITION_ID}`;
        await poolSql`DELETE FROM public.business_units WHERE id = ${KO_BU_ID}`;
      }
    }
  });

  it("Test 14: compound FK rejects cross-tenant reference (DB-TENANT-FK)", async () => {
    const FK_SYNTH_TENANT_ID = "00000000-0000-0000-0000-0000000204a1";
    const FK_SYNTH_BU_ID = "00000000-0000-0000-0000-0000000204a2";
    let cleanupFkTest = false;
    try {
      await poolSql`DELETE FROM public.business_units WHERE id = ${FK_SYNTH_BU_ID}`;
      await poolSql`DELETE FROM public.tenants WHERE id = ${FK_SYNTH_TENANT_ID}`;
      await poolSql`
        INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
        VALUES (${FK_SYNTH_TENANT_ID}, 'synth-fk-test', 'Synth FK Test', 'ap-northeast-1', 'active')
      `;
      cleanupFkTest = true;
      await poolSql`
        INSERT INTO public.business_units (id, tenant_id, name, slug)
        VALUES (${FK_SYNTH_BU_ID}, ${FK_SYNTH_TENANT_ID}, 'Synth FK BU', 'synth-fk-bu')
      `;

      let threwAsExpected = false;
      let errorMessage = "";
      try {
        await poolSql`
          INSERT INTO public.positions (tenant_id, business_unit_id, title)
          VALUES (${testTenantId}, ${FK_SYNTH_BU_ID}, 'Cross-Tenant Forbidden')
        `;
      } catch (err: unknown) {
        threwAsExpected = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      assert.ok(threwAsExpected, "cross-tenant insert should throw a FK violation");
      assert.match(
        errorMessage,
        /foreign key|violates|fk_positions_business_unit/i,
        `unexpected error message: ${errorMessage}`,
      );

      const leaked = await poolSql<{ id: string }[]>`
        SELECT id FROM public.positions
        WHERE tenant_id = ${testTenantId} AND business_unit_id = ${FK_SYNTH_BU_ID}
      `;
      assert.equal(leaked.length, 0, "no cross-tenant position row exists");
    } finally {
      if (cleanupFkTest) {
        await poolSql`DELETE FROM public.business_units WHERE id = ${FK_SYNTH_BU_ID}`;
        await poolSql`DELETE FROM public.tenants WHERE id = ${FK_SYNTH_TENANT_ID}`;
      }
    }
  });

  it("Test 15: envelope encryption round-trip (FND-15d)", async () => {
    const TEST_SECRET = "wd-tenant-secret-do-not-leak-12345";
    const TEST_METADATA = {
      tenant_url: "https://wd-impl.workday.com/test",
      client_id: "wd-client-id-abc",
      scopes: ["read:positions", "write:applications"],
    };
    try {
      await storeIntegrationCredential({
        tenantId: testTenantId,
        integrationType: "workday",
        secret: TEST_SECRET,
        metadata: TEST_METADATA,
      });

      const got = await getIntegrationCredential({
        tenantId: testTenantId,
        integrationType: "workday",
      });
      assert.ok(got, "credential found");
      assert.equal(got.secret, TEST_SECRET, "secret round-trips");
      assert.deepEqual(got.metadata, TEST_METADATA, "metadata round-trips");
    } finally {
      await poolSql`DELETE FROM public.integration_credentials WHERE tenant_id = ${testTenantId} AND integration_type = 'workday'`;
    }
  });

  it("Test 16: cross-tenant crypto isolation (FND-15d)", async () => {
    let cleanupFnd15dXtenant = false;
    try {
      await poolSql`DELETE FROM public.integration_credentials WHERE tenant_id = ${FND15D_SYNTH_TENANT_ID}`;
      await poolSql`DELETE FROM public.tenant_encryption_keys WHERE tenant_id = ${FND15D_SYNTH_TENANT_ID}`;
      await poolSql`DELETE FROM public.tenants WHERE id = ${FND15D_SYNTH_TENANT_ID}`;
      await poolSql`
        INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
        VALUES (${FND15D_SYNTH_TENANT_ID}, 'synth-fnd15d', 'Synth FND-15d', 'ap-northeast-1', 'active')
      `;
      cleanupFnd15dXtenant = true;

      const synthSecret = "synth-tenant-secret-do-not-mix";
      await storeIntegrationCredential({
        tenantId: FND15D_SYNTH_TENANT_ID,
        integrationType: "bgv",
        secret: synthSecret,
        metadata: { source: "synth" },
      });

      const [synthCred] = await poolSql<{ credential_envelope: Uint8Array }[]>`
        SELECT credential_envelope FROM public.integration_credentials
        WHERE tenant_id = ${FND15D_SYNTH_TENANT_ID} AND integration_type = 'bgv'
      `;
      assert.ok(synthCred, "synth credential exists");
      const synthEnvelope = Buffer.from(synthCred.credential_envelope);

      const kms = getKmsClient();
      const [testDekRow] = await poolSql<{ encrypted_dek: Uint8Array; kms_key_id: string }[]>`
        SELECT encrypted_dek, kms_key_id FROM public.tenant_encryption_keys
        WHERE tenant_id = ${testTenantId}
      `;
      assert.ok(testDekRow, "test tenant DEK row exists");
      const testDek = await unwrapDek(
        Buffer.from(testDekRow.encrypted_dek),
        testDekRow.kms_key_id,
        kms,
      );

      let threw = false;
      let errMsg = "";
      try {
        decryptStringWithDek(synthEnvelope, testDek);
      } catch (err: unknown) {
        threw = true;
        errMsg = err instanceof Error ? err.message : String(err);
      }
      assert.ok(threw, "decrypting cross-tenant envelope must throw");
      assert.match(errMsg, /auth|tag|GCM|unable to authenticate/i, `unexpected error: ${errMsg}`);

      const [synthDekRow] = await poolSql<{ encrypted_dek: Uint8Array; kms_key_id: string }[]>`
        SELECT encrypted_dek, kms_key_id FROM public.tenant_encryption_keys
        WHERE tenant_id = ${FND15D_SYNTH_TENANT_ID}
      `;
      const synthDek = await unwrapDek(
        Buffer.from(synthDekRow!.encrypted_dek),
        synthDekRow!.kms_key_id,
        kms,
      );
      const recovered = decryptStringWithDek(synthEnvelope, synthDek);
      assert.equal(recovered, synthSecret, "synth DEK decrypts synth envelope");
    } finally {
      if (cleanupFnd15dXtenant) {
        await poolSql`DELETE FROM public.integration_credentials WHERE tenant_id = ${FND15D_SYNTH_TENANT_ID}`;
        await poolSql`DELETE FROM public.tenant_encryption_keys WHERE tenant_id = ${FND15D_SYNTH_TENANT_ID}`;
        await poolSql`DELETE FROM public.tenants WHERE id = ${FND15D_SYNTH_TENANT_ID}`;
      }
    }
  });

  it("Test 17: provision-dev-dek idempotent on re-run (FND-15d)", async () => {
    const [beforeRow] = await poolSql<{ encrypted_dek: Uint8Array; kms_key_id: string }[]>`
      SELECT encrypted_dek, kms_key_id FROM public.tenant_encryption_keys
      WHERE tenant_id = ${testTenantId}
    `;
    assert.ok(beforeRow, "test tenant DEK row exists pre-test");
    const kms = getKmsClient();
    assert.equal(beforeRow.kms_key_id, kms.kmsKeyId, "test tenant already on current KMS keyId");
    const beforeBytes = Buffer.from(beforeRow.encrypted_dek);

    const [afterRow] = await poolSql<{ encrypted_dek: Uint8Array }[]>`
      SELECT encrypted_dek FROM public.tenant_encryption_keys
      WHERE tenant_id = ${testTenantId}
    `;
    const afterBytes = Buffer.from(afterRow!.encrypted_dek);
    assert.ok(
      beforeBytes.equals(afterBytes),
      "DEK ciphertext unchanged on idempotent re-provision",
    );
  });

  it("Test 18: audit trigger fires on insert / update / delete", async () => {
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${AUDIT_BU_ID}, ${testTenantId}, 'Audit BU', 'audit-bu')
    `;
    const afterInsert = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs WHERE entity_id = ${AUDIT_BU_ID}
    `;
    assert.equal(afterInsert.length, 1, "INSERT produced one audit row");
    assert.equal(afterInsert[0]?.action, "insert");

    await poolSql`UPDATE public.business_units SET name = 'Audit BU v2' WHERE id = ${AUDIT_BU_ID}`;
    const afterUpdate = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs WHERE entity_id = ${AUDIT_BU_ID} ORDER BY created_at
    `;
    assert.equal(afterUpdate.length, 2, "UPDATE produced a second audit row");
    assert.equal(afterUpdate[1]?.action, "update");

    await poolSql`DELETE FROM public.business_units WHERE id = ${AUDIT_BU_ID}`;
    const afterDelete = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs WHERE entity_id = ${AUDIT_BU_ID} ORDER BY created_at
    `;
    assert.equal(afterDelete.length, 3, "DELETE produced a third audit row");
    assert.equal(afterDelete[2]?.action, "delete");
  });

  it("Test 19: no-op update doesn't audit", async () => {
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${AUDIT_NOOP_BU_ID}, ${testTenantId}, 'No-Op BU', 'no-op-bu')
    `;
    const before = await poolSql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM public.audit_logs WHERE entity_id = ${AUDIT_NOOP_BU_ID}
    `;
    await poolSql`UPDATE public.business_units SET name = 'No-Op BU' WHERE id = ${AUDIT_NOOP_BU_ID}`;
    const after = await poolSql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM public.audit_logs WHERE entity_id = ${AUDIT_NOOP_BU_ID}
    `;
    assert.equal(after[0]?.c, before[0]?.c, "no-op UPDATE produced no new audit row");
  });

  it("Test 20: changed_columns is correct for partial update", async () => {
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${AUDIT_DIFF_BU_ID}, ${testTenantId}, 'Diff BU', 'diff-bu-original')
    `;
    await poolSql`
      UPDATE public.business_units SET name = 'Diff BU v2', slug = 'diff-bu-renamed'
      WHERE id = ${AUDIT_DIFF_BU_ID}
    `;
    const [row] = await poolSql<{ changed_columns: string[] }[]>`
      SELECT changed_columns FROM public.audit_logs
      WHERE entity_id = ${AUDIT_DIFF_BU_ID} AND action = 'update'
    `;
    assert.ok(row, "update audit row exists");
    const changed = row.changed_columns?.slice().sort() ?? [];
    assert.deepEqual(changed, ["name", "slug"], "changed_columns lists only the modified columns");
  });

  it("Test 21: audit_logs tenant isolation enforced via RLS", async () => {
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${AUDIT_SYNTH_TENANT_ID}, 'synth-audit', 'Synth Audit', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${AUDIT_SYNTH_BU_ID}, ${AUDIT_SYNTH_TENANT_ID}, 'Synth BU', 'synth-audit-bu')
    `;
    const synthRows = await poolSql<{ id: string }[]>`
      SELECT id FROM public.audit_logs WHERE tenant_id = ${AUDIT_SYNTH_TENANT_ID}
    `;
    assert.ok(synthRows.length >= 1, "synth tenant has at least one audit row in the DB");

    const visible = await withTenantContext(decodedClaims, async ({ db }) => {
      return db
        .select({ id: auditLogs.id, tenantId: auditLogs.tenantId })
        .from(auditLogs)
        .where(eq(auditLogs.tenantId, AUDIT_SYNTH_TENANT_ID));
    });
    assert.equal(visible.length, 0, "no cross-tenant audit rows leak via RLS");
  });

  it("Test 22: audit_logs append-only enforced via split RLS policies", async () => {
    const [picked] = await poolSql<{ id: string }[]>`
      SELECT id FROM public.audit_logs WHERE tenant_id = ${testTenantId} LIMIT 1
    `;
    assert.ok(picked, "test tenant has at least one audit row to attempt to mutate");
    const targetId = picked.id;

    const updated = await withTenantContext(decodedClaims, async ({ db }) => {
      return db
        .update(auditLogs)
        .set({ source: "tampered" })
        .where(eq(auditLogs.id, targetId))
        .returning();
    });
    assert.equal(updated.length, 0, "UPDATE on audit_logs blocked by RLS (no UPDATE policy)");

    const deleted = await withTenantContext(decodedClaims, async ({ db }) => {
      return db.delete(auditLogs).where(eq(auditLogs.id, targetId)).returning();
    });
    assert.equal(deleted.length, 0, "DELETE on audit_logs blocked by RLS (no DELETE policy)");

    const [reread] = await poolSql<{ source: string }[]>`
      SELECT source FROM public.audit_logs WHERE id = ${targetId} LIMIT 1
    `;
    assert.ok(reread, "audit row still present after blocked UPDATE/DELETE");
    assert.notEqual(reread.source, "tampered", "source value unchanged");
  });

  it("Test 23: session vars propagate from withTenantContext to audit row", async () => {
    const REQ_ID_PROBE = "req-audit-vars-probe-XYZ";
    const UA_PROBE = "vitest/audit-vars";
    const IP_PROBE = "203.0.113.42";
    await withTenantContext(
      decodedClaims,
      async ({ db }) => {
        await db.insert(businessUnits).values({
          id: AUDIT_VARS_BU_ID,
          tenantId: testTenantId,
          name: "Vars BU",
          slug: "audit-vars-bu",
        });
      },
      {
        actorUserId: testUserId,
        actorMembershipId: testMembershipId,
        requestId: REQ_ID_PROBE,
        userAgent: UA_PROBE,
        ipAddress: IP_PROBE,
        source: "app",
      },
    );

    const [row] = await poolSql<
      {
        actor_user_id: string;
        actor_membership_id: string;
        request_id: string;
        user_agent: string;
        ip_address: string;
        source: string;
      }[]
    >`
      SELECT actor_user_id, actor_membership_id, request_id, user_agent, ip_address::text AS ip_address, source
      FROM public.audit_logs
      WHERE entity_id = ${AUDIT_VARS_BU_ID} AND action = 'insert'
    `;
    assert.ok(row, "audit row exists for the insert");
    assert.equal(row.actor_user_id, testUserId, "actor_user_id propagated from metadata");
    assert.equal(row.actor_membership_id, testMembershipId, "actor_membership_id propagated");
    assert.equal(row.request_id, REQ_ID_PROBE, "request_id propagated");
    assert.equal(row.user_agent, UA_PROBE, "user_agent propagated");
    // PG canonicalizes inet for a bare IPv4 to include /32 (and IPv6 to /128).
    assert.equal(row.ip_address.replace(/\/(32|128)$/, ""), IP_PROBE, "ip_address propagated");
    assert.equal(row.source, "app", "source propagated");
  });

  it("Test 24: missing session vars don't crash; nulls + default source", async () => {
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${AUDIT_MISSING_BU_ID}, ${testTenantId}, 'Missing-Vars BU', 'audit-missing-bu')
    `;
    const [row] = await poolSql<
      {
        actor_user_id: string | null;
        actor_membership_id: string | null;
        request_id: string | null;
        user_agent: string | null;
        ip_address: string | null;
        source: string;
      }[]
    >`
      SELECT actor_user_id, actor_membership_id, request_id, user_agent,
             ip_address::text AS ip_address, source
      FROM public.audit_logs
      WHERE entity_id = ${AUDIT_MISSING_BU_ID} AND action = 'insert'
    `;
    assert.ok(row, "audit row exists");
    assert.equal(row.actor_user_id, null);
    assert.equal(row.actor_membership_id, null);
    assert.equal(row.request_id, null);
    assert.equal(row.user_agent, null);
    assert.equal(row.ip_address, null);
    assert.equal(row.source, "app", "source defaults to 'app' when unset");
  });

  it("Test 25: partition routing — row lands in current-month partition", async () => {
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${AUDIT_PART_BU_ID}, ${testTenantId}, 'Part BU', 'audit-part-bu')
    `;
    const [routed] = await poolSql<{ relname: string }[]>`
      SELECT tableoid::regclass::text AS relname FROM public.audit_logs
      WHERE entity_id = ${AUDIT_PART_BU_ID} AND action = 'insert'
    `;
    assert.ok(routed, "audit row exists");
    const now = new Date();
    const expected = `audit_logs_${now.getUTCFullYear()}_${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    assert.equal(
      routed.relname,
      expected,
      `row should live in the current-month partition (${expected})`,
    );

    const direct = await poolSql<{ id: string }[]>`
      SELECT id FROM public.audit_logs_2026_05 WHERE entity_id = ${AUDIT_PART_BU_ID}
    `;
    assert.equal(direct.length, 1, "row reachable through the partition directly");
  });
});

describe("DB-03 persons / candidates / applications", () => {
  beforeAll(async () => {
    // Establish JWT for this suite too (Vitest runs describes sequentially
    // within a file but each has independent setup).
    if (!jwt) {
      jwt = await getTestJwt();
      decodedClaims = decodeJwt(jwt) as JwtClaims;
      testUserId = decodedClaims.sub!;
      testTenantId = decodedClaims.tid!;
      const [m] = await poolSql<{ id: string }[]>`
        SELECT id FROM public.tenant_user_memberships
        WHERE user_id = ${testUserId} AND tenant_id = ${testTenantId} LIMIT 1
      `;
      if (!m) throw new Error("test user has no membership in its tenant");
      testMembershipId = m.id;
    }

    // DB-03 fixture pre-cleanup.
    await poolSql`DELETE FROM public.audit_logs WHERE entity_id = ANY(${DB03_AUDIT_ENTITY_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${DB03_APPLICATION_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.applications WHERE id = ANY(${DB03_APPLICATION_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.candidates WHERE id = ANY(${DB03_CANDIDATE_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.persons WHERE id = ANY(${DB03_PERSON_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${DB03_OWN_REQ_ID}`;
    await poolSql`DELETE FROM public.requisitions WHERE id = ${DB03_OWN_REQ_ID}`;
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${DB03_OWN_JD_ID}`;
    await poolSql`DELETE FROM public.positions WHERE id = ${DB03_OWN_POSITION_ID}`;
    await poolSql`DELETE FROM public.business_units WHERE id = ${DB03_OWN_BU_ID}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${DB03_SYNTH_TENANT_ID}`;

    // DB-03 shared own-tenant chain. Tests 26-35 reference these.
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${DB03_OWN_BU_ID}, ${testTenantId}, 'DB-03 BU', 'db03-bu')
    `;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title)
      VALUES (${DB03_OWN_POSITION_ID}, ${testTenantId}, ${DB03_OWN_BU_ID}, 'DB-03 Position')
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text)
      VALUES (${DB03_OWN_JD_ID}, ${testTenantId}, ${DB03_OWN_POSITION_ID}, 1, 'DB-03 JD')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${DB03_OWN_REQ_ID}, ${testTenantId}, ${DB03_OWN_POSITION_ID}, ${DB03_OWN_JD_ID}, ${testMembershipId}, ${testMembershipId}, 'draft')
    `;

    // DB-03 synth-tenant mirror chain.
    await poolSql`
      INSERT INTO public.tenants (id, slug, display_name, primary_region, status)
      VALUES (${DB03_SYNTH_TENANT_ID}, 'synth-db03', 'Synth DB-03', 'ap-northeast-1', 'active')
    `;
    await poolSql`
      INSERT INTO public.tenant_user_memberships (id, user_id, tenant_id, roles, status, accepted_at)
      VALUES (${DB03_SYNTH_MEMBERSHIP_ID}, ${testUserId}, ${DB03_SYNTH_TENANT_ID}, ARRAY['admin']::tenant_role[], 'active', now())
    `;
    await poolSql`
      INSERT INTO public.business_units (id, tenant_id, name, slug)
      VALUES (${DB03_SYNTH_BU_ID}, ${DB03_SYNTH_TENANT_ID}, 'Synth BU', 'synth-db03-bu')
    `;
    await poolSql`
      INSERT INTO public.positions (id, tenant_id, business_unit_id, title)
      VALUES (${DB03_SYNTH_POSITION_ID}, ${DB03_SYNTH_TENANT_ID}, ${DB03_SYNTH_BU_ID}, 'Synth Position')
    `;
    await poolSql`
      INSERT INTO public.jd_versions (id, tenant_id, position_id, version_number, jd_text)
      VALUES (${DB03_SYNTH_JD_ID}, ${DB03_SYNTH_TENANT_ID}, ${DB03_SYNTH_POSITION_ID}, 1, 'synth JD')
    `;
    await poolSql`
      INSERT INTO public.requisitions
        (id, tenant_id, position_id, jd_version_id, primary_recruiter_id, hiring_manager_id, status)
      VALUES (${DB03_SYNTH_REQ_ID}, ${DB03_SYNTH_TENANT_ID}, ${DB03_SYNTH_POSITION_ID}, ${DB03_SYNTH_JD_ID}, ${DB03_SYNTH_MEMBERSHIP_ID}, ${DB03_SYNTH_MEMBERSHIP_ID}, 'draft')
    `;
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${DB03_SYNTH_PERSON_ID}, ${DB03_SYNTH_TENANT_ID}, 'Synth Candidate', 'synth@example.com', 'synth@example.com')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source)
      VALUES (${DB03_SYNTH_CANDIDATE_ID}, ${DB03_SYNTH_TENANT_ID}, ${DB03_SYNTH_PERSON_ID}, 'career_site')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage)
      VALUES (${DB03_SYNTH_APP_ID}, ${DB03_SYNTH_TENANT_ID}, ${DB03_SYNTH_CANDIDATE_ID}, ${DB03_SYNTH_REQ_ID}, 'career_site', 'application_received')
    `;
    await poolSql`
      INSERT INTO public.application_state_transitions
        (id, tenant_id, application_id, from_stage, to_stage, reason)
      VALUES (${DB03_SYNTH_TRANSITION_ID}, ${DB03_SYNTH_TENANT_ID}, ${DB03_SYNTH_APP_ID}, NULL, 'application_received', 'initial')
    `;

    // Own-tenant DB-03 entities (person A / candidate A / app A / first transition).
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${DB03_PERSON_A_ID}, ${testTenantId}, 'Own Candidate A', 'a@own.test', 'a@own.test')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source)
      VALUES (${DB03_CANDIDATE_A_ID}, ${testTenantId}, ${DB03_PERSON_A_ID}, 'referral')
    `;
    await poolSql`
      INSERT INTO public.applications
        (id, tenant_id, candidate_id, requisition_id, source, current_stage)
      VALUES (${DB03_APP_A_ID}, ${testTenantId}, ${DB03_CANDIDATE_A_ID}, ${DB03_OWN_REQ_ID}, 'referral', 'application_received')
    `;
    await poolSql`
      INSERT INTO public.application_state_transitions
        (id, tenant_id, application_id, from_stage, to_stage, reason)
      VALUES (${DB03_OWN_TRANSITION_ID}, ${testTenantId}, ${DB03_APP_A_ID}, NULL, 'application_received', 'initial')
    `;
  });

  afterAll(async () => {
    // DB-03 teardown — children before parents.
    await poolSql`DELETE FROM public.audit_logs WHERE entity_id = ANY(${DB03_AUDIT_ENTITY_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.application_state_transitions WHERE application_id = ANY(${DB03_APPLICATION_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.applications WHERE id = ANY(${DB03_APPLICATION_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.candidates WHERE id = ANY(${DB03_CANDIDATE_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.persons WHERE id = ANY(${DB03_PERSON_IDS}::uuid[])`;
    await poolSql`DELETE FROM public.requisition_state_transitions WHERE requisition_id = ${DB03_OWN_REQ_ID}`;
    await poolSql`DELETE FROM public.requisitions WHERE id = ${DB03_OWN_REQ_ID}`;
    await poolSql`DELETE FROM public.jd_versions WHERE id = ${DB03_OWN_JD_ID}`;
    await poolSql`DELETE FROM public.positions WHERE id = ${DB03_OWN_POSITION_ID}`;
    await poolSql`DELETE FROM public.business_units WHERE id = ${DB03_OWN_BU_ID}`;
    await poolSql`DELETE FROM public.tenants WHERE id = ${DB03_SYNTH_TENANT_ID}`;

    // Drain the pool so the next file (db-approval) gets fresh connections.
    await poolSql.end({ timeout: 5 });
  });

  it("Test 26: DB-03 tenant isolation across persons/candidates/applications/transitions", async () => {
    const view = await withTenantContext(decodedClaims, async ({ db }) => {
      const p = await db.select().from(persons);
      const c = await db.select().from(candidates);
      const a = await db.select().from(applications);
      const t = await db.select().from(applicationStateTransitions);
      return { p, c, a, t };
    });
    const synth = (id: string) => view.p.find((r) => r.id === id);
    assert.ok(
      view.p.find((r) => r.id === DB03_PERSON_A_ID),
      "own person visible",
    );
    assert.equal(synth(DB03_SYNTH_PERSON_ID), undefined, "synth person not visible via RLS");
    assert.ok(
      view.c.find((r) => r.id === DB03_CANDIDATE_A_ID),
      "own candidate visible",
    );
    assert.equal(
      view.c.find((r) => r.id === DB03_SYNTH_CANDIDATE_ID),
      undefined,
      "synth candidate not visible via RLS",
    );
    assert.ok(
      view.a.find((r) => r.id === DB03_APP_A_ID),
      "own application visible",
    );
    assert.equal(
      view.a.find((r) => r.id === DB03_SYNTH_APP_ID),
      undefined,
      "synth application not visible via RLS",
    );
    assert.ok(
      view.t.find((r) => r.id === DB03_OWN_TRANSITION_ID),
      "own transition visible",
    );
    assert.equal(
      view.t.find((r) => r.id === DB03_SYNTH_TRANSITION_ID),
      undefined,
      "synth transition not visible via RLS",
    );
  });

  it("Test 27: compound FK rejects cross-tenant candidate reference", async () => {
    let threw = false;
    let errMsg = "";
    try {
      await poolSql`
        INSERT INTO public.applications
          (tenant_id, candidate_id, requisition_id, source, current_stage)
        VALUES (${testTenantId}, ${DB03_SYNTH_CANDIDATE_ID}, ${DB03_OWN_REQ_ID}, 'career_site', 'application_received')
      `;
    } catch (err: unknown) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(threw, "cross-tenant application insert should throw a FK violation");
    assert.match(
      errMsg,
      /foreign key|fk_applications_candidate/i,
      `unexpected error message: ${errMsg}`,
    );
  });

  it("Test 28: partial unique index enforces one-candidate-per-person-per-tenant", async () => {
    let threw = false;
    let errMsg = "";
    try {
      await poolSql`
        INSERT INTO public.candidates (id, tenant_id, person_id, source)
        VALUES (${DB03_CANDIDATE_B_ID}, ${testTenantId}, ${DB03_PERSON_A_ID}, 'job_board')
      `;
    } catch (err: unknown) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(threw, "duplicate candidate for same person should throw");
    assert.match(
      errMsg,
      /uniq_candidates_one_per_person|duplicate key/i,
      `unexpected error: ${errMsg}`,
    );
  });

  it("Test 29: unique constraint enforces one-application-per-candidate-per-req", async () => {
    let threw = false;
    let errMsg = "";
    try {
      await poolSql`
        INSERT INTO public.applications
          (tenant_id, candidate_id, requisition_id, source, current_stage)
        VALUES (${testTenantId}, ${DB03_CANDIDATE_A_ID}, ${DB03_OWN_REQ_ID}, 'whatsapp', 'application_received')
      `;
    } catch (err: unknown) {
      threw = true;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    assert.ok(threw, "duplicate (candidate, req) application should throw");
    assert.match(
      errMsg,
      /uniq_applications_candidate_req|duplicate key/i,
      `unexpected error: ${errMsg}`,
    );
  });

  it("Test 30: audit trigger fires on persons/candidates/applications inserts", async () => {
    const personRows = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs
      WHERE entity_type = 'persons' AND entity_id = ${DB03_PERSON_A_ID}
    `;
    const candidateRows = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs
      WHERE entity_type = 'candidates' AND entity_id = ${DB03_CANDIDATE_A_ID}
    `;
    const applicationRows = await poolSql<{ action: string }[]>`
      SELECT action FROM public.audit_logs
      WHERE entity_type = 'applications' AND entity_id = ${DB03_APP_A_ID}
    `;
    assert.ok(
      personRows.some((r) => r.action === "insert"),
      "audit row for person insert",
    );
    assert.ok(
      candidateRows.some((r) => r.action === "insert"),
      "audit row for candidate insert",
    );
    assert.ok(
      applicationRows.some((r) => r.action === "insert"),
      "audit row for application insert",
    );
  });

  it("Test 31: application_state_transitions append-only enforced", async () => {
    const inserted = await withTenantContext(decodedClaims, async ({ db }) => {
      return db
        .insert(applicationStateTransitions)
        .values({
          tenantId: testTenantId,
          applicationId: DB03_APP_A_ID,
          fromStage: "application_received",
          toStage: "ai_screening",
          actorMembershipId: testMembershipId,
          reason: "ai pipeline picked it up",
        })
        .returning();
    });
    assert.equal(inserted.length, 1, "INSERT into application_state_transitions allowed");
    const txId = inserted[0]!.id;

    const updated = await withTenantContext(decodedClaims, async ({ db }) => {
      return db
        .update(applicationStateTransitions)
        .set({ reason: "tampered" })
        .where(eq(applicationStateTransitions.id, txId))
        .returning();
    });
    assert.equal(updated.length, 0, "UPDATE blocked by RLS (no UPDATE policy)");

    const deleted = await withTenantContext(decodedClaims, async ({ db }) => {
      return db
        .delete(applicationStateTransitions)
        .where(eq(applicationStateTransitions.id, txId))
        .returning();
    });
    assert.equal(deleted.length, 0, "DELETE blocked by RLS (no DELETE policy)");

    const [rereread] = await poolSql<{ reason: string }[]>`
      SELECT reason FROM public.application_state_transitions WHERE id = ${txId}
    `;
    assert.ok(rereread, "transition row still present");
    assert.equal(rereread.reason, "ai pipeline picked it up", "reason unchanged");
  });

  it("Test 32: redaction nulls PII while FKs + audit history survive", async () => {
    await poolSql`
      UPDATE public.persons SET
        full_name = NULL,
        first_name = NULL,
        last_name = NULL,
        email_primary = NULL,
        email_normalised = NULL,
        phone_primary = NULL,
        phone_normalised = NULL,
        location_country = NULL,
        location_city = NULL,
        linkedin_url = NULL,
        redacted_at = now(),
        redaction_reason = 'erasure_request'
      WHERE id = ${DB03_PERSON_A_ID}
    `;
    const [redacted] = await poolSql<
      {
        full_name: string | null;
        email_primary: string | null;
        redacted_at: string | null;
        redaction_reason: string | null;
      }[]
    >`
      SELECT full_name, email_primary, redacted_at, redaction_reason
      FROM public.persons WHERE id = ${DB03_PERSON_A_ID}
    `;
    assert.ok(redacted, "redacted person row still present");
    assert.equal(redacted.full_name, null);
    assert.equal(redacted.email_primary, null);
    assert.ok(redacted.redacted_at, "redacted_at set");
    assert.equal(redacted.redaction_reason, "erasure_request");

    const [joined] = await poolSql<{ candidate_id: string; person_id: string }[]>`
      SELECT c.id AS candidate_id, p.id AS person_id
      FROM public.candidates c
      JOIN public.persons p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
      WHERE c.id = ${DB03_CANDIDATE_A_ID}
    `;
    assert.ok(joined, "candidate→person join still resolves after redaction");

    const updateRows = await poolSql<
      {
        before_data: { full_name?: string; email_primary?: string };
        after_data: { full_name?: string; email_primary?: string };
      }[]
    >`
      SELECT before_data, after_data FROM public.audit_logs
      WHERE entity_type = 'persons' AND entity_id = ${DB03_PERSON_A_ID} AND action = 'update'
      ORDER BY created_at DESC LIMIT 1
    `;
    assert.ok(updateRows.length >= 1, "audit row recorded the redaction update");
    assert.equal(updateRows[0]?.before_data.full_name, "Own Candidate A", "prior name in audit");
    assert.equal(updateRows[0]?.after_data.full_name, null, "post-redaction null in audit");
  });

  it("Test 33: application_stage enum accepts all 11 values", async () => {
    const STAGES: ApplicationStage[] = [
      "application_received",
      "ai_screening",
      "recruiter_review",
      "shortlisted",
      "tech_interview",
      "hr_round",
      "offer_drafted",
      "offer_accepted",
      "offer_declined",
      "withdrawn",
      "recruiter_rejected",
    ];
    for (const stage of STAGES) {
      await poolSql`
        UPDATE public.applications SET current_stage = ${stage}, stage_entered_at = now()
        WHERE id = ${DB03_APP_A_ID}
      `;
      const [row] = await poolSql<{ current_stage: string }[]>`
        SELECT current_stage FROM public.applications WHERE id = ${DB03_APP_A_ID}
      `;
      assert.equal(row?.current_stage, stage, `current_stage accepts ${stage}`);
    }
  });

  it("Test 34: application_source enum accepts all 8 values", async () => {
    const SOURCES: ApplicationSource[] = [
      "career_site",
      "referral",
      "partner_empanelled",
      "partner_adhoc",
      "job_board",
      "agency_search",
      "talent_pool",
      "whatsapp",
    ];
    for (const source of SOURCES) {
      await poolSql`UPDATE public.applications SET source = ${source} WHERE id = ${DB03_APP_A_ID}`;
      const [row] = await poolSql<{ source: string }[]>`
        SELECT source FROM public.applications WHERE id = ${DB03_APP_A_ID}
      `;
      assert.equal(row?.source, source, `source accepts ${source}`);
    }
  });

  it("Test 35: session vars propagate to audit row on application insert", async () => {
    const REQ_ID_PROBE = "req-db03-vars-probe-1234";
    await poolSql`
      INSERT INTO public.persons (id, tenant_id, full_name, email_primary, email_normalised)
      VALUES (${DB03_PERSON_B_ID}, ${testTenantId}, 'DB-03 Vars Person', 'vars@own.test', 'vars@own.test')
    `;
    await poolSql`
      INSERT INTO public.candidates (id, tenant_id, person_id, source)
      VALUES (${DB03_CANDIDATE_B_ID}, ${testTenantId}, ${DB03_PERSON_B_ID}, 'career_site')
    `;
    await withTenantContext(
      decodedClaims,
      async ({ db }) => {
        await db.insert(applications).values({
          id: DB03_APP_B_ID,
          tenantId: testTenantId,
          candidateId: DB03_CANDIDATE_B_ID,
          requisitionId: DB03_OWN_REQ_ID,
          source: "career_site",
          currentStage: "application_received",
        });
      },
      {
        actorUserId: testUserId,
        actorMembershipId: testMembershipId,
        requestId: REQ_ID_PROBE,
        userAgent: "vitest/db03",
        ipAddress: "198.51.100.10",
        source: "app",
      },
    );

    const [row] = await poolSql<
      {
        actor_user_id: string;
        actor_membership_id: string;
        request_id: string;
        source: string;
      }[]
    >`
      SELECT actor_user_id, actor_membership_id, request_id, source
      FROM public.audit_logs
      WHERE entity_type = 'applications' AND entity_id = ${DB03_APP_B_ID} AND action = 'insert'
    `;
    assert.ok(row, "audit row exists for application insert");
    assert.equal(row.actor_user_id, testUserId, "actor_user_id propagated");
    assert.equal(row.actor_membership_id, testMembershipId, "actor_membership_id propagated");
    assert.equal(row.request_id, REQ_ID_PROBE, "request_id propagated");
    assert.equal(row.source, "app");
  });
});

// DB03_PERSON_C_ID / DB03_CANDIDATE_C_ID / DB03_APP_C_ID are reserved for
// future tests that need an additional clean person+candidate+application
// chain in the test tenant; not used by the current suite but cleaned up
// by beforeAll / afterAll alongside the A/B IDs.
void [DB03_PERSON_C_ID, DB03_CANDIDATE_C_ID, DB03_APP_C_ID];
