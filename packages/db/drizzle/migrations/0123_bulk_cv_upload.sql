-- =====================================================================
-- 0123_bulk_cv_upload.sql — PC-2 bulk CV upload per requisition (hand-written)
--
-- A recruiter drops many PDF/DOCX CVs (or a .zip of them) on a requisition.
-- The api stores each file and writes one bulk_cv_items row per file; a
-- worker drain (apps/workers/src/lib/bulk-cv-drain.ts) parses each one and
-- creates the candidate + application through the SAME ingest core partner
-- submissions use (apps/api/src/lib/application-ingest.ts). Three changes,
-- one migration:
--
--   application_source      + 'bulk_upload'   (enum value)
--   bulk_cv_batches         NEW — one per upload session (who, which req, on
--                                 what basis)
--   bulk_cv_items           NEW — one per file; the drain's work queue and the
--                                 drawer's per-file status
--
-- ─────────────────────────────────────────────────────────────────────
-- THE ENUM VALUE
-- ─────────────────────────────────────────────────────────────────────
-- ADD VALUE IF NOT EXISTS is additive + idempotent, and the value is NOT
-- used anywhere in this migration, so it commits cleanly inside the
-- migrator's transaction (same discipline as 0050).
--
-- ─────────────────────────────────────────────────────────────────────
-- CONSENT / BASIS
-- ─────────────────────────────────────────────────────────────────────
-- A bulk-uploaded candidate has given NO consent to the platform — the CV
-- came from an agency, an RPO mailbox or a recruiter's own sourcing. So the
-- candidate row is created with consent_granted_at / consent_version NULL
-- and talent_pool_consent false (never the apply form's "candidate
-- consented" stamp). What IS recorded is the processing basis on the batch:
-- the uploader (user + membership) and their attestation that the CVs were
-- supplied for this requisition (`basis`, `attestation_version`). Every item
-- inherits it through batch_id; the dedup audit row carries the batch id.
--
-- ─────────────────────────────────────────────────────────────────────
-- THE ITEM LADDER  (text + CHECK, not pgEnum — HANDOVER reality #114)
-- ─────────────────────────────────────────────────────────────────────
--   queued → parsing → created | duplicate | failed
--   skipped   rejected at upload time (wrong type, too large, unsafe zip
--             entry name). Never stored → storage_key NULL → not retryable.
-- `lease_expires_at` bounds a 'parsing' claim (an expired lease is
-- re-claimable, the 0121 evidence-drain shape) and doubles as the
-- not-before of a 'queued' row that is backing off after a failed attempt.
-- Retry (recruiter) puts a failed row back to 'queued' with attempt_count 0.
--
-- Conventions: compound (tenant_id, x) FKs onto the uniq_*_tenant_id_id
-- keys; tenant-scoped FOR ALL RLS + FORCE ROW LEVEL SECURITY; audit trigger
-- on the batch only (it is the governed "who uploaded what, on what basis"
-- record). The items table is a work queue whose every transition would
-- flood audit_logs 3-4× per file — same exclusion as ai_score_outbox /
-- transcript_outbox; its own status columns are its log.
-- =====================================================================

ALTER TYPE public.application_source ADD VALUE IF NOT EXISTS 'bulk_upload';--> statement-breakpoint

CREATE TABLE "bulk_cv_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	-- auth.users id of the uploader. The worker impersonates this user's
	-- tenant context when it creates the candidate, so audit_logs attribute
	-- the created rows to the human who uploaded them.
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_by_membership_id" uuid,
	"basis" text DEFAULT 'recruiter_attested' NOT NULL,
	"attestation_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_bulk_cv_batches_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "bulk_cv_batches_basis_check" CHECK ("basis" IN ('recruiter_attested'))
);--> statement-breakpoint
ALTER TABLE "bulk_cv_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "bulk_cv_batches" ADD CONSTRAINT "bulk_cv_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_cv_batches" ADD CONSTRAINT "fk_bulk_cv_batches_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_cv_batches" ADD CONSTRAINT "fk_bulk_cv_batches_membership" FOREIGN KEY ("tenant_id","uploaded_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ("uploaded_by_membership_id") ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "idx_bulk_cv_batches_req" ON "bulk_cv_batches" USING btree ("tenant_id","requisition_id","created_at");--> statement-breakpoint

CREATE TABLE "bulk_cv_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	-- Denormalised from the batch so the drain needs no join.
	"requisition_id" uuid NOT NULL,
	-- Display name: the uploaded file name, or the path inside the zip.
	"file_name" text NOT NULL,
	-- NULL for 'skipped' rows (never stored).
	"storage_key" text,
	"content_type" text,
	"size_bytes" bigint,
	-- sha256 hex of the bytes; same-batch exact duplicates are caught at upload.
	"checksum" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"outcome_detail" text,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"candidate_id" uuid,
	"application_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_bulk_cv_items_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "bulk_cv_items_status_check" CHECK ("status" IN ('queued', 'parsing', 'created', 'duplicate', 'failed', 'skipped')),
	CONSTRAINT "bulk_cv_items_attempt_count_check" CHECK ("attempt_count" >= 0)
);--> statement-breakpoint
ALTER TABLE "bulk_cv_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "bulk_cv_items" ADD CONSTRAINT "bulk_cv_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_cv_items" ADD CONSTRAINT "fk_bulk_cv_items_batch" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."bulk_cv_batches"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_cv_items" ADD CONSTRAINT "fk_bulk_cv_items_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- SET NULL keeps the upload record if a candidate / application is later
-- erased (retention / DSAR); the composite FK names only the id column in the
-- SET NULL list so tenant_id is never nulled (PG15+ column-list syntax).
ALTER TABLE "bulk_cv_items" ADD CONSTRAINT "fk_bulk_cv_items_candidate" FOREIGN KEY ("tenant_id","candidate_id") REFERENCES "public"."candidates"("tenant_id","id") ON DELETE set null ("candidate_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_cv_items" ADD CONSTRAINT "fk_bulk_cv_items_application" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE set null ("application_id") ON UPDATE no action;--> statement-breakpoint

-- The drawer: one batch's items in upload order.
CREATE INDEX "idx_bulk_cv_items_batch" ON "bulk_cv_items" USING btree ("tenant_id","batch_id","created_at");--> statement-breakpoint
-- The drain claim: WHERE status = 'queued' OR (status = 'parsing' AND lease
-- expired). Cross-tenant by design (service-role worker), so tenant_id does
-- not lead. Partial — terminal rows never need scanning.
CREATE INDEX "idx_bulk_cv_items_drain" ON "bulk_cv_items" USING btree ("status","lease_expires_at","created_at") WHERE "status" IN ('queued', 'parsing');--> statement-breakpoint

-- ── RLS policies ────────────────────────────────────────────────────
CREATE POLICY "tenant_isolation" ON "bulk_cv_batches" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bulk_cv_items" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

ALTER TABLE public.bulk_cv_batches FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.bulk_cv_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- ── Audit trigger (batch only — see header) ─────────────────────────
CREATE TRIGGER audit_bulk_cv_batches
AFTER INSERT OR UPDATE OR DELETE ON public.bulk_cv_batches
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
