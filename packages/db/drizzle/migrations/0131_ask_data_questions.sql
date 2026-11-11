-- =====================================================================
-- 0131_ask_data_questions.sql — PC-21 (hand-written)
--
-- The "Ask your data" question log: one row per answered question (who
-- asked, their roles at the time, the typed text or NULL for a chip click,
-- and the resolved catalog intent + effective params). It feeds the
-- "Your recent" and "Popular in your team" chips and the admin
-- top-questions view.
--
-- A LOG, modelled on assistant_actions (0109/0110) and pii_access_log
-- (0043/0044): append-only under FORCE RLS — split tenant_isolation_select
-- + tenant_isolation_insert policies, NO update/delete policy for
-- authenticated — and no audit_record_change trigger (a log does not need
-- a change stream about itself).
--
-- `intent` is text, not an enum: the catalog is code
-- (packages/api-types/src/ask-data.ts) and growing it must not need DDL.
-- The membership FK is compound (tenant_id, membership_id) so a row can
-- never point at another tenant's member; ON DELETE CASCADE because the log
-- has no meaning once the asker's membership is gone.
-- =====================================================================

CREATE TABLE "ask_data_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"asker_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"question" text,
	"intent" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ask_data_questions_source_check" CHECK ("source" IN ('chip', 'matched', 'ai')),
	CONSTRAINT "ask_data_questions_question_len_check" CHECK ("question" IS NULL OR char_length("question") <= 500)
);--> statement-breakpoint
ALTER TABLE "ask_data_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ask_data_questions" ADD CONSTRAINT "ask_data_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ask_data_questions" ADD CONSTRAINT "fk_ask_data_questions_membership" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ask_data_questions_member_chrono" ON "ask_data_questions" USING btree ("tenant_id","membership_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_ask_data_questions_tenant_chrono" ON "ask_data_questions" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "ask_data_questions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "ask_data_questions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE public.ask_data_questions FORCE ROW LEVEL SECURITY;
