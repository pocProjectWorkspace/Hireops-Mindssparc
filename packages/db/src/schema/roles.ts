/**
 * Platform-level tenant role enum. Mirrors the CREATE TYPE in
 * 0005_db01_handwritten.sql.
 *
 * Wave 1 uses these 11 fixed roles only. Custom tenant-defined roles are
 * deferred to Wave 2+.
 *
 * Roles are tenant-scoped: a user can be admin in tenant A and candidate
 * in tenant B. The active tenant from JWT 'tid' determines which roles
 * apply on a given request. The roles column on tenant_user_memberships
 * is tenant_role[] (Postgres enum array) — the auth hook reads from there
 * to populate the JWT roles claim.
 */

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
