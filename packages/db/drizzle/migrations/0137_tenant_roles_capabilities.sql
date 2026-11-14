-- =====================================================================
-- 0137_tenant_roles_capabilities.sql — C2-F1 (hand-written)
--
-- Tenant-defined roles over a fixed PLATFORM capability list (Plan A §2 F1 +
-- §15 P5 target populations).
--
--   tenant_roles        NEW — a tenant CUSTOM role: key, label, base_role
--                       (one of the internal tenant_role enum values — that is
--                       what the JWT `roles` claim + RLS keep using), active.
--   role_capabilities   NEW — the role's bundle: (role_key, capability, scope)
--                       with scope ∈ own / team / business_unit / legal_entity /
--                       all. The capability list is code (api-types
--                       capabilities.ts); the column is format-checked here and
--                       catalog-checked by the API.
--   tenant_user_memberships.role_key  NEW, nullable. NULL = the member's base
--                       roles resolve to the PLATFORM DEFAULT bundles (exactly
--                       the pre-C2-F1 gates). Set = that custom role's bundle
--                       only.
--
-- SYSTEM roles are NOT rows: the platform default bundle for each enum role
-- lives in code, so a platform upgrade reaches every tenant and nothing has to
-- be backfilled or provisioned. Custom keys may not collide with an enum role
-- (CHECK below).
--
-- Roles are deactivated, never deleted while in use: the membership FK is
-- ON DELETE RESTRICT. role_capabilities cascades with its role.
--
-- tenant_isolation + FORCE RLS + the audit trigger on both new tables (tenant
-- configuration). No change to the auth hook: role_key is not a claim.
-- No backfill — every existing membership keeps role_key NULL.
-- =====================================================================

-- ── tenant_roles ────────────────────────────────────────────────────
CREATE TABLE "tenant_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"base_role" "tenant_role" NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_tenant_roles_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_tenant_roles_tenant_key" UNIQUE("tenant_id","key"),
	CONSTRAINT "tenant_roles_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,47}$'),
	CONSTRAINT "tenant_roles_key_not_system_check" CHECK ("key" NOT IN ('admin','recruiter','hiring_manager','panel_member','hr_ops','people_ops','it_admin','partner_admin','partner_user','candidate','employee','hr_head')),
	CONSTRAINT "tenant_roles_base_role_check" CHECK ("base_role" IN ('admin','recruiter','hiring_manager','panel_member','hr_ops','people_ops','it_admin','hr_head')),
	CONSTRAINT "tenant_roles_label_check" CHECK (char_length("label") BETWEEN 1 AND 60),
	CONSTRAINT "tenant_roles_description_check" CHECK ("description" IS NULL OR char_length("description") <= 400)
);--> statement-breakpoint
ALTER TABLE "tenant_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_roles" ADD CONSTRAINT "tenant_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_roles" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.tenant_roles FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_tenant_roles
AFTER INSERT OR UPDATE OR DELETE ON public.tenant_roles
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── role_capabilities ───────────────────────────────────────────────
CREATE TABLE "role_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"capability" text NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_role_capabilities_grant" UNIQUE("tenant_id","role_key","capability"),
	CONSTRAINT "role_capabilities_capability_check" CHECK ("capability" ~ '^[a-z_]+\.[a-z_]+$'),
	CONSTRAINT "role_capabilities_scope_check" CHECK ("scope" IN ('own','team','business_unit','legal_entity','all'))
);--> statement-breakpoint
ALTER TABLE "role_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "fk_role_capabilities_role" FOREIGN KEY ("tenant_id","role_key") REFERENCES "public"."tenant_roles"("tenant_id","key") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "role_capabilities" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.role_capabilities FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER audit_role_capabilities
AFTER INSERT OR UPDATE OR DELETE ON public.role_capabilities
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

-- ── tenant_user_memberships.role_key ────────────────────────────────
ALTER TABLE "tenant_user_memberships" ADD COLUMN "role_key" text;--> statement-breakpoint
ALTER TABLE "tenant_user_memberships" ADD CONSTRAINT "fk_membership_tenant_role" FOREIGN KEY ("tenant_id","role_key") REFERENCES "public"."tenant_roles"("tenant_id","key") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "idx_membership_role_key" ON "tenant_user_memberships" USING btree ("tenant_id","role_key") WHERE "role_key" IS NOT NULL;
