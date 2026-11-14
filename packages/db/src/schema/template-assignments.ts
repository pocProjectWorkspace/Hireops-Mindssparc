import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * C2-F12 (0136) — applicability rules: "for template kind K use template T
 * when the requisition satisfies CONDITIONS" (Plan A §15 P3).
 *
 * `template_kind` is format-checked text; the kind list is the platform
 * constant TEMPLATE_KINDS in @hireops/api-types (applicability.ts).
 * `template_id` is the target row in that kind's own table (interview_loops,
 * tenant_scorecard_template, …) — polymorphic, so NO FK: the API validates it
 * at write and the resolver skips a vanished / inactive target.
 * `conditions` is an AND of typed predicates (applicabilityConditionsSchema);
 * '{}' = the default for that kind. Most specific match wins, then priority,
 * then newest.
 */
export const templateAssignments = pgTable(
  "template_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    templateKind: text("template_kind").notNull(),
    name: text("name").notNull(),
    templateId: uuid("template_id").notNull(),
    priority: integer("priority").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    conditions: jsonb("conditions")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_template_assignments_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_template_assignments_kind_name").on(
      table.tenantId,
      table.templateKind,
      table.name,
    ),
    index("idx_template_assignments_kind").on(table.tenantId, table.templateKind, table.isActive),
    index("idx_template_assignments_target").on(table.tenantId, table.templateId),
    check("template_assignments_kind_check", sql`${table.templateKind} ~ '^[a-z][a-z0-9_]{1,39}$'`),
    check("template_assignments_name_check", sql`char_length(${table.name}) BETWEEN 1 AND 120`),
    check("template_assignments_priority_check", sql`${table.priority} BETWEEN -1000 AND 1000`),
    check(
      "template_assignments_conditions_check",
      sql`jsonb_typeof(${table.conditions}) = 'object'`,
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

export type TemplateAssignment = typeof templateAssignments.$inferSelect;
export type NewTemplateAssignment = typeof templateAssignments.$inferInsert;
