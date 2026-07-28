-- =====================================================================
-- 0109_iris_assistant_actions.sql — IRIS-A1 (hand-written)
--
-- assistant_actions: provenance for every transaction a user-invoked
-- assistant ("iris") executed on a human's behalf, after that human confirmed
-- a resolved preview. iris.execute writes one row the instant the underlying
-- gated procedure commits; iris.getProvenance reads it back to drive the future
-- "AI-assisted" pill. A requisition created via Iris carries a row here; a
-- human-created one does not.
--
-- Purely ADDITIVE — a new table only; touches no existing table. Modelled
-- end-to-end on ai_usage_logs / api_audit_logs (0019-0021, 0043-0044): an
-- append-only log with split select/insert policies, no UPDATE/DELETE for
-- authenticated under FORCE RLS, and NO audit_record_change() trigger (it IS a
-- log — a trigger would be a 1:1 noise stream). FORCE is added by the companion
-- 0110.
--
-- confirmed_by_user_id is the auth.users id (JWT sub) of the confirming human;
-- no modelled FK — auth.users is cross-schema (same treatment as
-- api_audit_logs.actor_user_id). entity_type / entity_id are a loose, nullable
-- reference to the created/changed entity — intentionally NOT a hard FK so this
-- ledger never blocks or cascades against the domain tables it annotates.
--
-- Hand-written rather than drizzle-generated: the generate path accumulates
-- drift against the prior hand-written companions (HANDOVER reality #83), so
-- append-only log tables in this repo are hand-written the way the
-- ai_usage_logs / api_audit_logs / pii_access_log pairs were.
-- =====================================================================

CREATE TABLE "assistant_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"assistant" text DEFAULT 'iris' NOT NULL,
	"action_id" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"confirmed_by_user_id" uuid,
	"status" text DEFAULT 'executed' NOT NULL,
	"params_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_actions_tenant_chrono" ON "assistant_actions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_actions_tenant_entity" ON "assistant_actions" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "assistant_actions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "assistant_actions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());
