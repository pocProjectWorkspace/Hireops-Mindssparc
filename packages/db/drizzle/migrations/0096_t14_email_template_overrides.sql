-- =====================================================================
-- 0096_t14_email_template_overrides.sql — T1.4 / G09 (hand-written)
--
-- TENANT COPY OVERRIDES for the 12 transactional email templates. Every
-- template in @hireops/email-templates ships code-owned copy; an org had no
-- way to change any wording. This table is that config layer: one row per
-- (tenant, template_key) with an optional subject override and a per-named-slot
-- override map (jsonb slotKey → text).
--
-- HONESTY: only the subject + the template's NAMED TEXT SLOTS are overridable.
-- There is NO raw-HTML / full-body column — layout, styles, and DATA bindings
-- stay code-owned. A disabled row, or no row, renders byte-identically to the
-- shipped template. The API rejects any slotKey/token a template does not
-- declare (EMAIL_TEMPLATE_CATALOG).
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- Force-RLS + audit-trigger companion lands in 0097.
-- =====================================================================

CREATE TABLE "tenant_email_template_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"subject_override" text,
	"slot_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_tenant_email_template_overrides_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_tenant_email_template_overrides_tenant_template" UNIQUE("tenant_id","template_key")
);
--> statement-breakpoint
ALTER TABLE "tenant_email_template_overrides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_email_template_overrides" ADD CONSTRAINT "tenant_email_template_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tenant_email_template_overrides_tenant" ON "tenant_email_template_overrides" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_email_template_overrides" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
