-- =====================================================================
-- 0132_c1_bug_fixes.sql — C1-BUGS BUG-4 + BUG-3 + BUG-6 + BUG-12 (hand-written)
--
-- BUG-4: document_types had no tenant_id, so a type one tenant seeded
-- (e.g. "UAN Service History", "PF Passbook") became an onboarding
-- checklist item for EVERY tenant hiring in that geography.
--
-- Model after this migration:
--   tenant_id IS NULL      → platform type (statutory / generic catalogue,
--                            scoped by geography_code; every tenant sees it)
--   tenant_id = <tenant>   → that tenant's own type (only it sees it)
--
-- Uniqueness moves from a global unique(code) to two partial unique indexes:
-- one code per platform catalogue, one code per tenant. A tenant type may
-- share a code with a platform type — readers prefer the tenant row
-- (onboarding-case.ts ensureDocumentCollectionTasks).
--
-- RLS: the permissive `reference_read USING (true)` policy is replaced by
-- `tenant_isolation_select USING (tenant_id IS NULL OR tenant_id =
-- current_tenant_id())`. Writes stay migration / service-role only (no
-- authenticated write policy — there is no tenant-facing editor yet), so the
-- table is no longer allowlisted in lint-rls.ts.
--
-- Backfill decision:
--   * The 0048 seed rows (government ID, address proof, PAN, Aadhaar,
--     Form 11, Form F, tax declaration, the PH statutory forms) are
--     country-statutory or generic → stay PLATFORM rows (tenant_id NULL).
--   * Every other existing row was added by a tenant demo seed and is
--     tenant-specific (passport photo / bank statement / UAN service history
--     / PF passbooks …). Ownership is resolved, in order:
--       1. the tenant whose demo-seed rows share the row's seed id namespace
--          (seed scripts mint ids as `<prefix>-<kind><n>`; the owner is the
--          tenant holding the business unit `<prefix>-01…01` of the same
--          namespace);
--       2. else the single tenant that has uploaded / requested it
--          (onboarding_documents, application_documents);
--       3. else left as a platform row, with a NOTICE (manual review).
--   * ESIC is added as a platform India type (`geography_code = 'IN'`) but
--     with required_for_lifecycle_stage NULL: it is requestable, not auto-
--     collected, because ESIC only applies below the statutory wage ceiling.
--
-- Existing onboarding_tasks in OTHER tenants that were auto-generated from a
-- now tenant-owned type are NOT touched (tasks carry their own title; no FK).
-- See the C1-BUGS hand-back for the review note.
--
-- BUG-3: onboarding_cases.probation_days was CHECK 1..180, but the offer
-- composer accepts probation_months 0..24. Onboarding now takes the accepted
-- offer's probation, so the range widens to 0..731 (24 calendar months).
--
-- BUG-6: the requisition wizard's employment type was accepted and dropped.
-- positions.employment_type (nullable free text, ≤120 like the input) keeps
-- it so JD generation can use it. Becomes a tenant taxonomy key later (F3).
--
-- BUG-12: partner_msa.exclusivity_scope ('org_wide' | 'req_only') was stored
-- and never enforced. Claims now snapshot it (exclusivity_scope +
-- requisition_id, the req a req_only claim is limited to). "One active claim
-- per person" becomes "one active ORG-WIDE claim per person" plus "one active
-- req_only claim per (person, requisition)". Backfill: an existing ACTIVE or
-- historical claim made while its org's MSA (the row effective at claimed_at)
-- was req_only becomes req_only on its claiming application's requisition;
-- everything else stays org_wide (the previous behaviour). The req FK
-- cascades: a req_only claim means nothing once its requisition is gone.
-- =====================================================================

ALTER TABLE "document_types" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_types" DROP CONSTRAINT "uniq_document_types_code";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_document_types_platform_code" ON "document_types" USING btree ("code") WHERE "tenant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_document_types_tenant_code" ON "document_types" USING btree ("tenant_id","code") WHERE "tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_document_types_tenant" ON "document_types" USING btree ("tenant_id");--> statement-breakpoint
DO $$
DECLARE
  r record;
  ns text;
  owner uuid;
  owner_count int;
