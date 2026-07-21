import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { hrPolicyDocuments } from "./hr-policy-documents";

/**
 * hr_policy_document_versions — the immutable version history of a policy
 * (T12/G10).
 *
 * Every time a policy is created or edited, a full content snapshot is appended
 * here: the version number, the title/category/summary/body as they stood, an
 * optional change note, and who edited it. This IS the governance record for
 * policy content changes (hr_policy_documents deliberately carries no
 * row-change trigger — see its header), and it powers the "Version history"
 * viewer on /hr-policies. Append-only: rows are never updated or deleted in the
 * normal flow, they cascade only when the parent policy or tenant is removed.
 *
 * Tenant-scoped + FORCE RLS + tenant_isolation, like every sibling tenant
 * table. No audit_record_change trigger — the table is itself the history, so
 * a trigger would only duplicate the signal.
 *
 * unique(tenant_id, policy_document_id, version) keeps one snapshot per version.
 */
export const hrPolicyDocumentVersions = pgTable(
  "hr_policy_document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    policyDocumentId: uuid("policy_document_id")
      .notNull()
      .references(() => hrPolicyDocuments.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    bodyMd: text("body_md").notNull(),
    changeNote: text("change_note"),
    editedByMembershipId: uuid("edited_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_policy_doc_versions_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_hr_policy_doc_versions_doc_version").on(
      table.tenantId,
      table.policyDocumentId,
      table.version,
    ),
    index("idx_hr_policy_doc_versions_doc").on(table.tenantId, table.policyDocumentId),

    check("hr_policy_doc_versions_version_check", sql`${table.version} >= 1`),
    check(
      "hr_policy_doc_versions_category_check",
      sql`${table.category} IN ('offers', 'benefits', 'policies')`,
    ),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type HrPolicyDocumentVersion = typeof hrPolicyDocumentVersions.$inferSelect;
export type NewHrPolicyDocumentVersion = typeof hrPolicyDocumentVersions.$inferInsert;
