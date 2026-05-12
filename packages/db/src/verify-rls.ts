/**
 * End-to-end verification of the FND-15c RLS baseline.
 *
 * Phase 1 — pg_catalog state: confirms RLS+FORCE are on for both tenant-context
 * tables and that the expected policies exist (tenants_self_select on tenants,
 * memberships_self_select on tenant_user_memberships).
 *
 * Phase 2 — synthetic isolation: creates a second tenant and a second auth user
 * with membership in that tenant. Signs in as the FND-15b test user (kyndryl-poc
 * tenant) and confirms they see EXACTLY their own tenant row and EXACTLY their
 * own membership row — never the synthetic ones — under the RLS policies.
 *
 * Phase 3 — cleanup: removes the synthetic membership, user, and tenant. Runs
 * even when assertions fail, via try/finally.
 *
 * Run with: pnpm db:test:verify-rls
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

import postgres from "postgres";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const DIRECT_URL = process.env.DIRECT_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!DIRECT_URL || !SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error(
    "Required env: DIRECT_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY",
  );
}

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";

// Synthetic second tenant + user, scoped to this verifier. Stable identifiers
// so cleanup-then-create is reliable across re-runs.
const SYNTH_TENANT_SLUG = "synth-fnd15c-rls-test";
const SYNTH_TENANT_NAME = "Synthetic FND-15c RLS test tenant";
const SYNTH_USER_EMAIL = "synth-fnd15c@hireops-dev.local";
const SYNTH_USER_PASSWORD = "synth-fnd15c-do-not-reuse";

interface RlsRow {
  relname: string;
  rls: boolean;
  forced: boolean;
}

interface PolicyRow {
  tablename: string;
  policyname: string;
  qual: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    throw new Error(msg);
  }
}

async function findUserByEmail(admin: SupabaseClient, email: string) {
  const { data, error } = await admin.auth.admin.listUsers();
  if (error) throw error;
  return data.users.find((u) => u.email === email);
}

async function deleteSyntheticUserIfExists(admin: SupabaseClient) {
  const existing = await findUserByEmail(admin, SYNTH_USER_EMAIL);
  if (existing) {
    const { error } = await admin.auth.admin.deleteUser(existing.id);
    if (error) throw error;
  }
}

async function main() {
  const sql = postgres(DIRECT_URL as string, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 2,
  });
  const admin = createClient(SUPABASE_URL as string, SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let cleanupNeeded = false;
  let allPassed = false;
  let cleanupError: unknown = null;

  try {
    // ----------------------------------------------------------------------
    // Phase 1 — pg_catalog state
    // ----------------------------------------------------------------------
    console.log("Phase 1: pg_catalog state");

    const rlsRows = await sql<RlsRow[]>`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN ('tenants', 'tenant_user_memberships')
    `;
    const rlsByName = new Map(rlsRows.map((r) => [r.relname, r]));

    const tenantsRls = rlsByName.get("tenants");
    assert(tenantsRls, "tenants row missing from pg_class");
    assert(tenantsRls.rls, "RLS not enabled on tenants");
    assert(tenantsRls.forced, "FORCE not enabled on tenants");
    console.log("  tenants: rls=true, forced=true");

    const membershipsRls = rlsByName.get("tenant_user_memberships");
    assert(membershipsRls, "tenant_user_memberships row missing from pg_class");
    assert(membershipsRls.rls, "RLS not enabled on tenant_user_memberships");
    assert(membershipsRls.forced, "FORCE not enabled on tenant_user_memberships");
    console.log("  tenant_user_memberships: rls=true, forced=true");

    const policies = await sql<PolicyRow[]>`
      SELECT tablename, policyname, qual
      FROM pg_policies
      WHERE schemaname = 'public'
    `;
    const policyByTable = new Map(policies.map((p) => [`${p.tablename}.${p.policyname}`, p]));

    const tenantsPolicy = policyByTable.get("tenants.tenants_self_select");
    assert(tenantsPolicy, "policy tenants_self_select missing on tenants");
    console.log(`  tenants_self_select: qual = ${tenantsPolicy.qual}`);

    const membershipsPolicy = policyByTable.get("tenant_user_memberships.memberships_self_select");
    assert(membershipsPolicy, "policy memberships_self_select missing on tenant_user_memberships");
    console.log(`  memberships_self_select: qual = ${membershipsPolicy.qual}`);

    // ----------------------------------------------------------------------
    // Phase 2 — synthetic isolation
    // ----------------------------------------------------------------------
    console.log("\nPhase 2: synthetic isolation");

    // Defensive pre-cleanup in case a previous run left rows behind.
    await deleteSyntheticUserIfExists(admin);
    await sql`DELETE FROM tenants WHERE slug = ${SYNTH_TENANT_SLUG}`;

    cleanupNeeded = true;

    // Create synthetic second tenant (postgres role bypasses RLS for writes).
    const tenantInsert = await sql<{ id: string }[]>`
      INSERT INTO tenants (slug, display_name, primary_region, status)
      VALUES (${SYNTH_TENANT_SLUG}, ${SYNTH_TENANT_NAME}, 'ap-northeast-1', 'active')
      RETURNING id
    `;
    const synthTenantId = tenantInsert[0]?.id;
    assert(synthTenantId, "synth tenant insert returned no id");
    console.log(`  synth tenant: ${synthTenantId}`);

    // Create synthetic second user via Supabase admin API.
    const { data: createdUser, error: createUserErr } = await admin.auth.admin.createUser({
      email: SYNTH_USER_EMAIL,
      password: SYNTH_USER_PASSWORD,
      email_confirm: true,
      user_metadata: { tenant_slug: SYNTH_TENANT_SLUG },
    });
    if (createUserErr) throw createUserErr;
    const synthUserId = createdUser.user?.id;
    assert(synthUserId, "synth user createUser returned no id");
    console.log(`  synth user: ${synthUserId}`);

    // Create membership linking synth user to synth tenant. The roles
    // column is tenant_role[] (DB-01); cast the array literal explicitly.
    await sql`
      INSERT INTO tenant_user_memberships (user_id, tenant_id, roles, status, accepted_at)
      VALUES (${synthUserId}, ${synthTenantId}, ARRAY['admin']::tenant_role[], 'active', now())
    `;
    console.log("  synth membership created");

    // Sign in as the FND-15b test user. The Supabase JS client uses the
    // anon key + the user's access token for authorization, which routes
    // through PostgREST under the `authenticated` role — exercising RLS.
    const authed = createClient(SUPABASE_URL as string, ANON_KEY as string);
    const { data: session, error: signInErr } = await authed.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr) throw signInErr;
    assert(session.session?.access_token, "no access token after sign-in");
    console.log("  signed in as FND-15b test user (kyndryl-poc)");

    // Query tenants — must return exactly 1 row (kyndryl-poc), not 2.
    const { data: visibleTenants, error: tenantsErr } = await authed
      .from("tenants")
      .select("id, slug");
    if (tenantsErr) throw tenantsErr;
    assert(
      visibleTenants?.length === 1,
      `expected 1 tenant visible, got ${visibleTenants?.length}`,
    );
    assert(
      visibleTenants[0]?.slug === "kyndryl-poc",
      `expected visible tenant kyndryl-poc, got ${visibleTenants[0]?.slug}`,
    );
    console.log(`  tenants query visible rows: 1 (slug=${visibleTenants[0].slug})`);

    // Query tenant_user_memberships — must return exactly 1 row (the test
    // user's own membership), not 2.
    const { data: visibleMemberships, error: membershipsErr } = await authed
      .from("tenant_user_memberships")
      .select("id, user_id, tenant_id");
    if (membershipsErr) throw membershipsErr;
    assert(
      visibleMemberships?.length === 1,
      `expected 1 membership visible, got ${visibleMemberships?.length}`,
    );
    console.log(`  memberships query visible rows: 1`);

    allPassed = true;
  } finally {
    // ------------------------------------------------------------------
    // Phase 3 — cleanup. Runs even if Phase 2 failed midway.
    // ------------------------------------------------------------------
    if (cleanupNeeded) {
      console.log("\nPhase 3: cleanup");
      try {
        await deleteSyntheticUserIfExists(admin);
        const deleted = await sql<{ id: string }[]>`
          DELETE FROM tenants WHERE slug = ${SYNTH_TENANT_SLUG} RETURNING id
        `;
        console.log(`  synth user removed; synth tenants removed: ${deleted.length}`);
      } catch (e) {
        cleanupError = e;
        console.error("  CLEANUP FAILED — manual cleanup may be required:", e);
      }
    }
    await sql.end({ timeout: 2 });
  }

  if (cleanupError) {
    throw cleanupError;
  }

  if (!allPassed) {
    console.error("\nFND-15c verification: FAIL");
    process.exit(1);
  }

  console.log("\n=========================================");
  console.log("FND-15c verification: PASS");
  console.log("=========================================");
}

main()
  .catch((err) => {
    console.error("Verification failed:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
