CREATE TABLE "integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"integration_type" text NOT NULL,
	"credential_envelope" "bytea" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "uniq_integration_credentials_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "integration_credentials_type_check" CHECK ("integration_credentials"."integration_type" IN (
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
        'jobboard_indeed'
      ))
);
--> statement-breakpoint
ALTER TABLE "integration_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_integration_credentials_tenant_type" ON "integration_credentials" USING btree ("tenant_id","integration_type");--> statement-breakpoint
CREATE POLICY "tenant_isolation_admin_select" ON "integration_credentials" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id() AND has_role('admin'));