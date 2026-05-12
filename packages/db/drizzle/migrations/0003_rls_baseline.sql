-- FND-15c: enable RLS on existing tables and establish baseline policies.
--
-- Pattern reference: ADR-002 §5.3. Every tenant-scoped table follows the
-- shape established here: RLS enabled, FORCE ROW LEVEL SECURITY on,
-- tenant_isolation policy as the outermost predicate using current_tenant_id().
--
-- Migrations run as the postgres superuser, which by default bypasses RLS.
-- FORCE ROW LEVEL SECURITY ensures even the table owner is subject to
-- policies — defence in depth. The DDL itself is still possible because
-- BYPASSRLS is checked separately from FORCE.

-- ============================================================================
-- tenants
-- ============================================================================
-- Platform-level table. Users see only their own tenant row.
-- The membership join table is the source of truth for "which tenants does
-- this user belong to" — but for this policy we filter by JWT tid claim
-- because that's authoritative for the active session.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_self_select ON tenants
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (id = current_tenant_id());

-- The Custom Access Token hook (FND-15b, SECURITY INVOKER) runs as
-- supabase_auth_admin and reads this table to populate the tenant_slug
-- claim at JWT issuance. That role does not have BYPASSRLS, so FORCE
-- RLS would block it without an explicit policy. Per Supabase guidance
-- for RLS + auth hooks.
CREATE POLICY tenants_auth_admin_read ON tenants
  AS PERMISSIVE
  FOR SELECT
  TO supabase_auth_admin
  USING (true);

-- No INSERT/UPDATE/DELETE policies for authenticated. Tenant CRUD is
-- platform-admin only and goes through service_role (BYPASSRLS).

-- ============================================================================
-- tenant_user_memberships
-- ============================================================================
-- Platform-level join table. Users see only their own membership rows
-- (across all tenants they belong to, not just the active one — this is
-- needed for the tenant switcher UI per ADR-002 §5.2).

ALTER TABLE tenant_user_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_user_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_self_select ON tenant_user_memberships
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Same auth-hook reason as on tenants above: supabase_auth_admin joins
-- this table during JWT issuance to read the user's tenant + roles.
CREATE POLICY memberships_auth_admin_read ON tenant_user_memberships
  AS PERMISSIVE
  FOR SELECT
  TO supabase_auth_admin
  USING (true);

-- INSERT/UPDATE/DELETE are platform-admin only via service_role.

-- ============================================================================
-- tenant_encryption_keys
-- ============================================================================
-- Per-tenant DEK store. Defence-in-depth: authenticated users must never read
-- this table — only worker-tier code running under service_role (which bypasses
-- RLS) has a legitimate access path. Per ADR-002 §5.5.
--
-- Pattern: RLS enabled + FORCE, no policies for authenticated. With RLS on and
-- no matching PERMISSIVE policy, every authenticated read is denied by default.
-- This is functionally equivalent to an explicit `FOR ALL USING (false)` policy
-- and chosen here for brevity. The lint script (packages/db/src/lint-rls.ts)
-- recognises this table on the platform-table allowlist.

ALTER TABLE tenant_encryption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_encryption_keys FORCE ROW LEVEL SECURITY;

-- No policies. Default-deny for authenticated; service_role bypasses RLS.
