CREATE TYPE "public"."approval_subject_type" AS ENUM('headcount_envelope', 'requisition', 'jd_version', 'offer');--> statement-breakpoint
CREATE TYPE "public"."approval_request_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."approval_decision_outcome" AS ENUM('approved', 'rejected', 'abstained');--> statement-breakpoint
CREATE TABLE "approval_matrices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" "approval_subject_type" NOT NULL,
	"name" text NOT NULL,
	"rules" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_approval_matrices_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "approval_matrices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"matrix_version_snapshot" jsonb NOT NULL,
	"resolved_steps" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_approval_chains_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "approval_chains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"chain_id" uuid NOT NULL,
	"subject_type" "approval_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" "approval_request_status" DEFAULT 'pending' NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"requested_by_membership_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_approval_requests_tenant_id_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"outcome" "approval_decision_outcome" NOT NULL,
	"approver_membership_id" uuid,
	"approver_external_ref" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"comment" text,
	"metadata" jsonb,
	CONSTRAINT "uniq_approval_decisions_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_decisions_approver_xor_check" CHECK ((approver_membership_id IS NOT NULL AND approver_external_ref IS NULL)
        OR (approver_membership_id IS NULL AND approver_external_ref IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "approval_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval_matrices" ADD CONSTRAINT "approval_matrices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrices" ADD CONSTRAINT "fk_approval_matrices_created_by" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_chains" ADD CONSTRAINT "approval_chains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_chains" ADD CONSTRAINT "fk_approval_chains_matrix" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."approval_matrices"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "fk_approval_requests_chain" FOREIGN KEY ("tenant_id","chain_id") REFERENCES "public"."approval_chains"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "fk_approval_requests_requested_by" FOREIGN KEY ("tenant_id","requested_by_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "fk_approval_decisions_request" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."approval_requests"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "fk_approval_decisions_approver" FOREIGN KEY ("tenant_id","approver_membership_id") REFERENCES "public"."tenant_user_memberships"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_approval_matrices_active_lookup" ON "approval_matrices" USING btree ("tenant_id","subject_type","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "idx_approval_chains_by_matrix" ON "approval_chains" USING btree ("tenant_id","matrix_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_approval_requests_one_pending_per_subject" ON "approval_requests" USING btree ("tenant_id","subject_type","subject_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_approval_requests_expiry_sweep" ON "approval_requests" USING btree ("tenant_id","status","expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "idx_approval_requests_by_requester" ON "approval_requests" USING btree ("tenant_id","requested_by_membership_id","created_at") WHERE requested_by_membership_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_approval_requests_analytics" ON "approval_requests" USING btree ("tenant_id","subject_type","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_approval_decisions_request" ON "approval_decisions" USING btree ("tenant_id","request_id","step_index","decided_at");--> statement-breakpoint
CREATE INDEX "idx_approval_decisions_by_approver" ON "approval_decisions" USING btree ("tenant_id","approver_membership_id","decided_at") WHERE approver_membership_id IS NOT NULL;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval_matrices" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval_chains" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval_requests" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "approval_decisions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id = current_tenant_id());--> statement-breakpoint
CREATE POLICY "tenant_isolation_insert" ON "approval_decisions" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (tenant_id = current_tenant_id());