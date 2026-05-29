CREATE TABLE "automation_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "uniq_automation_agents_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "automation_agents_agent_type_check" CHECK ("automation_agents"."agent_type" IN ('scheduling', 'follow_up', 'candidate_qa'))
);
--> statement-breakpoint
ALTER TABLE "automation_agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_agent_triggers_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "agent_triggers_type_check" CHECK ("agent_triggers"."trigger_type" IN ('stage_stale', 'stage_entered', 'message_received', 'time_scheduled', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "agent_triggers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"action_order" integer NOT NULL,
	"action_type" text NOT NULL,
	"action_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_agent_actions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "uniq_agent_actions_agent_order" UNIQUE("tenant_id","agent_id","action_order"),
	CONSTRAINT "agent_actions_type_check" CHECK ("agent_actions"."action_type" IN ('draft_message', 'send_message', 'propose_calendar_slots', 'create_calendar_event', 'update_application_stage', 'notify_recruiter', 'create_audit_entry'))
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"approval_mode" text NOT NULL,
	"approver_role" text,
	"approver_user_id" uuid,
	"conditions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_agent_approval_rules_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "agent_approval_rules_mode_check" CHECK ("agent_approval_rules"."approval_mode" IN ('auto', 'human_required', 'human_optional')),
	CONSTRAINT "agent_approval_rules_role_check" CHECK ("agent_approval_rules"."approver_role" IS NULL OR "agent_approval_rules"."approver_role" IN ('any_recruiter', 'owning_recruiter', 'hr_team', 'specific_user')),
	CONSTRAINT "agent_approval_rules_mode_role_pair_check" CHECK (("agent_approval_rules"."approval_mode" = 'auto') = ("agent_approval_rules"."approver_role" IS NULL)),
	CONSTRAINT "agent_approval_rules_role_user_pair_check" CHECK (("agent_approval_rules"."approver_role" = 'specific_user') = ("agent_approval_rules"."approver_user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_approval_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_run_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"action_order" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"input" jsonb,
	"output" jsonb,
	"approval_request_id" uuid,
	"error" text,
	CONSTRAINT "uniq_agent_run_actions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "agent_run_actions_status_check" CHECK ("agent_run_actions"."status" IN ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "agent_run_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"triggered_by" text NOT NULL,
	"triggered_by_user_id" uuid,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trigger_context" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"error" text,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "uniq_agent_runs_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "agent_runs_triggered_by_check" CHECK ("agent_runs"."triggered_by" IN ('system', 'cron', 'event', 'manual')),
	CONSTRAINT "agent_runs_status_check" CHECK ("agent_runs"."status" IN ('pending', 'running', 'awaiting_approval', 'approved', 'rejected', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_runs_triggered_by_user_pair_check" CHECK (("agent_runs"."triggered_by" = 'manual') = ("agent_runs"."triggered_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_action_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proposed_action_summary" text NOT NULL,
	"proposed_action_payload" jsonb NOT NULL,
	"approver_role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"ttl_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decision_notes" text,
	"edited_payload" jsonb,
	CONSTRAINT "uniq_agent_approval_requests_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "agent_approval_requests_status_check" CHECK ("agent_approval_requests"."status" IN ('pending', 'approved', 'rejected', 'expired', 'auto_approved'))
);
--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_run_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"trigger_context" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "uniq_agent_run_outbox_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "agent_run_outbox_status_check" CHECK ("agent_run_outbox"."status" IN ('pending', 'processing', 'awaiting_approval', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "agent_run_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "candidate_inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"application_id" uuid,
	"from_email" text NOT NULL,
	"to_email" text NOT NULL,
	"subject" text,
	"body_text" text,
	"body_html" text,
	"resend_message_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"agent_run_id" uuid,
	CONSTRAINT "uniq_candidate_inbound_messages_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_agents" ADD CONSTRAINT "automation_agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_agents" ADD CONSTRAINT "fk_automation_agents_created_by" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_triggers" ADD CONSTRAINT "agent_triggers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_triggers" ADD CONSTRAINT "fk_agent_triggers_agent" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."automation_agents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "agent_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD CONSTRAINT "fk_agent_actions_agent" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."automation_agents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_rules" ADD CONSTRAINT "agent_approval_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_rules" ADD CONSTRAINT "fk_agent_approval_rules_agent" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."automation_agents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_rules" ADD CONSTRAINT "fk_agent_approval_rules_action" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."agent_actions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_rules" ADD CONSTRAINT "fk_agent_approval_rules_approver_user" FOREIGN KEY ("approver_user_id") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_actions" ADD CONSTRAINT "agent_run_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_actions" ADD CONSTRAINT "fk_agent_run_actions_run" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."agent_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_actions" ADD CONSTRAINT "fk_agent_run_actions_action" FOREIGN KEY ("tenant_id","action_id") REFERENCES "public"."agent_actions"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "fk_agent_runs_agent" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."automation_agents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "fk_agent_runs_triggered_by_user" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "agent_approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "fk_agent_approval_requests_run" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."agent_runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "fk_agent_approval_requests_run_action" FOREIGN KEY ("tenant_id","run_action_id") REFERENCES "public"."agent_run_actions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "fk_agent_approval_requests_agent" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."automation_agents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approval_requests" ADD CONSTRAINT "fk_agent_approval_requests_decided_by_user" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."tenant_user_memberships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_outbox" ADD CONSTRAINT "agent_run_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_outbox" ADD CONSTRAINT "fk_agent_run_outbox_agent" FOREIGN KEY ("tenant_id","agent_id") REFERENCES "public"."automation_agents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD CONSTRAINT "candidate_inbound_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD CONSTRAINT "fk_candidate_inbound_messages_application" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_inbound_messages" ADD CONSTRAINT "fk_candidate_inbound_messages_agent_run" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_automation_agents_active_name" ON "automation_agents" USING btree ("tenant_id","name") WHERE retired_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_automation_agents_active" ON "automation_agents" USING btree ("tenant_id","enabled","retired_at");--> statement-breakpoint
CREATE INDEX "idx_agent_triggers_agent" ON "agent_triggers" USING btree ("tenant_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_actions_agent" ON "agent_actions" USING btree ("tenant_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_approval_rules_agent" ON "agent_approval_rules" USING btree ("tenant_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_approval_rules_action" ON "agent_approval_rules" USING btree ("tenant_id","action_id");--> statement-breakpoint
CREATE INDEX "idx_agent_run_actions_run" ON "agent_run_actions" USING btree ("tenant_id","run_id","action_order");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_history" ON "agent_runs" USING btree ("tenant_id","agent_id","triggered_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_agent_approval_requests_queue" ON "agent_approval_requests" USING btree ("tenant_id","status","proposed_at");--> statement-breakpoint
CREATE INDEX "idx_agent_approval_requests_agent_status" ON "agent_approval_requests" USING btree ("tenant_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_run_outbox_queue" ON "agent_run_outbox" USING btree ("tenant_id","status","enqueued_at") WHERE status IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "idx_agent_run_outbox_orphan_sweep" ON "agent_run_outbox" USING btree ("locked_until") WHERE status = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_candidate_inbound_messages_resend_id" ON "candidate_inbound_messages" USING btree ("tenant_id","resend_message_id") WHERE resend_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_candidate_inbound_messages_unprocessed" ON "candidate_inbound_messages" USING btree ("tenant_id","processed_at","received_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_agents" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_triggers" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_actions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_approval_rules" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_run_actions" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_runs" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_approval_requests" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_run_outbox" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "candidate_inbound_messages" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());