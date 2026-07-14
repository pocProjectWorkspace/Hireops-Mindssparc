import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { onboardingCases } from "./onboarding-cases";
import { documentTypes } from "./document-types";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * onboarding_documents — metadata for an uploaded onboarding document
 * (architecture.md §5.1: "KMS-encrypted document blob *metadata*; FK
 * document_type_id → document_types"). The blob itself lives in object
 * storage; `storage_ref` is the pointer and `encryption_key_ref` names
 * the KMS/DEK used to encrypt it — no blob bytes are stored in Postgres.
 *
 * Each upload carries a `verification_status` (requirements.md §7.1 —
 * "Each with verification status"); text + CHECK, same rationale as the
 * other onboarding tables (HANDOVER reality #114).
 *
 * `document_type_id` is a SINGLE-column FK to document_types — that table
 * is tenant-agnostic and has no tenant_id, so the compound-tenant-FK
 * pattern cannot apply here (cf. the single-column FKs in reality #63).
 * Tenant integrity is still enforced via this row's own tenant_id and the
 * compound FK back to onboarding_cases.
 */
export const onboardingDocuments = pgTable(
  "onboarding_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull(),
    documentTypeId: uuid("document_type_id")
      .notNull()
      .references(() => documentTypes.id, { onDelete: "restrict" }),

    storageRef: text("storage_ref").notNull(),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    encryptionKeyRef: text("encryption_key_ref"),

    verificationStatus: text("verification_status").notNull().default("pending"),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),

    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_onboarding_documents_tenant_id_id").on(table.tenantId, table.id),

    index("idx_onboarding_documents_case").on(table.tenantId, table.caseId),
    index("idx_onboarding_documents_type").on(table.tenantId, table.documentTypeId),
    index("idx_onboarding_documents_verification").on(table.tenantId, table.verificationStatus),

    check(
      "onboarding_documents_verification_status_check",
      sql`${table.verificationStatus} IN ('pending', 'verified', 'rejected', 'resubmit_required')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.caseId],
      foreignColumns: [onboardingCases.tenantId, onboardingCases.id],
      name: "fk_onboarding_documents_case",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.verifiedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_onboarding_documents_verified_by",
    }).onDelete("restrict"),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type OnboardingDocument = typeof onboardingDocuments.$inferSelect;
export type NewOnboardingDocument = typeof onboardingDocuments.$inferInsert;
