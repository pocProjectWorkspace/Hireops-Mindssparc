/**
 * Diagnoses why the Custom Access Token hook isn't injecting claims.
 *
 * Calls the hook function directly with a simulated event payload, using the
 * postgres superuser (DIRECT_URL). If the function works in isolation, the
 * problem is dashboard-side (hook not registered or wrong function selected).
 * If the function errors here, we have a function-side bug to fix.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

import postgres from "postgres";

const TEST_USER_EMAIL = "test-fnd15b@hireops-dev.local";

async function main() {
  const directUrl = process.env.DIRECT_URL;
  if (!directUrl) {
    throw new Error("DIRECT_URL is not set in .env");
  }
  const sql = postgres(directUrl, { max: 1 });

  // Find our test user's id from auth.users
  const userRows = await sql<{ id: string }[]>`
    SELECT id FROM auth.users WHERE email = ${TEST_USER_EMAIL}
  `;
  const firstUser = userRows[0];
  if (!firstUser) {
    console.error(`No auth.users row for ${TEST_USER_EMAIL} — run db:test:setup first.`);
    process.exit(1);
  }
  const userId = firstUser.id;
  console.log(`Test user_id: ${userId}`);

  // Build a minimal event payload that mirrors what Supabase Auth would send
  const event = {
    user_id: userId,
    claims: {
      iss: "https://iertkrvobpplahhrksnn.supabase.co/auth/v1",
      sub: userId,
      aud: "authenticated",
      role: "authenticated",
    },
  };

  console.log("\nCalling public.custom_access_token_hook(event)...");
  const hookRows = await sql<{ result: unknown }[]>`
    SELECT public.custom_access_token_hook(${sql.json(event)}::jsonb) AS result
  `;
  const firstHook = hookRows[0];
  if (!firstHook) {
    throw new Error("Hook returned no rows");
  }
  console.log("Hook returned:");
  console.log(JSON.stringify(firstHook.result, null, 2));

  // Was the membership lookup successful?
  console.log("\nChecking membership rows for the test user...");
  const memberships = await sql`
    SELECT m.id, m.tenant_id, m.roles, m.status, t.slug, t.status AS tenant_status
    FROM public.tenant_user_memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
    WHERE m.user_id = ${userId}
  `;
  console.log(`Found ${memberships.length} membership(s):`);
  for (const m of memberships) {
    console.log(JSON.stringify(m, null, 2));
  }

  // Check the user's metadata
  console.log("\nChecking auth.users.raw_user_meta_data for the test user...");
  const userMeta = await sql<{ raw_user_meta_data: unknown }[]>`
    SELECT raw_user_meta_data FROM auth.users WHERE id = ${userId}
  `;
  console.log(JSON.stringify(userMeta[0]?.raw_user_meta_data, null, 2));

  await sql.end();
}

main()
  .catch((err) => {
    console.error("Diagnostic failed:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
