import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  integer,
  timestamp,
  uniqueIndex,
  index,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * document_types — onboarding document-type definitions (PAN, Aadhaar,
 * BIR 2316, …). They drive the document-upload UI (filtered by the case's
 * `geography_code`) and the per-category retention policy
 * (`retention_years`). See requirements.md §7.1.
 *
 * Two kinds of row (migration 0132, C1-BUGS BUG-4):
 *   - `tenant_id IS NULL` — platform type: country-statutory or generic
 *     catalogue entries every tenant sees (seeded by migration).
 *   - `tenant_id = <tenant>` — a tenant's own type, visible only to it. A
 *     tenant type may reuse a platform code; readers prefer the tenant row.
 *
 * `geography_code` is nullable: NULL means the type applies to every
 * geography; a CHAR(2) ISO code (IN, PH) scopes country-specific types.
 * `required_for_lifecycle_stage = 'pre_boarding'` auto-adds a collection
 * task to every new case; NULL means requestable only.
 *
 * RLS: `tenant_isolation_select` lets an authenticated caller read platform
 * rows + its own tenant's rows. Writes are migration / service-role only.
 * Service-role readers (poolSql) MUST filter `tenant_id IS NULL OR
 * tenant_id = <tenant>` explicitly.
 */
export const documentTypes = pgTable(
  "document_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    geographyCode: char("geography_code", { length: 2 }),
    requiredForLifecycleStage: text("required_for_lifecycle_stage"),
    retentionYears: integer("retention_years"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uniq_document_types_platform_code")
      .on(table.code)
      .where(sql`${table.tenantId} IS NULL`),
    uniqueIndex("uniq_document_types_tenant_code")
      .on(table.tenantId, table.code)
      .where(sql`${table.tenantId} IS NOT NULL`),
    index("idx_document_types_tenant").on(table.tenantId),

    pgPolicy("tenant_isolation_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`tenant_id IS NULL OR tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type DocumentType = typeof documentTypes.$inferSelect;
export type NewDocumentType = typeof documentTypes.$inferInsert;
