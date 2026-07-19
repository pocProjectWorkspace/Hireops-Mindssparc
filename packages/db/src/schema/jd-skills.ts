import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  unique,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { jdVersions } from "./jd-versions";

/**
 * Skills + weights for a JD version. Free-text skill names (no canonical
 * registry yet) — AI matching layer canonicalises if/when needed.
 *
 * Per requirements.md §5.2: "Per-role weights set by HM. Must persist in
 * jd_skills." The shape is intentionally simple — weight + required flag
 * is enough for AI scoring downstream.
 */
export const jdSkills = pgTable(
  "jd_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jdVersionId: uuid("jd_version_id").notNull(),
    skillName: text("skill_name").notNull(),
    category: text("category"),
    weight: numeric("weight", { precision: 4, scale: 2 }).notNull().default("1.00"),
    isRequired: boolean("is_required").notNull().default(false),
    // RO-02 (migration 0080): additive per-skill metadata for the wizard v2
    // skill-weighting step. Both NULLABLE — pre-RO-02 inserts are unaffected.
    // min_years_experience is captured for interviewers + future scoring; the
    // current AI evaluator reads OVERALL years of experience via knockouts,
    // not per-skill minimums. notes is advisory free text (no parser).
    minYearsExperience: integer("min_years_experience"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_jd_skill_unique").on(table.jdVersionId, table.skillName),
    unique("uniq_jd_skills_tenant_id_id").on(table.tenantId, table.id),
    check("jd_skill_weight_check", sql`${table.weight} >= 0`),
    foreignKey({
      columns: [table.tenantId, table.jdVersionId],
      foreignColumns: [jdVersions.tenantId, jdVersions.id],
      name: "fk_jd_skills_jd_version",
    }).onDelete("cascade"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type JdSkill = typeof jdSkills.$inferSelect;
export type NewJdSkill = typeof jdSkills.$inferInsert;
