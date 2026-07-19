import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * hr_policy_documents — the curated templates & policies library (HROPS-03).
 *
 * Read-only reference content surfaced on /hr-policies: standard offer letter,
 * health-insurance policy, leave policy, probation guidelines, relocation
 * allowance, employee referral program. Tenant-scoped (each tenant owns its
 * own library) so it carries the standard tenant_isolation policy — unlike the
 * platform-wide document_types reference table which has no tenant_id.
 *
 * Content is CURATED REFERENCE material (labelled as such in the UI), seeded by
 * db:seed:hr-policies with India-appropriate, labour-law-neutral wording. It is
 * NOT legal advice and NOT AI-generated. body_md is Markdown rendered read-only
 * in the View panel.
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
