-- =====================================================================
-- 0004_db01_identity.sql
--
-- DB-01: identity layer.
--
--   - tenant_role enum (11 fixed platform roles; custom roles deferred to
--     Wave 2+)
--   - public.users — platform-level profile, FK to auth.users, user-scoped
--     RLS (self-select/self-update)
--   - public.business_units — intra-tenant org structure, hierarchical via
--     self-FK, tenant-scoped RLS (tenant_isolation)
--   - tenant_user_memberships — extended with job_title, manager_id (self-FK),
--     business_unit_id, joined_tenant_at; roles column migrated from text[]
--     to tenant_role[]
--
-- Hand-written instead of Drizzle-generated because the existing snapshot
-- chain (0001/0002) is in a broken state that blocks db:generate. The
-- Drizzle TypeScript schema for tenant_user_memberships.roles still types
-- the column as text[]; that mismatch is acceptable until pgEnum support
-- in Drizzle stabilises and we can switch the schema definition.
--
-- See docs/requirements.md §3 (role list) and ADR-002 §5.3 (RLS framework).
-- =====================================================================

-- ---------- tenant_role enum ----------

CREATE TYPE public.tenant_role AS ENUM (
  'admin',
  'recruiter',
  'hiring_manager',
  'panel_member',
  'hr_ops',
  'people_ops',
  'it_admin',
  'partner_admin',
  'partner_user',
  'candidate',
  'employee'
);

COMMENT ON TYPE public.tenant_role IS
  'Platform-level tenant roles. Wave 1 fixed list; custom roles deferred to Wave 2+. JWT roles claim must contain only these values.';

-- ---------- public.users ----------

CREATE TABLE public.users (
  id                       uuid PRIMARY KEY NOT NULL,
  display_name             text,
  avatar_url               text,
  locale                   text NOT NULL DEFAULT 'en-IN',
  timezone                 text NOT NULL DEFAULT 'Asia/Kolkata',
  high_contrast            boolean NOT NULL DEFAULT false,
  reduce_motion            boolean NOT NULL DEFAULT false,
  email_digest_frequency   text NOT NULL DEFAULT 'daily',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.users
  ADD CONSTRAINT users_id_fkey
  FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

COMMENT ON TABLE public.users IS
  'Platform-level user profile. One row per real human; FK to auth.users.id. Survives tenant offboarding. Tenant-specific attributes (job_title, manager, business_unit) live on tenant_user_memberships.';

-- ---------- public.business_units ----------

CREATE TABLE public.business_units (
  id                          uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  parent_business_unit_id     uuid REFERENCES public.business_units(id) ON DELETE SET NULL,
  name                        text NOT NULL,
  slug                        text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX business_units_tenant_id_slug_key
  ON public.business_units (tenant_id, slug);

CREATE INDEX idx_business_units_tenant
  ON public.business_units (tenant_id);

CREATE INDEX idx_business_units_parent
  ON public.business_units (parent_business_unit_id);

COMMENT ON TABLE public.business_units IS
  'Intra-tenant org structure. Hierarchical via parent_business_unit_id (NULL = top-level). Recruiters, requisitions, and partners attach to business units in later migrations.';

-- ---------- tenant_user_memberships extensions ----------

ALTER TABLE public.tenant_user_memberships
  ADD COLUMN job_title           text,
  ADD COLUMN manager_id          uuid REFERENCES public.tenant_user_memberships(id) ON DELETE SET NULL,
  ADD COLUMN business_unit_id    uuid REFERENCES public.business_units(id) ON DELETE SET NULL,
  ADD COLUMN joined_tenant_at    timestamptz NOT NULL DEFAULT now();

CREATE INDEX idx_membership_manager
  ON public.tenant_user_memberships (manager_id);

CREATE INDEX idx_membership_business_unit
  ON public.tenant_user_memberships (business_unit_id);

-- ---------- tenant_user_memberships.roles: text[] → tenant_role[] ----------

-- Pre-check: every existing roles value must be a valid enum member or
-- the cast below will fail with a confusing error mid-migration.
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
    FROM public.tenant_user_memberships
    WHERE NOT (roles <@ ARRAY[
      'admin','recruiter','hiring_manager','panel_member','hr_ops',
      'people_ops','it_admin','partner_admin','partner_user',
      'candidate','employee'
    ]);
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Cannot migrate tenant_user_memberships.roles to tenant_role[] — % row(s) contain values outside the enum.', bad_count;
  END IF;
END $$;

-- The default on the column references text[] syntax; drop it before the
-- cast, then restore in enum form after.
ALTER TABLE public.tenant_user_memberships
  ALTER COLUMN roles DROP DEFAULT;

ALTER TABLE public.tenant_user_memberships
  ALTER COLUMN roles TYPE public.tenant_role[]
  USING roles::public.tenant_role[];

ALTER TABLE public.tenant_user_memberships
  ALTER COLUMN roles SET DEFAULT ARRAY[]::public.tenant_role[];

-- ---------- RLS: public.users (user-scoped) ----------

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_self_select ON public.users
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY users_self_update ON public.users
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- No INSERT/DELETE policy for `authenticated`:
--   INSERT — profile creation runs as service_role during the signup flow
--            (FND-15f); user JWTs cannot create their own profile rows.
--   DELETE — profile deletion cascades from auth.users; users do not
--            delete public.users rows directly.

-- Defensive: if the auth hook ever reads public.users for additional
-- claims, supabase_auth_admin needs SELECT access. Add the policy now so
-- the next "missing claim" debugging session does not have to trace it.
GRANT SELECT ON TABLE public.users TO supabase_auth_admin;

CREATE POLICY users_auth_admin_read ON public.users
  AS PERMISSIVE
  FOR SELECT
  TO supabase_auth_admin
  USING (true);

-- ---------- RLS: public.business_units (tenant-scoped) ----------

ALTER TABLE public.business_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_units FORCE ROW LEVEL SECURITY;

-- Standard tenant_isolation policy per FND-15c framework (lint-rls.ts
-- requires this exact policy name on non-allowlisted tables).
CREATE POLICY tenant_isolation ON public.business_units
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (tenant_id = public.current_tenant_id())
  WITH CHECK (tenant_id = public.current_tenant_id());

-- =====================================================================
-- End of migration
-- =====================================================================
