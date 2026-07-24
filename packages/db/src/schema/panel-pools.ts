import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  unique,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantUserMemberships } from "./tenant-user-memberships";

/**
 * Panel-pool LIBRARY (T3.3 / G16, Phase 3 org structure — FINAL ticket). A
 * tenant's editable set of NAMED interview-panel pools — a reusable roster of
 * memberships an interview-plan round can draw its default panel FROM, so a
 * round's panel comes from a managed group rather than a per-round manual
 * checkbox pick each time.
 *
 * HONESTY: this is NOT a decorative dropdown. When an interview-plan round
 * carries a panelPoolId with NO manual override, upsertInterviewPlan COPIES the
 * pool's member membership-ids onto interview_plans.default_panel_membership_ids
 * — the SAME advisory uuid[] INT-02 already reads to seed interview_panelists.
 * So the chosen pool genuinely drives the round's panel.
 * interview_plans.panel_pool_id is retained as provenance (mirrors
 * positions.comp_band_id), so an override (explicit member ids) shows as a
 * divergence from the linked pool.
 *
 * FLAT + named, with an optional free-text `focus` label. Tenant-scoped:
 * standard tenant_isolation RLS. Pools are archived, never deleted
 * (interview_plans compound-FK them ON DELETE RESTRICT).
 */
export const panelPools = pgTable(
  "panel_pools",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),

    tenantId: uuid("tenant_id").notNull(),

    name: text("name").notNull(),
    // Optional free-text focus label (e.g. "Backend", "Leadership loop").
    focus: text("focus"),

    // Archived pools are retired from the plan-setup picker but stay valid for
    // rounds already attached to them.
    isArchived: boolean("is_archived").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_panel_pools_tenant_name").on(table.tenantId, table.name),
    // Compound unique enables compound (tenant_id, id) FKs from peer domain
    // tables — panel_pool_members + interview_plans.panel_pool_id (DB-TENANT-FK).
    unique("uniq_panel_pools_tenant_id_id").on(table.tenantId, table.id),
    index("idx_panel_pools_tenant").on(table.tenantId),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "panel_pools_tenant_id_fkey",
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

/**
 * panel_pool_members — the memberships that belong to a pool. One row per
 * (tenant, pool, membership); setPanelPoolMembers replace-sets the whole roster.
 *
 * A pool OWNS its member rows: the compound (tenant_id, panel_pool_id) FK is ON
 * DELETE CASCADE. The membership FK is ON DELETE RESTRICT (compound FKs cannot
 * cleanly SET NULL — the interview_panelists precedent, HANDOVER reality #63).
 */
export const panelPoolMembers = pgTable(
  "panel_pool_members",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),

    tenantId: uuid("tenant_id").notNull(),
    panelPoolId: uuid("panel_pool_id").notNull(),
    membershipId: uuid("membership_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A membership sits in a given pool at most once.
    unique("uniq_panel_pool_members_pool_membership").on(
      table.tenantId,
      table.panelPoolId,
      table.membershipId,
    ),

    index("idx_panel_pool_members_pool").on(table.tenantId, table.panelPoolId),
    index("idx_panel_pool_members_membership").on(table.tenantId, table.membershipId),

    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "panel_pool_members_tenant_id_fkey",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.panelPoolId],
      foreignColumns: [panelPools.tenantId, panelPools.id],
      name: "fk_panel_pool_members_pool",
    }).onDelete("cascade"),

    foreignKey({
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [tenantUserMemberships.tenantId, tenantUserMemberships.id],
      name: "fk_panel_pool_members_membership",
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

export type PanelPool = typeof panelPools.$inferSelect;
export type NewPanelPool = typeof panelPools.$inferInsert;
export type PanelPoolMember = typeof panelPoolMembers.$inferSelect;
export type NewPanelPoolMember = typeof panelPoolMembers.$inferInsert;
