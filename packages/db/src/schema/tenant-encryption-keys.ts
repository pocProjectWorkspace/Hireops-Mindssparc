import { pgTable, uuid, text, customType, timestamp } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// BYTEA custom type — Drizzle's bytea handling via postgres-js
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

// RLS enabled with no policies → default-deny for `authenticated` per
// ADR-002 §5.5. `service_role` (BYPASSRLS) is the only legitimate path.
export const tenantEncryptionKeys = pgTable("tenant_encryption_keys", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  encryptedDek: bytea("encrypted_dek").notNull(), // tenant DEK wrapped by the active KMS master key (FND-15d)
  kmsKeyId: text("kms_key_id").notNull(), // which master key wrapped this DEK ('local:v1' for LocalKmsClient, ARN for AWS)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  rotationStatus: text("rotation_status"), // NULL | 'rotating' | 'failed'
}).enableRLS();

export type TenantEncryptionKey = typeof tenantEncryptionKeys.$inferSelect;
export type NewTenantEncryptionKey = typeof tenantEncryptionKeys.$inferInsert;
