/**
 * Platform-level tenant role enum. Mirrors the CREATE TYPE in
 * 0004_db01_identity.sql.
 *
 * Wave 1 uses these 11 fixed roles only. Custom tenant-defined roles are
 * deferred to Wave 2+.
 *
 * Roles are tenant-scoped: a user can be admin in tenant A and candidate
 * in tenant B. The active tenant from JWT 'tid' determines which roles
 * apply on a given request. The roles column on tenant_user_memberships
 * is tenant_role[] — the auth hook reads from there to populate the JWT
 * roles claim.
 */

import { pgEnum } from "drizzle-orm/pg-core";

export const TENANT_ROLES = [
  "admin",
  "recruiter",
  "hiring_manager",
  "panel_member",
  "hr_ops",
  "people_ops",
  "it_admin",
  "partner_admin",
  "partner_user",
  "candidate",
  "employee",
] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

// Drizzle pgEnum so the schema models the SQL type. Use with `.array()` on
// the memberships.roles column for a typed tenant_role[].
export const tenantRoleEnum = pgEnum("tenant_role", TENANT_ROLES);
