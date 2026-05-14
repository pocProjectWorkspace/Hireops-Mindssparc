-- =====================================================================
-- 0012_wise_prism.sql — DB-AUDIT (generated, hand-edited for partitioning)
--
-- Drizzle 0.45.2 does not model PARTITION BY in pgTable, so the
-- generator emitted a regular CREATE TABLE. The CREATE TABLE statement
-- below has been hand-edited to declare audit_logs as RANGE PARTITIONED
-- on created_at, and the initial two monthly partitions are created in
-- the same migration. Everything else (enum, FK, indexes, policies) is
-- exactly what drizzle-kit emitted.
--
-- Companion migration 0013_audit_force_rls_triggers.sql sets FORCE RLS
-- on the parent + each partition and installs the trigger function
-- plus CREATE TRIGGER on every mutable tenant-scoped table.
--
-- Postgres constraints (PG 11+):
--   - The partition key must appear in every UNIQUE / PK constraint, so
--     the PK is composite (id, created_at) and the tenant uniqueness
--     constraint is (tenant_id, id, created_at).
--   - Indexes on the partitioned parent propagate to all partitions
--     automatically.
--   - Defaults on parent columns inherit to partitions.
--   - FK from a partitioned table to a non-partitioned table works
--     directly (audit_logs.tenant_id -> tenants.id).
-- =====================================================================

CREATE TYPE "public"."audit_action" AS ENUM('insert', 'update', 'delete');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"actor_user_id" uuid,
	"actor_membership_id" uuid,
	"request_id" text,
	"user_agent" text,
	"ip_address" "inet",
	"source" text DEFAULT 'app' NOT NULL,
	"before_data" jsonb,
	"after_data" jsonb,
	"changed_columns" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_pkey" PRIMARY KEY("id","created_at"),
	CONSTRAINT "uniq_audit_logs_tenant_id_id_created_at" UNIQUE("tenant_id","id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
-- Initial monthly partitions: current month + next month. DB-AUDIT-RETENTION
-- will own ongoing partition rotation (drop oldest, create next-next) on a
-- monthly cron. Until then partitions are pre-created by hand in migrations.
CREATE TABLE "audit_logs_2026_05" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');--> statement-breakpoint
CREATE TABLE "audit_logs_2026_06" PARTITION OF "audit_logs"
	FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Intentionally no FK from audit_logs.tenant_id to tenants(id) — see
-- packages/db/src/schema/audit-logs.ts for the rationale (cascade-trigger
-- ordering inside DELETE FROM tenants would FK-fail the trigger's audit
-- INSERT). Audit rows survive their subject's deletion.
CREATE INDEX "idx_audit_logs_tenant_chrono" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_entity" ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_actor" ON "audit_logs" USING btree ("tenant_id","actor_user_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "audit_logs" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "audit_logs" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());
