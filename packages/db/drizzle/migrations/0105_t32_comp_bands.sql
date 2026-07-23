-- =====================================================================
-- 0105_t32_comp_bands.sql — T3.2 / G15 (hand-written)
--
-- Comp-band LIBRARY (Phase 3, Org structure). A tenant's editable set of NAMED
-- compensation bands — a controlled list the requisition wizard's picker reads,
-- so a position's comp values come from a managed band, not a free-typed guess.
--
-- FLAT + named, with an optional free-text `level` label (no structured BU /
-- location scoping — deferred). Tenant-scoped: standard tenant_isolation RLS.
--
-- HONESTY: not a decorative dropdown. When the wizard sends a compBandId,
-- createRequisitionDraft COPIES min_major/max_major/currency onto
-- positions.comp_band_min/max/comp_currency (MAJOR INR), which the existing
-- comp-rules.ts verdict engine + feasibility/detail views already read — so the
-- chosen band genuinely drives the position's comp. positions.comp_band_id is
-- retained as provenance so an edited value shows as a divergence.
--
-- Compound (tenant_id, id) unique lets positions compound-FK a band (mirrors
-- uniq_business_units_tenant_id_id). Bands are archived, never deleted: the
-- positions FK is ON DELETE RESTRICT (the interview_panelists precedent for
-- compound FKs that can't cleanly SET NULL).
--
-- Hand-written (the drizzle snapshot chain is behind the schema — known debt).
-- Force-RLS + audit-trigger companion lands in 0106.
-- =====================================================================

CREATE TABLE "comp_bands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"level" text,
	"currency" char(3) NOT NULL,
	"min_major" numeric(12, 2) NOT NULL,
	"max_major" numeric(12, 2) NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_comp_bands_tenant_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "uniq_comp_bands_tenant_id_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "comp_bands_range_check" CHECK ("min_major" <= "max_major")
);
--> statement-breakpoint
ALTER TABLE "comp_bands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comp_bands" ADD CONSTRAINT "comp_bands_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_comp_bands_tenant" ON "comp_bands" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "comp_bands" AS PERMISSIVE FOR ALL TO "authenticated" USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());--> statement-breakpoint

-- Provenance link from positions → the band its comp values were populated from.
-- Compound (tenant_id, comp_band_id) FK (a position + band share a tenant),
-- ON DELETE RESTRICT (bands are archived, never deleted).
ALTER TABLE "positions" ADD COLUMN "comp_band_id" uuid;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "fk_positions_comp_band" FOREIGN KEY ("tenant_id","comp_band_id") REFERENCES "public"."comp_bands"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_positions_comp_band" ON "positions" USING btree ("tenant_id","comp_band_id");
