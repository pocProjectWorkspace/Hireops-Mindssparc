-- =====================================================================
-- 0134_platform_layer.sql — C1-F10 (hand-written)
--
-- The platform layer skeleton (Plan A §14 / F10):
--
--   1. platform_operators  — MindsSparc operators. NOT a tenant role: the
--      table sits outside tenant RLS (RLS enabled + FORCED, NO policies, so
--      only the service-role pool can read it) and the API resolves operator
--      status server-side from the auth user id, never from a JWT claim.
--   2. platform_audit_log  — one row per platform action (operator, action,
--      tenant nullable, summary). Metadata only, never tenant content.
--      Append-only: a trigger refuses UPDATE/DELETE except the FK
--      ON DELETE SET NULL cascades, so the trail survives tenant or operator
--      removal.
--   3. tenant_modules      — module entitlements over the platform catalogue
--      (packages/api-types/src/platform.ts). A MISSING row means ENABLED, so
--      existing tenants keep every module on deploy and no backfill rows are
--      needed. Tenant-scoped (tenant_isolation SELECT so a tenant may read its
--      own entitlements); NO write policy — only the platform (service role)
--      writes.
--   4. tenants.status       — a NOT VALID CHECK on the lifecycle vocabulary
--      (enforced for new writes without scanning or failing on legacy rows),
--      plus the lifecycle backfill below.
--
-- Lifecycle backfill (D3). tenants.status is NOT NULL with no default, so a
-- NULL status cannot exist; the only state that could turn a live tenant dark
-- once the API/workers start enforcing `status = 'active'` is
-- 'provisioning'. We promote a provisioning tenant to 'active' ONLY when it
-- already has at least one ACTIVE membership — i.e. people are using it. A
-- provisioning tenant with no members is genuinely mid-setup and stays as it
-- is. suspended / churned / deleting are deliberate states and are never
-- touched. Every promotion is recorded in platform_audit_log with a NULL
-- operator (system action) so it is visible in the console.
-- =====================================================================

CREATE TABLE "platform_operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "platform_operators_user_id_unique" UNIQUE ("user_id"),
	CONSTRAINT "platform_operators_role_check" CHECK ("role" IN ('owner', 'operator', 'support')),
	CONSTRAINT "platform_operators_email_check" CHECK (char_length("email") BETWEEN 3 AND 320)
);--> statement-breakpoint
ALTER TABLE "platform_operators" ADD CONSTRAINT "platform_operators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES auth.users("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_operators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.platform_operators FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.platform_operators FROM anon, authenticated;--> statement-breakpoint

CREATE TABLE "platform_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid,
	"operator_email" text NOT NULL,
	"action" text NOT NULL,
	"tenant_id" uuid,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_audit_log_action_check" CHECK ("action" ~ '^[a-z][a-z0-9_.]{2,63}$')
);--> statement-breakpoint
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."platform_operators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_platform_audit_log_tenant_chrono" ON "platform_audit_log" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_platform_audit_log_chrono" ON "platform_audit_log" USING btree ("created_at" DESC);--> statement-breakpoint
ALTER TABLE "platform_audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.platform_audit_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.platform_audit_log FROM anon, authenticated;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.platform_audit_log_append_only()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform_audit_log is append-only';
  END IF;
  -- The only permitted UPDATE is an FK ON DELETE SET NULL cascade.
  IF NEW.id = OLD.id
     AND NEW.action = OLD.action
     AND NEW.summary = OLD.summary
     AND NEW.operator_email = OLD.operator_email
     AND NEW.created_at = OLD.created_at
     AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
     AND (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id OR NEW.tenant_id IS NULL)
     AND (NEW.operator_id IS NOT DISTINCT FROM OLD.operator_id OR NEW.operator_id IS NULL)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'platform_audit_log is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "platform_audit_log_append_only" BEFORE UPDATE OR DELETE ON "platform_audit_log" FOR EACH ROW EXECUTE FUNCTION public.platform_audit_log_append_only();--> statement-breakpoint

CREATE TABLE "tenant_modules" (
	"tenant_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	"enabled_at" timestamp with time zone,
	"enabled_by_operator" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_modules_pkey" PRIMARY KEY ("tenant_id","module_key"),
	CONSTRAINT "tenant_modules_module_key_check" CHECK ("module_key" ~ '^[a-z][a-z0-9_]{1,62}$')
);--> statement-breakpoint
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_enabled_by_operator_fkey" FOREIGN KEY ("enabled_by_operator") REFERENCES "public"."platform_operators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_modules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "tenant_modules" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.tenant_modules FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_check" CHECK ("status" IN ('provisioning', 'active', 'suspended', 'churned', 'deleting')) NOT VALID;--> statement-breakpoint

WITH promoted AS (
  UPDATE public.tenants t
     SET status = 'active',
         activated_at = COALESCE(t.activated_at, now())
   WHERE t.status = 'provisioning'
     AND EXISTS (
       SELECT 1 FROM public.tenant_user_memberships m
        WHERE m.tenant_id = t.id AND m.status = 'active'
     )
  RETURNING t.id
)
INSERT INTO public.platform_audit_log (operator_id, operator_email, action, tenant_id, summary)
SELECT NULL, 'system:migration-0134', 'tenant.status_backfill', p.id,
       jsonb_build_object('from', 'provisioning', 'to', 'active',
                          'reason', 'provisioning tenant with active members at platform-layer deploy')
  FROM promoted p;
