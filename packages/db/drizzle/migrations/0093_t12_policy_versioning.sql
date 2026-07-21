-- =====================================================================
-- 0093_t12_policy_versioning.sql — T12 / G10 (hand-written)
--
-- Make the HR policy library org-editable + versioned.
--
--   1. hr_policy_documents gains version / is_archived /
--      updated_by_membership_id so a policy can be authored, edited, versioned,
--      and archived (soft) instead of only seeded read-only.
--   2. hr_policy_document_versions is the immutable content-change history —
--      one snapshot row per saved version. This IS the governance record for
--      policy edits: hr_policy_documents deliberately keeps NO row-change
--      trigger (an idempotent seed re-run would spray audit noise — the 0067
--      stance), and the write mutations capture intent via withAudit.
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- FORCE RLS on the new table lands in 0095.
-- =====================================================================

ALTER TABLE "hr_policy_documents"
  ADD COLUMN "version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "is_archived" boolean DEFAULT false NOT NULL,
  ADD COLUMN "updated_by_membership_id" uuid;--> statement-breakpoint

CREATE TABLE "hr_policy_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"summary" text NOT NULL,
	"body_md" text NOT NULL,
	"change_note" text,
	"edited_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_hr_policy_doc_versions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_hr_policy_doc_versions_doc_version" UNIQUE("tenant_id","policy_document_id","version"),
	CONSTRAINT "hr_policy_doc_versions_version_check" CHECK ("hr_policy_document_versions"."version" >= 1),
	CONSTRAINT "hr_policy_doc_versions_category_check" CHECK ("hr_policy_document_versions"."category" IN ('offers', 'benefits', 'policies'))
);
--> statement-breakpoint
ALTER TABLE "hr_policy_document_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_policy_document_versions" ADD CONSTRAINT "hr_policy_document_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policy_document_versions" ADD CONSTRAINT "hr_policy_document_versions_policy_document_id_fk" FOREIGN KEY ("policy_document_id") REFERENCES "public"."hr_policy_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_hr_policy_doc_versions_doc" ON "hr_policy_document_versions" USING btree ("tenant_id","policy_document_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "hr_policy_document_versions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
