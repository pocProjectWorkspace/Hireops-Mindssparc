import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// .env lives at the workspace root — load BEFORE importing client.ts
const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../.env") });

async function seed() {
  // Dynamic imports so dotenv loads before client.ts reads process.env
  const { db } = await import("./client");
  const { tenants, tenantEncryptionKeys } = await import("./schema");
  const { eq } = await import("drizzle-orm");

  console.log("Seeding development tenant...");

  // Idempotent: only insert if not already present
  const existing = await db.select().from(tenants).where(eq(tenants.slug, "kyndryl-poc"));
  if (existing.length > 0) {
    console.log("Tenant kyndryl-poc already exists, skipping seed.");
    return;
  }

  const [tenant] = await db
    .insert(tenants)
    .values({
      slug: "kyndryl-poc",
      displayName: "Kyndryl POC (Development)",
      primaryRegion: "ap-northeast-1", // dev region; production tenant will be ap-south-1
      status: "active",
      tier: "sandbox",
      onboardingStatus: "completed",
      activatedAt: new Date(),
      settings: {
        currency: "INR",
        timezone: "Asia/Kolkata",
        locale: "en-IN",
      },
    })
    .returning();

  if (!tenant) {
    throw new Error("Tenant insert returned no rows.");
  }

  // Placeholder DEK — real envelope encryption is FND-15d
  await db.insert(tenantEncryptionKeys).values({
    tenantId: tenant.id,
    encryptedDek: Buffer.from("PLACEHOLDER_DEK_FND_15D_WILL_REPLACE_THIS", "utf-8"),
    kmsKeyId: "placeholder/kms-key-id",
  });

  console.log(`Seeded tenant ${tenant.slug} with id ${tenant.id}`);
}

seed()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
