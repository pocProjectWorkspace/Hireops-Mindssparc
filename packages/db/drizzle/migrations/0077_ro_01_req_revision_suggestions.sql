-- =====================================================================
-- 0077_ro_01_req_revision_suggestions.sql — RO-01 (hand-written)
--
-- The cached, REAL-AI revision suggestions for a REJECTED requisition.
-- Sibling of requisition_feasibility (0062) and comp_recommendations
-- (0068): AI prose only, cached ONE row per requisition, regenerate
-- REPLACES (ON CONFLICT upsert). Tenant-scoped derived data.
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known
-- debt). Force-RLS + audit-trigger companions land in 0078/0079.
-- =====================================================================

CREATE TABLE "req_revision_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"suggestions" jsonb NOT NULL,
	"rejection_reason" text,
	"model" text,
	"prompt_version" text,
	"generated_by_membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_req_revision_suggestions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_req_revision_suggestions_per_req" UNIQUE("tenant_id","requisition_id")
);
--> statement-breakpoint
ALTER TABLE "req_revision_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "req_revision_suggestions" ADD CONSTRAINT "req_revision_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "req_revision_suggestions" ADD CONSTRAINT "fk_req_revision_suggestions_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "req_revision_suggestions" ADD CONSTRAINT "fk_req_revision_suggestions_generated_by" FOREIGN KEY ("tenant_id","generated_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_req_revision_suggestions_req" ON "req_revision_suggestions" USING btree ("tenant_id","requisition_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "req_revision_suggestions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
