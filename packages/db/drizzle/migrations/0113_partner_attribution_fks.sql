-- 0113 — partner attribution FKs on applications (P0.5).
-- The columns shipped un-constrained in 0025 ("FKs deferred to DB-PARTNER")
-- and were never enforced. Defensive orphan-NULLing first so this applies
-- cleanly on any environment with pre-FK data; attribution on an orphaned
-- row is meaningless, the application itself must survive.
UPDATE "applications" a SET "source_partner_id" = NULL
WHERE a."source_partner_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "partner_orgs" po
    WHERE po."tenant_id" = a."tenant_id" AND po."id" = a."source_partner_id"
  );--> statement-breakpoint
UPDATE "applications" a SET "submitted_by_partner_user_id" = NULL
WHERE a."submitted_by_partner_user_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "partner_users" pu
    WHERE pu."tenant_id" = a."tenant_id" AND pu."id" = a."submitted_by_partner_user_id"
  );--> statement-breakpoint
-- Composite (tenant_id, id) refs — the house cross-tenant-unrepresentable
-- style (0025). ON DELETE SET NULL is column-targeted (PG15+): a bare
-- SET NULL on a composite FK would try to null tenant_id as well.
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_source_partner"
  FOREIGN KEY ("tenant_id","source_partner_id")
  REFERENCES "public"."partner_orgs"("tenant_id","id")
  ON DELETE SET NULL ("source_partner_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "fk_applications_submitted_by_partner_user"
  FOREIGN KEY ("tenant_id","submitted_by_partner_user_id")
  REFERENCES "public"."partner_users"("tenant_id","id")
  ON DELETE SET NULL ("submitted_by_partner_user_id") ON UPDATE no action;
