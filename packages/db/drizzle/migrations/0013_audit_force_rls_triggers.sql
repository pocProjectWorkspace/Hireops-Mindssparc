-- =====================================================================
-- 0013_audit_force_rls_triggers.sql — DB-AUDIT (hand-written)
--
-- Companion to 0012_wise_prism.sql. Three things here:
--   1. FORCE RLS on the partitioned parent and every initial partition.
--      Per Postgres docs RLS settings propagate from partitioned parent
--      to partitions for ENABLE, but FORCE is set per-relation — we set
--      it on each partition explicitly so direct-partition access is
--      also forced.
--   2. audit_record_change() — SECURITY DEFINER trigger function owned
--      by `postgres` (BYPASSRLS), so its INSERT into audit_logs bypasses
--      the FORCE RLS on the parent. The function ALWAYS pulls tenant_id
--      from NEW/OLD, never from a parameter — that's the safety bar.
--   3. CREATE TRIGGER on each mutable tenant-scoped domain table.
--      requisition_state_transitions is intentionally excluded (it's
--      append-only itself; auditing its inserts is noise). Platform
--      tables (tenants, users, tenant_user_memberships,
--      tenant_encryption_keys, integration_credentials) are also
--      excluded per the DB-AUDIT scope.
--
-- The function reads request-level metadata via current_setting('app.*',
-- true). withTenantContext SET LOCALs these inside its transaction.
-- When unset (e.g. direct poolSql writes or worker invocations without
-- metadata), they're NULL and the audit row records NULL for the actor
-- — that is the intended behaviour.
-- =====================================================================

ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2026_05 FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.audit_logs_2026_06 FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.audit_record_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id            uuid;
  v_entity_id            uuid;
  v_action               public.audit_action;
  v_before               jsonb;
  v_after                jsonb;
  v_changed_columns      text[];
  v_actor_user_id        uuid;
  v_actor_membership_id  uuid;
  v_request_id           text;
  v_user_agent           text;
  v_ip_address           inet;
  v_source               text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action    := 'insert';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_before    := NULL;
    v_after     := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_action    := 'update';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_before    := to_jsonb(OLD);
    v_after     := to_jsonb(NEW);

    -- Skip no-op updates: rows where every value matches.
    IF v_before = v_after THEN
      RETURN NULL;
    END IF;

    -- Compute the set of column names whose values differ.
    SELECT array_agg(key ORDER BY key)
      INTO v_changed_columns
      FROM (
        SELECT key FROM jsonb_each(v_after) AS new_kv(key, value)
        EXCEPT
        SELECT key FROM jsonb_each(v_before) AS old_kv(key, value)
        UNION
        SELECT key FROM jsonb_each(v_before) AS old_kv(key, value)
        WHERE (v_before -> key) IS DISTINCT FROM (v_after -> key)
      ) diff;
  ELSIF TG_OP = 'DELETE' THEN
    v_action    := 'delete';
    v_tenant_id := OLD.tenant_id;
    v_entity_id := OLD.id;
    v_before    := to_jsonb(OLD);
    v_after     := NULL;
  ELSE
    RAISE EXCEPTION 'audit_record_change: unsupported TG_OP=%', TG_OP;
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION
      'audit_record_change: % on %.% has NULL tenant_id; audit triggers attach to tenant-scoped tables only',
      TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;

  -- Request-level metadata. NULLIF maps the empty-string sentinel back to
  -- NULL — set_config('x', NULL, true) stores '' not NULL.
  v_actor_user_id       := NULLIF(current_setting('app.actor_user_id', true), '')::uuid;
  v_actor_membership_id := NULLIF(current_setting('app.actor_membership_id', true), '')::uuid;
  v_request_id          := NULLIF(current_setting('app.request_id', true), '');
  v_user_agent          := NULLIF(current_setting('app.user_agent', true), '');
  v_ip_address          := NULLIF(current_setting('app.ip_address', true), '')::inet;
  v_source              := COALESCE(NULLIF(current_setting('app.source', true), ''), 'app');

  INSERT INTO public.audit_logs (
    tenant_id, entity_type, entity_id, action,
    actor_user_id, actor_membership_id,
    request_id, user_agent, ip_address, source,
    before_data, after_data, changed_columns
  ) VALUES (
    v_tenant_id, TG_TABLE_NAME, v_entity_id, v_action,
    v_actor_user_id, v_actor_membership_id,
    v_request_id, v_user_agent, v_ip_address, v_source,
    v_before, v_after, v_changed_columns
  );

  RETURN NULL;
END;
$$;--> statement-breakpoint

ALTER FUNCTION public.audit_record_change() OWNER TO postgres;--> statement-breakpoint

-- Attach the trigger to every mutable tenant-scoped table. Order doesn't
-- matter; each is independent. requisition_state_transitions is omitted
-- intentionally (it's append-only itself; its inserts are noise here).
CREATE TRIGGER audit_business_units
AFTER INSERT OR UPDATE OR DELETE ON public.business_units
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_headcount_envelopes
AFTER INSERT OR UPDATE OR DELETE ON public.headcount_envelopes
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_positions
AFTER INSERT OR UPDATE OR DELETE ON public.positions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_jd_versions
AFTER INSERT OR UPDATE OR DELETE ON public.jd_versions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_jd_skills
AFTER INSERT OR UPDATE OR DELETE ON public.jd_skills
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_requisitions
AFTER INSERT OR UPDATE OR DELETE ON public.requisitions
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_requisition_recruiters
AFTER INSERT OR UPDATE OR DELETE ON public.requisition_recruiters
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_requisition_knockouts
AFTER INSERT OR UPDATE OR DELETE ON public.requisition_knockouts
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
