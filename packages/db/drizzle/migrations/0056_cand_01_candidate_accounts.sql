-- =====================================================================
-- 0056_cand_01_candidate_accounts.sql — CAND-01 (hand-written)
--
-- The candidate login identity tier (Wave C). Third identity table
-- alongside tenant_user_memberships (internal) and partner_users
-- (partner); an identity is exactly one of the three in a given tenant.
--
-- Hand-written (not drizzle-kit generated) to stay consistent with the
-- 0050/0054/0055 precedent — the schema snapshot is frozen at 0051 and
-- every table since ships as a hand-written DDL + a schema model for the
-- query builder. FORCE RLS + audit trigger land in 0057/0058 (the
-- 0051→0052→0053 companion shape).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.candidate_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  person_id uuid NOT NULL,
  user_id uuid,
  status text NOT NULL DEFAULT 'pending',
  activation_token_hash text,
  activation_requested_at timestamptz,
  activated_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_candidate_accounts_tenant_id_id UNIQUE (tenant_id, id),
  CONSTRAINT candidate_accounts_status_check
    CHECK (status IN ('pending', 'active', 'disabled')),
  CONSTRAINT fk_candidate_accounts_person
    FOREIGN KEY (tenant_id, person_id)
    REFERENCES public.persons(tenant_id, id) ON DELETE CASCADE
);--> statement-breakpoint

-- One account per person per tenant (pending or active).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_candidate_accounts_tenant_person
  ON public.candidate_accounts (tenant_id, person_id);--> statement-breakpoint

-- One account per auth identity per tenant — partial (user_id NULL while pending).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_candidate_accounts_tenant_user
  ON public.candidate_accounts (tenant_id, user_id)
  WHERE user_id IS NOT NULL;--> statement-breakpoint

-- Completion route locates the pending row by activation hash.
CREATE INDEX IF NOT EXISTS idx_candidate_accounts_activation_hash
  ON public.candidate_accounts (activation_token_hash)
  WHERE activation_token_hash IS NOT NULL;--> statement-breakpoint

ALTER TABLE public.candidate_accounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON public.candidate_accounts
  AS PERMISSIVE FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
