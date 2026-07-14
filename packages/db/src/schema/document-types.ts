import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  integer,
  timestamp,
  unique,
  pgPolicy,
} from "drizzle-orm/pg-core";

/**
 * document_types — tenant-agnostic reference table (NO tenant_id).
 *
 * Rows are document-type *definitions* (PAN, Aadhaar, BIR 2316, …) shared
 * across every tenant. They drive two things: the document-upload UI
 * (rendered/filtered by the candidate's GCC `geography_code`) and the
 * per-category DPDPA retention policy (`retention_years`). See
 * requirements.md §7.1 and architecture.md §5.1 (onboarding group).
 *
 * `geography_code` is nullable: NULL means the type applies to every
 * geography (government ID, address proof, education certificate, bank
 * details); a CHAR(2) ISO code (IN, PH) scopes India-/Philippines-only
 * types.
 *
 * Access pattern (flagged in the hand-back): this is a platform/reference
 * table, so it is allowlisted in `lint-rls.ts` and cannot carry a
 * `tenant_isolation` policy (there is no tenant_id to key on). RLS is
 * enabled + FORCEd like every other table; a single permissive SELECT
 * policy lets any authenticated user *read* the reference rows, while
 * writes are reserved for the migration/service-role owner (rows are
 * seeded in migration). This mirrors the "readable reference, no
 * tenant scoping" shape rather than the default-deny stance of
 * tenant_encryption_keys / scheduled_job_runs (which authenticated
 * callers never read).
 */
export const documentTypes = pgTable(
  "document_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    geographyCode: char("geography_code", { length: 2 }),
    requiredForLifecycleStage: text("required_for_lifecycle_stage"),
    retentionYears: integer("retention_years"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_document_types_code").on(table.code),

    pgPolicy("reference_read", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`true`,
    }),
  ],
).enableRLS();

export type DocumentType = typeof documentTypes.$inferSelect;
export type NewDocumentType = typeof documentTypes.$inferInsert;
