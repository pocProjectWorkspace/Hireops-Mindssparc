-- =====================================================================
-- 0091_t11_tenant_application_sources.sql — T1.1 / G04 (hand-written)
--
-- The SOURCING-CHANNEL REGISTRY: a tenant's editable CONFIG over the fixed
-- `application_source` pgEnum. The enum stays the canonical, platform-wide
-- taxonomy; this table lets an org declare which channels it uses, what to
-- call them (`label`), whether they are on (`enabled`), an honesty flag
-- (`ingestion_mode`: manual | connector_pending — configuring a channel is
-- NOT connecting an auto-pull; connectors are a deferred work package), and
-- an optional per-source `config` blob. Tenant-scoped derived config.
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known
-- debt). Force-RLS + audit-trigger companion lands in 0092.
-- =====================================================================

CREATE TABLE "tenant_application_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_enum" "application_source" NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"ingestion_mode" text DEFAULT 'manual' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_tenant_application_sources_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_tenant_application_sources_tenant_source" UNIQUE("tenant_id","source_enum"),
	CONSTRAINT "tenant_application_sources_ingestion_mode_check" CHECK ("ingestion_mode" IN ('manual', 'connector_pending'))
);
--> statement-breakpoint
ALTER TABLE "tenant_application_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_application_sources" ADD CONSTRAINT "tenant_application_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tenant_application_sources_tenant" ON "tenant_application_sources" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_application_sources" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
