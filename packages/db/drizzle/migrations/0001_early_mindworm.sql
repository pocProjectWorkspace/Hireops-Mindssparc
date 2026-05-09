CREATE TABLE "tenant_user_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_user_memberships" ADD CONSTRAINT "tenant_user_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_membership_user_tenant" ON "tenant_user_memberships" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE INDEX "idx_membership_user" ON "tenant_user_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_membership_tenant" ON "tenant_user_memberships" USING btree ("tenant_id");