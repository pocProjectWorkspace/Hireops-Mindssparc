import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  unique,
  check,
  foreignKey,
  pgPolicy,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { tenantRoleEnum } from "./roles";

/**
 * C2-F1 (0137) — a tenant CUSTOM role: a label + capability bundle over a base
 * role. The base role (an internal `tenant_role` value) is what the member's
 * JWT `roles` claim carries, so RLS is unchanged; the bundle (role_capabilities)
 * is what the API enforces. System roles are NOT rows — their bundles are the
 * platform defaults in @hireops/api-types capabilities.ts.
 *
 * Deactivated, never deleted while assigned: tenant_user_memberships.role_key
 * FKs (tenant_id, key) ON DELETE RESTRICT.
 */
export const tenantRoles = pgTable(
  "tenant_roles",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    baseRole: tenantRoleEnum("base_role").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_tenant_roles_tenant_id_id").on(table.tenantId, table.id),
    unique("uniq_tenant_roles_tenant_key").on(table.tenantId, table.key),
    check("tenant_roles_key_check", sql`${table.key} ~ '^[a-z][a-z0-9_]{1,47}$'`),
    check(
      "tenant_roles_key_not_system_check",
      sql`${table.key} NOT IN ('admin','recruiter','hiring_manager','panel_member','hr_ops','people_ops','it_admin','partner_admin','partner_user','candidate','employee','hr_head')`,
    ),
    check(
      "tenant_roles_base_role_check",
      sql`${table.baseRole} IN ('admin','recruiter','hiring_manager','panel_member','hr_ops','people_ops','it_admin','hr_head')`,
    ),
    check("tenant_roles_label_check", sql`char_length(${table.label}) BETWEEN 1 AND 60`),
    check(
      "tenant_roles_description_check",
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 400`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "tenant_roles_tenant_id_fkey",
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
 * C2-F1 (0137) — one capability grant of a custom role, with its target
 * population scope. `capability` is format-checked here; the API validates it
 * against the platform catalog (and the resolver drops unknown ones).
 */
export const roleCapabilities = pgTable(
  "role_capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    roleKey: text("role_key").notNull(),
    capability: text("capability").notNull(),
    scope: text("scope").notNull().default("all"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uniq_role_capabilities_grant").on(table.tenantId, table.roleKey, table.capability),
    check("role_capabilities_capability_check", sql`${table.capability} ~ '^[a-z_]+\\.[a-z_]+$'`),
    check(
      "role_capabilities_scope_check",
      sql`${table.scope} IN ('own','team','business_unit','legal_entity','all')`,
    ),
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "role_capabilities_tenant_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.roleKey],
      foreignColumns: [tenantRoles.tenantId, tenantRoles.key],
      name: "fk_role_capabilities_role",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    pgPolicy("tenant_isolation", {
      as: "permissive",
      for: "all",
      to: ["authenticated"],
      using: sql`tenant_id = current_tenant_id()`,
      withCheck: sql`tenant_id = current_tenant_id()`,
    }),
  ],
).enableRLS();

export type TenantRoleRow = typeof tenantRoles.$inferSelect;
export type NewTenantRoleRow = typeof tenantRoles.$inferInsert;
export type RoleCapabilityRow = typeof roleCapabilities.$inferSelect;
