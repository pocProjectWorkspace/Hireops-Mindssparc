CREATE TABLE "ai_score_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"attempt_cap" smallint DEFAULT 5 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_ai_score_outbox_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_ai_score_outbox_per_application" UNIQUE("tenant_id","application_id"),
	CONSTRAINT "ai_score_outbox_status_check" CHECK ("ai_score_outbox"."status" IN ('pending', 'processing', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "ai_score_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_score_outbox" ADD CONSTRAINT "ai_score_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_score_outbox" ADD CONSTRAINT "fk_ai_score_outbox_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_score_outbox_queue" ON "ai_score_outbox" USING btree ("tenant_id","status","created_at") WHERE status IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_ai_score_outbox_orphan_sweep" ON "ai_score_outbox" USING btree ("claimed_at") WHERE status = 'processing';--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_score_outbox" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());