import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { persons } from "./persons";
import { applicationSourceEnum } from "./application-source";

/**
 * Recruitment-side lifecycle record. One per person per tenant in Wave 1
 * (enforced by the partial unique index below). Lifting this to allow
 * multiple candidate rows per person — for re-entries to the pipeline
 * months/years later — is a Wave 2 design question.
 *
 * talent_pool_consent_expires_at defaults (in app code) to consent_granted_at
 * + 24 months per requirements.md §10.3. App-level concern; not a DB
 * constraint.
 *
 * parsed_skills is opaque jsonb until the parser output schema stabilises.
 *
 * RLS: standard tenant_isolation. Trigger: audit_record_change() fires.
 */
export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    source: applicationSourceEnum("source").notNull(),
    consentGrantedAt: timestamp("consent_granted_at", { withTimezone: true }),
    consentVersion: text("consent_version"),
    talentPoolConsent: boolean("talent_pool_consent").notNull().default(false),
    talentPoolConsentExpiresAt: timestamp("talent_pool_consent_expires_at", {
      withTimezone: true,
    }),
    currentResumeUrl: text("current_resume_url"),
    parsedSkills: jsonb("parsed_skills"),
    yearsOfExperience: numeric("years_of_experience", { precision: 4, scale: 1 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_candidates_tenant_id_id").on(table.tenantId, table.id),
    // One candidate per person per tenant in Wave 1. Partial WHERE
    // person_id IS NOT NULL guards against future schema changes that
    // might allow a candidate to exist before a person is resolved.
    uniqueIndex("uniq_candidates_one_per_person")
      .on(table.tenantId, table.personId)
      .where(sql`person_id IS NOT NULL`),
    // Sourcing analytics: candidates per channel over time.
    index("idx_candidates_source").on(table.tenantId, table.source, table.createdAt),
    // Talent pool sweeps: only rows with active consent are interesting.
    index("idx_candidates_talent_pool")
      .on(table.tenantId, table.talentPoolConsent, table.talentPoolConsentExpiresAt)
      .where(sql`talent_pool_consent = true`),
    // Compound FK to persons (tenant_id, id) — the convention for every
    // cross-domain reference. Inline single-column references go only to
    // platform tables (tenants, users).
    foreignKey({
      columns: [table.tenantId, table.personId],
      foreignColumns: [persons.tenantId, persons.id],
      name: "fk_candidates_person",
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

export type Candidate = typeof candidates.$inferSelect;
export type NewCandidate = typeof candidates.$inferInsert;
