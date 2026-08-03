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
import { businessUnits } from "./business-units";
import { positions } from "./positions";
import { learningResources } from "./learning-resources";

/**
 * learning_tracks — curated BUNDLES of learning resources (LD-1A).
 *
 * A track is a bundle a recruiter PUSHES onto a new hire's onboarding case, not
 * a rule that fires on its own. Two layers ship in LD-1A:
 *
 *   'organisation' — company induction. `business_unit_id` NULL means every
 *                    hire; set it to scope the induction to one BU.
 *   'role'         — bound to exactly ONE of `position_id` (a specific position)
 *                    or `role_family` (the jd_templates.role_family vocabulary).
 *
 * The third layer of the client's ask — the individual's capability gaps — is
 * deliberately NOT a track: it is per-individual by definition and is derived
 * from the hire-vs-JD skill comparison. It lands in LD-2 as `learning_skill_map`.
 *
 * `layer` is text + CHECK (NOT a new pgEnum) — house convention. The binding
 * CHECK enforces the invariant above so a half-configured track cannot be saved.
 *
 * NO unique(tenant_id, name): two role tracks may legitimately share a name
 * while binding to different positions (e.g. "Role induction" for two roles).
 * upsertLearningTrack therefore keys on `id`, not the name.
 *
 * The business-unit / position FKs are COMPOUND (tenant_id, …) ON DELETE
 * RESTRICT — a compound FK cannot cleanly SET NULL (HANDOVER reality #63), and
 * both parents are archived rather than deleted (the positions.comp_band_id
 * precedent).
 *
 * Tenant-scoped + tenant_isolation + FORCE RLS + audit_record_change trigger
 * (companions in 0111).
 */
export const learningTracks = pgTable(
  "learning_tracks",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),

    tenantId: uuid("tenant_id").notNull(),

    name: text("name").notNull(),

    // organisation | role.
    layer: text("layer").notNull(),

    /** Layer 'organisation': NULL = every hire; set = scoped to one BU. */
    businessUnitId: uuid("business_unit_id"),
    /** Layer 'role': bind to a position… */
    positionId: uuid("position_id"),
    /** …or to a family, reusing the jd_templates.role_family vocabulary. */
    roleFamily: text("role_family"),

    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),

    createdByMembershipId: uuid("created_by_membership_id"),
    updatedByMembershipId: uuid("updated_by_membership_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Compound unique enables the compound (tenant_id, track_id) FK from
    // learning_track_items (DB-TENANT-FK).
    unique("uniq_learning_tracks_tenant_id_id").on(table.tenantId, table.id),

    index("idx_learning_tracks_tenant").on(table.tenantId),
    index("idx_learning_tracks_layer").on(table.tenantId, table.layer),
    index("idx_learning_tracks_position").on(table.tenantId, table.positionId),

    check("learning_tracks_layer_check", sql`${table.layer} IN ('organisation', 'role')`),
    // A 'role' track has EXACTLY ONE of position_id / role_family; an
    // 'organisation' track has neither.
    check(
      "learning_tracks_binding_check",
      sql`(
        ${table.layer} = 'role'
        AND (
          (${table.positionId} IS NOT NULL AND ${table.roleFamily} IS NULL)
          OR (${table.positionId} IS NULL AND ${table.roleFamily} IS NOT NULL)
        )
      ) OR (
        ${table.layer} = 'organisation'
        AND ${table.positionId} IS NULL
        AND ${table.roleFamily} IS NULL
      )`,
    ),

    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "learning_tracks_tenant_id_fkey",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.businessUnitId],
      foreignColumns: [businessUnits.tenantId, businessUnits.id],
      name: "fk_learning_tracks_business_unit",
    }).onDelete("restrict"),

    foreignKey({
      columns: [table.tenantId, table.positionId],
      foreignColumns: [positions.tenantId, positions.id],
      name: "fk_learning_tracks_position",
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

/**
 * learning_track_items — the ordered contents of a track.
 *
 * One row per (tenant, track, resource); setLearningTrackItems replace-sets the
 * whole list, the same shape as the interview round-template surface.
 *
 * `due_offset_days` is relative to the case's expected_start_date: the push
 * (assignLearningToCase) computes the resulting onboarding task's due_at as
 * expected_start_date + due_offset_days, and leaves it NULL when either is
 * unknown. `is_required` is carried onto the task metadata so a later ticket can
 * gate probation review on required items (LD-3).
 *
 * A track OWNS its items (compound (tenant_id, track_id) FK ON DELETE CASCADE);
 * the resource FK is ON DELETE RESTRICT — resources are archived, never deleted.
 */
export const learningTrackItems = pgTable(
  "learning_track_items",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),

    tenantId: uuid("tenant_id").notNull(),
    trackId: uuid("track_id").notNull(),
    resourceId: uuid("resource_id").notNull(),

    sortOrder: integer("sort_order").notNull().default(0),
    isRequired: boolean("is_required").notNull().default(true),
    /** Days after the case's expected_start_date. NULL = no due date. */
    dueOffsetDays: integer("due_offset_days"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_learning_track_items_tenant_id_id").on(table.tenantId, table.id),
    // A resource sits in a given track at most once — the replace-set key.
    unique("uniq_learning_track_items_track_resource").on(
      table.tenantId,
      table.trackId,
      table.resourceId,
    ),

    index("idx_learning_track_items_track").on(table.tenantId, table.trackId),
    index("idx_learning_track_items_resource").on(table.tenantId, table.resourceId),

    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "learning_track_items_tenant_id_fkey",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.trackId],
      foreignColumns: [learningTracks.tenantId, learningTracks.id],
      name: "fk_learning_track_items_track",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [learningResources.tenantId, learningResources.id],
      name: "fk_learning_track_items_resource",
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

export type LearningTrack = typeof learningTracks.$inferSelect;
export type NewLearningTrack = typeof learningTracks.$inferInsert;
export type LearningTrackItem = typeof learningTrackItems.$inferSelect;
export type NewLearningTrackItem = typeof learningTrackItems.$inferInsert;
