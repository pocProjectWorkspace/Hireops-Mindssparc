import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * jd_templates — the org's curated JD-template library (T12/G11).
 *
 * Replaces the hardcoded ROLE_TEMPLATES TS constant with a tenant-scoped,
 * org-editable table. The requisition wizard's "Quick start" preset row reads
 * from here (falling back to the seeded defaults when a tenant has none), and
 * admin + hiring_manager curate the library on /jd-library → Templates.
 *
 * A template pre-fills the wizard's Basics + Skills steps AND carries JD
 * boilerplate (`body_md`) plus an EEO / legal-clause block (`legal_clauses`).
 * Everything stays fully editable after applying — nothing here is
 * authoritative, and the clauses are curated, India-neutral starting text that
 * the platform has NOT had legally reviewed (labelled as such in the UI).
 *
 * Money: `budget_min_inr` / `budget_max_inr` are annual INR in MAJOR units
 * (rupees), matching positions.comp_band_* and the wizard's compBand fields —
 * NOT the paise/minor convention used by offers/benchmarks.
 *
 * `location_type` is text + CHECK (remote|hybrid|onsite|multi) to match
 * requisitions/positions vocabulary. `skills` is a jsonb array of
 * { skillName, category, weight, isRequired, minYears } — the RO-02 skill shape
 * the SkillWeightsEditor consumes.
 *
 * Tenant-scoped + FORCE RLS + tenant_isolation + audit_record_change trigger —
 * the same treatment as market_benchmarks (its closest sibling: curated,
 * tenant-editable, seeded reference data whose edits are audit-worthy).
 *
 * unique(tenant_id, title) is the idempotent upsert key for the seed.
 */
export const jdTemplates = pgTable(
  "jd_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    // Short chip label shown in the wizard's Quick-start row.
    label: text("label").notNull(),
    title: text("title").notNull(),
    roleFamily: text("role_family").notNull(),
    seniority: text("seniority").notNull(),
    locationType: text("location_type").notNull(),

    // Annual INR budget band in MAJOR units (rupees), fully editable hint.
    budgetMinInr: bigint("budget_min_inr", { mode: "number" }).notNull(),
    budgetMaxInr: bigint("budget_max_inr", { mode: "number" }).notNull(),

    // Steer text prefilled into the JD generator's extra-context box.
    extraContext: text("extra_context").notNull().default(""),
    // The JD boilerplate body (Markdown) and the EEO / legal clause block.
    bodyMd: text("body_md").notNull().default(""),
    legalClauses: text("legal_clauses").notNull().default(""),

    // [{ skillName, category, weight, isRequired, minYears }]
    skills: jsonb("skills")
      .notNull()
      .default(sql`'[]'::jsonb`),

    isArchived: boolean("is_archived").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),

    createdByMembershipId: uuid("created_by_membership_id"),
    updatedByMembershipId: uuid("updated_by_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_jd_templates_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_jd_templates_tenant_title").on(table.tenantId, table.title),
    index("idx_jd_templates_tenant").on(table.tenantId),

    check(
      "jd_templates_location_type_check",
      sql`${table.locationType} IN ('remote', 'hybrid', 'onsite', 'multi')`,
    ),
    check("jd_templates_budget_min_check", sql`${table.budgetMinInr} >= 0`),
    check("jd_templates_budget_max_check", sql`${table.budgetMaxInr} >= 0`),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type JdTemplate = typeof jdTemplates.$inferSelect;
export type NewJdTemplate = typeof jdTemplates.$inferInsert;
