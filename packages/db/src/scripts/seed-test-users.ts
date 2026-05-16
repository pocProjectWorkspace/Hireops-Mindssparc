/**
 * Idempotent test-user provisioner. Creates three personas in the
 * kyndryl-poc tenant so the internal portal has someone to log in as.
 *
 * Run:
 *   pnpm db:seed:test-users
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env
 *
 * Test password is the same for all three so the e2e + the developer
 * onboarding flow can hardcode it. It's a fixed string with no
 * security value — the seed only runs against the dev Supabase
 * project, never production.
 *
 * Behaviour:
 *   - For each persona, ensure auth.users row exists (admin.createUser;
 *     if "already registered", look it up).
 *   - Ensure public.users row exists (insert with onConflictDoNothing).
 *   - Ensure tenant_user_memberships row exists (insert with the
 *     persona-specific role array; onConflictDoNothing means re-runs
 *     don't overwrite roles a human modified mid-run).
 *
 * Logged per persona; non-zero exit on the first hard failure.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { db } from "../client";
import { users, tenantUserMemberships, tenants } from "../schema";

const TEST_PASSWORD = "TestPassword123!";

const TEST_USERS = [
  {
    email: "recruiter1@kyndryl-poc.test",
    displayName: "Test Recruiter",
    roles: ["recruiter"] as const,
  },
  {
    email: "hr_ops1@kyndryl-poc.test",
    displayName: "Test HR Ops",
    roles: ["hr_ops"] as const,
  },
  {
    email: "admin1@kyndryl-poc.test",
    displayName: "Test Admin",
    roles: ["admin"] as const,
  },
] as const;

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(2);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [tenant] = await db
    .select({ id: tenants.id, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.slug, "kyndryl-poc"))
    .limit(1);
  if (!tenant) {
    console.error("kyndryl-poc tenant not found; run db:migrate first (and seed the tenant).");
    process.exit(2);
  }

  for (const u of TEST_USERS) {
    let authUserId: string | null = null;
    const created = await admin.auth.admin.createUser({
      email: u.email,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (created.data?.user?.id) {
      authUserId = created.data.user.id;
      console.log(`  created auth user ${u.email} → ${authUserId}`);
    } else if (created.error) {
      // "already registered" → look it up. listUsers paginates; with 3
      // test users + maybe a handful of dev fixtures we stay under page 1.
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const existing = list.data?.users.find((x) => x.email === u.email);
      if (existing) {
        authUserId = existing.id;
        console.log(`  reused auth user ${u.email} → ${authUserId}`);
      } else {
        console.error(`  failed to create or find ${u.email}: ${created.error.message}`);
        process.exit(1);
      }
    }
    if (!authUserId) {
      console.error(`  no auth user id resolved for ${u.email}`);
      process.exit(1);
    }

    // public.users — id is FK to auth.users.id; insert + onConflictDoNothing.
    await db
      .insert(users)
      .values({ id: authUserId, displayName: u.displayName })
      .onConflictDoNothing();

    // tenant_user_memberships — unique index on (user_id, tenant_id) is the
    // conflict target. Roles is an enum array.
    await db
      .insert(tenantUserMemberships)
      .values({
        userId: authUserId,
        tenantId: tenant.id,
        roles: [...u.roles],
        status: "active",
        jobTitle: u.displayName,
      })
      .onConflictDoNothing();

    console.log(`  seeded ${u.email} (roles=${u.roles.join(",")})`);
  }

  console.log("\nDone. Login credentials:");
  console.log(`  password: ${TEST_PASSWORD}`);
  for (const u of TEST_USERS) console.log(`  email:    ${u.email}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
