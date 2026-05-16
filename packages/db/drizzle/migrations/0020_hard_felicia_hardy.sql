CREATE TABLE "api_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"actor_membership_id" uuid,
	"request_id" text,
	"source" text DEFAULT 'app' NOT NULL,
	"input_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_api_audit_logs_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "api_audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_audit_logs" ADD CONSTRAINT "api_audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_audit_logs" ADD CONSTRAINT "fk_api_audit_logs_actor" FOREIGN KEY ("tenant_id","actor_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_audit_logs_tenant_chrono" ON "api_audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_audit_logs_tenant_action" ON "api_audit_logs" USING btree ("tenant_id","action","created_at");--> statement-breakpoint
CREATE INDEX "idx_api_audit_logs_actor" ON "api_audit_logs" USING btree ("tenant_id","actor_user_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "api_audit_logs" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "api_audit_logs" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());