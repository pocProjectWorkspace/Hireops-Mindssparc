import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { learningResources } from "./learning-resources";

/**
 * learning_skill_map — the engine behind layer 3 of the L&D ask, the
 * INDIVIDUAL'S capability gaps (LD-2A).
 *
 * Layers 1 and 2 (`learning_tracks`, LD-1A) are curated BUNDLES someone authors
 * once. Layer 3 is per-individual BY DEFINITION — nobody can pre-author it,
 * because it depends on the gap between THIS hire and THIS role. So the org
 * does not curate the plan; it curates
 *
 *       WHICH RESOURCE CLOSES WHICH SKILL
 *
 * and the system assembles the per-hire plan from the JD-vs-candidate skill
 * comparison HireOps already ran at application time — the same comparison the
 * Insights skill-gap chart draws (apps/api/src/lib/skill-match.ts).
 *
 * Hence a MAP, not a track: one row per (skill_name → resource).
 * `getSuggestedLearningForCase` derives a hire's missing skills, looks each up
 * here and returns SUGGESTIONS carrying the skill they close. It assigns
 * nothing — there stays exactly ONE way learning reaches a hire, the explicit
 * push (`assignLearningToCase`, LD-1A).
 *
 * `skill_name` is free text deliberately: it has to line up with the tenant's
 * own `jd_skills.skill_name` vocabulary, which is free text too. There is no FK
 * to a skills table because there is no skills table. The suggestion path
 * matches map rows to JD skills on the trimmed, lowercased name.
 *
 * unique(tenant_id, skill_name, resource_id) — a resource closes a given skill
 * at most once, and that pair is the idempotent upsert key.
 *
 * The resource FK is COMPOUND (tenant_id, resource_id) ON DELETE RESTRICT —
 * resources are archived, never deleted, and a compound FK cannot cleanly SET
 * NULL (HANDOVER reality #63). Archived resources are filtered OUT of the
 * suggestions (a retired link is never suggested at a hire) but stay mapped, so
 * un-archiving restores the mapping intact.
 *
 * Tenant-scoped + tenant_isolation + FORCE RLS + audit_record_change trigger
 * (companions in 0112), the same treatment as the catalogue it points into.
 */
export const learningSkillMap = pgTable(
  "learning_skill_map",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),

    tenantId: uuid("tenant_id").notNull(),

    /** Free text, matched to jd_skills.skill_name on trim+lowercase. */
    skillName: text("skill_name").notNull(),

    /** The catalogue row that closes this skill. */
    resourceId: uuid("resource_id").notNull(),

    sortOrder: integer("sort_order").notNull().default(0),

    createdByMembershipId: uuid("created_by_membership_id"),
    updatedByMembershipId: uuid("updated_by_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Compound unique keeps the (tenant_id, id) compound-FK pattern available
    // to any future peer table (DB-TENANT-FK).
    unique("uniq_learning_skill_map_tenant_id_id").on(table.tenantId, table.id),
    // A resource closes a given skill at most once — the upsert key.
    unique("uniq_learning_skill_map_skill_resource").on(
      table.tenantId,
      table.skillName,
      table.resourceId,
    ),

    index("idx_learning_skill_map_tenant").on(table.tenantId),
    // The read path is "given this hire's missing skills, what closes them?".
    index("idx_learning_skill_map_skill").on(table.tenantId, table.skillName),
    index("idx_learning_skill_map_resource").on(table.tenantId, table.resourceId),

    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "learning_skill_map_tenant_id_fkey",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [learningResources.tenantId, learningResources.id],
      name: "fk_learning_skill_map_resource",
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

export type LearningSkillMapping = typeof learningSkillMap.$inferSelect;
export type NewLearningSkillMapping = typeof learningSkillMap.$inferInsert;
