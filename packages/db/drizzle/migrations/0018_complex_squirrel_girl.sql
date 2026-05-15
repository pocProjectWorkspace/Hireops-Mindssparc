CREATE TABLE "ai_usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"feature" text NOT NULL,
	"actor_membership_id" uuid,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micros" bigint NOT NULL,
	"latency_ms" integer NOT NULL,
	"request_id" text,
	"succeeded" boolean DEFAULT true NOT NULL,
	"error_code" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_ai_usage_logs_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_credentials" DROP CONSTRAINT "integration_credentials_type_check";--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "fk_ai_usage_logs_actor" FOREIGN KEY ("tenant_id","actor_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_usage_logs_tenant_chrono" ON "ai_usage_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_logs_tenant_feature" ON "ai_usage_logs" USING btree ("tenant_id","feature","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_logs_tenant_model" ON "ai_usage_logs" USING btree ("tenant_id","provider","model","created_at");--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_type_check" CHECK ("integration_credentials"."integration_type" IN (
        'workday',
        'bgv',
        'idp_oidc',
        'idp_saml',
        'esign_docusign',
        'esign_adobe',
        'calendar_google',
        'calendar_outlook',
        'video_zoom',
        'video_teams',
        'jobboard_linkedin',
        'jobboard_naukri',
        'jobboard_indeed',
        'ai_anthropic',
        'ai_openai'
      ));--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "ai_usage_logs" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "ai_usage_logs" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());