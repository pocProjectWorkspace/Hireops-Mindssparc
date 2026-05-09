import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

import postgres from "postgres";

async function main() {
  const directUrl = process.env.DIRECT_URL;
  if (!directUrl) {
    throw new Error("DIRECT_URL is not set in .env");
  }
  const sql = postgres(directUrl, { max: 1 });

  // 1. tenant_user_memberships table
  const tableExists = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'tenant_user_memberships'
    ) AS exists
  `;
  const tableRow = tableExists[0];
  if (!tableRow) {
    throw new Error("table existence query returned no rows");
  }
  console.log(`tenant_user_memberships table exists: ${tableRow.exists}`);

  // 2. FK from tenant_user_memberships.user_id → auth.users(id)
  const fkExists = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'tenant_user_memberships_user_id_fkey'
    ) AS exists
  `;
  const fkRow = fkExists[0];
  if (!fkRow) {
    throw new Error("FK existence query returned no rows");
  }
  console.log(`tenant_user_memberships_user_id_fkey FK exists: ${fkRow.exists}`);

  // 3. The three functions
  const functions = await sql<{ proname: string }[]>`
    SELECT proname FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND proname IN ('current_tenant_id', 'has_role', 'custom_access_token_hook')
    ORDER BY proname
  `;
  console.log(`Functions found: ${functions.map((r) => r.proname).join(", ")}`);

  await sql.end();

  const allOk = tableRow.exists && fkRow.exists && functions.length === 3;

  if (allOk) {
    console.log("\nFND-15b objects verification: PASS");
  } else {
    console.log("\nFND-15b objects verification: FAIL");
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("Object verification failed:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
