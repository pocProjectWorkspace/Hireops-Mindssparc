-- =====================================================================
-- 0126_diversity_slate.sql — PC-26 (hand-written)
--
-- Diverse-slate requirement per role, flagged (never blocked) when a
-- role's slate falls short. Two pieces:
--
-- 1. requisitions.diverse_slate_required (bool, default false) +
--    requisitions.diverse_slate_min (int NULL = tenant default, 1..20).
--    Plain columns, not a jsonb: requisitions carries no settings jsonb
--    today and every other per-role switch is a typed column. Additive —
--    every existing row reads "not required". requisitions already has
--    tenant_isolation + FORCE RLS + its audit trigger.
--
-- 2. candidate_diversity_self_id — VOLUNTARY self-identification, the
--    first demographic data the platform holds, under these guardrails:
--      - Separate table: nothing on persons / candidates / applications, so
--        no existing select / list / export / AI read can carry it.
--      - "Prefer not to say" is never stored (CHECK); choosing it or
--        withdrawing sets withdrawn_at. One ACTIVE answer per
--        (person, category) — partial unique.
--      - collected_via CHECKed to the two candidate-owned seams. There is
--        deliberately no partner / recruiter value.
--      - RLS FORCE + tenant_isolation_candidate_self: tenant match AND the
--        caller holds the 'candidate' role. Staff and partner JWTs see zero
--        rows. The per-role COUNT runs server-side on the service-role pool
--        and returns numbers only.
--      - Audit: a redacting trigger — the row change is recorded in
--        audit_logs (who / when / which category / withdrawn) with `value`
--        replaced by '[redacted]', so the audit trail never becomes a
--        second copy of the answer.
--
-- The tenant-level policy (enabled / defaultMin / countedStages /
-- categories) lives in tenants.settings.diversitySlate — no DDL.
-- =====================================================================

ALTER TABLE "requisitions" ADD COLUMN IF NOT EXISTS "diverse_slate_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "requisitions" ADD COLUMN IF NOT EXISTS "diverse_slate_min" integer;--> statement-breakpoint
ALTER TABLE "requisitions" DROP CONSTRAINT IF EXISTS "requisitions_diverse_slate_min_check";--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_diverse_slate_min_check" CHECK ("diverse_slate_min" IS NULL OR ("diverse_slate_min" >= 1 AND "diverse_slate_min" <= 20));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "candidate_diversity_self_id" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"category_key" text NOT NULL,
	"value" text NOT NULL,
	"disclosure_version" text NOT NULL,
	"collected_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "uniq_candidate_diversity_self_id_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "candidate_diversity_self_id_collected_via_check" CHECK ("collected_via" IN ('apply_form', 'candidate_portal')),
	CONSTRAINT "candidate_diversity_self_id_key_check" CHECK ("category_key" ~ '^[a-z][a-z0-9_]{0,39}$'),
	CONSTRAINT "candidate_diversity_self_id_value_check" CHECK ("value" ~ '^[a-z][a-z0-9_]{0,39}$' AND "value" <> 'prefer_not_to_say')
);--> statement-breakpoint
ALTER TABLE "candidate_diversity_self_id" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.candidate_diversity_self_id FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "candidate_diversity_self_id" ADD CONSTRAINT "candidate_diversity_self_id_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_diversity_self_id" ADD CONSTRAINT "fk_candidate_diversity_self_id_person" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."persons"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_candidate_diversity_self_id_active" ON "candidate_diversity_self_id" USING btree ("tenant_id","person_id","category_key") WHERE withdrawn_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_candidate_diversity_self_id_person" ON "candidate_diversity_self_id" USING btree ("tenant_id","person_id");--> statement-breakpoint

-- Tenant match AND a candidate JWT. A staff / partner caller on the RLS
-- client matches no policy → zero rows, zero writes.
CREATE POLICY "tenant_isolation_candidate_self" ON "candidate_diversity_self_id" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id() AND has_role('candidate')) WITH CHECK (tenant_id = current_tenant_id() AND has_role('candidate'));--> statement-breakpoint

-- ── Redacting audit trigger ───────────────────────────────────────────
-- Same contract as audit_record_change() (0013): SECURITY DEFINER owned by
-- postgres, tenant_id always from NEW/OLD, request metadata from app.*
-- settings. Differs only in that `value` is masked in before/after data.
CREATE OR REPLACE FUNCTION public.audit_diversity_self_id_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id  uuid;
  v_entity_id  uuid;
  v_action     public.audit_action;
  v_before     jsonb;
  v_after      jsonb;
  v_changed    text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'insert';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_after := to_jsonb(NEW) || jsonb_build_object('value', '[redacted]');
  ELSIF TG_OP = 'UPDATE' THEN
    v_action := 'update';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    IF to_jsonb(OLD) = to_jsonb(NEW) THEN
      RETURN NULL;
    END IF;
    v_before := to_jsonb(OLD) || jsonb_build_object('value', '[redacted]');
    v_after := to_jsonb(NEW) || jsonb_build_object('value', '[redacted]');
    SELECT array_agg(key ORDER BY key) INTO v_changed
      FROM jsonb_each(to_jsonb(NEW)) AS n(key, val)
      WHERE (to_jsonb(OLD) -> key) IS DISTINCT FROM val;
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'delete';
    v_tenant_id := OLD.tenant_id;
    v_entity_id := OLD.id;
    v_before := to_jsonb(OLD) || jsonb_build_object('value', '[redacted]');
  ELSE
    RAISE EXCEPTION 'audit_diversity_self_id_change: unsupported TG_OP=%', TG_OP;
  END IF;

  INSERT INTO public.audit_logs (
    tenant_id, entity_type, entity_id, action,
    actor_user_id, actor_membership_id,
    request_id, user_agent, ip_address, source,
    before_data, after_data, changed_columns
  ) VALUES (
    v_tenant_id, TG_TABLE_NAME, v_entity_id, v_action,
    NULLIF(current_setting('app.actor_user_id', true), '')::uuid,
    NULLIF(current_setting('app.actor_membership_id', true), '')::uuid,
    NULLIF(current_setting('app.request_id', true), ''),
    NULLIF(current_setting('app.user_agent', true), ''),
    NULLIF(current_setting('app.ip_address', true), '')::inet,
    COALESCE(NULLIF(current_setting('app.source', true), ''), 'app'),
    v_before, v_after, v_changed
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint

ALTER FUNCTION public.audit_diversity_self_id_change() OWNER TO postgres;--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_candidate_diversity_self_id ON public.candidate_diversity_self_id;--> statement-breakpoint
CREATE TRIGGER audit_candidate_diversity_self_id
AFTER INSERT OR UPDATE OR DELETE ON public.candidate_diversity_self_id
FOR EACH ROW EXECUTE FUNCTION public.audit_diversity_self_id_change();
