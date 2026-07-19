-- =====================================================================
-- 0085_recr_03_missing_info_requests.sql — RECR-03 (hand-written)
--
-- The Missing Info Tracker's request-lifecycle row. `pending` is DERIVED
-- (a tracked field is absent + no row here); this table stores only the
-- post-request states, mirroring the application-document request→verify
-- lifecycle: requested → received → verified (+ dismissed = "N/A"). The
-- "Request" action ALSO enqueues a real candidate notification; the outbox
-- id is recorded for provenance. There is deliberately NO score-impact / cap
-- column — a missing field's hard consequence is a deterministic stage-gate,
-- never a fabricated score penalty.
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- Force-RLS + audit-trigger companions land in 0087.
-- =====================================================================

CREATE TABLE "missing_info_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"note" text,
	"requested_by_membership_id" uuid NOT NULL,
	"resolved_by_membership_id" uuid,
	"notification_outbox_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_contact_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_missing_info_requests_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_missing_info_requests_field" UNIQUE("tenant_id","application_id","field_key")
);
--> statement-breakpoint
ALTER TABLE "missing_info_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "missing_info_requests" ADD CONSTRAINT "missing_info_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_info_requests" ADD CONSTRAINT "fk_missing_info_requests_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missing_info_requests" ADD CONSTRAINT "fk_missing_info_requests_requested_by" FOREIGN KEY ("tenant_id","requested_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_missing_info_requests_app" ON "missing_info_requests" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "idx_missing_info_requests_status" ON "missing_info_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "missing_info_requests" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
