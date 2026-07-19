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
import { applications } from "./applications";
import { documentTypes } from "./document-types";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * application_documents — PRE-OFFER document verification (HROPS-03).
 *
 * The recruiting-side twin of onboarding_documents: where onboarding docs
 * hang off an onboarding_case (post-accept), these hang off the APPLICATION
 * itself so hr_ops can request + verify identity/eligibility documents while
 * a candidate is still in the tech_interview → offer window. Same PII / RLS /
 * audit discipline as onboarding_documents (metadata only in Postgres; the
 * blob lives behind an opaque storage_ref, proxied + PII-logged on read).
 *
 * Lifecycle (status, text + CHECK, HANDOVER reality #114):
 *   requested → uploaded → verified | rejected
 * hr_ops REQUESTS a type (status='requested', no blob yet); the candidate
 * uploads (status='uploaded', storage_ref + file metadata set); hr_ops
 * verifies or rejects (rejection_reason required on reject; a re-upload from
 * rejected returns the row to 'uploaded').
 *
 * document_type_id is a SINGLE-column FK to the tenant-agnostic document_types
 * reference table (same shape as onboarding_documents — reality #63); tenant
 * integrity rests on this row's tenant_id + the compound FK to applications.
 *
 * One CURRENT row per (application, document_type): a partial history is out
 * of scope (matches onboarding_documents' "single current document" model), so
 * unique(tenant_id, application_id, document_type_id) makes request idempotent
 * and a re-upload replaces the blob in place.
 */
export const applicationDocuments = pgTable(
  "application_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").notNull(),
    documentTypeId: uuid("document_type_id")
      .notNull()
      .references(() => documentTypes.id, { onDelete: "restrict" }),

    status: text("status").notNull().default("requested"),
    rejectionReason: text("rejection_reason"),

    requestedByMembershipId: uuid("requested_by_membership_id"),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    storageRef: text("storage_ref"),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    encryptionKeyRef: text("encryption_key_ref"),

    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_application_documents_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_application_documents_app_type").on(
      table.tenantId,
      table.applicationId,
      table.documentTypeId,
    ),

    index("idx_application_documents_app").on(table.tenantId, table.applicationId),
    index("idx_application_documents_status").on(table.tenantId, table.status),

    check(
      "application_documents_status_check",
      sql`${table.status} IN ('requested', 'uploaded', 'verified', 'rejected')`,
    ),

    foreignKey({
      columns: [table.tenantId, table.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_application_documents_application",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.requestedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_application_documents_requested_by",
    }).onDelete("set null"),

    foreignKey({
      columns: [table.tenantId, table.verifiedByMembershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_application_documents_verified_by",
    }).onDelete("set null"),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type ApplicationDocument = typeof applicationDocuments.$inferSelect;
export type NewApplicationDocument = typeof applicationDocuments.$inferInsert;
