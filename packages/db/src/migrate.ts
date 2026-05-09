import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// .env lives at the workspace root
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
  throw new Error(
    "DIRECT_URL is not set. Add it to your .env file. This must be the direct connection (port 5432), not the pooler.",
  );
}

// Migration client: direct connection (session mode, port 5432)
// `max: 1` ensures a single connection for migration safety
const migrationClient = postgres(directUrl, { max: 1 });

async function runMigrations() {
  console.log("Running migrations...");
  await migrate(drizzle(migrationClient), { migrationsFolder: "./drizzle/migrations" });
  console.log("Migrations completed.");
  await migrationClient.end();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
