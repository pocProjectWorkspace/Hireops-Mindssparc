import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  foreignKey,
  pgPolicy,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { businessUnits } from "./business-units";
import { tenantRoleEnum } from "./roles";

/**
 * Maps Supabase Auth users (auth.users.id) to HireOps tenants. A user can
 * belong to multiple tenants; roles are tenant-scoped (admin in tenant A,
 * recruiter in tenant B). The Custom Access Token hook reads this table at
 * JWT issuance to populate tid/tenant_slug/roles claims (FND-15b, §5.2).
 *
 * The user_id FK actually references auth.users.id. Drizzle can't model
 * cross-schema FKs, so it lives only at the SQL level (0002 migration).
 * Setting `name` on each modelled foreign key matches the Postgres-default
 * constraint names used in the live DB, so db:generate doesn't churn them.
 */
export const tenantUserMemberships = pgTable(
  "tenant_user_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(), // FK to auth.users(id), enforced at SQL level only
    tenantId: uuid("tenant_id").notNull(),
    roles: tenantRoleEnum("roles").array().notNull().default([]), // tenant-scoped role array
    status: text("status").notNull().default("active"), // 'active' | 'suspended' | 'revoked'
    jobTitle: text("job_title"),
    managerId: uuid("manager_id"),
    businessUnitId: uuid("business_unit_id"),
    joinedTenantAt: timestamp("joined_tenant_at", { withTimezone: true }).notNull().defaultNow(),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_membership_user_tenant").on(table.userId, table.tenantId),
    index("idx_membership_user").on(table.userId),
    index("idx_membership_tenant").on(table.tenantId),
    index("idx_membership_manager").on(table.managerId),
    index("idx_membership_business_unit").on(table.businessUnitId),
    // tenant_id FK was created by Drizzle in 0001, so its constraint name
    // follows Drizzle's auto-derivation convention (table_col_reftable_refcol_fk),
    // not the Postgres-default _fkey shorthand.
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "tenant_user_memberships_tenant_id_tenants_id_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.managerId],
      foreignColumns: [table.id as AnyPgColumn],
      name: "tenant_user_memberships_manager_id_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.businessUnitId],
      foreignColumns: [businessUnits.id],
      name: "tenant_user_memberships_business_unit_id_fkey",
    }).onDelete("set null"),
    pgPolicy("memberships_self_select", {
      as: "permissive",
      for: "select",
      to: ["authenticated"],
      using: sql`user_id = auth.uid()`,
    }),
    pgPolicy("memberships_auth_admin_read", {
      as: "permissive",
      for: "select",
      to: ["supabase_auth_admin"],
      using: sql`true`,
    }),
  ],
).enableRLS();

export type TenantUserMembership = typeof tenantUserMemberships.$inferSelect;
export type NewTenantUserMembership = typeof tenantUserMemberships.$inferInsert;
