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

const TEST_PASSWORD = "TestPassword123!";

/**
 * The persona addresses moved off the client-branded `@mindssparc.com` so the
 * platform can be demonstrated to a room that is not Kyndryl. The TENANT SLUG is
 * still `kyndryl-poc` — that is a database key with rows hanging off it, and
 * renaming it is a different, much larger job.
 *
 * MIGRATE, DO NOT RECREATE. Every persona's auth.users.id is FK'd by a
 * tenant_user_membership, and those membership ids are hardcoded in the demo
 * seeds (seed-analytics-demo, seed-learning-demo, …) as the owners of
 * requisitions, offers, interviews and onboarding cases. Creating fresh users on
 * the new domain would mint new ids, orphan every one of those relationships,
 * and leave someone logging in as admin1@mindssparc.com looking at an empty
 * platform. So when a persona exists on the OLD domain we rename that user in
 * place and keep its id.
 *
 * The rename goes through the Admin API rather than SQL because the address is
 * stored twice — auth.users.email AND auth.identities.identity_data->>'email' —
 * and updateUserById keeps both in step.
 */
const LEGACY_EMAIL_DOMAIN = "kyndryl-poc.test";

/** The same local part on the legacy domain, for the rename lookup. */
function legacyEmailFor(email: string): string {
  return `${email.split("@")[0]}@${LEGACY_EMAIL_DOMAIN}`;
}

const TEST_USERS = [
  {
    email: "recruiter1@mindssparc.com",
    displayName: "Test Recruiter",
    roles: ["recruiter"] as const,
  },
  {
    email: "hr_ops1@mindssparc.com",
    displayName: "Test HR Ops",
    roles: ["hr_ops"] as const,
  },
  {
    email: "admin1@mindssparc.com",
    displayName: "Test Admin",
    roles: ["admin"] as const,
  },
  {
    // REQ-01 (Wave A): the requisition-owner persona. The prototype's
    // "requirement_owner" = our hiring_manager role.
    email: "hiringmanager1@mindssparc.com",
    displayName: "Test Hiring Manager",
    roles: ["hiring_manager"] as const,
  },
  {
    // REQ-01 (Wave A): the HR-head approval persona (REQ-03 wires the queue).
    email: "hrhead1@mindssparc.com",
    displayName: "Test HR Head",
    roles: ["hr_head"] as const,
  },
  {
    // INT-03 (Wave B): the panel/interviewer persona. Sees "My interviews",
    // opens the candidate brief, submits ONE scorecard per interview.
    email: "panel1@mindssparc.com",
    displayName: "Test Panelist",
    roles: ["panel_member"] as const,
  },
] as const;

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
    process.exit(2);
  }

  // Dynamic imports so dotenv (above) loads before client.ts evaluates
  // DATABASE_URL at module init. Same pattern as provision-dev-dek.ts.
  const { createClient } = await import("@supabase/supabase-js");
  const { eq } = await import("drizzle-orm");
  // poolSql is the postgres-js pool the drizzle `db` sits on; close it in the
  // finally so the script exits promptly instead of hanging on idle
  // connections (the documented pooler-hang class).
  const { db, sql: poolSql } = await import("../client");
  const { users, tenantUserMemberships, tenants } = await import("../schema");

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const [tenant] = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.slug, "kyndryl-poc"))
      .limit(1);
    if (!tenant) {
      console.error("kyndryl-poc tenant not found; run db:migrate first (and seed the tenant).");
      process.exit(2);
    }

    // One listing serves every persona below — both the "already registered"
    // path and the legacy-domain rename lookup.
    const roster = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const byEmail = new Map(
      (roster.data?.users ?? []).map((x) => [(x.email ?? "").toLowerCase(), x] as const),
    );

    for (const u of TEST_USERS) {
      let authUserId: string | null = null;

      const onNewDomain = byEmail.get(u.email.toLowerCase());
      const onLegacyDomain = byEmail.get(legacyEmailFor(u.email).toLowerCase());

      if (onNewDomain) {
        authUserId = onNewDomain.id;
        console.log(`  reused auth user ${u.email} → ${authUserId}`);
      } else if (onLegacyDomain) {
        // RENAME IN PLACE. Keeping the id is the whole point — see the note on
        // LEGACY_EMAIL_DOMAIN. updateUserById also rewrites auth.identities, which a
        // direct SQL UPDATE would miss.
        const renamed = await admin.auth.admin.updateUserById(onLegacyDomain.id, {
          email: u.email,
          email_confirm: true,
        });
        if (renamed.error) {
          console.error(
            `  failed to rename ${legacyEmailFor(u.email)} → ${u.email}: ${renamed.error.message}`,
          );
          process.exit(1);
        }
        authUserId = onLegacyDomain.id;
        console.log(
          `  renamed ${legacyEmailFor(u.email)} → ${u.email} (id ${authUserId} preserved)`,
        );
      } else {
        const created = await admin.auth.admin.createUser({
          email: u.email,
          password: TEST_PASSWORD,
          email_confirm: true,
        });
        if (created.data?.user?.id) {
          authUserId = created.data.user.id;
          console.log(`  created auth user ${u.email} → ${authUserId}`);
        } else {
          console.error(`  failed to create ${u.email}: ${created.error?.message ?? "unknown"}`);
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
  } finally {
    await poolSql.end({ timeout: 10 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