BEGIN
  FOR r IN
    SELECT id, code FROM public.document_types
    WHERE tenant_id IS NULL
      AND code NOT IN (
        'government_id', 'address_proof', 'prior_employment_proof',
        'education_certificate', 'bank_details',
        'pan_card', 'aadhaar', 'form_11_pf', 'form_f_gratuity', 'tax_declaration_in',
        'bir_2316', 'sss', 'philhealth', 'pag_ibig'
      )
  LOOP
    owner := NULL;

    -- 1. seed id namespace → the tenant owning business unit <prefix>-01…01.
    ns := substring(r.id::text from 1 for 23);
    SELECT bu.tenant_id INTO owner
      FROM public.business_units bu
      WHERE bu.id::text = ns || '-010000000001'
      LIMIT 1;

    -- 2. the single tenant that uploaded / requested it.
    IF owner IS NULL THEN
      SELECT count(DISTINCT u.tenant_id), min(u.tenant_id::text)::uuid
        INTO owner_count, owner
        FROM (
          SELECT od.tenant_id FROM public.onboarding_documents od
            WHERE od.document_type_id = r.id
          UNION
          SELECT ad.tenant_id FROM public.application_documents ad
            WHERE ad.document_type_id = r.id
        ) u;
      IF owner_count <> 1 THEN
        owner := NULL;
      END IF;
    END IF;

    IF owner IS NULL THEN
      RAISE NOTICE '0132: document_types % (%) left as a platform type — owner not resolvable, review manually', r.code, r.id;
    ELSE
      UPDATE public.document_types SET tenant_id = owner, updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
INSERT INTO public.document_types (code, name, geography_code, required_for_lifecycle_stage, retention_years)
SELECT 'esic', 'ESIC Registration (Employees'' State Insurance)', 'IN', NULL, 8
WHERE NOT EXISTS (
  SELECT 1 FROM public.document_types WHERE code = 'esic' AND tenant_id IS NULL
);--> statement-breakpoint
DROP POLICY IF EXISTS "reference_read" ON "document_types";--> statement-breakpoint
CREATE POLICY "tenant_isolation_select" ON "document_types" AS PERMISSIVE FOR SELECT TO "authenticated" USING (tenant_id IS NULL OR tenant_id = current_tenant_id());--> statement-breakpoint
ALTER TABLE "onboarding_cases" DROP CONSTRAINT "onboarding_cases_probation_days_check";--> statement-breakpoint
ALTER TABLE "onboarding_cases" ADD CONSTRAINT "onboarding_cases_probation_days_check" CHECK ("onboarding_cases"."probation_days" BETWEEN 0 AND 731);--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN "employment_type" text;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_employment_type_len_check" CHECK ("positions"."employment_type" IS NULL OR char_length("positions"."employment_type") <= 120);--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD COLUMN "exclusivity_scope" text DEFAULT 'org_wide' NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD COLUMN "requisition_id" uuid;--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD CONSTRAINT "fk_claims_requisition" FOREIGN KEY ("tenant_id","requisition_id") REFERENCES "public"."requisitions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE public.candidate_ownership_claims c
   SET exclusivity_scope = 'req_only', requisition_id = a.requisition_id
  FROM public.applications a, public.partner_msa m
 WHERE a.tenant_id = c.tenant_id
   AND a.id = c.claimed_via_application_id
   AND m.tenant_id = c.tenant_id
   AND m.partner_org_id = c.partner_org_id
   AND m.effective_from <= c.claimed_at
   AND (m.effective_to IS NULL OR m.effective_to > c.claimed_at)
   AND m.exclusivity_scope = 'req_only';--> statement-breakpoint
ALTER TABLE "candidate_ownership_claims" ADD CONSTRAINT "candidate_ownership_claims_scope_check" CHECK (("candidate_ownership_claims"."exclusivity_scope" = 'org_wide' AND "candidate_ownership_claims"."requisition_id" IS NULL)
       OR ("candidate_ownership_claims"."exclusivity_scope" = 'req_only' AND "candidate_ownership_claims"."requisition_id" IS NOT NULL));--> statement-breakpoint
DROP INDEX "uniq_active_claim_per_person";--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_active_claim_per_person" ON "candidate_ownership_claims" USING btree ("tenant_id","person_id") WHERE status = 'active' AND exclusivity_scope = 'org_wide';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_active_req_claim_per_person" ON "candidate_ownership_claims" USING btree ("tenant_id","person_id","requisition_id") WHERE status = 'active' AND exclusivity_scope = 'req_only';
