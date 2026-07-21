import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * hr_policy_documents — the org's editable templates & policies library
 * (HROPS-03, made org-editable in T12/G10).
 *
 * Originally seeded READ-ONLY reference content surfaced on /hr-policies:
 * standard offer letter, health-insurance policy, leave policy, probation
 * guidelines, relocation allowance, employee referral program. As of T12 the
 * seeded set is the STARTING library — hr_ops + admin can now author, edit,
 * version, and archive their own policies through create/update/version/archive
 * mutations (see router.ts). Tenant-scoped (each tenant owns its own library),
 * carrying the standard tenant_isolation policy.
 *
 * The seeded content stays CURATED REFERENCE material (labelled as such in the
 * UI) written with India-appropriate, labour-law-neutral wording — NOT legal
 * advice and NOT AI-generated. body_md is Markdown, rendered in the View panel
 * and editable in the authoring panel.
 *
 * VERSIONING (T12): `version` is the current version number; each save appends
 * an immutable snapshot row to hr_policy_document_versions (the history log).
 * `is_archived` hides a policy from the default library without deleting it
 * (history is preserved). `updated_by_membership_id` stamps the last editor.
 *
 * AUDIT stance (unchanged from 0067): this table deliberately carries NO
 * row-change trigger — an idempotent seed re-run would spray audit noise. The
 * write mutations capture INTENT via withAudit (api_audit_logs), and
 * hr_policy_document_versions is itself the content-change history. It keeps
 * FORCE RLS + tenant isolation.
 *
 * unique(tenant_id, title) is the idempotent upsert key for the seed.
 */
export const hrPolicyDocuments = pgTable(
  "hr_policy_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    bodyMd: text("body_md").notNull(),
    // T12 — org-editable versioning + archive.
    version: integer("version").notNull().default(1),
    isArchived: boolean("is_archived").notNull().default(false),
    updatedByMembershipId: uuid("updated_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_hr_policy_documents_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_hr_policy_documents_tenant_title").on(table.tenantId, table.title),
    index("idx_hr_policy_documents_category").on(table.tenantId, table.category),

    check(
      "hr_policy_documents_category_check",
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

export type HrPolicyDocument = typeof hrPolicyDocuments.$inferSelect;
export type NewHrPolicyDocument = typeof hrPolicyDocuments.$inferInsert;
