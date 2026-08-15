-- =====================================================================
-- 0114_partner_commercials.sql — P2 (hand-written)
--
-- partner_msa + partner_fees: the commercial keystone the completion
-- audit flagged (its absence blocked H2/H5/H6 — exclusivity override,
-- MSA engine, fee tracking) and the schema that unblocks reports #7
-- (partner scorecard fees) and #8 (cost per hire).
--
-- Same conventions as 0025/0026/0027: composite (tenant_id, id) FKs,
-- tenant_isolation RLS + FORCE, audit triggers. partner_fees FKs are
-- RESTRICT on org/application — fee rows are financial records.
-- =====================================================================

CREATE TABLE "partner_msa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_org_id" uuid NOT NULL,
	"fee_model" text NOT NULL,
	"fee_percent" numeric(5, 2),
	"flat_fee_minor" bigint,
	"fee_currency" text DEFAULT 'INR' NOT NULL,
	"exclusivity_window_days" integer DEFAULT 90 NOT NULL,
	"exclusivity_scope" text DEFAULT 'org_wide' NOT NULL,
	"probation_holdback_percent" numeric(5, 2) DEFAULT 25 NOT NULL,
	"replacement_guarantee_days" integer DEFAULT 90 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_partner_msa_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "partner_msa_fee_model_check" CHECK ("fee_model" IN ('percentage_ctc', 'flat_per_hire')),
	CONSTRAINT "partner_msa_fee_operand_check" CHECK (("fee_model" = 'percentage_ctc' AND "fee_percent" IS NOT NULL) OR ("fee_model" = 'flat_per_hire' AND "flat_fee_minor" IS NOT NULL)),
	CONSTRAINT "partner_msa_exclusivity_scope_check" CHECK ("exclusivity_scope" IN ('org_wide', 'req_only'))
);--> statement-breakpoint
ALTER TABLE "partner_msa" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "partner_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"partner_org_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"offer_id" uuid,
	"msa_id" uuid,
	"msa_snapshot" jsonb NOT NULL,
	"fee_minor" bigint NOT NULL,
	"fee_currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'accrued' NOT NULL,
	"holdback_release_at" timestamp with time zone,
	"hired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_partner_fees_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_partner_fees_application" UNIQUE("tenant_id","application_id"),
	CONSTRAINT "partner_fees_status_check" CHECK ("status" IN ('accrued', 'payable', 'paid', 'disputed'))
);--> statement-breakpoint
ALTER TABLE "partner_fees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "partner_msa" ADD CONSTRAINT "partner_msa_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_msa" ADD CONSTRAINT "fk_partner_msa_partner_org" FOREIGN KEY ("tenant_id","partner_org_id") REFERENCES "public"."partner_orgs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_msa" ADD CONSTRAINT "fk_partner_msa_created_by" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_fees" ADD CONSTRAINT "partner_fees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_fees" ADD CONSTRAINT "fk_partner_fees_partner_org" FOREIGN KEY ("tenant_id","partner_org_id") REFERENCES "public"."partner_orgs"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_fees" ADD CONSTRAINT "fk_partner_fees_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_fees" ADD CONSTRAINT "fk_partner_fees_msa" FOREIGN KEY ("tenant_id","msa_id") REFERENCES "public"."partner_msa"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_partner_msa_live" ON "partner_msa" USING btree ("tenant_id","partner_org_id") WHERE effective_to IS NULL;--> statement-breakpoint
CREATE INDEX "idx_partner_msa_org" ON "partner_msa" USING btree ("tenant_id","partner_org_id","effective_from");--> statement-breakpoint
CREATE INDEX "idx_partner_fees_org_status" ON "partner_fees" USING btree ("tenant_id","partner_org_id","status");--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "partner_msa" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "partner_fees" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

ALTER TABLE public.partner_msa FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.partner_fees FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_partner_msa
AFTER INSERT OR UPDATE OR DELETE ON public.partner_msa
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();--> statement-breakpoint

CREATE TRIGGER audit_partner_fees
AFTER INSERT OR UPDATE OR DELETE ON public.partner_fees
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
