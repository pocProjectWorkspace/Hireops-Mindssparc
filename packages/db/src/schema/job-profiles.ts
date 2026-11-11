import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { jobFunctions } from "./job-functions";
import { jobLevels } from "./job-levels";
import { jdTemplates } from "./jd-templates";

/**
 * C1-F3 (0133) — job profiles, the centre of the job architecture (Plan A
 * §15 P2): title, function, level range (min..max, both optional — a
 * single-level profile sets only min or min = max), default JD template,
 * competencies [{ key, label }] and the canonical market title market data is
 * matched on (NULL = use `title`).
 *
 * The requisition wizard's profile picker pre-fills function / level / title /
 * competencies from here; the requisition keeps job_profile_id as provenance.
 * Deactivated, never deleted (RESTRICT FKs from positions / requisitions). The
 * JD-template link is SET NULL on that column only (jd_templates are
 * hard-deletable).
 */
export const jobProfiles = pgTable(
  "job_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    title: text("title").notNull(),
    jobFunctionId: uuid("job_function_id"),
    jobLevelMinId: uuid("job_level_min_id"),
    jobLevelMaxId: uuid("job_level_max_id"),
    defaultJdTemplateId: uuid("default_jd_template_id"),
    competencies: jsonb("competencies")
      .$type<{ key: string; label: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    canonicalMarketTitle: text("canonical_market_title"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_job_profiles_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_job_profiles_tenant_title").on(table.tenantId, table.title),
    index("idx_job_profiles_function").on(table.tenantId, table.jobFunctionId),
    check("job_profiles_title_check", sql`char_length(${table.title}) BETWEEN 2 AND 200`),
    check(
      "job_profiles_market_title_check",
      sql`${table.canonicalMarketTitle} IS NULL OR char_length(${table.canonicalMarketTitle}) BETWEEN 1 AND 200`,
    ),
    check("job_profiles_competencies_check", sql`jsonb_typeof(${table.competencies}) = 'array'`),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "job_profiles_tenant_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.jobFunctionId],
      foreignColumns: [jobFunctions.tenantId, jobFunctions.id],
      name: "fk_job_profiles_function",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.jobLevelMinId],
      foreignColumns: [jobLevels.tenantId, jobLevels.id],
      name: "fk_job_profiles_level_min",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.tenantId, table.jobLevelMaxId],
      foreignColumns: [jobLevels.tenantId, jobLevels.id],
      name: "fk_job_profiles_level_max",
    }).onDelete("restrict"),
    // The migration uses ON DELETE SET NULL ("default_jd_template_id") (PG15
    // column list, the 0113 precedent); drizzle can't express the column list,
    // so the schema declares the closest shape. The SQL is authoritative.
    foreignKey({
      columns: [table.tenantId, table.defaultJdTemplateId],
      foreignColumns: [jdTemplates.tenantId, jdTemplates.id],
      name: "fk_job_profiles_jd_template",
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

export type JobProfile = typeof jobProfiles.$inferSelect;
export type NewJobProfile = typeof jobProfiles.$inferInsert;
