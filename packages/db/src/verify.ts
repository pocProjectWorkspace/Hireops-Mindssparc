import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// .env lives at the workspace root — load BEFORE importing client.ts
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

async function verify() {
  // Dynamic imports so dotenv loads before client.ts reads process.env
  const { db } = await import("./client");
  const { tenants, tenantEncryptionKeys } = await import("./schema");

  const tenantsList = await db.select().from(tenants);
  console.log(`Found ${tenantsList.length} tenant(s):`);
  for (const t of tenantsList) {
    console.log(`  - ${t.slug} (${t.id}): ${t.displayName} [${t.status}, ${t.primaryRegion}]`);
  }

  const keysList = await db.select().from(tenantEncryptionKeys);
  console.log(`Found ${keysList.length} encryption key record(s).`);

  if (tenantsList.length > 0 && keysList.length === tenantsList.length) {
    console.log("\nFND-15a verification: PASS");
  } else {
    console.log("\nFND-15a verification: FAIL");
    process.exit(1);
  }
}

verify()
  .catch((err) => {
    console.error("Verification failed:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
