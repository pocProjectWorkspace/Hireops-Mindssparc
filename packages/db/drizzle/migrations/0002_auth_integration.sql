-- =====================================================================
-- 0002_auth_integration.sql
--
-- Adds the auth.users foreign key to tenant_user_memberships
-- (Drizzle cannot model this because auth schema is Supabase-managed).
--
-- Creates the three SECURITY DEFINER helper functions that runtime code
-- and RLS policies use to read tenant context from JWTs.
--
-- Creates the Custom Access Token hook function and applies the grants
-- Supabase Auth requires.
--
-- Per multi-tenancy-adr.md §5.2 and §5.3.
-- =====================================================================

-- ---------- Foreign key from tenant_user_memberships to auth.users ----------

ALTER TABLE public.tenant_user_memberships
  ADD CONSTRAINT tenant_user_memberships_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ---------- Helper: current_tenant_id() ----------

-- Returns the tenant_id from the current request's JWT 'tid' claim.
-- Used as the outermost predicate in every domain table's RLS policy.
-- STABLE because it does not modify data; LANGUAGE SQL for inlinability.

CREATE OR REPLACE FUNCTION public.current_tenant_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT (auth.jwt() ->> 'tid')::uuid;
$$;

COMMENT ON FUNCTION public.current_tenant_id() IS
  'Returns the tenant_id from the current JWT. Used in RLS policies as the outermost tenant predicate. Per multi-tenancy-adr.md §5.3.';

-- ---------- Helper: has_role(role text) ----------

-- Returns true if the JWT 'roles' array contains the given role.
-- Composes with current_tenant_id() inside RLS policies for tenant + role scoping.

CREATE OR REPLACE FUNCTION public.has_role(role_name text)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT (auth.jwt() -> 'roles') ? role_name;
$$;

COMMENT ON FUNCTION public.has_role(text) IS
  'Returns true if the current JWT contains the given role in its roles claim. Roles are tenant-scoped per multi-tenancy-adr.md §5.2.';

-- ---------- Custom Access Token hook ----------

-- Runs at JWT issuance time. Reads the user's tenant memberships and writes:
--   tid           — the active tenant's UUID
--   tenant_slug   — the active tenant's subdomain identifier (for routing convenience)
--   roles         — the roles the user has within the active tenant
--   aud           — preserved from event; we don't override this in MVP
--
-- Active tenant selection: the client passes 'tenant_slug' in raw_user_meta_data
-- at sign-in time (when subdomain-based auth is wired up in FND-06). For now,
-- the hook reads the desired tenant_slug from the user's user_metadata field.
-- If the user has only one membership, that one is selected automatically.
--
-- Per Supabase guidance, this function does NOT use SECURITY DEFINER. Permissions
-- are granted explicitly to supabase_auth_admin and revoked from public roles.

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql
  STABLE
AS $$
DECLARE
  user_id_val uuid;
  desired_slug text;
  active_tenant_id uuid;
  active_tenant_slug text;
  active_roles text[];
  membership_count int;
  claims jsonb;
BEGIN
  user_id_val := (event ->> 'user_id')::uuid;
  claims := event -> 'claims';

  -- Read the desired tenant from user_metadata (set by client at sign-in,
  -- or pre-populated for synthetic test users).
  SELECT (raw_user_meta_data ->> 'tenant_slug')
    INTO desired_slug
    FROM auth.users
    WHERE id = user_id_val;

  IF desired_slug IS NOT NULL THEN
    -- Active tenant explicitly requested
    SELECT t.id, t.slug, m.roles
      INTO active_tenant_id, active_tenant_slug, active_roles
      FROM public.tenant_user_memberships m
      JOIN public.tenants t ON t.id = m.tenant_id
      WHERE m.user_id = user_id_val
        AND m.status = 'active'
        AND t.status = 'active'
        AND t.slug = desired_slug;
  ELSE
    -- No tenant requested. If user has exactly one active membership, use it.
    -- Otherwise, leave claims unset and the API layer decides how to handle.
    SELECT count(*) INTO membership_count
      FROM public.tenant_user_memberships m
      JOIN public.tenants t ON t.id = m.tenant_id
      WHERE m.user_id = user_id_val
        AND m.status = 'active'
        AND t.status = 'active';

    IF membership_count = 1 THEN
      SELECT t.id, t.slug, m.roles
        INTO active_tenant_id, active_tenant_slug, active_roles
        FROM public.tenant_user_memberships m
        JOIN public.tenants t ON t.id = m.tenant_id
        WHERE m.user_id = user_id_val
          AND m.status = 'active'
          AND t.status = 'active';
    END IF;
  END IF;

  IF active_tenant_id IS NOT NULL THEN
    claims := jsonb_set(claims, '{tid}', to_jsonb(active_tenant_id::text));
    claims := jsonb_set(claims, '{tenant_slug}', to_jsonb(active_tenant_slug));
    claims := jsonb_set(claims, '{roles}', to_jsonb(active_roles));
    event := jsonb_set(event, '{claims}', claims);
  END IF;

  RETURN event;
END;
$$;

COMMENT ON FUNCTION public.custom_access_token_hook(jsonb) IS
  'Custom Access Token hook for Supabase Auth. Injects tid, tenant_slug, and roles claims based on user memberships. Per multi-tenancy-adr.md §5.2.';

-- ---------- Grants ----------

-- The hook function: only supabase_auth_admin can execute it; nothing else
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;

-- The hook function reads tenants and tenant_user_memberships, so grant SELECT
GRANT SELECT ON TABLE public.tenants TO supabase_auth_admin;
GRANT SELECT ON TABLE public.tenant_user_memberships TO supabase_auth_admin;

-- The helper functions: callable by authenticated users (used in app queries and RLS)
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.has_role(text) TO authenticated, anon;

-- =====================================================================
-- End of migration
-- =====================================================================
