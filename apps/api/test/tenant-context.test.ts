/**
 * FND-15e integration verification.
 *
 * Covers, end to end through the Hono app + withTenantContext:
 *   - no Authorization header → 401 (reason: "missing")
 *   - malformed Bearer token → 401
 *   - valid JWT → 200, /test/whoami returns tenantId/userId/roles
 *   - RLS scoping → /test/tenants returns exactly 1 row for the test user
 *   - Worker-side parity → withTenantContext called directly yields the
 *     same single-tenant view as the HTTP path
 *
 * Test user comes from FND-15b: test-fnd15b@hireops-dev.local with the
 * fnd15b-test-password-do-not-reuse password. The auth hook (FND-15b)
 * stamps tid + tenant_slug + roles into the JWT at issuance time.
 */

import "../src/bootstrap";

import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import { app } from "../src/index.js";
import { withTenantContext, drizzleSql, type JwtClaims } from "@hireops/db";

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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
  console.log("FND-15e integration tests starting...\n");

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
    // Use the real claims from the test JWT (rather than synthesising) — the
    // tenant UUID isn't stable across environments. RLS reads `tid` from
    // request.jwt.claims, so what matters is that the claim is set.
    const result = await withTenantContext(decodedClaims, async ({ db }) => {
      return db.execute<{ id: string; slug: string }>(drizzleSql`SELECT id, slug FROM tenants`);
    });
    assert.equal(result.length, 1, "worker helper should see 1 tenant via RLS");
    assert.equal(result[0]?.slug, "kyndryl-poc");
    console.log("  ✓ withTenantContext worker pattern matches HTTP path");
  }

  console.log("\n=========================================");
  console.log("FND-15e verification: PASS");
  console.log("=========================================");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFND-15e verification: FAIL");
    console.error(err);
    process.exit(1);
  });
