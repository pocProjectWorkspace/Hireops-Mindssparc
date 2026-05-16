-- =====================================================================
-- 0032_signed_link_uses_partial_unique.sql — Module 3 hot-fix (hand-written)
--
-- The Module 3 schema (0028) created a full UNIQUE (tenant_id, token_hash)
-- on signed_link_uses. That made the second-attempt audit row impossible
-- to insert — same token_hash → 23505 → silently swallowed → no audit
-- trail for "tried again, was already redeemed".
--
-- Change to PARTIAL UNIQUE WHERE successful = true:
--   - one successful row per token (one-time-use still enforced)
--   - any number of failed rows per token (audit log of every attempt)
--
-- The verification route logic stays the same: look up an existing
-- successful row; if present, refuse + insert a failed row.
-- =====================================================================

DROP INDEX IF EXISTS public.uniq_signed_link_uses_tenant_token;--> statement-breakpoint

CREATE UNIQUE INDEX uniq_signed_link_uses_tenant_token
  ON public.signed_link_uses (tenant_id, token_hash)
  WHERE successful = true;
