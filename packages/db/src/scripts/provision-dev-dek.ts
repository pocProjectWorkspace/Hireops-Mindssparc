/**
 * One-shot script to upgrade the kyndryl-poc tenant's placeholder DEK to a
 * real envelope-encrypted DEK via the local KMS.
 *
 * Idempotent: if the existing row's kms_key_id matches the current KMS
 * client's keyId (e.g. "local:v1"), the script reports "already
 * provisioned" and exits without writes.
 *
 * Run with: pnpm db:provision:dev-dek
 */

import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(here, "../../../../.env") });

const TARGET_TENANT_SLUG = "kyndryl-poc";

async function main(): Promise<void> {
  // Dynamic imports so dotenv loads first; client.ts reads DATABASE_URL at
  // module init and KMS reads SUPABASE_KEK_SECRET.
  const { eq } = await import("drizzle-orm");
  const { db, sql: poolSql } = await import("../client");
  const { tenantEncryptionKeys } = await import("../schema/tenant-encryption-keys");
  const { tenants } = await import("../schema/tenants");
  const { getKmsClient } = await import("../kms");
  const { generateDek, wrapDek } = await import("../envelope");

  // poolSql is the connection we close in finally.

  try {
    const kms = getKmsClient();
    console.log(`KMS provider: ${kms.kmsKeyId}`);

    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, TARGET_TENANT_SLUG))
      .limit(1);
    if (!tenant) {
      throw new Error(`Tenant ${TARGET_TENANT_SLUG} not found. Did FND-15a seed run?`);
    }
    console.log(`Tenant ${tenant.slug}: ${tenant.id}`);

    const [existing] = await db
      .select()
      .from(tenantEncryptionKeys)
      .where(eq(tenantEncryptionKeys.tenantId, tenant.id))
      .limit(1);

    if (!existing) {
      const dek = generateDek();
      const wrapped = await wrapDek(dek, kms);
      await db.insert(tenantEncryptionKeys).values({
        tenantId: tenant.id,
        encryptedDek: Buffer.from(wrapped.encryptedDek),
        kmsKeyId: wrapped.kmsKeyId,
      });
      console.log(`Provisioned new DEK (no prior row); kms_key_id=${wrapped.kmsKeyId}`);
    } else if (existing.kmsKeyId === kms.kmsKeyId) {
      console.log(`Already provisioned: kms_key_id=${existing.kmsKeyId}. No changes.`);
    } else {
      console.log(
        `Replacing placeholder DEK (kms_key_id="${existing.kmsKeyId}") with a real wrapped DEK.`,
      );
      const dek = generateDek();
      const wrapped = await wrapDek(dek, kms);
      await db
        .update(tenantEncryptionKeys)
        .set({
          encryptedDek: Buffer.from(wrapped.encryptedDek),
          kmsKeyId: wrapped.kmsKeyId,
          rotatedAt: new Date(),
        })
        .where(eq(tenantEncryptionKeys.tenantId, tenant.id));
      console.log(`Provisioned real DEK; kms_key_id=${wrapped.kmsKeyId}`);
    }
  } finally {
    await poolSql.end({ timeout: 2 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
