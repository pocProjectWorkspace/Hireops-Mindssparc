-- =====================================================================
-- 0050_req_01_hr_head_role.sql — REQ-01 (hand-written)
--
-- Wave A / the approval spine. Adds the `hr_head` value to the
-- tenant_role enum so the HR-head persona (requisition approval queue,
-- REQ-03) has a first-class identity. The prototype's "requirement_owner"
-- persona maps to our existing `hiring_manager` role — NOT a new role.
--
-- ALTER TYPE ... ADD VALUE is additive and safe on the live staging DB
-- (the dev Supabase project is also staging). IF NOT EXISTS makes the
-- migration idempotent. The new value is only added here, never USED in
-- this same migration, so it commits cleanly inside the migrator's tx.
--
-- No FORCE-RLS / snapshot companion: this touches a type, not a table.
-- =====================================================================

ALTER TYPE public.tenant_role ADD VALUE IF NOT EXISTS 'hr_head';
