-- =====================================================================
-- 0095_t12_force_rls_audit.sql — T12 (hand-written)
--
-- Companion to 0093/0094. Drizzle's .enableRLS() emits ENABLE ROW LEVEL
-- SECURITY but never FORCE; lint-rls (FND-15c) requires both on every
-- tenant-scoped table.
--
--   hr_policy_document_versions — FORCE RLS only. No audit trigger: the table
--     is itself the immutable content-change history, so a trigger would only
--     duplicate the signal. (hr_policy_documents likewise keeps no trigger —
--     the 0067 stance — so its seed re-runs stay noise-free.)
--   jd_templates — FORCE RLS + audit_record_change trigger, matching its
--     closest sibling market_benchmarks (0063/0064): curated, tenant-editable
--     reference data whose edits are audit-worthy.
-- =====================================================================

ALTER TABLE public.hr_policy_document_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.jd_templates FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TRIGGER audit_jd_templates
AFTER INSERT OR UPDATE OR DELETE ON public.jd_templates
FOR EACH ROW EXECUTE FUNCTION public.audit_record_change();
