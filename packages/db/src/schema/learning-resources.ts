import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * learning_resources — the tenant's curated catalogue of LEARNING POINTERS
 * (LD-1A).
 *
 * HireOps ORCHESTRATES learning, it does not author or host it. Every row is a
 * pointer at material that already lives somewhere else: a Workday Learning /
 * LinkedIn Learning / Cornerstone deep link, a SharePoint or Drive document, an
 * unlisted video, a Confluence page. `url` IS the payload — HireOps stores no
 * media and file upload is deliberately out of scope (that would be authoring,
 * and would need blob storage plus streaming).
 *
 * `external_ref` is the provider-side course id — the seam a future Workday
 * Learning connector writes/reads through. Nothing consumes it yet; it exists so
 * the integration does not need a migration later.
 *
 * `provider` is text + CHECK (NOT a new pgEnum) — house convention.
 *
 * unique(tenant_id, title) is the idempotent upsert key (same convention as
 * jd_templates), so a seed or a re-run of upsertLearningResource collapses onto
 * one row instead of duplicating the catalogue.
 *
 * Resources are ARCHIVED, never deleted: learning_track_items compound-FK them
 * ON DELETE RESTRICT, and onboarding tasks already pushed onto a hire's case
 * carry the resource id in `metadata` and must keep resolving.
 *
 * Tenant-scoped + tenant_isolation + FORCE RLS + audit_record_change trigger
 * (companions in 0111), the same treatment as every other tenant-editable
 * config table (jd_templates / comp_bands / panel_pools).
 */
export const learningResources = pgTable(
  "learning_resources",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),

    tenantId: uuid("tenant_id").notNull(),

    title: text("title").notNull(),
    description: text("description"),

    // workday_learning | linkedin_learning | cornerstone | internal_doc |
    // video | link | other.
    provider: text("provider").notNull(),

    /** The pointer. Orchestration means this is the payload. */
    url: text("url").notNull(),

    /** Provider-side course id — the Workday Learning seam. */
    externalRef: text("external_ref"),

    /** Drives "≈4h of induction" summaries. Null when unknown. */
    estimatedMinutes: integer("estimated_minutes"),

    isArchived: boolean("is_archived").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),

    createdByMembershipId: uuid("created_by_membership_id"),
    updatedByMembershipId: uuid("updated_by_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Compound unique enables compound (tenant_id, id) FKs from peer tables —
    // learning_track_items.resource_id (DB-TENANT-FK).
    unique("uniq_learning_resources_tenant_id_id").on(table.tenantId, table.id),
    // The idempotent upsert key (the jd_templates convention).
    unique("uniq_learning_resources_tenant_title").on(table.tenantId, table.title),

    index("idx_learning_resources_tenant").on(table.tenantId),

    check(
      "learning_resources_provider_check",
      sql`${table.provider} IN ('workday_learning', 'linkedin_learning', 'cornerstone', 'internal_doc', 'video', 'link', 'other')`,
    ),
    check(
      "learning_resources_estimated_minutes_check",
      sql`${table.estimatedMinutes} IS NULL OR ${table.estimatedMinutes} >= 0`,
    ),

    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "learning_resources_tenant_id_fkey",
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

export type LearningResource = typeof learningResources.$inferSelect;
export type NewLearningResource = typeof learningResources.$inferInsert;
