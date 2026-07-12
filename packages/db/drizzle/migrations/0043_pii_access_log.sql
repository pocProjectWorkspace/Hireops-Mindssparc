-- =====================================================================
-- 0043_pii_access_log.sql — PII-01 (hand-written)
--
-- pii_access_log: every high-value PII read (who / when / why). ADR-002 §7
-- makes this mandatory under DPDPA. Modelled on api_audit_logs end-to-end:
-- no partitioning (Wave 1 volume doesn't justify it), no audit trigger (it
-- IS an audit log), append-only under FORCE RLS with split select/insert
-- policies. FORCE is added by the companion 0044.
--
-- Hand-written rather than drizzle-generated: the generate path accumulates
-- drift against the prior hand-written companions (see HANDOVER reality #83),
-- so append-only audit tables in this repo are hand-written the way the
-- api_audit_logs pair (0020/0021) was.
-- =====================================================================

CREATE TABLE "pii_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_membership_id" uuid,
	"actor_label" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"fields_accessed" text[],
	"reason" text NOT NULL,
	"request_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pii_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pii_access_log" ADD CONSTRAINT "pii_access_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii_access_log" ADD CONSTRAINT "fk_pii_access_log_actor" FOREIGN KEY ("tenant_id","actor_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pii_access_log_tenant_chrono" ON "pii_access_log" USING btree ("tenant_id","accessed_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_pii_access_log_tenant_entity" ON "pii_access_log" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "pii_access_log" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "pii_access_log" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());
