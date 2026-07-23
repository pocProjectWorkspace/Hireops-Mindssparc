import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  unique,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * tenant_scorecard_template — CUSTOM scorecard VALUES (T2.2 / G07).
 *
 * WHY THIS TABLE EXISTS (read this — it is the other half of the T2.2 gap):
 * The scorecard rubric shown to (and validated against) a panelist was a FIXED
 * code constant keyed by one of 4 template names (SCORECARD_CRITERIA in
 * @hireops/api-types). An org could not define its own scorecard values. This
 * table holds a tenant's own scorecard keys, each with a `label` and an ordered
 * `criteria` jsonb array ([{key,label}, ...] — the ScorecardCriterion shape).
 *
 * HONESTY — custom criteria actually DRIVE the assessment: resolveScorecardCriteria
 * consumes these; the resolved criteria (tenant custom OR the 4 code defaults) are
 * SNAPSHOT onto interviews.scorecard_criteria_snapshot at schedule time, and the
 * panel scorecard form renders + validates against that snapshot. The custom
 * criteria genuinely gate the assessment, they are not stored-and-ignored config.
 *
 * `scorecardKey` is text with a lax SHAPE check (snake_case, ≤64); it may NOT
 * collide with the 4 reserved code-default keys (enforced in the procedure).
 *
 * One row per (tenant, scorecard_key) — the upsert / seed conflict target.
 * Tenant-scoped + FORCE RLS + audit trigger (companions in 0103).
 */
export const tenantScorecardTemplate = pgTable(
  "tenant_scorecard_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),

    // The tenant-defined scorecard key (snake_case, not one of the 4 reserved
    // code defaults — that collision is rejected in the procedure).
    scorecardKey: text("scorecard_key").notNull(),
    // Human label for the scorecard (shown in the plan editor's picker).
    label: text("label").notNull(),
    // Ordered rubric criteria: [{ key, label }, ...] — the ScorecardCriterion
    // shape. Validated in the procedure at write (>=1, each key snake_case).
    criteria: jsonb("criteria").notNull().default([]),

    // Membership id of the admin who last saved this row (audit convenience).
    updatedBy: uuid("updated_by"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_tenant_scorecard_template_tenant_id_id").on(table.tenantId, table.id),
    // One row per scorecard key per tenant — the upsert / seed conflict target.
    unique("uniq_tenant_scorecard_template_tenant_key").on(table.tenantId, table.scorecardKey),

    index("idx_tenant_scorecard_template_tenant").on(table.tenantId),

    check("tenant_scorecard_template_key_check", sql`${table.scorecardKey} ~ '^[a-z0-9_]{1,64}$'`),

    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type TenantScorecardTemplateRow = typeof tenantScorecardTemplate.$inferSelect;
export type NewTenantScorecardTemplateRow = typeof tenantScorecardTemplate.$inferInsert;
