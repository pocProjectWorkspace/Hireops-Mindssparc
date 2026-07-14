-- =====================================================================
-- 0048_onboard_01_seed_document_types.sql — ONBOARD-01 (hand-written)
--
-- Seed the tenant-agnostic document_types reference rows. This is
-- foundational reference data (not tenant/demo data), so it lives in a
-- migration rather than the demo-seed scripts — every environment gets
-- the same taxonomy, once, purely additively. Seeding here (vs the
-- generated 0045) keeps it out of drizzle's regenerate/trim churn.
--
-- geography_code NULL = applies to every geography (the common
-- collection set from requirements.md §7.1); 'IN' / 'PH' scope the
-- geography-specific statutory documents. codes are globally UNIQUE, so
-- ON CONFLICT (code) DO NOTHING makes this idempotent / re-runnable.
--
-- retention_years are DPDPA-relevant defaults (identity/employment docs
-- ~7y; statutory tax/PF forms 8-10y); tenants can layer overrides via a
-- future tenant_document_policies table (architecture.md §5.1 note) —
-- out of scope for Wave 1.
-- =====================================================================

INSERT INTO public.document_types (code, name, geography_code, required_for_lifecycle_stage, retention_years) VALUES
  -- Common / geography-agnostic collection (requirements.md §7.1)
  ('government_id',          'Government-issued Photo ID',      NULL, 'pre_boarding', 7),
  ('address_proof',          'Address Proof',                   NULL, 'pre_boarding', 7),
  ('prior_employment_proof', 'Prior Employment Proof',          NULL, 'pre_boarding', 7),
  ('education_certificate',  'Education Certificate',           NULL, 'pre_boarding', 7),
  ('bank_details',           'Bank Account Details',            NULL, 'pre_boarding', 7),
  -- India-specific (requirements.md §7.1)
  ('pan_card',               'PAN Card',                        'IN', 'pre_boarding', 7),
  ('aadhaar',                'Aadhaar Card',                    'IN', 'pre_boarding', 7),
  ('form_11_pf',             'Form 11 (EPF Declaration)',       'IN', 'pre_boarding', 8),
  ('form_f_gratuity',        'Form F (Gratuity Nominee)',       'IN', 'pre_boarding', 8),
  ('tax_declaration_in',     'Investment / Tax Declaration',    'IN', 'pre_boarding', 8),
  -- Philippines-specific (requirements.md §7.1)
  ('bir_2316',               'BIR Form 2316',                   'PH', 'pre_boarding', 10),
  ('sss',                    'SSS Registration',                'PH', 'pre_boarding', 10),
  ('philhealth',             'PhilHealth Registration',         'PH', 'pre_boarding', 10),
  ('pag_ibig',               'Pag-IBIG Registration',           'PH', 'pre_boarding', 10)
ON CONFLICT (code) DO NOTHING;
