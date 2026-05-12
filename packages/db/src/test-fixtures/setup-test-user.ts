/**
 * Creates a synthetic Supabase Auth user for testing FND-15b.
 * The user is given:
 *   - email/password credentials (for sign-in)
 *   - tenant_slug='kyndryl-poc' in user_metadata (so the hook picks that tenant)
 *   - membership in kyndryl-poc with admin role
 *
 * Run with: pnpm db:test:setup
 *
 * Idempotent: if the user already exists, skips creation but ensures membership.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load workspace-root .env BEFORE importing client.ts
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
}

const TEST_EMAIL = "test-fnd15b@hireops-dev.local";
const TEST_PASSWORD = "fnd15b-test-password-do-not-reuse";
const TARGET_TENANT_SLUG = "kyndryl-poc";

async function main() {
  // Local consts to satisfy strict TS narrowing — the throw above already guards both.
  const url = SUPABASE_URL;
  const serviceKey = SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Dynamic imports so dotenv is loaded first
  const { db, sql: poolSql } = await import("../client");
  const { tenants, tenantUserMemberships } = await import("../schema");
  const { eq } = await import("drizzle-orm");

  console.log("Looking up tenant kyndryl-poc...");
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, TARGET_TENANT_SLUG));
  if (!tenant) {
    throw new Error(`Tenant ${TARGET_TENANT_SLUG} not found. Did FND-15a seed run?`);
  }
  console.log(`Tenant ${tenant.slug} found: ${tenant.id}`);

  // Check if user already exists
  console.log(`Looking up Supabase Auth user ${TEST_EMAIL}...`);
  const { data: existing } = await supabase.auth.admin.listUsers();
  let user = existing?.users.find((u) => u.email === TEST_EMAIL);

  if (!user) {
    console.log("Creating user...");
    const { data, error } = await supabase.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: {
        tenant_slug: TARGET_TENANT_SLUG,
      },
    });
    if (error) throw error;
    if (!data.user) throw new Error("createUser returned no user");
    user = data.user;
    console.log(`Created user ${user.id}`);
  } else {
    console.log(`User exists: ${user.id}`);
    // Ensure user_metadata has tenant_slug
    if (user.user_metadata?.tenant_slug !== TARGET_TENANT_SLUG) {
      console.log("Updating user_metadata to set tenant_slug...");
      await supabase.auth.admin.updateUserById(user.id, {
        user_metadata: { tenant_slug: TARGET_TENANT_SLUG },
      });
    }
  }

  // Ensure membership exists with admin role
  console.log("Ensuring membership...");
  const existingMembership = await db
    .select()
    .from(tenantUserMemberships)
    .where(eq(tenantUserMemberships.userId, user.id));

  if (existingMembership.length === 0) {
    // Drizzle schema still types roles as text[]; the DB column is
    // tenant_role[] (DB-01). Use raw SQL with an explicit enum cast so the
    // insert doesn't hit "text[] cannot be assigned to tenant_role[]".
    await poolSql`
      INSERT INTO tenant_user_memberships (user_id, tenant_id, roles, status, accepted_at)
      VALUES (${user.id}, ${tenant.id}, ARRAY['admin']::tenant_role[], 'active', now())
    `;
    console.log("Created membership with admin role");
  } else {
    console.log("Membership already exists");
  }

  console.log("\n=========================================");
  console.log("Test user setup complete:");
  console.log(`  email:    ${TEST_EMAIL}`);
  console.log(`  password: ${TEST_PASSWORD}`);
  console.log(`  user_id:  ${user.id}`);
  console.log(`  tenant:   ${TARGET_TENANT_SLUG} (${tenant.id})`);
  console.log(`  roles:    [admin]`);
  console.log("=========================================");
}

main()
  .catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
