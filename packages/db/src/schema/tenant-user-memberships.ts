import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { businessUnits } from "./business-units";

/**
 * Maps Supabase Auth users (auth.users.id) to HireOps tenants.
 * A user can belong to multiple tenants (consultants, internal-staff support access, etc.).
 * Roles are tenant-scoped — a user can be admin in one tenant and recruiter in another.
 *
 * Per multi-tenancy-adr.md §5.2, this table is read by the Custom Access Token hook
 * at JWT issuance time to populate tid, tenant_slug, and roles claims.
 *
 * Note: we don't add a foreign key reference to auth.users.id here because Drizzle
 * does not model the auth schema. The FK exists at the SQL level (added in the
 * raw migration in Step 4) — we just don't represent it in the TypeScript schema.
 */
export const tenantUserMemberships = pgTable(
  "tenant_user_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(), // FK to auth.users(id), enforced at SQL level
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    roles: text("roles").array().notNull().default([]), // ['admin', 'recruiter', etc.] — tenant-scoped. Column is migrated to tenant_role[] in 0004_db01_identity; Drizzle schema stays text[] until pgEnum support stabilises.
    status: text("status").notNull().default("active"), // 'active' | 'suspended' | 'revoked'
    // Tenant-specific profile attributes (DB-01).
    jobTitle: text("job_title"),
    // Self-FK: managers are members in the same tenant, not users (which
    // would lose tenant scoping).
    managerId: uuid("manager_id").references((): AnyPgColumn => tenantUserMemberships.id, {
      onDelete: "set null",
    }),
    businessUnitId: uuid("business_unit_id").references(() => businessUnits.id, {
      onDelete: "set null",
    }),
    joinedTenantAt: timestamp("joined_tenant_at", { withTimezone: true }).notNull().defaultNow(),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A user has at most one membership row per tenant
    uniqueUserTenant: uniqueIndex("idx_membership_user_tenant").on(table.userId, table.tenantId),
    // Hot path for the hook: lookup memberships by user_id quickly
    userIdx: index("idx_membership_user").on(table.userId),
    // For tenant admin views: list all members of a tenant
    tenantIdx: index("idx_membership_tenant").on(table.tenantId),
  }),
);

export type TenantUserMembership = typeof tenantUserMemberships.$inferSelect;
export type NewTenantUserMembership = typeof tenantUserMemberships.$inferInsert;
