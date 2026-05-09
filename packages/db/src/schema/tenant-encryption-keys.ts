import { pgTable, uuid, text, customType, timestamp } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

// BYTEA custom type — Drizzle's bytea handling via postgres-js
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const tenantEncryptionKeys = pgTable("tenant_encryption_keys", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  encryptedDek: bytea("encrypted_dek").notNull(), // TODO FND-15d: real DEK wrapped by KMS master KEK; placeholder for now
  kmsKeyId: text("kms_key_id").notNull(), // which master key wrapped this DEK
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  rotationStatus: text("rotation_status"), // NULL | 'rotating' | 'failed'
});

export type TenantEncryptionKey = typeof tenantEncryptionKeys.$inferSelect;
export type NewTenantEncryptionKey = typeof tenantEncryptionKeys.$inferInsert;
