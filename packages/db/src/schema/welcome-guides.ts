import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  index,
  foreignKey,
  check,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { businessUnits } from "./business-units";
import { applications } from "./applications";

/**
 * PC-18 — pre-joining welcome guide per business unit (migration 0130).
 *
 * The SQL migration is the source of truth (hand-written; the NULLS NOT
 * DISTINCT uniques and the one-draft / one-published partial unique indexes
 * live only there). These definitions mirror it for typed reads; the welcome
 * guide code uses raw postgres.js with an explicit tenant_id.
 *
 * business_unit_id NULL = the organisation-wide default.
 */

const tenantIsolation = () =>
  pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    to: ["authenticated"],
    using: sql`tenant_id = current_tenant_id()`,
    withCheck: sql`tenant_id = current_tenant_id()`,
  });

export const welcomeGuideSources = pgTable(
  "welcome_guide_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id"),
    overview: text("overview").notNull().default(""),
    leaders: jsonb("leaders")
      .notNull()
      .default(sql`'[]'::jsonb`),
    culture: text("culture").notNull().default(""),
    firstWeek: text("first_week").notNull().default(""),
    links: jsonb("links")
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedByMembershipId: uuid("updated_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_welcome_guide_sources_tenant_id_id").on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.businessUnitId],
      foreignColumns: [businessUnits.tenantId, businessUnits.id],
      name: "fk_welcome_guide_sources_business_unit",
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
).enableRLS();

export const welcomeGuides = pgTable(
  "welcome_guides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    businessUnitId: uuid("business_unit_id"),
    version: integer("version").notNull(),
    /** draft | published | superseded | discarded */
    status: text("status").notNull().default("draft"),
    content: jsonb("content").notNull(),
    groundingReport: jsonb("grounding_report")
      .notNull()
      .default(sql`'{"dropped":[]}'::jsonb`),
    sourceSnapshot: jsonb("source_snapshot")
      .notNull()
      .default(sql`'{}'::jsonb`),
    model: text("model"),
    promptVersion: text("prompt_version"),
    generatedByMembershipId: uuid("generated_by_membership_id"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editedByMembershipId: uuid("edited_by_membership_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByMembershipId: uuid("published_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_welcome_guides_tenant_id_id").on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.businessUnitId],
      foreignColumns: [businessUnits.tenantId, businessUnits.id],
      name: "fk_welcome_guides_business_unit",
    }).onDelete("cascade"),
    check(
      "welcome_guides_status_check",
      sql`${t.status} IN ('draft', 'published', 'superseded', 'discarded')`,
    ),
    tenantIsolation(),
  ],
).enableRLS();

export const welcomeGuideViews = pgTable(
  "welcome_guide_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    guideId: uuid("guide_id").notNull(),
    applicationId: uuid("application_id").notNull(),
    section: text("section").notNull(),
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uniq_welcome_guide_views_tenant_id_id").on(t.tenantId, t.id),
    unique("uniq_welcome_guide_views_section").on(
      t.tenantId,
      t.guideId,
      t.applicationId,
      t.section,
    ),
    index("idx_welcome_guide_views_application").on(t.tenantId, t.applicationId, t.firstViewedAt),
    foreignKey({
      columns: [t.tenantId, t.guideId],
      foreignColumns: [welcomeGuides.tenantId, welcomeGuides.id],
      name: "fk_welcome_guide_views_guide",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.tenantId, t.applicationId],
      foreignColumns: [applications.tenantId, applications.id],
      name: "fk_welcome_guide_views_application",
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
).enableRLS();
